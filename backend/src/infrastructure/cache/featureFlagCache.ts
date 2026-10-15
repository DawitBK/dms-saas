// Per-tenant feature-flag cache — same shape as roleCache.ts (Redis + LRU
// fallback, 300s TTL, invalidate-on-write). See Documentations/rollout.md §4.2: flags let a
// risky feature ship dark (deployed, off) and get turned on per-tenant
// without a redeploy, so flipping one needs to be fast and cheap, not a
// fresh DB round-trip on every check.

import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";

const TTL_SECONDS = 300;
const LRU_MAX_SIZE = 1000;

interface CacheEntry {
  data: Record<string, boolean>;
  expiresAt: number;
}

class LRUCache {
  private cache: Map<string, CacheEntry> = new Map();

  set(key: string, value: Record<string, boolean>, ttlSeconds: number = TTL_SECONDS): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.delete(key);
    this.cache.set(key, { data: value, expiresAt });
    if (this.cache.size > LRU_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  get(key: string): Record<string, boolean> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
}

const lruCache = new LRUCache();

function getCacheKey(tenantId: string): string {
  return `dms:feature-flags:${tenantId}`;
}

export async function getCachedFeatureFlags(tenantId: string): Promise<Record<string, boolean> | null> {
  const key = getCacheKey(tenantId);
  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      return cached ? (JSON.parse(cached) as Record<string, boolean>) : null;
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve feature flags from Redis; checking LRU fallback");
      return lruCache.get(key);
    }
  }
  return lruCache.get(key);
}

export async function cacheFeatureFlags(
  tenantId: string,
  flags: Record<string, boolean>,
  ttlSeconds: number = TTL_SECONDS,
): Promise<void> {
  const key = getCacheKey(tenantId);
  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(flags));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache feature flags in Redis; using LRU fallback");
    }
  }
  lruCache.set(key, flags, ttlSeconds);
}

/** Call after committing any change to a tenant's feature_flags column. */
export async function invalidateFeatureFlags(tenantId: string): Promise<void> {
  const key = getCacheKey(tenantId);
  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ error, key }, "Failed to invalidate feature flags cache in Redis");
    }
  }
  lruCache.delete(key);
}
