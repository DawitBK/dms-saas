// S5-07 fix: cross-process cache for the audit hash chain's "last written" state.
//
// writeAuditLog() (audit.service.ts) needs each tenant's {sequenceNumber, entryHash}
// of the most recently written row to compute the next row's previousHash, without
// re-querying Postgres on every write. That cache used to be a plain in-process Map,
// which is only safe if every audit writer runs in the same OS process. This app
// runs the API (`npm run dev`) and the BullMQ worker (`npm run worker`) as separate
// processes against the same DB/Redis, so a Map-per-process meant each process could
// hold a stale "last hash" relative to what the other process had just committed -
// producing false "chain broken" reports from verifyAuditChain() with no actual
// tampering involved.
//
// Backing this with Redis gives both processes one shared view. When Redis is
// unavailable, reads return null (a cache miss) rather than degrading to an
// in-process Map fallback - writeAuditLog()'s existing cold-cache path already
// re-queries the true last row from Postgres on a miss, which is the only way to
// stay correct without a shared store. A local fallback here would silently
// reintroduce the exact cross-process staleness this module exists to prevent.
import { logger } from "../../core/logger.js";
import { getCacheRedis } from "./redis.js";

const KEY_PREFIX = "dms:audit-chain:";
// Safety-net TTL only - every write to a tenant's chain overwrites this key, so
// the TTL just keeps Redis from accumulating keys for tenants that stop writing.
const TTL_SECONDS = 60 * 60 * 24;

export type ChainCacheEntry = { sequenceNumber: bigint; entryHash: string | null };

export async function getChainCacheEntry(cacheKey: string): Promise<ChainCacheEntry | null> {
  const redis = getCacheRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get(KEY_PREFIX + cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sequenceNumber: string; entryHash: string | null };
    return { sequenceNumber: BigInt(parsed.sequenceNumber), entryHash: parsed.entryHash };
  } catch (error) {
    logger.warn({ error, cacheKey }, "Failed to read audit chain cache from Redis; falling back to DB lookup");
    return null;
  }
}

export async function setChainCacheEntry(cacheKey: string, entry: ChainCacheEntry): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) return;

  try {
    await redis.setex(
      KEY_PREFIX + cacheKey,
      TTL_SECONDS,
      JSON.stringify({ sequenceNumber: entry.sequenceNumber.toString(), entryHash: entry.entryHash })
    );
  } catch (error) {
    logger.warn({ error, cacheKey }, "Failed to write audit chain cache to Redis");
  }
}
