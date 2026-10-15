/**
 * Approved forms get a gap-free reference number.
 *
 * Reported as "the forms module needs to have department etc as the rest,
 * otherwise how can it have a ref number".
 *
 * The department and org unit turned out to be derivable already (a form's
 * backing document carries departmentId, and departments.org_unit_id is NOT
 * NULL), so the only genuinely missing pieces were a counter and somewhere to
 * keep the allocated number.
 *
 * WHAT THIS PROVES
 *
 *   1. Format and sourcing: REF/<UNIT>/<DEPT>/FORM/<YEAR>/<00001>, with UNIT and
 *      DEPT resolved from where the form was actually filed rather than
 *      hardcoded.
 *   2. Allocated at FINAL APPROVAL, not at submit. A number handed out at
 *      submit is consumed by every declined or abandoned form, so the series
 *      develops gaps in normal use and a real gap stops being noticeable.
 *   3. Gap-free and consecutive under sequential approvals.
 *   4. Idempotent: re-approving cannot mint a second number for one form. The
 *      first is printed on a filed PDF.
 *   5. Separate from the letters series — a form must never consume a number in
 *      the correspondence register.
 *
 * Needs the dev backend on :7100 and seeded users (npm run db:seed:core).
 * Run: npx tsx test-scripts/verify-form-reference-numbers.ts
 */

import 'dotenv/config';
import axios from 'axios';
import FormData from 'form-data';
import { loginAs, verifyAdminEmail, verifyApproverEmail } from './lib/dev-admin.js';

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
  return loginAs(email, 'verify-form-reference-numbers.ts');
}

const authFor = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

const SCHEMA = [
  [{ name: 'subject', type: 'text', title: 'Subject', position: { x: 20, y: 20 }, width: 170, height: 10, required: true }],
];

