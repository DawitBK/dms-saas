// Perf audit 2026-08-13: listReadableFolders' non-oversight branch (folders
// service) recomputes the user's whole visible-folder set from scratch on
// every call — a tenant-wide FolderNode scan, a department-subtree CTE, an
// AclEntry lookup, and a JS ancestor walk — with zero caching, even though
// it's the function backing every non-admin GET /folders/tree, hit on
// essentially every sidebar/tree navigation click. Modeled on aclCache.ts /
// userDeptCache.ts (TDD §5.1 pattern): Redis + LRU fallback, short TTL.
//
// TTL is intentionally shorter than aclCache's 300s — folder membership
// changes (moves, new folders) are more visible/interactive to users than
// document-level ACL grants, so a tighter staleness window trades a bit of
// cache-hit rate for feeling more "live." It's also actively invalidated
// wherever tenant ACL state or a user's department membership changes (see
// invalidateReadableFoldersForTenant/-ForUser below and their call sites),
// so the TTL mostly only matters when a mutation's invalidation is missed.

import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";

const TTL_SECONDS = 60;
const LRU_MAX_SIZE = 1000;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();

  set(key: string, value: T, ttlSeconds: number = TTL_SECONDS): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.delete(key);
    this.cache.set(key, { data: value, expiresAt });
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

  /** Delete every key currently prefixed by `prefix` (LRU has no SCAN, so this is a linear pass — fine at LRU_MAX_SIZE). */
  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

const lruCache = new LRUCache<any[]>();

// Key order is userId-then-tenantId (not tenantId-then-userId) specifically
// so invalidateReadableFoldersForUser can SCAN-match on a userId prefix —
// invalidateUserDepartments (userDeptCache.ts) only ever receives a userId,
// never a tenantId, so the tenant can't be the leading key segment.
function getCacheKey(userId: string, tenantId: string): string {
  return `dms:readable-folders:${userId}:${tenantId}`;
}

/** Retrieve a user's cached readable-folder list for a tenant (plain JSON objects, not live model instances). */
export async function getCachedReadableFolders(userId: string, tenantId: string): Promise<any[] | null> {
  const key = getCacheKey(userId, tenantId);
  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve readable-folders cache from Redis; checking LRU fallback");
      return lruCache.get(key);
    }
  }
  return lruCache.get(key);
}

/** Cache a user's readable-folder list for a tenant. */
export async function cacheReadableFolders(
  userId: string,
  tenantId: string,
  folders: any[],
  ttlSeconds: number = TTL_SECONDS,
): Promise<void> {
  const key = getCacheKey(userId, tenantId);
  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(folders));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache readable-folders in Redis; using LRU fallback");
    }
  }
  lruCache.set(key, folders, ttlSeconds);
}

async function scanAndDelete(redis: NonNullable<ReturnType<typeof getCacheRedis>>, pattern: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({ match: pattern, count: 100 });
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
    stream.on("end", () => resolve());
    stream.on("error", (err: unknown) => {
      logger.error({ err, pattern }, "Redis scan error");
      reject(err);
    });
  });
}

/** Call alongside invalidateTenantACL — folder ACL/department-structure
 *  changes affect every user's visible-folder set for this tenant. */
export async function invalidateReadableFoldersForTenant(tenantId: string): Promise<void> {
  const redis = getCacheRedis();
  if (redis) {
    await scanAndDelete(redis, `dms:readable-folders:*:${tenantId}`).catch((err) =>
      logger.warn({ err, tenantId }, "Failed to invalidate readable-folders cache for tenant"),
    );
  }
  lruCache.clear();
}

/** Call alongside invalidateUserDepartments — a user's department
 *  membership changing affects their own visible-folder set across
 *  whichever tenants they belong to. */
export async function invalidateReadableFoldersForUser(tenantId: string, userId: string): Promise<void> {
  const key = getCacheKey(userId, tenantId);
  const redis = getCacheRedis();
  if (redis) {
    await redis.del(key).catch((err: unknown) =>
      logger.warn({ err, tenantId, userId }, "Failed to invalidate readable-folders cache for user"),
    );
  }
  lruCache.deleteByPrefix(key);
}
