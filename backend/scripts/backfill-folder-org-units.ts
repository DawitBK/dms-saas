/**
 * Reparent existing department folders off the single shared organisation
 * folder onto a per-org-unit folder, and backfill folder_nodes.org_unit_id.
 *
 * WHY THIS EXISTS
 *
 * Before migration 20260912000002, folder_nodes had no org_unit_id column at
 * all, and getOrCreateDepartmentFolder (folders.service.ts) parented EVERY
 * department's folder directly under one single tenant-wide "Example Corp
 * Group" folder, regardless of which OrgUnit the department actually
 * belonged to. Two org units with a same/similarly-named department (e.g. two
 * "Finance" departments, one per org unit) ended up as flat, indistinguishable
 * siblings with no visual grouping in the Folders admin tree — the documented
 * hierarchy is Tenant -> OrgUnit -> Department -> FolderNode),
 * but the actual folder tree skipped the OrgUnit level entirely.
 *
 * getOrCreateDepartmentFolder now nests a department's folder under
 * getOrCreateOrgUnitFolder's per-org-unit folder instead, so every NEW
 * department folder is correct from the start. This script fixes what's
 * already there: for each active department whose canonical folder still
 * hangs off the old org-unit-less shared folder, it moves that folder (and
 * cascades the path rewrite to its descendants, same technique updateFolder
 * already uses for renames/reparents) onto its own org unit's folder, then
 * backfills org_unit_id for every folder bound to a department.
 *
 * Idempotent: a department whose folder is already parented under the
 * correct org-unit folder is left alone, and the org_unit_id backfill only
 * touches rows where it doesn't already match.
 *
 * FIX 2026-09-23: this script ran once already (its own doc comment above
 * describes a completed migration), and produced "0 to reparent" every time
 * it was actually re-run against real production data -- not because the
 * work was done, but because it queried `Department.findAll` and friends
 * with NO transaction and NO `SET LOCAL app.current_tenant`. departments,
 * org_units and folder_nodes all FORCE row-level security with a strict
 * policy (`tenant_id = current_setting('app.current_tenant') OR
 * CURRENT_USER = 'postgres'`) -- edams_app (the app's real DB role in both
 * production and mirror) gets zero rows back with the GUC unset, silently.
 * This is exactly the class of bug workerTenantContext.ts's own doc comment
 * warns still exists ("the broader 'worker does one big cross-tenant SELECT
 * with no tenant GUC' pattern some sweeps still use") -- this was one of
 * those sweeps. Concretely: Example Corp HQ's 9 real departments (DANIEL,
 * Executive, Finance, HR, IT, Legal, Operations, Procurement, Uncategorized)
 * were STILL parented under the old tenant-wide "Global Folders" umbrella
 * (org_unit_id IS NULL) months after this script was believed to have fixed
 * them -- Browse showed only the one department (Software Engineering) that
 * happened to get created after the org-unit-folder code path landed,
 * while the Hierarchy sidebar (which reads departments/org_units directly,
 * not folder_nodes) correctly listed all of them, making it look like the
 * two panes disagreed about the org chart.
 *
 * Now loops per-tenant (read from the tenant-agnostic, RLS-free `tenants`
 * table) via withWorkerTenantContext, which opens a real transaction, issues
 * `SET LOCAL app.current_tenant` on it, and threads it through Sequelize's
 * CLS adapter so every query below -- none of which pass an explicit
 * `{ transaction }` -- auto-joins it and sees that tenant's real rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-folder-org-units.ts            # dry run
 *   npx tsx scripts/backfill-folder-org-units.ts --execute  # apply
 */

import 'dotenv/config';
import { Op, QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize, Department, OrgUnit, FolderNode } from '../src/infrastructure/database/index.js';
import { getOrCreateOrgUnitFolder } from '../src/modules/folders/folders.service.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';
import { getRequestTransaction } from '../src/shared/requestContext.js';

const EXECUTE = process.argv.includes('--execute');

type Candidate = { dept: Department; folder: FolderNode; orgUnit: OrgUnit };

