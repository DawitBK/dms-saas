// R-03 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): the Redis rate-limit store used to
// fail fully OPEN — on any Redis error it returned a flat `totalHits: 1`, so
// every request looked like the first in its window and a Redis blip silently
// removed brute-force protection from /api/v1/auth with nothing but a log
// line. It must not fail closed either (that 500'd every login attempt, which
// is how the fail-open behaviour came about in the first place). The store now
// degrades to a per-process in-memory window.
//
// These tests drive the store directly with a Redis double, so both the
// healthy path and the outage path are exercised without a live Redis.

const mockGetCacheRedis = jest.fn();
jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getCacheRedis: () => mockGetCacheRedis(),
}));

import type { Options, Store } from "express-rate-limit";
import {
  __resetMemoryRateLimitFallback,
  createRedisRateLimitStore,
} from "../src/infrastructure/cache/rateLimitStore.js";

const WINDOW_MS = 60_000;

/** A Redis double that can be switched between healthy and failing. */
function makeRedis() {
  const state = { failing: false, counters: new Map<string, number>() };
  return {
    state,
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, windowMs: number) => {
      if (state.failing) throw new Error("ECONNREFUSED");
      const next = (state.counters.get(key) ?? 0) + 1;
      state.counters.set(key, next);
      return [next, Number(windowMs)];
    }),
    decr: jest.fn(async (key: string) => {
      if (state.failing) throw new Error("ECONNREFUSED");
      const next = (state.counters.get(key) ?? 0) - 1;
      state.counters.set(key, next);
      return next;
    }),
    del: jest.fn(async (key: string) => {
      if (state.failing) throw new Error("ECONNREFUSED");
      state.counters.delete(key);
      return 1;
    }),
    incr: jest.fn(),
    pttl: jest.fn(),
    pexpire: jest.fn(),
  };
}

function build(redis: unknown, prefix = "auth"): Store {
  mockGetCacheRedis.mockReturnValue(redis);
  const store = createRedisRateLimitStore(prefix)!;
  store.init?.({ windowMs: WINDOW_MS } as Options);
  return store;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetMemoryRateLimitFallback();
});

describe("createRedisRateLimitStore", () => {
  it("returns undefined when Redis is not configured, so the library uses its own MemoryStore", () => {
    mockGetCacheRedis.mockReturnValue(null);
    expect(createRedisRateLimitStore("auth")).toBeUndefined();
  });
});

describe("healthy Redis", () => {
  it("counts up through Redis, one round-trip per request", async () => {
    const redis = makeRedis();
    const store = build(redis);
    expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await store.increment("1.2.3.4")).totalHits).toBe(2);
    expect((await store.increment("1.2.3.4")).totalHits).toBe(3);
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it("keys are independent per caller", async () => {
    const store = build(makeRedis());
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    expect((await store.increment("5.6.7.8")).totalHits).toBe(1);
  });

  it("does not touch the in-memory fallback while Redis is healthy", async () => {
    const redis = makeRedis();
    const store = build(redis);
    for (let i = 0; i < 5; i++) await store.increment("1.2.3.4");
    // Redis now fails; the fallback must start from scratch rather than
    // continuing a count it was never keeping.
    redis.state.failing = true;
    expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
  });
});

// The regression this recommendation exists for.
describe("Redis unavailable", () => {
  it("keeps counting instead of reporting 1 forever (the fail-open bug)", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    const hits: number[] = [];
    for (let i = 0; i < 5; i++) hits.push((await store.increment("1.2.3.4")).totalHits);
    expect(hits).toEqual([1, 2, 3, 4, 5]);
  });

  it("would therefore trip a limit of 20 on /auth rather than never tripping", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    let tripped = 0;
    for (let i = 0; i < 25; i++) {
      const { totalHits } = await store.increment("attacker");
      if (totalHits > 20) tripped++;
    }
    expect(tripped).toBe(5);
  });

  it("never fails closed — it always returns a positive totalHits", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    for (let i = 0; i < 3; i++) {
      const result = await store.increment("1.2.3.4");
      // express-rate-limit's Store contract: a positive integer. 0 makes the
      // library throw its own ValidationError mid-request.
      expect(Number.isInteger(result.totalHits)).toBe(true);
      expect(result.totalHits).toBeGreaterThan(0);
      expect(result.resetTime).toBeInstanceOf(Date);
    }
  });

  it("scopes fallback counters per caller", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    expect((await store.increment("5.6.7.8")).totalHits).toBe(1);
    expect((await store.increment("1.2.3.4")).totalHits).toBe(3);
  });

  it("scopes fallback counters per limiter, so /auth and /api cannot collide", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const auth = build(redis, "auth");
    const global = build(redis, "global");
    await auth.increment("1.2.3.4");
    await auth.increment("1.2.3.4");
    expect((await global.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("sets a reset time one window out", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    const before = Date.now();
    const { resetTime } = await store.increment("1.2.3.4");
    const ms = (resetTime as Date).getTime() - before;
    expect(ms).toBeGreaterThan(WINDOW_MS - 2_000);
    expect(ms).toBeLessThanOrEqual(WINDOW_MS + 1_000);
  });

  it("starts a fresh window once the old one has elapsed", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    const realNow = Date.now;
    try {
      // Past the window AND past the prune interval, so the expired entry is
      // actually collected rather than merely stale.
      Date.now = () => realNow() + WINDOW_MS + 1_000;
      expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("decrement gives a hit back, so a skipped request is not held against the caller", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    await store.decrement("1.2.3.4");
    expect((await store.increment("1.2.3.4")).totalHits).toBe(2);
  });

  it("decrement never drives a counter below 1 (the contract 0 would violate)", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    for (let i = 0; i < 5; i++) await store.decrement("1.2.3.4");
    expect((await store.increment("1.2.3.4")).totalHits).toBe(2);
  });

  it("resetKey forgives a caller in the fallback too", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    await store.resetKey!("1.2.3.4");
    expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("resetKey clears the fallback even while Redis is healthy, leaving no stale window behind", async () => {
    const redis = makeRedis();
    const store = build(redis);
    redis.state.failing = true;
    await store.increment("1.2.3.4"); // fallback window now exists
    redis.state.failing = false;
    await store.resetKey!("1.2.3.4");
    redis.state.failing = true;
    expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("resumes using Redis the moment it recovers", async () => {
    const redis = makeRedis();
    redis.state.failing = true;
    const store = build(redis);
    await store.increment("1.2.3.4");
    await store.increment("1.2.3.4");
    redis.state.failing = false;
    // Redis kept its own state (none yet) and simply takes over.
    expect((await store.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await store.increment("1.2.3.4")).totalHits).toBe(2);
  });
});
