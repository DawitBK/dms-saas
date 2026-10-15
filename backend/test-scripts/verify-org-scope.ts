/**
 * Organisation scope + document access, against the REAL dev database.
 *
 * Proves (shared/orgScope.ts, shared/resolveACL.ts), with a throwaway tenant
 * `tst-orgscope` that is created and removed by this script:
 *
 *   - a department head administers their department and its sub-departments,
 *     and nothing beside or above it;
 *   - a head cannot manage a user who outranks them, or one in another tenant;
 *   - tenant-wide authority (acl:bypass_admin / orgunit:manage) is unrestricted;
 *   - an explicit per-user document:read ALLOW opens a document outside the
 *     reader's department (an approval participant, a "special member"), while
 *     an ordinary outsider, a role-only ALLOW and an explicit DENY still do not.
 *
 * Direct service/DB level: no HTTP server, and no audit rows are written (it
 * calls only read paths), so the immutable audit chain is untouched.
 * Only touches tenant `tst-orgscope`. Refuses to run against anything but the
 * dev database name.
 *
 * Run: npx tsx test-scripts/verify-org-scope.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/config/permissions.js';
import {
  assertCanManageDepartment,
  assertCanManageUser,
  assertCanRestructureDepartment,
  assertDepartmentsInScope,
  getManagedDepartmentIds,
  type ScopeActor,
} from '../src/shared/orgScope.js';
import { resolveACL, resolveACLBatch } from '../src/shared/resolveACL.js';
import { invalidateTenantACL } from '../src/infrastructure/cache/aclCache.js';
import { invalidateUserPermissionOverrides } from '../src/infrastructure/cache/roleCache.js';

const TENANT = 'tst-orgscope';
const OTHER_TENANT = 'tst-orgscope-b';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, details ?? ''); }
}

async function rejectsWith(fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return (e as { code?: string }).code === code; }
}
async function resolves(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return true; } catch { return false; }
}

const q = (sql: string, replacements: Record<string, unknown> = {}) =>
  sequelize.query(sql, { replacements, type: 'RAW' as never });

async function cleanup() {
  for (const t of [TENANT, OTHER_TENANT]) {
    await q(`DELETE FROM acl_entries WHERE tenant_id = :t`, { t });
    await q(`DELETE FROM documents WHERE tenant_id = :t`, { t });
    await q(`DELETE FROM folder_nodes WHERE tenant_id = :t`, { t });
    await q(`DELETE FROM document_types WHERE tenant_id = :t`, { t });
  }
  await q(`DELETE FROM users WHERE email LIKE 'tst-orgscope-%'`);
  for (const t of [TENANT, OTHER_TENANT]) {
    await q(`DELETE FROM departments WHERE tenant_id = :t AND parent_id IS NOT NULL`, { t });
    await q(`DELETE FROM departments WHERE tenant_id = :t`, { t });
    await q(`DELETE FROM org_units WHERE tenant_id = :t`, { t });
    await q(`DELETE FROM tenants WHERE id = :t`, { t });
  }
}

async function main() {
  await initModels();
  await connectDB();
  const [{ db }] = (await sequelize.query(`SELECT current_database() AS db`, { type: 'SELECT' as never })) as unknown as Array<{ db: string }>;
  if (db !== 'DMS') throw new Error(`refusing to run against database "${db}" (expected the dev database "DMS")`);
  await cleanup();

  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    for (const t of [TENANT, OTHER_TENANT]) await q(`INSERT INTO tenants (id, name) VALUES (:t, :t)`, { t });
    const ou = randomUUID();
    const ouB = randomUUID();
    await q(`INSERT INTO org_units (id, tenant_id, code, name, unit_type) VALUES (:id, :t, 'HQ', 'HQ', 'HQ')`, { id: ou, t: TENANT });
    await q(`INSERT INTO org_units (id, tenant_id, code, name, unit_type) VALUES (:id, :t, 'HQ', 'HQ', 'HQ')`, { id: ouB, t: OTHER_TENANT });

    const dept = async (code: string, parent: string | null, t = TENANT, unit = ou) => {
      const id = randomUUID();
      await q(
        `INSERT INTO departments (id, code, name, tenant_id, parent_id, org_unit_id, level) VALUES (:id, :code, :code, :t, :parent, :unit, 0)`,
        { id, code, t, parent, unit },
      );
      return id;
    };
    const FIN = await dept('FIN', null);
    const FINAP = await dept('FINAP', FIN); // sub-department of FIN
    const FINAPX = await dept('FINAPX', FINAP); // sub-sub-department
    const HR = await dept('HR', null); // sibling
    const OTHERDEPT = await dept('OTH', null, OTHER_TENANT, ouB);

    const roleId = async (name: string) =>
      ((await sequelize.query(`SELECT id FROM roles WHERE name = :name`, { replacements: { name }, type: 'SELECT' as never })) as unknown as Array<{ id: string }>)[0]!.id;
    const user = async (tag: string, roles: string[], depts: string[], tenants = [TENANT]) => {
      const id = randomUUID();
      await q(`INSERT INTO users (id, email, first_name, last_name) VALUES (:id, :email, :tag, 'T')`, { id, email: `tst-orgscope-${tag}@example.test`, tag });
      for (const t of tenants) await q(`INSERT INTO user_tenants (user_id, tenant_id) VALUES (:id, :t)`, { id, t });
      for (const r of roles) await q(`INSERT INTO user_roles (user_id, role_id) VALUES (:id, :r)`, { id, r: await roleId(r) });
      for (const d of depts) await q(`INSERT INTO user_departments (user_id, department_id) VALUES (:id, :d)`, { id, d });
      return id;
    };
    const finHead = await user('finhead', ['DEPT_MANAGER'], [FIN]);
    const apHead = await user('aphead', ['DEPT_MANAGER'], [FINAP]);
    const hrHead = await user('hrhead', ['DEPT_MANAGER'], [HR]);
    const finStaff = await user('finstaff', ['EMPLOYEE'], [FIN]);
    const apStaff = await user('apstaff', ['EMPLOYEE'], [FINAP]);
    const hrStaff = await user('hrstaff', ['EMPLOYEE'], [HR]);
    const finAdminUser = await user('finsysadmin', ['SYSTEM_ADMIN'], [FIN]);
    const finAuditor = await user('finauditor', ['AUDITOR'], [FIN]);
    const unassigned = await user('unassigned', ['EMPLOYEE'], []);
    const foreigner = await user('foreigner', ['EMPLOYEE'], [OTHERDEPT], [OTHER_TENANT]);

    const actor = (userId: string, role: string, extra: string[] = []): ScopeActor => ({
      userId,
      tenantId: TENANT,
      role,
      roles: [role],
      permissions: [...new Set([...(ROLE_PERMISSIONS[role] ?? []), ...extra])],
    });
    const headFin = actor(finHead, 'DEPT_MANAGER');
    const headAp = actor(apHead, 'DEPT_MANAGER');
    const headHr = actor(hrHead, 'DEPT_MANAGER');
    const sysAdmin = actor(finAdminUser, 'SYSTEM_ADMIN');

    console.log('\n== managed department subtree ==');
    const finManaged = await getManagedDepartmentIds(TENANT, finHead);
    check('FIN head manages FIN, FINAP and FINAPX', [FIN, FINAP, FINAPX].every((d) => finManaged.has(d)));
    check('FIN head does not manage the sibling HR', !finManaged.has(HR));
    const apManaged = await getManagedDepartmentIds(TENANT, apHead);
    check('FINAP head manages FINAP and FINAPX only (not parent FIN)', apManaged.has(FINAP) && apManaged.has(FINAPX) && !apManaged.has(FIN));
    check('a membership in another tenant never leaks into this tenant\'s subtree',
      (await getManagedDepartmentIds(TENANT, foreigner)).size === 0);

    console.log('\n== department administration ==');
    check('FIN head may manage sub-department FINAP', await resolves(() => assertCanManageDepartment(headFin, FINAP)));
    check('FIN head may manage the sub-sub-department FINAPX', await resolves(() => assertCanManageDepartment(headFin, FINAPX)));
    check('FIN head may NOT manage sibling HR', await rejectsWith(() => assertCanManageDepartment(headFin, HR), 'ERR-DEPT-SCOPE'));
    check('FINAP head may NOT manage parent FIN', await rejectsWith(() => assertCanManageDepartment(headAp, FIN), 'ERR-DEPT-SCOPE'));
    check('HR head may NOT manage FINAP', await rejectsWith(() => assertCanManageDepartment(headHr, FINAP), 'ERR-DEPT-SCOPE'));
    check('SYSTEM_ADMIN manages every department', await resolves(() => assertCanManageDepartment(sysAdmin, HR)));
    check('FIN head may restructure (move/deactivate) FINAP — their parent is FIN',
      await resolves(() => assertCanRestructureDepartment(headFin, { parentId: FIN })));
    check('FINAP head may NOT restructure FINAP itself (that is its parent\'s call)',
      await rejectsWith(() => assertCanRestructureDepartment(headAp, { parentId: FIN }), 'ERR-DEPT-SCOPE'));
    check('only tenant-wide authority may restructure a top-level department',
      await rejectsWith(() => assertCanRestructureDepartment(headFin, { parentId: null }), 'ERR-DEPT-SCOPE')
      && await resolves(() => assertCanRestructureDepartment(sysAdmin, { parentId: null })));
    check('a department of ANOTHER tenant is never in scope',
      await rejectsWith(() => assertDepartmentsInScope(sysAdmin, [OTHERDEPT]), 'ERR-DEPARTMENT-NOT-FOUND'));

    console.log('\n== user administration ==');
    check('FIN head manages FIN staff', await resolves(() => assertCanManageUser(headFin, finStaff)));
    check('FIN head manages sub-department staff (FINAP)', await resolves(() => assertCanManageUser(headFin, apStaff)));
    check('FIN head may NOT manage HR staff', await rejectsWith(() => assertCanManageUser(headFin, hrStaff), 'ERR-USER-SCOPE'));
    check('FINAP head may NOT manage FIN staff (parent)', await rejectsWith(() => assertCanManageUser(headAp, finStaff), 'ERR-USER-SCOPE'));
    check('a department head may NOT manage the SYSTEM_ADMIN in their own department',
      await rejectsWith(() => assertCanManageUser(headFin, finAdminUser), 'ERR-TARGET-OUTRANKS-ACTOR'));
    check('...nor an AUDITOR in their own department',
      await rejectsWith(() => assertCanManageUser(headFin, finAuditor), 'ERR-TARGET-OUTRANKS-ACTOR'));
    check('a peer department manager is allowed (equal permissions)',
      await resolves(() => assertCanManageUser(actor(apHead, 'DEPT_MANAGER'), apHead)));
    check('an unassigned tenant member is NOT in a head\'s scope by default',
      await rejectsWith(() => assertCanManageUser(headFin, unassigned), 'ERR-USER-SCOPE'));
    check('...but can be adopted when allowUnassigned is set (onboarding)',
      await resolves(() => assertCanManageUser(headFin, unassigned, { allowUnassigned: true })));
    check('a user of another tenant reads as not found, not forbidden',
      await rejectsWith(() => assertCanManageUser(headFin, foreigner), 'ERR-USER-NOT-FOUND')
      && await rejectsWith(() => assertCanManageUser(sysAdmin, foreigner), 'ERR-USER-NOT-FOUND'));
    check('SYSTEM_ADMIN manages anyone in the tenant, in any department',
      await resolves(() => assertCanManageUser(sysAdmin, hrHead)) && await resolves(() => assertCanManageUser(sysAdmin, finAuditor)));
    check('a per-user permission GRANT counts: an employee given user:manage outranks nobody extra',
      await resolves(() => assertCanManageUser(headFin, finStaff)));
    await q(
      `INSERT INTO user_permission_overrides (tenant_id, user_id, permission, effect) VALUES (:t, :u, :p, 'GRANT')`,
      { t: TENANT, u: finStaff, p: PERMISSIONS.DOCUMENT_PURGE },
    );
    await invalidateUserPermissionOverrides(TENANT, finStaff);
    check('...a staff member individually granted document:purge now outranks the head, who lacks it',
      await rejectsWith(() => assertCanManageUser(headFin, finStaff), 'ERR-TARGET-OUTRANKS-ACTOR'));
    await q(`DELETE FROM user_permission_overrides WHERE tenant_id = :t`, { t: TENANT });
    await invalidateUserPermissionOverrides(TENANT, finStaff);

    console.log('\n== document read: department boundary vs explicit per-user grants ==');
    const [{ id: retentionCode }] = [{ id: 'RET-CORR-5Y' }];
    const typeId = randomUUID();
    await q(`INSERT INTO document_types (id, code, name, default_retention_class, tenant_id) VALUES (:id, 'GEN', 'General', :rc, :t)`,
      { id: typeId, rc: retentionCode, t: TENANT });
    const doc = async (name: string, deptId: string, owner: string) => {
      const id = randomUUID();
      await q(
        `INSERT INTO documents (id, tenant_id, document_name, title, department_id, document_type_id, owner_id, organisation_unit, status, security_classification, retention_class, source)
         VALUES (:id, :t, :name, :name, :d, :ty, :o, 'HQ', 'ACTIVE', 'INTERNAL', 'RET-CORR-5Y', 'UPLOAD')`,
        { id, t: TENANT, name, d: deptId, ty: typeId, o: owner },
      );
      return id;
    };
    // The app invalidates its ACL cache whenever a grant is written (acl.service);
    // raw SQL here must do the same or a cached decision outlives the change.
    const grant = async (resourceType: string, resourceId: string, principalType: string, principalId: string, effect: 'ALLOW' | 'DENY', permission = 'document:read') => {
      await q(
        `INSERT INTO acl_entries (tenant_id, resource_type, resource_id, principal_type, principal_id, effect, permission, granted_by_id)
         VALUES (:t, :rt, :rid, :pt, :pid, :e, :p, :g)`,
        { t: TENANT, rt: resourceType, rid: resourceId, pt: principalType, pid: principalId, e: effect, p: permission, g: finAdminUser },
      );
      await invalidateTenantACL(TENANT);
    };
    const read = (userId: string, role: string, docId: string) =>
      resolveACL({ resourceType: 'document', resourceId: docId, permission: 'document:read', userId, userRole: role, userRoles: [role], userPermissions: ROLE_PERMISSIONS[role], tenantId: TENANT });

    const docFin = await doc('FIN-doc', FIN, finStaff);
    await grant('document', docFin, 'user', finStaff, 'ALLOW'); // owner snapshot, as grantDefaultDocumentAcl writes
    await grant('document', docFin, 'user', apStaff, 'ALLOW'); // department member snapshot

    check('owner reads their document', (await read(finStaff, 'EMPLOYEE', docFin)).allowed);
    check('a department member with a snapshot grant reads it', (await read(apStaff, 'EMPLOYEE', docFin)).allowed);
    check('an HR employee with no grant does NOT', !(await read(hrStaff, 'EMPLOYEE', docFin)).allowed);

    await grant('document', docFin, 'user', hrStaff, 'ALLOW');
    const shared = await read(hrStaff, 'EMPLOYEE', docFin);
    check('an explicit per-user ALLOW opens a document OUTSIDE the reader\'s department (approver / special member)',
      shared.allowed, shared.reason);

    const batch = await resolveACLBatch([docFin], { permission: 'document:read', userId: hrStaff, userRole: 'EMPLOYEE', userRoles: ['EMPLOYEE'], userPermissions: ROLE_PERMISSIONS.EMPLOYEE, tenantId: TENANT });
    check('the list/search path (resolveACLBatch) agrees with the detail path',
      batch.get(docFin)?.allowed === shared.allowed, JSON.stringify(batch.get(docFin)));

    const docFin2 = await doc('FIN-doc-2', FIN, finStaff);
    await grant('document', docFin2, 'role', 'EMPLOYEE', 'ALLOW');
    check('a ROLE-only ALLOW does not cross the department boundary',
      !(await read(hrStaff, 'EMPLOYEE', docFin2)).allowed);

    const docFin3 = await doc('FIN-doc-3', FIN, finStaff);
    await grant('document', docFin3, 'user', hrStaff, 'ALLOW');
    await grant('document', docFin3, 'user', hrStaff, 'DENY', 'document:archive'); // different permission: must not matter
    check('an explicit user ALLOW on a different permission does not open document:read',
      !(await read(hrStaff, 'EMPLOYEE', await doc('FIN-doc-4', FIN, finStaff))).allowed);

    const docFin5 = await doc('FIN-doc-5', FIN, finStaff);
    await grant('document', docFin5, 'user', hrStaff, 'ALLOW');
    await q(`UPDATE acl_entries SET expires_at = now() - interval '1 hour' WHERE resource_id = :id`, { id: docFin5 });
    await invalidateTenantACL(TENANT);
    check('an EXPIRED explicit grant no longer opens it', !(await read(hrStaff, 'EMPLOYEE', docFin5)).allowed);

    const docFin6 = await doc('FIN-doc-6', FIN, finStaff);
    await grant('document', docFin6, 'user', hrStaff, 'DENY');
    await grant('folder', randomUUID(), 'user', hrStaff, 'ALLOW'); // irrelevant noise
    check('an explicit DENY wins over membership/ownership of nothing: outsider stays out',
      !(await read(hrStaff, 'EMPLOYEE', docFin6)).allowed);

    // Folder inheritance: ALLOW on an ancestor folder for a named user.
    const folderRoot = randomUUID();
    const folderSub = randomUUID();
    await q(`INSERT INTO folder_nodes (id, name, path, level, tenant_id, department_id) VALUES (:id, 'root', '/tst-root', 1, :t, :d)`, { id: folderRoot, t: TENANT, d: FIN });
    await q(`INSERT INTO folder_nodes (id, name, path, level, tenant_id, department_id, parent_id) VALUES (:id, 'sub', '/tst-root/sub', 2, :t, :d, :p)`, { id: folderSub, t: TENANT, d: FIN, p: folderRoot });
    const docInFolder = await doc('FIN-doc-7', FIN, finStaff);
    await q(`UPDATE documents SET folder_id = :f WHERE id = :id`, { f: folderSub, id: docInFolder });
    await grant('folder', folderRoot, 'user', hrStaff, 'ALLOW');
    check('a per-user ALLOW on an ANCESTOR folder is inherited by documents below it, across departments',
      (await read(hrStaff, 'EMPLOYEE', docInFolder)).allowed);
    await grant('folder', folderSub, 'user', hrStaff, 'DENY');
    check('a DENY on the nearer folder overrides the ancestor ALLOW',
      !(await read(hrStaff, 'EMPLOYEE', docInFolder)).allowed);

    // Tenant-wide read.
    const readAll = await read(finAuditor, 'AUDITOR', docFin6);
    check('document:read_all (AUDITOR) reads across departments with no grant', readAll.allowed);
    const denyAuditor = await doc('FIN-doc-8', FIN, finStaff);
    await grant('document', denyAuditor, 'user', finAuditor, 'DENY');
    check('...but an explicit DENY still beats document:read_all', !(await read(finAuditor, 'AUDITOR', denyAuditor)).allowed);
  } finally {
    await cleanup();
    await sequelize.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); await sequelize.close(); } catch { /* ignore */ }
  process.exit(1);
});
