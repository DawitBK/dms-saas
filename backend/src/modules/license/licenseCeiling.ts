/**
 * The "SSO ends on this date" note (docs/operations/PLATFORM-LICENSING.md section 10; owner decision 2026-10-21).
 *
 * A DMS that holds an OFFLINE licence (signed on the owner's computer, verified against the pinned LICENSE_TRUST_PUBLIC_KEYS) cannot be re-signed by SSO to
 * follow SSO's own expiry: that would put the private licence key on the server. Instead SSO publishes a small note signed with its ordinary OIDC key; DMS
 * verifies it against SSO's JWKS and ends at the EARLIER of its own licence date and the note's date.
 *
 * Safe without the owner's key because the note can only SHORTEN a licence: `applyCeiling` never moves an end date later, so a forged or replayed note
 * cannot grant time (the offline-signed date is the hard backstop). Like the licence token it has no `exp` and carries no secret.
 *
 * Keep this file in step with GMS's modules/license/license.ceiling.ts (the two are copies of one rule, adapted to each codebase).
 */
import crypto from "node:crypto";
import type { LicenseClaims } from "./licenseToken.js";

export const LICENSE_CEILING_TYP = "kcms-license-ceiling+jwt";
export const LICENSE_CEILING_AUDIENCE = "license:ceiling";

export interface CeilingClaims {
  iss: string;
  ver: number;
  iat: number | null;
  customer: string | null;
  /** null = SSO's licence never expires: no limit. */
  expiresAt: Date | null;
  graceDays: number;
  warnDays: number;
  jti: string | null;
}

export type CeilingResult = { ok: true; claims: CeilingClaims; kid: string } | { ok: false; reason: string };

export interface CeilingVerifyOptions {
  resolveKey: (kid: string | undefined) => Promise<crypto.KeyObject | null> | crypto.KeyObject | null;
  /** SSO's own issuer. Unset = not compared (the signature is still verified against SSO's own JWKS), as for the licence token. */
  issuer?: string | undefined;
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const isDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 365;

function parseJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyCeilingToken(token: string, options: CeilingVerifyOptions): Promise<CeilingResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > 16_384) return { ok: false, reason: "note is missing or too large" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((s) => s.length === 0)) return { ok: false, reason: "not a compact JWS" };
  const header = parseJson(parts[0]);
  if (!header) return { ok: false, reason: "header is not JSON" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg is not RS256" };
  if (header.typ !== LICENSE_CEILING_TYP) return { ok: false, reason: `typ is not ${LICENSE_CEILING_TYP}` };
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  let key: crypto.KeyObject | null;
  try {
    key = await options.resolveKey(kid);
  } catch {
    return { ok: false, reason: "signing key could not be resolved" };
  }
  if (!key) return { ok: false, reason: `no signing key for kid ${kid ?? "(none)"}` };
  let signatureOk = false;
  try {
    signatureOk = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "signature does not verify" };

  const p = parseJson(parts[1]);
  if (!p) return { ok: false, reason: "payload is not JSON" };
  if (typeof p.iss !== "string" || (options.issuer && !sameIssuer(p.iss, options.issuer))) return { ok: false, reason: "iss does not match" };
  if (p.aud !== LICENSE_CEILING_AUDIENCE) return { ok: false, reason: `aud is not ${LICENSE_CEILING_AUDIENCE}` };
  if (p.sys !== "sso") return { ok: false, reason: "sys is not sso" };
  if (typeof p.ver !== "number" || !Number.isInteger(p.ver) || p.ver < 0) return { ok: false, reason: "ver is not a non-negative integer" };
  let expiresAt: Date | null = null;
  if (p.expiresAt !== null && p.expiresAt !== undefined) {
    if (typeof p.expiresAt !== "string") return { ok: false, reason: "expiresAt is not an ISO string or null" };
    expiresAt = new Date(p.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: "expiresAt is not a real date" };
  }
  if (!isDays(p.graceDays)) return { ok: false, reason: "graceDays is not an integer 0..365" };
  if (!isDays(p.warnDays)) return { ok: false, reason: "warnDays is not an integer 0..365" };
  return {
    ok: true,
    kid: kid ?? "",
    claims: {
      iss: p.iss,
      ver: p.ver,
      iat: typeof p.iat === "number" ? p.iat : null,
      customer: typeof p.customer === "string" ? p.customer : null,
      expiresAt,
      graceDays: p.graceDays,
      warnDays: p.warnDays,
      jti: typeof p.jti === "string" ? p.jti : null,
    },
  };
}

export type LimitedBy = "licence" | "sso";

const DAY_MS = 86_400_000;

/**
 * The licence as enforced: its own dates, unless SSO ends first, in which case SSO's date and warning days apply (as on the mirror, where SSO re-signs the
 * client token), with SSO's grace days capped so the system never stays usable past the instant its own licence's grace period ends: the note only shortens.
 *
 * A licence that may ALSO run standalone (`modes` includes `standalone`) is not tied to SSO and keeps its own dates (owner decision 2026-10-21); only a
 * licence valid solely behind SSO ends with SSO.
 */
export function applyCeiling(claims: LicenseClaims, ceiling: CeilingClaims | null): { claims: LicenseClaims; limitedBy: LimitedBy } {
  const own = { claims, limitedBy: "licence" as const };
  if (!ceiling || ceiling.expiresAt === null) return own;
  if ((claims.modes ?? ["sso"]).includes("standalone")) return own;
  const ownEnd = claims.expiresAt ? claims.expiresAt.getTime() : Number.POSITIVE_INFINITY;
  if (!(ceiling.expiresAt.getTime() < ownEnd)) return own;
  const room = Math.floor((ownEnd + claims.graceDays * DAY_MS - ceiling.expiresAt.getTime()) / DAY_MS);
  return { claims: { ...claims, expiresAt: ceiling.expiresAt, graceDays: Math.min(ceiling.graceDays, room), warnDays: ceiling.warnDays }, limitedBy: "sso" };
}
