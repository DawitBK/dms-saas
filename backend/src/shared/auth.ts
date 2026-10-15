/**
 * DMS Authentication Middleware
 *
 * Verification flow:
 *   1. Extract Bearer token from Authorization header
 *   2. If LOCAL_JWT_MOCK=true (dev only) AND DEV_RSA_PUBLIC_KEY is set:
 *        → verify with the local RSA public key (no JWKS roundtrip)
 *   3. Else if DEV_RSA_PUBLIC_KEY is set and AUTH_JWKS_URI is not:
 *        → verify with the shared public key PEM
 *   4. Else: fetch signing key from AUTH_JWKS_URI (JWKS rotation supported)
 *   5. Verify RS256 signature, iss, aud, exp
 *   6. Extract user_id → req.user.userId, role → req.user.role,
 *      tenant_id → req.user.tenantId
 *
 * LOCAL_JWT_MOCK defaults to false; assertProductionRuntimeRequirements() used
 * to hard-refuse boot if it was true in production/mirror. That refusal was
 * removed 2026-07-31 (explicit user decision) so the seeded demo accounts can
 * sign in passwordlessly on the production box — see the comment on that
 * check in config/env.ts for the tradeoff, and getPublicKey() below for how
 * mock tokens (kid 'dev-key') verify without weakening real SSO tokens.
 *
 * requirePermission(permission) checks ROLE_PERMISSIONS[req.user.role].includes(permission).
 * The role is an identity label — never check it directly for authorization.
 * Unknown roles resolve to zero permissions (safe default-deny).
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { config } from '../config/env.js';
import { AppError } from '../core/AppError.js';
import { writeAuditLog } from '../modules/audit/audit.service.js';
import { AUDIT_EVENTS } from '../modules/audit/auditEvents.js';
import { type Permission } from '../config/permissions.js';
import { resolveUnionPermissions } from '../modules/roles/roles.service.js';
import { getCacheRedis } from '../infrastructure/cache/redis.js';
import { UserSessionCutoff } from '../infrastructure/database/index.js';
import type { Transaction } from 'sequelize';
import { logger } from '../core/logger.js';

/** Redis key holding the cached cutoff for a user. */
function userCutoffKey(userId: string): string {
  return `dms:auth:revoked_user:${userId}`;
}

/**
 * Cache lifetime for a cutoff lookup. Deliberately SHORT.
 *
 * This used to be 172_800s (2 days) because Redis was the record of truth and
 * the value had to outlive every token. Postgres is the record now (R-04), so
 * this is purely a hot-path cache, and its TTL is the worst-case window in
 * which a revocation could go unnoticed if the cache write below failed. Short
 * TTL, small window; the per-request Postgres load is still ~nil because a
 * user makes many requests inside 30s.
 */
const CUTOFF_CACHE_TTL_SEC = 30;

/** Cached sentinel for "this user has no cutoff". Without negative caching,
 *  every authenticated request by the overwhelming majority of users (who
 *  have never been revoked) would fall through to Postgres. */
const CUTOFF_NONE = 'none';

/**
 * Immediately invalidate every outstanding access AND refresh token for a
 * user, by recording a cutoff of "now". `authenticate` (below) and
 * POST /auth/refresh both reject any token whose `iat <= cutoff`, so the user
 * must re-authenticate — at which point deactivation / role changes take
 * effect.
 *
 * Call this on deactivation, soft-delete, force-logout, and any role or
 * permission change. Without it a terminated employee's token keeps working
 * until natural expiry (finding C5) and a demoted user keeps stale
 * permissions (finding H9).
 *
 * R-04 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): the cutoff used to live ONLY in Redis,
 * which made this function's contract impossible to honour consistently. It
 * was documented to fail CLOSED in production — "if the cutoff cannot be
 * persisted, the revocation is a lie, so we throw" — but three call sites had
 * to wrap it in `.catch(logger.warn)` because by the time they call it their
 * permission change has ALREADY committed, so throwing would 500 on a change
 * that did apply. Net effect: deactivating a user failed closed while
 * demoting one failed open, and a Redis flush silently un-revoked everyone.
 *
 * Postgres is the record of truth now, so pass the `transaction` that carries
 * the domain change and the cutoff commits atomically with it — the ordering
 * problem that forced those `.catch()` calls simply does not arise. Redis is
 * a read-through cache; a cache write failure can no longer make the
 * revocation a lie, so it is logged and tolerated rather than thrown.
 */
