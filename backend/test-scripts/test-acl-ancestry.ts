/**
 * ACL ancestry + access_rules resolution test
 * Run: npx tsx test-scripts/test-acl-ancestry.ts
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

  // The verification tenant (qa-lab unless VERIFY_TENANT says otherwise); it creates and then deletes its own TST-* fixtures there.
  const TENANT_ID = verifyTenantId();

  // --- Cleanup from any prior failed run (order matters: docs → folders → depts → users) ---
  const prevDeptIds = await sequelize.query<any>(
    `SELECT id FROM departments WHERE tenant_id = $1 AND code IN ('TST-PARENT','TST-SUB')`,
    { bind: [TENANT_ID], type: QueryTypes.SELECT }
  );
  if (prevDeptIds.length > 0) {
    const ids = prevDeptIds.map((r: any) => r.id);
    await sequelize.query(`DELETE FROM documents WHERE tenant_id = $1 AND document_name IN ('tst-acl-doc1.pdf','tst-acl-doc2.pdf','tst-acl-doc3.pdf')`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM folder_nodes WHERE tenant_id = $1 AND path IN ('/tst-folder','/tst-folder/tst-sub')`, { bind: [TENANT_ID] });
    await sequelize.query(`DELETE FROM departments WHERE tenant_id = $1 AND code IN ('TST-PARENT','TST-SUB')`, { bind: [TENANT_ID] });
  }
  await sequelize.query(`DELETE FROM users WHERE email IN ('tst-acl-u1@x.local','tst-acl-u2@x.local')`);

  const [orgUnit] = await sequelize.query<any>(
    `SELECT id FROM org_units WHERE tenant_id = $1 LIMIT 1`,
    { bind: [TENANT_ID], type: QueryTypes.SELECT }
  );
  if (!orgUnit) { console.error(`No org unit found for tenant ${TENANT_ID}`); process.exit(1); }
  const orgUnitId: string = orgUnit.id;

  // --- Create parent department ---
  const [parentDept] = await sequelize.query<any>(
    `INSERT INTO departments (id, tenant_id, code, name, org_unit_id, is_active)
     VALUES (gen_random_uuid(), $1, 'TST-PARENT', 'Test Parent Dept', $2, true) RETURNING id`,
    { bind: [TENANT_ID, orgUnitId], type: QueryTypes.SELECT }
  );
  const parentDeptId: string = parentDept.id;

  const [subDept] = await sequelize.query<any>(
    `INSERT INTO departments (id, tenant_id, code, name, parent_id, org_unit_id, is_active)
     VALUES (gen_random_uuid(), $1, 'TST-SUB', 'Test Sub Dept', $2, $3, true) RETURNING id`,
    { bind: [TENANT_ID, parentDeptId, orgUnitId], type: QueryTypes.SELECT }
  );
  const subDeptId: string = subDept.id;

  // --- Create folder/subfolder inside sub-department ---
  await sequelize.query(`DELETE FROM folder_nodes WHERE tenant_id = $1 AND path IN ('/tst-folder','/tst-folder/tst-sub')`, { bind: [TENANT_ID] });
  const [folder] = await sequelize.query<any>(
    `INSERT INTO folder_nodes (id, tenant_id, name, path, level, department_id)
     VALUES (gen_random_uuid(), $1, 'tst-folder', '/tst-folder', 1, $2) RETURNING id`,
    { bind: [TENANT_ID, subDeptId], type: QueryTypes.SELECT }
  );
  const folderId: string = folder.id;

  const [subfolder] = await sequelize.query<any>(
    `INSERT INTO folder_nodes (id, tenant_id, name, path, level, parent_id, department_id)
     VALUES (gen_random_uuid(), $1, 'tst-sub', '/tst-folder/tst-sub', 2, $2, $3) RETURNING id`,
    { bind: [TENANT_ID, folderId, subDeptId], type: QueryTypes.SELECT }
  );
  const subfolderId: string = subfolder.id;

  // --- Get two document types ---
  const docTypes = await sequelize.query<any>(
    `SELECT id FROM document_types WHERE tenant_id = $1 AND is_active = true LIMIT 2`,
    { bind: [TENANT_ID], type: QueryTypes.SELECT }
  );
  if (docTypes.length < 2) { console.error('Need at least 2 active document types'); process.exit(1); }
  const [docTypeId, docTypeId2] = [docTypes[0].id, docTypes[1].id];

  // --- Get an existing user id (for ownerId and test subjects) ---
  const [adminUser] = await sequelize.query<any>(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    { bind: [verifyAdminEmail()], type: QueryTypes.SELECT }
  );
  if (!adminUser) needsDemoData('test-acl-ancestry.ts', `no user "${verifyAdminEmail()}" (set VERIFY_ADMIN_EMAIL to an existing administrator)`);
  const adminId: string = adminUser.id;

  // --- Create test document inside subfolder (type 1) ---
  await sequelize.query(`DELETE FROM documents WHERE tenant_id = $1 AND document_name IN ('tst-acl-doc1.pdf','tst-acl-doc2.pdf','tst-acl-doc3.pdf')`, { bind: [TENANT_ID] });
  const [doc1] = await sequelize.query<any>(
    `INSERT INTO documents (id, tenant_id, document_name, title, status, security_classification, organisation_unit, retention_class, folder_id, department_id, document_type_id, owner_id, source)
     VALUES (gen_random_uuid(), $1, 'tst-acl-doc1.pdf', 'ACL Test Doc 1', 'DRAFT', 'INTERNAL', 'Test', 'STANDARD', $2, $3, $4, $5, 'MANUAL_UPLOAD') RETURNING id`,
    { bind: [TENANT_ID, subfolderId, subDeptId, docTypeId, adminId], type: QueryTypes.SELECT }
  );
  const doc1Id: string = doc1.id;

  // --- Create test document in an unrelated department (type 2) ---
  // Use an existing seeded department (not our test ones) so doc2 is NOT in user1's dept tree
  const [existingDept] = await sequelize.query<any>(
    `SELECT id FROM departments WHERE tenant_id = $1 AND id NOT IN ($2, $3) AND is_active = true LIMIT 1`,
    { bind: [TENANT_ID, parentDeptId, subDeptId], type: QueryTypes.SELECT }
  );
  const otherDeptId: string = existingDept?.id ?? parentDeptId; // fallback if no other dept
  const [doc2] = await sequelize.query<any>(
    `INSERT INTO documents (id, tenant_id, document_name, title, status, security_classification, organisation_unit, retention_class, department_id, document_type_id, owner_id, source)
     VALUES (gen_random_uuid(), $1, 'tst-acl-doc2.pdf', 'ACL Test Doc 2', 'DRAFT', 'INTERNAL', 'Test', 'STANDARD', $2, $3, $4, 'MANUAL_UPLOAD') RETURNING id`,
    { bind: [TENANT_ID, otherDeptId, docTypeId2, adminId], type: QueryTypes.SELECT }
  );
  const doc2Id: string = doc2.id;

  // doc3: a TYPE-1 document inside doc2's department (where user2 is a member, see below), so TEST 3b can show the document-type rule
  // really is what decides, not merely the department boundary.
  const [doc3] = await sequelize.query<any>(
    `INSERT INTO documents (id, tenant_id, document_name, title, status, security_classification, organisation_unit, retention_class, department_id, document_type_id, owner_id, source)
     VALUES (gen_random_uuid(), $1, 'tst-acl-doc3.pdf', 'ACL Test Doc 3', 'DRAFT', 'INTERNAL', 'Test', 'STANDARD', $2, $3, $4, 'MANUAL_UPLOAD') RETURNING id`,
    { bind: [TENANT_ID, otherDeptId, docTypeId, adminId], type: QueryTypes.SELECT }
  );
  const doc3Id: string = doc3.id;

  // --- Create two test users (no tenant_id or role columns, those are in JWT/user_tenants) ---
  await sequelize.query(`DELETE FROM users WHERE email IN ('tst-acl-u1@x.local','tst-acl-u2@x.local')`);
  const [user1] = await sequelize.query<any>(
    `INSERT INTO users (id, email, first_name, last_name, is_active)
     VALUES (gen_random_uuid(), 'tst-acl-u1@x.local', 'ACL1', 'Test', true) RETURNING id`,
    { type: QueryTypes.SELECT }
  );
  const user1Id: string = user1.id;

  const [user2] = await sequelize.query<any>(
    `INSERT INTO users (id, email, first_name, last_name, is_active)
     VALUES (gen_random_uuid(), 'tst-acl-u2@x.local', 'ACL2', 'Test', true) RETURNING id`,
    { type: QueryTypes.SELECT }
  );
  const user2Id: string = user2.id;

  // --- Grant user1 ACL on PARENT DEPARTMENT only ---
  await sequelize.query(
    `INSERT INTO acl_entries (id, tenant_id, resource_type, resource_id, principal_type, principal_id, permission, effect, granted_by_id)
     VALUES (gen_random_uuid(), $1, 'department', $2, 'user', $3, 'document:read', 'ALLOW', $4)`,
    { bind: [TENANT_ID, parentDeptId, user1Id, adminId] }
  );
  console.log('User1 granted document:read on parent department (id:', parentDeptId, ')');

  // --- Grant user2 access_rule for docTypeId2 only ---
  await sequelize.query(
    `INSERT INTO access_rules (id, tenant_id, principal_type, principal_id, permission, effect, document_type_id, granted_by_id)
     VALUES (gen_random_uuid(), $1, 'user', $2, 'document:read', 'ALLOW', $3, $4)`,
    { bind: [TENANT_ID, user2Id, docTypeId2, adminId] }
  );
  console.log('User2 granted access_rule for doc type 2 (id:', docTypeId2, ')');

  // A document-type access rule only applies INSIDE the reader's department scope since the 2026-10-09 owner decision (reading is
  // direct department membership; outside it only a deliberate per-user grant opens a document, resolveACL: "Document is outside the
  // active department scope"). So user2 is a member of doc2's department and the rule is what lets them in. user2 is deleted at the
  // end, which removes this row with it (ON DELETE CASCADE).
  await sequelize.query(`INSERT INTO user_departments (user_id, department_id) VALUES ($1, $2)`, { bind: [user2Id, otherDeptId] });
  console.log("User2 made a member of doc2's department (id:", otherDeptId, ')\n');

  // --- Now import and run resolveACL ---
  const { resolveACL } = await import('../src/shared/resolveACL.js');

  let passed = 0, failed = 0;

  async function test(label: string, fn: () => Promise<{ allowed: boolean; reason?: string }>, expect: boolean) {
    const r = await fn();
    const ok = r.allowed === expect;
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${label}: allowed=${r.allowed} (${r.reason ?? 'no reason'})`);
    if (ok) passed++; else failed++;
  }

  // TEST 1: user1 can read doc1 (parent dept grant → sub-dept → subfolder → doc)
  await test(
    'TEST 1: Dept ancestry: user1 → doc1 (via parent dept)',
    () => resolveACL({ resourceType: 'document', resourceId: doc1Id, permission: 'document:read', userId: user1Id, userRole: 'STAFF' }),
    true
  );

  // TEST 2: user2 can read doc2 (access_rule for doc type 2)
  await test(
    'TEST 2: access_rule: user2 → doc2 (matching doc type)',
    () => resolveACL({ resourceType: 'document', resourceId: doc2Id, permission: 'document:read', userId: user2Id, userRole: 'STAFF' }),
    true
  );

  // TEST 3: user2 cannot read doc1 (access_rule is for type2, doc1 is type1)
  await test(
    'TEST 3: access_rule isolation: user2 → doc1 (wrong doc type, expect denied)',
    () => resolveACL({ resourceType: 'document', resourceId: doc1Id, permission: 'document:read', userId: user2Id, userRole: 'STAFF' }),
    false
  );

  // TEST 3b: same isolation, inside user2's own department (doc3 is type 1, the rule is for type 2)
  await test(
    'TEST 3b: access_rule isolation: user2 → doc3 (in their own department, wrong doc type, expect denied)',
    () => resolveACL({ resourceType: 'document', resourceId: doc3Id, permission: 'document:read', userId: user2Id, userRole: 'STAFF' }),
    false
  );

  // TEST 4: user1 cannot read doc2 (no grant, doc2 is in no dept/folder user1 has access to)
  await test(
    'TEST 4: No grant: user1 → doc2 (no dept/folder grant, expect denied)',
    () => resolveACL({ resourceType: 'document', resourceId: doc2Id, permission: 'document:read', userId: user1Id, userRole: 'STAFF' }),
    false
  );

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

  // Cleanup
  await sequelize.query(`DELETE FROM acl_entries WHERE principal_id IN ($1,$2)`, { bind: [user1Id, user2Id] });
  await sequelize.query(`DELETE FROM access_rules WHERE principal_id IN ($1,$2)`, { bind: [user1Id, user2Id] });
  await sequelize.query(`DELETE FROM documents WHERE id IN ($1,$2,$3)`, { bind: [doc1Id, doc2Id, doc3Id] });
  await sequelize.query(`DELETE FROM folder_nodes WHERE id IN ($1,$2)`, { bind: [folderId, subfolderId] });
  await sequelize.query(`DELETE FROM departments WHERE id IN ($1,$2)`, { bind: [parentDeptId, subDeptId] });
  await sequelize.query(`DELETE FROM users WHERE id IN ($1,$2)`, { bind: [user1Id, user2Id] });
  console.log('Fixtures cleaned up');

  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
