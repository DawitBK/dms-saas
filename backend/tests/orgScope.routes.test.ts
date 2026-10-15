// Organisation scope at the HTTP layer (shared/orgScope.ts wired into the
// department, user, role and document-type routes).
//
// Real routers and the real orgScope module, driven through supertest with a
// stand-in authenticated user. The data layer is faked: the only SQL the scope
// module issues is the managed-subtree walk, the target's department list and
// the target's role names, answered here from per-test fixtures. The services
// behind the routes are jest.fn()s, so "the service was (not) called" is the
// observable proof that the scope check ran first.

import express from "express";
import request from "supertest";

type Fixture = {
  managed: string[]; // departments the ACTOR heads (subtree), answered for the managed-subtree query
  targetDepartments: string[]; // departments the TARGET user belongs to
  targetRoles: string[];
  targetPermissions: string[];
  tenantMember: boolean;
  departmentsInTenant: Record<string, { id: string; tenantId: string; parentId: string | null; isActive?: boolean }>;
};
let fx: Fixture;
const resetFixture = () => {
  fx = {
    managed: [],
    targetDepartments: [],
    targetRoles: ["EMPLOYEE"],
    targetPermissions: [],
    tenantMember: true,
    departmentsInTenant: {},
  };
};

const mockQuery = jest.fn(async (sql: string) => {
  if (sql.includes("WITH RECURSIVE managed")) return fx.managed.map((id) => ({ id }));
  if (sql.includes("FROM user_departments ud JOIN departments d")) return fx.targetDepartments.map((id) => ({ id }));
  if (sql.includes("FROM roles r INNER JOIN user_roles ur")) return fx.targetRoles.map((name) => ({ name }));
  return [];
});

const mockDepartment = {
  findOne: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
    const d = fx.departmentsInTenant[where.id];
    return d && d.tenantId === where.tenantId ? d : null;
  }),
  findAll: jest.fn(async ({ where }: { where: { id: string[]; tenantId: string } }) =>
    where.id.map((id) => fx.departmentsInTenant[id]).filter((d) => d && d.tenantId === where.tenantId)),
};
const mockUserTenant = { findOne: jest.fn(async () => (fx.tenantMember ? { userId: "target" } : null)) };
const mockDocumentType = { findOne: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  UserTenant: mockUserTenant,
  DocumentType: mockDocumentType,
  Role: { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn() },
  sequelize: { query: (...a: unknown[]) => mockQuery(...(a as [string])) },
}));

const mockResolveUnionPermissions = jest.fn(async () => fx.targetPermissions);
const mockReplaceRolePermissions = jest.fn().mockResolvedValue([]);
const mockReplaceOverrides = jest.fn().mockResolvedValue({ grants: [], revokes: [] });
jest.mock("../src/modules/roles/roles.service.js", () => ({
  resolveUnionPermissions: (...a: unknown[]) => (mockResolveUnionPermissions as (...x: unknown[]) => unknown)(...a),
  replaceRolePermissions: (...a: unknown[]) => mockReplaceRolePermissions(...a),
  getRolePermissionsByRoleId: jest.fn(),
  listIdpRoleMappings: jest.fn(),
  getUserPermissionOverrides: jest.fn().mockResolvedValue({ grants: [], revokes: [] }),
  replaceUserPermissionOverrides: (...a: unknown[]) => mockReplaceOverrides(...a),
}));

const svc = {
  createDepartment: jest.fn().mockResolvedValue({ id: "new-dept" }),
  deactivateDepartment: jest.fn().mockResolvedValue({}),
  getDepartment: jest.fn().mockResolvedValue({ id: "d" }),
  getVisibleDepartmentIds: jest.fn().mockResolvedValue(new Set<string>()),
  getVisibleOrgUnitIds: jest.fn().mockResolvedValue(new Set<string>()),
  listDepartmentTree: jest.fn().mockResolvedValue([]),
  listDepartments: jest.fn().mockResolvedValue([]),
  moveDepartment: jest.fn().mockResolvedValue({}),
  updateDepartment: jest.fn().mockResolvedValue({}),
};
jest.mock("../src/modules/departments/departments.service.js", () => svc);