export async function revokeAllUserSessions(
  userId: string,
  opts: { transaction?: Transaction; reason?: string } = {},
): Promise<void> {
  const cutoffAt = new Date();

  // Durable and, when a transaction is supplied, atomic with the change that
  // prompted it. A failure here genuinely means the revocation did not
  // happen, so it propagates — and rolls the domain change back with it.
  await UserSessionCutoff.upsert(
    { userId, cutoffAt, reason: opts.reason ?? null, updatedAt: cutoffAt },
    { transaction: opts.transaction },
  );

  // Everything below is a SIDE EFFECT of the revocation, not part of it: the
  // Postgres row above is the authority. Both must therefore happen only if
  // that row actually survives — which, inside a caller-supplied transaction,
  // is not known yet.
  //
  // FIX (2026-09-03): they used to run inline, and a rolled-back permission
  // change left a REAL revocation behind. The Postgres row vanished with the
  // rollback (correctly — that is what makes revocation atomic with the change
  // that caused it), but the Redis write did not, so getUserRevocationCutoff
  // read the cached cutoff and reported the user revoked for up to
  // CUTOFF_CACHE_TTL_SEC. A permission change that FAILED still logged the
  // user out, and killed their socket on the way. Caught by
  // test-scripts/verify-session-revocation.ts's atomicity case, which had been
  // passing only because Redis was unreachable in dev (see MINIO_ENDPOINT in
  // .env.example for why) and the cache path was never exercised.
  //
  // afterCommit is the pattern DMS's CLAUDE.md prescribes for exactly this —
  // cache invalidation that must not observe an uncommitted write. Note the
  // transaction here is usually the ambient per-request one, so "after commit"
  // means at response-flush time, not when this function returns.
  const applySideEffects = async () => {
    // Drop any LIVE realtime socket this user holds.
    //
    // The cutoff stops every future HTTP request and every future socket
    // handshake, but a socket that is already open was authenticated once, at
    // connect — so without this a demoted or deactivated user kept a working
    // event feed on their old rooms until they happened to reconnect, which
    // for an idle browser tab can be hours. Reaches sockets on every API
    // process when the Redis adapter is attached.
    //
    // Dynamically imported to avoid a static import cycle: the socket module
    // imports verifyAccessToken and getUserRevocationCutoff from this one.
    try {
      const { disconnectUserSockets } = await import('../infrastructure/websocket/socket.js');
      await disconnectUserSockets(userId);
    } catch (error) {
      logger.warn(
        { userId, error },
        'Failed to disconnect live sockets on revocation; the durable cutoff still bars every new request and handshake',
      );
    }

    // Refresh the cache so the revocation takes effect immediately rather than
    // at the end of any currently-cached window. Overwriting also clears a
    // cached CUTOFF_NONE sentinel. Best-effort by design: if this fails, reads
    // fall through to Postgres within CUTOFF_CACHE_TTL_SEC at the latest.
    const redis = getCacheRedis();
    if (!redis) {
      logger.warn(
        { userId },
        'Redis unavailable while revoking sessions; cutoff is persisted in Postgres and will be read from there',
      );
      return;
    }
    try {
      await redis.set(
        userCutoffKey(userId),
        String(Math.floor(cutoffAt.getTime() / 1000)),
        'EX',
        CUTOFF_CACHE_TTL_SEC,
      );
    } catch (error) {
      logger.warn(
        { userId, error },
        'Failed to cache the revocation cutoff; it is persisted in Postgres and reads will pick it up',
      );
    }
  };

  if (opts.transaction) {
    // Never awaited and never allowed to throw: by the time this runs the
    // transaction has committed, so the revocation has already happened and
    // nothing here can or should undo it.
    opts.transaction.afterCommit(() => {
      void applySideEffects().catch((error) =>
        logger.warn({ userId, error }, 'Revocation side effects failed after commit'),
      );
    });
    return;
  }

  await applySideEffects();
}

