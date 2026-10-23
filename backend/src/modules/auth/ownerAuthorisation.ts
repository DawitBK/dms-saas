/**
 * Owner authorisation tickets: server-side proof that an owner-only operation (today: creating a tenant) was
 * approved by the platform owner in SSO, not merely requested by whoever holds a platform-admin session.
 *
 * SSO issues the ticket (SSO console > Owner verification, after the owner's security questions, e-mail code and
 * authenticator). DMS only VERIFIES it. A ticket is a compact JWS signed with SSO's active OIDC signing key:
 *
 *   header  { alg: "RS256", typ: "kcms-owner-ticket+jwt", kid }
 *   claims  iss (SSO issuer), aud "dms", sub (the owner's SSO subject), jti (uuid), op (operation key, e.g.
 *           "dms.tenant.create"), iat, exp (lifetime <= 300 s), plus th / sid which DMS ignores.
 *   carried in the request header  X-Owner-Authorisation: <jwt>
 *
 * Keys come from the SAME JWKS fetch + cache the OIDC id_token verification uses (auth.service getJwksPems), so there
 * is one SSO key source in DMS, not two.
 *
 * Setting: OWNER_VERIFICATION_REQUIRED (config/env.ts). Default true in production and mirror, false in development
 * and tests. False = this middleware does nothing at all.
 *
 * Answers (error envelope as everywhere else, see shared/middleware.ts errorHandler):
 *   403 OWNER_AUTHORISATION_REQUIRED   header missing
 *   403 OWNER_AUTHORISATION_INVALID    present but unusable: malformed, bad signature, wrong typ/iss/aud/operation,
 *                                      expired, lifetime too long, not for this caller, or already used
 *   503 OWNER_AUTHORISATION_UNAVAILABLE SSO's keys cannot be fetched (fail closed: never allow)
 *
 * Single use: the jti is reserved when verification passes and kept until the ticket's own exp. If the request then
 * ends in an error status (validation 4xx, 5xx) the reservation is released, so a mistyped form does not burn the
 * owner's ticket; a request that succeeds keeps it consumed. The memory is PER PROCESS: a ticket could in principle be
 * replayed once against each additional API process (DMS runs one API process; the worker has no HTTP routes) and a
 * restart forgets it, which is bounded by the <= 5 minute lifetime.
 */
import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../../config/env.js";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { User } from "../../infrastructure/database/index.js";
import { getJwksPems } from "./auth.service.js";

export const OWNER_AUTHORISATION_HEADER = "X-Owner-Authorisation";
export const OWNER_TICKET_TYP = "kcms-owner-ticket+jwt";
export const OWNER_TICKET_AUDIENCE = "dms";
/** DMS refuses a ticket whose exp - iat exceeds this (SSO issues at most 300 s; 30 s of slack). */
export const OWNER_TICKET_MAX_LIFETIME_SEC = 330;
/** A ticket issued "in the future" by more than this is refused (clock skew allowance). */
const IAT_SKEW_SEC = 60;
/** Upper bound on remembered jtis. Tickets are minted by one human, so reaching it means abuse: refuse (fail closed). */
const MAX_REMEMBERED = 5_000;

export const OPERATION_TENANT_CREATE = "dms.tenant.create";

/** jti -> exp (seconds). Per process. */
const consumed = new Map<string, number>();

function pruneConsumed(nowSec: number) {
  for (const [jti, exp] of consumed) if (exp <= nowSec) consumed.delete(jti);
}

