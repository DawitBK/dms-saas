import { apiClient, apiClientBlob, apiClientBlobResponse } from '../../shared/lib/apiClient';
import { API_BASE_URL } from '../../shared/lib/apiConfig';
import type {
  CreateLetterInput,
  LetterDetail,
  LetterLinkRecord,
  LetterRevisionBody,
  LetterSummary,
  LetterVolumeReport,
  OrgUnitSummary,
  VerifyResult,
} from './types';

export function listLetters(params: {
  direction?: 'OUTGOING' | 'INCOMING';
  status?: string;
  orgUnitId?: string;
  departmentId?: string;
  year?: number;
  letterType?: string;
  q?: string;
  overdue?: boolean;
  skip?: number;
  take?: number;
}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== false) query.set(k, String(v));
  });
  return apiClient<{ data: LetterSummary[]; total: number }>(`/letters?${query}`);
}

export function getLetter(id: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}`);
}

/** Reverse lookup for the Documents module's own detail page: is this
 *  document (its final PDF, an attachment, or a cover sheet) actually a
 *  filed letter, and if so, its full approval chain. `data` is `null` for
 *  every ordinary, non-letter document — that's the expected case, not an
 *  error. */
export function getLetterByDocumentId(documentId: string) {
  return apiClient<{ data: LetterDetail | null }>(`/letters/by-document/${documentId}`);
}

/** Full bodyHtml for one revision — getLetter()'s revision list omits bodies. */
export function getLetterRevisionBody(id: string, revisionNo: number) {
  return apiClient<{ data: LetterRevisionBody }>(`/letters/${id}/revisions/${revisionNo}`);
}

export function createLetter(input: CreateLetterInput) {
  return apiClient<{ data: LetterDetail }>(`/letters`, { method: 'POST', body: JSON.stringify(input) });
}

/** Stateless preview render for the compose page (letters/new) — renders
 *  whatever has been typed so far through the real PDF pipeline, no letter
 *  ever created. Mirrors previewFormTemplatePdf's POST /forms/templates/preview.
 *
 *  Also returns `blockPages`: the letter body's top-level content blocks,
 *  numbered in document order, each mapped to the 1-based PDF page it starts
 *  on (letters.routes.ts's `X-Letter-Block-Pages` header, from
 *  drawLetterBodyDoc's onBlockPage) — lets the live preview jump to the exact
 *  page the author's caret is on instead of guessing from scroll position. */
export async function previewLetterPdf(input: {
  orgUnitId: string;
  departmentId: string;
  subject?: string;
  bodyHtml?: string;
  correspondent?: string;
  correspondentOrganization?: string;
  correspondentLocation?: string;
}): Promise<{ blob: Blob; blockPages: number[] }> {
  const response = await apiClientBlobResponse(`/letters/preview-pdf`, { method: 'POST', body: JSON.stringify(input) });
  let blockPages: number[] = [];
  try {
    blockPages = JSON.parse(response.headers['x-letter-block-pages'] ?? '[]');
  } catch {
    // A malformed/missing header just means "no exact page map this round" —
    // the preview still renders fine, it falls back to scroll-based tracking.
  }
  return { blob: response.data, blockPages };
}

export function updateLetter(id: string, input: Partial<CreateLetterInput>) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/**
 * Submit a letter for approval — approvers only.
 *
 * The `signatory` argument is gone on purpose. It used to ride along here,
 * which is exactly why the person chosen to SIGN a letter received an approval
 * task: the signatory was stored at submit and the signing ceremony was created
 * as a side effect of the final approval. Choosing who signs is now its own
 * action — see initiateLetterSigning below.
 */
export function submitLetter(
  id: string,
  steps?: { stepType: 'REVIEW' | 'APPROVE'; assignedRole?: string; assignedUserId?: string; slaHours?: number }[],
) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      ...(steps && steps.length ? { steps } : {}),
    }),
  });
}

/**
 * Initiate signing on a letter whose approval is complete — signatory only.
 *
 * The separate second action. Scoping mirrors approval steps exactly:
 * `assignedUserId` is tenant-wide (any active member — a cross-department
 * choice is allowed and merely flagged), `assignedRole` is department-scoped
 * to the letter's own department. Exactly one of the two.
 */
export function initiateLetterSigning(
  id: string,
  signatory: { assignedUserId?: string; assignedRole?: string },
) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/initiate-signing`, {
    method: 'POST',
    body: JSON.stringify({ signatory }),
  });
}

export type LetterAssignableUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  departments: Array<{ id: string; name: string; code: string }>;
};

// Named-person candidates for the submit-chain modal's approver/reviewer
// step picker, and the "who signs this letter" picker — reachable by any
// letter drafter/reviewer/approver, not just USER_MANAGE holders (unlike
// GET /users, which the reassign-step admin recovery flow still uses).
export function getLetterAssignableUsers(stepType: 'REVIEW' | 'APPROVE' | 'SIGNATORY') {
  return apiClient<{ data: LetterAssignableUser[] }>(`/letters/assignable-users?stepType=${stepType}`);
}

export function decideStep(letterId: string, stepId: string, decision: 'APPROVE' | 'RETURN', comment?: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${letterId}/steps/${stepId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, comment }),
  });
}

/** reason is required only for the admin-override cancel of an IN_REVIEW letter (>=10 chars, enforced server-side). */
export function cancelLetter(id: string, reason?: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

/** Drafter pulls their own letter back out of review to edit it (IN_REVIEW -> RETURNED). A reason of
 *  10+ characters is required once any step has already been decided. */
export function recallLetter(id: string, reason?: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/recall`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

/** Admin recovery: reassign a stuck PENDING step (deactivated assignee,
 *  unstaffed role). Requires department:manage or admin bypass — enforced
 *  server-side. Exactly one of assignedUserId / assignedRole. */
export function reassignStep(
  letterId: string,
  stepId: string,
  input: { assignedUserId?: string; assignedRole?: string; reason?: string },
) {
  return apiClient<{ data: LetterDetail }>(`/letters/${letterId}/steps/${stepId}/reassign`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function archiveLetter(id: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/archive`, { method: 'POST' });
}