const userSvc = {
  assignDepartment: jest.fn().mockResolvedValue({}),
  assignRole: jest.fn().mockResolvedValue({}),
  createUser: jest.fn().mockResolvedValue({ id: "u" }),
  getUser: jest.fn().mockResolvedValue({ id: "u" }),
  listUsers: jest.fn().mockResolvedValue({ data: [] }),
  removeDepartment: jest.fn().mockResolvedValue(undefined),
  removeRole: jest.fn().mockResolvedValue(undefined),
  updateUser: jest.fn().mockResolvedValue({}),
  getMe: jest.fn(), setSignatureImage: jest.fn(), setExecNoticeOptOut: jest.fn(),
  getNotificationPrefs: jest.fn(), setNotificationPrefs: jest.fn(),
  softDeleteUser: jest.fn().mockResolvedValue({}),
  activateUser: jest.fn().mockResolvedValue({}),
  deactivateUser: jest.fn().mockResolvedValue({}),
  forceLogoutUser: jest.fn().mockResolvedValue({}),
  getUserActivity: jest.fn().mockResolvedValue([]),
};
jest.mock("../src/modules/users/users.service.js", () => userSvc);

const docTypeSvc = {
  createDocumentType: jest.fn().mockResolvedValue({ id: "t" }),
  deactivateDocumentType: jest.fn().mockResolvedValue({}),
  getDocumentType: jest.fn().mockResolvedValue({}),
  listDocumentTypes: jest.fn().mockResolvedValue([]),
  listDocumentTypesForDepartment: jest.fn().mockResolvedValue([]),
  updateDocumentType: jest.fn().mockResolvedValue({}),
};
jest.mock("../src/modules/document-types/documentTypes.service.js", () => docTypeSvc);

jest.mock("../src/shared/platformAdmin.js", () => {
  const { AppError } = jest.requireActual("../src/core/AppError.js");
  return {
    guardPlatformAdminTarget: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    userNotFound: () => new AppError(404, "ERR-USER-NOT-FOUND", "User not found"),
    isPlatformAdminRoleName: (n: string) => n === "PLATFORM_ADMIN",
    withoutPlatformAdminRole: (rows: unknown[]) => rows,
    assertNotHiddenUser: jest.fn(),
  };
});

jest.mock("../src/shared/auth.js", () => {
  const { AppError } = jest.requireActual("../src/core/AppError.js");
  const need = (p: string) => (req: { user: { permissions: string[] } }, _res: unknown, next: (e?: unknown) => void) =>
    req.user.permissions.includes(p) ? next() : next(new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${p}`));
  return {
    requirePermission: need,
    requireAnyPermission: (...ps: string[]) => (req: { user: { permissions: string[] } }, _res: unknown, next: (e?: unknown) => void) =>
      ps.some((p) => req.user.permissions.includes(p)) ? next() : next(new AppError(403, "ERR-PERMISSION-DENIED", "Missing one of")),
    requireSelfOrPermission: (p: string) => (req: { params: { id: string }; user: { userId: string; permissions: string[] } }, _res: unknown, next: (e?: unknown) => void) =>
      req.params.id === req.user.userId || req.user.permissions.includes(p) ? next() : next(new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${p}`)),
  };
});

import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/config/permissions.js";
import { AppError } from "../src/core/AppError.js";

const TENANT = "tenant-1";
const FIN = "00000000-0000-4000-8000-0000000000f1";
const FIN_SUB = "00000000-0000-4000-8000-0000000000f2";
const HR = "00000000-0000-4000-8000-0000000000a1";
const OU = "00000000-0000-4000-8000-0000000000b1";

const deptRow = (id: string, parentId: string | null) => ({ id, tenantId: TENANT, parentId });

function appFor(role: string, mount: (app: express.Express) => void, extraPermissions: string[] = []) {
  const app = express();
  const use = app.use.bind(app) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  use(express.json());
  use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = {
      userId: "actor",
      tenantId: TENANT,
      role,
      roles: [role],
      permissions: [...new Set([...(ROLE_PERMISSIONS[role] ?? []), ...extraPermissions])],
    };
    next();
  });
  mount(app);
  use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ error: { code: "ERR-INTERNAL", message: String(error) } });
  });
  return app;
}

