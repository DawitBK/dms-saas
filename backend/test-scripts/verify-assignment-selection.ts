/**
 * Assignment-selection verification — live HTTP test against the dev backend.
 *
 * Covers the "choose an approver / signer by ROLE or by NAMED PERSON" capability
 * added on 2026-09-02/03 across letters, the unified approvals engine, and
 * generic e-signing:
 *
 *   - GET /assignment-advisory/check   (non-blocking cross-department / no-ACL
 *     warning data — never refuses an assignment)
 *   - GET /assignment-advisory/roles   (per-tenant role list, permission-filtered,
 *     reachable by ordinary drafters — not gated on role:read like GET /roles)
 *   - GET /letters/assignable-users    (named-person candidates for a drafter)
 *   - POST /letters/:id/submit { signatory } — default / named / role
 *   - the role-based e-sign recipient: unclaimed → notified → claimed by the
 *     first qualified, department-scoped holder → rejected for everyone else
 *
 * The critical NO-REGRESSION case (omit `signatory` → the final approver signs,
 * exactly as before) is already covered end-to-end by verify-cams.ts.
 *
 * Run: npx tsx test-scripts/verify-assignment-selection.ts   (backend running)
 */

import axios from 'axios';
import { loginAs, verifyAdminEmail } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string; user: any }> {
  return loginAs(email, 'verify-assignment-selection.ts');
}

const authOf = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const status = (e: any) => e.response?.status ?? 0;
const errCode = (e: any) => e.response?.data?.error?.code ?? '';

/** Poll until the letter's ceremony request is actually sendable
 *  (sendSignatureRequest runs on a post-commit setImmediate). */
async function waitForSendableRequest(documentId: string, auth: any): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const requests = (await axios.get(`${API_BASE}/documents/${documentId}/signing`, auth)).data.data;
    const hit = requests.find((r: any) => ['sent', 'partially_signed'].includes(r.status));
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`no sendable signature request on document ${documentId}`);
}

async function signAs(requestId: string, recipientId: string, auth: any) {
  const full = (await axios.get(`${API_BASE}/signing/${requestId}`, auth)).data.data;
  const fieldValues = (full.fields ?? [])
    .filter((f: any) => f.recipientId === recipientId)
    .map((f: any) => ({ fieldId: f.id, value: 'verify-assignment signature' }));
  return axios.post(`${API_BASE}/signing/${requestId}/recipients/${recipientId}/sign`, { fieldValues }, auth);
}

async function waitForLetterOut(letterId: string, fromStatus: string, auth: any): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const letter = (await axios.get(`${API_BASE}/letters/${letterId}`, auth)).data.data;
    if (letter.status !== fromStatus) return letter;
    await sleep(250);
  }
  return (await axios.get(`${API_BASE}/letters/${letterId}`, auth)).data.data;
}