async function main() {
  console.log('\n═══ Form reference numbers ═══\n');

  const { token, user } = await loginWithTenant(verifyAdminEmail());
  const auth = authFor(token);
  check('admin authenticates', Boolean(token && user?.id));
  // The product refuses to let a step go to the item's author (ERR-STEP-SELF-APPROVAL), so a second person decides every step.
  const approver = await loginAs(verifyApproverEmail(), 'verify-form-reference-numbers.ts');
  const apAuth = authFor(approver.token);

  const departments = (await axios.get(`${API_BASE}/departments`, auth)).data.data;
  const department = departments.find((d: any) => d.code === 'FIN') ?? departments[0];
  const orgUnits = (await axios.get(`${API_BASE}/org-units`, auth)).data.data;

  // ── A chain-approval template ─────────────────────────────────────────────
  const stamp = Date.now();
  const template = (
    await axios.post(
      `${API_BASE}/forms/templates`,
      { name: `Ref-number form ${stamp}`, category: 'verification', schemaJson: SCHEMA, sectionsJson: [], instanceApproval: 'chain' },
      auth,
    )
  ).data.data;

  const tplChain = (
    await axios.post(`${API_BASE}/approvals/FORM_TEMPLATE/${template.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] }, auth)
  ).data;
  const tplStep = tplChain.steps.find((s: any) => s.status === 'PENDING') ?? tplChain.steps[0];
  await axios.post(`${API_BASE}/approvals/chains/${tplChain.id}/steps/${tplStep.id}/decision`, { decision: 'APPROVE', comment: 'activate' }, apAuth);
  check('the template is active', (await axios.get(`${API_BASE}/forms/templates/${template.id}`, auth)).data.data.status === 'active');

  /** File a form, approve it, and return the instance as the API reports it. */
  async function fileAndApprove(subject: string): Promise<any> {
    const form = new FormData();
    form.append('templateId', template.id);
    form.append('dataJson', JSON.stringify({ subject }));
    form.append('departmentId', department.id);
    form.append('approvalSteps', JSON.stringify([{ stepType: 'APPROVE', assignedUserId: approver.userId }]));
    const filed = (
      await axios.post(`${API_BASE}/forms/instances`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      })
    ).data;

    const beforeApproval = (await axios.get(`${API_BASE}/forms/instances?templateId=${template.id}&take=100`, auth)).data.data.find(
      (i: any) => i.id === filed.data.id,
    );

    const chain = (await axios.get(`${API_BASE}/approvals/FORM_INSTANCE/${filed.data.id}/chain`, auth)).data;
    const step = (chain.steps ?? []).find((s: any) => s.status === 'PENDING');
    await axios.post(`${API_BASE}/approvals/chains/${chain.id}/steps/${step.id}/decision`, { decision: 'APPROVE', comment: 'approve' }, apAuth);

    const afterApproval = (await axios.get(`${API_BASE}/forms/instances?templateId=${template.id}&take=100`, auth)).data.data.find(
      (i: any) => i.id === filed.data.id,
    );
    return { id: filed.data.id, chainId: chain.id, stepId: step.id, beforeApproval, afterApproval };
  }

  // ── 2. Not at submit ──────────────────────────────────────────────────────
  const first = await fileAndApprove(`Ref form A ${stamp}`);
  check(
    'a freshly filed form has NO reference number — numbering happens at approval, not submit',
    !first.beforeApproval?.referenceNumber,
    first.beforeApproval?.referenceNumber,
  );

  // ── 1. Format and sourcing ────────────────────────────────────────────────
  const ref = first.afterApproval?.referenceNumber as string | undefined;
  check('an approved form has a reference number', Boolean(ref), first.afterApproval?.status);

  const expectedUnit = orgUnits.find((u: any) => u.id === department.orgUnitId)?.code;
  const pattern = new RegExp(`^REF/[A-Z0-9-]+/${department.code}/FORM/${new Date().getFullYear()}/\\d{5}$`);
  check(`it matches REF/<UNIT>/${department.code}/FORM/<YEAR>/<00001>`, Boolean(ref && pattern.test(ref)), ref);
  if (expectedUnit) {
    check(
      'the UNIT segment is the org unit the form was really filed under, not a constant',
      Boolean(ref?.startsWith(`REF/${expectedUnit}/`)),
      { ref, expectedUnit },
    );
  }

  // ── 3. Consecutive ────────────────────────────────────────────────────────
  const second = await fileAndApprove(`Ref form B ${stamp}`);
  const ref2 = second.afterApproval?.referenceNumber as string | undefined;
  check('a second approved form is also numbered', Boolean(ref2), ref2);

  const seqOf = (r?: string) => (r ? Number(r.split('/').pop()) : NaN);
  check(
    'the two numbers are consecutive — the counter is gap-free',
    seqOf(ref2) === seqOf(ref) + 1,
    { first: ref, second: ref2 },
  );

  // ── 4. Idempotent ─────────────────────────────────────────────────────────
  //
  // Deciding the same, already-decided step must not mint a second number. The
  // first is printed on a filed PDF.
  const reDecide = await axios
    .post(`${API_BASE}/approvals/chains/${first.chainId}/steps/${first.stepId}/decision`, { decision: 'APPROVE', comment: 'again' }, apAuth)
    .then(() => 'accepted')
    .catch((e) => e.response?.data?.error?.code ?? e.response?.status);
  check('re-deciding a completed step is refused', reDecide !== 'accepted', reDecide);

  const afterRedecide = (await axios.get(`${API_BASE}/forms/instances?templateId=${template.id}&take=100`, auth)).data.data.find(
    (i: any) => i.id === first.id,
  );
  check('its reference number is unchanged', afterRedecide?.referenceNumber === ref, {
    was: ref,
    now: afterRedecide?.referenceNumber,
  });

  // ── 5. A separate series from letters ─────────────────────────────────────
  //
  // Sharing letter_sequences would let a form consume a number in the
  // correspondence register — very hard to unpick once numbers are printed.
  const letters = (await axios.get(`${API_BASE}/letters?take=50`, auth)).data.data ?? [];
  const letterRefs = new Set(letters.map((l: any) => l.referenceNumber).filter(Boolean));
  check('no letter carries this form\'s reference number', !letterRefs.has(ref), ref);
  check(
    'the form series uses the FORM type segment, so it cannot collide with a letter type',
    Boolean(ref?.includes('/FORM/')),
    ref,
  );

  // ── A 'none' template never gets numbered ─────────────────────────────────
  const noChain = (
    await axios.post(
      `${API_BASE}/forms/templates`,
      { name: `Ref-number none ${stamp}`, category: 'verification', schemaJson: SCHEMA, sectionsJson: [], instanceApproval: 'none' },
      auth,
    )
  ).data.data;
  const ncChain = (
    await axios.post(`${API_BASE}/approvals/FORM_TEMPLATE/${noChain.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] }, auth)
  ).data;
  const ncStep = ncChain.steps.find((s: any) => s.status === 'PENDING') ?? ncChain.steps[0];
  await axios.post(`${API_BASE}/approvals/chains/${ncChain.id}/steps/${ncStep.id}/decision`, { decision: 'APPROVE', comment: 'activate' }, apAuth);

  const ncForm = new FormData();
  ncForm.append('templateId', noChain.id);
  ncForm.append('dataJson', JSON.stringify({ subject: 'never approved' }));
  ncForm.append('departmentId', department.id);
  const ncFiled = (
    await axios.post(`${API_BASE}/forms/instances`, ncForm, { headers: { ...ncForm.getHeaders(), Authorization: `Bearer ${token}` } })
  ).data;
  const ncInstance = (await axios.get(`${API_BASE}/forms/instances?templateId=${noChain.id}&take=10`, auth)).data.data.find(
    (i: any) => i.id === ncFiled.data.id,
  );
  check(
    'a form from a no-approval template is never numbered — nothing cleared it',
    !ncInstance?.referenceNumber,
    ncInstance?.referenceNumber,
  );

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err.response?.status, err.response?.data ?? err.message);
  process.exit(1);
});