const departmentsApp = async (role: string, extra: string[] = []) => {
  const { departmentRoutes } = await import("../src/modules/departments/departments.routes.js");
  return appFor(role, (a) => (a.use as any).call(a, "/departments", departmentRoutes), extra);
};
const usersApp = async (role: string, extra: string[] = []) => {
  const { userRoutes } = await import("../src/modules/users/users.routes.js");
  return appFor(role, (a) => (a.use as any).call(a, "/users", userRoutes), extra);
};
const rolesApp = async (role: string, extra: string[] = []) => {
  const { rolesRoutes } = await import("../src/modules/roles/roles.routes.js");
  return appFor(role, (a) => (a.use as any).call(a, "/roles", rolesRoutes), extra);
};
const docTypesApp = async (role: string, extra: string[] = []) => {
  const { documentTypeRoutes } = await import("../src/modules/document-types/documentTypes.routes.js");
  return appFor(role, (a) => (a.use as any).call(a, "/document-types", documentTypeRoutes), extra);
};

beforeEach(() => {
  jest.clearAllMocks();
  resetFixture();
  fx.departmentsInTenant = {
    [FIN]: deptRow(FIN, null),
    [FIN_SUB]: deptRow(FIN_SUB, FIN),
    [HR]: deptRow(HR, null),
  };
  svc.getVisibleDepartmentIds.mockResolvedValue(new Set([FIN, FIN_SUB]));
});

