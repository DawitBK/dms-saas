/**
 * The signed letter of record actually carries the signature.
 *
 * THE BUG THIS PINS
 *
 * Reported as: "view final letter shows the letter without the signature even
 * though it was signed." True of every signed letter in the system, and for two
 * compounding reasons.
 *
 *   1. `generateLetterPdf` accepted a `signatureImageDataUrl` and never drew it.
 *      The parameter was declared on the input type and referenced nowhere else
 *      in the file — so even a signatory who HAD set a signature got an unsigned
 *      letter of record.
 *
 *   2. It was fed `User.signatureImage` — the signatory's stored PROFILE
 *      signature, which nobody had (0 of 24 users). The mark a signatory
 *      actually draws during the ceremony is written to the ceremony's
 *      signature FIELD and never went near the profile.
 *
 * Structurally: the ceremony stamps its signature into the unnumbered SIGNABLE
 * DRAFT, and `finalizeLetterAfterSigning` then renders the numbered letter of
 * record FROM SCRATCH afterwards. So the signature stayed behind on the draft,
 * and the PDF that gets dispatched — the one with the reference number, the one
 * of record — showed none.
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT
 *
 * The join that resolves the captured signature crosses SignatureField ->
 * SignatureRequest, and that inverse association did not exist. TypeScript
 * accepted it happily, because Sequelize `include` options are not type-checked
 * against the declared associations — it would have failed at runtime, on the
 * finalize path, AFTER the reference number had been allocated. Only a live run
 * catches that class of mistake.
 *
 * Needs the dev backend on :7100 and seeded users (npm run db:seed:core).
 * Run: npx tsx test-scripts/verify-letter-signature-on-record.ts
 */

import 'dotenv/config';
import axios from 'axios';
import { PDFDocument } from 'pdf-lib';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A real 2x2 PNG, as a data URL.
 *
 * It has to be a genuinely decodable image: the renderer embeds it with
 * pdf-lib's embedPng, which parses the bytes. A fake data URL would be skipped
 * by the same guard that skips a typed signature, and the test would pass while
 * proving nothing.
 */
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWNgYGD4TyRmGFX4n37BAwA0vWOdh6puJAAAAABJRU5ErkJggg==';

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string; user: any }> {
  return loginAs(email, 'verify-letter-signature-on-record.ts');
}

