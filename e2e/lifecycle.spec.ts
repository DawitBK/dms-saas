import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { apiLogin, apiGet, bearer, type ApiSession } from './fixtures/api';
import { execSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

/**
 * Whole-lifecycle flows over the real HTTP API, signed in as the QA personas (tenant qa-lab, `npm run db:seed:qa`):
 *
 *   1. upload -> submit -> review -> approve -> signature request -> signed -> finalised
 *   2. the signer DECLINES -> the request closes and the document is not left stuck
 *   3. a letter: create -> submit -> approve -> initiate signing -> signed -> dispatched -> acknowledged
 *   4. a letter whose signer declines recovers by itself (the eager hook) instead of waiting for someone to open it
 *
 * Every test provisions its own rows with a timestamped title, so the suite can be run any number of times.
 */

const API = 'http://localhost:7100/api/v1';
const SIGNATURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const email = (k: string) => `qa.${k}@qa.local`;

let sessions: Record<string, ApiSession> = {};
async function as(key: string) { return (sessions[key] ??= await apiLogin(email(key))); }

async function post<T = any>(s: ApiSession, path: string, data?: unknown, expectOk = true): Promise<{ status: number; body: T }> {
  const res = await s.ctx.post(`${API}${path}`, { data: data ?? {}, headers: bearer(s) });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (expectOk) expect(res.status(), `POST ${path} -> ${res.status()} ${text.slice(0, 400)}`).toBeLessThan(400);
  return { status: res.status(), body };
}

async function patch<T = any>(s: ApiSession, path: string, data?: unknown, expectOk = true): Promise<{ status: number; body: T }> {
  const res = await s.ctx.patch(`${API}${path}`, { data: data ?? {}, headers: bearer(s) });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (expectOk) expect(res.status(), `PATCH ${path} -> ${res.status()} ${text.slice(0, 400)}`).toBeLessThan(400);
  return { status: res.status(), body };
}

async function pdfBytes(title: string) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 760, size: 16, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
}

async function hqFinance(s: ApiSession) {
  const orgUnits = (await apiGet(s, '/org-units')).data as { id: string; code: string; name: string }[];
  const departments = (await apiGet(s, '/departments')).data as { id: string; code: string; orgUnitId: string }[];
  const orgUnit = orgUnits.find((o) => o.code === 'HQ')!;
  return { orgUnit, department: departments.find((d) => d.code === 'FIN' && d.orgUnitId === orgUnit.id)! };
}

