// Regression coverage for the AccessRule.grantedById -> granter association
// fix (the "*By field never resolved to a name" batch). Two layers, because
// the real bug lived in the SECOND one: the service-level include was correct
// from the start, but access-rules.routes.ts hand-serializes each row into a
// plain object literal before res.json() — which silently dropped `granter`
// even though the service query fetched it. Fixed by adding `granter` to the
// route's response mappers; this test pins that shape so it can't regress.

const mockAccessRule = { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() };
const mockUser = {};

jest.mock("../src/infrastructure/database/models/index.js", () => ({
  AccessRule: mockAccessRule,
  User: mockUser,
}));

jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ LOCK: { UPDATE: "UPDATE" } }),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/infrastructure/cache/aclCache.js", () => ({
  invalidateTenantACL: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let listAccessRules: typeof import("../src/modules/access-rules/access-rules.service.js").listAccessRules;
let getAccessRule: typeof import("../src/modules/access-rules/access-rules.service.js").getAccessRule;

beforeAll(async () => {
  const service = await import("../src/modules/access-rules/access-rules.service.js");
  listAccessRules = service.listAccessRules;
  getAccessRule = service.getAccessRule;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const GRANTER = { id: "admin-1", firstName: "System", lastName: "Admin", email: "admin@examplecorp.com" };

describe("access-rules.service — granter association is requested", () => {
  it("listAccessRules includes the granter association", async () => {
    mockAccessRule.findAll.mockResolvedValue([]);
    await listAccessRules("tenant-1");

    const passedInclude = mockAccessRule.findAll.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "granter" })]);
  });

  it("getAccessRule includes the granter association", async () => {
    mockAccessRule.findOne.mockResolvedValue({ id: "rule-1", tenantId: "tenant-1", granter: GRANTER });
    await getAccessRule("rule-1", "tenant-1");

    const passedInclude = mockAccessRule.findOne.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "granter" })]);
  });
});

// ─── Route-level serializer regression ─────────────────────────────────────
// This is the actual bug that shipped once: the include above was always
// correct, but the route below hand-picked fields into a new object and
// forgot `granter` — so the API response never carried it despite the
// service fetching it. Exercise the real route handler (not just the
// service) so a future refactor that reintroduces hand-picking is caught.

import express from "express";
import request from "supertest";
import { AppError } from "../src/core/AppError.js";

// A minimal stand-in for shared/middleware.ts's real errorHandler — that
// module wires up pino-http as a module-scope side effect (real logger
// transport), which is unnecessary weight for a route-serializer test that
// only needs AppError -> JSON translation.
function errorHandler(error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ error: { code: "ERR-INTERNAL", message: "Internal server error" } });
}

function buildApp(permissions: string[] = []) {
  const app = express();
  // Express 5's overload resolution rejects a bare RequestHandler here under
  // this repo's @types/express-serve-static-core version — same workaround
  // app.ts itself uses (`const use = app.use.bind(app) as any`).
  const use = app.use.bind(app) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  use(express.json());
  use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user = { userId: "admin-1", tenantId: "tenant-1", role: "SYSTEM_ADMIN", permissions };
    next();
  });
  return app;
}

describe("access-rules.routes — response body carries granter (not stripped by hand-serialization)", () => {
  it("GET /access-rules includes granter for each row", async () => {
    mockAccessRule.findAll.mockResolvedValue([
      {
        id: "rule-1",
        principalType: "role",
        principalId: "DEPT_MANAGER",
        effect: "ALLOW",
        permission: "document:read",
        documentTypeId: null,
        expiresAt: null,
        grantedById: "admin-1",
        granter: GRANTER,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const { accessRulesRoutes } = await import("../src/modules/access-rules/access-rules.routes.js");
    const { PERMISSIONS } = await import("../src/config/permissions.js");
    const app = buildApp([PERMISSIONS.ACL_MANAGE]);
    app.use("/access-rules", accessRulesRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/access-rules");

    expect(res.status).toBe(200);
    expect(res.body.data[0].granter).toEqual(GRANTER);
  });

  it("GET /access-rules/:id includes granter", async () => {
    mockAccessRule.findOne.mockResolvedValue({
      id: "rule-1",
      tenantId: "tenant-1",
      principalType: "role",
      principalId: "DEPT_MANAGER",
      effect: "ALLOW",
      permission: "document:read",
      documentTypeId: null,
      expiresAt: null,
      grantedById: "admin-1",
      granter: GRANTER,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const { accessRulesRoutes } = await import("../src/modules/access-rules/access-rules.routes.js");
    const { PERMISSIONS } = await import("../src/config/permissions.js");
    const app = buildApp([PERMISSIONS.ACL_MANAGE]);
    app.use("/access-rules", accessRulesRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/access-rules/rule-1");

    expect(res.status).toBe(200);
    expect(res.body.data.granter).toEqual(GRANTER);
  });
});
