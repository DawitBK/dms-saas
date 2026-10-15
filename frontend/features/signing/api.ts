// Public (no-auth) API surface for the external e-signing landing page
// (frontend/app/sign/[requestId]/[recipientId]/page.tsx). These endpoints
// authenticate via a per-recipient access token carried in the URL query
// string, never a JWT — mirrors the plain-`fetch` pattern used by
// verifyLetterPublic() in features/letters/api.ts rather than the
// axios-based apiClient (which auto-injects an unrelated Bearer token from
// the logged-in DMS session, if any happens to exist in this browser).

import { API_BASE_URL } from '../../shared/lib/apiConfig';

const API_BASE = API_BASE_URL;

export class SigningApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'SigningApiError';
    this.status = status;
    this.code = code;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code: string | undefined;
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: { code?: string; message?: string } };
      code = json.error?.code;
      message = json.error?.message ?? message;
    } catch {
      // non-JSON error body — fall back to the generic message above
    }
    throw new SigningApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

export type ExternalSigningField = {
  id: string;
  fieldType: 'signature' | 'initial' | 'date' | 'text' | 'seal';
  pageNumber: number;
  value: string | null;
};

export type ExternalSigningRecipientSummary = {
  id: string;
  name: string;
  orderIndex: number;
  status: 'pending' | 'viewed' | 'signed' | 'declined';
};

export type ExternalSigningView = {
  request: {
    id: string;
    status: 'draft' | 'sent' | 'partially_signed' | 'completed' | 'voided' | 'expired';
    orderingMode: 'parallel' | 'serial';
    expiresAt: string | null;
    documentName: string | null;
  };
  recipient: {
    id: string;
    name: string;
    email: string;
    status: 'pending' | 'viewed' | 'signed' | 'declined';
    orderIndex: number;
  };
  fields: ExternalSigningField[];
  recipients: ExternalSigningRecipientSummary[];
};

/** GET the signing context and mark the recipient as having viewed the link. */
export async function getExternalSigningView(
  requestId: string,
  recipientId: string,
  accessToken: string,
): Promise<ExternalSigningView> {
  const res = await fetch(
    `${API_BASE}/signing/${requestId}/recipients/${recipientId}/view?token=${encodeURIComponent(accessToken)}`,
  );
  const json = await handle<{ data: ExternalSigningView }>(res);
  return json.data;
}

/** The actual document bytes for an external signer to preview before
 *  signing — see the backend's fetchSigningDocumentBytes for why this
 *  couldn't just be the generic document-download route (no ACL identity to
 *  check it against; an emailed access token is all an external signer has). */
export async function fetchExternalSigningDocumentBlobUrl(
  requestId: string,
  recipientId: string,
  accessToken: string,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/signing/${requestId}/recipients/${recipientId}/document/external?token=${encodeURIComponent(accessToken)}`,
  );
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      message = json.error?.message ?? message;
    } catch {
      // non-JSON error body — fall back to the generic message above
    }
    throw new SigningApiError(message, res.status);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function signExternal(
  requestId: string,
  recipientId: string,
  accessToken: string,
  fieldValues: Array<{ fieldId: string; value: string }>,
): Promise<{ status: string; allSigned: boolean }> {
  const res = await fetch(`${API_BASE}/signing/${requestId}/recipients/${recipientId}/sign/external`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, fieldValues }),
  });
  const json = await handle<{ data: { status: string; allSigned: boolean } }>(res);
  return json.data;
}

export async function declineExternal(
  requestId: string,
  recipientId: string,
  accessToken: string,
  reason: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/signing/${requestId}/recipients/${recipientId}/decline/external`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, reason }),
  });
  await handle<{ success: boolean }>(res);
}
