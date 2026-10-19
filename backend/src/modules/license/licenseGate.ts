/**
 * The request guard: module gate and read-only guard in one middleware (contract sections 6 and 7).
 *
 * Mounted FIRST on the v1 router (api/v1/index.ts), so it also covers the public e-signing routes and the
 * `/operations` and `/internal` routers, and in front of the TUS upload endpoint in app.ts. Because it runs
 * before authentication it never reads `req.user`: the licence state is installation-wide and public.
 *
 * Order: module gate first (a disabled module answers 403 LICENSE_MODULE_DISABLED for EVERY method, reads
 * included, so the UI can tell "not licensed" from "read-only"), then the read-only guard (state `expired`
 * only; POST/PUT/PATCH/DELETE refused with 403 LICENSE_EXPIRED unless allowlisted). Safe methods always pass
 * the read-only guard.
 *
 * `LICENSE_ENFORCEMENT=warn` evaluates everything and logs what it WOULD have refused, but refuses nothing.
 * `off`, `unconfigured` and `unknown` never refuse.
 */
import type { NextFunction, Request, Response } from "express";
import { config } from "../../config/env.js";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import {
  LICENSE_ERROR,
  LICENSE_EXPIRED_MESSAGE,
  MODULE_DISABLED_MESSAGE,
  type LicenseModuleKey,
} from "./license.constants.js";
import { getLicenseSnapshot, isModuleEnabled } from "./license.service.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ── read-only allowlist ────────────────────────────────────────────────────────────────────────────────────

export interface AllowEntry {
  /** HTTP method, or "*" for every method. */
  method: string;
  /** Matched against the path RELATIVE to the API base (e.g. /auth/login). */
  pattern: RegExp;
  why: string;
}

/**
 * Writes (or POSTs) that must keep working while the system is read-only. Every entry has a test in
 * tests/license.gate.test.ts. Anything not listed here is refused once the licence has expired.
 */
export const READ_ONLY_ALLOWLIST: readonly AllowEntry[] = [
  { method: "*", pattern: /^\/auth(\/|$)/, why: "sign-in, sign-out, refresh, tenant/role selection, 2FA, SSO callback, back-channel logout, JWKS refresh" },
  { method: "*", pattern: /^\/license(\/|$)/, why: "the status endpoint itself" },
  { method: "*", pattern: /^\/operations\/(health|ready)$/, why: "health and readiness probes (uptime monitor)" },
  { method: "POST", pattern: /^\/operations\/client-error$/, why: "browser error reporting must not be silenced by the very state it reports" },
  { method: "POST", pattern: /^\/internal\/roles\/tenants\/[^/]+\/role-mappings\/resolve$/, why: "SSO's role-mapping lookup at login (a query); the PUTs next to it stay blocked" },
  { method: "POST", pattern: /^\/letters\/preview-pdf$/, why: "renders a preview, writes nothing" },
  { method: "POST", pattern: /^\/forms\/templates\/preview$/, why: "renders a preview, writes nothing" },
  { method: "POST", pattern: /^\/ai\/chat$/, why: "read-only compliance-assistant query" },
];

export function isAllowlisted(method: string, relPath: string): boolean {
  const m = method.toUpperCase();
  return READ_ONLY_ALLOWLIST.some((e) => (e.method === "*" || e.method === m) && e.pattern.test(relPath));
}

// ── route group -> module ─────────────────────────────────────────────────────────────────────────────────

interface ModuleRoute {
  module: LicenseModuleKey;
  pattern: RegExp;
}

/**
 * Which route groups belong to which gateable module (contract section 7). Core groups (documents, folders,
 * versions, document-types, acl, access-rules, roles, users, org-units, departments, tenants, audit, auth,
 * comments, notifications, operations, feature-flags, status-permissions) are deliberately absent.
 *
 * Notes:
 *  - `/letters/verify` is the PUBLIC QR verification of an already-issued letter; it stays available.
 *  - `ocr` has no route group of its own (OCR runs through the outbox and the worker), so it gates nothing here.
 *  - `archive` is the document archive action; retention (disposal, cold restore) is the `retention` module.
 *  - Legacy and e-signing document actions (`/documents/:id/signing`, `/documents/:id/sign/*`) belong to `esigning`.
 */