/** Test seam: forget every consumed ticket. */
export function __resetOwnerTicketsForTesting() {
  consumed.clear();
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function parseJson(segment: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Denial = { status: 403 | 503; code: string; reason: string };
const invalid = (reason: string): Denial => ({ status: 403, code: "OWNER_AUTHORISATION_INVALID", reason });

interface Verified {
  jti: string;
  exp: number;
  sub: string;
}

async function verifyTicket(token: string, operation: string, nowSec: number): Promise<Verified | Denial> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((s) => s.length === 0)) return invalid("not a compact JWS");
  const header = parseJson(parts[0]);
  if (!header) return invalid("header is not JSON");
  if (header.alg !== "RS256") return invalid("alg is not RS256");
  if (header.typ !== OWNER_TICKET_TYP) return invalid("typ is not an owner ticket");
  const kid = typeof header.kid === "string" && header.kid ? header.kid : "_default";

  // SSO's keys: same cache as id_token verification; one forced refresh for an unknown kid (rotation).
  let pems: Record<string, string>;
  try {
    pems = await getJwksPems();
    if (!pems[kid]) pems = await getJwksPems(true);
  } catch {
    return { status: 503, code: "OWNER_AUTHORISATION_UNAVAILABLE", reason: "SSO signing keys unavailable" };
  }
  const pem = pems[kid];
  if (!pem) return invalid("no signing key for kid");

  let signatureOk = false;
  try {
    signatureOk = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), pem, Buffer.from(parts[2], "base64url"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return invalid("signature does not verify");

  const p = parseJson(parts[1]);
  if (!p) return invalid("payload is not JSON");
  if (!config.AUTH_ISSUER) return { status: 503, code: "OWNER_AUTHORISATION_UNAVAILABLE", reason: "AUTH_ISSUER not configured" };
  if (typeof p.iss !== "string" || !sameIssuer(p.iss, config.AUTH_ISSUER)) return invalid("iss does not match");
  if (p.aud !== OWNER_TICKET_AUDIENCE) return invalid("aud is not dms");
  if (p.op !== operation) return invalid("ticket is for a different operation");
  if (typeof p.jti !== "string" || p.jti.length === 0 || p.jti.length > 128) return invalid("jti missing");
  if (typeof p.sub !== "string" || p.sub.length === 0) return invalid("sub missing");
  if (typeof p.exp !== "number" || typeof p.iat !== "number" || !Number.isFinite(p.exp) || !Number.isFinite(p.iat)) {
    return invalid("exp or iat missing");
  }
  if (p.exp <= nowSec) return invalid("ticket expired");
  if (p.exp - p.iat > OWNER_TICKET_MAX_LIFETIME_SEC) return invalid("lifetime too long");
  if (p.iat > nowSec + IAT_SKEW_SEC) return invalid("issued in the future");
  return { jti: p.jti, exp: p.exp, sub: p.sub };
}

function deny(req: Request, operation: string, denial: Denial, callerId: string | undefined): AppError {
  logger.warn(
    { operation, outcome: denial.code, reason: denial.reason, callerId: callerId ?? null, ip: req.ip },
    "owner authorisation refused",
  );
  const message =
    denial.code === "OWNER_AUTHORISATION_REQUIRED"
      ? "This action needs owner verification. Get an owner authorisation ticket in SSO (Owner verification) and send it with the request."
      : denial.code === "OWNER_AUTHORISATION_UNAVAILABLE"
        ? "Owner verification cannot be checked right now because the sign-in service is not reachable. Try again shortly."
        : "The owner authorisation ticket is not valid for this action. It may have expired, been used already or been issued for something else. Get a new one in SSO (Owner verification).";
  return new AppError(denial.status, denial.code, message);
}

/**
 * Guard for one owner-only operation. Mount it AFTER authentication and the permission check, BEFORE the handler:
 *   router.post("/", requirePermission(...), requireOwnerAuthorisation("dms.tenant.create"), handler)
 */
export function requireOwnerAuthorisation(operation: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config.OWNER_VERIFICATION_REQUIRED) return next();
    const callerId = req.user?.userId;
    try {
      const raw = req.header(OWNER_AUTHORISATION_HEADER);
      const token = typeof raw === "string" ? raw.trim() : "";
      if (!token) {
        throw deny(req, operation, { status: 403, code: "OWNER_AUTHORISATION_REQUIRED", reason: "header missing" }, callerId);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const result = await verifyTicket(token, operation, nowSec);
      if ("code" in result) throw deny(req, operation, result, callerId);

      // The ticket must be for THIS caller when DMS knows the caller's SSO subject. An account that was never linked
      // to an SSO subject (no external_sub) cannot be compared; the ticket itself, which only the owner can mint in
      // SSO, is then the proof (logged so it is visible).
      const caller = callerId ? await User.findByPk(callerId, { attributes: ["id", "externalSub"] }) : null;
      if (caller?.externalSub) {
        if (caller.externalSub !== result.sub) throw deny(req, operation, invalid("ticket belongs to a different account"), callerId);
      } else {
        logger.info({ operation, callerId: callerId ?? null }, "owner ticket accepted without a subject comparison (account has no SSO link)");
      }

      pruneConsumed(nowSec);
      if (consumed.has(result.jti)) throw deny(req, operation, invalid("ticket already used"), callerId);
      if (consumed.size >= MAX_REMEMBERED) {
        throw deny(req, operation, { status: 503, code: "OWNER_AUTHORISATION_UNAVAILABLE", reason: "too many consumed tickets" }, callerId);
      }
      consumed.set(result.jti, result.exp);
      // A request that does not succeed gives the ticket back (a mistyped form must not burn it).
      const release = () => {
        if (res.statusCode >= 400) consumed.delete(result.jti);
      };
      res.once("finish", release);
      res.once("close", () => {
        if (!res.writableFinished) consumed.delete(result.jti);
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
