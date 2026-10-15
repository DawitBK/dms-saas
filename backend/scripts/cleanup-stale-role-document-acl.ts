/**
 * Removes stale tenant-wide role-level `document:read` ACL grants left over
 * from `grantDefaultDocumentAcl`'s old (buggy) behavior and from migration
 * `20260716000002-default-document-acls.sql`, which backfilled the same
 * bug retroactively.
 *
 * WHY THIS EXISTS
 *
 * `grantDefaultDocumentAcl` (documents.service.ts) used to grant
 * `document:read` to an entire ROLE — RECORDS_OFFICER, DEPT_MANAGER,
 * APPROVER, EMPLOYEE, AUDITOR, EXECUTIVE — on every document it touched,
 * TENANT-WIDE. AclEntry has no department dimension on a role principal, so
 * that grant applied to literally anyone in the tenant holding that role,
 * regardless of which department they actually belong to: an EMPLOYEE in one
 * department could open a document filed under a completely different
 * department straight from Browse/Dashboard — no department membership
 * required. The code has since been fixed (see the comment on
 * grantDefaultDocumentAcl) to snapshot only the document's OWN department's
 * current members as individual per-user ALLOW grants instead. But every row
 * the old behavior already wrote — every document ever created before the
 * fix, plus the entire backfill migration that ran the buggy version against
 * documents that predated it — is still sitting in `acl_entries` today,
 * silently overriding the department-scoped access model the rest of this
 * platform (buildReadScope, listReadableFolders, resolveACL) was built
 * around. This is why a user with zero department overlap with a document
 * could still see it on their Dashboard/Browse.
 *
 * This script deletes exactly that shape and nothing else:
 *   resourceType = 'document' AND principalType = 'role'
 *   AND principalId IN (RECORDS_OFFICER, DEPT_MANAGER, APPROVER, EMPLOYEE,
 *                        AUDITOR, EXECUTIVE)
 *   AND permission = 'document:read' AND effect = 'ALLOW'
 * The current, fixed grantDefaultDocumentAcl NEVER writes a row matching this
 * shape again (its only role-level grant is RECORDS_OFFICER + document:purge,
 * a deliberate, documented, unrelated capability — left untouched here). Any
 * row matching this exact shape is therefore unambiguously a leftover from
 * the old bug, not something a correct call could have produced since the fix
 * landed — safe to delete outright, no case-by-case judgment needed.
 *
 * Current department members lose nothing: buildReadScope already grants
 * them access via live UserDepartment membership, independent of any ACL row
 * (see documents.service.ts). Only a user who has since LEFT the document's
 * department, and who had no other explicit grant, loses the access this
 * over-broad role grant accidentally gave them — which is the correct
 * outcome, not a regression: that access was never supposed to exist.
 *
 * Usage:
 *   npx tsx scripts/cleanup-stale-role-document-acl.ts            # dry run
 *   npx tsx scripts/cleanup-stale-role-document-acl.ts --execute  # apply
 */

import 'dotenv/config';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { QueryTypes } from 'sequelize';
import { invalidateTenantACL } from '../src/infrastructure/cache/aclCache.js';

const EXECUTE = process.argv.includes('--execute');

const STALE_ROLE_PRINCIPALS = ['RECORDS_OFFICER', 'DEPT_MANAGER', 'APPROVER', 'EMPLOYEE', 'AUDITOR', 'EXECUTIVE'];

async function main() {
  initModels();
  await connectDB();

  const whereClause = `
    resource_type = 'document'
    AND principal_type = 'role'
    AND principal_id IN (:roles)
    AND permission = 'document:read'
    AND effect = 'ALLOW'
  `;

  const counts = await sequelize.query<{ tenant_id: string; principal_id: string; cnt: string }>(
    `SELECT tenant_id, principal_id, COUNT(*) as cnt FROM acl_entries WHERE ${whereClause} GROUP BY tenant_id, principal_id ORDER BY tenant_id, principal_id`,
    { replacements: { roles: STALE_ROLE_PRINCIPALS }, type: QueryTypes.SELECT },
  );

  console.log('\n  Stale tenant-wide role document:read ALLOW grants found:');
  let total = 0;
  for (const row of counts) {
    console.log(`    ${row.tenant_id} / ${row.principal_id}: ${row.cnt}`);
    total += Number(row.cnt);
  }
  console.log(`  TOTAL rows to delete: ${total}\n`);

  if (total === 0) {
    console.log('  Nothing to do.\n');
    await sequelize.close();
    process.exit(0);
  }

  if (!EXECUTE) {
    console.log('  DRY RUN — re-run with --execute to apply.\n');
    await sequelize.close();
    process.exit(0);
  }

  // Postgres via Sequelize returns [rows, rowCountOrMetadata] for a raw DELETE
  // — rowCountOrMetadata is a plain number under pg's driver, not the object
  // shape some other dialects return, but the pre-delete count above is the
  // authoritative "how many should be gone" figure either way.
  await sequelize.query(
    `DELETE FROM acl_entries WHERE ${whereClause}`,
    { replacements: { roles: STALE_ROLE_PRINCIPALS } },
  );
  console.log(`  Deleted ${total} stale ACL row(s).\n`);

  // resolveACL caches resolutions for 300s (aclCache.ts) — invalidate now so
  // the fix is visible immediately instead of waiting out the TTL.
  const tenantIds = [...new Set(counts.map((r) => r.tenant_id))];
  for (const tenantId of tenantIds) {
    await invalidateTenantACL(tenantId);
    console.log(`  Invalidated ACL cache for tenant ${tenantId}`);
  }

  await sequelize.close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n  cleanup failed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
