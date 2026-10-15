/**
 * Rename existing tenant-root and org-less "global" folders to match the
 * new naming convention introduced alongside getOrCreateOrgUnitFolder:
 *
 *   - the level-0 tenant root is named after the TENANT (was hardcoded to
 *     "DMS Repository"/"EDAMS Repository" for every tenant regardless of its
 *     actual name)
 *   - the level-1 org-unit-less "global folders" umbrella is named
 *     "Global Folders" (was hardcoded to "Example Corp" — which, for the
 *     tenant actually NAMED "Example Corp", put a folder with the exact
 *     same name as the tenant as a level-1 SIBLING of that tenant's real org
 *     units, reading as if the tenant were one more org unit alongside them)
 *
 * Idempotent: only touches rows that still have isSystemManaged=true and the
 * old placeholder names, so it's safe to re-run and won't touch anything a
 * user deliberately renamed.
 *
 * Usage:
 *   npx tsx scripts/backfill-folder-tenant-naming.ts            # dry run
 *   npx tsx scripts/backfill-folder-tenant-naming.ts --execute  # apply
 */

import 'dotenv/config';
import { connectDB, initModels, sequelize, Tenant, FolderNode } from '../src/infrastructure/database/index.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';

const EXECUTE = process.argv.includes('--execute');
const OLD_ROOT_NAMES = new Set(['DMS Repository', 'EDAMS Repository']);
const OLD_GLOBAL_NAME = 'Example Corp';

async function main() {
  initModels();
  await connectDB();

  // FIX 2026-09-23: `folder_nodes` FORCE-enables RLS (tenant_id match or
  // CURRENT_USER = 'postgres' — no fail-open), and this script's queries ran
  // with no app.current_tenant ever set, so every tenant's FolderNode.findOne
  // returned nothing under the app's real (non-superuser) DB role — this
  // script has always reported "nothing to do" regardless of actual state.
  // Confirmed live: the examplecorp tenant root folder is still named "DMS
  // Repository" today. Scope each tenant's lookup with withWorkerTenantContext,
  // same fix already applied to backfill-folder-org-units.ts this session.
  const tenants = await Tenant.findAll();

  type Rename = { folder: FolderNode; from: string; to: string };
  const renames: Rename[] = [];

  for (const tenant of tenants) {
    await withWorkerTenantContext(tenant.id, async () => {
      const root = await FolderNode.findOne({
        where: { tenantId: tenant.id, parentId: null, departmentId: null, orgUnitId: null, level: 0, isSystemManaged: true },
      });
      if (root && OLD_ROOT_NAMES.has(root.name) && root.name !== tenant.name) {
        renames.push({ folder: root, from: root.name, to: tenant.name });
      }

      if (root) {
        const globalFolder = await FolderNode.findOne({
          where: { tenantId: tenant.id, parentId: root.id, departmentId: null, orgUnitId: null, level: 1, isSystemManaged: true, name: OLD_GLOBAL_NAME },
        });
        if (globalFolder) {
          renames.push({ folder: globalFolder, from: globalFolder.name, to: 'Global Folders' });
        }
      }
    });
  }

  console.log(`\n  tenants checked: ${tenants.length}`);
  console.log(`  folders to rename: ${renames.length}\n`);
  for (const r of renames) {
    console.log(`  [tenant ${r.folder.tenantId}] "${r.from}" -> "${r.to}"  (path ${r.folder.path})`);
  }

  if (renames.length === 0) {
    console.log('\n  nothing to do.\n');
    await sequelize.close();
    process.exit(0);
  }

  if (!EXECUTE) {
    console.log('\n  DRY RUN — re-run with --execute to apply.\n');
    await sequelize.close();
    process.exit(0);
  }

  for (const r of renames) {
    await withWorkerTenantContext(r.folder.tenantId, async () => {
      await r.folder.update({ name: r.to });
    });
  }

  console.log(`\n  renamed ${renames.length} folder(s).\n`);
  await sequelize.close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n  rename failed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
