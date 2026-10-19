import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { buildLicenseStatus } from "./license.service.js";

export const licenseRoutes = Router();

/**
 * GET /license/status — any authenticated user (the frontend banner and menu read it). Contract section 5.
 * Mounted behind `authenticate` only (not tenantContext): the answer is installation-wide, and not holding a
 * pooled connection for the whole request keeps a polled endpoint cheap.
 */
licenseRoutes.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await buildLicenseStatus());
  }),
);
