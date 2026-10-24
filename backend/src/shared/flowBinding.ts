/**
 * Browser-binding for the in-flight OIDC authorization-code flow (P1-1).
 *
 * `state` is unguessable, but unguessable is not the same as bound. The DMS
 * callback used to accept a code+state pair from whatever browser presented it,
 * so an attacker holding a valid pair from their OWN completed authorization
 * could get a victim's browser to redeem it and be silently signed in as the
 * attacker — login CSRF / session fixation. Everything the victim then does
 * happens in the attacker's account.
 *
 * At authorize time we mint a high-entropy token, persist only its SHA-256
 * alongside the state/nonce, and hand the raw token to the browser as an
 * httpOnly cookie. At callback time the cookie must be present and must hash to
 * the stored value. An attacker can copy `code` and `state` out of their own URL
 * bar; they cannot write an httpOnly cookie for this origin into someone else's
 * browser.
 *
 * Hashing before comparing keeps both operands at a fixed 32 bytes, which
 * sidesteps timingSafeEqual's throw-on-length-mismatch and keeps the token's
 * length from leaking. Mirrors SSO's `flow-binding.ts`, which does
 * the same for the portal and GMS-bridge legs of the same platform flow.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface FlowBinding {
  /** Raw token — goes to the browser in an httpOnly cookie. Never persisted. */
  token: string;
  /** SHA-256 of the token, hex — this is what is persisted. */
  hash: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createFlowBinding(): FlowBinding {
  const token = randomBytes(32).toString('hex');
  return { token, hash: sha256Hex(token) };
}

/**
 * Constant-time check. Fails closed on every degenerate input: no cookie, no
 * stored hash (which is exactly what a pre-deploy row looks like), or a stored
 * value that is not 64 hex characters.
 */
export function flowBindingMatches(presentedToken: string | undefined, storedHash: unknown): boolean {
  if (!presentedToken || typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const expected = Buffer.from(storedHash, 'hex');
  if (expected.length !== 32) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(presentedToken), 'hex'), expected);
}
