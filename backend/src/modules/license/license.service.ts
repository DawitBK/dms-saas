/**
 * Platform licensing, DMS consumer (docs/operations/PLATFORM-LICENSING.md, sections 4-6).
 *
 * What this file owns:
 *   - the held token (memory + a file, so a restart while SSO is down keeps enforcing it),
 *   - the fetcher/poller (API process only; the worker needs no enforcement),
 *   - the install path (POST /license/install: a token handed over by an operator, verified like a fetched one),
 *   - which keys may sign (SSO's JWKS, or the pinned LICENSE_TRUST_PUBLIC_KEYS: contract section 9),
 *   - the synchronous snapshot the request guard reads (state plus per-application entitlement),
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
import { computeEntitlement, type DeploymentMode, type EntitlementReason } from "./licenseEntitlement.js";
import { computeLicenseState, type LicenseEvaluation, type LicenseState } from "./licenseState.js";
import { verifyLicenseToken, type LicenseClaims } from "./licenseToken.js";

export type LicenseSource = "sso" | "cache" | "none";
export type RefreshOutcome =
  | "updated" // a newer (or first) verified token is now held
  | "unchanged" // verified, same version
  | "ignored-older" // verified but older than the held one; ignored
  | "no-record" // SSO answered 404: no record (a token SSO had served is dropped)
  | "unreachable" // transport failure, timeout, non-2xx: nothing changed
  | "rejected" // answered but failed verification: nothing changed
  | "disabled"; // LICENSE_ENFORCEMENT=off

interface Held {
  token: string;
  claims: LicenseClaims;
  jwk: crypto.JsonWebKey;
  fetchedAt: Date;
  source: "sso" | "cache";
  /**
   * Where this token came from: "sso" = SSO has served it (so an SSO 404 later means "revoked"), "install" = an
   * operator posted it to /license/install and SSO has never served it (an SSO 404 says nothing about it).
   */
  origin: "sso" | "install";
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

/** "production" or "mirror": the two NODE_ENVs that run real (or production-parity) installations. */
const isProductionLike = () => config.NODE_ENV === "production" || config.NODE_ENV === "mirror";

/**
 * Deployment mode (contract section 9), computed from this process's own SSO configuration and never taken from a
 * client: `sso` when the OIDC sign-in is fully configured (the same four settings completeOidcCallback needs),
 * otherwise `standalone`. LOCAL_JWT_MOCK is deliberately NOT consulted: it is a dev/test sign-in shortcut, and a
 * production process with it left on must not count as an SSO deployment.
 */
export function deploymentMode(): DeploymentMode {
  return config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET && config.OIDC_REDIRECT_URI && config.AUTH_ISSUER ? "sso" : "standalone";
}

// ── pinned trust (LICENSE_TRUST_PUBLIC_KEYS) ─────────────────────────────────────────────────────────────────

interface PinnedKey {
  key: crypto.KeyObject;
  jwk: crypto.JsonWebKey;
}
let pinnedMemo: { raw: string | undefined; keys: PinnedKey[]; error: string | null } | null = null;

