// Tenant-wide aggregates and ACL-gated renderings must not be handed out
// to everyone who can merely read a document.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { AppError } from "../src/core/AppError.js";

const mockGetStorageAnalytics = jest.fn().mockResolvedValue({ summary: {} });
jest.mock("../src/modules/reports/storage.service.js", () => ({ getStorageAnalytics: (...a: unknown[]) => mockGetStorageAnalytics(...a) }));
jest.mock("../src/modules/reports/reports.service.js", () => ({
  listReports: () => [{ key: "document-inventory", requiredPermission: "audit:read" }],
  getReportDef: jest.fn(), runReport: jest.fn(), reportToCsv: jest.fn(),
}));
jest.mock("../src/modules/reports/dashboard.service.js", () => ({ getDashboard: jest.fn() }));
jest.mock("../src/shared/auth.js", () => {
  const { AppError: Err } = jest.requireActual("../src/core/AppError.js");
  const gate = (ok: (p: string[]) => boolean) => (req: { user: { permissions: string[] } }, _res: unknown, next: (e?: unknown) => void) =>
    ok(req.user.permissions) ? next() : next(new Err(403, "ERR-PERMISSION-DENIED", "denied"));
  return {
    requirePermission: (p: string) => gate((perms) => perms.includes(p)),
    requireAnyPermission: (...ps: string[]) => gate((perms) => ps.some((p) => perms.includes(p))),
  };
});

import { ROLE_PERMISSIONS } from "../src/config/permissions.js";

async function get(role: string) {
  const { reportRoutes } = await import("../src/modules/reports/reports.routes.js");
  const app = express();
  const use = app.use.bind(app) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).user = { userId: "u", tenantId: "t1", role, permissions: ROLE_PERMISSIONS[role] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    next();
  });
  use("/reports", reportRoutes);
  use((e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(e instanceof AppError ? e.statusCode : 500).json({});
  });
  return request(app).get("/reports/storage/analytics");
}

describe("GET /reports/storage/analytics (tenant-wide totals per department/type/status)", () => {
  it("is refused to ordinary document readers", async () => {
    for (const role of ["EMPLOYEE", "DEPT_MANAGER", "APPROVER"]) {
      expect((await get(role)).status).toBe(403);
    }
    expect(mockGetStorageAnalytics).not.toHaveBeenCalled();
  });

  it("is available to the oversight roles (document:read_all)", async () => {
    for (const role of ["SYSTEM_ADMIN", "RECORDS_OFFICER", "AUDITOR", "EXECUTIVE"]) {
      expect((await get(role)).status).toBe(200);
    }
  });
});

describe("document preview cache header", () => {
  it("is private: an ACL-gated rendering must not be storable by a shared cache", () => {
    const source = readFileSync(join(__dirname, "../src/modules/documents/documents.routes.ts"), "utf8");
    const preview = source.slice(source.indexOf("'/:id/preview'"), source.indexOf("'/:id/preview'") + 1200);
    expect(preview).toContain("'private, max-age=3600'");
    expect(preview).not.toMatch(/Cache-Control',\s*'public/);
  });
});
