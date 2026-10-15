// Authenticated (JWT) e-signing API for the internal dashboard — distinct from
// api.ts, which is the public/access-token surface for the external ceremony
// page. Uses the shared apiClient (auto Bearer token), unlike api.ts's plain
// fetch (which must NOT carry the logged-in session's token).
import { apiClient, apiClientBlob } from '../../shared/lib/apiClient';

export type SigningRecipientSummary = {
  id: string;
  name: string;
  email: string;
  status: 'pending' | 'viewed' | 'signed' | 'declined';
  orderIndex: number;
};

export type SigningRequestSummary = {
  id: string;
  documentId: string;
  status: 'draft' | 'sent' | 'partially_signed' | 'completed' | 'voided' | 'expired';
  orderingMode: 'parallel' | 'serial';
  createdAt: string;
  completedAt: string | null;
  document?: { id: string; title: string; documentName: string };
  recipients?: SigningRecipientSummary[];
  // Only populated on the pending-me scope (listMySignatureTasks) — needed so
  // "Sign now" can submit directly from that list without a second fetch
  // through GET /documents/:id/signing, which requires document:read ACL and
  // 403s for a recipient outside the document's normal folder/department
  // scope even though the actual sign endpoint has no such gate.
  fields?: Array<{ id: string; recipientId: string; fieldType: string }>;
};

/** Recipient-centric row from the pending-me scope — request is nested. Also
 *  IS the recipient the "sign" endpoint expects (id/name/email), so this row
 *  alone is enough to sign — no need to re-fetch the request separately. */
export type MySignatureTask = {
  id: string;
  name: string;
  email: string;
  status: 'pending' | 'viewed';
  orderIndex: number;
  request?: SigningRequestSummary;
};

export function listMySignatureTasks(skip = 0, take = 25) {
  return apiClient<{ data: MySignatureTask[]; total: number }>(`/signing/requests?scope=pending-me&skip=${skip}&take=${take}`);
}

/** The actual document bytes for a pending signature task, so a signer can
 *  see what they're about to sign — see fetchSigningDocumentBytes's own
 *  comment (backend) for why this is its own endpoint rather than the
 *  generic document download route. */
export async function fetchSigningDocumentBlobUrl(requestId: string, recipientId: string): Promise<string> {
  const blob = await apiClientBlob(`/signing/${requestId}/recipients/${recipientId}/document`);
  return URL.createObjectURL(blob);
}

export function listSentSignatureRequests(skip = 0, take = 25) {
  return apiClient<{ data: SigningRequestSummary[]; total: number }>(`/signing/requests?scope=sent-by-me&skip=${skip}&take=${take}`);
}

export function listCompletedSignatureRequests(skip = 0, take = 25) {
  return apiClient<{ data: SigningRequestSummary[]; total: number }>(`/signing/requests?scope=completed&skip=${skip}&take=${take}`);
}

export function remindSignatureRequest(requestId: string) {
  return apiClient<{ data: SigningRequestSummary }>(`/signing/${requestId}/remind`, { method: 'POST' });
}

/** Cancel (void) a request that has not completed. Creator or system administrator only (backend). */
export function cancelSignatureRequest(requestId: string, reason?: string) {
  return apiClient<{ data: SigningRequestSummary }>(`/signing/${requestId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
}

/** A candidate internal signer for the recipient picker. */
export type AssignableSigner = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string | null;
  /** Powers the picker's non-blocking "this signer is outside the document's
   *  department" advisory — a named signer is globally scoped by design, so
   *  this only warns, it never filters the list. */
  departments?: Array<{ id: string; name: string; code: string }>;
};

/**
 * Searchable list of internal users that can be added as signers. Backed by
 * GET /signing/assignable-users (gated by SIGNING_MANAGE), which searches by
 * first name, last name, OR email, and can be narrowed by department/role
 * membership. Returns up to 25 matches.
 */
export function listSigningAssignableUsers(q?: string, filters?: { departmentId?: string; roleId?: string }) {
  const params = new URLSearchParams();
  if (q?.trim()) params.set('q', q.trim());
  if (filters?.departmentId) params.set('departmentId', filters.departmentId);
  if (filters?.roleId) params.set('roleId', filters.roleId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiClient<{ data: AssignableSigner[] }>(`/signing/assignable-users${qs}`);
}

/** A newly uploaded-and-filed document, ready to be used as
 *  createSignatureRequest's documentId — see uploadDocumentForSigning. */
export type UploadedSigningDocument = {
  documentId: string;
  documentName: string;
  warnings: string[];
  duplicateOf: string | null;
};

/**
 * Uploads a local file straight from the signing page and files it as a
 * first-class Document (POST /signing/uploads, gated by SIGNING_MANAGE).
 * Department/document type/folder are all optional — omitted values fall
 * back to the tenant's fixed Uncategorized bucket (UNCAT / SIGN-UNCAT).
 * Returns the new document's id so the caller can continue straight into the
 * existing signing-ceremony-creation flow.
 */
export function uploadDocumentForSigning(
  file: File,
  meta: { departmentId?: string; departmentCode?: string; documentTypeCode?: string; folderPath?: string; title?: string },
) {
  const formData = new FormData();
  formData.append('file', file);
  // departmentId is the precise, collision-free field — department codes are
  // only unique per (tenant, org unit), so two departments can share a code
  // and departmentCode alone can resolve to the wrong one. Always send it
  // when known; departmentCode stays only for a caller that hasn't been
  // updated to send an id.
  if (meta.departmentId) formData.append('departmentId', meta.departmentId);
  else if (meta.departmentCode) formData.append('departmentCode', meta.departmentCode);
  if (meta.documentTypeCode) formData.append('documentTypeCode', meta.documentTypeCode);
  if (meta.folderPath) formData.append('folderPath', meta.folderPath);
  if (meta.title) formData.append('title', meta.title);
  return apiClient<{ data: UploadedSigningDocument }>('/signing/uploads', {
    method: 'POST',
    body: formData,
  });
}

/** One row of the tenant-wide oversight list (document:read_all holders only). Read-only: no tokens. */
export type OversightSignatureRequest = SigningRequestSummary & {
  createdBy: string | null;
  createdByName: string | null;
  voidedReason?: string | null;
  expiresAt?: string | null;
};

export function listAllSignatureRequests(params: { skip?: number; take?: number; status?: string; q?: string } = {}) {
  const qs = new URLSearchParams({ scope: 'all', skip: String(params.skip ?? 0), take: String(params.take ?? 25) });
  if (params.status) qs.set('status', params.status);
  if (params.q?.trim()) qs.set('q', params.q.trim());
  return apiClient<{ data: OversightSignatureRequest[]; total: number }>(`/signing/requests?${qs.toString()}`);
}

/** One line of a request's audit trail: who, when, from where, doing what. */
export type SigningAuditEntry = {
  id: string;
  at: string;
  action: string;
  success: boolean;
  actor: { userId: string; name: string | null; role: string | null } | null;
  externalSigner: string | null;
  recipientId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  detail: string | null;
};

/** Requester, administrator or oversight (audit:read / document:read_all) only (backend 403s everyone else). */
export function getSignatureRequestAudit(requestId: string) {
  return apiClient<{ data: SigningAuditEntry[] }>(`/signing/${requestId}/audit`);
}
