// Regression: the platform-vault check functions are SECURITY DEFINER, so they run as their owner. When the vault migration was applied as the
// application role itself, they are owned by the role the migration locked out of the vault tables, and every insert into user_roles fails with
// "permission denied for table platform_vault_unlocked" - with no symptom until someone assigns a role (found on the mirror, 2026-10-15).
// GET /operations/ready now lists "platform-vault-owner" under `degraded` (status stays 200: the system runs, role assignment does not).

import request from "supertest";
import express from "express";

const mockQuery = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
  DocumentDek: {},
  OutboxEvent: { count: jest.fn().mockResolvedValue(0) },
}));
jest.mock("../src/infrastructure/cache/redis.js", () => ({
  getCacheRedis: () => ({ ping: jest.fn().mockResolvedValue("PONG") }),
  getRedis: () => ({ ping: jest.fn().mockResolvedValue("PONG"), get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() }),
}));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({
  getAntivirusStatus: jest.fn().mockResolvedValue({ enabled: false, reachable: false, cooldownActive: false }),
}));
jest.mock("../src/infrastructure/storage/minio.js", () => ({ minioClient: { bucketExists: jest.fn().mockResolvedValue(true) } }));
jest.mock("../src/infrastructure/queue/workers/index.js", () => ({ getWorkerHealthStatus: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock("../src/shared/auth.js", () => ({
  authenticate: (_q: unknown, _r: unknown, n: () => void) => n(),
  requirePermission: () => (_q: unknown, _r: unknown, n: () => void) => n(),
  requireAnyPermission: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));
jest.mock("../src/shared/middleware.js", () => ({ tenantContext: (_q: unknown, _r: unknown, n: () => void) => n() }));

let router: express.Router;
let resetCache: () => void;

beforeAll(async () => {
  const mod = await import("../src/modules/operations/operations.routes.js");
  router = mod.operationsRoutes;
  resetCache = mod.__resetHealthCache;
});

const app = () => express().use("/operations", router);

function vaultRow(row: { owned_by_app: boolean; app_is_super: boolean } | null) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/platform_vault_is_unlocked/.test(sql)) return [row ? [row] : [], undefined];
    return [[{ "?column?": 1 }], undefined];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetCache();
});

describe("GET /operations/ready and the platform-vault function owner", () => {
  it("reports the defect as degraded (still 200) when the application role owns the vault functions", async () => {
    vaultRow({ owned_by_app: true, app_is_super: false });
    const res = await request(app()).get("/operations/ready");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toContain("platform-vault-owner");
  });

  it("is silent when the functions are owned by someone else (the correct, superuser-owned state)", async () => {
    vaultRow({ owned_by_app: false, app_is_super: false });
    const res = await request(app()).get("/operations/ready");
    expect(res.body.degraded).not.toContain("platform-vault-owner");
  });

  it("is silent when the application connects as a superuser (development)", async () => {
    vaultRow({ owned_by_app: true, app_is_super: true });
    const res = await request(app()).get("/operations/ready");
    expect(res.body.degraded).not.toContain("platform-vault-owner");
  });

  it("is silent on a schema that predates the vault migration", async () => {
    vaultRow(null);
    const res = await request(app()).get("/operations/ready");
    expect(res.body.degraded).not.toContain("platform-vault-owner");
  });
});
