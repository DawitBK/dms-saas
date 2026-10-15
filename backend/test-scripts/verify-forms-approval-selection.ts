/**
 * Forms: the submitter chooses who approves.
 *
 * THE BUG THIS PINS
 *
 * `createFormInstance` called `submitForApproval('FORM_INSTANCE', id, {}, user)`
 * — an EMPTY step list. The engine's fallback for that is its hardcoded single
 * [{ APPROVE, DEPT_MANAGER }] default, so EVERY form filed in this system got
 * that one chain regardless of who the submitter wanted, and there was no UI to
 * want anything else. Every form chain in the live database was exactly that
 * shape: one step, assigned_role = DEPT_MANAGER, assigned_user_id = null.
 *
 * The engine has always supported author-chosen users and roles — documents
 * (ApprovalChainCard) and letters both use it. Only the forms path never passed
 * any.
 *
 * WHAT THIS PROVES, over real HTTP, that the unit tests cannot
 *
 *   1. The prefill endpoint answers from the FORM TEMPLATE. The engine's own
 *      getSubmitPrefill needs an item id and a form instance has none until it
 *      is filed, which is exactly why the fill UI had no chain to show. This
 *      resolves the same recipe submitForApproval will use.
 *   2. A chosen chain survives the whole fill pipeline — PDF render, storage,
 *      document filing, and the post-commit submit — and lands in the database
 *      as the steps that were asked for, in order, with the right assignees.
 *      That pipeline is the reason a unit test is not enough: the fill
 *      transaction commits BEFORE the submit runs.
 *   3. Choosing nothing still produces the old behaviour exactly, so every
 *      already-filed form and every existing caller is unaffected.
 *   4. A named approver is TENANT-GLOBAL: assigning someone from another
 *      department works and grants them access, which is the fix from
 *      verify-approval-participant-access.ts holding for forms too.
 *   5. The guards reject a bad chain BEFORE anything is filed — no orphaned
 *      instance with no chain and no way to add one.
 *
 * Needs the dev backend on :7100 and seeded users (npm run db:seed:core).
 * Run: npx tsx test-scripts/verify-forms-approval-selection.ts
 */