describe("departments: a department manager works inside their own subtree", () => {
  it("creates a sub-department under a department they head", async () => {
    fx.managed = [FIN, FIN_SUB];
    const res = await request(await departmentsApp("DEPT_MANAGER"))
      .post("/departments").send({ orgUnitId: OU, code: "FAP", name: "AP", parentId: FIN });
    expect(res.status).toBe(201);
    expect(svc.createDepartment).toHaveBeenCalledTimes(1);
  });

  it("cannot create a sub-department under a sibling department", async () => {
    fx.managed = [FIN, FIN_SUB];
    const res = await request(await departmentsApp("DEPT_MANAGER"))
      .post("/departments").send({ orgUnitId: OU, code: "X", name: "X", parentId: HR });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ERR-DEPT-SCOPE");
    expect(svc.createDepartment).not.toHaveBeenCalled();
  });

  it("cannot create a top-level department (organisation-level authority)", async () => {
    fx.managed = [FIN];
    const res = await request(await departmentsApp("DEPT_MANAGER"))
      .post("/departments").send({ orgUnitId: OU, code: "TOP", name: "Top" });
    expect(res.status).toBe(403);
    expect(svc.createDepartment).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN can create a top-level department", async () => {
    const res = await request(await departmentsApp("SYSTEM_ADMIN"))
      .post("/departments").send({ orgUnitId: OU, code: "TOP", name: "Top" });
    expect(res.status).toBe(201);
  });

  it("a holder of orgunit:manage (organisation administrator) can create a top-level department", async () => {
    const res = await request(await departmentsApp("DEPT_MANAGER", [PERMISSIONS.ORG_UNIT_MANAGE]))
      .post("/departments").send({ orgUnitId: OU, code: "TOP", name: "Top" });
    expect(res.status).toBe(201);
  });

  it("edits their own department and a sub-department, but not a sibling or a parent", async () => {
    fx.managed = [FIN_SUB]; // head of the sub-department only
    const app = await departmentsApp("DEPT_MANAGER");
    expect((await request(app).patch(`/departments/${FIN_SUB}`).send({ name: "Renamed" })).status).toBe(200);
    expect((await request(app).patch(`/departments/${FIN}`).send({ name: "Parent" })).status).toBe(403);
    expect((await request(app).patch(`/departments/${HR}`).send({ name: "Sibling" })).status).toBe(403);
    expect(svc.updateDepartment).toHaveBeenCalledTimes(1);
  });

  it("cannot re-home a department under another org unit", async () => {
    fx.managed = [FIN, FIN_SUB];
    const res = await request(await departmentsApp("DEPT_MANAGER")).patch(`/departments/${FIN_SUB}`).send({ orgUnitId: OU });
    expect(res.status).toBe(403);
    expect(svc.updateDepartment).not.toHaveBeenCalled();
  });

  it("deactivating through PATCH { isActive } follows the same rule as DELETE (the parent's call)", async () => {
    fx.managed = [FIN_SUB];
    const app = await departmentsApp("DEPT_MANAGER");
    const res = await request(app).patch(`/departments/${FIN_SUB}`).send({ isActive: false });
    expect(res.status).toBe(403); // the head of FIN_SUB does not manage FIN_SUB's parent
    expect(svc.updateDepartment).not.toHaveBeenCalled();
    fx.managed = [FIN, FIN_SUB];
    expect((await request(app).patch(`/departments/${FIN_SUB}`).send({ isActive: false })).status).toBe(200);
  });

  it("deactivates a sub-department only as the head of its parent", async () => {
    const app = await departmentsApp("DEPT_MANAGER");
    fx.managed = [FIN_SUB];
    expect((await request(app).delete(`/departments/${FIN_SUB}`)).status).toBe(403);
    fx.managed = [FIN, FIN_SUB];
    expect((await request(app).delete(`/departments/${FIN_SUB}`)).status).toBe(200);
    expect(svc.deactivateDepartment).toHaveBeenCalledTimes(1);
  });

  it("nobody below organisation level can deactivate or move a top-level department", async () => {
    fx.managed = [FIN, FIN_SUB];
    const app = await departmentsApp("DEPT_MANAGER");
    expect((await request(app).delete(`/departments/${FIN}`)).status).toBe(403);
    expect((await request(app).patch(`/departments/${FIN}/move`).send({ parentId: null })).status).toBe(403);
    expect(svc.deactivateDepartment).not.toHaveBeenCalled();
    expect(svc.moveDepartment).not.toHaveBeenCalled();
  });

  it("moves a sub-department only into a department they head, and never to the top level", async () => {
    fx.managed = [FIN, FIN_SUB];
    const app = await departmentsApp("DEPT_MANAGER");
    expect((await request(app).patch(`/departments/${FIN_SUB}/move`).send({ parentId: HR })).status).toBe(403);
    expect((await request(app).patch(`/departments/${FIN_SUB}/move`).send({ parentId: null })).status).toBe(403);
    expect(svc.moveDepartment).not.toHaveBeenCalled();
    fx.departmentsInTenant["sub2"] = deptRow("sub2", FIN);
    fx.managed = [FIN, FIN_SUB, "sub2"];
    expect((await request(app).patch(`/departments/${FIN_SUB}/move`).send({ parentId: "sub2" })).status).toBe(200);
  });

  it("a department from another tenant reads as not found", async () => {
    fx.departmentsInTenant["foreign"] = { id: "foreign", tenantId: "tenant-2", parentId: null };
    const res = await request(await departmentsApp("SYSTEM_ADMIN")).patch("/departments/foreign").send({ name: "x" });
    expect(res.status).toBe(404);
    expect(svc.updateDepartment).not.toHaveBeenCalled();
  });

  it("GET /departments/:id hides departments outside the reader's visible set", async () => {
    const app = await departmentsApp("DEPT_MANAGER");
    expect((await request(app).get(`/departments/${FIN}`)).status).toBe(200);
    expect((await request(app).get(`/departments/${HR}`)).status).toBe(404);
  });

  it("AUDITOR (read-only) cannot create, edit or delete a department", async () => {
    const app = await departmentsApp("AUDITOR");
    expect((await request(app).post("/departments").send({ orgUnitId: OU, code: "X", name: "X", parentId: FIN })).status).toBe(403);
    expect((await request(app).patch(`/departments/${FIN}`).send({ name: "x" })).status).toBe(403);
    expect((await request(app).delete(`/departments/${FIN}`)).status).toBe(403);
  });

  it("EMPLOYEE and EXECUTIVE cannot administer departments", async () => {
    for (const role of ["EMPLOYEE", "EXECUTIVE"]) {
      const app = await departmentsApp(role);
      expect((await request(app).post("/departments").send({ orgUnitId: OU, code: "X", name: "X", parentId: FIN })).status).toBe(403);
    }
  });
});

