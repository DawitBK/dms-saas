/**
 * CAMS verification script — live HTTP test against :4000.
 *
 * Covers the full correspondence lifecycle:
 *   draft → edit (revision) → submit → final approve → e-sign ceremony
 *   (ref no. + PDF + QR are allocated when the SIGNATURE completes, not at
 *   approval — see enterPendingSignatureInTx / finalizeLetterAfterSigning)
 *   → public QR verify (authentic + tamper case) → dispatch
 *   → incoming registration (+ REPLY_TO link) → thread → archive filters
 *
 * Run: npx tsx test-scripts/verify-cams.ts   (backend must be running)
 */

import axios from 'axios';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';
// eslint-disable-next-line import/no-extraneous-dependencies
import { PDFDocument } from 'pdf-lib';
import { loginAs, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string; user: any }> {
  return loginAs(email, 'verify-cams.ts');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide the final APPROVE step and carry the letter all the way to APPROVED.
 *
 * A COMPOSED letter no longer goes straight from IN_REVIEW to APPROVED: the
 * final approval files a signable draft and parks the letter in
 * PENDING_SIGNATURE with a one-recipient, one-field e-sign ceremony
 * (letters.service.ts's enterPendingSignatureInTx). The reference number, QR
 * payload and final PDF are only allocated once that ceremony COMPLETES
 * (finalizeLetterAfterSigning). SCANNED-origin letters skip the ceremony and
 * still finalize inline, so this helper branches on the status the decision
 * actually returned and handles both.
 *
 * sendSignatureRequest runs on a post-commit setImmediate, so the request is
 * briefly still 'draft' — poll for the signable state instead of racing it.
 */
async function approveAndSign(letterId: string, stepId: string, auth: any): Promise<any> {
  const decided = (await axios.post(
    `${API_BASE}/letters/${letterId}/steps/${stepId}/decision`,
    { decision: 'APPROVE', comment: 'Verified and approved' },
    auth,
  )).data.data;

  // Approval no longer creates the signing ceremony. "Submit for approval" and
  // "initiate signing" are separate actions now: an outgoing composed letter
  // clears approval as APPROVED with NO reference number and NO filed document,
  // and someone then explicitly chooses who signs it. Anything else (incoming,
  // scanned-outgoing) still finalizes directly on approval and is returned
  // as-is here.
  if (decided.status !== 'APPROVED' || decided.documentId) return decided;

  const initiated = await initiateSigning(letterId, auth);
  if (initiated.status !== 'PENDING_SIGNATURE') return initiated;
  return completeCeremony(letterId, initiated.documentId, auth);
}

/** The caller's own user id, read from the access token — used to name the
 *  signatory so the same session can complete the ceremony. */
function callerUserId(auth: any): string {
  const token = String(auth.headers.Authorization).replace(/^Bearer /, '');
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return payload.user_id;
}

/** Initiate signing on an approved letter, naming the caller as signatory. */
async function initiateSigning(letterId: string, auth: any): Promise<any> {
  return (await axios.post(
    `${API_BASE}/letters/${letterId}/initiate-signing`,
    { signatory: { assignedUserId: callerUserId(auth) } },
    auth,
  )).data.data;
}

/** Sign off the pending ceremony on `documentId` and wait for the letter to
 *  leave PENDING_SIGNATURE. Split out of approveAndSign so the concurrency
 *  test — which decides the step itself, twice, on purpose — can reuse it. */
async function completeCeremony(letterId: string, documentId: string, auth: any): Promise<any> {
  let request: any = null;
  for (let i = 0; i < 40 && !request; i++) {
    const requests = (await axios.get(`${API_BASE}/documents/${documentId}/signing`, auth)).data.data;
    request = requests.find((r: any) => ['sent', 'partially_signed'].includes(r.status)) ?? null;
    if (!request) await sleep(250);
  }
  if (!request) throw new Error(`signature request never became signable for letter ${letterId}`);

  const full = (await axios.get(`${API_BASE}/signing/${request.id}`, auth)).data.data;
  const recipient = (full.recipients ?? [])[0];
  const fieldValues = (full.fields ?? [])
    .filter((f: any) => f.recipientId === recipient.id)
    .map((f: any) => ({ fieldId: f.id, value: 'verify-cams signature' }));
  await axios.post(
    `${API_BASE}/signing/${request.id}/recipients/${recipient.id}/sign`,
    { fieldValues },
    auth,
  );

  // Re-read until the letter has left PENDING_SIGNATURE — completion runs in
  // the signing request's own transaction, which commits after the HTTP call
  // returns from this process's point of view.
  for (let i = 0; i < 40; i++) {
    const letter = (await axios.get(`${API_BASE}/letters/${letterId}`, auth)).data.data;
    if (letter.status !== 'PENDING_SIGNATURE') return letter;
    await sleep(250);
  }
  return (await axios.get(`${API_BASE}/letters/${letterId}`, auth)).data.data;
}

async function main() {
  console.log('\n═══ CAMS verification ═══\n');

  // ── Setup ──
  const { token } = await loginWithTenant(verifyAdminEmail());
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  // The product refuses self-approval (ERR-SELF-APPROVAL: the drafter cannot approve their own letter), so a FIN employee
  // drafts, edits and submits every letter below and the administrator decides, signs and dispatches.
  const drafter = await loginWithTenant('employee@edams.local');
  const draftAuth = { headers: { Authorization: `Bearer ${drafter.token}` } };
  console.log(`Setup: logged in as ${verifyAdminEmail()} (tenant ${verifyTenantId()})`);

  // Org units (HQ seeded by migration; create if missing)
  let units = (await axios.get(`${API_BASE}/org-units`, auth)).data.data;
  if (!units.length) {
    await axios.post(`${API_BASE}/org-units`, { code: 'HQ', name: 'Head Office', unitType: 'HQ' }, auth);
    units = (await axios.get(`${API_BASE}/org-units`, auth)).data.data;
  }
  const hq = units.find((u: any) => u.code === 'HQ') ?? units[0];
  check('org-units list returns the HQ unit', Boolean(hq));

  // Create a branch unit to prove unit management works. Fixed code (not
  // time-based) so reruns find-and-reuse it instead of accumulating a new
  // "Test Branch" every run — that accumulation is exactly what previously
  // cluttered the hierarchy tree with 9 leftover units. Org units are always
  // flat siblings under the tenant — the API does not accept parentUnitId at
  // all — so this must NOT be created under HQ.
  const branchCode = 'TEST-BR-CAMS';
  let branch = units.find((u: any) => u.code === branchCode);
  if (!branch) {
    branch = (await axios.post(
      `${API_BASE}/org-units`,
      { code: branchCode, name: 'Test Branch (verify-cams)', unitType: 'BRANCH' },
      auth,
    )).data.data;
  }
  check('org-unit create (flat sibling of HQ, not nested under it)', branch.unitType === 'BRANCH' && !branch.parentUnitId);

  const departments = (await axios.get(`${API_BASE}/departments`, auth)).data.data;
  const fin = departments.find((d: any) => d.code === 'FIN') ?? departments[0];
  check('department lookup (FIN)', Boolean(fin));

  // ── 1. Outgoing lifecycle ──
  console.log('\n1. Outgoing letter lifecycle');
  const draft = (await axios.post(
    `${API_BASE}/letters`,
    {
      orgUnitId: hq.id, departmentId: fin.id,
      subject: `CAMS verification letter ${Date.now()}`,
      bodyHtml: '<p>First paragraph of the verification letter.</p><p>Second paragraph.</p>',
      letterType: 'OUT', confidentiality: 'INTERNAL', priority: 'NORMAL',
      correspondent: 'Ato Test Recipient', correspondentOrganization: 'Ministry of Verification',
    },
    draftAuth,
  )).data.data;
  check('draft created with status DRAFT and no reference number', draft.status === 'DRAFT' && draft.referenceNumber === null);

  const updated = (await axios.patch(
    `${API_BASE}/letters/${draft.id}`,
    { bodyHtml: '<p>First paragraph, revised.</p><p>Second paragraph.</p>' },
    draftAuth,
  )).data.data;
  check('draft edit accepted', Boolean(updated));

  const submitted = (await axios.post(
    `${API_BASE}/letters/${draft.id}/submit`,
    { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] },
    draftAuth,
  )).data.data;
  check('submit → IN_REVIEW with a PENDING approve step', submitted.status === 'IN_REVIEW');
  const revCount = (submitted.revisions ?? []).length;
  check('revision history recorded (>= 2 revisions)', revCount >= 2, `revisions=${revCount}`);

  const pendingStep = (submitted.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
  check('pending step exists', Boolean(pendingStep));

  // The split, asserted directly: final approval must complete approval and
  // stop there — no reference number, no filed document, no ceremony. This is
  // the behaviour that stops a chosen signatory being handed an approval task.
  const approvalOnly = (await axios.post(
    `${API_BASE}/letters/${draft.id}/steps/${pendingStep.id}/decision`,
    { decision: 'APPROVE', comment: 'Verified and approved' },
    auth,
  )).data.data;
  check(
    'final approval alone → APPROVED, no reference number, no document, no ceremony',
    approvalOnly.status === 'APPROVED' &&
      approvalOnly.referenceNumber === null &&
      !approvalOnly.documentId,
    `${approvalOnly.status} ref=${approvalOnly.referenceNumber} doc=${approvalOnly.documentId}`,
  );

  // Dispatch must be refused while there is no letter of record yet.
  const earlyDispatch = await axios
    .post(`${API_BASE}/letters/${draft.id}/dispatch`, { recipientName: 'Too Early' }, auth)
    .then(() => ({ status: 200 }))
    .catch((e) => ({ status: e.response?.status ?? 0 }));
  check(
    'dispatch is refused before the letter is signed',
    earlyDispatch.status >= 400,
    `status ${earlyDispatch.status}`,
  );

  // Initiate signing: the separate action, with its own signatory choice.
  const initiated = await initiateSigning(draft.id, auth);
  check(
    'initiate signing → PENDING_SIGNATURE with a signable draft filed',
    initiated.status === 'PENDING_SIGNATURE' && Boolean(initiated.documentId) && initiated.referenceNumber === null,
    `${initiated.status} doc=${initiated.documentId}`,
  );

  // Initiating twice must not create a second ceremony.
  const doubleInitiate = await axios
    .post(
      `${API_BASE}/letters/${draft.id}/initiate-signing`,
      { signatory: { assignedUserId: callerUserId(auth) } },
      auth,
    )
    .then(() => ({ status: 200 }))
    .catch((e) => ({ status: e.response?.status ?? 0 }));
  check(
    'initiating signing twice is refused (no second ceremony)',
    doubleInitiate.status === 409,
    `status ${doubleInitiate.status}`,
  );

  const approved = await completeCeremony(draft.id, initiated.documentId, auth);
  check('signature → status APPROVED', approved.status === 'APPROVED', approved.status);
  check(
    'reference number allocated in REF/UNIT/DEPT/TYPE/YEAR/SEQ format',
    /^REF\/HQ\/FIN\/OUT\/\d{4}\/\d{5}$/.test(approved.referenceNumber ?? ''),
    approved.referenceNumber,
  );
  check('signatory stamped from approver profile', Boolean(approved.signatoryName));
  check('QR payload generated', Boolean(approved.qrPayload));
  check('final PDF filed as encrypted document', Boolean(approved.documentId));

  // Gap-free sequencing: approve a second letter, sequence must increment by 1
  const seq1 = parseInt((approved.referenceNumber as string).split('/').pop()!, 10);
  const draft2 = (await axios.post(
    `${API_BASE}/letters`,
    { orgUnitId: hq.id, departmentId: fin.id, subject: `CAMS seq test ${Date.now()}`, bodyHtml: '<p>x</p>', letterType: 'OUT' },
    draftAuth,
  )).data.data;
  const sub2 = (await axios.post(`${API_BASE}/letters/${draft2.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] }, draftAuth)).data.data;
  const step2 = (sub2.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
  const approved2 = await approveAndSign(draft2.id, step2.id, auth);
  const seq2 = parseInt((approved2.referenceNumber as string).split('/').pop()!, 10);
  check('sequence is strictly incrementing and gap-free', seq2 === seq1 + 1, `${seq1} → ${seq2}`);

  // ── 2. PDF download ──
  console.log('\n2. Final PDF');
  const pdfResp = await axios.get(`${API_BASE}/letters/${draft.id}/pdf`, { ...auth, responseType: 'arraybuffer' });
  const pdfBuf = Buffer.from(pdfResp.data);
  check('PDF downloads and starts with %PDF magic bytes', pdfBuf.subarray(0, 4).toString() === '%PDF', pdfBuf.subarray(0, 8).toString());

  // ── 2b. Amharic composed letter (Ethiopic font embedding) ──
  console.log('\n2b. Amharic composed letter');
  const amDraft = (await axios.post(
    `${API_BASE}/letters`,
    {
      orgUnitId: hq.id, departmentId: fin.id,
      subject: `የማረጋገጫ ደብዳቤ ${Date.now()}`,
      bodyHtml: '<p>ለክቡር አቶ ተስፋዬ፣</p><p>ይህ ደብዳቤ የ CAMS ማረጋገጫ ሙከራ ነው።</p>',
      letterType: 'OUT', confidentiality: 'INTERNAL',
      correspondent: 'አቶ ተስፋዬ በቀለ',
    },
    draftAuth,
  )).data.data;
  const amSub = (await axios.post(`${API_BASE}/letters/${amDraft.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] }, draftAuth)).data.data;
  const amStep = (amSub.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
  const amApproved = await approveAndSign(amDraft.id, amStep.id, auth);
  check('Amharic letter approves and allocates a reference', Boolean(amApproved.referenceNumber), amApproved.referenceNumber);
  const amPdfBuf = Buffer.from((await axios.get(`${API_BASE}/letters/${amDraft.id}/pdf`, { ...auth, responseType: 'arraybuffer' })).data);
  check('Amharic PDF downloads (%PDF)', amPdfBuf.subarray(0, 4).toString() === '%PDF');
  {
    // Font names live inside compressed object streams — reload and enumerate.
    const loaded = await PDFDocument.load(amPdfBuf);
    const fontNames: string[] = [];
    loaded.context.enumerateIndirectObjects().forEach(([, obj]) => {
      const m = /\/BaseFont\s*\/([^\s/>]+)/.exec((obj as any)?.toString?.() ?? '');
      if (m) fontNames.push(m[1]);
    });
    check(
      'Amharic PDF embeds Noto Sans Ethiopic (script not stripped to "?")',
      fontNames.some((n) => n.includes('NotoSansEthiopic')),
      fontNames.join(','),
    );
  }

  // ── 2c. Scanned-origin outgoing letter + cover sheet ──
  console.log('\n2c. Scanned outgoing letter');
  const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF');
  const scanForm = new FormData();
  scanForm.append('scan', new Blob([tinyPdf], { type: 'application/pdf' }), 'signed-original.pdf');
  scanForm.append('orgUnitId', hq.id);
  scanForm.append('departmentId', fin.id);
  scanForm.append('subject', `Scanned original ${Date.now()}`);
  scanForm.append('letterType', 'OUT');
  const scanned = (await axios.post(`${API_BASE}/letters/scanned`, scanForm, draftAuth)).data.data;
  check('scanned letter drafts with staged content file', scanned.status === 'DRAFT' && Boolean(scanned.attachmentDocumentId ?? scanned.documentId ?? true));
  const scanSub = (await axios.post(`${API_BASE}/letters/${scanned.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] }, draftAuth)).data.data;
  const scanStep = (scanSub.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
  const scanApproved = await approveAndSign(scanned.id, scanStep.id, auth);
  check('scanned letter approval allocates reference + promotes the scan', Boolean(scanApproved.referenceNumber) && Boolean(scanApproved.documentId), scanApproved.referenceNumber);
  const coverBuf = Buffer.from((await axios.get(`${API_BASE}/letters/${scanned.id}/cover-sheet`, { ...auth, responseType: 'arraybuffer' })).data);
  check('QR cover sheet downloads (%PDF)', coverBuf.subarray(0, 4).toString() === '%PDF');

  // ── 2d. Draft attachments: add → download → remove purges the backing doc ──
  console.log('\n2d. Letter attachments');
  const attDraft = (await axios.post(
    `${API_BASE}/letters`,
    { orgUnitId: hq.id, departmentId: fin.id, subject: `Attachment test ${Date.now()}`, bodyHtml: '<p>x</p>', letterType: 'OUT' },
    draftAuth,
  )).data.data;
  const attForm = new FormData();
  const attBytes = Buffer.from(`attachment-payload-${Date.now()}`);
  attForm.append('file', new Blob([attBytes], { type: 'image/png' }), 'evidence.png');
  const withAtt = (await axios.post(`${API_BASE}/letters/${attDraft.id}/attachments`, attForm, draftAuth)).data.data;
  const attachment = (withAtt.attachments ?? [])[0];
  check('attachment filed and listed on the letter', Boolean(attachment?.id), JSON.stringify(withAtt.attachments ?? []));
  const attDl = Buffer.from((await axios.get(`${API_BASE}/letters/${attDraft.id}/attachments/${attachment.id}`, { ...draftAuth, responseType: 'arraybuffer' })).data);
  check('attachment downloads byte-identical (encrypt/decrypt round-trip)', attDl.equals(attBytes));
  const attDocId = attachment.documentId;
  const afterRemove = (await axios.delete(`${API_BASE}/letters/${attDraft.id}/attachments/${attachment.id}`, draftAuth)).data.data;
  check('attachment removed from the letter', (afterRemove.attachments ?? []).length === 0);
  const docGone = await axios.get(`${API_BASE}/documents/${attDocId}`, auth).then(() => false, (e) => e.response?.status === 404);
  check('backing CORR document purged on removal (no orphan)', docGone === true, `documentId=${attDocId}`);

  // ── 3. Public QR verification ──
  console.log('\n3. Public QR verification (no auth)');
  const qrUrl = new URL(approved.qrPayload);
  const ref = qrUrl.searchParams.get('ref')!;
  const hash = qrUrl.searchParams.get('hash')!;
  const verifyOk = (await axios.get(`${API_BASE}/letters/verify`, { params: { ref, hash } })).data.data;
  check('genuine ref+hash → authentic=true with unit + signatory', verifyOk.authentic === true && Boolean(verifyOk.signatoryName));
  const tampered = (await axios.get(`${API_BASE}/letters/verify`, { params: { ref, hash: 'a'.repeat(64) } })).data.data;
  check('tampered hash → authentic=false', tampered.authentic === false);

  // ── 4. Dispatch ──
  console.log('\n4. Dispatch & delivery tracking');
  await axios.post(
    `${API_BASE}/letters/${draft.id}/dispatches`,
    { channel: 'COURIER', recipientName: 'Ato Test Recipient', trackingReference: 'TRK-001', notes: 'verification run' },
    auth,
  );
  const afterDispatch = (await axios.get(`${API_BASE}/letters/${draft.id}`, auth)).data.data;
  check('dispatch recorded and status → DISPATCHED', afterDispatch.status === 'DISPATCHED' && (afterDispatch.dispatches ?? []).length === 1);

  // ── 5. Incoming registration + cross-reference ──
  console.log('\n5. Incoming registration + thread');
  const incoming = (await axios.post(
    `${API_BASE}/letters/register`,
    {
      orgUnitId: hq.id, departmentId: fin.id,
      subject: `Reply to ${approved.referenceNumber}`,
      correspondent: 'Ministry of Verification',
      relatedLetterId: draft.id,
    },
    auth,
  )).data.data;
  check('incoming registered with RECEIVED status', incoming.status === 'RECEIVED');
  check('incoming registration number allocated (…/IN/…)', /\/IN\/\d{4}\/\d{5}$/.test(incoming.referenceNumber ?? ''), incoming.referenceNumber);

  const thread = (await axios.get(`${API_BASE}/letters/${incoming.id}/links`, auth)).data.data;
  check('REPLY_TO link visible in cross-reference thread', (thread.outbound ?? []).some((l: any) => l.linkType === 'REPLY_TO'));
  const reverseThread = (await axios.get(`${API_BASE}/letters/${draft.id}/links`, auth)).data.data;
  check('link visible from the other side too', (reverseThread.inbound ?? []).length >= 1);

  // ── 6. Archive search ──
  console.log('\n6. Archive filters');
  const outList = (await axios.get(`${API_BASE}/letters`, { ...auth, params: { direction: 'OUTGOING', q: 'CAMS verification' } })).data;
  check('outgoing filter + full-text q finds the letter', outList.data.some((l: any) => l.id === draft.id));
  const inList = (await axios.get(`${API_BASE}/letters`, { ...auth, params: { direction: 'INCOMING' } })).data;
  check('incoming filter finds the registered letter', inList.data.some((l: any) => l.id === incoming.id));

  // ── 7. Guards ──
  console.log('\n7. Guards');
  const editLocked = await axios
    .patch(`${API_BASE}/letters/${draft.id}`, { subject: 'tamper attempt' }, draftAuth)
    .then(() => false)
    .catch((e) => e.response?.status === 409);
  check('approved letter is locked (edit → 409)', editLocked === true);

  // ── 8. Concurrency: double-approval race ──
  // Two simultaneous final-approval requests on the SAME pending step must
  // resolve as exactly one success + one 409, with exactly one reference
  // number allocated (no phantom sequence numbers, no orphan documents).
  console.log('\n8. Concurrency (double-approval race)');
  const raceDraft = (await axios.post(
    `${API_BASE}/letters`,
    { orgUnitId: hq.id, departmentId: fin.id, subject: `CAMS race test ${Date.now()}`, bodyHtml: '<p>race</p>', letterType: 'OUT' },
    draftAuth,
  )).data.data;
  const raceSub = (await axios.post(
    `${API_BASE}/letters/${raceDraft.id}/submit`,
    { steps: [{ stepType: 'APPROVE', assignedRole: 'SYSTEM_ADMIN' }] },
    draftAuth,
  )).data.data;
  const raceStep = (raceSub.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
  // Baseline from the LAST allocation before the race (sections 2b/2c also
  // draw from this sequence, so approved2's number is stale by now).
  const seqBefore = parseInt((scanApproved.referenceNumber as string).split('/').pop()!, 10);

  const attempt = () =>
    axios
      .post(`${API_BASE}/letters/${raceDraft.id}/steps/${raceStep.id}/decision`, { decision: 'APPROVE' }, auth)
      .then((r) => ({ ok: true as const, status: r.status }))
      .catch((e) => ({ ok: false as const, status: e.response?.status ?? 0 }));
  const [r1, r2] = await Promise.all([attempt(), attempt()]);
  const successes = [r1, r2].filter((r) => r.ok).length;
  const conflicts = [r1, r2].filter((r) => !r.ok && r.status === 409).length;
  check('exactly one approval succeeds, the other gets 409', successes === 1 && conflicts === 1,
    `statuses: ${r1.status}/${r2.status}`);

  // The winning approval leaves the letter APPROVED and unsigned — approval no
  // longer starts a ceremony. Then race the NEW action too: two simultaneous
  // initiate-signing calls must produce exactly one ceremony.
  const afterRace = (await axios.get(`${API_BASE}/letters/${raceDraft.id}`, auth)).data.data;
  check('the race winner leaves the letter APPROVED and unsigned',
    afterRace.status === 'APPROVED' && afterRace.referenceNumber === null && !afterRace.documentId,
    afterRace.status);

  const initiateAttempt = () =>
    axios
      .post(
        `${API_BASE}/letters/${raceDraft.id}/initiate-signing`,
        { signatory: { assignedUserId: callerUserId(auth) } },
        auth,
      )
      .then((r) => ({ ok: true as const, status: r.status }))
      .catch((e) => ({ ok: false as const, status: e.response?.status ?? 0 }));
  const [i1, i2] = await Promise.all([initiateAttempt(), initiateAttempt()]);
  check('exactly one initiate-signing succeeds, the other gets 409',
    [i1, i2].filter((r) => r.ok).length === 1 && [i1, i2].filter((r) => !r.ok && r.status === 409).length === 1,
    `statuses: ${i1.status}/${i2.status}`);

  const racedPending = (await axios.get(`${API_BASE}/letters/${raceDraft.id}`, auth)).data.data;
  check('exactly one signing ceremony exists after the initiate race',
    racedPending.status === 'PENDING_SIGNATURE' && Boolean(racedPending.documentId),
    racedPending.status);
  const raced = await completeCeremony(raceDraft.id, racedPending.documentId, auth);
  const raceSeq = parseInt((raced.referenceNumber as string).split('/').pop()!, 10);
  check('exactly ONE reference number allocated (seq advanced by exactly 1)',
    raced.status === 'APPROVED' && raceSeq === seqBefore + 1, `${seqBefore} → ${raceSeq}`);

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.response?.data ?? e.message);
  process.exit(1);
});
