/**
 * Live probe (dev DB only, ALWAYS rolled back): flips one existing letter to CONFIDENTIAL inside a
 * transaction, runs syncLetterDocumentAcl against the real database, prints the ACL rows before/after,
 * then rolls everything back. Proves the real SQL of letters L14 without leaving data behind.
 *   npx tsx test-scripts/probe-letter-acl-rollback.ts
 */
import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize, Letter } from '../src/infrastructure/database/index.js';
import { syncLetterDocumentAcl } from '../src/modules/letters/letterDocumentAcl.js';

async function counts(letterId: string, tx: import('sequelize').Transaction) {
  return sequelize.query<{ origin: string | null; n: string }>(
    `SELECT a.origin, count(*) AS n FROM acl_entries a
      WHERE a.resource_type='document' AND a.permission='document:read'
        AND a.resource_id IN (SELECT x FROM unnest(ARRAY[(SELECT document_id FROM letters WHERE id=:id),(SELECT attachment_document_id FROM letters WHERE id=:id),(SELECT cover_sheet_document_id FROM letters WHERE id=:id)]) x WHERE x IS NOT NULL
                              UNION SELECT document_id FROM letter_attachments WHERE letter_id=:id)
      GROUP BY a.origin ORDER BY 1 NULLS FIRST`,
    { replacements: { id: letterId }, type: QueryTypes.SELECT, transaction: tx },
  );
}

async function main() {
  initModels();
  await connectDB();
  const candidates = await sequelize.query<{ id: string; tenant_id: string }>(
    `SELECT l.id, l.tenant_id FROM letters l
      WHERE l.document_id IS NOT NULL OR l.attachment_document_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM letter_attachments a WHERE a.letter_id = l.id)
      LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (candidates.length === 0) {
    console.log('PROBE SKIPPED: no dev letter has a backing document');
    await sequelize.close();
    return;
  }
  const { id, tenant_id: tenantId } = candidates[0]!;
  const tx = await sequelize.transaction();
  try {
    console.log('before            ', JSON.stringify(await counts(id, tx)));
    await Letter.update({ confidentiality: 'CONFIDENTIAL' }, { where: { id }, transaction: tx });
    await syncLetterDocumentAcl(id, tenantId, tx, { classificationChanged: true });
    console.log('after CONFIDENTIAL', JSON.stringify(await counts(id, tx)));
    await Letter.update({ confidentiality: 'INTERNAL' }, { where: { id }, transaction: tx });
    await syncLetterDocumentAcl(id, tenantId, tx, { classificationChanged: true });
    console.log('after INTERNAL    ', JSON.stringify(await counts(id, tx)));
  } finally {
    await tx.rollback();
    console.log('rolled back');
    await sequelize.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
