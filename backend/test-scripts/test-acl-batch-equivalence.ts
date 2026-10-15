/**
 * Equivalence test for resolveACLBatch vs resolveACL (per-row), added
 * alongside the perf fix that made filterDocsByDetailAcl call
 * resolveACLBatch() once per page instead of resolveACL() once per row.
 * Exercises every branch of the DENY-first ladder (direct user/role
 * ALLOW/DENY, folder + department ancestor ALLOW/DENY, tenant-wide and
 * document-type access rules, expired entries, no entry at all) across two
 * users and asserts the batch result for every document matches the
 * independently-computed single-resolveACL result — both cold (cache
 * cleared before each call) and warm (batch's own cache write reused).
 *
 * Run: npx tsx test-scripts/test-acl-batch-equivalence.ts
 */

import { QueryTypes } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

import { sequelize } from '../src/infrastructure/database/sequelize.js';
import { initModels } from '../src/infrastructure/database/models/index.js';
import { assertLocalDevDatabase, needsDemoData, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

async function run() {
  assertLocalDevDatabase(sequelize.config.host, sequelize.config.database);
  await sequelize.authenticate();
  initModels();
  console.log('DB connected\n');

  // The verification tenant (qa-lab unless VERIFY_TENANT says otherwise); it creates and then deletes its own TST-BATCHEQ fixtures there.
  const TENANT_ID = verifyTenantId();
  const PERMISSION = 'document:read';
  const CODE_PREFIX = 'TST-BATCHEQ';
  const DEPT_CODE = 'TBEQDEPT'; // departments.code is varchar(10) — keep short

  const { resolveACL, resolveACLBatch } = await import('../src/shared/resolveACL.js');
  const { invalidateResourceACL, invalidateTenantACL } = await import('../src/infrastructure/cache/aclCache.js');

  // Role access rules this run inserted, by id. The cleanup used to delete EVERY role rule for STAFF / RECORDS_OFFICER in the
  // tenant, which on a tenant with real rules for those roles would have erased them along with the fixtures.
  const createdRuleIds: string[] = [];

  async function cleanup() {
    await sequelize.query(`DELETE FROM acl_entries WHERE tenant_id = $1 AND resource_id IN (SELECT id FROM documents WHERE tenant_id = $1 AND document_name LIKE '${CODE_PREFIX}%')`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM acl_entries WHERE tenant_id = $1 AND resource_id IN (SELECT id FROM folder_nodes WHERE tenant_id = $1 AND name LIKE '${CODE_PREFIX}%')`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM acl_entries WHERE tenant_id = $1 AND resource_id IN (SELECT id FROM departments WHERE tenant_id = $1 AND code LIKE '${CODE_PREFIX}%')`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM access_rules WHERE tenant_id = $1 AND principal_id IN (SELECT id::text FROM users WHERE email LIKE '${CODE_PREFIX.toLowerCase()}%')`, { bind: [TENANT_ID] });
    if (createdRuleIds.length) await sequelize.query(`DELETE FROM access_rules WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, { bind: [TENANT_ID, createdRuleIds] });
    await sequelize.query(`DELETE FROM documents WHERE tenant_id = $1 AND document_name LIKE '${CODE_PREFIX}%'`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM folder_nodes WHERE tenant_id = $1 AND name LIKE '${CODE_PREFIX}%'`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM departments WHERE tenant_id = $1 AND code LIKE '${DEPT_CODE}%'`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM users WHERE email LIKE '${CODE_PREFIX.toLowerCase()}%'`);
  }

  await cleanup();

  const [orgUnit] = await sequelize.query<any>(
    `SELECT id FROM org_units WHERE tenant_id = $1 LIMIT 1`,
    { bind: [TENANT_ID], type: QueryTypes.SELECT }
  );
  if (!orgUnit) { console.error(`No org unit found for tenant ${TENANT_ID}`); process.exit(1); }
  const orgUnitId: string = orgUnit.id;

  const [dept] = await sequelize.query<any>(
    `INSERT INTO departments (id, tenant_id, code, name, org_unit_id, is_active) VALUES (gen_random_uuid(), $1, '${DEPT_CODE}', 'Batch Eq Dept', $2, true) RETURNING id`,
    { bind: [TENANT_ID, orgUnitId], type: QueryTypes.SELECT }
  );
  const deptId: string = dept.id;

  // Separate department purely so the department-level DENY test below
  // doesn't collide with docDirectUserDeny's department-level ALLOW grant on
  // the SAME (department, user, permission) tuple — acl_entries has a unique
  // constraint on that tuple, so each ancestor-level scenario needs its own resource.
  const [dept2] = await sequelize.query<any>(
    `INSERT INTO departments (id, tenant_id, code, name, org_unit_id, is_active) VALUES (gen_random_uuid(), $1, '${DEPT_CODE}2', 'Batch Eq Dept 2', $2, true) RETURNING id`,
    { bind: [TENANT_ID, orgUnitId], type: QueryTypes.SELECT }
  );
  const deptId2: string = dept2.id;

  const [folder] = await sequelize.query<any>(
    `INSERT INTO folder_nodes (id, tenant_id, name, path, level, department_id) VALUES (gen_random_uuid(), $1, '${CODE_PREFIX}-folder', '/${CODE_PREFIX}-folder', 1, $2) RETURNING id`,
    { bind: [TENANT_ID, deptId], type: QueryTypes.SELECT }
  );
  const folderId: string = folder.id;

  const [subfolder] = await sequelize.query<any>(
    `INSERT INTO folder_nodes (id, tenant_id, name, path, level, parent_id, department_id) VALUES (gen_random_uuid(), $1, '${CODE_PREFIX}-sub', '/${CODE_PREFIX}-folder/sub', 2, $2, $3) RETURNING id`,
    { bind: [TENANT_ID, folderId, deptId], type: QueryTypes.SELECT }
  );
  const subfolderId: string = subfolder.id;

  const docTypes = await sequelize.query<any>(
    `SELECT id FROM document_types WHERE tenant_id = $1 AND is_active = true LIMIT 2`,
    { bind: [TENANT_ID], type: QueryTypes.SELECT }
  );
  if (docTypes.length < 2) { console.error('Need at least 2 active document types'); process.exit(1); }
  const [docTypeA, docTypeB] = [docTypes[0].id, docTypes[1].id];

  const [adminUser] = await sequelize.query<any>(`SELECT id FROM users WHERE email = $1 LIMIT 1`, { bind: [verifyAdminEmail()], type: QueryTypes.SELECT });
  if (!adminUser) needsDemoData('test-acl-batch-equivalence.ts', `no user "${verifyAdminEmail()}" (set VERIFY_ADMIN_EMAIL to an existing administrator)`);
  const adminId: string = adminUser.id;

  const [user1] = await sequelize.query<any>(
    `INSERT INTO users (id, email, first_name, last_name, is_active) VALUES (gen_random_uuid(), '${CODE_PREFIX.toLowerCase()}-u1@x.local', 'BatchEq1', 'Test', true) RETURNING id`,
    { type: QueryTypes.SELECT }
  );
  const user1Id: string = user1.id;
  const [user2] = await sequelize.query<any>(
    `INSERT INTO users (id, email, first_name, last_name, is_active) VALUES (gen_random_uuid(), '${CODE_PREFIX.toLowerCase()}-u2@x.local', 'BatchEq2', 'Test', true) RETURNING id`,
    { type: QueryTypes.SELECT }
  );
  const user2Id: string = user2.id;

  const ROLE = 'STAFF';
  const ROLE2 = 'RECORDS_OFFICER';

  async function makeDoc(name: string, opts: { folderId?: string | null; departmentId: string; documentTypeId: string }) {
    const [row] = await sequelize.query<any>(
      `INSERT INTO documents (id, tenant_id, document_name, title, status, security_classification, organisation_unit, retention_class, folder_id, department_id, document_type_id, owner_id, source)
       VALUES (gen_random_uuid(), $1, $2, $2, 'DRAFT', 'INTERNAL', 'Test', 'STANDARD', $3, $4, $5, $6, 'MANUAL_UPLOAD') RETURNING id`,
      { bind: [TENANT_ID, name, opts.folderId ?? null, opts.departmentId, opts.documentTypeId, adminId], type: QueryTypes.SELECT }
    );
    return row.id as string;
  }

  async function grantAclEntry(resourceType: string, resourceId: string, principalType: 'user' | 'role', principalId: string, effect: 'ALLOW' | 'DENY', expiresAt?: string) {
    await sequelize.query(
      `INSERT INTO acl_entries (id, tenant_id, resource_type, resource_id, principal_type, principal_id, permission, effect, granted_by_id, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      { bind: [TENANT_ID, resourceType, resourceId, principalType, principalId, PERMISSION, effect, adminId, expiresAt ?? null] }
    );
  }

  async function grantAccessRule(principalType: 'user' | 'role', principalId: string, effect: 'ALLOW' | 'DENY', documentTypeId: string | null) {
    const [row] = await sequelize.query<any>(
      `INSERT INTO access_rules (id, tenant_id, principal_type, principal_id, permission, effect, document_type_id, granted_by_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      { bind: [TENANT_ID, principalType, principalId, PERMISSION, effect, documentTypeId, adminId], type: QueryTypes.SELECT }
    );
    createdRuleIds.push(row.id);
  }

  // --- Build one document per DENY-first branch ---
  const docDirectUserDeny = await makeDoc(`${CODE_PREFIX}-directUserDeny`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('department', deptId, 'user', user1Id, 'ALLOW'); // ancestor ALLOW that the direct DENY below must beat
  await grantAclEntry('document', docDirectUserDeny, 'user', user1Id, 'DENY');

  const docDirectUserAllow = await makeDoc(`${CODE_PREFIX}-directUserAllow`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('document', docDirectUserAllow, 'user', user1Id, 'ALLOW');

  const docDirectRoleDeny = await makeDoc(`${CODE_PREFIX}-directRoleDeny`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('document', docDirectRoleDeny, 'role', ROLE, 'DENY');

  const docDirectRoleAllow = await makeDoc(`${CODE_PREFIX}-directRoleAllow`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('document', docDirectRoleAllow, 'role', ROLE, 'ALLOW');

  const docFolderUserDeny = await makeDoc(`${CODE_PREFIX}-folderUserDeny`, { folderId: subfolderId, departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('folder', folderId, 'user', user1Id, 'DENY');

  const docFolderRoleAllow = await makeDoc(`${CODE_PREFIX}-folderRoleAllow`, { folderId: subfolderId, departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('folder', subfolderId, 'role', ROLE, 'ALLOW');

  const docDeptUserDeny = await makeDoc(`${CODE_PREFIX}-deptUserDeny`, { departmentId: deptId2, documentTypeId: docTypeA });
  await grantAclEntry('department', deptId2, 'user', user1Id, 'DENY');

  const docDeptRoleAllow = await makeDoc(`${CODE_PREFIX}-deptRoleAllow`, { departmentId: deptId2, documentTypeId: docTypeA });
  await grantAclEntry('department', deptId2, 'role', ROLE2, 'ALLOW');

  const docAccessRuleAllowType = await makeDoc(`${CODE_PREFIX}-accessRuleAllowType`, { departmentId: deptId, documentTypeId: docTypeB });
  await grantAccessRule('user', user2Id, 'ALLOW', docTypeB);

  const docAccessRuleDenyTenantWide = await makeDoc(`${CODE_PREFIX}-accessRuleDenyTenant`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAccessRule('role', ROLE, 'DENY', null);

  const docExpiredAllowOnly = await makeDoc(`${CODE_PREFIX}-expiredAllowOnly`, { departmentId: deptId, documentTypeId: docTypeA });
  await grantAclEntry('document', docExpiredAllowOnly, 'user', user1Id, 'ALLOW', '2000-01-01T00:00:00Z');

  const docNoEntry = await makeDoc(`${CODE_PREFIX}-noEntry`, { departmentId: deptId, documentTypeId: docTypeA });

  const allDocIds = [
    docDirectUserDeny, docDirectUserAllow, docDirectRoleDeny, docDirectRoleAllow,
    docFolderUserDeny, docFolderRoleAllow, docDeptUserDeny, docDeptRoleAllow,
    docAccessRuleAllowType, docAccessRuleDenyTenantWide, docExpiredAllowOnly, docNoEntry,
  ];

  let passed = 0, failed = 0;

  async function checkUser(label: string, userId: string, userRole: string) {
    // Cold, independent single-resolveACL pass — clear this exact resource's
    // cache first so each call is a from-scratch computation, not a hit on
    // whatever the batch call below already wrote.
    const expected = new Map<string, { allowed: boolean; reason?: string }>();
    for (const docId of allDocIds) {
      await invalidateResourceACL(TENANT_ID, 'document', docId);
      const r = await resolveACL({ resourceType: 'document', resourceId: docId, permission: PERMISSION, userId, userRole, tenantId: TENANT_ID });
      expected.set(docId, { allowed: r.allowed, reason: r.reason });
    }

    // Cold batch pass (cache cleared again so batch computes from scratch too).
    await invalidateTenantACL(TENANT_ID);
    const coldBatch = await resolveACLBatch(allDocIds, { permission: PERMISSION, userId, userRole, tenantId: TENANT_ID });

    // Warm batch pass — same call again, now hitting the cache coldBatch just wrote.
    const warmBatch = await resolveACLBatch(allDocIds, { permission: PERMISSION, userId, userRole, tenantId: TENANT_ID });

    for (const docId of allDocIds) {
      const exp = expected.get(docId)!;
      for (const [passName, batchResult] of [['cold', coldBatch], ['warm', warmBatch]] as const) {
        const got = batchResult.get(docId);
        const ok = got?.allowed === exp.allowed && got?.reason === exp.reason;
        const icon = ok ? '✅' : '❌';
        console.log(`${icon} [${label}/${passName}] ${docId.slice(0, 8)}: expected allowed=${exp.allowed} (${exp.reason}) got allowed=${got?.allowed} (${got?.reason})`);
        if (ok) passed++; else failed++;
      }
    }
  }

  await checkUser('user1/STAFF', user1Id, ROLE);
  await checkUser('user2/RECORDS_OFFICER', user2Id, ROLE2);

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);

  await cleanup();
  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