describe("users: a department manager administers only people they may", () => {
  const PATHS: Array<[string, string, string]> = [
    ["patch", "/users/target", "edit"],
    ["delete", "/users/target", "delete"],
    ["post", "/users/target/activate", "activate"],
    ["post", "/users/target/deactivate", "deactivate"],
    ["post", "/users/target/force-logout", "force-logout"],
    ["post", "/users/target/roles", "assign role"],
    ["delete", "/users/target/roles/role-1", "remove role"],
    ["get", "/users/target/permission-overrides", "read overrides"],
    ["put", "/users/target/permission-overrides", "set overrides"],
  ];

  it.each(PATHS)("%s %s (%s) is refused for a user in another department", async (method, path) => {
    fx.managed = [FIN];
    fx.targetDepartments = [HR];
    const res = await (request(await usersApp("DEPT_MANAGER")) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).send({ roleId: "r", departmentId: FIN });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ERR-USER-SCOPE");
    expect(userSvc.updateUser).not.toHaveBeenCalled();
    expect(userSvc.assignRole).not.toHaveBeenCalled();
    expect(userSvc.softDeleteUser).not.toHaveBeenCalled();
    expect(mockReplaceOverrides).not.toHaveBeenCalled();
  });

  it("assigns a role to a member of their own department", async () => {
    fx.managed = [FIN, FIN_SUB];
    fx.targetDepartments = [FIN_SUB];
    const res = await request(await usersApp("DEPT_MANAGER")).post("/users/target/roles").send({ roleId: "role-employee" });
    expect(res.status).toBe(201);
    expect(userSvc.assignRole).toHaveBeenCalledTimes(1);
  });

  it("sets a per-user permission override for a member of their own department", async () => {
    fx.managed = [FIN];
    fx.targetDepartments = [FIN];
    const res = await request(await usersApp("DEPT_MANAGER")).put("/users/target/permission-overrides").send({ grants: [PERMISSIONS.DOCUMENT_ARCHIVE], revokes: [] });
    expect(res.status).toBe(200);
    expect(mockReplaceOverrides).toHaveBeenCalledTimes(1);
  });

  it("refuses to manage a user who holds a permission the manager lacks (a SYSTEM_ADMIN in their own department)", async () => {
    fx.managed = [FIN];
    fx.targetDepartments = [FIN];
    fx.targetPermissions = [...ROLE_PERMISSIONS.SYSTEM_ADMIN];
    const app = await usersApp("DEPT_MANAGER");
    for (const [method, path] of [["post", "/users/target/deactivate"], ["delete", "/users/target/roles/role-admin"], ["put", "/users/target/permission-overrides"], ["post", "/users/target/force-logout"]] as const) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ERR-TARGET-OUTRANKS-ACTOR");
    }
    expect(userSvc.deactivateUser).not.toHaveBeenCalled();
    expect(userSvc.removeRole).not.toHaveBeenCalled();
    expect(mockReplaceOverrides).not.toHaveBeenCalled();
  });

  it("a user of another tenant reads as not found for everyone, administrators included", async () => {
    fx.tenantMember = false;
    for (const role of ["DEPT_MANAGER", "SYSTEM_ADMIN"]) {
      const res = await request(await usersApp(role)).post("/users/target/deactivate");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ERR-USER-NOT-FOUND");
    }
    expect(userSvc.deactivateUser).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN manages a user in any department of the tenant", async () => {
    fx.targetDepartments = [HR];
    fx.targetPermissions = [ROLE_PERMISSIONS.EMPLOYEE[0]!];
    expect((await request(await usersApp("SYSTEM_ADMIN")).post("/users/target/deactivate")).status).toBe(200);
  });

  it("adds a member to a department they head, and refuses a department they do not", async () => {
    fx.managed = [FIN];
    fx.targetDepartments = [FIN];
    const app = await usersApp("DEPT_MANAGER");
    expect((await request(app).post("/users/target/departments").send({ departmentId: FIN })).status).toBe(201);
    expect((await request(app).post("/users/target/departments").send({ departmentId: HR })).status).toBe(403);
    expect(userSvc.assignDepartment).toHaveBeenCalledTimes(1);
  });

  it("may adopt a tenant member who belongs to no department yet, but not one that belongs elsewhere", async () => {
    fx.managed = [FIN];
    const app = await usersApp("DEPT_MANAGER");
    fx.targetDepartments = [];
    expect((await request(app).post("/users/target/departments").send({ departmentId: FIN })).status).toBe(201);
    fx.targetDepartments = [HR];
    expect((await request(app).post("/users/target/departments").send({ departmentId: FIN })).status).toBe(403);
  });

  it("removes a member only from a department they head", async () => {
    fx.managed = [FIN];
    fx.targetDepartments = [FIN, HR];
    const app = await usersApp("DEPT_MANAGER");
    expect((await request(app).delete(`/users/target/departments/${FIN}`)).status).toBe(200);
    expect((await request(app).delete(`/users/target/departments/${HR}`)).status).toBe(403);
    expect(userSvc.removeDepartment).toHaveBeenCalledTimes(1);
  });

  it("reading another user's profile is user administration (scoped); reading your own is not", async () => {
    fx.managed = [FIN];
    fx.targetDepartments = [HR];
    const app = await usersApp("DEPT_MANAGER");
    expect((await request(app).get("/users/target")).status).toBe(403);
    expect((await request(app).get("/users/actor")).status).toBe(200);
  });
});

