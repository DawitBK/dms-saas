// shared/lib/ownerTicket.ts
//
// Owner-only operations (today: creating a tenant) need a single-use owner ticket issued by SSO
// (SSO console > Owner verification). The backend reads it from the X-Owner-Authorisation header
// (backend modules/auth/ownerAuthorisation.ts). The owner copies the ticket out of SSO and pastes it
// into the form; this turns the pasted text into the request headers.

export const OWNER_AUTHORISATION_HEADER = 'X-Owner-Authorisation';

/** Backend error codes that mean "send (a new) owner ticket". */
export const OWNER_AUTHORISATION_CODES = [
  'OWNER_AUTHORISATION_REQUIRED',
  'OWNER_AUTHORISATION_INVALID',
  'OWNER_AUTHORISATION_UNAVAILABLE',
] as const;

/**
 * Headers for a pasted ticket. All whitespace is removed (a ticket is a compact token with no spaces, and a pasted
 * line break would make the browser refuse the header). An empty paste sends no header at all.
 */
export function ownerTicketHeaders(pasted: string): Record<string, string> {
  const ticket = pasted.replace(/\s+/g, '');
  return ticket ? { [OWNER_AUTHORISATION_HEADER]: ticket } : {};
}
