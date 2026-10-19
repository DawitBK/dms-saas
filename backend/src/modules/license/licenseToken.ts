/**
 * Verifier for the signed licence token SSO issues (contract section 4): a compact JWS, RS256, header
 * `typ: "kcms-license+jwt"` plus the signing key's `kid`, signed with SSO's own OIDC key.
 *
 * Deliberately NOT jsonwebtoken: the token carries no `exp` on purpose (the licence's own dates are the
 * expiry, and a consumer must never reject a token for its age), so a general-purpose verifier's checks are
 * either irrelevant or, for `typ`, absent. Uses node:crypto only, no new dependency.
 *
 * Checked: three segments, alg RS256, typ, signature against the key for the header's `kid`, `iss`, `aud`
 * (`license:dms`), `sys` (`dms`), and the shape of every claim the rest of DMS relies on. Anything else is a
 * rejection (the caller then keeps the previous good token).
 */
import crypto from "node:crypto";
import { LICENSE_SYSTEM, LICENSE_TOKEN_AUDIENCE, LICENSE_TOKEN_TYP } from "./license.constants.js";

export interface LicenseClaims {
  iss: string;
  aud: string;
  sys: string;
  ver: number;
  iat: number | null;
  customer: string | null;
  /** null = perpetual */
  expiresAt: Date | null;
  graceDays: number;
  warnDays: number;
  /** null = unlimited */
  maxUsers: number | null;
  /** null = every module enabled */
  modules: string[] | null;
}

export type LicenseTokenResult = { ok: true; claims: LicenseClaims; kid: string } | { ok: false; reason: string };

export interface VerifyOptions {
  /** Resolve the public key for a `kid` (the caller owns JWKS fetching/caching). null = unknown kid. */
  resolveKey: (kid: string | undefined) => Promise<crypto.KeyObject | null> | crypto.KeyObject | null;
  /** The expected `iss`. Unset = not checked (the signature is still verified against SSO's own JWKS). */
  issuer?: string | undefined;
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function parseJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 365;

/** Validate and normalise the payload. Exported for tests. */
export function parseLicenseClaims(p: Record<string, unknown>): { ok: true; claims: LicenseClaims } | { ok: false; reason: string } {
  if (typeof p.ver !== "number" || !Number.isInteger(p.ver) || p.ver < 0) return { ok: false, reason: "ver is not a non-negative integer" };
  if (!isDays(p.graceDays)) return { ok: false, reason: "graceDays is not an integer 0..365" };
  if (!isDays(p.warnDays)) return { ok: false, reason: "warnDays is not an integer 0..365" };

  let expiresAt: Date | null = null;
  if (p.expiresAt !== null && p.expiresAt !== undefined) {
    if (typeof p.expiresAt !== "string") return { ok: false, reason: "expiresAt is not an ISO string or null" };
    expiresAt = new Date(p.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: "expiresAt is not a real date" };
  }

  let maxUsers: number | null = null;
  if (p.maxUsers !== null && p.maxUsers !== undefined) {
    if (typeof p.maxUsers !== "number" || !Number.isInteger(p.maxUsers) || p.maxUsers < 1) return { ok: false, reason: "maxUsers is not an integer >= 1 or null" };
    maxUsers = p.maxUsers;
  }

  let modules: string[] | null = null;
  if (p.modules !== null && p.modules !== undefined) {
    if (!Array.isArray(p.modules) || !p.modules.every((m) => typeof m === "string")) return { ok: false, reason: "modules is not a string array or null" };
    modules = [...new Set(p.modules as string[])];
  }

  return {
    ok: true,
    claims: {
      iss: String(p.iss),
      aud: String(p.aud),
      sys: String(p.sys),
      ver: p.ver,
      iat: typeof p.iat === "number" ? p.iat : null,
      customer: typeof p.customer === "string" ? p.customer : null,
      expiresAt,
      graceDays: p.graceDays,
      warnDays: p.warnDays,
      maxUsers,
      modules,
    },
  };
}

export async function verifyLicenseToken(token: string, options: VerifyOptions): Promise<LicenseTokenResult> {
  if (typeof token !== "string") return { ok: false, reason: "token is not a string" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((s) => s.length === 0)) return { ok: false, reason: "not a compact JWS" };

  const header = parseJson(parts[0]);
  if (!header) return { ok: false, reason: "header is not JSON" };
  if (header.alg !== "RS256") return { ok: false, reason: "alg is not RS256" };
  if (header.typ !== LICENSE_TOKEN_TYP) return { ok: false, reason: `typ is not ${LICENSE_TOKEN_TYP}` };
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

  const payload = parseJson(parts[1]);
  if (!payload) return { ok: false, reason: "payload is not JSON" };
  if (typeof payload.iss !== "string" || (options.issuer && !sameIssuer(payload.iss, options.issuer))) return { ok: false, reason: "iss does not match" };
  if (payload.aud !== LICENSE_TOKEN_AUDIENCE) return { ok: false, reason: `aud is not ${LICENSE_TOKEN_AUDIENCE}` };
  if (payload.sys !== LICENSE_SYSTEM) return { ok: false, reason: `sys is not ${LICENSE_SYSTEM}` };

  const parsed = parseLicenseClaims(payload);
  if (!parsed.ok) return parsed;
  return { ok: true, claims: parsed.claims, kid: kid ?? "" };
}
