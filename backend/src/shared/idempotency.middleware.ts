import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { IdempotencyKey } from "../infrastructure/database/models/index.js";
import { logger } from "../core/logger.js";

// Wires up the IdempotencyKey table (previously modeled and migrated, never
// read or written anywhere). Scoped to one-shot, state-transitioning actions
// where a lost response after a successful write is the realistic failure
// mode — decideStep (letter approval) and e-sign completion are already
// guarded against duplicate SIDE EFFECTS by their own status transitions
// (a retry 409s instead of double-approving/double-signing), but that 409
// looks like an error to a client whose original request actually
// succeeded and just never got the response back. Replaying the ORIGINAL
// response for the same key fixes that without touching the state guards.
//
// Opt-in: only activates when the caller sends an Idempotency-Key header,
// so clients that don't send one behave exactly as before this existed.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type CachedResponse = { status: number; body: unknown };

export function idempotent(endpointName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key");
    if (!key) return next();

    // Cast at the point of use, matching this codebase's existing pattern
    // for req.user (see tusUpload.ts) rather than a new global augmentation.
    const userId = (req as any).user?.userId as string | undefined;
    if (!userId) return next();

    // Fingerprints the BODY too, not just user+endpoint — the same key,
    // user, and endpoint reused with a genuinely different body used to
    // silently replay the first request's response instead of being
    // rejected as a key-reuse conflict.
    const bodyHash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");

    try {
      const existing = await IdempotencyKey.findOne({ where: { key } });
      if (existing) {
        const bodyMismatch = existing.bodyHash != null && existing.bodyHash !== bodyHash;
        if (existing.userId !== userId || existing.endpoint !== endpointName || bodyMismatch) {
          res.status(409).json({
            error: {
              code: "ERR-IDEMPOTENCY-KEY-REUSED",
              message: "This Idempotency-Key was already used for a different request",
            },
          });
          return;
        }
        if (existing.expiresAt.getTime() < Date.now()) {
          await existing.destroy().catch(() => {});
        } else {
          const cached = JSON.parse(existing.responseBody) as CachedResponse;
          res.status(cached.status).json(cached.body);
          return;
        }
      }
    } catch (err) {
      // Lookup failure must not block the request — fall through and let it
      // execute normally, same fail-open policy as everywhere else in this
      // codebase that treats a cache as an optimization, not a gate.
      logger.warn({ err, key, endpoint: endpointName }, "idempotency-key lookup failed — proceeding without it");
    }

    // Persisting the record happens after res.json is actually called (i.e.
    // after the handler's own domain transaction, if any, has already
    // committed) — best-effort, same as the async-scan/PAdES notification
    // patterns elsewhere: a crash between that commit and this write just
    // means a retry behaves like it did before this middleware existed
    // (re-executes, hits the state-guard 409), never worse.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        IdempotencyKey.upsert({
          key,
          userId,
          endpoint: endpointName,
          bodyHash,
          responseBody: JSON.stringify({ status, body } satisfies CachedResponse),
          expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
        }).catch((err) => {
          logger.warn({ err, key, endpoint: endpointName }, "failed to persist idempotency record");
        });
      }
      return originalJson(body);
    }) as typeof res.json;

    next();
  };
}
