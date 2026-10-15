/**
 * Cross-department approval assignees can actually OPEN their work.
 *
 * THE BUG THIS PINS
 *
 * Assigning an approval step to a NAMED user outside the item's own department
 * is deliberately allowed: a named assignee is globally scoped by design, and
 * the picker only shows a cross-department advisory rather than blocking the
 * choice (listLetterAssignableUsers / listAssignableUsers are explicitly not
 * department-filtered).
 *
 * But nothing granted that person access to the document.
 * grantDefaultDocumentAcl (documents.service.ts) grants document:read to the
 * owner and to a SNAPSHOT of the document's own department members, and
 * approvals.service.ts wrote no ACL entries at all. So the assignment
 * succeeded, the assignee saw the item in My Work — and their first click
 * failed with AUTHZ_ACL_NO_ENTRY, "No access control entry for this
 * resource". They could never reach the Workflow tab to act on it.
 *
 * getChain() does let a chain participant bypass its own ACL and department
 * checks, which is why this looked fine in code review — but the document page
 * loads GET /documents/:id FIRST, and that has no such bypass, so the document
 * fetch is what actually died.
 *
 * letters.service.ts already did the right thing for its signatory (the
 * AclEntry grants in enterPendingSignatureInTx). This proves the engine's
 * equivalent, over real HTTP, as two different users.
 *
 * Needs the dev backend on :7100 and seeded users (npm run db:seed:core).
 * Run: npx tsx test-scripts/verify-approval-participant-access.ts
 */

import 'dotenv/config';
import axios from 'axios';
import { loginAs, verifyAdminEmail } from './lib/dev-admin.js';

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
  return loginAs(email, 'verify-approval-participant-access.ts');
}

