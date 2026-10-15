// ACL resolution cache: Redis, with an in-process LRU fallback when Redis is
// unavailable. 300s TTL, invalidated on every ACL mutation (TDD §5.1).
//
// This caches RESOLUTIONS — the answer to "may this user do X to this
// resource", which is what resolveACL() computes by walking folder and
// department ancestry. It deliberately does not cache individual acl_entries
// rows: an earlier layer that did was removed once nothing read from it, and
// its Redis key prefix (dms:acl:) no longer exists. Only dms:aclr: is written.

import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";
import type { AclResolutionResult } from "../../shared/resolveACL.js";
import { invalidateReadableFoldersForTenant } from "./readableFoldersCache.js";

const TTL_SECONDS = 300; // 5 minutes per TDD §5.1
const LRU_MAX_SIZE = 1000; // Max entries in-memory when Redis unavailable

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * In-memory LRU cache fallback when Redis is unavailable
 */
class LRUCache<T> {
  // Map preserves insertion order; we delete+re-insert on update to keep
  // the entry at the "most recently used" end, so the oldest key is always first.
  private cache: Map<string, CacheEntry<T>> = new Map();

  set(key: string, value: T, ttlSeconds: number = TTL_SECONDS): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    // Delete first so the key moves to the end on re-insertion (LRU order)
    this.cache.delete(key);
    this.cache.set(key, { data: value, expiresAt });

    // Evict the least-recently-used (first) entry when over the size limit
    if (this.cache.size > LRU_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  get(key: string): T | null {
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

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const lruResolutionCache = new LRUCache<AclResolutionResult>();

/**
 * Retrieve a cached ACL resolution result
 */
export async function getCachedResolution(
  tenantId: string,
  resourceType: string,
  resourceId: string,
  userId: string | undefined,
  userRoles: string[] | undefined,
  permission: string
): Promise<AclResolutionResult | null> {
  // Key format: dms:aclr:{tenantId}:{userId|"none"}:{sorted,role,list|"none"}:{resourceType}:{resourceId}:{permission}
  // Roles are sorted so the same role set always hits the same key regardless
  // of the order the caller's roles array happens to be in.
  const rolesKey = userRoles && userRoles.length > 0 ? [...userRoles].sort().join(",") : "none";
  const key = `dms:aclr:${tenantId}:${userId || "none"}:${rolesKey}:${resourceType}:${resourceId}:${permission}`;

  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as AclResolutionResult;
      }
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve ACL resolution from Redis; checking LRU fallback");
      return lruResolutionCache.get(key) ?? null;
    }
  }

  return lruResolutionCache.get(key);
}

/**
 * Batched equivalent of getCachedResolution for multiple resourceIds against
 * the same tenant/user/roles/permission — one Redis round-trip (mget) instead
 * of one GET per resourceId. Falls back to the LRU cache per-key when Redis
 * is unavailable or the mget itself fails. Returns only the ids that were
 * actually found (a hit); callers treat a missing id as a cache miss.
 */
export async function getCachedResolutionsBatch(
  tenantId: string,
  resourceType: string,
  resourceIds: string[],
  userId: string | undefined,
  userRoles: string[] | undefined,
  permission: string
): Promise<Map<string, AclResolutionResult>> {
  const hits = new Map<string, AclResolutionResult>();
  if (resourceIds.length === 0) return hits;

  const rolesKey = userRoles && userRoles.length > 0 ? [...userRoles].sort().join(",") : "none";
  const keyFor = (resourceId: string) =>
    `dms:aclr:${tenantId}:${userId || "none"}:${rolesKey}:${resourceType}:${resourceId}:${permission}`;
  const keys = resourceIds.map(keyFor);

  const redis = getCacheRedis();
  if (redis) {
    try {
      const values = await redis.mget(...keys);
      values.forEach((raw: string | null, i: number) => {
        if (raw) hits.set(resourceIds[i], JSON.parse(raw) as AclResolutionResult);
      });
      return hits;
    } catch (error) {
      logger.warn({ error }, "Failed to batch-retrieve ACL resolutions from Redis; checking LRU fallback");
    }
  }

  resourceIds.forEach((id, i) => {
    const cached = lruResolutionCache.get(keys[i]);
    if (cached) hits.set(id, cached);
  });
  return hits;
}

/**
 * Cache an ACL resolution result
 */
export async function cacheResolution(
  tenantId: string,
  resourceType: string,
  resourceId: string,
  userId: string | undefined,
  userRoles: string[] | undefined,
  permission: string,
  result: AclResolutionResult,
  ttlSeconds: number = TTL_SECONDS
): Promise<void> {
  // Key format: dms:aclr:{tenantId}:{userId|"none"}:{sorted,role,list|"none"}:{resourceType}:{resourceId}:{permission}
  // Must match getCachedResolution's key derivation exactly (same sort+join).
  const rolesKey = userRoles && userRoles.length > 0 ? [...userRoles].sort().join(",") : "none";
  const key = `dms:aclr:${tenantId}:${userId || "none"}:${rolesKey}:${resourceType}:${resourceId}:${permission}`;

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(result));
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache ACL resolution in Redis; using LRU fallback");
      lruResolutionCache.set(key, result, ttlSeconds);
    }
  } else {
    lruResolutionCache.set(key, result, ttlSeconds);
  }
}

/**
 * Non-blocking scan and delete helper using redis.scanStream.
 * Accepts the redis client directly to avoid redundant getCacheRedis() calls per pattern.
 */
async function scanAndDelete(redis: NonNullable<ReturnType<typeof getCacheRedis>>, pattern: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({
      match: pattern,
      count: 100
    });

    stream.on("data", async (keys: string[]) => {
      if (keys.length > 0) {
        stream.pause();
        try {
          await redis.del(...keys);
        } catch (error) {
          logger.warn({ error, keys }, "Failed to delete keys during scan");
        } finally {
          stream.resume();
        }
      }
    });

    stream.on("end", () => {
      resolve();
    });

    stream.on("error", (err: any) => {
      logger.error({ err, pattern }, "Redis scan error");
      reject(err);
    });
  });
}

/**
 * Invalidate every cached resolution touching one resource.
 *   dms:aclr:{tenantId}:*:*:{resourceType}:{resourceId}:*
 */
export async function invalidateResourceACL(
  tenantId: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  const redis = getCacheRedis();
  if (redis) {
    const pattern = `dms:aclr:${tenantId}:*:*:${resourceType}:${resourceId}:*`;
    await scanAndDelete(redis, pattern).catch((err) =>
      logger.warn({ err, pattern }, "Failed to invalidate resource ACL cache")
    );
  }

  lruResolutionCache.clear();
}

/**
 * Invalidate every cached resolution for a tenant.
 *   dms:aclr:{tenantId}:*
 */
export async function invalidateTenantACL(tenantId: string): Promise<void> {
  const redis = getCacheRedis();
  if (redis) {
    const pattern = `dms:aclr:${tenantId}:*`;
    await scanAndDelete(redis, pattern).catch((err) =>
      logger.warn({ err, pattern }, "Failed to invalidate tenant ACL cache")
    );
  }

  lruResolutionCache.clear();

  // Folder ACL/department-structure changes flow through this same
  // "tenant ACL changed" invalidation path — piggyback on it rather than
  // touching every one of invalidateTenantACL's existing call sites.
  await invalidateReadableFoldersForTenant(tenantId).catch((err) =>
    logger.warn({ err, tenantId }, "Failed to invalidate readable-folders cache alongside tenant ACL"),
  );
}
