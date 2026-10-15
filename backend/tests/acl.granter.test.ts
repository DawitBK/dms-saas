// Regression coverage for the AclEntry.grantedById -> granter association fix
// (the "*By field never resolved to a name" batch), mirroring
// access-rules.granter.test.ts. Same two-layer shape, because the real bug
// lived at the route layer: acl.routes.ts hand-serializes each row into a
// plain object literal in three places (by-resource, single, by-principal)
// and initially forgot `granter` in all three even though the service query
// fetched it correctly.

const mockAclEntry = {
  findAll: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  destroy: jest.fn(),
  count: jest.fn(),
};

jest.mock("../src/infrastructure/database/models/index.js", () => ({
  AclEntry: mockAclEntry,
  Document: { findByPk: jest.fn() },
  FolderNode: { findByPk: jest.fn() },
  Department: { findByPk: jest.fn() },
  WorkflowInstance: { findByPk: jest.fn() },
  WorkflowTask: { findByPk: jest.fn() },
  UserTenant: { findOne: jest.fn() },
  User: {},
}));

jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ LOCK: { UPDATE: "UPDATE" } }),
}));

jest.mock("../src/infrastructure/cache/aclCache.js", () => ({
  invalidateResourceACL: jest.fn().mockResolvedValue(undefined),
  invalidateTenantACL: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let listAclEntries: typeof import("../src/modules/acl/acl.service.js").listAclEntries;
let getAclEntry: typeof import("../src/modules/acl/acl.service.js").getAclEntry;
let listAclEntriesByPrincipal: typeof import("../src/modules/acl/acl.service.js").listAclEntriesByPrincipal;
let createAclEntry: typeof import("../src/modules/acl/acl.service.js").createAclEntry;
let createBulkAclEntries: typeof import("../src/modules/acl/acl.service.js").createBulkAclEntries;

beforeAll(async () => {
  const service = await import("../src/modules/acl/acl.service.js");
  listAclEntries = service.listAclEntries;
  getAclEntry = service.getAclEntry;
  listAclEntriesByPrincipal = service.listAclEntriesByPrincipal;
  createAclEntry = service.createAclEntry;
  createBulkAclEntries = service.createBulkAclEntries;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const GRANTER = { id: "admin-1", firstName: "System", lastName: "Admin", email: "admin@examplecorp.com" };

describe("acl.service — granter association is requested", () => {
  it("listAclEntries includes the granter association", async () => {
    mockAclEntry.findAll.mockResolvedValue([]);
    await listAclEntries("document", "doc-1", "tenant-1");

    const passedInclude = mockAclEntry.findAll.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "granter" })]);
  });

  it("getAclEntry includes the granter association", async () => {
    mockAclEntry.findOne.mockResolvedValue({ id: "acl-1", tenantId: "tenant-1", granter: GRANTER });
    await getAclEntry("acl-1", "tenant-1");

    const passedInclude = mockAclEntry.findOne.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "granter" })]);
  });

  it("listAclEntriesByPrincipal includes the granter association", async () => {
    mockAclEntry.findAll.mockResolvedValue([]);
    await listAclEntriesByPrincipal("user", "user-9", "tenant-1");

    const passedInclude = mockAclEntry.findAll.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "granter" })]);
  });

  it("rejects a role-wide document read grant before it reaches persistence", async () => {
    await expect(createAclEntry(
      "document",
      "doc-1",
      { principalType: "role", principalId: "DEPT_MANAGER", effect: "ALLOW", permission: "document:read" },
      "admin-1",
      "tenant-1",
    )).rejects.toMatchObject({
      statusCode: 400,
      code: "ERR-ACL-DOCUMENT-READ-SCOPE",
    });
    expect(mockAclEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a role-wide folder read grant because folder ACLs inherit to documents", async () => {
    await expect(createAclEntry(
      "folder",
      "folder-1",
      { principalType: "role", principalId: "DEPT_MANAGER", effect: "ALLOW", permission: "document:read" },
      "admin-1",
      "tenant-1",
    )).rejects.toMatchObject({
      statusCode: 400,
      code: "ERR-ACL-DOCUMENT-READ-SCOPE",
    });
    expect(mockAclEntry.create).not.toHaveBeenCalled();
  });

  it("rejects a bulk role-wide document read grant before resource lookups", async () => {
    await expect(createBulkAclEntries(
      "document",
      "doc-1",
      { principalType: "role", principalId: "DEPT_MANAGER", effect: "ALLOW", permissions: ["document:read", "document:download"] },
      "admin-1",
      "tenant-1",
    )).rejects.toMatchObject({
      statusCode: 400,
      code: "ERR-ACL-DOCUMENT-READ-SCOPE",
    });
    expect(mockAclEntry.create).not.toHaveBeenCalled();
    expect(mockAclEntry.findOne).not.toHaveBeenCalled();
  });
});

// ─── Route-level serializer regression ─────────────────────────────────────

import express from "express";
import request from "supertest";
import { AppError } from "../src/core/AppError.js";

function errorHandler(error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ error: { code: "ERR-INTERNAL", message: "Internal server error" } });
}

function buildApp(permissions: string[] = []) {
  const app = express();
  const use = app.use.bind(app) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  use(express.json());
  use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user = { userId: "admin-1", tenantId: "tenant-1", role: "SYSTEM_ADMIN", permissions };
    next();
  });
  return app;
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "acl-1",
    resourceType: "document",
    resourceId: "doc-1",
    principalType: "role",
    principalId: "DEPT_MANAGER",
    effect: "ALLOW",
    permission: "document:read",
    expiresAt: null,
    grantedById: "admin-1",
    granter: GRANTER,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("acl.routes — response body carries granter in all three read shapes", () => {
  it("GET /acl/:resourceType/:resourceId includes granter for each row", async () => {
    mockAclEntry.findAll.mockResolvedValue([makeEntry()]);

    const { aclRoutes } = await import("../src/modules/acl/acl.routes.js");
    const { PERMISSIONS } = await import("../src/config/permissions.js");
    const app = buildApp([PERMISSIONS.ACL_MANAGE]);
    app.use("/acl", aclRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/acl/document/doc-1");

    expect(res.status).toBe(200);
    expect(res.body.data[0].granter).toEqual(GRANTER);
  });

  it("GET /acl/:aclId includes granter for a single entry", async () => {
    mockAclEntry.findOne.mockResolvedValue(makeEntry());

    const { aclRoutes } = await import("../src/modules/acl/acl.routes.js");
    const { PERMISSIONS } = await import("../src/config/permissions.js");
    const app = buildApp([PERMISSIONS.ACL_MANAGE]);
    app.use("/acl", aclRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/acl/acl-1");

    expect(res.status).toBe(200);
    expect(res.body.data.granter).toEqual(GRANTER);
  });

  it("GET /acl?principalType=&principalId= includes granter for each row", async () => {
    mockAclEntry.findAll.mockResolvedValue([makeEntry()]);

    const { aclRoutes } = await import("../src/modules/acl/acl.routes.js");
    const { PERMISSIONS } = await import("../src/config/permissions.js");
    const app = buildApp([PERMISSIONS.ACL_MANAGE]);
    app.use("/acl", aclRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/acl?principalType=role&principalId=DEPT_MANAGER");

    expect(res.status).toBe(200);
    expect(res.body.data[0].granter).toEqual(GRANTER);
  });
});
