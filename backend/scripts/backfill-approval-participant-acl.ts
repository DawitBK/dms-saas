/**
 * Backfill document:read ACL entries for approval-chain participants.
 *
 * WHY THIS EXISTS
 *
 * Assigning an approval step to a NAMED user outside the item's own department
 * is deliberately allowed — a named assignee is globally scoped by design, and
 * the picker only shows a cross-department advisory rather than blocking the
 * choice. But nothing ever granted that person access to the document:
 * grantDefaultDocumentAcl (documents.service.ts) grants document:read to the
 * owner and to a SNAPSHOT of the document's own department members, and
 * approvals.service.ts wrote no ACL entries at all.
 *
 * So the assignee's first click failed with AUTHZ_ACL_NO_ENTRY — "No access
 * control entry for this resource" — and they could never reach the Workflow
 * tab to act on the thing assigned to them. getChain() lets a chain
 * participant bypass its own ACL check, but the page loads GET /documents/:id
 * first, and that has no such bypass.
 *
 * approvals.service.ts now grants at every point that names a participant
 * (submit, reassign, auditor assignment). This script repairs the chains that
 * were created BEFORE that fix and are still in flight.
 *
 * WHAT IT GRANTS
 *
 * document:read only — never write, archive or purge — to:
 *   - every named assignee of a non-terminal (PENDING/WAITING) approval step
 *   - every assigned role of such a step (as a role principal; resolveACL
 *     matches those against the acting user's role names)
 *   - every auditor of a PENDING audit-stage review
 *
 * Only for chains that are still live (IN_REVIEW / CHANGES_REQUESTED) and
 * items that still have a document. Idempotent: re-running grants nothing new.
 *
 * Usage:
 *   npx tsx scripts/backfill-approval-participant-acl.ts            # dry run
 *   npx tsx scripts/backfill-approval-participant-acl.ts --execute  # apply
 */

import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize, AclEntry } from '../src/infrastructure/database/index.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';

const EXECUTE = process.argv.includes('--execute');

type Row = {
  tenant_id: string;
  document_id: string;
  principal_type: 'user' | 'role';
  principal_id: string;
  /** acl_entries.granted_by_id is NOT NULL, so the grant is attributed to
   *  whoever actually made the assignment — the chain's submitter, or the
   *  approver who named the auditor. That is both truthful and auditable:
   *  the access follows from a decision that person really made. */
  granted_by_id: string;
  source: string;
  item_title: string | null;
};

