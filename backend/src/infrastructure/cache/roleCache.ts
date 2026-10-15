// PHASE-6 perf: role -> permissions cache with Redis + LRU fallback.
// Modeled on aclCache.ts (TDD §5.1 pattern) — 300s TTL with invalidation on
// mutation (RolePermission rows written/replaced).

import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";
import type { Permission } from "../../config/permissions.js";

const TTL_SECONDS = 300; // 5 minutes, consistent with aclCache
const LRU_MAX_SIZE = 1000; // Max entries in-memory when Redis unavailable

export interface ResolvedUserOverrides {
  grants: Permission[];
  revokes: Permission[];
}

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

const lruCache = new LRUCache<Permission[]>();
const userOverrideLruCache = new LRUCache<ResolvedUserOverrides>();

function getCacheKey(tenantId: string, roleId: string): string {
  return `dms:role-perms:${tenantId}:${roleId}`;
}

function getUserOverrideCacheKey(tenantId: string, userId: string): string {
  return `dms:user-perm-overrides:${tenantId}:${userId}`;
}

/**
 * Retrieve cached resolved permissions for a role.
 */
export async function getCachedRolePermissions(
  tenantId: string,
  roleId: string
): Promise<Permission[] | null> {
  const key = getCacheKey(tenantId, roleId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as Permission[];
      }
      return null;
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve role permissions from Redis; checking LRU fallback");
      return lruCache.get(key);
    }
  }

  return lruCache.get(key);
}

/**
 * Cache resolved permissions for a role.
 */
export async function cacheRolePermissions(
  tenantId: string,
  roleId: string,
  permissions: Permission[],
  ttlSeconds: number = TTL_SECONDS
): Promise<void> {
  const key = getCacheKey(tenantId, roleId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(permissions));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache role permissions in Redis; using LRU fallback");
    }
  }
  lruCache.set(key, permissions, ttlSeconds);
}

/**
 * Invalidate the cached permissions for a single role (call whenever
 * RolePermission rows for that role/tenant are written or replaced).
 */
export async function invalidateRolePermissions(tenantId: string, roleId: string): Promise<void> {
  const key = getCacheKey(tenantId, roleId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ error, key }, "Failed to invalidate role permissions cache in Redis");
    }
  }

  lruCache.delete(key);
}

/**
 * Retrieve cached resolved permission overrides for a user.
 */
export async function getCachedUserPermissionOverrides(
  tenantId: string,
  userId: string
): Promise<ResolvedUserOverrides | null> {
  const key = getUserOverrideCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as ResolvedUserOverrides;
      }
      return null;
    } catch (error) {
      logger.warn({ error, key }, "Failed to retrieve user permission overrides from Redis; checking LRU fallback");
      return userOverrideLruCache.get(key);
    }
  }

  return userOverrideLruCache.get(key);
}

/**
 * Cache resolved permission overrides for a user.
 */
export async function cacheUserPermissionOverrides(
  tenantId: string,
  userId: string,
  overrides: ResolvedUserOverrides,
  ttlSeconds: number = TTL_SECONDS
): Promise<void> {
  const key = getUserOverrideCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(overrides));
      return;
    } catch (error) {
      logger.warn({ error, key }, "Failed to cache user permission overrides in Redis; using LRU fallback");
    }
  }
  userOverrideLruCache.set(key, overrides, ttlSeconds);
}

/**
 * Invalidate the cached permission overrides for a single user (call whenever
 * UserPermissionOverride rows for that user/tenant are written or replaced).
 */
export async function invalidateUserPermissionOverrides(tenantId: string, userId: string): Promise<void> {
  const key = getUserOverrideCacheKey(tenantId, userId);

  const redis = getCacheRedis();
  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      logger.warn({ error, key }, "Failed to invalidate user permission overrides cache in Redis");
    }
  }

  userOverrideLruCache.delete(key);
}
