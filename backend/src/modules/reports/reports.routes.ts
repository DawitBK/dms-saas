/**
 * Compliance report routes.
 * Listing shows only reports the caller is permitted to run; running a report
 * enforces that report's required permission and returns JSON or CSV.
 */
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { listReports, getReportDef, runReport, reportToCsv } from "./reports.service.js";
import { getStorageAnalytics } from "./storage.service.js";
import { getDashboard } from "./dashboard.service.js";
import { requireAnyPermission, requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";

export const reportRoutes = Router();
const REPORT_REQUIRED_PERMISSIONS = [...new Set(listReports().map((report) => report.requiredPermission))];

function requireReportPermissionByKey() {
  return asyncHandler(async (req, res, next) => {
    const def = getReportDef(String(req.params.key));
    await requirePermission(def.requiredPermission)(req, res, next);
  });
}

reportRoutes.get(
  "/",
  requireAnyPermission(...REPORT_REQUIRED_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const perms = req.user!.permissions;
    const available = listReports().filter((r) => perms.includes(r.requiredPermission));
    res.json({ data: available });
  }),
);

// Storage consumption analytics — before /:key so "storage" isn't read as a report key
// Tenant-wide totals (document counts and bytes per department, type and
// status) — it was open to every document:read holder, so an employee could see
// how much the departments they cannot enter hold. Aggregate over the whole
// tenant = tenant-wide visibility (document:read_all: records officer, auditor,
// executive, administrators), same as the other oversight surfaces.
reportRoutes.get(
  "/storage/analytics",
  requirePermission(PERMISSIONS.DOCUMENT_READ_ALL),
  asyncHandler(async (req, res) => {
    const result = await getStorageAnalytics(req.user!.tenantId);
    res.json({ data: result });
  }),
);

// Reports & Analytics dashboard aggregate (KPIs + trend + breakdowns) — before
// /:key so "dashboard" isn't read as a report key. Gated at the same baseline
// permission as the flat reports it draws from (document-inventory /
// by-department / by-type / by-classification all require AUDIT_READ); a few
// KPI fields are additionally gated inside getDashboard() by the specific
// permission the equivalent standalone report requires.
reportRoutes.get(
  "/dashboard",
  requirePermission(PERMISSIONS.AUDIT_READ),
  asyncHandler(async (req, res) => {
    const filters = {
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null,
      departmentId: req.query.departmentId ? String(req.query.departmentId) : null,
      documentTypeId: req.query.documentTypeId ? String(req.query.documentTypeId) : null,
    };
    const result = await getDashboard(req.user!, filters);
    res.json({ data: result });
  }),
);

// Dashboard widget convenience alias for the "letter-volume" report — same
// data/shape as GET /reports/letter-volume, kept as a stable, memorable path
// for the dashboard widget (before /:key so "letters" isn't read as a key).
reportRoutes.get(
  "/letters/volume",
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const result = await runReport("letter-volume", req.user!.tenantId, { from: null, to: null });
    res.json({ data: result });
  }),
);

reportRoutes.get(
  "/:key",
  requireReportPermissionByKey(),
  asyncHandler(async (req, res) => {
    const def = getReportDef(String(req.params.key));
    const range = {
      from: req.query.from ? String(req.query.from) : null,
      to: req.query.to ? String(req.query.to) : null,
    };
    const result = await runReport(def.key, req.user!.tenantId, range);

    if (String(req.query.format ?? "").toLowerCase() === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${def.key}.csv"`);
      res.send(reportToCsv(result));
      return;
    }
    res.json({ data: result });
  }),
);