export function recordDispatch(
  id: string,
  input: { channel: string; recipientName?: string; recipientAddress?: string; trackingReference?: string; notes?: string },
) {
  return apiClient(`/letters/${id}/dispatches`, { method: 'POST', body: JSON.stringify(input) });
}

export function registerIncoming(input: Record<string, string>, scan?: File) {
  const formData = new FormData();
  Object.entries(input).forEach(([k, v]) => {
    if (v !== undefined && v !== '') formData.append(k, v);
  });
  if (scan) formData.append('scan', scan);
  return apiClient<{ data: LetterDetail }>(`/letters/register`, { method: 'POST', body: formData });
}

/** Outgoing letter filed as a scan of a signed paper original (not composed
 *  in-system) — the paper-origin counterpart of createLetter(). */
export function createScannedLetter(input: Record<string, string>, scan: File) {
  const formData = new FormData();
  Object.entries(input).forEach(([k, v]) => {
    if (v !== undefined && v !== '') formData.append(k, v);
  });
  formData.append('scan', scan);
  return apiClient<{ data: LetterDetail }>(`/letters/scanned`, { method: 'POST', body: formData });
}

/** Attach a supplementary file to a letter while it's still a draft — the
 *  "paperclip" equivalent of composing an email with attachments. */
export function addLetterAttachment(letterId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiClient<{ data: LetterDetail }>(`/letters/${letterId}/attachments`, { method: 'POST', body: formData });
}

export function removeLetterAttachment(letterId: string, attachmentId: string) {
  return apiClient<{ data: LetterDetail }>(`/letters/${letterId}/attachments/${attachmentId}`, { method: 'DELETE' });
}

/** Uploads an image inserted directly into the Body editor (paste or the
 *  toolbar's Insert Image button) — distinct from addLetterAttachment
 *  above, which files a supporting document alongside the letter. Not
 *  scoped to a letterId: the compose form (letters/new) has no letter row
 *  yet when an author pastes an image. Returns the `url` to reference from
 *  an image node's `src` in the editor's doc JSON. */
export function uploadLetterBodyImage(file: File | Blob) {
  const formData = new FormData();
  formData.append('file', file);
  return apiClient<{ data: { id: string; url: string; width: number; height: number } }>(
    `/letters/body-images`,
    { method: 'POST', body: formData },
  );
}

export function assignLetter(id: string, assignedToUserId: string | null, dueDate?: string | null) {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ assignedToUserId, dueDate }),
  });
}

export function getLetterLinks(id: string) {
  return apiClient<{ data: { outbound: LetterLinkRecord[]; inbound: LetterLinkRecord[] } }>(`/letters/${id}/links`);
}

export function linkLetters(id: string, relatedLetterId: string, linkType: 'REPLY_TO' | 'RELATED' | 'FOLLOW_UP') {
  return apiClient(`/letters/${id}/links`, { method: 'POST', body: JSON.stringify({ relatedLetterId, linkType }) });
}

export function unlinkLetters(id: string, linkId: string) {
  return apiClient(`/letters/${id}/links/${linkId}`, { method: 'DELETE' });
}

export function resolveLetter(id: string, status: 'RESPONDED' | 'CLOSED') {
  return apiClient<{ data: LetterDetail }>(`/letters/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export function acknowledgeDispatch(letterId: string, dispatchId: string, note?: string) {
  return apiClient(`/letters/${letterId}/dispatches/${dispatchId}/acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function listOrgUnits() {
  return apiClient<{ data: OrgUnitSummary[] }>(`/org-units`);
}

/** Small backend report powering the dashboard's letter-volume widget. */
export function fetchLetterVolumeReport() {
  return apiClient<{ data: LetterVolumeReport }>(`/reports/letters/volume`).then((r) => r.data);
}

/** Public — no auth header required. Used by the QR verification page. */
export async function verifyLetterPublic(ref: string, hash: string): Promise<VerifyResult> {
  const base = API_BASE_URL;
  const res = await fetch(`${base}/letters/verify?ref=${encodeURIComponent(ref)}&hash=${encodeURIComponent(hash)}`);
  if (!res.ok) throw new Error(`Verification request failed (${res.status})`);
  const json = (await res.json()) as { data: VerifyResult };
  return json.data;
}

/** Authenticated download of the letter's primary content → object URL.
 *  For a COMPOSED letter this is the rendered PDF; for a SCANNED one it's
 *  whatever file was actually uploaded (PDF/Word/image). */
export async function fetchLetterPdfBlobUrl(id: string): Promise<string> {
  const blob = await apiClientBlob(`/letters/${id}/pdf`);
  return URL.createObjectURL(blob);
}

/** Authenticated download of the generated QR verification cover sheet
 *  (SCANNED-origin letters only) → object URL. */
export async function fetchLetterCoverSheetBlobUrl(id: string): Promise<string> {
  const blob = await apiClientBlob(`/letters/${id}/cover-sheet`);
  return URL.createObjectURL(blob);
}

/** Authenticated download of one supplementary attachment → object URL. */
export async function fetchLetterAttachmentBlobUrl(letterId: string, attachmentId: string): Promise<string> {
  const blob = await apiClientBlob(`/letters/${letterId}/attachments/${attachmentId}`);
  return URL.createObjectURL(blob);
}
