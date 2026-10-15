// Readable wording for the error codes the e-signing API can answer with. The backend already sends a
// message with each code; this table exists so the wording shown to people is chosen here, in plain
// language, and does not change when a server-side message is reworded. Anything not listed falls back
// to the server's own message, then to the caller's fallback.
import { getErrorCode } from '../../shared/lib/errorMessage';

export const SIGNING_ERROR_MESSAGES: Record<string, string> = {
  'ERR-SIGNATURE-REQUIRED': 'Please complete every signature field assigned to you before signing.',
  'ERR-SIGNATURE-INVALID': 'The signature image is not valid. Draw, type or upload a PNG or JPEG signature and try again.',
  'ERR-SIGNING-IN-PROGRESS': 'This document already has a signature request in progress. Cancel it first, then send a new one.',
  'ERR-RECIPIENT-INVALID': 'One of the signers is not valid. Check that every signer is a member of your organisation, or has a name and an email address.',
  'ERR-RECIPIENT-ROLE-UNSTAFFED': 'Nobody currently holds the role you picked for this document, so nobody could sign. Choose a person or another role.',
  'ERR-FIELD-INVALID': 'A signature field points at a signer who is not on this request. Remove or reassign it.',
  'ERR-EXPIRY-INVALID': 'The expiry time must be in the future.',
  'ERR-FOLDER-INVALID': 'The folder you picked to file the signed document into was not found.',
  'ERR-DOCUMENT-NOT-SIGNABLE': 'This document cannot be sent for signature yet. It must be approved first and have a file.',
  'ERR-SIGNING-NOT-PERMITTED': 'Only the document owner, an administrator, someone with write access, or the approver of this document can send it for signature.',
  'ERR-SIGNING-VERSION-STALE': 'The document has changed since this request was prepared, so it can no longer be signed. Cancel this request and send a new one for the current version.',
  'ERR-SIGNING-EXPIRED': 'This signature request has expired and can no longer be signed.',
  'ERR-SIGNING-OUT-OF-ORDER': 'Earlier signers must sign before you in this signing order.',
  'ERR-ALREADY-SIGNED': 'You have already signed this document.',
  'ERR-ALREADY-CLAIMED': 'Somebody else already took this signing task.',
  'ERR-HOLD-MODIFICATION-BLOCKED': 'This document is under legal hold and cannot be signed right now.',
  'ERR-INVALID-STATE': 'This request is no longer open, so that action is not available.',
};

/** Text for a failed signing call: the table above, else the server's message, else the fallback. */
export function signingErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const code = codeOf(err);
  if (code && SIGNING_ERROR_MESSAGES[code]) return SIGNING_ERROR_MESSAGES[code];
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** The code from an ApiError (internal calls) or a SigningApiError (the public, token-based calls). */
function codeOf(err: unknown): string | undefined {
  const viaApi = getErrorCode(err);
  if (viaApi && viaApi !== 'ERR-UNKNOWN') return viaApi;
  const own = (err as { code?: unknown } | null)?.code;
  return typeof own === 'string' ? own : undefined;
}

/** Wording for each action recorded in a request's audit trail. */
export const SIGNING_AUDIT_ACTION_LABELS: Record<string, string> = {
  signature_request_created: 'Request created',
  signature_request_sent: 'Request sent',
  signature_request_reminded: 'Reminder sent',
  signature_request_viewed: 'Opened by signer',
  document_signed_partial: 'Signed',
  document_signed_completed: 'Signed (last signer, request completed)',
  signature_declined: 'Declined',
  signature_request_cancelled: 'Cancelled by requester',
  signature_request_expired: 'Expired',
  signature_token_rejected: 'Refused: invalid or expired signing link',
  signature_document_fetched: 'Document opened by link',
  pades_signed_copy_filed: 'Signed copy filed (digitally signed)',
  flattened_signed_copy_filed: 'Signed copy filed',
  SIGNING_EXPIRED: 'Document returned from signing (expired)',
};

export function signingAuditActionLabel(action: string): string {
  return SIGNING_AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}