async function processTenant(tenantId: string): Promise<{ reparented: number; descendantsUpdated: number }> {
  return withWorkerTenantContext(tenantId, async () => {
    const departments = await Department.findAll({ where: { isActive: true, tenantId } });

    const candidates: Candidate[] = [];
    const skipped: string[] = [];

    for (const dept of departments) {
      // Same canonical-folder lookup getOrCreateDepartmentFolder uses: the
      // lowest-level, non-root, absolute-path folder bound to this department.
      const folder = await FolderNode.findOne({
        where: {
          tenantId: dept.tenantId,
          departmentId: dept.id,
          isActive: true,
          level: { [Op.gt]: 0 },
          path: { [Op.like]: '/%' },
        },
        order: [
          ['level', 'ASC'],
          ['createdAt', 'ASC'],
        ],
      });
      if (!folder || !folder.parentId) continue;

      const parent = await FolderNode.findByPk(folder.parentId);
      if (!parent) continue;
      // Already parented under this department's own org unit (either a fresh
      // department created after the fix, or a department this script already
      // repaired on a prior run) — nothing to do.
      if (parent.orgUnitId === dept.orgUnitId) continue;

      const orgUnit = await OrgUnit.findOne({ where: { id: dept.orgUnitId, tenantId: dept.tenantId } });
      if (!orgUnit) {
        skipped.push(`${dept.name} (${dept.id}): org unit ${dept.orgUnitId} not found`);
        continue;
      }

      candidates.push({ dept, folder, orgUnit });
    }

    console.log(`\n  [${tenantId}] departments checked:      ${departments.length}`);
    console.log(`  [${tenantId}] already correctly parented: ${departments.length - candidates.length - skipped.length}`);
    console.log(`  [${tenantId}] TO REPARENT:              ${candidates.length}`);
    if (skipped.length) console.log(`  [${tenantId}] SKIPPED (org unit missing): ${skipped.length}`);

    for (const { dept, folder, orgUnit } of candidates) {
      console.log(`  [${tenantId}] ${dept.name} (${dept.id})  "${folder.path}"  ->  under org unit "${orgUnit.name}" (${orgUnit.code})`);
    }
    for (const line of skipped) console.log(`  [${tenantId}] SKIP  ${line}`);

    if (candidates.length === 0 || !EXECUTE) {
      return { reparented: 0, descendantsUpdated: 0 };
    }

    let reparented = 0;
    let descendantsUpdated = 0;

    for (const { dept, orgUnit } of candidates) {
      // Re-fetch inside this tenant's transaction: state may have shifted
      // between the dry-run pass above and here.
      const folder = await FolderNode.findOne({
        where: {
          tenantId: dept.tenantId,
          departmentId: dept.id,
          isActive: true,
          level: { [Op.gt]: 0 },
          path: { [Op.like]: '/%' },
        },
        order: [
          ['level', 'ASC'],
          ['createdAt', 'ASC'],
        ],
      });
      if (!folder) continue;

      const t = getRequestTransaction();
      if (!t) throw new Error('withWorkerTenantContext did not establish an ambient transaction');
      const orgFolder = await getOrCreateOrgUnitFolder(dept.tenantId, orgUnit, t);
      const oldPath = folder.path;
      const slug = oldPath.split('/').pop()!;
      const newPath = `${orgFolder.path}/${slug}`;

      const collision = await FolderNode.findOne({
        where: { tenantId: dept.tenantId, path: newPath, isActive: true, id: { [Op.ne]: folder.id } },
      });
      if (collision) {
        console.warn(`  [${tenantId}] SKIP ${dept.name}: target path "${newPath}" already in use by another folder`);
        continue;
      }

      await folder.update({ parentId: orgFolder.id, level: orgFolder.level + 1, path: newPath, orgUnitId: dept.orgUnitId });
      reparented += 1;

      const descendants = await FolderNode.findAll({
        where: { tenantId: dept.tenantId, path: { [Op.like]: `${oldPath}/%` } },
      });
      for (const descendant of descendants) {
        const newDescPath = descendant.path.replace(oldPath + '/', newPath + '/');
        const newLevel = newDescPath.split('/').length - 1;
        await descendant.update({ path: newDescPath, level: newLevel });
        descendantsUpdated += 1;
      }
    }

    // Defense in depth: any folder bound to a department (the just-reparented
    // roots, their descendants, or anything this loop didn't otherwise touch)
    // gets its org_unit_id aligned with that department's, in one pass.
    await sequelize.query(
      `UPDATE folder_nodes fn
         SET org_unit_id = d.org_unit_id
        FROM departments d
       WHERE fn.department_id = d.id
         AND fn.tenant_id = :tenantId
         AND fn.org_unit_id IS DISTINCT FROM d.org_unit_id`,
      { replacements: { tenantId } },
    );

    return { reparented, descendantsUpdated };
  });
}

async function main() {
  initModels();
  await connectDB();

  const tenants = await sequelize.query<{ id: string }>('SELECT id FROM tenants', { type: QueryTypes.SELECT });

  let totalReparented = 0;
  let totalDescendants = 0;

  for (const { id: tenantId } of tenants) {
    const { reparented, descendantsUpdated } = await processTenant(tenantId);
    totalReparented += reparented;
    totalDescendants += descendantsUpdated;
  }

  if (!EXECUTE) {
    console.log('\n  DRY RUN — re-run with --execute to apply.\n');
  } else {
    console.log(`\n  reparented ${totalReparented} department folder(s), rewrote ${totalDescendants} descendant path(s).\n`);
  }

  await sequelize.close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n  backfill failed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
