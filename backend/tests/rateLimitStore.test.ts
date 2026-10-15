/**
 * Perf fix: increment() used to be INCR then PTTL (occasionally a third
 * PEXPIRE) as separate sequential Redis round-trips on every single
 * rate-limited request. These tests pin that it's now one EVAL round-trip
 * with equivalent semantics, and that the existing fail-open-on-Redis-error
 * behavior (see the FIX comment in rateLimitStore.ts) still holds.
 */
import { createRedisRateLimitStore } from "../src/infrastructure/cache/rateLimitStore.js";

const mockRedis = {
  incr: jest.fn(),
  pttl: jest.fn(),
  pexpire: jest.fn(),
  decr: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
};

jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getCacheRedis: () => mockRedis,
}));
jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("RedisRateLimitStore.increment", () => {
  it("does the whole increment+ttl(+expire) in a single eval round-trip", async () => {
    mockRedis.eval.mockResolvedValue([5, 30_000]);
    const store = createRedisRateLimitStore("test")!;
    store.init?.({ windowMs: 60_000 } as any);

    const result = await store.increment("k1");

    expect(result.totalHits).toBe(5);
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.pttl).not.toHaveBeenCalled();
    expect(mockRedis.pexpire).not.toHaveBeenCalled();
    // windowMs passed through as the fallback expiry the script applies when
    // the key has no TTL yet.
    expect(mockRedis.eval).toHaveBeenCalledWith(expect.any(String), 1, "dms:rate-limit:test:k1", 60_000);
  });

  it("fails open (totalHits=1) when the eval call itself throws", async () => {
    mockRedis.eval.mockRejectedValue(new Error("ECONNREFUSED"));
    const store = createRedisRateLimitStore("test")!;
    store.init?.({ windowMs: 60_000 } as any);

    const result = await store.increment("k1");

    expect(result.totalHits).toBe(1);
  });
});