import 'dotenv/config';
import axios from 'axios';
import FormData from 'form-data';
import { loginAs, verifyAdminEmail, verifyApproverEmail, type VerifyLogin } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL ?? 'http://127.0.0.1:7100/api/v1';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`, details ?? '');
  }
}

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string; user: any }> {
  return loginAs(email, 'verify-forms-approval-selection.ts');
}

const authFor = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** The error code a request failed with, or 'accepted' if it wrongly succeeded.
 *  Errors are wrapped as { error: { code, message } } by the global handler. */
async function failureCode(request: Promise<unknown>): Promise<string> {
  try {
    await request;
    return 'accepted';
  } catch (e: any) {
    return e.response?.data?.error?.code ?? `HTTP ${e.response?.status ?? 'none'}`;
  }
}

/** One text field on a blank A4 page — the smallest template that renders. */
const SCHEMA = [
  [{ name: 'subject', type: 'text', title: 'Subject', position: { x: 20, y: 20 }, width: 170, height: 10, required: true }],
];

/** Fill a form the way the browser does: multipart, with the chain as JSON. */
async function fillForm(
  token: string,
  templateId: string,
  departmentId: string,
  approvalSteps?: unknown[],
): Promise<any> {
  const form = new FormData();
  form.append('templateId', templateId);
  form.append('dataJson', JSON.stringify({ subject: `verifier ${Date.now()}` }));
  form.append('departmentId', departmentId);
  if (approvalSteps) form.append('approvalSteps', JSON.stringify(approvalSteps));
  const resp = await axios.post(`${API_BASE}/forms/instances`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });
  return resp.data;
}

/** Activate a form template the only way the product allows: through the
 *  approval engine. A single APPROVE step keeps this self-contained — the
 *  template chain is not what is under test here. The step goes to a SECOND
 *  person (`approver`): the engine refuses to assign it to the author
 *  (ERR-STEP-SELF-APPROVAL), which is why the demo administrator could once
 *  do both and the verification administrator cannot. */
async function activateTemplate(templateId: string, token: string, approver: VerifyLogin): Promise<void> {
  const auth = authFor(token);
  const chain = (
    await axios.post(
      `${API_BASE}/approvals/FORM_TEMPLATE/${templateId}/submit`,
      { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] },
      auth,
    )
  ).data;
  const step = chain.steps.find((s: any) => s.status === 'PENDING') ?? chain.steps[0];
  await axios.post(
    `${API_BASE}/approvals/chains/${chain.id}/steps/${step.id}/decision`,
    { decision: 'APPROVE', comment: 'verifier activation' },
    authFor(approver.token),
  );
}

async function main() {
  console.log('\n═══ Forms approver selection ═══\n');

  const { token: adminToken, user: adminUser } = await loginWithTenant(verifyAdminEmail());
  const admin = authFor(adminToken);
  const { token: opsToken, user: opsUser } = await loginWithTenant('ops.manager@edams.local');
  const approver = await loginAs(verifyApproverEmail(), 'verify-forms-approval-selection.ts');
  check('admin and ops.manager both authenticate', Boolean(adminToken && opsToken && opsUser?.id));

  const departments = (await axios.get(`${API_BASE}/departments`, admin)).data.data;
  const fin = departments.find((d: any) => d.code === 'FIN') ?? departments[0];
  const ops = departments.find((d: any) => d.code === 'OPS');
  check('FIN and OPS departments both exist', Boolean(fin && ops && fin.id !== ops?.id));

  // ── A chain template, so the prefill has a real recipe to answer with ──────
  const stamp = Date.now();
  const template = (
    await axios.post(
      `${API_BASE}/forms/templates`,
      {
        name: `Verifier chain form ${stamp}`,
        category: 'verification',
        schemaJson: SCHEMA,
        sectionsJson: [],
        instanceApproval: 'chain',
      },
      admin,
    )
  ).data.data;
  check('a chain-approval form template is created', Boolean(template?.id));

  // A template is itself activated through the approval engine — a direct flip
  // to 'active' is refused (ERR-FORM-APPROVAL-REQUIRED), and the final APPROVE
  // is what sets the status. So the verifier activates the way the product
  // does, rather than reaching past the rule it is testing around.
  await activateTemplate(template.id, adminToken, approver);
  const activated = (await axios.get(`${API_BASE}/forms/templates/${template.id}`, admin)).data.data;
  check('the template is active and fillable', activated?.status === 'active', activated?.status);

  // ── 1. Prefill ────────────────────────────────────────────────────────────
  const prefill = (
    await axios.get(`${API_BASE}/forms/templates/${template.id}/approval-prefill?departmentId=${fin.id}`, admin)
  ).data;
  check('prefill reports the template uses chain approval', prefill.instanceApproval === 'chain');
  check('prefill returns at least one step', Array.isArray(prefill.steps) && prefill.steps.length > 0);
  check(
    "prefill's last step is an APPROVE (what the engine will demand)",
    prefill.steps[prefill.steps.length - 1]?.stepType === 'APPROVE',
  );
  check(
    'prefill resolves role holders, so the author sees people rather than a bare role code',
    prefill.steps.every((s: any) => !s.assignedRole || Array.isArray(s.roleHolders)),
  );

  const noChainTemplate = (
    await axios.post(
      `${API_BASE}/forms/templates`,
      { name: `Verifier no-chain form ${stamp}`, category: 'verification', schemaJson: SCHEMA, sectionsJson: [], instanceApproval: 'none' },
      admin,
    )
  ).data.data;
  await activateTemplate(noChainTemplate.id, adminToken, approver);
  const noChainPrefill = (await axios.get(`${API_BASE}/forms/templates/${noChainTemplate.id}/approval-prefill`, admin)).data;
  check(
    "a 'none' template's prefill offers no chain at all (the picker stays hidden)",
    noChainPrefill.instanceApproval === 'none' && noChainPrefill.steps.length === 0,
  );

  // ── 2. A chosen chain reaches the database intact ─────────────────────────
  //
  // Two steps, one role and one named person, deliberately in an order the
  // engine's default could never produce — so a pass cannot be the old
  // hardcoded behaviour coincidentally looking right.
  const chosen = [
    { stepType: 'REVIEW', assignedRole: 'APPROVER' },
    { stepType: 'APPROVE', assignedUserId: opsUser.id },
  ];
  const filed = await fillForm(adminToken, template.id, fin.id, chosen);
  check('the form files with a chosen chain', Boolean(filed?.data?.id));
  check('no approval warning was returned (the submit succeeded)', !filed.approvalWarning, filed.approvalWarning);

  const chain = (await axios.get(`${API_BASE}/approvals/FORM_INSTANCE/${filed.data.id}/chain`, admin)).data;
  check('a chain exists for the filed instance', Boolean(chain?.id));
  check('the chain has exactly the two steps that were chosen', chain?.steps?.length === 2, chain?.steps?.length);
  check(
    'step 1 is the REVIEW assigned to the chosen ROLE',
    chain?.steps?.[0]?.stepType === 'REVIEW' && chain?.steps?.[0]?.assignedRole === 'APPROVER',
    chain?.steps?.[0],
  );
  check(
    'step 2 is the APPROVE assigned to the chosen NAMED person',
    chain?.steps?.[1]?.stepType === 'APPROVE' && chain?.steps?.[1]?.assignedUserId === opsUser.id,
    chain?.steps?.[1],
  );
  check(
    'the chain is NOT the old hardcoded single DEPT_MANAGER step',
    !(chain?.steps?.length === 1 && chain?.steps?.[0]?.assignedRole === 'DEPT_MANAGER'),
  );

  // ── 4. A named approver from another department can actually open it ──────
  //
  // ops.manager is seeded into OPS and this form is filed in FIN. The
  // assignment is allowed on purpose (a named assignee is tenant-global), and
  // grantChainParticipantAcl is what makes it usable rather than a dead item in
  // their queue. This is the forms half of verify-approval-participant-access.
  const documentId = filed.data.documentId;
  check('the filed instance has a backing document', Boolean(documentId));
  if (documentId) {
    const asOps = await axios
      .get(`${API_BASE}/documents/${documentId}`, authFor(opsToken))
      .then((r) => r.status)
      .catch((e) => e.response?.status ?? 0);
    check(
      'the cross-department named approver can open the document they were assigned',
      asOps === 200,
      asOps === 403 ? 'AUTHZ_ACL_NO_ENTRY — the participant ACL grant did not fire' : asOps,
    );
  }

  // ── 3. Choosing nothing preserves the previous behaviour exactly ──────────
  const defaulted = await fillForm(adminToken, template.id, fin.id);
  const defaultChain = (await axios.get(`${API_BASE}/approvals/FORM_INSTANCE/${defaulted.data.id}/chain`, admin)).data;
  check(
    'omitting approvalSteps still builds the template/default chain (no regression for existing callers)',
    Array.isArray(defaultChain?.steps) && defaultChain.steps.length > 0,
    defaultChain?.steps,
  );

  // ── 5. Bad chains are refused BEFORE anything is filed ────────────────────
  //
  // The fill transaction commits before the submit runs, so a chain rejected
  // late would leave an instance filed with no chain and no way to add one.
  const instancesBefore = (await axios.get(`${API_BASE}/forms/instances?templateId=${template.id}&take=100`, admin)).data.total;

  const reviewOnly = await failureCode(fillForm(adminToken, template.id, fin.id, [{ stepType: 'REVIEW', assignedRole: 'APPROVER' }]));
  check('a chain not ending in an APPROVE is refused', reviewOnly === 'ERR-CHAIN-FINAL-STEP', reviewOnly);

  const bothAssigned = await failureCode(
    fillForm(adminToken, template.id, fin.id, [
      { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', assignedUserId: opsUser.id },
    ]),
  );
  check('a step carrying both a role and a named person is refused', bothAssigned === 'ERR-VALIDATION', bothAssigned);

  const neitherAssigned = await failureCode(
    fillForm(adminToken, template.id, fin.id, [{ stepType: 'APPROVE' }]),
  );
  check('a step carrying neither a role nor a named person is refused', neitherAssigned === 'ERR-VALIDATION', neitherAssigned);

  const onNoChain = await failureCode(
    fillForm(adminToken, noChainTemplate.id, fin.id, [{ stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER' }]),
  );
  check(
    "approvers chosen for a 'none' template are refused rather than silently dropped",
    onNoChain === 'ERR-FORM-APPROVAL-NOT-USED',
    onNoChain,
  );

  const instancesAfter = (await axios.get(`${API_BASE}/forms/instances?templateId=${template.id}&take=100`, admin)).data.total;
  check(
    'no instance was filed by any of the rejected submissions',
    instancesAfter === instancesBefore,
    { before: instancesBefore, after: instancesAfter },
  );

  // ── Authorization ─────────────────────────────────────────────────────────
  const anon = await failureCode(axios.get(`${API_BASE}/forms/templates/${template.id}/approval-prefill`));
  check('the prefill endpoint requires authentication', anon === 'ERR-AUTH-REQUIRED', anon);

  // The prefill reuses getFormTemplate, which is tenant-scoped and 404s
  // otherwise — a caller who cannot see a template must not learn its approval
  // routing either.
  const missing = await failureCode(
    axios.get(`${API_BASE}/forms/templates/00000000-0000-0000-0000-000000000000/approval-prefill`, admin),
  );
  check('the prefill endpoint 404s on a template that does not exist', missing === 'ERR-NOT-FOUND', missing);

  console.log(`\n  ${passed} passed, ${failed} failed  (admin: ${adminUser?.email})\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err.response?.status, err.response?.data ?? err.message);
  process.exit(1);
});
