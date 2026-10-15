import * as IORedis from "ioredis";
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";

let redis: any | null = null;
let cacheRedis: any | null = null;

/**
 * Shared connection for BullMQ (queues.ts, every worker, outbox.ts) and the
 * socket.io Redis adapter. `maxRetriesPerRequest: null` is a hard BullMQ
 * requirement — it refuses to start otherwise — which means a command
 * issued on THIS client while Redis is down waits indefinitely for a
 * reconnect that may never come. That's the right tradeoff for a queue (you
 * want a job to wait, not silently vanish), but it's the wrong one for a
 * plain cache read. Use getCacheRedis() below for those, never this one.
 */
export function getRedis() {
  if (!config.REDIS_URL) return null;
  if (!redis) {
    const RedisCtor = (IORedis as any).default ?? IORedis;
    redis = new RedisCtor(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    redis.on("error", (error: unknown) => logger.warn({ error }, "redis unavailable; cache/queues degrade"));
  }
  return redis;
}

/**
 * Separate connection for plain get/set/del caches that already have an
 * in-memory LRU fallback (roleCache, aclCache, featureFlagCache,
 * rateLimitStore, userDeptCache, auditChainCache) — fails fast instead of
 * hanging, so that fallback is actually reachable when Redis is down rather
 * than the caller hanging forever waiting on a command that will never
 * complete. Never share this with a BullMQ Queue/Worker (they need the
 * other client's infinite-patience settings, not this one's fail-fast ones).
 */
/**
 * BullMQ (all queues, repeatable jobs, the SLA/retention/expiry crons)
 * requires Redis >= 6.2 — on an older server the workers misbehave in
 * non-obvious ways instead of failing cleanly. Called at API/worker boot:
 * an old Redis is a hard error in production/mirror and a loud warning in
 * dev; an UNREACHABLE Redis stays a soft degrade (that path is handled by
 * the queue/cache fallbacks, not this check).
 */
export async function assertRedisVersion(): Promise<void> {
  // Deliberately the fail-fast cache client (maxRetriesPerRequest: 1,
  // connectTimeout: 2000ms), NOT getRedis()'s BullMQ client. That one is
  // configured with maxRetriesPerRequest: null specifically so a queued job
  // waits indefinitely for Redis to come back rather than vanish — which
  // means a command awaited on it, at boot, with Redis unreachable, never
  // resolves and never rejects. That silently blocked every server/worker
  // boot before app.listen() when Redis was down, contradicting this
  // function's own contract below ("an UNREACHABLE Redis stays a soft
  // degrade").
  const client = getCacheRedis();
  if (!client) return;
  let info: string;
  try {
    // getCacheRedis() is lazyConnect + enableOfflineQueue:false, and this is
    // typically the very first command issued on it (at boot). Without an
    // explicit connect() first, ioredis fires .info() while the socket is
    // still opening and — since offline queueing is off — rejects immediately
    // with "Stream isn't writeable", which this function then misreports as
    // "redis unreachable" even when Redis is up and would have connected fine.
    if (client.status === "wait") {
      await client.connect();
    }
    info = await client.info("server");
  } catch (error) {
    logger.warn({ error }, "redis version check skipped — redis unreachable at boot");
    return;
  }
  const match = /redis_version:(\d+)\.(\d+)/.exec(info);
  if (!match) return;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > 6 || (major === 6 && minor >= 2)) return;
  const message = `Redis ${major}.${minor} detected — BullMQ requires >= 6.2 (queues, scheduled jobs, SLA/retention crons will misbehave). Upgrade the Redis server.`;
  if (config.NODE_ENV === "production" || config.NODE_ENV === "mirror") {
    throw new Error(message);
  }
  logger.error(message);
}

export function getCacheRedis() {
  if (!config.REDIS_URL) return null;
  if (!cacheRedis) {
    const RedisCtor = (IORedis as any).default ?? IORedis;
    cacheRedis = new RedisCtor(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
      // Without this, a command issued while a prior reconnect attempt is
      // still backing off QUEUES behind that attempt instead of failing on
      // its own — latency compounds request over request (measured: 0.2s,
      // 1s, 1.4s, 3.4s, 4s+ across successive calls while Redis was down)
      // until it's indistinguishable from a hang. With it, every command
      // gets its own fast, independent attempt no matter what the shared
      // connection's reconnect state is doing.
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });
    cacheRedis.on("error", (error: unknown) => logger.warn({ error }, "cache redis unavailable; falling back to in-memory LRU"));
  }
  return cacheRedis;
}
