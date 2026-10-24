import type { Options, Store } from "express-rate-limit";
import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";

type RedisLike = {
  incr(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

// Perf: increment() used to be INCR then PTTL as two sequential round-trips
// (occasionally a third PEXPIRE) — on the global /api limiter, that's a tax
// paid on every single request. One EVAL does INCR + PTTL + the conditional
// PEXPIRE atomically in a single round-trip, with the same semantics: bump
// the counter, read its TTL, and (re)arm the window's expiry only if it's
// missing (key just created, or a prior expire was somehow lost).
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * R-03 (audit 2026-09-03): a fixed-window counter kept in this
 * process, used ONLY while Redis is unreachable.
 *
 * The store used to fail fully open on a Redis error — every request looked
 * like the first in its window (verified live: RateLimit-Remaining sat at 799
 * across four consecutive requests with Redis down), so a Redis blip
 * silently removed brute-force protection from /api/v1/auth entirely, with
 * no alert. Failing fully CLOSED is not the answer either and was already
 * tried: it 500'd every login attempt, which is worse.
 *
 * Falling back to a per-process window keeps enforcement during an outage
 * and cannot reintroduce those 500s, because increment() always returns a
 * valid positive totalHits. It also makes the "Redis configured but down"
 * case behave like the "Redis not configured at all" case, which already
 * gets express-rate-limit's own MemoryStore (createRedisRateLimitStore
 * returns undefined there, so the library falls back on its own).
 *
 * Known and accepted limits, since this is a degraded mode, not the design:
 *   - Counters are per process. Behind N workers the effective limit is up to
 *     N x the configured one. Still bounded; "unlimited" is not.
 *   - Counters are lost on restart and do not carry over when Redis returns
 *     (the Redis keys keep their own state and simply resume).
 *   - Memory is capped (see MEMORY_FALLBACK_MAX_KEYS). Past the cap the
 *     entries nearest expiry are dropped, so a very wide distributed source
 *     degrades toward fail-open rather than exhausting the heap — losing rate
 *     limiting is recoverable, OOM-killing the API is not.
 *
 * Redis availability still needs monitoring; this bounds the blast radius,
 * it does not remove the need to know.
 */
const MEMORY_FALLBACK_MAX_KEYS = 20_000;
const MEMORY_FALLBACK_PRUNE_INTERVAL_MS = 5_000;

type Window = { count: number; resetAt: number };

class MemoryWindowCounter {
  private windows = new Map<string, Window>();
  private lastPrune = 0;

  increment(key: string, windowMs: number): Window {
    const now = Date.now();
    this.prune(now);
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh: Window = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }

  decrement(key: string): void {
    const existing = this.windows.get(key);
    // Never below 1: express-rate-limit's Store contract wants a positive
    // integer, and a 0 here would resurface the ValidationError this store
    // already had to fix once.
    if (existing && existing.count > 1) existing.count -= 1;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Drop expired windows, then enforce the size cap. Rate-limited itself so
   *  a burst does not pay a full sweep per request. */
  private prune(now: number): void {
    if (now - this.lastPrune < MEMORY_FALLBACK_PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size <= MEMORY_FALLBACK_MAX_KEYS) return;
    // Over cap: shed the windows closest to expiring, keeping the ones with
    // the most life left (an active offender's window is the one worth
    // holding on to).
    const byExpiry = [...this.windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    const excess = this.windows.size - MEMORY_FALLBACK_MAX_KEYS;
    for (let i = 0; i < excess; i++) this.windows.delete(byExpiry[i]![0]);
    logger.warn(
      { size: this.windows.size, shed: excess },
      "in-memory rate-limit fallback exceeded its key cap; shed the windows nearest expiry",
    );
  }
}

/** Shared across every limiter instance; keys are already prefixed per
 *  limiter, so one map cannot let the auth limiter and the global limiter
 *  collide. */
const memoryFallback = new MemoryWindowCounter();

/** Exposed for tests only. */
export function __resetMemoryRateLimitFallback(): void {
  memoryFallback["windows"].clear();
  memoryFallback["lastPrune"] = 0;
}

class RedisRateLimitStore implements Store {
  localKeys = false;
  prefix: string;
  private windowMs = 60_000;

  constructor(
    private readonly redis: RedisLike,
    prefix: string,
  ) {
    this.prefix = `dms:rate-limit:${prefix}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string) {
    const redisKey = this.prefix + key;
    try {
      const [rawCount, rawTtl] = (await this.redis.eval(INCREMENT_SCRIPT, 1, redisKey, this.windowMs)) as [
        number,
        number,
      ];
      return { totalHits: Number(rawCount), resetTime: new Date(Date.now() + Number(rawTtl)) };
    } catch (error) {
      // Do NOT fail closed: rejecting every request the moment Redis is
      // unreachable turns an infra blip into a full outage — that was the
      // original behaviour and it 500'd every login attempt.
      //
      // R-03: but do not fail fully OPEN either, which is what returning a
      // flat `totalHits: 1` did — every request looked like the first in its
      // window, so a Redis blip silently removed brute-force protection from
      // /api/v1/auth with nothing but a log line to show for it. Degrade to a
      // per-process in-memory window instead: enforcement continues, and
      // because this still returns a positive totalHits it cannot reintroduce
      // the express-rate-limit ValidationError described below.
      //
      // (That contract is why the old code could not simply return 0:
      // express-rate-limit requires totalHits to be a positive integer, and 0
      // made it throw mid-request — after cors() had run — surfacing in the
      // browser as a bare "CORS error" on random requests whenever Redis
      // hiccupped. The memory counter starts at 1, so the contract holds.)
      const window = memoryFallback.increment(redisKey, this.windowMs);
      logger.warn(
        { error, redisKey, totalHits: window.count },
        "rate limit store unavailable; degrading to the per-process in-memory window",
      );
      return { totalHits: window.count, resetTime: new Date(window.resetAt) };
    }
  }

  async decrement(key: string) {
    try {
      await this.redis.decr(this.prefix + key);
    } catch (error) {
      // Mirror the increment fallback, or a skipped request (skipSuccessful/
      // FailedRequests) would stay counted against the caller for the rest of
      // the window while Redis is down.
      memoryFallback.decrement(this.prefix + key);
      logger.warn({ error }, "failed to decrement Redis rate-limit key; decremented the in-memory fallback");
    }
  }

  async resetKey(key: string) {
    // Always clear the fallback too: resetKey means "this caller is
    // forgiven", and leaving a stale in-memory window behind would keep
    // penalising them after a successful reset.
    memoryFallback.reset(this.prefix + key);
    try {
      await this.redis.del(this.prefix + key);
    } catch (error) {
      logger.warn({ error }, "failed to reset Redis rate-limit key");
    }
  }
}

export function createRedisRateLimitStore(prefix: string): Store | undefined {
  const redis = getCacheRedis();
  if (!redis) return undefined;
  return new RedisRateLimitStore(redis as RedisLike, prefix);
}