async function main() {
  console.log('\n═══ Assignment-selection verification ═══\n');

  const admin = await loginWithTenant(verifyAdminEmail());
  const adminAuth = authOf(admin.token);
  const finManager = await loginWithTenant('manager@edams.local');       // DEPT_MANAGER, FIN
  const finManagerAuth = authOf(finManager.token);
  const hrManager = await loginWithTenant('hr.manager@edams.local');     // DEPT_MANAGER, HR (cross-department)
  const hrManagerAuth = authOf(hrManager.token);
  const employee = await loginWithTenant('employee@edams.local');        // EMPLOYEE, FIN (letter:create only)
  const employeeAuth = authOf(employee.token);
  console.log('Setup: admin / FIN manager / HR manager / FIN employee logged in');

  const units = (await axios.get(`${API_BASE}/org-units`, adminAuth)).data.data;
  const hq = units.find((u: any) => u.code === 'HQ') ?? units[0];
  const departments = (await axios.get(`${API_BASE}/departments`, adminAuth)).data.data;
  const fin = departments.find((d: any) => d.code === 'FIN');
  const hr = departments.find((d: any) => d.code === 'HR');
  check('FIN + HR departments resolved', Boolean(fin && hr));

  const newLetter = async (auth: any, subject: string) =>
    (await axios.post(
      `${API_BASE}/letters`,
      { orgUnitId: hq.id, departmentId: fin.id, subject, bodyHtml: '<p>body</p>', letterType: 'OUT' },
      auth,
    )).data.data;

  // ── 1. Advisory endpoint (warn, never block) ──
  console.log('\n1. GET /assignment-advisory/check');
  {
    const outside = (await axios.get(
      `${API_BASE}/assignment-advisory/check?candidateUserId=${hrManager.user.id}` +
      `&departmentId=${fin.id}&resourceType=department&resourceId=${fin.id}&permission=document:read`,
      adminAuth,
    )).data.data;
    check('HR manager reports inDepartment=false against a FIN letter', outside.inDepartment === false, outside);

    const inside = (await axios.get(
      `${API_BASE}/assignment-advisory/check?candidateUserId=${finManager.user.id}` +
      `&departmentId=${fin.id}&resourceType=department&resourceId=${fin.id}&permission=document:read`,
      adminAuth,
    )).data.data;
    check('FIN manager reports inDepartment=true', inside.inDepartment === true, inside);
    check('advisory always answers both halves (never throws on a denied ACL)',
      typeof outside.aclAllowed === 'boolean' && typeof inside.aclAllowed === 'boolean');

    const bad = await axios
      .get(`${API_BASE}/assignment-advisory/check?candidateUserId=${finManager.user.id}&resourceType=nonsense&resourceId=x`, adminAuth)
      .then(() => 0)
      .catch(status);
    check('invalid resourceType → 422 (not a 500)', bad === 422, bad);
  }

  // ── 2. Role list (per-tenant, permission-filtered, drafter-reachable) ──
  console.log('\n2. GET /assignment-advisory/roles');
  {
    const approveRoles = (await axios.get(`${API_BASE}/assignment-advisory/roles?permission=letter:approve`, adminAuth)).data.data
      .map((r: any) => r.name);
    check('letter:approve roles include DEPT_MANAGER + APPROVER',
      approveRoles.includes('DEPT_MANAGER') && approveRoles.includes('APPROVER'), approveRoles.join(','));
    // RECORDS_OFFICER holds letter:create/read/register/dispatch but NOT
    // letter:approve — it must not be offered as an approval-step role, or
    // submitLetter rejects it with ERR-STEP-ROLE-INVALID.
    check('letter:approve roles exclude RECORDS_OFFICER (it does not hold it)',
      !approveRoles.includes('RECORDS_OFFICER'), approveRoles.join(','));
    check('EMPLOYEE is not offered as an approval role', !approveRoles.includes('EMPLOYEE'));

    const decideRoles = (await axios.get(`${API_BASE}/assignment-advisory/roles?permission=approval:decide`, adminAuth)).data.data
      .map((r: any) => r.name);
    check('approval:decide roles include RECORDS_OFFICER (it does hold that one)',
      decideRoles.includes('RECORDS_OFFICER'), decideRoles.join(','));

    const all = (await axios.get(`${API_BASE}/assignment-advisory/roles`, adminAuth)).data.data;
    check('unfiltered list returns every tenant role with an id + name',
      all.length >= decideRoles.length && all.every((r: any) => r.id && r.name), all.length);

    // The whole point of this endpoint: an ordinary drafter can read it.
    // GET /roles (role:read | acl:manage) 403s for EMPLOYEE.
    const asEmployee = await axios.get(`${API_BASE}/assignment-advisory/roles?permission=letter:approve`, employeeAuth)
      .then((r) => r.data.data.length).catch((e) => `HTTP ${status(e)}`);
    check('an EMPLOYEE drafter can read the role list', asEmployee === approveRoles.length, asEmployee);
    const rolesForbidden = await axios.get(`${API_BASE}/roles`, employeeAuth).then(() => 200).catch(status);
    check('…while GET /roles still 403s for them (gate unchanged)', rolesForbidden === 403, rolesForbidden);

    const badPerm = await axios.get(`${API_BASE}/assignment-advisory/roles?permission=not:areal`, adminAuth)
      .then(() => 0).catch(status);
    check('unknown permission → 422', badPerm === 422, badPerm);
  }

  // ── 3. Named-person candidates for a drafter ──
  console.log('\n3. GET /letters/assignable-users');
  {
    const approvers = (await axios.get(`${API_BASE}/letters/assignable-users?stepType=APPROVE`, employeeAuth)).data.data;
    check('an EMPLOYEE drafter gets a non-empty approver list', approvers.length > 0, approvers.length);
    check('candidates carry their departments (for the cross-department warning)',
      approvers.every((u: any) => Array.isArray(u.departments)));
    check('list is NOT department-filtered — a named pick is global by design',
      approvers.some((u: any) => (u.departments ?? []).every((d: any) => d.id !== fin.id)),
      'expected at least one candidate outside FIN');

    const signatories = (await axios.get(`${API_BASE}/letters/assignable-users?stepType=SIGNATORY`, employeeAuth)).data.data;
    check('SIGNATORY candidates are unrestricted (superset of approvers)',
      signatories.length >= approvers.length, `${signatories.length} >= ${approvers.length}`);
  }

  // The product refuses self-approval (ERR-SELF-APPROVAL: the drafter cannot approve their own letter), so from here the
  // FIN employee drafts and submits and the administrator decides, which is what the demo seed's two accounts did not need.
  // ── 4. Letters: named signatory override ──
  console.log('\n4. Letter with a NAMED signatory (cross-department, allowed)');
  {
    const letter = await newLetter(employeeAuth, `Named signatory ${Date.now()}`);
    const submitted = (await axios.post(
      `${API_BASE}/letters/${letter.id}/submit`,
      {
        steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }],
        signatory: { assignedUserId: hrManager.user.id },
      },
      employeeAuth,
    )).data.data;
    check('submit accepts a cross-department named signatory (warn, never block)',
      submitted.status === 'IN_REVIEW', submitted.status);

    const step = (submitted.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
    const decided = (await axios.post(
      `${API_BASE}/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE' }, adminAuth,
    )).data.data;
    check('final approval completes approval phase', decided.status === 'APPROVED', decided.status);

    const pending = (await axios.post(
      `${API_BASE}/letters/${letter.id}/initiate-signing`,
      { signatory: { assignedUserId: hrManager.user.id } },
      adminAuth,
    )).data.data;
    check('initiating signing parks the letter in PENDING_SIGNATURE', pending.status === 'PENDING_SIGNATURE', pending.status);

    const request = await waitForSendableRequest(pending.documentId, adminAuth);
    const full = (await axios.get(`${API_BASE}/signing/${request.id}`, adminAuth)).data.data;
    const recipient = full.recipients[0];
    check('the ceremony targets the CHOSEN person, not the approver',
      recipient.dmsUserId === hrManager.user.id, `${recipient.dmsUserId} vs approver ${admin.user.id}`);

    const approverBlocked = await signAs(request.id, recipient.id, adminAuth).then(() => 0).catch(status);
    check('the approver can no longer sign it (403)', approverBlocked === 403, approverBlocked);

    await signAs(request.id, recipient.id, hrManagerAuth);
    const finalLetter = await waitForLetterOut(letter.id, 'PENDING_SIGNATURE', adminAuth);
    check('the chosen signer completes it → APPROVED + reference number',
      finalLetter.status === 'APPROVED' && Boolean(finalLetter.referenceNumber), finalLetter.status);
    check('signatory recorded as the chosen person',
      (finalLetter.signatoryName ?? '').includes(hrManager.user.firstName), finalLetter.signatoryName);
  }

  // ── 5. Letters: role-based signatory ──
  console.log('\n5. Letter with a ROLE signatory (department-scoped)');
  {
    const letter = await newLetter(employeeAuth, `Role signatory ${Date.now()}`);
    const submitted = (await axios.post(
      `${API_BASE}/letters/${letter.id}/submit`,
      {
        steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }],
        signatory: { assignedRole: 'DEPT_MANAGER' },
      },
      employeeAuth,
    )).data.data;
    check('submit accepts a staffed role signatory', submitted.status === 'IN_REVIEW', submitted.status);

    const step = (submitted.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
    const decided = (await axios.post(
      `${API_BASE}/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE' }, adminAuth,
    )).data.data;
    check('final approval completes approval phase', decided.status === 'APPROVED', decided.status);

    const pending = (await axios.post(
      `${API_BASE}/letters/${letter.id}/initiate-signing`,
      { signatory: { assignedRole: 'DEPT_MANAGER' } },
      adminAuth,
    )).data.data;
    check('initiating signing parks the letter in PENDING_SIGNATURE', pending.status === 'PENDING_SIGNATURE', pending.status);

    const request = await waitForSendableRequest(pending.documentId, adminAuth);
    const full = (await axios.get(`${API_BASE}/signing/${request.id}`, adminAuth)).data.data;
    const recipient = full.recipients[0];
    check('recipient is created UNCLAIMED with the role recorded',
      recipient.assignedRole === 'DEPT_MANAGER' && !recipient.dmsUserId, recipient);
    check('unclaimed recipient carries a non-routable placeholder address',
      String(recipient.email).endsWith('@unassigned.internal'), recipient.email);

    // The FIN role holder sees it in their queue; the HR one (same role,
    // wrong department) does not.
    const finQueue = (await axios.get(`${API_BASE}/signing/requests?scope=pending-me`, finManagerAuth)).data.data;
    check('a department-scoped role holder sees the unclaimed task in My Work',
      finQueue.some((r: any) => r.id === recipient.id), finQueue.length);
    const hrQueue = (await axios.get(`${API_BASE}/signing/requests?scope=pending-me`, hrManagerAuth)).data.data;
    check('a same-role holder in ANOTHER department does not see it',
      !hrQueue.some((r: any) => r.id === recipient.id), hrQueue.length);

    const wrongDept = await signAs(request.id, recipient.id, hrManagerAuth).then(() => 0).catch(status);
    check('…and cannot claim it either (403)', wrongDept === 403, wrongDept);

    await signAs(request.id, recipient.id, finManagerAuth);
    const claimed = (await axios.get(`${API_BASE}/signing/${request.id}`, adminAuth)).data.data.recipients[0];
    check('claiming replaces the placeholder with the real signer identity',
      claimed.dmsUserId === finManager.user.id && !String(claimed.email).endsWith('@unassigned.internal'),
      `${claimed.name} <${claimed.email}>`);

    // 409 ERR-INVALID-STATE (the whole request is 'completed' once its only
    // recipient signed) rather than 409 ERR-ALREADY-SIGNED — the request-level
    // state guard runs first. Either way the slot is closed to a second signer.
    const secondAttempt = await signAs(request.id, recipient.id, finManagerAuth).then(() => 0).catch(status);
    check('the slot cannot be signed twice', secondAttempt === 400 || secondAttempt === 409, secondAttempt);

    const finalLetter = await waitForLetterOut(letter.id, 'PENDING_SIGNATURE', adminAuth);
    check('role-signed letter finalizes → APPROVED + reference number',
      finalLetter.status === 'APPROVED' && Boolean(finalLetter.referenceNumber), finalLetter.status);
  }

  // ── 6. Guards that must still block (role assignment is NOT best-effort) ──
  console.log('\n6. Guards');
  {
    const letter = await newLetter(employeeAuth, `Unstaffed role ${Date.now()}`);
    const unstaffed = await axios.post(
      `${API_BASE}/letters/${letter.id}/submit`,
      { steps: [{ stepType: 'APPROVE', assignedRole: 'AUDITOR' }] },
      employeeAuth,
    ).then(() => '').catch(errCode);
    check('a role with no holder in the letter\'s department is rejected at submit',
      unstaffed === 'ERR-STEP-ROLE-UNSTAFFED' || unstaffed === 'ERR-STEP-ROLE-INVALID', unstaffed);

    const letter2 = await newLetter(employeeAuth, `Both signatory kinds ${Date.now()}`);
    const submitted2 = (await axios.post(
      `${API_BASE}/letters/${letter2.id}/submit`,
      { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] },
      employeeAuth,
    )).data.data;
    const step2 = (submitted2.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
    await axios.post(`${API_BASE}/letters/${letter2.id}/steps/${step2.id}/decision`, { decision: 'APPROVE' }, adminAuth);

    const both = await axios.post(
      `${API_BASE}/letters/${letter2.id}/initiate-signing`,
      {
        signatory: { assignedUserId: hrManager.user.id, assignedRole: 'DEPT_MANAGER' },
      },
      adminAuth,
    ).then(() => 0).catch(status);
    check('both a named user AND a role on one signatory → 400 ERR-VALIDATION', both === 400, both);

    const letter3 = await newLetter(employeeAuth, `Invalid step role ${Date.now()}`);
    const badRole = await axios.post(
      `${API_BASE}/letters/${letter3.id}/submit`,
      { steps: [{ stepType: 'APPROVE', assignedRole: 'RECORDS_OFFICER' }] },
      employeeAuth,
    ).then(() => '').catch(errCode);
    check('a role without letter:approve is still rejected for an APPROVE step',
      badRole === 'ERR-STEP-ROLE-INVALID', badRole);
  }

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.response?.data ?? e.message);
  process.exit(1);
});
