// Cache for the document-status-action-role matrix (statusPermissions.service.ts).
// Same shape as roleCache.ts: Redis with an in-memory LRU fallback, 300s TTL,
// invalidated on write. An empty array IS a valid cached value (means "no
// rule configured for this tuple — unrestricted"), distinct from a cache miss
// (null) — mirrors getCachedRolePermissions's convention exactly.

import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";

const TTL_SECONDS = 300;
const LRU_MAX_SIZE = 2000;

interface CacheEntry {
  data: string[];
  expiresAt: number;
}

class LRUCache {
  private cache: Map<string, CacheEntry> = new Map();

  set(key: string, value: string[], ttlSeconds: number = TTL_SECONDS): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.delete(key);
    this.cache.set(key, { data: value, expiresAt });
    if (this.cache.size > LRU_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  get(key: string): string[] | null {
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

function getCacheKey(tenantId: string, status: string, action: string): string {
  return `dms:status-action-roles:${tenantId}:${status}:${action}`;
}

export async function getCachedStatusActionRoles(
  tenantId: string,
  status: string,
  action: string,
): Promise<string[] | null> {
  const key = getCacheKey(tenantId, status, action);

  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached === null) return null;
      return JSON.parse(cached) as string[];
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve status-action-role cache from Redis; checking LRU fallback");
      return lruCache.get(key);
    }
  }

  return lruCache.get(key);
}

export async function cacheStatusActionRoles(
  tenantId: string,
  status: string,
  action: string,
  roleNames: string[],
  ttlSeconds: number = TTL_SECONDS,
): Promise<void> {
  const key = getCacheKey(tenantId, status, action);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(roleNames));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache status-action-role matrix in Redis; using LRU fallback");
    }
  }
  lruCache.set(key, roleNames, ttlSeconds);
}

export async function invalidateStatusActionRoles(tenantId: string, status: string, action: string): Promise<void> {
  const key = getCacheKey(tenantId, status, action);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ error, key }, "Failed to invalidate status-action-role cache in Redis");
    }
  }
  lruCache.delete(key);
}
