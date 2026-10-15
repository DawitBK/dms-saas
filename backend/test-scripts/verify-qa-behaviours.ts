/**
 * verify-qa-behaviours.ts — live checks (real database, real services) for the access and structure behaviours
 * added on 2026-10-09, run against the QA tenant built by `npm run db:seed:qa`:
 *
 *   A  a person who JOINS a department late can read that department's older documents, and loses them on leaving
 *   B  a department head can move a folder inside their subtree; a head of ANOTHER department cannot
 *   C  re-activating a department needs an active org unit and an active parent
 *   D  a DENY can sit beside an ALLOW for the same person and permission, and DENY wins
 *   E  an explicit grant on top of the automatic department-snapshot row PROMOTES it (no 409) and makes it firm
 *   F  nobody can deactivate themselves
 *   G  GET /operations/ready answers without a token with the readiness shape
 *   H  a deactivated folder can be re-activated, with guards
 *   I  a letter step with a deadline is flagged when overdue, escalates to the department head after the grace period,
 *      the head can then decide it, and an outsider still cannot
 *   J  a catch-all default approval recipe per scope: the most specific wins, switching one off falls back
 *   L  CONFIDENTIAL / RESTRICTED documents (owner decision 2026-10-10, option B): who opens them, lists agree with detail, platform admin
 *      and oversight roles read everything, a class can be changed (lowering needs a reason), letters unchanged
 *   K  custom roles: description editable, built-in roles protected, delete refused while held / used by a recipe, then allowed
 *
 *   npm run db:seed:qa && npx tsx test-scripts/verify-qa-behaviours.ts      (dev only; the dev API must be up for G)
 */
import '../src/config/env.js';
import { config } from '../src/config/env.js';
import {
  AclEntry, Department, Document, FolderNode, OrgUnit, Role, User, initModels, sequelize,
} from '../src/infrastructure/database/index.js';
import { resolveUnionPermissions } from '../src/modules/roles/roles.service.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';
import { createUser, assignDepartment, removeDepartment, deactivateUser } from '../src/modules/users/users.service.js';
import { createDepartment, deactivateDepartment, updateDepartment } from '../src/modules/departments/departments.service.js';
import { updateFolder, createFolder, deactivateFolder, reactivateFolder, listInactiveFolders } from '../src/modules/folders/folders.service.js';
import { createAclEntry } from '../src/modules/acl/acl.service.js';
import { resolveACL } from '../src/shared/resolveACL.js';
import { createLetter, submitLetter, decideStep, recallLetter } from '../src/modules/letters/letters.service.js';
import { flagOverdueLetterSteps, escalateOverdueLetterSteps } from '../src/modules/letters/letterEscalation.service.js';
import { LetterApprovalStep } from '../src/infrastructure/database/index.js';
import { upsertChainTemplate, deactivateChainTemplate, findChainRecipe } from '../src/modules/approvals/approvals.service.js';
import { deleteCustomRole, updateCustomRoleDescription } from '../src/modules/roles/roles.service.js';
import { resolveACLBatch } from '../src/shared/resolveACL.js';
import { ROLE_PERMISSIONS } from '../src/config/permissions.js';
import { changeDocumentClassification, listDocuments } from '../src/modules/documents/documents.service.js';
import { listLetters } from '../src/modules/letters/letters.service.js';

const TENANT = 'qa-lab';
const API = process.env.API_URL ?? 'http://localhost:7100/api/v1';
const stamp = Date.now();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
async function refused(name: string, fn: () => Promise<unknown>, code: string) {
  try { await fn(); check(name, false, 'was allowed'); } catch (e) {
    const got = (e as { code?: string }).code ?? String(e);
    check(name, got.includes(code), `refused with ${got}`);
  }
}