/**
 * The user's revocation cutoff in epoch seconds, or null if they have none.
 * Redis first, Postgres as the authority behind it.
 */
export async function getUserRevocationCutoff(userId: string): Promise<number | null> {
  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(userCutoffKey(userId));
      if (cached !== null) return cached === CUTOFF_NONE ? null : Number(cached);
    } catch (error) {
      // Not fatal any more: Postgres below is the record of truth, so a Redis
      // outage costs a query per request rather than the ability to
      // authenticate at all.
      logger.warn({ userId, error }, 'Revocation-cutoff cache read failed; falling through to Postgres');
    }
  }

  let seconds: number | null;
  try {
    const row = await UserSessionCutoff.findByPk(userId, { attributes: ['cutoffAt'] });
    seconds = row ? Math.floor(new Date(row.cutoffAt).getTime() / 1000) : null;
  } catch (error) {
    // The authoritative read itself failed. Every authenticated request needs
    // Postgres anyway (tenantContext opens a transaction per request), so this
    // is normally a symptom of a wider outage rather than a revocation
    // problem. Keep exactly the enforcement posture this check has always
    // had: refuse where revocation is enforced, because we cannot prove the
    // session is still valid; fail open elsewhere, as the Redis-only version
    // did, so a dev/test environment without a database still authenticates.
    logger.error({ userId, error }, 'Revocation-cutoff lookup failed');
    if (revocationEnforced()) {
      throw new AppError(503, 'ERR-AUTH-REVOCATION-UNAVAILABLE', 'Authentication is temporarily unavailable');
    }
    return null;
  }

  if (redis) {
    try {
      await redis.set(
        userCutoffKey(userId),
        seconds === null ? CUTOFF_NONE : String(seconds),
        'EX',
        CUTOFF_CACHE_TTL_SEC,
      );
    } catch {
      // Caching is an optimisation; the answer above is already correct.
    }
  }
  return seconds;
}

/**
 * True where a missing/failing revocation store must reject the request rather
 * than fail open. Production AND mirror both enforce it, so a `NODE_ENV` that
 * is mistakenly left at "mirror" cannot silently disable token revocation.
 */
export function revocationEnforced(): boolean {
  return config.NODE_ENV === 'production' || config.NODE_ENV === 'mirror';
}

// --- MFA/TOTP brute-force protection (S19 audit finding 4.1 / 4.2) ----------
// A 6-digit TOTP has only 1e6 codes and each is valid for a ~90 s window, so an
// unthrottled verify endpoint is brute-forceable. We track consecutive failures
// per account in Redis and lock further attempts once the ceiling is hit; a
// successful verify clears the counter. Single-use of the MFA-pending token is
// enforced separately so a captured (token, code) pair cannot be replayed.
const MFA_MAX_ATTEMPTS = 5;
const MFA_ATTEMPT_WINDOW_SEC = 300; // 5 min — matches the pending-token lifetime
const MFA_LOCK_SEC = 900; // 15 min lockout once the ceiling is hit

/**
 * Throw 429 if the account has too many recent failed TOTP attempts. Fails
 * CLOSED where revocation is enforced (prod/mirror): if we cannot consult the
 * store, we cannot prove the account isn't under attack, so we refuse.
 */