describe("roles: role definitions are organisation-level", () => {
  it("a department manager cannot replace a role's permissions or create a role, even holding role:manage", async () => {
    const app = await rolesApp("DEPT_MANAGER", [PERMISSIONS.ROLE_MANAGE]);
    const put = await request(app).put("/roles/role-1/permissions").send({ permissions: [] });
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe("ERR-ROLE-DEFINITION-RESERVED");
    expect((await request(app).post("/roles").send({ name: "NEW_ROLE" })).status).toBe(403);
    expect(mockReplaceRolePermissions).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN still edits role permissions", async () => {
    const res = await request(await rolesApp("SYSTEM_ADMIN")).put("/roles/role-1/permissions").send({ permissions: [PERMISSIONS.DOCUMENT_READ] });
    expect(res.status).toBe(200);
    expect(mockReplaceRolePermissions).toHaveBeenCalledTimes(1);
  });
});

describe("document types: where a type applies is part of managing it", () => {
  it("records staff (document:read_all) may define a tenant-wide type", async () => {
    const res = await request(await docTypesApp("RECORDS_OFFICER")).post("/document-types").send({ code: "GEN", name: "General", defaultRetentionClass: "X" });
    expect(res.status).toBe(201);
  });

  it("someone granted doctype:manage without oversight is limited to a department they head", async () => {
    fx.managed = [FIN];
    const app = await docTypesApp("DEPT_MANAGER", [PERMISSIONS.DOCTYPE_MANAGE]);
    const tenantWide = await request(app).post("/document-types").send({ code: "GEN", name: "General", defaultRetentionClass: "X" });
    expect(tenantWide.status).toBe(403);
    expect(tenantWide.body.error.code).toBe("ERR-DOCTYPE-SCOPE");
    expect((await request(app).post("/document-types").send({ code: "O", name: "O", defaultRetentionClass: "X", orgUnitId: OU })).status).toBe(403);
    expect((await request(app).post("/document-types").send({ code: "H", name: "H", defaultRetentionClass: "X", departmentId: HR })).status).toBe(403);
    expect((await request(app).post("/document-types").send({ code: "F", name: "F", defaultRetentionClass: "X", departmentId: FIN })).status).toBe(201);
    expect(docTypeSvc.createDocumentType).toHaveBeenCalledTimes(1);
  });

  it("cannot edit or deactivate a tenant-wide type, or widen a department type, without oversight", async () => {
    fx.managed = [FIN];
    const app = await docTypesApp("DEPT_MANAGER", [PERMISSIONS.DOCTYPE_MANAGE]);
    mockDocumentType.findOne.mockResolvedValueOnce({ id: "t1", departmentId: null, orgUnitId: null });
    expect((await request(app).patch("/document-types/t1").send({ name: "x" })).status).toBe(403);
    mockDocumentType.findOne.mockResolvedValueOnce({ id: "t2", departmentId: FIN, orgUnitId: null });
    expect((await request(app).patch("/document-types/t2").send({ departmentId: null })).status).toBe(403);
    mockDocumentType.findOne.mockResolvedValueOnce({ id: "t3", departmentId: null, orgUnitId: null });
    expect((await request(app).delete("/document-types/t3")).status).toBe(403);
    mockDocumentType.findOne.mockResolvedValueOnce({ id: "t4", departmentId: FIN, orgUnitId: null });
    expect((await request(app).patch("/document-types/t4").send({ name: "renamed" })).status).toBe(200);
    expect(docTypeSvc.updateDocumentType).toHaveBeenCalledTimes(1);
    expect(docTypeSvc.deactivateDocumentType).not.toHaveBeenCalled();
  });

  it("AUDITOR, EXECUTIVE and EMPLOYEE hold no doctype:manage at all", async () => {
    for (const role of ["AUDITOR", "EXECUTIVE", "EMPLOYEE", "DEPT_MANAGER"]) {
      const res = await request(await docTypesApp(role)).post("/document-types").send({ code: "G", name: "G", defaultRetentionClass: "X" });
      expect(res.status).toBe(403);
    }
  });
});
