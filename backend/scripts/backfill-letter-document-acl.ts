/**
 * Back-fill (letters L14): make the backing documents of EXISTING CONFIDENTIAL / RESTRICTED letters
 * participants-only, the way new letters now are.
 *
 * WHY: until the L14 fix, grantDefaultDocumentAcl gave every current member of the department a read
 * snapshot on every document of every letter, whatever its classification, so any department member
 * could open a CONFIDENTIAL letter's PDF / scan / attachments through the Documents module.
 *
 * WHAT IT DOES, per restricted letter, using the same code path the service uses
 * (letters/letterDocumentAcl.ts syncLetterDocumentAcl):
 *   - deletes the DEPT_SNAPSHOT read rows on the letter's documents (current, staged, cover sheet,
 *     attachments, signed or voided drafts);
 *   - grants a deliberate read to each participant (drafter, assignee, signatory, named step assignees and
 *     deciders, holders of an open role step / the signatory role in the letter's department);
 *   - invalidates the ACL cache for those documents.
 * Rows from other sources (approval participants, Access Control Center grants, owner rows) are not touched.
 *
 * IS IT SAFE? It removes read access from department members who are not on the letter: that is the point.
 * Nothing else is deleted, and re-running changes nothing. Reverse (approximately): change the letter's
 * classification back and forth through the API, or re-run grantDefaultDocumentAcl-style snapshot manually.
 *
 * Usage (dev DB; NEVER aim at mirror/prod without the owner's go-ahead):
 *   npx tsx scripts/backfill-letter-document-acl.ts            # dry run: counts only
 *   npx tsx scripts/backfill-letter-document-acl.ts --execute  # apply
 */

import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';
import { syncLetterDocumentAcl } from '../src/modules/letters/letterDocumentAcl.js';

const EXECUTE = process.argv.includes('--execute');

async function main() {
  initModels();
  await connectDB();
  const tenants = await sequelize.query<{ id: string }>('SELECT id FROM tenants', { type: QueryTypes.SELECT });

  let letters = 0;
  let snapshotRows = 0;
  for (const { id: tenantId } of tenants) {
    await withWorkerTenantContext(tenantId, async () => {
      const restricted = await sequelize.query<{ id: string; snapshot_rows: string }>(
        `SELECT l.id,
                (SELECT count(*) FROM acl_entries a
                  WHERE a.tenant_id = l.tenant_id AND a.resource_type = 'document' AND a.origin = 'DEPT_SNAPSHOT'
                    AND a.resource_id IN (
                      SELECT x FROM unnest(ARRAY[l.document_id, l.attachment_document_id, l.cover_sheet_document_id, l.signed_draft_document_id]) AS x WHERE x IS NOT NULL
                      UNION SELECT document_id FROM letter_attachments WHERE letter_id = l.id
                      UNION SELECT d.id FROM documents d WHERE d.tenant_id = l.tenant_id AND d.document_name LIKE 'Letter draft — ' || l.id::text || '%'
                    )) AS snapshot_rows
           FROM letters l
          WHERE l.tenant_id = :tenantId AND l.confidentiality IN ('CONFIDENTIAL', 'RESTRICTED')`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      );
      for (const row of restricted) {
        letters += 1;
        snapshotRows += Number(row.snapshot_rows);
        if (EXECUTE) await syncLetterDocumentAcl(row.id, tenantId, undefined, { classificationChanged: true });
      }
    });
  }
  console.log(
    `${EXECUTE ? 'APPLIED' : 'DRY RUN'}: ${letters} CONFIDENTIAL/RESTRICTED letter(s); ` +
      `${snapshotRows} department snapshot row(s) ${EXECUTE ? 'removed (participants re-granted)' : 'would be removed'}.`,
  );
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
