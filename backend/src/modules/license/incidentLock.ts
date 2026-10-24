/**
 * The incident lock: read-only containment shared with SSO and GMS (SSO: SSO's `incidentLock.ts`; keep the three in step).
 *
 * A lock is a FILE whose path is INCIDENT_LOCK_FILE. While it exists, every state-changing request is answered 403 INCIDENT_READ_ONLY except sign-in and
 * sign-out, health and the licence routes (the same allowlists the licence's read-only state uses); reads keep working. Unset path = off. The file holds a
 * small JSON object { at, reason, kind } and NO secret. It is a file so the out-of-process watcher (not part of this edition) can create it while every
 * application is down, and the owner removes it from a terminal, never through the web.
 *
 * The stat result is cached for ~3 s. A path that cannot be inspected for any reason except "does not exist" counts as NOT locked (fail open).
 */
import fs from "node:fs";
import { logger } from "../../core/logger.js";

export interface IncidentLockInfo {
  at: string | null;
  reason: string | null;
  kind: string | null;
}

export const INCIDENT_READ_ONLY_MESSAGE = "A security incident is being handled; the system is read-only. Contact the owner.";

const CACHE_MS = 3000;
const cache = new Map<string, { at: number; value: IncidentLockInfo | null }>();
let warned = false;

export function parseLockBody(body: string): IncidentLockInfo {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const s = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
    return { at: s(j.at, 40), reason: s(j.reason, 300), kind: s(j.kind, 100) };
  } catch {
    return { at: null, reason: null, kind: null };
  }
}

export function readIncidentLock(file: string | undefined | null, nowMs: number = Date.now()): IncidentLockInfo | null {
  const lockPath = (file ?? "").trim();
  if (!lockPath) return null;
  const hit = cache.get(lockPath);
  if (hit && nowMs - hit.at < CACHE_MS && nowMs >= hit.at) return hit.value;
  let value: IncidentLockInfo | null = null;
  try {
    if (fs.statSync(lockPath).isFile()) {
      let body = "";
      try {
        body = fs.readFileSync(lockPath, "utf8").slice(0, 4096);
      } catch {
        /* exists but unreadable: still locked */
      }
      value = parseLockBody(body);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && !warned) {
      warned = true;
      logger.warn({ code }, "incident: the lock path could not be checked; treating it as not locked");
    }
  }
  cache.set(lockPath, { at: nowMs, value });
  return value;
}

/** Test hook. */
export function resetIncidentLockCache(): void {
  cache.clear();
  warned = false;
}