export async function assertMfaAttemptsAllowed(userId: string): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) {
    if (revocationEnforced()) {
      throw new AppError(503, 'ERR-MFA-THROTTLE-UNAVAILABLE', 'Cannot verify MFA right now (throttle store unavailable)');
    }
    return; // dev fail-open
  }
  let count = 0;
  try {
    count = Number((await redis.get(`dms:auth:mfa_fail:${userId}`)) ?? 0);
  } catch (error) {
    if (revocationEnforced()) {
      logger.error({ userId, error }, 'MFA throttle lookup failed; rejecting');
      throw new AppError(503, 'ERR-MFA-THROTTLE-UNAVAILABLE', 'Cannot verify MFA right now');
    }
    return;
  }
  if (count >= MFA_MAX_ATTEMPTS) {
    throw new AppError(429, 'ERR-MFA-LOCKED', 'Too many failed codes. Try again later.');
  }
}

/** Record one failed TOTP attempt; on reaching the ceiling, extend the lock. */
export async function recordMfaFailure(userId: string): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) return;
  try {
    const key = `dms:auth:mfa_fail:${userId}`;
    const count = await redis.incr(key);
    // First failure starts the window; the ceiling extends it to a full lockout.
    await redis.expire(key, count >= MFA_MAX_ATTEMPTS ? MFA_LOCK_SEC : MFA_ATTEMPT_WINDOW_SEC);
  } catch (error) {
    logger.warn({ userId, error }, 'Could not record MFA failure');
  }
}

/** Clear the failure counter after a successful TOTP verification. */
export async function clearMfaFailures(userId: string): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) return;
  try {
    await redis.del(`dms:auth:mfa_fail:${userId}`);
  } catch {
    /* best-effort */
  }
}

/**
 * Atomically claim an MFA-pending token's jti so it can be exchanged at most
 * once. Returns false if already used (replay). Fails CLOSED in prod/mirror.
 * `ttlSec` should be >= the pending token's remaining lifetime.
 */
export async function consumeMfaPendingJti(jti: string, ttlSec: number): Promise<boolean> {
  const redis = getCacheRedis();
  if (!redis) {
    // No store: cannot prove single-use. Enforce it where security matters.
    return !revocationEnforced();
  }
  try {
    // SET NX = claim only if not already present.
    const claimed = await redis.set(`dms:auth:mfa_pending_used:${jti}`, '1', 'EX', Math.max(ttlSec, 1), 'NX');
    return claimed === 'OK';
  } catch (error) {
    logger.error({ jti, error }, 'MFA pending-token single-use claim failed');
    return !revocationEnforced();
  }
}

type ExternalAccessTokenPayload = {
  jti?: string; // Token ID — present on tokens issued by this server; used for revocation
  user_id: string;
  role: string; // Display role for backward compatibility
  roles?: string[]; // All assigned roles
  permissions?: Permission[]; // Pre-computed permission union
  tenant_id: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  // Present ONLY on the short-lived (5 min) MFA-pending token issued by
  // POST /auth/login when the account has MFA enabled. That token carries
  // every claim authenticate() otherwise checks except `permissions`, which
  // used to make it a full bearer credential the moment permissions[] was
  // recomputed from the DB below. It must never be accepted here — it is
  // only valid at POST /auth/mfa/validate.
  mfa_pending?: boolean;
  // Present ONLY on the short-lived (5 min) pre-role token issued when a
  // multi-role user's login/select-tenant has resolved tenant_id but not yet
  // which role they're signing in as — carries every claim authenticate()
  // otherwise checks except `permissions`, same shape/reasoning as
  // mfa_pending above. Only valid at POST /auth/select-role.
  role_selection_required?: boolean;
  available_roles?: string[];
};

export type AuthenticatedUser = {
  userId: string;
  role: string; // Display role (highest-ranked) for UI only
  roles: string[]; // All assigned roles
  tenantId: string;
  permissions: Permission[]; // Effective permission set (union of all roles)
};

// JWKS Client for external provider
const client = config.AUTH_JWKS_URI
  ? jwksClient({ jwksUri: config.AUTH_JWKS_URI })
  : null;

