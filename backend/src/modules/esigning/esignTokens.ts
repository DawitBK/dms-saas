/**
 * External-signer access tokens (E24).
 *
 * The emailed signing link carries a random bearer secret. Only its SHA-256
 * digest is stored (`signature_recipients.access_token_hash`); the raw value
 * exists in exactly two places: the link in the email, and — for the few
 * seconds between enqueue and delivery — the `signUrl` of the outbox row that
 * carries that email (redacted by `redactOutboxPayload` as soon as the row is
 * processed, see queue/outbox.ts).
 *
 * The token is 24 random bytes (192 bits), so an unsalted SHA-256 is enough:
 * there is nothing to brute-force and nothing to look up by token (the
 * recipient is always addressed by id, the token is only compared).
 *
 * This file is a dependency-free leaf on purpose: queue/outbox.ts imports it,
 * and esigning.service.ts imports the outbox, so it must not import either.
 */

import crypto from 'node:crypto';

/** How long an emailed external-signer link stays valid. Re-armed at send and
 *  at every reminder (a reminder also rotates the token). */
export const EXTERNAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** SHA-256 hex digest of a raw token. */
export function hashAccessToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A fresh token: the raw value (shown once, in the link) and the digest to store. */
export function mintAccessToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(24).toString('base64url');
  return { raw, hash: hashAccessToken(raw) };
}

/** Constant-time comparison of two strings of any length (both are digested first,
 *  so differing lengths do not short-circuit). */
function safeEqual(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Does the presented raw token match what is stored?
 *
 *  - `storedHash` is the normal case: compare SHA-256(presented) to it.
 *  - `legacyPlaintext` is a read-only bridge for a row written by a backend that
 *    pre-dates the hash column (a rolling deploy can briefly leave one). The
 *    migration (20261004000021) hashes and clears every existing plaintext
 *    token, so in steady state this is always null; it is never written.
 *
 * False when the presented token or both stored forms are missing (an internal
 * recipient has no token at all).
 */
export function accessTokenMatches(
  presented: string | undefined | null,
  stored: { hash?: string | null; legacyPlaintext?: string | null },
): boolean {
  if (!presented) return false;
  if (stored.hash) return safeEqual(hashAccessToken(presented), stored.hash);
  if (stored.legacyPlaintext) return safeEqual(presented, stored.legacyPlaintext);
  return false;
}

/**
 * Removes the raw token from an already-delivered outbox payload. Returns the
 * redacted JSON string, or null when the event type carries no token or the
 * payload needs no change (so the caller can skip the write).
 */
export function redactOutboxPayload(type: string, payload: string): string | null {
  if (type !== 'ESIGNING.RECIPIENT_INVITED') return null;
  const redacted = payload
    .replace(/"accessToken"\s*:\s*(?:"[^"]*"|null)\s*,?/g, '')
    .replace(/([?&]token=)[A-Za-z0-9_%.~-]+/g, '$1REDACTED');
  return redacted === payload ? null : redacted;
}
