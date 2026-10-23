/**
 * Read-only containment while an incident lock is in force (incidentLock.ts). Mounted next to licenseGate: FIRST on the v1 router and in front of the TUS upload.
 *
 * Refuses POST/PUT/PATCH/DELETE with 403 INCIDENT_READ_ONLY unless the request is one the licence's own states already let through: the read-only allowlist
 * (sign-in, sign-out, tenant/role selection, 2FA, the licence routes, health) or the entitlement exemptions. Safe methods always pass. No INCIDENT_LOCK_FILE:
 * no effect. Fails open on any fault, like the licence gate.
 */
import type { NextFunction, Request, Response } from "express";
import { config } from "../../config/env.js";
import { AppError } from "../../core/AppError.js";
import { INCIDENT_READ_ONLY_MESSAGE, readIncidentLock, type IncidentLockInfo } from "./incidentLock.js";
import { apiRelativePath, isAllowlisted, isEntitlementExempt } from "./licenseGate.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const INCIDENT_READ_ONLY_CODE = "INCIDENT_READ_ONLY";

export function createIncidentGate(lock: () => IncidentLockInfo | null = () => readIncidentLock(config.INCIDENT_LOCK_FILE)) {
  return function incidentGate(req: Request, _res: Response, next: NextFunction): void {
    try {
      if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
      const rel = apiRelativePath(req);
      if (isAllowlisted(req.method, rel) || isEntitlementExempt(req.method, rel)) return next();
      const info = lock();
      if (!info) return next();
      return next(new AppError(403, INCIDENT_READ_ONLY_CODE, INCIDENT_READ_ONLY_MESSAGE, { reason: info.kind ?? undefined }));
    } catch {
      return next();
    }
  };
}

export const incidentGate = createIncidentGate();