export const MODULE_ROUTES: readonly ModuleRoute[] = [
  { module: "letters", pattern: /^\/letters(?!\/verify(\/|$))(\/|$)/ },
  { module: "workflow", pattern: /^\/(workflow|approvals)(\/|$)/ },
  { module: "esigning", pattern: /^\/signing(\/|$)/ },
  { module: "esigning", pattern: /^\/documents\/[^/]+\/(signing|sign)(\/|$)/ },
  { module: "legal_hold", pattern: /^\/legal-hold(\/|$)/ },
  { module: "retention", pattern: /^\/retention(\/|$)/ },
  { module: "ai", pattern: /^\/(ai|assignment-advisory)(\/|$)/ },
  { module: "search", pattern: /^\/search(\/|$)/ },
  { module: "archive", pattern: /^\/documents\/[^/]+\/archive(\/|$)/ },
  { module: "reports", pattern: /^\/reports(\/|$)/ },
  { module: "bundles", pattern: /^\/bundles(\/|$)/ },
  { module: "webhooks", pattern: /^\/webhooks(\/|$)/ },
  { module: "forms", pattern: /^\/forms(\/|$)/ },
];

export function moduleForPath(relPath: string): LicenseModuleKey | null {
  return MODULE_ROUTES.find((r) => r.pattern.test(relPath))?.module ?? null;
}

// ── the middleware ─────────────────────────────────────────────────────────────────────────────────────────

/** The request path relative to API_BASE_PATH, whether the middleware is mounted on the router or on the app. */
export function apiRelativePath(req: Pick<Request, "baseUrl" | "path">): string {
  const full = `${req.baseUrl ?? ""}${req.path}`;
  const base = config.API_BASE_PATH.replace(/\/+$/, "");
  const rel = base && full.startsWith(`${base}/`) ? full.slice(base.length) : full;
  return rel.length > 1 ? rel.replace(/\/+$/, "") : rel;
}

const warnedAt = new Map<string, number>();
function warnWouldBlock(key: string, detail: Record<string, unknown>): void {
  const now = Date.now();
  if ((warnedAt.get(key) ?? 0) > now - 60_000) return;
  warnedAt.set(key, now);
  logger.warn(detail, "licence (warn mode): this request would have been refused under LICENSE_ENFORCEMENT=enforce");
}

export function licenseGate(req: Request, _res: Response, next: NextFunction): void {
  try {
    const snapshot = getLicenseSnapshot();
    // unconfigured / unknown / off: nothing is ever refused (principles 1 and 2).
    if (snapshot.mode === "off" || snapshot.state === "unconfigured" || snapshot.state === "unknown") return next();

    const rel = apiRelativePath(req);
    const warnOnly = snapshot.mode === "warn";

    const moduleKey = moduleForPath(rel);
    if (moduleKey && !isModuleEnabled(moduleKey, snapshot)) {
      if (warnOnly) {
        warnWouldBlock(`module:${moduleKey}`, { module: moduleKey, path: rel });
      } else {
        return next(new AppError(403, LICENSE_ERROR.MODULE_DISABLED, MODULE_DISABLED_MESSAGE, { module: moduleKey }));
      }
    }

    if (snapshot.state === "expired" && !SAFE_METHODS.has(req.method.toUpperCase()) && !isAllowlisted(req.method, rel)) {
      if (warnOnly) {
        warnWouldBlock("read-only", { method: req.method, path: rel });
      } else {
        return next(new AppError(403, LICENSE_ERROR.EXPIRED, LICENSE_EXPIRED_MESSAGE));
      }
    }
    next();
  } catch (error) {
    // The guard must never take the API down: on any internal fault, fail OPEN (principle 2).
    logger.error({ error }, "licence: gate failed internally; request allowed");
    next();
  }
}
