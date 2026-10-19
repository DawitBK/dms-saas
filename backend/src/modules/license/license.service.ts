/**
 * Platform licensing, DMS consumer (docs/operations/PLATFORM-LICENSING.md, sections 4-6).
 *
 * What this file owns:
 *   - the held token (memory + a file, so a restart while SSO is down keeps enforcing it),
 *   - the fetcher/poller (API process only; the worker needs no enforcement),
 *   - the synchronous snapshot the request guard reads,
 *   - the answer behind GET /license/status.
 *
 * The two principles that must survive every future edit:
 *   1. NO RECORD = NO ENFORCEMENT. SSO answering 404 means `unconfigured`; this process never having obtained
 *      a verified token means `unknown`. Neither blocks anything.
 *   2. NEVER BLOCK BECAUSE SSO IS UNREACHABLE. A failed fetch (timeout, refused, 5xx, garbage, bad signature)
 *      changes nothing: the last verified token stays held and keeps being judged by ITS OWN dates. Only a
 *      verified, expired token can make the system read-only.
 * Nothing in here throws into request handling: refreshLicense() resolves with an outcome, never rejects.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { QueryTypes } from "sequelize";
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { sequelize } from "../../infrastructure/database/sequelize.js";
import { notPlatformAdminSql } from "../../shared/platformAdmin.js";
import {
  LICENSE_FETCH_TIMEOUT_MS,
  LICENSE_JWKS_TTL_MS,
  LICENSE_SSO_PUBLIC_PATH,
  LICENSE_SYSTEM,
} from "./license.constants.js";
import { computeLicenseState, type LicenseEvaluation, type LicenseState } from "./licenseState.js";
import { verifyLicenseToken, type LicenseClaims } from "./licenseToken.js";

export type LicenseSource = "sso" | "cache" | "none";
export type RefreshOutcome =
  | "updated" // a newer (or first) verified token is now held
  | "unchanged" // verified, same version
  | "ignored-older" // verified but older than the held one; ignored
  | "no-record" // SSO answered 404: unconfigured
  | "unreachable" // transport failure, timeout, non-2xx: nothing changed
  | "rejected" // answered but failed verification: nothing changed
  | "disabled"; // LICENSE_ENFORCEMENT=off

interface Held {
  token: string;
  claims: LicenseClaims;
  jwk: crypto.JsonWebKey;
  fetchedAt: Date;
  source: "sso" | "cache";
}

let held: Held | null = null;
/** SSO has answered 404 ("no licence record") and nothing since has contradicted it. */
let noRecord = false;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<RefreshOutcome> | null = null;

// ── configuration helpers (read at call time so tests and a restart-free env change behave) ──────────────

export const enforcementMode = (): "enforce" | "warn" | "off" => config.LICENSE_ENFORCEMENT;

export function licenseCachePath(): string {
  return config.LICENSE_CACHE_PATH
    ? path.resolve(config.LICENSE_CACHE_PATH)
    : path.resolve(process.cwd(), ".license", `${LICENSE_SYSTEM}-${config.NODE_ENV}.json`);
}

const licenseUrl = () => new URL(LICENSE_SSO_PUBLIC_PATH, config.LICENSE_SSO_URL).toString();
const jwksUrl = () => config.AUTH_JWKS_URI || new URL("/jwks", config.LICENSE_SSO_URL).toString();

// ── JWKS (SSO's own OIDC signing keys; the licence is signed with the same key) ───────────────────────────

interface JwksCache {
  keys: Map<string, { key: crypto.KeyObject; jwk: crypto.JsonWebKey }>;
  fetchedAt: number;
}
let jwksCache: JwksCache | null = null;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LICENSE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(t);
  }
}

async function loadJwks(): Promise<JwksCache> {
  const res = await fetchWithTimeout(jwksUrl());
  if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const keys: JwksCache["keys"] = new Map();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || (jwk.use !== undefined && jwk.use !== "sig")) continue;
    try {
      const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
      keys.set(typeof jwk.kid === "string" ? jwk.kid : "_default", { key, jwk: jwk as crypto.JsonWebKey });
    } catch {
      // a malformed JWK entry is skipped, as in auth.service.ts
    }
  }
  jwksCache = { keys, fetchedAt: Date.now() };
  return jwksCache;
}

async function lookupSigningKey(kid: string | undefined) {
  const id = kid ?? "_default";
  let cache = jwksCache && Date.now() - jwksCache.fetchedAt < LICENSE_JWKS_TTL_MS ? jwksCache : await loadJwks();
  let hit = cache.keys.get(id);
  if (!hit) {
    // key rotation: one forced refresh before giving up
    cache = await loadJwks();
    hit = cache.keys.get(id);
  }
  return hit ?? null;
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────────────────

function persist(h: Held): void {
  const file = licenseCachePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ token: h.token, jwk: h.jwk, savedAt: h.fetchedAt.toISOString() }), "utf-8");
    fs.renameSync(tmp, file);
  } catch (error) {
    logger.warn({ error, file }, "licence: could not persist the token (it is still held in memory)");
  }
}