async function actorFor(email: string) {
  const u = (await User.findOne({ where: { email } }))!;
  const rows = (await sequelize.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :id`, { replacements: { id: u.id } },
  ))[0] as { name: string }[];
  const roles = rows.map((r) => r.name);
  const permissions = await resolveUnionPermissions(roles, TENANT, u.id);
  return { userId: u.id, role: roles[0], roles, tenantId: TENANT, permissions: [...permissions] };
}
const q = (key: string) => `qa.${key}@qa.local`;
const canRead = (userId: string, roles: string[], permissions: string[], documentId: string) =>
  withWorkerTenantContext(TENANT, () => resolveACL({ resourceType: 'document', resourceId: documentId, permission: 'document:read', userId, userRole: roles[0], userRoles: roles, userPermissions: permissions, tenantId: TENANT }));

async function main() {
  if (process.env.NODE_ENV !== 'development' || String(config.DB_NAME) !== 'DMS') {
    console.error('Refusing: this verifier writes to the development database only.');
    process.exit(2);
  }
  initModels();
  await sequelize.authenticate();
  const admin = await actorFor(q('sysadmin'));
  const hr = (await Department.findOne({ where: { tenantId: TENANT, code: 'HR' } }))!;
  const hrDoc = (await Document.findOne({ where: { tenantId: TENANT, title: 'QA HR leave policy' } }))!;
  const employee = (await Role.findOne({ where: { name: 'EMPLOYEE' } }))!;

  // ── A: late joiner ──
  console.log('A. a late joiner reads the department\'s older documents and loses them on leaving');
  const joinerEmail = `qa.latejoiner.${stamp}@qa.local`;
  const joiner = await withWorkerTenantContext(TENANT, () => createUser(
    { email: joinerEmail, firstName: 'Late', lastName: 'Joiner', isActive: true, roleIds: [employee.id], departmentIds: [hr.id] },
    { userId: admin.userId, tenantId: TENANT, permissions: admin.permissions as never },
  ));
  const joinerPerms = await resolveUnionPermissions(['EMPLOYEE'], TENANT, joiner.id);
  check('created into HR → reads the HR document written months before', (await canRead(joiner.id, ['EMPLOYEE'], [...joinerPerms], hrDoc.id)).allowed);
  await withWorkerTenantContext(TENANT, () => removeDepartment(joiner.id, hr.id, TENANT, admin.userId));
  check('removed from HR → no longer reads it', !(await canRead(joiner.id, ['EMPLOYEE'], [...joinerPerms], hrDoc.id)).allowed);
  const leftRows = await AclEntry.count({ where: { tenantId: TENANT, resourceType: 'document', resourceId: hrDoc.id, principalType: 'user', principalId: joiner.id, origin: 'DEPT_SNAPSHOT' } });
  check('leaving removes the snapshot row itself', leftRows === 0, { leftRows });
  await withWorkerTenantContext(TENANT, () => assignDepartment(joiner.id, hr.id, TENANT, admin.userId));
  check('re-assigned to HR → reads it again', (await canRead(joiner.id, ['EMPLOYEE'], [...joinerPerms], hrDoc.id)).allowed);

  // ── B: folder move by a department head ──
  console.log('B. a department head moves folders in their subtree, another head cannot');
  const finDept = (await Department.findOne({ where: { tenantId: TENANT, code: 'FIN', orgUnitId: (await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } }))!.id } }))!;
  const open = (await FolderNode.findOne({ where: { tenantId: TENANT, departmentId: finDept.id, name: 'Open' } }))!;
  const restricted = (await FolderNode.findOne({ where: { tenantId: TENANT, departmentId: finDept.id, name: 'Restricted' } }))!;
  const year = (await FolderNode.findOne({ where: { tenantId: TENANT, parentId: open.id, name: '2026' } }))!;
  const finHead = await actorFor(q('fin.head'));
  const hrHead = await actorFor(q('hr.head'));
  await refused('the HR head cannot move a Finance folder', () => withWorkerTenantContext(TENANT, () => updateFolder(year.id, { parentId: restricted.id }, hrHead)), 'ERR-');
  await withWorkerTenantContext(TENANT, () => updateFolder(year.id, { parentId: restricted.id }, finHead))
    .then(() => check('the Finance head moves Open/2026 under Restricted', true))
    .catch((e) => check('the Finance head moves Open/2026 under Restricted', false, (e as Error).message));
  await withWorkerTenantContext(TENANT, () => updateFolder(year.id, { parentId: open.id }, finHead))
    .then(() => check('…and moves it back', true))
    .catch((e) => check('…and moves it back', false, (e as Error).message));

  // ── C: re-activation guards ──
  console.log('C. re-activating a department needs an active parent');
  const hq = (await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } }))!;
  const parent = await withWorkerTenantContext(TENANT, () => createDepartment({ orgUnitId: hq.id, code: `P${String(stamp).slice(-6)}`, name: `Guard parent ${stamp}` }, admin.userId, TENANT)) as { id: string };
  const child = await withWorkerTenantContext(TENANT, () => createDepartment({ orgUnitId: hq.id, code: `C${String(stamp).slice(-6)}`, name: `Guard child ${stamp}`, parentId: parent.id }, admin.userId, TENANT)) as { id: string };
  await withWorkerTenantContext(TENANT, async () => { await deactivateDepartment(child.id, admin.userId, TENANT); await deactivateDepartment(parent.id, admin.userId, TENANT); });
  await refused('the child cannot come back while its parent is inactive', () => withWorkerTenantContext(TENANT, () => updateDepartment(child.id, { isActive: true }, admin.userId, TENANT)), 'ERR-DEPT-PARENT-INACTIVE');
  await withWorkerTenantContext(TENANT, async () => { await updateDepartment(parent.id, { isActive: true }, admin.userId, TENANT); await updateDepartment(child.id, { isActive: true }, admin.userId, TENANT); })
    .then(() => check('parent first, then child → both active', true))
    .catch((e) => check('parent first, then child → both active', false, (e as Error).message));
  await withWorkerTenantContext(TENANT, async () => { await deactivateDepartment(child.id, admin.userId, TENANT); await deactivateDepartment(parent.id, admin.userId, TENANT); });

  // ── D: DENY beside ALLOW ──
  console.log('D. DENY beside ALLOW for the same person and permission');
  const noDept = (await User.findOne({ where: { email: q('no.dept') } }))!;
  const probeDoc = (await Document.findOne({ where: { tenantId: TENANT, title: 'QA Finance text note' } }))!;
  const noDeptPerms = await resolveUnionPermissions(['EMPLOYEE'], TENANT, noDept.id);
  await AclEntry.destroy({ where: { tenantId: TENANT, resourceType: 'document', resourceId: probeDoc.id, principalType: 'user', principalId: noDept.id } });
  await withWorkerTenantContext(TENANT, async () => {
    await createAclEntry('document', probeDoc.id, { principalType: 'user', principalId: noDept.id, permission: 'document:read', effect: 'ALLOW' } as never, admin.userId, TENANT);
    await createAclEntry('document', probeDoc.id, { principalType: 'user', principalId: noDept.id, permission: 'document:read', effect: 'DENY' } as never, admin.userId, TENANT);
  }).then(() => check('an ALLOW and a DENY for the same person/permission can both be stored', true))
    .catch((e) => check('an ALLOW and a DENY for the same person/permission can both be stored', false, (e as Error).message));
  const both = await canRead(noDept.id, ['EMPLOYEE'], [...noDeptPerms], probeDoc.id);
  check('DENY wins over the ALLOW', !both.allowed && both.effect === 'DENY', both);
  await AclEntry.destroy({ where: { tenantId: TENANT, resourceType: 'document', resourceId: probeDoc.id, principalType: 'user', principalId: noDept.id } });

  // ── E: snapshot promotion ──
  console.log('E. an explicit grant promotes the automatic snapshot row');
  const snapshot = await AclEntry.findOne({ where: { tenantId: TENANT, resourceType: 'document', resourceId: hrDoc.id, principalType: 'user', permission: 'document:read', origin: 'DEPT_SNAPSHOT' } });
  if (!snapshot) {
    check('there is a department-snapshot row to promote (seed prerequisite)', false);
  } else {
    await withWorkerTenantContext(TENANT, () => createAclEntry('document', hrDoc.id, { principalType: 'user', principalId: snapshot.principalId, permission: 'document:read', effect: 'ALLOW' } as never, admin.userId, TENANT))
      .then(() => check('granting the same access on purpose does not fail with a 409', true))
      .catch((e) => check('granting the same access on purpose does not fail with a 409', false, (e as { code?: string }).code ?? (e as Error).message));
    await snapshot.reload();
    check('the row is now a deliberate grant (origin cleared)', snapshot.origin === null, { origin: snapshot.origin });
    await snapshot.update({ origin: 'DEPT_SNAPSHOT' }); // put the seed back as it was
  }

  // ── F: self-deactivate ──
  console.log('F. nobody deactivates themselves');
  await refused('an administrator cannot deactivate their own account', () => withWorkerTenantContext(TENANT, () => deactivateUser(admin.userId, admin.userId)), 'ERR-SELF-DEACTIVATE');

  // ── G: readiness probe ──
  console.log('G. GET /operations/ready');
  try {
    const res = await fetch(`${API}/operations/ready`);
    const body = await res.json() as { ok?: boolean; failing?: unknown[]; degraded?: unknown[] };
    check('answers without a token', res.status === 200 || res.status === 503, { status: res.status });
    check('has the readiness shape { ok, failing[], degraded[] }', typeof body.ok === 'boolean' && Array.isArray(body.failing) && Array.isArray(body.degraded), body);
  } catch (e) {
    check('the dev API is reachable for the readiness probe', false, (e as Error).message);
  }

  // ── H: folder re-activation ──
  console.log('H. a deactivated folder can be brought back, with guards');
  const keeper = await withWorkerTenantContext(TENANT, () => createFolder({ name: `Reactivate ${stamp}`, departmentId: finDept.id, parentId: open.id }, admin.userId, TENANT, admin.permissions)) as { id: string };
  const subFolder = await withWorkerTenantContext(TENANT, () => createFolder({ name: `Child ${stamp}`, departmentId: finDept.id, parentId: keeper.id }, admin.userId, TENANT, admin.permissions)) as { id: string };
  await withWorkerTenantContext(TENANT, async () => { await deactivateFolder(subFolder.id, admin); await deactivateFolder(keeper.id, admin); });
  check('both folders are listed as deactivated', (await withWorkerTenantContext(TENANT, () => listInactiveFolders(admin))).filter((f) => f.id === keeper.id || f.id === subFolder.id).length === 2);
  await refused('the child cannot come back while its parent folder is inactive', () => withWorkerTenantContext(TENANT, () => reactivateFolder(subFolder.id, admin)), 'ERR-FOLDER-PARENT-INACTIVE');
  await refused('a head of another department cannot re-activate a Finance folder', () => withWorkerTenantContext(TENANT, () => reactivateFolder(keeper.id, hrHead)), 'ERR-FOLDER-SCOPE');
  await withWorkerTenantContext(TENANT, async () => { await reactivateFolder(keeper.id, admin); await reactivateFolder(subFolder.id, admin); })
    .then(() => check('parent first, then child → both active again', true))
    .catch((e) => check('parent first, then child → both active again', false, (e as Error).message));
  // path reuse: deactivate, create a new folder at the same path, the old one can no longer return
  await withWorkerTenantContext(TENANT, async () => { await deactivateFolder(subFolder.id, admin); });
  await withWorkerTenantContext(TENANT, () => createFolder({ name: `Child ${stamp}`, departmentId: finDept.id, parentId: keeper.id }, admin.userId, TENANT, admin.permissions));
  await refused('a folder whose path was reused cannot return', () => withWorkerTenantContext(TENANT, () => reactivateFolder(subFolder.id, admin)), 'ERR-FOLDER-PATH-TAKEN');

  // ── I: letter deadlines and escalation ──
  console.log('I. a letter step with a deadline is flagged, escalates to the head, and the head can decide it');
  {
    const author = await actorFor(q('fin.staff1'));
    const approver = await actorFor(q('fin.approver'));
    const outsider = await actorFor(q('hr.staff'));
    const hq = (await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } }))!;
    const fin = (await Department.findOne({ where: { tenantId: TENANT, code: 'FIN', orgUnitId: hq.id } }))!;
    const asUser = (a: typeof author) => ({ ...a } as never);
    const letter = await withWorkerTenantContext(TENANT, () => createLetter(
      { orgUnitId: hq.id, departmentId: fin.id, subject: `SLA letter ${stamp}`, bodyHtml: '<p>deadline</p>', letterType: 'OUT', correspondent: 'Someone' }, asUser(author),
    )) as { id: string };
    const before = Date.now();
    await withWorkerTenantContext(TENANT, () => submitLetter(letter.id, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId, slaHours: 1 }] }, asUser(author)));
    const step = (await LetterApprovalStep.findOne({ where: { letterId: letter.id, status: 'PENDING' } }))!;
    check('the first step has a deadline about one hour out', !!step.dueAt && Math.abs(step.dueAt.getTime() - (before + 3_600_000)) < 120_000, step.dueAt);
    check('nothing is flagged before the deadline', (await withWorkerTenantContext(TENANT, () => flagOverdueLetterSteps(TENANT))) === 0);

    await sequelize.query(`UPDATE letter_approval_steps SET due_at = now() - interval '1 hour' WHERE id = :id`, { replacements: { id: step.id } });
    const flagged = await withWorkerTenantContext(TENANT, () => flagOverdueLetterSteps(TENANT));
    check('after the deadline the sweep flags the step once', flagged === 1, flagged);
    check('a second sweep does not flag it again', (await withWorkerTenantContext(TENANT, () => flagOverdueLetterSteps(TENANT))) === 0);
    check('inside the grace period nothing escalates', (await withWorkerTenantContext(TENANT, () => escalateOverdueLetterSteps(TENANT))) === 0);

    await sequelize.query(`UPDATE letter_approval_steps SET sla_breached_at = now() - interval '48 hours' WHERE id = :id`, { replacements: { id: step.id } });
    const escalated = await withWorkerTenantContext(TENANT, () => escalateOverdueLetterSteps(TENANT));
    check('past the grace period the step escalates', escalated === 1, escalated);
    const after = (await LetterApprovalStep.findOne({ where: { id: step.id } }))!;
    check('escalation names at least one person, never the drafter or the assignee',
      after.escalatedToUserIds.length > 0 && !after.escalatedToUserIds.includes(author.userId) && !after.escalatedToUserIds.includes(approver.userId), after.escalatedToUserIds);
    await refused('someone the step is not assigned or escalated to still cannot decide it',
      () => withWorkerTenantContext(TENANT, () => decideStep(letter.id, step.id, { decision: 'APPROVE' }, asUser(outsider))), 'ERR-STEP-NOT-ASSIGNED');

    const targetId = after.escalatedToUserIds[0]!;
    const targetEmail = (await User.findByPk(targetId))!.email;
    const target = await actorFor(targetEmail);
    await withWorkerTenantContext(TENANT, () => decideStep(letter.id, step.id, { decision: 'APPROVE', comment: 'covering for the overdue approver' }, asUser(target)))
      .then(() => check(`the escalated person (${targetEmail}) can approve the step`, true))
      .catch((e) => check(`the escalated person (${targetEmail}) can approve the step`, false, (e as Error).message));

    // recall: a second letter, submitted then pulled back by its drafter
    const second = await withWorkerTenantContext(TENANT, () => createLetter(
      { orgUnitId: hq.id, departmentId: fin.id, subject: `Recall letter ${stamp}`, bodyHtml: '<p>recall</p>', letterType: 'OUT', correspondent: 'Someone' }, asUser(author),
    )) as { id: string };
    await withWorkerTenantContext(TENANT, () => submitLetter(second.id, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] }, asUser(author)));
    const recalled = await withWorkerTenantContext(TENANT, () => recallLetter(second.id, {}, asUser(author))) as { status: string };
    check('the drafter recalls a letter in review; it comes back as RETURNED', recalled.status === 'RETURNED', recalled.status);
    check('the recalled step is cancelled, not left pending', (await LetterApprovalStep.count({ where: { letterId: second.id, status: 'PENDING' } })) === 0);
  }

  // ── J: default (catch-all) approval recipes ──
  console.log('J. a default recipe per scope; the most specific wins; switching one off falls back');
  {
    const hq = (await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } }))!;
    const fin = (await Department.findOne({ where: { tenantId: TENANT, code: 'FIN', orgUnitId: hq.id } }))!;
    const scope = { departmentId: fin.id, orgUnitId: hq.id };
    const find = () => withWorkerTenantContext(TENANT, () => findChainRecipe({ tenantId: TENANT, scope }));
    // start from a clean slate for the two scopes this check uses
    await sequelize.query(`UPDATE approval_chain_templates SET is_active = false WHERE tenant_id = :t AND document_type_id IS NULL AND form_template_id IS NULL AND NOT for_form_templates AND (department_id = :d OR org_unit_id = :o)`, { replacements: { t: TENANT, d: fin.id, o: hq.id } });
    check('with no default recipe, nothing is found for a type that has no recipe', (await find()) === null);
    const unit = await withWorkerTenantContext(TENANT, () => upsertChainTemplate({ isDefault: true, orgUnitId: hq.id, name: `HQ default ${stamp}`, steps: [{ stepType: 'APPROVE', assignedRole: 'EXECUTIVE' }] }, admin as never)) as { id: string };
    check('an org-unit default is found for a department under it', (await find())?.id === unit.id);
    const dept = await withWorkerTenantContext(TENANT, () => upsertChainTemplate({ isDefault: true, departmentId: fin.id, name: `FIN default ${stamp}`, steps: [{ stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER' }] }, admin as never)) as { id: string };
    check('a department default beats the org-unit default', (await find())?.id === dept.id);
    const again = await withWorkerTenantContext(TENANT, () => upsertChainTemplate({ isDefault: true, departmentId: fin.id, name: `FIN default v2 ${stamp}`, steps: [{ stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER' }] }, admin as never)) as { id: string };
    check('saving a default again replaces it (one active default per scope)', (await find())?.id === again.id && again.id !== dept.id);
    await withWorkerTenantContext(TENANT, () => deactivateChainTemplate(again.id, admin as never));
    check('switching the department default off falls back to the org-unit default', (await find())?.id === unit.id);
    await withWorkerTenantContext(TENANT, () => deactivateChainTemplate(unit.id, admin as never));
    check('switching that off too leaves nothing (built-in default applies)', (await find()) === null);
    const someType = (await sequelize.query(`SELECT id FROM document_types WHERE tenant_id = :t LIMIT 1`, { replacements: { t: TENANT } }))[0][0] as { id: string };
    await refused('a recipe cannot target a document type AND be a default', () => withWorkerTenantContext(TENANT, () => upsertChainTemplate({ isDefault: true, documentTypeId: someType.id, name: 'x', steps: [{ stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER' }] }, admin as never)), 'ERR-TEMPLATE-TARGET');
  }

  // ── K: custom roles ──
  console.log('K. custom roles: edit the description, protect built-ins, delete only when nothing uses the role');
  {
    const name = `QA_TMP_ROLE_${stamp}`;
    const role = await Role.create({ name, description: 'temporary' } as never);
    const hq = (await OrgUnit.findOne({ where: { tenantId: TENANT, code: 'HQ' } }))!;
    const actor = { userId: admin.userId, role: admin.role, tenantId: TENANT };
    await withWorkerTenantContext(TENANT, () => updateCustomRoleDescription(role.id, 'changed description', actor));
    check('a custom role description can be changed', (await Role.findByPk(role.id))!.description === 'changed description');
    await refused('a built-in role description cannot be changed', async () => withWorkerTenantContext(TENANT, async () => updateCustomRoleDescription((await Role.findOne({ where: { name: 'EMPLOYEE' } }))!.id, 'x', actor)), 'ERR-ROLE-BUILT-IN');
    await refused('a built-in role cannot be deleted', async () => withWorkerTenantContext(TENANT, async () => deleteCustomRole((await Role.findOne({ where: { name: 'EMPLOYEE' } }))!.id, actor)), 'ERR-ROLE-BUILT-IN');

    // held by a person → refused with the count
    const holder = (await User.findOne({ where: { email: q('fin.staff2') } }))!;
    await sequelize.query(`INSERT INTO user_roles (user_id, role_id) VALUES (:u, :r) ON CONFLICT DO NOTHING`, { replacements: { u: holder.id, r: role.id } });
    await refused('a role someone holds cannot be deleted', () => withWorkerTenantContext(TENANT, () => deleteCustomRole(role.id, actor)), 'ERR-ROLE-IN-USE');
    await sequelize.query(`DELETE FROM user_roles WHERE user_id = :u AND role_id = :r`, { replacements: { u: holder.id, r: role.id } });

    // named in an active approval recipe step → refused
    const recipe = await withWorkerTenantContext(TENANT, () => upsertChainTemplate({ isDefault: true, orgUnitId: hq.id, name: `uses ${name}`, steps: [{ stepType: 'APPROVE', assignedRole: name }] }, admin as never)) as { id: string };
    await refused('a role used by an active approval recipe cannot be deleted', () => withWorkerTenantContext(TENANT, () => deleteCustomRole(role.id, actor)), 'ERR-ROLE-IN-RECIPE');
    await withWorkerTenantContext(TENANT, () => deactivateChainTemplate(recipe.id, admin as never));

    // mapped from an SSO group → refused
    await sequelize.query(`INSERT INTO idp_role_mappings (relying_party, ad_group_dn, role_name) VALUES ('edams', :dn, :n)`, { replacements: { dn: `CN=${name},OU=Test`, n: name } });
    await refused('a role an SSO group mapping grants cannot be deleted', () => withWorkerTenantContext(TENANT, () => deleteCustomRole(role.id, actor)), 'ERR-ROLE-MAPPED');
    await sequelize.query(`DELETE FROM idp_role_mappings WHERE role_name = :n`, { replacements: { n: name } });

    await withWorkerTenantContext(TENANT, () => deleteCustomRole(role.id, actor))
      .then(() => check('with nothing using it, the role is deleted', true))
      .catch((e) => check('with nothing using it, the role is deleted', false, (e as Error).message));
    check('and it is really gone', (await Role.findByPk(role.id)) === null);
  }

  // ── L: classified documents ──
  console.log('L. CONFIDENTIAL / RESTRICTED documents: owner, shared people, head (Confidential only) and oversight roles');
  {
    const doc = (await Document.findOne({ where: { tenantId: TENANT, title: 'QA Finance PDF report' } }))!;
    const originalClass = doc.securityClassification;
    const ownerEmail = (await User.findByPk(doc.ownerId!))!.email;
    const keys = ['fin.staff1', 'fin.staff2', 'fin.approver', 'fin.head', 'fap.head', 'hr.head', 'no.dept', 'exec', 'auditor', 'records', 'sysadmin'];
    const people: Record<string, Awaited<ReturnType<typeof actorFor>>> = {};
    for (const k of keys) people[k] = await actorFor(q(k));
    // the platform administrator: a real person's id carrying the platform administrator role and its full permission set
    const pa = { userId: admin.userId, role: 'PLATFORM_ADMIN', roles: ['PLATFORM_ADMIN'], tenantId: TENANT, permissions: [...ROLE_PERMISSIONS.PLATFORM_ADMIN] as string[] };
    const ownerKey = keys.find((k) => q(k) === ownerEmail);

    /** can each person open the document: by the single resolver and, as a cross-check, by the batch resolver the lists use */
    const reads = async (docId: string, who: string[] = keys) => {
      const out: Record<string, boolean> = {};
      for (const k of who) {
        const a = people[k]!;
        const single = (await canRead(a.userId, a.roles, a.permissions, docId)).allowed;
        const batch = (await withWorkerTenantContext(TENANT, () => resolveACLBatch([docId], { permission: 'document:read', userId: a.userId, userRole: a.role, userRoles: a.roles, userPermissions: a.permissions, tenantId: TENANT }))).get(docId)?.allowed ?? false;
        if (single !== batch) check(`single and batch resolvers agree for ${k}`, false, { single, batch });
        out[k] = single;
      }
      out['platform-admin'] = (await canRead(pa.userId, pa.roles, pa.permissions, docId)).allowed;
      return out;
    };
    const expectMap = (label: string, got: Record<string, boolean>, allowed: string[]) => {
      const wrong = Object.keys(got).filter((k) => got[k] !== allowed.includes(k));
      check(label, wrong.length === 0, wrong.map((k) => `${k}: got ${got[k]}`));
    };
    const oversight = ['exec', 'auditor', 'records', 'sysadmin', 'platform-admin'];
    const addRow = (over: Record<string, unknown>) => AclEntry.create({ tenantId: TENANT, resourceType: 'document', resourceId: doc.id, principalType: 'user', permission: 'document:read', effect: 'ALLOW', grantedById: admin.userId, origin: null, ...over } as never);
    const adminActor = admin as never;

    try {
      const setClass = (cls: string) => withWorkerTenantContext(TENANT, () => changeDocumentClassification(doc.id, { classification: cls, reason: 'set by the classified-document checks' }, adminActor));
      await setClass('INTERNAL');
      const open = await reads(doc.id);
      check('INTERNAL: department members read it as before', open['fin.approver'] === true && open['fin.staff1'] === true, open);

      await setClass('CONFIDENTIAL');
      const conf = await reads(doc.id);
      expectMap('CONFIDENTIAL: owner, the person it was shared with, the department head and oversight roles', conf,
        [...(ownerKey ? [ownerKey] : []), 'no.dept', 'fin.head', ...oversight]);
      check('CONFIDENTIAL: a department colleague (member, no grant) cannot open it', conf['fin.approver'] === false);
      check('CONFIDENTIAL: the head of a DIFFERENT department cannot', conf['hr.head'] === false && conf['fap.head'] === false);

      await setClass('RESTRICTED');
      const restr = await reads(doc.id);
      expectMap('RESTRICTED: owner, shared people and oversight roles, but NOT the department head', restr,
        [...(ownerKey ? [ownerKey] : []), 'no.dept', ...oversight]);
      check('the platform administrator reads a RESTRICTED document', restr['platform-admin'] === true);

      // a deliberate grant on the document opens it; one on the folder does not
      // (this person already has the automatic department row, so sharing PROMOTES it to a deliberate grant, as createAclEntry does)
      const approverRow = { tenantId: TENANT, resourceType: 'document', resourceId: doc.id, principalType: 'user', principalId: people['fin.approver']!.userId, permission: 'document:read', effect: 'ALLOW' };
      await AclEntry.update({ origin: null } as never, { where: approverRow as never });
      check('RESTRICTED: a person it is shared with can open it', (await reads(doc.id, ['fin.approver']))['fin.approver'] === true);
      await AclEntry.update({ origin: 'DEPT_SNAPSHOT' } as never, { where: approverRow as never });
      check('RESTRICTED: and loses it when the share is removed (only the automatic department row remains)', (await reads(doc.id, ['fin.approver']))['fin.approver'] === false);
      if (doc.folderId) {
        const folderGrant = await AclEntry.create({ tenantId: TENANT, resourceType: 'folder', resourceId: doc.folderId, principalType: 'user', principalId: people['fin.approver']!.userId, permission: 'document:read', effect: 'ALLOW', grantedById: admin.userId, origin: null } as never);
        check('RESTRICTED: a grant on the FOLDER does not open it', (await reads(doc.id, ['fin.approver']))['fin.approver'] === false);
        await folderGrant.destroy();
      }

      // an explicit DENY still wins, even over the head rule
      await setClass('CONFIDENTIAL');
      const deny = await addRow({ principalId: people['fin.head']!.userId, effect: 'DENY' });
      check('CONFIDENTIAL: an explicit DENY beats the head rule', (await reads(doc.id, ['fin.head']))['fin.head'] === false);
      await deny.destroy();
      check('CONFIDENTIAL: the head reads it again once the DENY is gone', (await reads(doc.id, ['fin.head']))['fin.head'] === true);

      // lists follow the same rule
      const titlesFor = async (k: string) => (await withWorkerTenantContext(TENANT, () => listDocuments(people[k] as never, 0, 20, { q: 'QA Finance PDF report' }))).data.map((d: { title: string }) => d.title);
      check('the Documents list hides it from a department colleague', !(await titlesFor('fin.approver')).includes('QA Finance PDF report'));
      check('the Documents list still shows it to the department head (CONFIDENTIAL)', (await titlesFor('fin.head')).includes('QA Finance PDF report'));
      await setClass('RESTRICTED');
      check('the Documents list hides a RESTRICTED document from the head', !(await titlesFor('fin.head')).includes('QA Finance PDF report'));
      check('the Documents list shows it to an oversight role', (await titlesFor('auditor')).includes('QA Finance PDF report'));

      // who may change a class, and the reason rule
      await refused('a department colleague who is neither owner nor head cannot change the class', () => withWorkerTenantContext(TENANT, () => changeDocumentClassification(doc.id, { classification: 'PUBLIC', reason: 'trying it out for size' }, people['fin.approver'] as never)), 'ERR-');
      await refused('the head of another department cannot change it', () => withWorkerTenantContext(TENANT, () => changeDocumentClassification(doc.id, { classification: 'PUBLIC', reason: 'trying it out for size' }, people['hr.head'] as never)), 'ERR-');
      await refused('lowering a class without a reason is refused', () => withWorkerTenantContext(TENANT, () => changeDocumentClassification(doc.id, { classification: 'INTERNAL' }, adminActor)), 'ERR-REASON-REQUIRED');
      await withWorkerTenantContext(TENANT, () => changeDocumentClassification(doc.id, { classification: 'INTERNAL', reason: 'Checked: no longer sensitive' }, adminActor));
      check('lowering with a reason reopens it to the department at once', (await reads(doc.id, ['fin.approver']))['fin.approver'] === true);
      const auditRows = (await sequelize.query(`SELECT count(*) AS n FROM audit_logs WHERE document_id = :id AND event_type = 'DOC_CLASSIFICATION_CHANGED'`, { replacements: { id: doc.id } }))[0] as Array<{ n: string }>;
      check('the changes are in the audit log', Number(auditRows[0]?.n ?? 0) >= 2, auditRows);

      // one answer for a document's class: the label follows it in the database whatever writes the row (migration 20261011000010)
      const labelOf = async () => ((await sequelize.query(`SELECT security_classification AS c, "sensitivityLabel" AS l FROM documents WHERE id = :id`, { replacements: { id: doc.id } }))[0] as Array<{ c: string; l: string }>)[0]!;
      const titleCase = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
      const afterChange = await withWorkerTenantContext(TENANT, labelOf);
      check('the label follows the class after a class change', afterChange.l === titleCase(afterChange.c), afterChange);
      await withWorkerTenantContext(TENANT, () => sequelize.query(`UPDATE documents SET "sensitivityLabel" = 'Restricted' WHERE id = :id`, { replacements: { id: doc.id } }));
      const afterRogue = await withWorkerTenantContext(TENANT, labelOf);
      check('a write that tries to set the label on its own is overruled by the database', afterRogue.l === afterChange.l && afterRogue.l !== 'Restricted', afterRogue);
      await refused('a class outside the four is refused by the database', () => withWorkerTenantContext(TENANT, () => sequelize.query(`UPDATE documents SET security_classification = 'SECRET' WHERE id = :id`, { replacements: { id: doc.id } })), 'documents_security_classification_check');

      // a letter's documents are refused (the letters module decides who reads a letter)
      const letterDocRows = (await sequelize.query(`SELECT document_id AS id FROM letters WHERE tenant_id = :t AND document_id IS NOT NULL LIMIT 1`, { replacements: { t: TENANT } }))[0] as Array<{ id: string }>;
      if (letterDocRows[0]) {
        const letterDocId = letterDocRows[0].id;
        await refused("a letter's document cannot be reclassified here", () => withWorkerTenantContext(TENANT, () => changeDocumentClassification(letterDocId, { classification: 'PUBLIC', reason: 'trying it out for size' }, adminActor)), 'ERR-CLASSIFICATION-LETTER');
      } else console.log('  (no letter document in this tenant: letter refusal not exercised)');

      // letters are unchanged, and the platform administrator reads every letter whatever its confidentiality
      const subject = 'QA confidential outgoing letter';
      const lettersFor = async (u: unknown) => ((await withWorkerTenantContext(TENANT, () => listLetters({ q: subject, take: 20 }, u as never))) as { data: Array<{ subject: string }> }).data.map((l) => l.subject);
      check('the platform administrator reads a CONFIDENTIAL letter', (await lettersFor(pa)).includes(subject));
      check('oversight roles read it too', (await lettersFor(people['auditor'])).includes(subject) && (await lettersFor(people['records'])).includes(subject) && (await lettersFor(people['exec'])).includes(subject));
      check('a department colleague who is not on the letter does not', !(await lettersFor(people['fin.staff2'])).includes(subject));
    } finally {
      await Document.update({ securityClassification: originalClass, sensitivityLabel: originalClass.charAt(0) + originalClass.slice(1).toLowerCase() }, { where: { id: doc.id } });
    }
  }

  // clean up the throwaway person
  await User.update({ isActive: false }, { where: { id: joiner.id } });

  console.log(`\n${passed} passed, ${failed} failed`);
  await sequelize.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