async function uploadDoc(s: ApiSession, typeCode: string, title: string, classification = 'INTERNAL') {
  const { orgUnit, department } = await hqFinance(s);
  const res = await s.ctx.post(`${API}/documents`, {
    headers: bearer(s),
    multipart: {
      title, departmentId: department.id, documentTypeCode: typeCode, organisationUnit: orgUnit.name, securityClassification: classification,
      retentionClass: 'RET-CORP-5Y', source: 'MANUAL_UPLOAD', file: { name: 'lifecycle.pdf', mimeType: 'application/pdf', buffer: await pdfBytes(title) },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return (body.data ?? body) as { id: string };
}

/** Walk a chain to its end: the records officer clears the review step, the finance head approves. */
async function approveChain(docId: string, authorKey: string) {
  const author = await as(authorKey);
  const submitted = (await post(author, `/approvals/DOCUMENT/${docId}/submit`, {})).body as any;
  const chain = submitted.data ?? submitted;
  const decide = async (who: string, stepType: string) => {
    const s = await as(who);
    const current = (await apiGet(s, `/approvals/DOCUMENT/${docId}/chain`)) as any;
    const c = current.data ?? current;
    const step = c.steps.find((x: any) => x.status === 'PENDING' && x.stepType === stepType);
    expect(step, `no pending ${stepType} step for ${who}`).toBeTruthy();
    await post(s, `/approvals/chains/${c.id ?? chain.id}/steps/${step.id}/decision`, { decision: 'APPROVE', comment: `${stepType} ok` });
  };
  await decide('records', 'REVIEW');
  await decide('fin.head', 'APPROVE');
}

async function signingRequestFor(docId: string, ownerKey: string, signerKey: string) {
  const owner = await as(ownerKey);
  const signer = await as(signerKey);
  const created = (await post(owner, `/documents/${docId}/signing`, {
    source: 'freeform', orderingMode: 'serial',
    recipients: [{ dmsUserId: signer.user.id, orderIndex: 0 }],
    fields: [{ recipientIndex: 0, pageNumber: 1, x: 80, y: 80, width: 150, height: 50, fieldType: 'signature' }],
  })).body as any;
  const request = created.data ?? created;
  await post(owner, `/signing/${request.id}/send`, {});
  const full = ((await apiGet(owner, `/signing/${request.id}`)) as any).data as any;
  return { request: full, owner, signer, recipient: full.recipients[0], field: (full.fields ?? [])[0] };
}

test.describe.configure({ mode: 'serial' });

test('1. upload -> review -> approve -> signature request -> signed -> finalised', async () => {
  const title = `Lifecycle contract ${Date.now()}`;
  const doc = await uploadDoc(await as('fin.staff1'), 'QA-APSG', title);
  await approveChain(doc.id, 'fin.staff1');

  const finance = await as('fin.head');
  const afterApproval = (await apiGet(finance, `/documents/${doc.id}`)) as any;
  const status = (afterApproval.data ?? afterApproval).status;
  expect(['ACTIVE', 'PENDING_SIGNATURE'], `status after the last approval: ${status}`).toContain(status);

  const { request, signer, recipient, field } = await signingRequestFor(doc.id, 'fin.staff1', 'fin.approver');
  expect(request.status).toMatch(/sent|partially_signed/);
  expect(field, 'the request has no signature field').toBeTruthy();

  await post(signer, `/signing/${request.id}/recipients/${recipient.id}/sign`, { fieldValues: [{ fieldId: field.id, value: SIGNATURE_PNG }] });
  const done = ((await apiGet(signer, `/signing/${request.id}`)) as any).data;
  expect(done.status, `request status ${done.status}`).toBe('completed');
  const finalDoc = (await apiGet(finance, `/documents/${doc.id}`)) as any;
  const finalStatus = (finalDoc.data ?? finalDoc).status;
  expect(['SIGNED', 'ARCHIVED', 'ACTIVE'], `document status after signing: ${finalStatus}`).toContain(finalStatus);
  expect(finalStatus).not.toBe('PENDING_SIGNATURE');
});

test('2. a declined signature closes the request and does not leave the document stuck', async () => {
  const title = `Lifecycle decline ${Date.now()}`;
  const doc = await uploadDoc(await as('fin.staff1'), 'QA-SIGN', title);
  await post(await as('fin.staff1'), `/documents/${doc.id}/publish`, {}); // no approval needed for this type: publish the draft, then ask for signatures
  const { request, signer, recipient } = await signingRequestFor(doc.id, 'fin.staff1', 'fin.approver');
  await post(signer, `/signing/${request.id}/recipients/${recipient.id}/decline`, { reason: 'I disagree with clause 4' });
  const after = ((await apiGet(signer, `/signing/${request.id}`)) as any).data;
  expect(['declined', 'voided', 'cancelled'], `request status ${after.status}`).toContain(after.status);
  const d = (await apiGet(await as('fin.staff1'), `/documents/${doc.id}`)) as any;
  expect((d.data ?? d).status, 'the document is still waiting for a signature that can no longer come').not.toBe('PENDING_SIGNATURE');
});

async function approvedLetter(subject: string) {
  const author = await as('fin.staff1');
  const { orgUnit, department } = await hqFinance(author);
  const created = (await post(author, '/letters', {
    orgUnitId: orgUnit.id, departmentId: department.id, subject, bodyHtml: `<p>${subject}</p>`, letterType: 'OUT',
    correspondent: 'Lifecycle Correspondent', correspondentEmail: 'lifecycle@example.com',
  })).body as any;
  const letter = created.data ?? created;
  const head = await as('fin.head');
  const submitted = (await post(author, `/letters/${letter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: head.user.id }] })).body as any;
  const s = submitted.data ?? submitted;
  const step = (s.approvalSteps ?? []).find((x: any) => x.status === 'PENDING') ?? s.approvalSteps[0];
  await post(head, `/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE', comment: 'approved' });
  return { id: letter.id as string, author, head };
}

test('3. letter: approve -> initiate signing -> signed -> dispatched -> acknowledged', async () => {
  const { id, author } = await approvedLetter(`Lifecycle letter ${Date.now()}`);
  const signerSession = await as('fin.approver');
  await post(author, `/letters/${id}/initiate-signing`, { signatory: { assignedUserId: signerSession.user.id } });
  const pendingLetter = (await apiGet(author, `/letters/${id}`)) as any;
  expect((pendingLetter.data ?? pendingLetter).status).toBe('PENDING_SIGNATURE');

  // the signature task belongs to the letter's document
  const documentId = (pendingLetter.data ?? pendingLetter).documentId ?? (pendingLetter.data ?? pendingLetter).document?.id;
  expect(documentId, 'the letter has no backing document after initiating signing').toBeTruthy();
  const requests = ((await apiGet(signerSession, `/documents/${documentId}/signing`)) as any).data as any[];
  const request = requests[0];
  expect(request, 'no signature request was created for the letter').toBeTruthy();
  const full = ((await apiGet(signerSession, `/signing/${request.id}`)) as any).data;
  const recipient = full.recipients.find((r: any) => r.dmsUserId === signerSession.user.id) ?? full.recipients[0];
  const fieldId = (full.fields ?? [])[0]?.id;
  await post(signerSession, `/signing/${request.id}/recipients/${recipient.id}/sign`, { fieldValues: fieldId ? [{ fieldId, value: SIGNATURE_PNG }] : [] });

  const signed = (await apiGet(author, `/letters/${id}`)) as any;
  const letter = signed.data ?? signed;
  expect(letter.status, `letter status after signing: ${letter.status}`).toMatch(/SIGNED|APPROVED|ISSUED|SENT|COMPLETED|ARCHIVED/);
  expect(letter.referenceNumber, 'the signed letter has no reference number').toBeTruthy();

  const registry = await as('records'); // dispatching is the records officer's job (letter:dispatch)
  const dispatch = (await post(registry, `/letters/${id}/dispatches`, { channel: 'EMAIL', recipientName: 'Lifecycle Correspondent', recipientAddress: 'lifecycle@example.com' }, false));
  expect(dispatch.status, `dispatch -> ${dispatch.status} ${JSON.stringify(dispatch.body).slice(0, 300)}`).toBeLessThan(400);
  const dispatchId = (dispatch.body.data ?? dispatch.body).id;
  if (dispatchId) await post(registry, `/letters/${id}/dispatches/${dispatchId}/acknowledge`, { note: 'received' });
});

test('4. letter whose signer declines recovers on its own', async () => {
  const { id, author } = await approvedLetter(`Lifecycle declined letter ${Date.now()}`);
  const signerSession = await as('fin.approver');
  await post(author, `/letters/${id}/initiate-signing`, { signatory: { assignedUserId: signerSession.user.id } });
  const pending = ((await apiGet(author, `/letters/${id}`)) as any);
  const documentId = (pending.data ?? pending).documentId ?? (pending.data ?? pending).document?.id;
  const request = (((await apiGet(signerSession, `/documents/${documentId}/signing`)) as any).data as any[])[0];
  const full = ((await apiGet(signerSession, `/signing/${request.id}`)) as any).data;
  await post(signerSession, `/signing/${request.id}/recipients/${full.recipients[0].id}/decline`, { reason: 'not signing this' });
  // no read of the letter happened in between: the eager hook must already have moved it
  const after = (await apiGet(author, `/letters/${id}`)) as any;
  const status = (after.data ?? after).status;
  expect(status, `the letter is still ${status} after its signer declined`).not.toBe('PENDING_SIGNATURE');
});

async function expireNow(requestId: string) {
  const db = new pg.Client({ host: 'localhost', port: 5432, user: 'postgres', password: process.env.PGPASSWORD ?? 'change-me-dev-password', database: 'DMS' });
  await db.connect();
  await db.query("SELECT set_config('app.current_tenant', 'qa-lab', false)");
  await db.query(`UPDATE signature_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`, [requestId]);
  await db.end();
  const out = execSync('npx tsx test-scripts/run-esign-expiry-sweep.ts', { cwd: path.join(__dirname, '..', 'backend'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' } });
  expect(out).toMatch(/EXPIRED \d+/);
}

test('5. an expired signing request closes, and the letter behind it recovers', async () => {
  const { id, author } = await approvedLetter(`Lifecycle expiry letter ${Date.now()}`);
  const signerSession = await as('fin.approver');
  await post(author, `/letters/${id}/initiate-signing`, { signatory: { assignedUserId: signerSession.user.id } });
  const letterNow = (await apiGet(author, `/letters/${id}`)) as any;
  const documentId = (letterNow.data ?? letterNow).documentId ?? (letterNow.data ?? letterNow).document?.id;
  const request = (((await apiGet(signerSession, `/documents/${documentId}/signing`)) as any).data as any[])[0];
  await expireNow(request.id);
  const after = ((await apiGet(signerSession, `/signing/${request.id}`)) as any).data;
  expect(after.status).toBe('expired');
  const letter = (await apiGet(author, `/letters/${id}`)) as any;
  expect((letter.data ?? letter).status, 'the letter is still waiting for a signature that expired').not.toBe('PENDING_SIGNATURE');
});

test('6. a letter step can be delegated by the person it waits on, and only by them', async () => {
  const author = await as('fin.staff1');
  const head = await as('fin.approver'); // an approver who is NOT a department head: the case delegation exists for
  const colleague = await as('fin.head');
  const outsider = await as('hr.staff');
  const { orgUnit, department } = await hqFinance(author);
  const created = (await post(author, '/letters', {
    orgUnitId: orgUnit.id, departmentId: department.id, subject: `Delegation letter ${Date.now()}`, bodyHtml: '<p>delegate me</p>', letterType: 'OUT', correspondent: 'Someone',
  })).body as any;
  const letter = created.data ?? created;
  const submitted = (await post(author, `/letters/${letter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: head.user.id }] })).body as any;
  const step = ((submitted.data ?? submitted).approvalSteps as any[]).find((x) => x.status === 'PENDING');

  const as403 = await post(outsider, `/letters/${letter.id}/steps/${step.id}/reassign`, { assignedUserId: colleague.user.id, reason: 'not mine to move' }, false);
  expect(as403.status, 'someone the step is not waiting on must not be able to move it').toBe(403);
  const noReason = await post(head, `/letters/${letter.id}/steps/${step.id}/reassign`, { assignedUserId: colleague.user.id }, false);
  expect(noReason.status, 'delegation needs a reason').toBe(422);
  const toDrafter = await post(head, `/letters/${letter.id}/steps/${step.id}/reassign`, { assignedUserId: author.user.id, reason: 'give it back to the author' }, false);
  expect(toDrafter.status, 'a step cannot be delegated to the drafter').toBe(422);

  const ok = await post(head, `/letters/${letter.id}/steps/${step.id}/reassign`, { assignedUserId: colleague.user.id, reason: 'On leave this week' }, false);
  expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBeLessThan(400);
  // the colleague can now decide it; the original approver no longer can
  const now = ((await apiGet(colleague, `/letters/${letter.id}`)) as any);
  const pending = (((now.data ?? now).approvalSteps as any[]).find((x) => x.status === 'PENDING'));
  expect(pending.assignedUserId).toBe(colleague.user.id);
  const stale = await post(head, `/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE' }, false);
  expect(stale.status, 'the delegator can no longer decide the step').toBeGreaterThanOrEqual(400);
  await post(colleague, `/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE', comment: 'covering' });
});

test('7. a drafter can recall a letter out of review, edit it and submit it again; nobody else can', async () => {
  const author = await as('fin.staff1');
  const approver = await as('fin.approver');
  const second = await as('fin.head');
  const outsider = await as('fin.staff2');
  const { orgUnit, department } = await hqFinance(author);
  const created = (await post(author, '/letters', {
    orgUnitId: orgUnit.id, departmentId: department.id, subject: `Recall letter ${Date.now()}`, bodyHtml: '<p>first draft</p>', letterType: 'OUT', correspondent: 'Someone',
  })).body as any;
  const letter = created.data ?? created;

  const early = await post(author, `/letters/${letter.id}/recall`, {}, false);
  expect(early.status, 'a draft is not in review, so there is nothing to recall').toBe(409);

  const submitted = (await post(author, `/letters/${letter.id}/submit`, {
    steps: [{ stepType: 'REVIEW', assignedUserId: approver.user.id }, { stepType: 'APPROVE', assignedUserId: second.user.id }],
  })).body as any;
  const steps = (submitted.data ?? submitted).approvalSteps as any[];

  const notOwner = await post(outsider, `/letters/${letter.id}/recall`, {}, false);
  expect(notOwner.status, 'only the drafter may recall').toBe(403);

  // nobody has decided yet: no reason needed, and the letter goes back to the drafter as RETURNED
  const recalled = (await post(author, `/letters/${letter.id}/recall`, {})).body as any;
  expect((recalled.data ?? recalled).status).toBe('RETURNED');
  const stale = await post(approver, `/letters/${letter.id}/steps/${steps[0].id}/decision`, { decision: 'APPROVE' }, false);
  expect(stale.status, 'the recalled step can no longer be decided').toBeGreaterThanOrEqual(400);

  // edit, submit again: a fresh chain; this time the first reviewer decides before the drafter changes their mind
  const edited = await patch(author, `/letters/${letter.id}`, { bodyHtml: '<p>second draft</p>' }, false);
  expect(edited.status, JSON.stringify(edited.body).slice(0, 200)).toBeLessThan(400);
  const again = (await post(author, `/letters/${letter.id}/submit`, {
    steps: [{ stepType: 'REVIEW', assignedUserId: approver.user.id }, { stepType: 'APPROVE', assignedUserId: second.user.id }],
  })).body as any;
  const fresh = ((again.data ?? again).approvalSteps as any[]).find((x) => x.status === 'PENDING');
  await post(approver, `/letters/${letter.id}/steps/${fresh.id}/decision`, { decision: 'APPROVE', comment: 'looks fine' });

  const noReason = await post(author, `/letters/${letter.id}/recall`, {}, false);
  expect(noReason.status, 'after a decision the drafter must give a reason').toBe(422);
  const withReason = await post(author, `/letters/${letter.id}/recall`, { reason: 'Numbers changed after review' }, false);
  expect(withReason.status, JSON.stringify(withReason.body).slice(0, 200)).toBeLessThan(400);
  const after = ((await apiGet(author, `/letters/${letter.id}`)) as any);
  expect((after.data ?? after).status).toBe('RETURNED');
  const history = ((after.data ?? after).approvalSteps as any[]).filter((x) => x.status === 'APPROVED');
  expect(history.length, 'the decided step stays in the history').toBeGreaterThanOrEqual(1);
});

async function status(s: ApiSession, path: string) {
  const res = await s.ctx.get(`${API}${path}`, { headers: bearer(s) });
  return res.status();
}

test('8. a RESTRICTED document: only its owner and the people on its approval chain can open it, and the approval still completes', async () => {
  const author = await as('fin.staff1');
  const colleague = await as('fin.staff2');
  const head = await as('fin.head');
  const otherHead = await as('fap.head');
  const auditor = await as('auditor');
  const doc = await uploadDoc(author, 'QA-APSG', `Restricted lifecycle ${Date.now()}`, 'RESTRICTED');

  expect(await status(author, `/documents/${doc.id}`), 'the owner opens it').toBe(200);
  expect(await status(colleague, `/documents/${doc.id}`), 'a department colleague cannot').toBeGreaterThanOrEqual(403);
  expect(await status(head, `/documents/${doc.id}`), 'the head cannot open a RESTRICTED document that is not shared with them').toBeGreaterThanOrEqual(403);
  expect(await status(auditor, `/documents/${doc.id}`), 'an oversight role can').toBe(200);

  // submitting puts the head on the chain, which shares the document with them as a person
  await approveChain(doc.id, 'fin.staff1');
  expect(await status(head, `/documents/${doc.id}`), 'the approver on the chain opened it and decided').toBe(200);
  expect(await status(colleague, `/documents/${doc.id}`), 'a colleague still cannot').toBeGreaterThanOrEqual(403);
  expect(await status(otherHead, `/documents/${doc.id}`), 'the head of another department cannot').toBeGreaterThanOrEqual(403);
});

test('9. making a document CONFIDENTIAL while its approval is running does not lock out the approver', async () => {
  const author = await as('fin.staff1');
  const colleague = await as('fin.staff2');
  const doc = await uploadDoc(author, 'QA-APSG', `Raised mid-approval ${Date.now()}`, 'INTERNAL');
  await post(author, `/approvals/DOCUMENT/${doc.id}/submit`, {});

  const raised = await patch(author, `/documents/${doc.id}/classification`, { classification: 'RESTRICTED' });
  expect(raised.status).toBeLessThan(400);
  expect(await status(colleague, `/documents/${doc.id}`), 'a colleague loses it').toBeGreaterThanOrEqual(403);
  // the review step belongs to the records officer (an oversight role) and the approve step to the finance head
  const head = await as('fin.head');
  expect(await status(head, `/documents/${doc.id}`), 'the approver the chain was waiting for still opens it').toBe(200);
  const chain = ((await apiGet(head, `/approvals/DOCUMENT/${doc.id}/chain`)) as any);
  expect(((chain.data ?? chain).steps as any[]).length).toBeGreaterThan(0);
});