function removePersisted(): void {
  try {
    fs.rmSync(licenseCachePath(), { force: true });
  } catch (error) {
    logger.warn({ error }, "licence: could not remove the persisted token");
  }
}

/**
 * Re-verify the persisted token against the PUBLIC KEY STORED WITH IT (the one that verified it when it was
 * fetched), so a restart while SSO is down still enforces the licence's own dates. A file that does not verify
 * (edited, corrupt, wrong environment) is ignored, never trusted.
 */
export async function loadPersistedLicense(): Promise<boolean> {
  const file = licenseCachePath();
  try {
    if (!fs.existsSync(file)) return false;
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as { token?: string; jwk?: crypto.JsonWebKey; savedAt?: string };
    if (!saved.token || !saved.jwk) return false;
    const key = crypto.createPublicKey({ key: saved.jwk, format: "jwk" });
    const result = await verifyLicenseToken(saved.token, { issuer: config.AUTH_ISSUER, resolveKey: () => key });
    if (!result.ok) {
      logger.warn({ reason: result.reason }, "licence: the persisted token did not verify; ignoring it");
      return false;
    }
    held = {
      token: saved.token,
      claims: result.claims,
      jwk: saved.jwk,
      fetchedAt: saved.savedAt ? new Date(saved.savedAt) : new Date(),
      source: "cache",
    };
    noRecord = false;
    return true;
  } catch (error) {
    logger.warn({ error }, "licence: could not read the persisted token; ignoring it");
    return false;
  }
}

// ── fetcher ───────────────────────────────────────────────────────────────────────────────────────────────

async function doRefresh(): Promise<RefreshOutcome> {
  if (enforcementMode() === "off") return "disabled";

  let res: Response;
  try {
    res = await fetchWithTimeout(licenseUrl());
  } catch (error) {
    logger.warn({ error: (error as Error)?.message }, "licence: SSO unreachable; keeping the last verified token");
    return "unreachable";
  }

  if (res.status === 404) {
    // No licence record for this system: nothing is enforced (principle 1). A previously held token is dropped
    // too: "revoke" in SSO deletes the record and returns the system to `unconfigured`.
    if (held) logger.info("licence: SSO reports no licence record any more; enforcement released");
    held = null;
    noRecord = true;
    removePersisted();
    return "no-record";
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "licence: SSO answered an error; keeping the last verified token");
    return "unreachable";
  }

  let token: unknown;
  try {
    token = ((await res.json()) as { token?: unknown })?.token;
  } catch {
    logger.warn("licence: SSO answered something that is not JSON; keeping the last verified token");
    return "rejected";
  }
  if (typeof token !== "string") {
    logger.warn("licence: SSO's answer has no token; keeping the last verified token");
    return "rejected";
  }

  try {
    let usedJwk: crypto.JsonWebKey | undefined;
    const result = await verifyLicenseToken(token, {
      issuer: config.AUTH_ISSUER,
      resolveKey: async (kid) => {
        const hit = await lookupSigningKey(kid);
        usedJwk = hit?.jwk;
        return hit?.key ?? null;
      },
    });
    if (!result.ok || !usedJwk) {
      logger.warn({ reason: result.ok ? "no key" : result.reason }, "licence: token rejected; keeping the last verified token");
      return "rejected";
    }
    if (held && result.claims.ver < held.claims.ver) return "ignored-older";

    const unchanged = held !== null && held.claims.ver === result.claims.ver && held.token === token;
    held = { token, claims: result.claims, jwk: usedJwk, fetchedAt: new Date(), source: "sso" };
    noRecord = false;
    persist(held);
    return unchanged ? "unchanged" : "updated";
  } catch (error) {
    // verification needed the JWKS and SSO would not give it: transport, not a verdict
    logger.warn({ error: (error as Error)?.message }, "licence: could not verify the token (JWKS unavailable); keeping the last verified token");
    return "unreachable";
  }
}