/**
 * The key id on every token DMS itself signs: the pre-tenant token, the MFA
 * step tokens and, above all, the full ACCESS token every request carries.
 * (The name predates the IdP integration; do not rename it, it is in tokens
 * already issued.)
 */
const DMS_SESSION_KID = 'dev-key';

async function getPublicKey(header: jwt.JwtHeader): Promise<string> {
  // DMS's OWN session tokens. Every login, SSO or not, ends with DMS minting its own
  // RS256 session token signed by DEV_RSA_PRIVATE_KEY under keyid 'dev-key' (the OIDC
  // callback in auth.service.ts re-signs after verifying the IdP's id_token). This
  // is therefore the key that verifies EVERY ordinary request, and it must work
  // whether or not LOCAL_JWT_MOCK is on. Until 2026-10-04 it was only reachable
  // through the LOCAL_JWT_MOCK branch, so turning the mock off would have rejected
  // every request of every SSO-authenticated user (the flag looked like "disable
  // passwordless demo login" and was really also "disable DMS's own sessions").
  //
  // Safe to accept unconditionally: only the holder of DEV_RSA_PRIVATE_KEY (this
  // server's secret, distinct in each environment) can produce a signature this
  // key verifies, and a real IdP-issued token carries the IdP's own rotated kid,
  // never 'dev-key', so it still goes through the JWKS client below.
  if (config.DEV_RSA_PUBLIC_KEY && header.kid === DMS_SESSION_KID) {
    return Buffer.from(config.DEV_RSA_PUBLIC_KEY, 'base64').toString('utf-8');
  }

  // Outside production, LOCAL_JWT_MOCK + a local public key is enough whatever the
  // kid: the test suites sign mock tokens with no keyid at all, so requiring one
  // here breaks them. Never reached in production (the branch above is the only
  // local-key path there).
  if (config.LOCAL_JWT_MOCK && config.DEV_RSA_PUBLIC_KEY && config.NODE_ENV !== 'production') {
    return Buffer.from(config.DEV_RSA_PUBLIC_KEY, 'base64').toString('utf-8');
  }

  /**
   * Fallback to the shared public key when no JWKS endpoint is configured.
   *
   * Gated on NODE_ENV now. Previously this had NO environment check and NO kid
   * check, so in production a single unset or misspelled AUTH_JWKS_URI silently
   * downgraded verification of EVERY token -- whatever its kid, including ones
   * claiming to come from the real IdP -- to the locally-held dev public key.
   * That is a config typo turning into a total authentication bypass, with no
   * error and no log line. The LOCAL_JWT_MOCK path above is the deliberate,
   * kid-scoped exception; this one was not deliberate.
   */
  if (config.DEV_RSA_PUBLIC_KEY && !config.AUTH_JWKS_URI && config.NODE_ENV !== 'production') {
    return Buffer.from(config.DEV_RSA_PUBLIC_KEY, 'base64').toString('utf-8');
  }

  if (!client) {
    throw new AppError(
      500,
      'ERR-AUTH-CONFIG',
      'Auth verification not configured (no JWKS or public key)',
    );
  }

  const key = await client.getSigningKey(header.kid);
  return key.getPublicKey();
}

/**
 * Same issuer/audience computation every RS256 verify in this codebase must
 * use — DMS-minted tokens (pre-tenant, MFA-pending, and the full access
 * token) are all signed with the same iss/aud pair (see auth.routes.ts's
 * jwt.sign calls). Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #9: /select-tenant and
 * /totp/validate used to call jwt.verify directly with only `algorithms`
 * pinned, skipping this check — a code-consistency gap (and a latent one if
 * JWKS/multi-issuer trust is ever extended) that this helper closes by
 * giving both routes the exact same options verifyAccessToken enforces.
 */
