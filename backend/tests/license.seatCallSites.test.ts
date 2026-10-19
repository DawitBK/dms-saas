/**
 * Where the seat limit is actually applied: users.service createUser / activateUser / updateUser(isActive:true) and
 * the OIDC just-in-time provisioning in auth/ssoIdentity.ts. The database is mocked.
 *
 * What must hold: a refusal writes NOTHING; an existing account logging in through SSO is never refused; editing an
 * already-active account never consumes a seat; with no licence none of this changes.
 */
const PA = "00000000-0000-0000-0000-00000000aaaa";
const TENANT = "tenant-1";
const ROLE_ID = "550e8400-e29b-41d4-a716-446655440010";

const mockRole = { findByPk: jest.fn() };
const mockUser = { findOne: jest.fn(), findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() };
const mockUserTenant = { create: jest.fn() };
const mockUserRole = { bulkCreate: jest.fn() };
const mockUserDepartment = { bulkCreate: jest.fn() };
const mockDepartment = { findAll: jest.fn() };
const mockDbQuery = jest.fn(); // database/index.js sequelize (orgScope etc.)
const mockSeatQuery = jest.fn(); // database/sequelize.js sequelize (the seat count)
const mockAudit = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment, Role: mockRole, User: mockUser, UserDepartment: mockUserDepartment,
  UserRole: mockUserRole, UserTenant: mockUserTenant, Document: {}, AuthSession: {}, DocLock: {},
  DocumentCheckout: {}, ApprovalStep: {}, ApprovalChain: {}, AuditStageReview: {},
  LetterApprovalStep: {}, Letter: {}, WorkflowTask: {}, WorkflowInstance: {},
  SignatureRecipient: {}, SignatureRequest: {},
  sequelize: { query: (...a: unknown[]) => mockDbQuery(...a) },
}));
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockSeatQuery(...a) },
}));
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: jest.fn() }));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockAudit(...a) }));
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({ invalidateUserDepartments: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/shared/auth.js", () => ({ revokeAllUserSessions: jest.fn() }));
jest.mock("../src/shared/transaction.js", () => ({
  runInSavepoint: jest.fn(),
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ afterCommit: jest.fn() }),
}));
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getMaxRolePermissionsAcrossTenants: jest.fn(async () => []),
  resolveUnionPermissions: jest.fn().mockResolvedValue([]),
}));
jest.mock("../src/shared/platformAdmin.js", () => {
  const { AppError } = jest.requireActual("../src/core/AppError.js");
  return {
    PLATFORM_ADMIN_ROLE: "PLATFORM_ADMIN",
    assertNotHiddenUser: jest.fn(),
    excludeHiddenWhere: jest.fn(() => ({})),
    hiddenUserIds: jest.fn().mockResolvedValue([]),
    isPlatformAdminRoleName: (n: string) => n === "PLATFORM_ADMIN",
    getPlatformAdminUserIds: jest.fn().mockResolvedValue([PA]),
    notPlatformAdminSql: () => "1=1",
    userNotFound: () => new AppError(404, "ERR-USER-NOT-FOUND", "User not found"),
  };
});
jest.mock("../src/core/logger.js", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { ROLE_PERMISSIONS } from "../src/config/permissions.js";
import * as service from "../src/modules/license/license.service.js";
import { claims } from "./licenseTestKit.js";

let createUser: typeof import("../src/modules/users/users.service.js").createUser;
let activateUser: typeof import("../src/modules/users/users.service.js").activateUser;
let updateUser: typeof import("../src/modules/users/users.service.js").updateUser;
let resolveOidcUser: typeof import("../src/modules/auth/ssoIdentity.js").resolveOidcUser;
beforeAll(async () => {
  ({ createUser, activateUser, updateUser } = await import("../src/modules/users/users.service.js"));
  ({ resolveOidcUser } = await import("../src/modules/auth/ssoIdentity.js"));
});

const sysAdmin = { userId: "admin-1", tenantId: TENANT, permissions: ROLE_PERMISSIONS.SYSTEM_ADMIN };
const input = (extra: Record<string, unknown> = {}) => ({ email: "new.person@example.test", firstName: "New", lastName: "Person", roleIds: [ROLE_ID], ...extra });
const identity = { externalSub: "sub-new", email: "New.Person@Example.test", givenName: "New", familyName: "Person" };

function withSeats(used: number, maxUsers: number | null) {
  mockSeatQuery.mockResolvedValue([{ n: used }]);
  service.__setLicenseForTesting({ claims: claims({ expiresAt: new Date(Date.now() + 200 * 86_400_000), maxUsers }) });
}
function account(over: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { id: "u-1", email: "someone@example.test", isActive: true, externalSub: "sub-existing", ...over };
  r.update = jest.fn(async (patch: Record<string, unknown>) => Object.assign(r, patch));
  return r as any;
}

beforeEach(() => {
  jest.clearAllMocks(); // keeps the module factories' implementations
  for (const m of [mockRole.findByPk, mockUser.findOne, mockUser.findAll, mockUser.findByPk, mockUser.create, mockUserTenant.create, mockUserRole.bulkCreate, mockUserDepartment.bulkCreate, mockDepartment.findAll, mockDbQuery, mockSeatQuery, mockAudit]) m.mockReset();
  service.__resetLicenseForTesting();
  mockRole.findByPk.mockResolvedValue({ id: ROLE_ID, name: "EMPLOYEE" });
  mockUser.findOne.mockResolvedValue(null);
  mockUser.findAll.mockResolvedValue([]);
  mockUser.create.mockResolvedValue({ id: "new-user", email: "new.person@example.test", firstName: "New", lastName: "Person" });
  mockUserTenant.create.mockResolvedValue({});
  mockUserRole.bulkCreate.mockResolvedValue([]);
  mockDbQuery.mockResolvedValue([{ id: "dept-1" }]);
  mockDepartment.findAll.mockImplementation(async ({ where }: { where: { id: string[] } }) => where.id.map((id) => ({ id })));
  mockAudit.mockResolvedValue(undefined);
  const { getPlatformAdminUserIds } = jest.requireMock("../src/shared/platformAdmin.js");
  getPlatformAdminUserIds.mockResolvedValue([PA]);
});

describe("createUser", () => {
  it("at the limit: 403 LICENSE_SEAT_LIMIT and NOTHING is written", async () => {
    withSeats(10, 10);
    await expect(createUser(input(), sysAdmin)).rejects.toMatchObject({ statusCode: 403, code: "LICENSE_SEAT_LIMIT" });
    expect(mockUser.create).not.toHaveBeenCalled();
    expect(mockUserTenant.create).not.toHaveBeenCalled();
    expect(mockUserRole.bulkCreate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
  it("one seat free: the account is created", async () => {
    withSeats(9, 10);
    await expect(createUser(input(), sysAdmin)).resolves.toMatchObject({ id: "new-user" });
  });
  it("creating an INACTIVE account takes no seat, so it is allowed at the limit", async () => {
    withSeats(10, 10);
    await expect(createUser(input({ isActive: false }), sysAdmin)).resolves.toMatchObject({ id: "new-user" });
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
  it("no licence: unchanged (no seat query at all)", async () => {
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    await expect(createUser(input(), sysAdmin)).resolves.toMatchObject({ id: "new-user" });
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
  it("unlimited licence: unchanged", async () => {
    withSeats(10_000, null);
    await expect(createUser(input(), sysAdmin)).resolves.toMatchObject({ id: "new-user" });
  });
});

describe("activateUser", () => {
  it("activating an inactive account at the limit is refused and the account stays inactive", async () => {
    withSeats(10, 10);
    const u = account({ isActive: false });
    mockUser.findByPk.mockResolvedValue(u);
    await expect(activateUser("u-1", "admin-1")).rejects.toMatchObject({ statusCode: 403, code: "LICENSE_SEAT_LIMIT" });
    expect(u.update).not.toHaveBeenCalled();
    expect(u.isActive).toBe(false);
  });
  it("activating with a free seat works", async () => {
    withSeats(9, 10);
    const u = account({ isActive: false });
    mockUser.findByPk.mockResolvedValue(u);
    await activateUser("u-1", "admin-1");
    expect(u.update).toHaveBeenCalledWith({ isActive: true, lockedUntil: null }, expect.anything());
  });
  it("'activating' an account that is already active is a no-op for the limit (it is already counted)", async () => {
    withSeats(10, 10);
    const u = account({ isActive: true });
    mockUser.findByPk.mockResolvedValue(u);
    await expect(activateUser("u-1", "admin-1")).resolves.toBeTruthy();
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
  it("a platform administrator is never refused", async () => {
    withSeats(10, 10);
    mockUser.findByPk.mockResolvedValue(account({ id: PA, isActive: false }));
    await expect(activateUser(PA, "admin-1")).resolves.toBeTruthy();
  });
  it("no licence: unchanged", async () => {
    mockUser.findByPk.mockResolvedValue(account({ isActive: false }));
    await expect(activateUser("u-1", "admin-1")).resolves.toBeTruthy();
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
});

describe("updateUser with isActive (the other way to restore an account)", () => {
  it("isActive:true on an inactive account at the limit is refused", async () => {
    withSeats(10, 10);
    const u = account({ isActive: false });
    mockUser.findByPk.mockResolvedValue(u);
    await expect(updateUser("u-1", { isActive: true }, "admin-1")).rejects.toMatchObject({ code: "LICENSE_SEAT_LIMIT" });
    expect(u.update).not.toHaveBeenCalled();
  });
  it("editing an ACTIVE account (even sending isActive:true again) never needs a seat", async () => {
    withSeats(10, 10);
    const u = account({ isActive: true });
    mockUser.findByPk.mockResolvedValue(u);
    await expect(updateUser("u-1", { firstName: "X", isActive: true }, "admin-1")).resolves.toBeTruthy();
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
  it("deactivating is never refused (the limit only ever blocks taking a seat)", async () => {
    withSeats(50, 10); // over the limit already
    mockUser.findByPk.mockResolvedValue(account({ isActive: true }));
    await expect(updateUser("u-1", { isActive: false }, "admin-1")).resolves.toBeTruthy();
  });
});

describe("OIDC just-in-time provisioning (SSO login)", () => {
  it("a NEW identity at the limit is refused with 403 LICENSE_SEAT_LIMIT and nothing is created", async () => {
    withSeats(10, 10);
    mockUser.findOne.mockResolvedValue(null); // no account for this sub
    mockUser.findAll.mockResolvedValue([]); // none for this email either
    await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 403, code: "LICENSE_SEAT_LIMIT" });
    expect(mockUser.create).not.toHaveBeenCalled();
    expect(mockUserTenant.create).not.toHaveBeenCalled();
  });

  it("a NEW identity with a free seat is provisioned as before", async () => {
    withSeats(9, 10);
    mockUser.create.mockResolvedValue({ id: "jit-1", email: "new.person@example.test" });
    const out = await resolveOidcUser(identity, TENANT);
    expect(out).toMatchObject({ id: "jit-1" });
    expect(mockUserTenant.create).toHaveBeenCalled();
  });

  it("an EXISTING account (matched by sub) signs in even when seats are full: the limit never locks anyone out", async () => {
    withSeats(50, 10); // over the limit
    const u = account({ externalSub: "sub-new", email: "new.person@example.test" });
    mockUser.findOne.mockResolvedValueOnce(u);
    await expect(resolveOidcUser(identity, TENANT)).resolves.toBe(u);
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });

  it("an EXISTING account adopted by email (first SSO login of a local account) signs in at the limit too", async () => {
    withSeats(10, 10);
    const legacy = account({ externalSub: null, email: "new.person@example.test" });
    mockUser.findOne.mockResolvedValueOnce(null);
    mockUser.findAll.mockResolvedValueOnce([legacy]);
    await expect(resolveOidcUser(identity, TENANT)).resolves.toBe(legacy);
    expect(mockSeatQuery).not.toHaveBeenCalled();
    expect(mockUser.create).not.toHaveBeenCalled();
  });

  it("no licence: JIT is unchanged", async () => {
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    mockUser.create.mockResolvedValue({ id: "jit-2" });
    await expect(resolveOidcUser(identity, TENANT)).resolves.toMatchObject({ id: "jit-2" });
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
});

describe("atomicity: every path takes the seat lock BEFORE counting, and writes only after", () => {
  const sqls = () => mockSeatQuery.mock.calls.map((c) => String(c[0]));
  const lockFirst = () => {
    const s = sqls();
    expect(s[0]).toContain("pg_advisory_xact_lock");
    expect(s[1]).toContain("count(*)");
  };

  it("createUser", async () => {
    withSeats(9, 10);
    await createUser(input(), sysAdmin);
    lockFirst();
    expect(mockSeatQuery.mock.invocationCallOrder[1]).toBeLessThan(mockUser.create.mock.invocationCallOrder[0]);
  });
  it("activateUser", async () => {
    withSeats(9, 10);
    const u = account({ isActive: false });
    mockUser.findByPk.mockResolvedValue(u);
    await activateUser("u-1", "admin-1");
    lockFirst();
    expect(mockSeatQuery.mock.invocationCallOrder[1]).toBeLessThan((u.update as jest.Mock).mock.invocationCallOrder[0]);
  });
  it("updateUser re-activating", async () => {
    withSeats(9, 10);
    const u = account({ isActive: false });
    mockUser.findByPk.mockResolvedValue(u);
    await updateUser("u-1", { isActive: true }, "admin-1");
    lockFirst();
    expect(u.update).toHaveBeenCalled();
  });
  it("OIDC just-in-time provisioning", async () => {
    withSeats(9, 10);
    mockUser.create.mockResolvedValue({ id: "jit-1" });
    await resolveOidcUser(identity, TENANT);
    lockFirst();
    expect(mockSeatQuery.mock.invocationCallOrder[1]).toBeLessThan(mockUser.create.mock.invocationCallOrder[0]);
  });
  it("no limit in force: no statement at all (no lock, no count) on any path", async () => {
    withSeats(10_000, null);
    await createUser(input(), sysAdmin);
    mockUser.findByPk.mockResolvedValue(account({ isActive: false }));
    await activateUser("u-1", "admin-1");
    expect(mockSeatQuery).not.toHaveBeenCalled();
  });
});