/** The pinned public keys (parsed once per distinct value), and why the value is unusable if it is. */
export function trustedKeys(): { keys: PinnedKey[]; error: string | null } {
  const raw = config.LICENSE_TRUST_PUBLIC_KEYS;
  if (pinnedMemo && pinnedMemo.raw === raw) return pinnedMemo;
  const keys: PinnedKey[] = [];
  let error: string | null = null;
  if (raw) {
    try {
      const list: unknown = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error("not a JSON array");
      let skipped = 0;
      for (const jwk of list as Array<Record<string, unknown>>) {
        try {
          if (!jwk || jwk.kty !== "RSA" || jwk.d !== undefined) throw new Error("not a public RSA JWK");
          keys.push({ key: crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" }), jwk: jwk as crypto.JsonWebKey });
        } catch {
          skipped++;
        }
      }
      if (skipped > 0) error = `${skipped} entr${skipped === 1 ? "y is" : "ies are"} not a public RSA JWK`;
    } catch (e) {
      error = `not valid JSON: ${(e as Error).message}`;
    }
  }
  pinnedMemo = { raw, keys, error };
  return pinnedMemo;
}

/**
 * Who may sign a licence. Required: ONLY the pinned keys, SSO's JWKS is never consulted. Not required: the pinned
 * keys when any are configured, otherwise SSO's JWKS (today's behaviour).
 */
const usesPinnedKeys = () => config.LICENSE_REQUIRED || trustedKeys().keys.length > 0;

function peekKid(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf-8")) as { kid?: unknown };
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

type Verified = { ok: true; claims: LicenseClaims; jwk: crypto.JsonWebKey } | { ok: false; reason: string; transport: boolean };

/** Verify against the pinned keys only (offline). `iss` is not compared: an offline-signed token has no SSO to match. */
async function verifyPinned(token: string): Promise<Verified> {
  const kid = peekKid(token);
  const candidates = trustedKeys().keys.filter((k) => !kid || !k.jwk.kid || k.jwk.kid === kid);
  if (candidates.length === 0) return { ok: false, reason: "no trusted licence key is configured for this token", transport: false };
  let reason = "signature does not verify";
  for (const c of candidates) {
    const result = await verifyLicenseToken(token, { resolveKey: () => c.key });
    if (result.ok) return { ok: true, claims: result.claims, jwk: c.jwk };
    reason = result.reason;
  }
  return { ok: false, reason, transport: false };
}

/** Verify a token the way the current trust mode demands. `transport: true` = the JWKS was unreachable (no verdict). */
async function verifyToken(token: string): Promise<Verified> {
  if (usesPinnedKeys()) return verifyPinned(token);
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
    if (!result.ok || !usedJwk) return { ok: false, reason: result.ok ? "no key" : result.reason, transport: false };
    return { ok: true, claims: result.claims, jwk: usedJwk };
  } catch (error) {
    return { ok: false, reason: (error as Error)?.message ?? "JWKS unavailable", transport: true };
  }
}

// ── JWKS (SSO's own OIDC signing keys; used for licences only when no key is pinned and the licence is not required) ──

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
    fs.writeFileSync(tmp, JSON.stringify({ token: h.token, jwk: h.jwk, savedAt: h.fetchedAt.toISOString(), origin: h.origin }), "utf-8");
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
    const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      token?: string;
      jwk?: crypto.JsonWebKey;
      savedAt?: string;
      origin?: string;
    };
    if (!saved.token || !saved.jwk) return false;
    // Pinned trust (required, or keys configured): the pinned keys decide, NOT the key stored beside the token, so a
    // file someone planted with its own key and token is never believed. Otherwise the stored key re-verifies it offline.
    let claims: LicenseClaims;
    let jwk: crypto.JsonWebKey;
    if (usesPinnedKeys()) {
      const verified = await verifyPinned(saved.token);
      if (!verified.ok) {
        logger.warn({ reason: verified.reason }, "licence: the persisted token did not verify against the trusted keys; ignoring it");
        return false;
      }
      ({ claims, jwk } = verified);
    } else {
      const key = crypto.createPublicKey({ key: saved.jwk, format: "jwk" });
      const result = await verifyLicenseToken(saved.token, { issuer: config.AUTH_ISSUER, resolveKey: () => key });
      if (!result.ok) {
        logger.warn({ reason: result.reason }, "licence: the persisted token did not verify; ignoring it");
        return false;
      }
      claims = result.claims;
      jwk = saved.jwk;
    }
    held = {
      token: saved.token,
      claims,
      jwk,
      fetchedAt: saved.savedAt ? new Date(saved.savedAt) : new Date(),
      source: "cache",
      origin: saved.origin === "install" ? "install" : "sso",
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
    // A token an operator installed and SSO has never served says nothing about SSO's records (offline signing:
    // SSO may never have heard of it), so a 404 must not take it away.
    if (held?.origin === "install") {
      logger.info("licence: SSO has no record, but the held token was installed directly; keeping it");
      return "no-record";
    }
    // SSO deleted the record ("revoke"): drop the token it had served. Not required (principle 1): the system
    // returns to `unconfigured` and nothing is enforced. Required (contract section 9): it returns to NO_LICENSE
    // and the entitlement guard refuses all but sign-in, health and the licence routes. Either way the data stays
    // untouched. A 404 when nothing was held changes nothing.
    if (held) {
      logger.warn(
        { required: config.LICENSE_REQUIRED },
        config.LICENSE_REQUIRED
          ? "licence: SSO reports no licence record any more; the stored token is dropped and the system is unlicensed"
          : "licence: SSO reports no licence record any more; enforcement released",
      );
    }
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

  return acceptToken(token, "sso");
}

type AcceptOutcome = "updated" | "unchanged" | "ignored-older" | "rejected" | "unreachable";

/**
 * The ONE place a token becomes the held one, whether SSO served it or an operator installed it: verified against
 * whichever keys the trust mode allows, never lowers the held `ver`, persisted so it survives a restart. Never
 * throws. `unreachable` = verification needed SSO's JWKS and it would not answer (transport, not a verdict).
 */
async function acceptToken(token: string, origin: "sso" | "install"): Promise<AcceptOutcome> {
  const verified = await verifyToken(token);
  if (!verified.ok) {
    if (verified.transport) {
      logger.warn({ error: verified.reason }, "licence: could not verify the token (JWKS unavailable); keeping the last verified token");
      return "unreachable";
    }
    logger.warn({ reason: verified.reason, origin }, "licence: token rejected; keeping the last verified token");
    return "rejected";
  }
  if (held && verified.claims.ver < held.claims.ver) return "ignored-older";

  const unchanged = held !== null && held.claims.ver === verified.claims.ver && held.token === token;
  held = {
    token,
    claims: verified.claims,
    jwk: verified.jwk,
    fetchedAt: new Date(),
    // An installed token is a stored one, not one fetched just now: report it as the cache (the contract's status shape).
    source: origin === "sso" ? "sso" : "cache",
    // Once SSO has served a token it knows it, whoever delivered it first.
    origin: origin === "sso" || (unchanged && held?.origin === "sso") ? "sso" : "install",
  };
  noRecord = false;
  persist(held);
  if (origin === "install") {
    logger.info({ ver: held.claims.ver, jti: held.claims.jti, customer: held.claims.customer, modes: held.claims.modes }, "licence: a token was installed");
  }
  return unchanged ? "unchanged" : "updated";
}

export type InstallOutcome = "updated" | "unchanged" | "ignored-older" | "rejected" | "unavailable";

/**
 * POST /license/install: verify exactly like a fetched token (against the trusted keys; aud and sys must still be
 * ours), hold it and persist it. Never lowers the stored ver. Works whatever LICENSE_ENFORCEMENT says (the token is
 * stored even while the guard is switched off). Never throws.
 */
export async function installLicense(token: string): Promise<{ outcome: InstallOutcome }> {
  try {
    const outcome = await acceptToken(token, "install");
    return { outcome: outcome === "unreachable" ? "unavailable" : outcome };
  } catch (error) {
    logger.error({ error }, "licence: unexpected failure while installing a token");
    return { outcome: "unavailable" };
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

/**
 * Boot-time report of the entitlement configuration, at every start. Anything that weakens the guard in a process
 * that holds real data is an ERROR, not a warning: it has to be visible the day someone asks why a licence is not
 * being honoured.
 */
export function logLicenseStartupChecks(): void {
  const required = config.LICENSE_REQUIRED;
  const pinned = trustedKeys();
  if (!required && isProductionLike()) {
    logger.error({ nodeEnv: config.NODE_ENV }, "licence: LICENSE_REQUIRED=false in a production process: this system runs WITHOUT needing a licence. Remove it (or set it to true) in the env file.");
  }
  if (required && config.LICENSE_ENFORCEMENT !== "enforce") {
    logger.error(
      { enforcement: config.LICENSE_ENFORCEMENT },
      "licence: LICENSE_REQUIRED is true but LICENSE_ENFORCEMENT is not 'enforce': the licence is NOT being enforced (emergency brake). Set LICENSE_ENFORCEMENT=enforce.",
    );
  }
  if (pinned.error) {
    logger.error({ detail: pinned.error }, "licence: LICENSE_TRUST_PUBLIC_KEYS is unusable (expected a JSON array of public RSA JWKs)");
  }
  if (required && pinned.keys.length === 0) {
    logger.error("licence: LICENSE_REQUIRED is true and no usable LICENSE_TRUST_PUBLIC_KEYS is configured: no licence token can verify, so every request except sign-in, health and the licence routes is refused");
  }
  logger.info({ required, deployment: deploymentMode(), pinnedKeys: pinned.keys.length, enforcement: config.LICENSE_ENFORCEMENT }, "licence: entitlement configuration");
}

/** Boot: load the persisted token (fast, no network), then poll. Call from the API process only. */
export async function startLicensePolling(): Promise<void> {
  logLicenseStartupChecks();
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
  /** config.LICENSE_REQUIRED */
  required: boolean;
  /** Entitlement (contract section 9): always true when not required. */
  licensed: boolean;
  reason: EntitlementReason | null;
  deployment: DeploymentMode;
  claims: LicenseClaims | null;
  source: LicenseSource;
  fetchedAt: Date | null;
}

/** Synchronous, allocation-light; safe to call on every request. */
export function getLicenseSnapshot(now: Date = new Date()): LicenseSnapshot {
  const mode = enforcementMode();
  const required = config.LICENSE_REQUIRED;
  const deployment = deploymentMode();
  if (mode === "off") {
    const e = computeEntitlement({ required, state: "unknown", modes: null, deployment });
    return { mode, required, ...e, deployment, state: "unknown", daysRemaining: null, graceEndsAt: null, claims: null, source: "none", fetchedAt: null };
  }
  const evaluation = computeLicenseState(
    held ? { expiresAt: held.claims.expiresAt, graceDays: held.claims.graceDays, warnDays: held.claims.warnDays } : null,
    now,
    noRecord ? "unconfigured" : "unknown",
  );
  const e = computeEntitlement({ required, state: evaluation.state, modes: held?.claims.modes ?? null, deployment });
  return {
    mode,
    required,
    ...e,
    deployment,
    ...evaluation,
    claims: held?.claims ?? null,
    source: held ? held.source : "none",
    fetchedAt: held?.fetchedAt ?? null,
  };
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
  /** Contract section 9: LICENSE_REQUIRED, the entitlement verdict, why not, and this process's deployment mode. */
  required: boolean;
  licensed: boolean;
  reason: EntitlementReason | null;
  deployment: DeploymentMode;
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
    required: s.required,
    licensed: s.licensed,
    reason: s.reason,
    deployment: s.deployment,
  };
}

// ── test hooks (no production caller) ─────────────────────────────────────────────────────────────────────

/** Replace the held licence / SSO verdict directly. For tests only. */
export function __setLicenseForTesting(next: {
  claims: LicenseClaims | null;
  noRecord?: boolean;
  source?: "sso" | "cache";
  origin?: "sso" | "install";
}): void {
  held = next.claims
    ? { token: "test", claims: next.claims, jwk: {}, fetchedAt: new Date(), source: next.source ?? "sso", origin: next.origin ?? "sso" }
    : null;
  noRecord = next.noRecord ?? false;
}

export function __resetLicenseForTesting(): void {
  held = null;
  noRecord = false;
  jwksCache = null;
  pinnedMemo = null;
  seatCache = null;
  inFlight = null;
  stopLicensePolling();
}