/** One fetch cycle. Never rejects; concurrent calls share one request. */
export function refreshLicense(): Promise<RefreshOutcome> {
  if (!inFlight) {
    inFlight = doRefresh()
      .catch((error): RefreshOutcome => {
        logger.error({ error }, "licence: unexpected failure in the fetcher (ignored)");
        return "unreachable";
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Boot: load the persisted token (fast, no network), then poll. Call from the API process only. */
export async function startLicensePolling(): Promise<void> {
  if (enforcementMode() === "off") {
    logger.info("licence: LICENSE_ENFORCEMENT=off, fetcher not started");
    return;
  }
  if (await loadPersistedLicense()) logger.info({ ver: held?.claims.ver }, "licence: loaded the persisted token");
  void refreshLicense();
  stopLicensePolling();
  timer = setInterval(() => void refreshLicense(), config.LICENSE_POLL_SECONDS * 1000);
  timer.unref();
  logger.info({ mode: enforcementMode(), everySeconds: config.LICENSE_POLL_SECONDS }, "licence: polling started");
}

export function stopLicensePolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── what the rest of DMS reads ────────────────────────────────────────────────────────────────────────────

export interface LicenseSnapshot extends LicenseEvaluation {
  mode: "enforce" | "warn" | "off";
  claims: LicenseClaims | null;
  source: LicenseSource;
  fetchedAt: Date | null;
}

/** Synchronous, allocation-light; safe to call on every request. */
export function getLicenseSnapshot(now: Date = new Date()): LicenseSnapshot {
  const mode = enforcementMode();
  if (mode === "off") {
    return { mode, state: "unknown", daysRemaining: null, graceEndsAt: null, claims: null, source: "none", fetchedAt: null };
  }
  const evaluation = computeLicenseState(
    held ? { expiresAt: held.claims.expiresAt, graceDays: held.claims.graceDays, warnDays: held.claims.warnDays } : null,
    now,
    noRecord ? "unconfigured" : "unknown",
  );
  return { mode, ...evaluation, claims: held?.claims ?? null, source: held ? held.source : "none", fetchedAt: held?.fetchedAt ?? null };
}

/** True when the licence is verified and the state means the system must be read-only. */
export function isReadOnly(snapshot: LicenseSnapshot = getLicenseSnapshot()): boolean {
  return snapshot.state === "expired" && snapshot.mode === "enforce";
}

/** Module gate verdict. `unconfigured` / `unknown` enable everything; `modules: null` enables everything. */
export function isModuleEnabled(moduleKey: string, snapshot: LicenseSnapshot = getLicenseSnapshot()): boolean {
  if (snapshot.state === "unconfigured" || snapshot.state === "unknown") return true;
  const modules = snapshot.claims?.modules ?? null;
  return modules === null || modules.includes(moduleKey);
}

// ── seats ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Active, non-deleted accounts across the whole installation, platform administrators excluded.
 *
 * Counts on a connection of its OWN (`transaction: null` opts out of the request's CLS transaction): the
 * request's tenant GUC would otherwise restrict `users` (RLS) to the current tenant's members, and the limit
 * is per installation. With the GUC unset the users policy lets every row through, which is exactly how the
 * pre-tenant login paths already read it.
 */
export async function countSeatsUsed(): Promise<number> {
  const rows = await sequelize.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u WHERE u.is_active = true AND u.deleted_at IS NULL AND ${notPlatformAdminSql("u.id")}`,
    { type: QueryTypes.SELECT, transaction: null },
  );
  return Number(rows[0]?.n ?? 0);
}

let seatCache: { n: number; at: number } | null = null;
const SEAT_CACHE_MS = 15_000;

/** For the status endpoint (polled by every open browser): cached briefly, null if the count itself failed. */
export async function seatsUsedCached(): Promise<number | null> {
  if (seatCache && Date.now() - seatCache.at < SEAT_CACHE_MS) return seatCache.n;
  try {
    const n = await countSeatsUsed();
    seatCache = { n, at: Date.now() };
    return n;
  } catch (error) {
    logger.warn({ error }, "licence: could not count seats for the status answer");
    return null;
  }
}

export function invalidateSeatCache(): void {
  seatCache = null;
}

// ── status (contract section 5) ───────────────────────────────────────────────────────────────────────────

export interface LicenseStatus {
  system: typeof LICENSE_SYSTEM;
  state: LicenseState;
  customer: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  daysRemaining: number | null;
  warnDays: number | null;
  graceDays: number | null;
  readOnly: boolean;
  maxUsers: number | null;
  seatsUsed: number | null;
  modules: string[] | null;
  source: LicenseSource;
  fetchedAt: string | null;
  version: number | null;
  /** Additive to the contract: lets the UI say "warning only" in `warn` mode. */
  enforcement: "enforce" | "warn" | "off";
}

export async function buildLicenseStatus(now: Date = new Date()): Promise<LicenseStatus> {
  const s = getLicenseSnapshot(now);
  const c = s.claims;
  return {
    system: LICENSE_SYSTEM,
    state: s.state,
    customer: c?.customer ?? null,
    expiresAt: c?.expiresAt ? c.expiresAt.toISOString() : null,
    graceEndsAt: s.graceEndsAt ? s.graceEndsAt.toISOString() : null,
    daysRemaining: s.daysRemaining,
    warnDays: c?.warnDays ?? null,
    graceDays: c?.graceDays ?? null,
    readOnly: isReadOnly(s),
    maxUsers: c?.maxUsers ?? null,
    seatsUsed: await seatsUsedCached(),
    modules: c?.modules ?? null,
    source: s.source,
    fetchedAt: s.fetchedAt ? s.fetchedAt.toISOString() : null,
    version: c?.ver ?? null,
    enforcement: s.mode,
  };
}

// ── test hooks (no production caller) ─────────────────────────────────────────────────────────────────────

/** Replace the held licence / SSO verdict directly. For tests only. */
export function __setLicenseForTesting(next: { claims: LicenseClaims | null; noRecord?: boolean; source?: "sso" | "cache" }): void {
  held = next.claims
    ? { token: "test", claims: next.claims, jwk: {}, fetchedAt: new Date(), source: next.source ?? "sso" }
    : null;
  noRecord = next.noRecord ?? false;
}

export function __resetLicenseForTesting(): void {
  held = null;
  noRecord = false;
  jwksCache = null;
  seatCache = null;
  inFlight = null;
  stopLicensePolling();
}