const authFor = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function main() {
  console.log('\n═══ Cross-department approval assignee access ═══\n');

  const { token: adminToken } = await loginWithTenant(verifyAdminEmail());
  const admin = authFor(adminToken);

  const { token: opsToken, user: opsUser } = await loginWithTenant('ops.manager@edams.local');
  const ops = authFor(opsToken);
  check('both users authenticate', Boolean(adminToken && opsToken && opsUser?.id));

  // Pick a department the assignee is NOT a member of — that is the whole
  // point. ops.manager is seeded into OPS, so file the document in FIN.
  const departments = (await axios.get(`${API_BASE}/departments`, admin)).data.data;
  const fin = departments.find((d: any) => d.code === 'FIN');
  const opsDept = departments.find((d: any) => d.code === 'OPS');
  check('FIN and OPS departments both exist (so the assignee really is outside)', Boolean(fin && opsDept));

  const docTypes = (await axios.get(`${API_BASE}/document-types`, admin)).data.data;
  const docType = docTypes.find((t: any) => t.code === 'POLICY') ?? docTypes[0];
  check('a document type is available', Boolean(docType));

  const orgUnits = (await axios.get(`${API_BASE}/org-units`, admin)).data.data;
  const hq = orgUnits.find((u: any) => u.code === 'HQ') ?? orgUnits[0];

  // ── Upload a document into FIN as admin ────────────────────────────────
  // Every field in documentValidation.ts's mandatoryMetadataFields must be
  // present or the upload is a 422 before it ever reaches the ACL logic.
  const form = new FormData();
  const body = `cross-department assignee access check ${Date.now()}`;
  form.append('file', new Blob([body], { type: 'text/plain' }), 'acl-check.txt');
  form.append('title', `ACL check ${Date.now()}`);
  form.append('departmentId', fin.id);
  form.append('departmentCode', fin.code);
  form.append('documentTypeId', docType.id);
  form.append('documentTypeCode', docType.code);
  form.append('organisationUnit', hq.code);
  form.append('securityClassification', 'INTERNAL');
  form.append('retentionClass', 'RET-CORR-5Y');
  form.append('source', 'MANUAL_UPLOAD');

  // POST /documents returns the created document directly, not { data }.
  const uploaded = (await axios.post(`${API_BASE}/documents`, form, admin)).data;
  check('document uploaded into FIN', Boolean(uploaded?.id), uploaded?.id);

  // ── The assignee must NOT be able to read it yet ───────────────────────
  const beforeAssign = await axios
    .get(`${API_BASE}/documents/${uploaded.id}`, ops)
    .then(() => ({ status: 200, code: null as string | null }))
    .catch((e) => ({ status: e.response?.status ?? 0, code: e.response?.data?.error?.code ?? null }));
  check(
    'before assignment the out-of-department user is correctly denied',
    beforeAssign.status === 403,
    `${beforeAssign.status} ${beforeAssign.code}`,
  );

  // ── Assign the approval step to them by name ───────────────────────────
  const submitted = await axios
    .post(
      `${API_BASE}/approvals/DOCUMENT/${uploaded.id}/submit`,
      { steps: [{ stepType: 'APPROVE', assignedUserId: opsUser.id }] },
      admin,
    )
    .then((r) => ({ ok: true as const, data: r.data }))
    .catch((e) => ({ ok: false as const, status: e.response?.status, body: e.response?.data }));
  check(
    'assigning a step to a user outside the document\'s department is allowed',
    submitted.ok,
    submitted.ok ? '' : JSON.stringify(submitted.body),
  );
  if (!submitted.ok) {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  // ── …and now they can open it. This is the fix. ────────────────────────
  const afterAssign = await axios
    .get(`${API_BASE}/documents/${uploaded.id}`, ops)
    .then((r) => ({ status: 200, code: null as string | null, data: r.data.data }))
    .catch((e) => ({
      status: e.response?.status ?? 0,
      code: e.response?.data?.error?.code ?? null,
      data: null,
    }));
  check(
    'the named assignee can now OPEN the document (was AUTHZ_ACL_NO_ENTRY)',
    afterAssign.status === 200,
    `${afterAssign.status} ${afterAssign.code}`,
  );

  // The Workflow tab itself, which is what they were trying to reach.
  const chain = await axios
    .get(`${API_BASE}/approvals/DOCUMENT/${uploaded.id}/chain`, ops)
    .then((r) => ({ status: 200, data: r.data }))
    .catch((e) => ({ status: e.response?.status ?? 0, data: e.response?.data }));
  check('the named assignee can load the approval chain', chain.status === 200, chain.status);

  // And it appears as work waiting on them.
  const myWork = (await axios.get(`${API_BASE}/approvals/my/work`, ops)).data;
  const inQueue = (myWork.approvals ?? []).some(
    (a: any) => a.chainId || a.id, // any engine step present
  );
  check('the assignment shows in their My Work queue', inQueue, JSON.stringify(myWork.approvals?.length));

  // ── Read-only: the grant must not have handed over write access ────────
  const archiveAttempt = await axios
    .post(`${API_BASE}/documents/${uploaded.id}/archive`, {}, ops)
    .then(() => ({ status: 200 }))
    .catch((e) => ({ status: e.response?.status ?? 0 }));
  check(
    'the grant is READ-only — it does not confer archive',
    archiveAttempt.status >= 400,
    `status ${archiveAttempt.status}`,
  );

  // ── An unrelated out-of-department user is still denied ───────────────
  const { token: otherToken, user: otherUser } = await loginWithTenant('hr.manager@edams.local');
  const other = authFor(otherToken);
  const unrelated = await axios
    .get(`${API_BASE}/documents/${uploaded.id}`, other)
    .then(() => ({ status: 200 }))
    .catch((e) => ({ status: e.response?.status ?? 0, code: e.response?.data?.error?.code }));
  check(
    'an unrelated out-of-department user is STILL denied (the grant is per-assignee)',
    unrelated.status === 403,
    `${otherUser?.email}: ${unrelated.status}`,
  );

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n  verifier crashed:', e.response?.data ?? e.message);
  process.exit(1);
});