export function dmsJwtVerifyOptions(): jwt.VerifyOptions {
  const issuer =
    config.NODE_ENV === 'production'
      ? config.AUTH_ISSUER
      : [config.AUTH_ISSUER, config.DEV_JWT_ISSUER].filter((s): s is string =>
          Boolean(s),
        );
  const audience =
    config.NODE_ENV === 'production'
      ? config.AUTH_AUDIENCE
      : [config.AUTH_AUDIENCE, config.DEV_JWT_AUDIENCE].filter(
          (s): s is string => Boolean(s),
        );

  const jwtOptions: jwt.VerifyOptions = { algorithms: ['RS256'] };
  if (Array.isArray(issuer)) {
    if (issuer.length === 1) jwtOptions.issuer = issuer[0];
    else if (issuer.length > 1) jwtOptions.issuer = issuer as [string, ...string[]];
  } else if (issuer) {
    jwtOptions.issuer = issuer;
  }
  if (Array.isArray(audience)) {
    if (audience.length === 1) jwtOptions.audience = audience[0];
    else if (audience.length > 1) jwtOptions.audience = audience as [string, ...string[]];
  } else if (audience) {
    jwtOptions.audience = audience;
  }
  return jwtOptions;
}

/**
 * P2-9 item 20: failed verifications are audit-SAMPLED per source, not written
 * one-for-one.
 *
 * Every failure used to write an AUTHN_FAILURE audit row, from any caller,
 * authenticated or not. Those rows go through the hash-chained audit writer,
 * which takes a GLOBAL `pg_advisory_xact_lock` to serialise the chain — so any
 * unauthenticated client could generate unbounded audit writes AND serialise them
 * against every legitimate audit write in the system, just by replaying a garbage
 * Bearer token in a loop. Write amplification and lock contention, reachable with
 * no credentials.
 *
 * Sampling keeps the security signal (a burst from one source still produces
 * rows, and the count of suppressed attempts is recorded on the next one) while
 * bounding the writes. `sourceKey` is the caller's IP where one is known; failures
 * with no known source share a single bucket, which is the conservative choice —
 * they cannot be used to evade another source's budget.
 */
const AUTHN_FAILURE_AUDIT_WINDOW_MS = 60_000;
const AUTHN_FAILURE_AUDIT_MAX_PER_WINDOW = 3;
const authnFailureAuditBuckets = new Map<string, { windowStart: number; written: number; suppressed: number }>();

function shouldAuditAuthnFailure(sourceKey: string): { write: boolean; suppressed: number } {
  const now = Date.now();
  const key = sourceKey || 'unknown';
  let bucket = authnFailureAuditBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= AUTHN_FAILURE_AUDIT_WINDOW_MS) {
    bucket = { windowStart: now, written: 0, suppressed: 0 };
    authnFailureAuditBuckets.set(key, bucket);
  }
  // Bounded map: a long-lived process facing many distinct source IPs must not
  // accumulate a bucket per address forever.
  if (authnFailureAuditBuckets.size > 10_000) {
    for (const [k, v] of authnFailureAuditBuckets) {
      if (now - v.windowStart >= AUTHN_FAILURE_AUDIT_WINDOW_MS) authnFailureAuditBuckets.delete(k);
    }
  }
  if (bucket.written < AUTHN_FAILURE_AUDIT_MAX_PER_WINDOW) {
    bucket.written += 1;
    const suppressed = bucket.suppressed;
    bucket.suppressed = 0;
    return { write: true, suppressed };
  }
  bucket.suppressed += 1;
  return { write: false, suppressed: bucket.suppressed };
}