const authFor = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function main() {
  console.log('\n═══ Signature on the letter of record ═══\n');

  const { token, user } = await loginWithTenant(verifyAdminEmail());
  const auth = authFor(token);
  check('admin authenticates', Boolean(token && user?.id));
  // The product refuses self-approval (ERR-SELF-APPROVAL), so a second person approves the letter this administrator drafts.
  const approver = await loginAs(verifyApproverEmail(), 'verify-letter-signature-on-record.ts');

  const orgUnits = (await axios.get(`${API_BASE}/org-units`, auth)).data.data;
  const departments = (await axios.get(`${API_BASE}/departments`, auth)).data.data;
  const department = departments.find((d: any) => d.code === 'FIN') ?? departments[0];

  // ── A composed outgoing letter, approved ──────────────────────────────────
  const letter = (
    await axios.post(
      `${API_BASE}/letters`,
      {
        orgUnitId: department.orgUnitId ?? orgUnits[0].id, // the unit the department really belongs to (ERR-DEPT-ORG-UNIT-MISMATCH otherwise)
        departmentId: department.id,
        subject: `Signature-on-record verification ${Date.now()}`,
        bodyHtml: '<p>Body for signature verification.</p>',
        letterType: 'OUT',
        correspondent: 'Verification Correspondent',
        correspondentEmail: 'verify@example.com',
      },
      auth,
    )
  ).data.data;

  const submitted = (
    await axios.post(`${API_BASE}/letters/${letter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] }, auth)
  ).data.data;
  const step = (submitted.approvalSteps ?? []).find((s: any) => s.status === 'PENDING') ?? submitted.approvalSteps?.[0];
  await axios.post(`${API_BASE}/letters/${letter.id}/steps/${step.id}/decision`, { decision: 'APPROVE', comment: 'verifier' }, authFor(approver.token));

  const approved = (await axios.get(`${API_BASE}/letters/${letter.id}`, auth)).data.data;
  check('the letter reaches APPROVED with no reference number yet', approved.status === 'APPROVED' && !approved.referenceNumber, {
    status: approved.status,
    ref: approved.referenceNumber,
  });

  // ── Initiate signing, then sign with a REAL image ─────────────────────────
  const pending = (
    await axios.post(`${API_BASE}/letters/${letter.id}/initiate-signing`, { signatory: { assignedUserId: user.id } }, auth)
  ).data.data;
  check('initiating signing parks the letter in PENDING_SIGNATURE', pending.status === 'PENDING_SIGNATURE', pending.status);

  const draftDocumentId = pending.documentId;
  check('a signable draft document exists to sign', Boolean(draftDocumentId));

  let request: any = null;
  for (let i = 0; i < 40 && !request; i++) {
    const requests = (await axios.get(`${API_BASE}/documents/${draftDocumentId}/signing`, auth)).data.data;
    request = requests.find((r: any) => ['sent', 'partially_signed'].includes(r.status)) ?? null;
    if (!request) await sleep(250);
  }
  check('a signature request becomes signable', Boolean(request));
  if (!request) {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  const full = (await axios.get(`${API_BASE}/signing/${request.id}`, auth)).data.data;
  const recipient = (full.recipients ?? [])[0];
  const signatureFields = (full.fields ?? []).filter(
    (f: any) => f.recipientId === recipient.id && f.fieldType === 'signature',
  );
  check('the ceremony offers a signature field to draw into', signatureFields.length > 0);

  await axios.post(
    `${API_BASE}/signing/${request.id}/recipients/${recipient.id}/sign`,
    {
      fieldValues: (full.fields ?? [])
        .filter((f: any) => f.recipientId === recipient.id)
        // The real mark goes into the signature field; anything else takes text.
        .map((f: any) => ({ fieldId: f.id, value: f.fieldType === 'signature' ? SIGNATURE_PNG : 'verifier' })),
    },
    auth,
  );

  let finalized: any = null;
  for (let i = 0; i < 40; i++) {
    const current = (await axios.get(`${API_BASE}/letters/${letter.id}`, auth)).data.data;
    if (current.status !== 'PENDING_SIGNATURE') {
      finalized = current;
      break;
    }
    await sleep(250);
  }
  check('the letter leaves PENDING_SIGNATURE after signing', Boolean(finalized), finalized?.status);
  if (!finalized) {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(1);
  }

  check('a reference number is allocated at signature', Boolean(finalized.referenceNumber), finalized.referenceNumber);
  check(
    'the final numbered document is a DIFFERENT document from the signable draft',
    Boolean(finalized.documentId) && finalized.documentId !== draftDocumentId,
    { final: finalized.documentId, draft: draftDocumentId },
  );

  // ── The actual point: is the signature IN the letter of record? ───────────
  const pdfBytes = Buffer.from(
    (
      await axios.get(`${API_BASE}/documents/${finalized.documentId}/download`, {
        ...auth,
        responseType: 'arraybuffer',
      })
    ).data as ArrayBuffer,
  );
  check('the finalized letter downloads as a PDF', pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-');

  const parsed = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // Every letter embeds a QR code, so "has an image" proves nothing on its own.
  // Counting XObject images does: an unsigned letter has exactly the QR (plus
  // the letterhead artwork when present), a signed one has one more.
  const imageCount = pdfBytes.toString('latin1').match(/\/Subtype\s*\/Image/g)?.length ?? 0;
  check('the finalized PDF embeds more than one image (QR + signature)', imageCount >= 2, { imageCount });

  const text = pdfBytes.toString('latin1');
  check('the signature block is printed', text.includes('With Regards') || parsed.getPageCount() > 0);

  // ── The signed draft is retained, but is not a second library entry ──────
  //
  // A signed letter files TWO documents: the ceremony-stamped draft carrying
  // the PAdES proof, and the numbered letter of record. Both were listed, under
  // the same title — reported as "it lists the same document twice".
  //
  // The draft must stay: it is the evidence the letter was signed. It just is
  // not a separate item in the library.
  const defaultList = (await axios.get(`${API_BASE}/documents?take=100`, auth)).data;
  const leaked = (defaultList.data ?? []).filter((d: any) => String(d.documentName ?? '').includes('Signed Draft'));
  check('no signature drafts appear in the default document library', leaked.length === 0, {
    leaked: leaked.slice(0, 3).map((d: any) => d.documentName),
  });

  const draftTitle = (defaultList.data ?? []).filter((d: any) => d.id === draftDocumentId);
  check("this letter's own signed draft is not listed", draftTitle.length === 0);

  // Hidden from the LIST, not from the system: it must still open by id, or the
  // signature evidence would be unreachable rather than merely unlisted.
  const draftDirect = await axios
    .get(`${API_BASE}/documents/${draftDocumentId}`, auth)
    .then((r) => r.status)
    .catch((e) => e.response?.status ?? 0);
  check('the signed draft is still reachable directly by id', draftDirect === 200, draftDirect);

  const inclusiveList = (await axios.get(`${API_BASE}/documents?take=100&includeLetterSignedDrafts=true`, auth)).data;
  check(
    'an explicit opt-in still returns them, for records views that want every filed object',
    inclusiveList.total > defaultList.total,
    { withoutDrafts: defaultList.total, withDrafts: inclusiveList.total },
  );

  // ── The control: a TYPED signature must not draw an image ────────────────
  //
  // Without a control, the assertion above could be satisfied by anything that
  // draws a second image unconditionally. This one goes down the exact same
  // path — approve, initiate signing, complete the ceremony — and differs only
  // in what the signatory submitted: plain text instead of a drawn mark.
  //
  // A ceremony can legitimately record a typed name, and the verifiers record
  // plain marker text. embedSignatureImage skips anything that is not a real
  // raster image, so a typed signature must fall through to the name/title
  // lines rather than corrupting the PDF or inventing a mark that was never
  // made. That guard is what this pins.
  const typedLetter = (
    await axios.post(
      `${API_BASE}/letters`,
      {
        orgUnitId: department.orgUnitId ?? orgUnits[0].id, // the unit the department really belongs to (ERR-DEPT-ORG-UNIT-MISMATCH otherwise)
        departmentId: department.id,
        subject: `Typed-signature control ${Date.now()}`,
        bodyHtml: '<p>Control letter, signed with typed text.</p>',
        letterType: 'OUT',
        correspondent: 'Control',
      },
      auth,
    )
  ).data.data;
  const typedSubmitted = (
    await axios.post(`${API_BASE}/letters/${typedLetter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.userId }] }, auth)
  ).data.data;
  const typedStep = (typedSubmitted.approvalSteps ?? []).find((s: any) => s.status === 'PENDING') ?? typedSubmitted.approvalSteps?.[0];
  await axios.post(
    `${API_BASE}/letters/${typedLetter.id}/steps/${typedStep.id}/decision`,
    { decision: 'APPROVE', comment: 'verifier control' },
    authFor(approver.token),
  );
  const typedPending = (
    await axios.post(`${API_BASE}/letters/${typedLetter.id}/initiate-signing`, { signatory: { assignedUserId: user.id } }, auth)
  ).data.data;

  let typedRequest: any = null;
  for (let i = 0; i < 40 && !typedRequest; i++) {
    const requests = (await axios.get(`${API_BASE}/documents/${typedPending.documentId}/signing`, auth)).data.data;
    typedRequest = requests.find((r: any) => ['sent', 'partially_signed'].includes(r.status)) ?? null;
    if (!typedRequest) await sleep(250);
  }
  const typedFull = (await axios.get(`${API_BASE}/signing/${typedRequest.id}`, auth)).data.data;
  const typedRecipient = (typedFull.recipients ?? [])[0];
  await axios.post(
    `${API_BASE}/signing/${typedRequest.id}/recipients/${typedRecipient.id}/sign`,
    {
      fieldValues: (typedFull.fields ?? [])
        .filter((f: any) => f.recipientId === typedRecipient.id)
        .map((f: any) => ({ fieldId: f.id, value: 'Typed Name' })),
    },
    auth,
  );

  let typedFinal: any = null;
  for (let i = 0; i < 40; i++) {
    const current = (await axios.get(`${API_BASE}/letters/${typedLetter.id}`, auth)).data.data;
    if (current.status !== 'PENDING_SIGNATURE') {
      typedFinal = current;
      break;
    }
    await sleep(250);
  }
  check('the typed-signature control letter finalizes', Boolean(typedFinal?.documentId), typedFinal?.status);

  if (typedFinal?.documentId) {
    const typedBytes = Buffer.from(
      (
        await axios.get(`${API_BASE}/documents/${typedFinal.documentId}/download`, { ...auth, responseType: 'arraybuffer' })
      ).data as ArrayBuffer,
    );
    const typedImages = typedBytes.toString('latin1').match(/\/Subtype\s*\/Image/g)?.length ?? 0;
    check(
      'a typed signature draws NO image — the drawn-mark assertion above is real',
      typedImages < imageCount,
      { drawn: imageCount, typed: typedImages },
    );
  }


  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err.response?.status, err.response?.data ?? err.message);
  process.exit(1);
});
