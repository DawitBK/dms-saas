// PHASE-6 perf: user -> department-id list cache with Redis + LRU fallback.
// Modeled on aclCache.ts (TDD §5.1 pattern) — 300s TTL with invalidation on
// mutation (UserDepartment rows created/destroyed).

import { logger } from "../../core/logger.js";
import { QueryTypes } from "sequelize";
import { getCacheRedis } from "./redis.js";
import { invalidateReadableFoldersForUser } from "./readableFoldersCache.js";
import { sequelize } from "../database/sequelize.js";

const TTL_SECONDS = 300; // 5 minutes, consistent with aclCache
const LRU_MAX_SIZE = 1000; // Max entries in-memory when Redis unavailable

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * In-memory LRU cache fallback when Redis is unavailable
 */
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

const lruCache = new LRUCache<string[]>();

function getCacheKey(tenantId: string, userId: string): string {
  return `dms:user-depts:${tenantId}:${userId}`;
}

/**
 * Retrieve a user's cached department id list.
 */
export async function getCachedUserDepartments(tenantId: string, userId: string): Promise<string[] | null> {
  const key = getCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as string[];
      }
      return null;
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve user departments from Redis; checking LRU fallback");
      return lruCache.get(key);
    }
  }

  return lruCache.get(key);
}

/**
 * Cache a user's department id list.
 */
export async function cacheUserDepartments(
  tenantId: string,
  userId: string,
  departmentIds: string[],
  ttlSeconds: number = TTL_SECONDS
): Promise<void> {
  const key = getCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(departmentIds));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache user departments in Redis; using LRU fallback");
    }
  }
  lruCache.set(key, departmentIds, ttlSeconds);
}

/**
 * Invalidate a user's cached department id list (call whenever that user's
 * UserDepartment rows are created or destroyed).
 */
export async function invalidateUserDepartments(tenantId: string, userId: string): Promise<void> {
  const key = getCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ error, key }, "Failed to invalidate user departments cache in Redis");
    }
  }

  lruCache.delete(key);

  // Folder visibility (listReadableFolders) depends on this same user's
  // department membership — piggyback on this invalidation path rather than
  // touching every one of invalidateUserDepartments' existing call sites.
  await invalidateReadableFoldersForUser(tenantId, userId).catch((err) =>
    logger.warn({ err, tenantId, userId }, "Failed to invalidate readable-folders cache alongside user departments"),
  );
}

/** Load a membership list from the authoritative tenant-scoped join on a cache miss. */
export async function loadUserDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ departmentId: string }>(
    `SELECT ud.department_id AS "departmentId"
       FROM user_departments ud
       JOIN departments d ON d.id = ud.department_id
      WHERE ud.user_id = :userId AND d.tenant_id = :tenantId`,
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => row.departmentId);
}