export async function verifyAccessToken(
  token: string,
  sourceKey = '',
): Promise<ExternalAccessTokenPayload> {
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header || !decoded.payload) {
      throw new AppError(401, 'ERR-AUTH-INVALID', 'Malformed token');
    }

    const publicKey = await getPublicKey(decoded.header);

    const jwtOptions = dmsJwtVerifyOptions();
    const payload = jwt.verify(
      token,
      publicKey,
      jwtOptions,
    ) as unknown as Record<string, unknown>;

    // Check required claims per JWT-contract.md
    const requiredClaims: (keyof ExternalAccessTokenPayload)[] = [
      'user_id',
      'role',
      'tenant_id',
      'iat',
      'exp',
      'iss',
      'aud',
    ];
    for (const claim of requiredClaims) {
      if (!(claim in payload)) {
        throw new AppError(
          401,
          'ERR-AUTH-INVALID',
          `Missing required claim: ${claim}`,
        );
      }
    }

    return payload as unknown as ExternalAccessTokenPayload;
  } catch (err) {
    const errorCode =
      err instanceof jwt.TokenExpiredError
        ? 'ERR-AUTH-EXPIRED'
        : 'ERR-AUTH-INVALID';
    const errorMessage =
      err instanceof jwt.TokenExpiredError
        ? 'Access token expired'
        : (err as Error).message || 'Invalid access token';

    const sampling = shouldAuditAuthnFailure(sourceKey);
    if (sampling.write) {
      try {
        await writeAuditLog({
          eventType: AUDIT_EVENTS.AUTHN_FAILURE,
          actionDetails: {
            error: errorMessage,
            token: token.substring(0, 10) + '...',
            source: sourceKey || 'unknown',
            // How many failures from this source were NOT written since the last
            // recorded one — so a suppressed burst is still visible in the audit
            // trail rather than silently vanishing.
            suppressedSincePrevious: sampling.suppressed,
          },
          isSuccess: false,
          errorCode,
        });
      } catch {
        // Auth failure must not become 500 when audit persistence is unavailable
      }
    }

    if (err instanceof AppError) throw err;
    throw new AppError(401, errorCode, errorMessage);
  }
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Authentication required');
    }

    const payload = await verifyAccessToken(token, req.ip ?? '');

    // FIX: reject MFA-pending tokens outright. They carry every claim below
    // except permissions[] — which used to make them silently fall through
    // to "compute the full permission set from the DB," turning a token that
    // was only ever supposed to authorize completing MFA into a fully
    // authenticated bearer credential, with no TOTP check ever performed.
    if (payload.mfa_pending) {
      throw new AppError(
        401,
        'ERR-MFA-REQUIRED',
        'Complete MFA verification before using this token',
      );
    }

    // Same reasoning as mfa_pending above: a pre-role token carries a valid
    // tenant_id (role selection happens after tenant is resolved) and would
    // otherwise fall through to "compute permissions from the DB" below,
    // silently becoming a full bearer credential for the union of every role
    // the user holds — defeating the entire point of asking which one to act
    // as. Only valid at POST /auth/select-role.
    if (payload.role_selection_required) {
      throw new AppError(
        401,
        'ERR-ROLE-SELECTION-REQUIRED',
        'Select a role before using this token',
      );
    }

    // Revocation checks (jti blacklist + user-level cutoff) are independent
    // Redis lookups — run them concurrently instead of one-after-the-other,
    // since both gate every single authenticated request.
    const checkJtiRevocation = async (): Promise<void> => {
      // Check token revocation blacklist (populated by POST /auth/logout)
      if (!payload.jti) return;
      const redis = getCacheRedis();
      if (!redis && revocationEnforced()) {
        logger.error({ jti: payload.jti }, 'Redis is unavailable; rejecting authenticated request because revocation cannot be checked');
        throw new AppError(503, 'ERR-AUTH-REVOCATION-UNAVAILABLE', 'Authentication is temporarily unavailable');
      }
      if (redis) {
        let revoked: string | null;
        try {
          revoked = await redis.get(`dms:auth:revoked:${payload.jti}`);
        } catch (error) {
          logger.error({ jti: payload.jti, error }, 'Redis revocation lookup failed; rejecting authenticated request');
          if (revocationEnforced()) {
            throw new AppError(503, 'ERR-AUTH-REVOCATION-UNAVAILABLE', 'Authentication is temporarily unavailable');
          }
          revoked = null;
        }
        if (revoked) {
          throw new AppError(401, 'ERR-AUTH-REVOKED', 'Token has been revoked');
        }
      } else {
        // FIX: this used to fail open with total silence — an admin could
        // revoke a token or sign a user out and never learn that a Redis
        // outage quietly made that a no-op. Still fail open (consistent
        // with this app's Redis-optional posture elsewhere), but log it.
        logger.warn(
          { jti: payload.jti },
          'Redis unavailable — access-token revocation check skipped (fail-open)',
        );
      }
    };

    const checkUserRevocationCutoff = async (): Promise<void> => {
      // User-level revocation cutoff (deactivation, force-logout, any role or
      // permission change, and the IdP's backchannel-logout propagation): any
      // token ISSUED at or before the cutoff is dead, regardless of jti.
      //
      // R-04: this used to be a Redis-only lookup, so in production a Redis
      // outage made every authenticated request 503 (the cutoff could not be
      // consulted, so the request could not be trusted) and in development it
      // silently skipped the check. The cutoff is durable in Postgres now, so
      // there is a correct answer available either way: Redis is consulted
      // first as a cache, and its absence costs a primary-key lookup rather
      // than the ability to authenticate. A genuine Postgres failure still
      // propagates, which is right — that is a real inability to verify.
      if (!(payload.user_id && payload.iat)) return;
      const cutoff = await getUserRevocationCutoff(payload.user_id);
      if (cutoff !== null && payload.iat <= cutoff) {
        throw new AppError(401, 'ERR-AUTH-REVOKED', 'Session has been signed out');
      }
    };

    await Promise.all([checkJtiRevocation(), checkUserRevocationCutoff()]);

    // Extract roles array (new multi-role format) or fall back to single role
    const roles = payload.roles ?? [payload.role];
    
    // Use pre-computed permissions from JWT if available, otherwise compute union
    let permissions: Permission[];
    if (payload.permissions && payload.permissions.length > 0) {
      permissions = payload.permissions;
    } else {
      // Fallback: compute union of all roles' permissions
      permissions = await resolveUnionPermissions(roles, payload.tenant_id, payload.user_id);
    }

    req.user = {
      userId: payload.user_id,
      role: payload.role, // Display role
      roles,
      tenantId: payload.tenant_id,
      permissions,
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user)
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Authentication required');
    
    // Use pre-computed permissions from authenticate middleware
    const allowed = req.user.permissions;
    
    if (!allowed.includes(permission)) {
      try {
        await writeAuditLog({
          eventType: AUDIT_EVENTS.AUTHZ_ROLE_DENIED,
          userId: req.user.userId,
          userRole: req.user.role,
          sourceIp: req.ip ?? null,
          actionDetails: {
            permission,
            method: req.method,
            path: req.originalUrl,
            roles: req.user.roles, // Include all roles for audit trail
          },
          isSuccess: false,
          errorCode: 'ERR-PERMISSION-DENIED',
        });
      } catch {
        // Permission denial must not become 500 when audit persistence is unavailable
      }
      throw new AppError(
        403,
        'ERR-PERMISSION-DENIED',
        `Missing permission: ${permission}`,
      );
    }
    next();
  };
}

/**
 * Passes if the principal holds ANY of the listed permissions. Use for
 * endpoints legitimately reachable by more than one role capability (e.g. the
 * approval assignee picker is needed by both submitters and deciders).
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user)
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Authentication required');
    const held = new Set(req.user.permissions);
    if (permissions.some((p) => held.has(p))) {
      next();
      return;
    }
    throw new AppError(403, 'ERR-PERMISSION-DENIED', `Missing one of: ${permissions.join(', ')}`);
  };
}

export function requireSelfOrPermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user)
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Authentication required');
    if (req.params.id === req.user.userId) {
      next();
      return;
    }
    await requirePermission(permission)(req, res, next);
  };
}