async function main() {
  initModels();
  await connectDB();

  // FIX 2026-09-23: approval_steps, approval_chains, documents and
  // audit_stage_reviews all FORCE-enable RLS with a strict tenant_id-match
  // policy (documents/approval_steps/approval_chains/audit_stage_reviews have
  // no fail-open clause at all) — these two queries ran with no
  // app.current_tenant ever set, so they always returned zero rows under the
  // app's real (non-superuser) DB role. This script has always reported
  // "candidates found: 0, nothing to do" regardless of actual backlog. Loop
  // the tenant registry (tenant-agnostic, no RLS) and scope each query per
  // tenant; AclEntry's own lookup below is fail-open-safe already but is
  // wrapped too now that everything runs inside the per-tenant loop anyway.
  const tenantRows = await sequelize.query<{ id: string }>('SELECT id FROM tenants', { type: QueryTypes.SELECT });

  let all: Row[] = [];
  for (const { id: tenantId } of tenantRows) {
    await withWorkerTenantContext(tenantId, async () => {
      // Named assignees and assigned roles of steps that are still actionable,
      // for DOCUMENT and FORM_INSTANCE chains (FORM_TEMPLATE has no document).
      const stepRows = (await sequelize.query(
        `
        SELECT DISTINCT
               ac.tenant_id,
               COALESCE(d_direct.id, d_form.id) AS document_id,
               CASE WHEN s.assigned_user_id IS NOT NULL THEN 'user' ELSE 'role' END AS principal_type,
               COALESCE(s.assigned_user_id::text, s.assigned_role)                  AS principal_id,
               ac.submitted_by::text                                                AS granted_by_id,
               'approval_step:' || s.status                                         AS source,
               COALESCE(d_direct.title, d_form.title)                               AS item_title
          FROM approval_steps s
          JOIN approval_chains ac ON ac.id = s.chain_id
          LEFT JOIN documents d_direct
                 ON ac.item_type = 'DOCUMENT' AND d_direct.id = ac.item_id AND d_direct.deleted_at IS NULL
          LEFT JOIN form_instances fi
                 ON ac.item_type = 'FORM_INSTANCE' AND fi.id = ac.item_id
          LEFT JOIN documents d_form
                 ON d_form.id = fi.document_id AND d_form.deleted_at IS NULL
         WHERE ac.status IN ('IN_REVIEW', 'CHANGES_REQUESTED')
           AND s.status IN ('PENDING', 'WAITING')
           AND (s.assigned_user_id IS NOT NULL OR s.assigned_role IS NOT NULL)
           AND COALESCE(d_direct.id, d_form.id) IS NOT NULL
           AND ac.submitted_by IS NOT NULL
        `,
        { type: QueryTypes.SELECT },
      )) as Row[];

      // Auditors of reviews still awaiting a decision.
      const auditRows = (await sequelize.query(
        `
        SELECT DISTINCT
               r.tenant_id,
               d.id            AS document_id,
               'user'          AS principal_type,
               r.auditor_user_id::text AS principal_id,
               r.assigned_by::text     AS granted_by_id,
               'audit_review:PENDING'  AS source,
               d.title         AS item_title
          FROM audit_stage_reviews r
          JOIN documents d ON d.id = r.item_id AND d.deleted_at IS NULL
         WHERE r.status = 'PENDING'
           AND r.auditor_user_id IS NOT NULL
           AND r.assigned_by IS NOT NULL
        `,
        { type: QueryTypes.SELECT },
      )) as Row[];

      all = all.concat(stepRows, auditRows);
    });
  }

  // Skip anything that already has the grant, so the report shows real work.
  const missing: Row[] = [];
  for (const row of all) {
    const existing = await withWorkerTenantContext(row.tenant_id, () =>
      AclEntry.findOne({
        where: {
          tenantId: row.tenant_id,
          resourceType: 'document',
          resourceId: row.document_id,
          principalType: row.principal_type,
          principalId: row.principal_id,
          permission: 'document:read',
        },
      }),
    );
    if (!existing) missing.push(row);
  }

  console.log(`\n  candidates found:      ${all.length}`);
  console.log(`  already granted:       ${all.length - missing.length}`);
  console.log(`  MISSING (to grant):    ${missing.length}\n`);

  for (const row of missing) {
    console.log(
      `  ${row.principal_type.padEnd(4)} ${row.principal_id}  ->  ${row.document_id}` +
        `  (${row.source}${row.item_title ? `, "${row.item_title.slice(0, 40)}"` : ''})`,
    );
  }

  if (missing.length === 0) {
    console.log('\n  nothing to do.\n');
    await sequelize.close();
    return;
  }

  if (!EXECUTE) {
    console.log('\n  DRY RUN — re-run with --execute to apply.\n');
    await sequelize.close();
    return;
  }

  // One transaction: either every participant can open their work, or none of
  // this ran and the report above is still accurate.
  await sequelize.transaction(async (transaction) => {
    await AclEntry.bulkCreate(
      missing.map((row) => ({
        tenantId: row.tenant_id,
        resourceType: 'document' as const,
        resourceId: row.document_id,
        principalType: row.principal_type,
        principalId: row.principal_id,
        effect: 'ALLOW' as const,
        permission: 'document:read',
        grantedById: row.granted_by_id,
      })) as never[],
      { transaction, ignoreDuplicates: true },
    );
  });

  console.log(`\n  granted ${missing.length} document:read entries.\n`);
  await sequelize.close();
}

main().catch(async (error) => {
  console.error('\n  backfill failed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
