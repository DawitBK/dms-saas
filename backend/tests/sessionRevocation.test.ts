// R-04 (audit 2026-09-03): session-revocation cutoffs used to live
// only in Redis. That made revokeAllUserSessions()'s documented contract — "if
// the cutoff cannot be persisted, the revocation is a lie, so we throw" —
// impossible to honour, because three call sites had to swallow its failure
// with .catch(logger.warn): by the time they call it the permission change has
// already committed, so throwing would 500 a change that did apply. Net
// effect, deactivating a user failed closed while demoting one failed open,
// and a Redis flush silently un-revoked everyone.
//
// Postgres is the record of truth now, Redis a read-through cache. These tests
// pin the resulting contract; test-scripts/verify-session-revocation.ts proves
// the same properties against a live database, including atomicity.

const mockUpsert = jest.fn();
const mockFindByPk = jest.fn();
jest.mock("../src/infrastructure/database/index.js", () => ({
  UserSessionCutoff: {
    upsert: (...args: unknown[]) => mockUpsert(...args),
    findByPk: (...args: unknown[]) => mockFindByPk(...args),
  },
}));

const mockGetCacheRedis = jest.fn();
jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getCacheRedis: () => mockGetCacheRedis(),
}));

const mockDisconnectUserSockets = jest.fn();
jest.mock("../src/infrastructure/websocket/socket.js", () => ({
  disconnectUserSockets: (...args: unknown[]) => mockDisconnectUserSockets(...args),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../src/modules/roles/roles.service.js", () => ({ resolveUnionPermissions: jest.fn() }));

import { config } from "../src/config/env.js";
import { getUserRevocationCutoff, revokeAllUserSessions } from "../src/shared/auth.js";

const USER = "7c4d84f0-3efa-4335-a436-7b1a99406483";
const KEY = `dms:auth:revoked_user:${USER}`;

function makeRedis() {
  return { get: jest.fn(), set: jest.fn().mockResolvedValue("OK"), del: jest.fn() };
}

const originalEnv = config.NODE_ENV;

/**
 * A transaction double that records its afterCommit hooks so a test can decide
 * when — or whether — the commit happens.
 */
function makeTransaction() {
  const hooks: Array<() => void> = [];
  return {
    id: "tx-1",
    afterCommit: (hook: () => void) => hooks.push(hook),
    /** Fire what a real commit would fire. */
    commit: async () => {
      for (const hook of hooks) hook();
      // Hooks are deliberately not awaited by the implementation (by then the
      // revocation has committed and nothing may undo it), so give their
      // microtasks a turn before asserting.
      await Promise.resolve();
      await Promise.resolve();
    },
    hookCount: () => hooks.length,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDisconnectUserSockets.mockResolvedValue(undefined);
  mockUpsert.mockResolvedValue([{}, true]);
  mockFindByPk.mockResolvedValue(null);
  config.NODE_ENV = originalEnv;
});

afterAll(() => {
  config.NODE_ENV = originalEnv;
});

describe("revokeAllUserSessions", () => {
  it("persists the cutoff to Postgres", async () => {
    mockGetCacheRedis.mockReturnValue(makeRedis());
    await revokeAllUserSessions(USER);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [values] = mockUpsert.mock.calls[0]!;
    expect(values.userId).toBe(USER);
    expect(values.cutoffAt).toBeInstanceOf(Date);
  });

  it("passes the caller's transaction through, so the cutoff commits with the change", async () => {
    mockGetCacheRedis.mockReturnValue(makeRedis());
    const transaction = makeTransaction();
    await revokeAllUserSessions(USER, { transaction: transaction as never, reason: "role-change" });
    const [values, options] = mockUpsert.mock.calls[0]!;
    expect(options.transaction).toBe(transaction);
    expect(values.reason).toBe("role-change");
  });

  // ── Side effects must not outlive a rollback ──────────────────────────────
  //
  // FIX (2026-09-03): the Redis write and the socket disconnect used to run
  // inline. A rolled-back permission change therefore left a REAL revocation
  // behind — the Postgres row went away with the rollback (correctly), but the
  // cached cutoff did not, so the user was reported revoked for up to
  // CUTOFF_CACHE_TTL_SEC and had their socket killed, because of a change that
  // FAILED. Found by verify-session-revocation.ts, which had been passing only
  // because Redis was unreachable in dev and the cache path never ran.

  it("does not touch the cache or live sockets before the transaction commits", async () => {
    const redis = makeRedis();
    mockGetCacheRedis.mockReturnValue(redis);
    const transaction = makeTransaction();

    await revokeAllUserSessions(USER, { transaction: transaction as never, reason: "role-change" });

    // The durable write has happened (it is part of the caller's transaction)…
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    // …but nothing observable outside it has.
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockDisconnectUserSockets).not.toHaveBeenCalled();
    expect(transaction.hookCount()).toBe(1);
  });

  it("applies the cache write and socket disconnect once the transaction commits", async () => {
    const redis = makeRedis();
    mockGetCacheRedis.mockReturnValue(redis);
    const transaction = makeTransaction();

    await revokeAllUserSessions(USER, { transaction: transaction as never });
    await transaction.commit();

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0]![0]).toBe(KEY);
    expect(mockDisconnectUserSockets).toHaveBeenCalledWith(USER);
  });

  it("applies the side effects immediately when there is no transaction to wait for", async () => {
    // The IdP backchannel-logout path calls it this way: there is no domain
    // change to be atomic with, so deferring would only delay the revocation.
    const redis = makeRedis();
    mockGetCacheRedis.mockReturnValue(redis);

    await revokeAllUserSessions(USER, { reason: "idp-backchannel-logout" });

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(mockDisconnectUserSockets).toHaveBeenCalledWith(USER);
  });

  it("still revokes when disconnecting live sockets fails", async () => {
    // The durable cutoff is the authority; a socket that survives will be
    // refused at its next handshake anyway. This must never surface as a
    // failure of the permission change.
    const redis = makeRedis();
    mockGetCacheRedis.mockReturnValue(redis);
    mockDisconnectUserSockets.mockRejectedValue(new Error("no io instance"));

    await expect(revokeAllUserSessions(USER)).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    // And it still got as far as refreshing the cache.
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it("records a null reason when none is given", async () => {
    mockGetCacheRedis.mockReturnValue(makeRedis());
    await revokeAllUserSessions(USER);
    expect(mockUpsert.mock.calls[0]![0].reason).toBeNull();
  });

  it("refreshes the cache so the revocation applies immediately, not at window end", async () => {
    const redis = makeRedis();
    mockGetCacheRedis.mockReturnValue(redis);
    await revokeAllUserSessions(USER);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, ex, ttl] = redis.set.mock.calls[0]!;
    expect(key).toBe(KEY);
    expect(Number(value)).toBeGreaterThan(1_600_000_000);
    expect(ex).toBe("EX");
    // Short TTL: this is a cache now, not the record. It also bounds how long a
    // failed cache write could hide a revocation.
    expect(ttl).toBeLessThanOrEqual(60);
  });

  // A cache write can no longer make the revocation a lie, so it must not fail
  // the operation.
  it("tolerates a Redis write failure", async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValue(new Error("ECONNREFUSED"));
    mockGetCacheRedis.mockReturnValue(redis);
    await expect(revokeAllUserSessions(USER)).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("tolerates Redis being absent entirely (used to throw 503 in production)", async () => {
    mockGetCacheRedis.mockReturnValue(null);
    config.NODE_ENV = "production";
    await expect(revokeAllUserSessions(USER)).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  // The other half: a failure that DOES mean the revocation did not happen has
  // to propagate, so it rolls the accompanying change back.
  it("propagates a Postgres failure", async () => {
    mockGetCacheRedis.mockReturnValue(makeRedis());
    mockUpsert.mockRejectedValue(new Error("deadlock detected"));
    await expect(revokeAllUserSessions(USER)).rejects.toThrow(/deadlock/);
  });
});

describe("getUserRevocationCutoff", () => {
  it("serves a cache hit without touching Postgres", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue("1788000000");
    mockGetCacheRedis.mockReturnValue(redis);
    expect(await getUserRevocationCutoff(USER)).toBe(1788000000);
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  it("treats the cached sentinel as 'no cutoff' without touching Postgres", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue("none");
    mockGetCacheRedis.mockReturnValue(redis);
    expect(await getUserRevocationCutoff(USER)).toBeNull();
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  it("falls through to Postgres on a cache miss and caches what it finds", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    mockGetCacheRedis.mockReturnValue(redis);
    const cutoffAt = new Date(1788000000_000);
    mockFindByPk.mockResolvedValue({ cutoffAt });
    expect(await getUserRevocationCutoff(USER)).toBe(1788000000);
    expect(redis.set).toHaveBeenCalledWith(KEY, "1788000000", "EX", expect.any(Number));
  });

  // Without negative caching, every request by the vast majority of users —
  // who have never been revoked — would hit Postgres.
  it("negatively caches 'no cutoff'", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    mockGetCacheRedis.mockReturnValue(redis);
    mockFindByPk.mockResolvedValue(null);
    expect(await getUserRevocationCutoff(USER)).toBeNull();
    expect(redis.set).toHaveBeenCalledWith(KEY, "none", "EX", expect.any(Number));
  });

  it("resolves from Postgres when Redis is absent (no longer a 503 in production)", async () => {
    mockGetCacheRedis.mockReturnValue(null);
    config.NODE_ENV = "production";
    mockFindByPk.mockResolvedValue({ cutoffAt: new Date(1788000000_000) });
    expect(await getUserRevocationCutoff(USER)).toBe(1788000000);
  });

  it("falls through to Postgres when the cache read itself errors", async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error("ECONNRESET"));
    mockGetCacheRedis.mockReturnValue(redis);
    mockFindByPk.mockResolvedValue({ cutoffAt: new Date(1788000000_000) });
    expect(await getUserRevocationCutoff(USER)).toBe(1788000000);
  });

  it("still answers correctly when caching the result fails", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    redis.set.mockRejectedValue(new Error("ECONNREFUSED"));
    mockGetCacheRedis.mockReturnValue(redis);
    mockFindByPk.mockResolvedValue({ cutoffAt: new Date(1788000000_000) });
    expect(await getUserRevocationCutoff(USER)).toBe(1788000000);
  });

  // If the authoritative read fails we cannot prove the session is valid. Keep
  // exactly the posture this check always had, rather than making a database
  // outage newly fatal in dev/test.
  it("refuses where revocation is enforced if the authoritative read fails", async () => {
    mockGetCacheRedis.mockReturnValue(null);
    config.NODE_ENV = "production";
    mockFindByPk.mockRejectedValue(new Error("connection terminated"));
    await expect(getUserRevocationCutoff(USER)).rejects.toMatchObject({
      statusCode: 503,
      code: "ERR-AUTH-REVOCATION-UNAVAILABLE",
    });
  });

  it("fails open elsewhere if the authoritative read fails", async () => {
    mockGetCacheRedis.mockReturnValue(null);
    config.NODE_ENV = "development";
    mockFindByPk.mockRejectedValue(new Error("connection terminated"));
    expect(await getUserRevocationCutoff(USER)).toBeNull();
  });

  it("enforces in mirror too, so a mis-set NODE_ENV cannot disable revocation", async () => {
    mockGetCacheRedis.mockReturnValue(null);
    config.NODE_ENV = "mirror";
    mockFindByPk.mockRejectedValue(new Error("connection terminated"));
    await expect(getUserRevocationCutoff(USER)).rejects.toMatchObject({ statusCode: 503 });
  });
});
