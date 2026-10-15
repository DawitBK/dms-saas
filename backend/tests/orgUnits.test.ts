// CAMS org-units router — the module had zero jest coverage (only the live
// verifiers touched it). Mounted on a minimal express app with the OrgUnit
// model + permission middleware mocked; proves tenant scoping, the FLAT
// hierarchy invariant (parent_unit_id never accepted from the API), code
// validation, deactivation semantics, and letterhead-title handling.

const mockOrgUnit = { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  OrgUnit: mockOrgUnit,
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// The listing route now scopes ordinary users to their visible units.  Keep
// this router unit test database-free while exercising that real path.
const mockGetVisibleOrgUnitIds = jest.fn().mockResolvedValue(new Set(["u1"]));
jest.mock("../src/modules/departments/departments.service.js", () => ({
  getVisibleOrgUnitIds: (...args: unknown[]) => mockGetVisibleOrgUnitIds(...args),
}));

// requirePermission passes through but records what each route demanded.
const requiredPermissions: string[] = [];
jest.mock("../src/shared/auth.js", () => ({
  requirePermission: (perm: string) => (_req: unknown, _res: unknown, next: () => void) => {
    requiredPermissions.push(perm);
    next();
  },
}));

import express from "express";
import request from "supertest";
import { orgUnitsRoutes } from "../src/modules/org-units/orgUnits.routes.js";
import { AppError } from "../src/core/AppError.js";

const TENANT = "examplecorp";

function makeApp() {
  const app = express();
  // Same Express-5 typings dodge app.ts uses for middleware registration.
  const use = app.use.bind(app) as any;
  use(express.json());
  use((req: any, _res: unknown, next: () => void) => {
    req.user = {
      userId: "u-admin",
      tenantId: TENANT,
      role: "SYSTEM_ADMIN",
      permissions: [],
    };
    next();
  });
  use("/org-units", orgUnitsRoutes);
  use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ code: err.code, message: err.message });
    // zod parse errors surface as 400s here (prod uses the shared error middleware)
    return res.status(err?.name === "ZodError" ? 400 : 500).json({ message: err?.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetVisibleOrgUnitIds.mockResolvedValue(new Set(["u1"]));
  requiredPermissions.length = 0;
});

describe("GET /org-units", () => {
  it("lists active units scoped to the caller's tenant", async () => {
    mockOrgUnit.findAll.mockResolvedValue([{ id: "u1", code: "HQ" }]);
    const res = await request(makeApp()).get("/org-units");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const where = mockOrgUnit.findAll.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: TENANT, isActive: true });
    expect(requiredPermissions).toContain("orgunit:read");
  });

  it("includeInactive=true drops the isActive filter but never the tenant filter", async () => {
    mockOrgUnit.findAll.mockResolvedValue([]);
    await request(makeApp()).get("/org-units?includeInactive=true");
    const where = mockOrgUnit.findAll.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
    expect(where.isActive).toBeUndefined();
  });
});

describe("POST /org-units", () => {
  const valid = { code: "GELANA", name: "Gelana Branch", unitType: "BRANCH" };

  it("creates a unit as a FLAT sibling — parentUnitId is forced null even if sent", async () => {
    mockOrgUnit.findOne.mockResolvedValue(null);
    mockOrgUnit.create.mockImplementation(async (attrs: any) => ({ ...attrs, id: "u-new" }));

    const res = await request(makeApp())
      .post("/org-units")
      .send({ ...valid, parentUnitId: "some-other-unit" });

    expect(res.status).toBe(201);
    expect(mockOrgUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, code: "GELANA", parentUnitId: null }),
    );
    expect(requiredPermissions).toContain("orgunit:manage");
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });

  it("rejects lowercase / malformed codes (uppercase letters, digits, dashes)", async () => {
    const res = await request(makeApp()).post("/org-units").send({ ...valid, code: "gelana!" });
    expect(res.status).toBe(400);
    expect(mockOrgUnit.create).not.toHaveBeenCalled();
  });

  it("rejects unknown unit types", async () => {
    const res = await request(makeApp()).post("/org-units").send({ ...valid, unitType: "REGION" });
    expect(res.status).toBe(400);
  });

  it("409s on a duplicate code within the tenant", async () => {
    mockOrgUnit.findOne.mockResolvedValue({ id: "u1", code: "GELANA" });
    const res = await request(makeApp()).post("/org-units").send(valid);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ERR-ORG-UNIT-EXISTS");
  });

  it("stores a trimmed letterheadTitle and maps empty to null", async () => {
    mockOrgUnit.findOne.mockResolvedValue(null);
    mockOrgUnit.create.mockImplementation(async (attrs: any) => ({ ...attrs, id: "u-new" }));

    await request(makeApp()).post("/org-units").send({ ...valid, letterheadTitle: "  Gelana Coffee PLC  " });
    expect(mockOrgUnit.create).toHaveBeenCalledWith(expect.objectContaining({ letterheadTitle: "Gelana Coffee PLC" }));

    mockOrgUnit.create.mockClear();
    await request(makeApp()).post("/org-units").send({ ...valid, code: "GELANA2", letterheadTitle: "   " });
    expect(mockOrgUnit.create).toHaveBeenCalledWith(expect.objectContaining({ letterheadTitle: null }));
  });
});

describe("PATCH /org-units/:id", () => {
  function existingUnit(overrides: Record<string, unknown> = {}) {
    return {
      id: "u1", tenantId: TENANT, code: "HQ", name: "Head Quarters",
      unitType: "HQ", isActive: true,
      update: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("404s for a unit in another tenant (scoped lookup)", async () => {
    mockOrgUnit.findOne.mockResolvedValue(null);
    const res = await request(makeApp()).patch("/org-units/u-foreign").send({ name: "X" });
    expect(res.status).toBe(404);
    const where = mockOrgUnit.findOne.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
  });

  it("updates only the provided fields", async () => {
    const unit = existingUnit();
    mockOrgUnit.findOne.mockResolvedValue(unit);
    const res = await request(makeApp()).patch("/org-units/u1").send({ name: "Renamed HQ" });
    expect(res.status).toBe(200);
    expect(unit.update).toHaveBeenCalledWith({ name: "Renamed HQ" });
  });

  it("deactivation writes the DEACTIVATED audit event", async () => {
    const unit = existingUnit();
    mockOrgUnit.findOne.mockResolvedValue(unit);
    await request(makeApp()).patch("/org-units/u1").send({ isActive: false });
    expect(unit.update).toHaveBeenCalledWith({ isActive: false });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: expect.stringMatching(/DEACTIVATED/i) }),
    );
  });

  it("clears letterheadTitle when null is sent", async () => {
    const unit = existingUnit({ letterheadTitle: "Old Masthead" });
    mockOrgUnit.findOne.mockResolvedValue(unit);
    await request(makeApp()).patch("/org-units/u1").send({ letterheadTitle: null });
    expect(unit.update).toHaveBeenCalledWith({ letterheadTitle: null });
  });

  it("does not accept parentUnitId (flat hierarchy — unknown keys are dropped)", async () => {
    const unit = existingUnit();
    mockOrgUnit.findOne.mockResolvedValue(unit);
    await request(makeApp()).patch("/org-units/u1").send({ name: "HQ", parentUnitId: "u2" });
    expect(unit.update).toHaveBeenCalledWith({ name: "HQ" });
  });
});
