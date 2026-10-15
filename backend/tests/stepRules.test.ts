// R-08 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): the approval-step assignment and
// decision rules used to exist twice — once in letters.service.ts and once in
// approvals.service.ts, where the copy was literally labelled "Mirror of
// letters' assertStepIsActionable". They had drifted. These tests pin the
// single unified implementation (src/modules/approvals/stepRules.ts), and in
// particular the two behaviours that differed between the copies:
//
//   * the cross-department escape hatch, which only letters' submit-time
//     validator applied even though BOTH decide paths grant it (a real
//     defect on the engine side — see the "cross-department" tests below);
//   * UNCAT normalization, which only the engine applied.
//
// Fully mocked, no live DB.

const mockDepartment = { findOne: jest.fn() };
const mockUser = { findOne: jest.fn() };
const mockUserTenant = { findOne: jest.fn() };
const mockSequelize = { query: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  User: mockUser,
  UserTenant: mockUserTenant,
  sequelize: mockSequelize,
}));

// The hidden platform administrator is a database lookup; nobody is hidden unless a test makes it so.
const mockAssertNotHiddenUser = jest.fn();
jest.mock("../src/shared/platformAdmin.js", () => ({
  ...jest.requireActual("../src/shared/platformAdmin.js"),
  assertNotHiddenUser: (...args: unknown[]) => mockAssertNotHiddenUser(...args),
}));

const mockGetResolvedRolePermissions = jest.fn();
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getResolvedRolePermissions: (...args: unknown[]) => mockGetResolvedRolePermissions(...args),
}));

const mockLoadUserDepartmentIds = jest.fn();
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: (...args: unknown[]) => mockLoadUserDepartmentIds(...args),
}));

import { PERMISSIONS } from "../src/config/permissions.js";
import {
  ENGINE_STEP_RULES,
  LETTER_STEP_RULES,
  assertRoleStepDepartmentScope,
  assertStepIsActionable,
  resolveRoleStepEligibility,
  stepIsAssignedTo,
} from "../src/modules/approvals/stepRules.js";

const TENANT = "test-tenant-1";
const DEPT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OTHER_DEPT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const USER_ID = "11111111-1111-1111-1111-111111111111";

/** The SQL of the "is this role staffed" probe, as actually issued. */
function staffingSql(): string {
  const call = mockSequelize.query.mock.calls.find((c) =>
    String(c[0]).includes("FROM user_roles"),
  );
  return call ? String(call[0]) : "";
}

/** Did that probe scope to the item's department? */
function scopedToDepartment(): boolean {
  return staffingSql().includes("user_departments");
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the department exists and is NOT the UNCAT bucket.
  mockDepartment.findOne.mockResolvedValue(null);
  mockUserTenant.findOne.mockResolvedValue({ userId: USER_ID, tenantId: TENANT });
  mockUser.findOne.mockResolvedValue({ id: USER_ID, isActive: true });
  mockLoadUserDepartmentIds.mockResolvedValue([]);
  mockSequelize.query.mockResolvedValue([]);
  mockAssertNotHiddenUser.mockResolvedValue(undefined);
});

describe("the hidden platform administrator (audit E4)", () => {
  it("can never be named as an assignee: assertStepIsActionable answers like an unknown user", async () => {
    mockAssertNotHiddenUser.mockRejectedValue(Object.assign(new Error("User not found"), { statusCode: 404, code: "ERR-USER-NOT-FOUND" }));
    await expect(assertStepIsActionable({ stepType: "APPROVE", assignedUserId: USER_ID }, TENANT, null, ENGINE_STEP_RULES))
      .rejects.toMatchObject({ code: "ERR-USER-NOT-FOUND", statusCode: 404 });
    expect(mockAssertNotHiddenUser).toHaveBeenCalledWith(USER_ID);
  });
});

describe("stepIsAssignedTo", () => {
  const user = { userId: USER_ID, role: "STAFF", roles: ["STAFF", "DEPT_MANAGER"], tenantId: TENANT };

  it("matches a named assignee by user id", () => {
    expect(stepIsAssignedTo({ assignedUserId: USER_ID, assignedRole: null }, user)).toBe(true);
  });

  it("does not match a different named assignee", () => {
    expect(stepIsAssignedTo({ assignedUserId: "22222222-2222-2222-2222-222222222222", assignedRole: null }, user))
      .toBe(false);
  });

  it("matches a role the user holds", () => {
    expect(stepIsAssignedTo({ assignedUserId: null, assignedRole: "DEPT_MANAGER" }, user)).toBe(true);
  });

  it("does not match a role the user does not hold", () => {
    expect(stepIsAssignedTo({ assignedUserId: null, assignedRole: "EXECUTIVE" }, user)).toBe(false);
  });

  it("falls back to the single `role` when `roles` is absent", () => {
    const single = { userId: USER_ID, role: "AUDITOR", tenantId: TENANT };
    expect(stepIsAssignedTo({ assignedUserId: null, assignedRole: "AUDITOR" }, single)).toBe(true);
  });

  it("matches nothing when the step is unassigned", () => {
    expect(stepIsAssignedTo({ assignedUserId: null, assignedRole: null }, user)).toBe(false);
  });

  it("prefers the named assignee over the role when both are set", () => {
    // A named assignee IS the authorization; the role must not widen it.
    const other = { userId: "22222222-2222-2222-2222-222222222222", role: "DEPT_MANAGER", tenantId: TENANT };
    expect(stepIsAssignedTo({ assignedUserId: USER_ID, assignedRole: "DEPT_MANAGER" }, other)).toBe(false);
  });
});

describe("assertStepIsActionable — named assignee", () => {
  it("rejects an assignee who is not a member of the tenant", async () => {
    mockUserTenant.findOne.mockResolvedValue(null);
    await expect(
      assertStepIsActionable({ assignedUserId: USER_ID }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-ASSIGNEE-INVALID" });
  });

  it("rejects an inactive assignee", async () => {
    mockUser.findOne.mockResolvedValue(null);
    await expect(
      assertStepIsActionable({ assignedUserId: USER_ID }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-ASSIGNEE-INVALID" });
  });

  it("rejects an assignee whose roles do not grant the decide permission", async () => {
    mockSequelize.query.mockResolvedValue([{ name: "STAFF" }]);
    mockGetResolvedRolePermissions.mockResolvedValue(["document:read"]);
    await expect(
      assertStepIsActionable({ assignedUserId: USER_ID }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-ASSIGNEE-INVALID" });
  });

  it("accepts an assignee holding the decide permission through any one of their roles", async () => {
    mockSequelize.query.mockResolvedValue([{ name: "STAFF" }, { name: "DEPT_MANAGER" }]);
    mockGetResolvedRolePermissions
      .mockResolvedValueOnce(["document:read"])
      .mockResolvedValueOnce([PERMISSIONS.APPROVAL_DECIDE]);
    await expect(
      assertStepIsActionable({ assignedUserId: USER_ID }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("resolves role permissions PER TENANT, so a customised role agrees with the decide path", async () => {
    mockSequelize.query.mockResolvedValue([{ name: "CUSTOM_ROLE" }]);
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    await assertStepIsActionable({ assignedUserId: USER_ID }, TENANT, DEPT, ENGINE_STEP_RULES);
    expect(mockGetResolvedRolePermissions).toHaveBeenCalledWith("CUSTOM_ROLE", TENANT);
  });
});

describe("assertStepIsActionable — role assignee", () => {
  it("rejects a role that does not grant the decide permission", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue(["document:read"]);
    await expect(
      assertStepIsActionable({ assignedRole: "CLERK" }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-ROLE-INVALID" });
  });

  it("rejects a role nobody qualified holds", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([]);
    await expect(
      assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-ROLE-UNSTAFFED" });
  });

  it("accepts a role with at least one qualified holder", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await expect(
      assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("scopes the staffing check to the item's department by default", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, ENGINE_STEP_RULES);
    expect(scopedToDepartment()).toBe(true);
  });

  it("does not scope to a department when the item has none", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, null, ENGINE_STEP_RULES);
    expect(scopedToDepartment()).toBe(false);
  });

  it("rejects a step with neither a user nor a role", async () => {
    await expect(
      assertStepIsActionable({}, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-UNASSIGNED" });
  });
});

// The defect this unification fixed. Both decide paths let a holder of the
// domain's read-all permission decide a role-assigned step outside their own
// department — but only letters' submit-time validator knew that. The
// engine's copy scoped unconditionally, so a role whose qualified holders all
// sit outside the item's department (a central-archive or EXECUTIVE role
// holding document:read_all) was rejected at submit with
// ERR-STEP-ROLE-UNSTAFFED even though decideStep would have let them decide.
describe("assertStepIsActionable — cross-department escape hatch (R-08 defect)", () => {
  it("ENGINE: a role granting document:read_all is NOT department-scoped", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([
      PERMISSIONS.APPROVAL_DECIDE,
      PERMISSIONS.DOCUMENT_READ_ALL,
    ]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable({ assignedRole: "CENTRAL_ARCHIVE" }, TENANT, DEPT, ENGINE_STEP_RULES);
    expect(scopedToDepartment()).toBe(false);
  });

  it("ENGINE: a role without document:read_all stays department-scoped", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, ENGINE_STEP_RULES);
    expect(scopedToDepartment()).toBe(true);
  });

  it("LETTER: a role granting letter:read_all is NOT department-scoped", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([
      PERMISSIONS.LETTER_APPROVE,
      PERMISSIONS.LETTER_READ_ALL,
    ]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable(
      { stepType: "APPROVE", assignedRole: "CENTRAL_ARCHIVE" }, TENANT, DEPT, LETTER_STEP_RULES,
    );
    expect(scopedToDepartment()).toBe(false);
  });

  it("LETTER: a role without letter:read_all stays department-scoped", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable(
      { stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, LETTER_STEP_RULES,
    );
    expect(scopedToDepartment()).toBe(true);
  });
});

// UNCAT normalization used to live only on the engine side.
describe("assertStepIsActionable — UNCAT normalization", () => {
  it("treats the tenant's UNCAT bucket as no department at all", async () => {
    mockDepartment.findOne.mockResolvedValue({ id: DEPT, code: "UNCAT" });
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable({ assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, ENGINE_STEP_RULES);
    expect(scopedToDepartment()).toBe(false);
  });

  it("applies the same normalization on the letter side (was engine-only)", async () => {
    mockDepartment.findOne.mockResolvedValue({ id: DEPT, code: "UNCAT" });
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await assertStepIsActionable(
      { stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }, TENANT, DEPT, LETTER_STEP_RULES,
    );
    expect(scopedToDepartment()).toBe(false);
  });
});

// The permission each domain requires is a genuine difference, not drift.
describe("step rule profiles", () => {
  it("LETTER requires letter:approve for an APPROVE step", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_REVIEW]);
    await expect(
      assertStepIsActionable({ stepType: "APPROVE", assignedRole: "R" }, TENANT, DEPT, LETTER_STEP_RULES),
    ).rejects.toMatchObject({ code: "ERR-STEP-ROLE-INVALID" });
  });

  it("LETTER requires letter:review for a REVIEW step", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_REVIEW]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    await expect(
      assertStepIsActionable({ stepType: "REVIEW", assignedRole: "R" }, TENANT, DEPT, LETTER_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("ENGINE requires approval:decide regardless of step type", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);
    for (const stepType of ["APPROVE", "REVIEW"] as const) {
      await expect(
        assertStepIsActionable({ stepType, assignedRole: "R" }, TENANT, DEPT, ENGINE_STEP_RULES),
      ).resolves.toBeUndefined();
    }
  });
});

describe("assertRoleStepDepartmentScope", () => {
  const member = {
    userId: USER_ID, role: "DEPT_MANAGER", roles: ["DEPT_MANAGER"], tenantId: TENANT, permissions: [],
  };

  it("exempts a named-assignee step — naming a person IS the authorization", async () => {
    await expect(
      assertRoleStepDepartmentScope(
        { assignedUserId: USER_ID, assignedRole: "DEPT_MANAGER" }, member, TENANT, OTHER_DEPT, ENGINE_STEP_RULES,
      ),
    ).resolves.toBeUndefined();
    expect(mockLoadUserDepartmentIds).not.toHaveBeenCalled();
  });

  it("exempts a step with no role at all", async () => {
    await expect(
      assertRoleStepDepartmentScope({ assignedUserId: null, assignedRole: null }, member, TENANT, OTHER_DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("exempts an actor holding the cross-department read permission", async () => {
    const reader = { ...member, permissions: [PERMISSIONS.DOCUMENT_READ_ALL] };
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, reader, TENANT, OTHER_DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
    expect(mockLoadUserDepartmentIds).not.toHaveBeenCalled();
  });

  it("allows a member of the item's department", async () => {
    mockLoadUserDepartmentIds.mockResolvedValue([DEPT]);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, member, TENANT, DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("rejects a non-member of the item's department", async () => {
    mockLoadUserDepartmentIds.mockResolvedValue([OTHER_DEPT]);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, member, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toMatchObject({ statusCode: 403, code: "ERR-STEP-DEPT-SCOPE" });
  });

  it("exempts an UNCAT-filed item, which nobody can ever be a member of", async () => {
    mockDepartment.findOne.mockResolvedValue({ id: DEPT, code: "UNCAT" });
    mockLoadUserDepartmentIds.mockResolvedValue([OTHER_DEPT]);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, member, TENANT, DEPT, ENGINE_STEP_RULES),
    ).resolves.toBeUndefined();
  });

  it("uses the letter read-all permission under the LETTER profile", async () => {
    const letterReader = { ...member, permissions: [PERMISSIONS.LETTER_READ_ALL] };
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, letterReader, TENANT, OTHER_DEPT, LETTER_STEP_RULES),
    ).resolves.toBeUndefined();
    // document:read_all must NOT open the letter domain.
    const docReader = { ...member, permissions: [PERMISSIONS.DOCUMENT_READ_ALL] };
    mockLoadUserDepartmentIds.mockResolvedValue([]);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "DEPT_MANAGER" }, docReader, TENANT, OTHER_DEPT, LETTER_STEP_RULES),
    ).rejects.toMatchObject({ code: "ERR-STEP-DEPT-SCOPE" });
  });

  it("names the domain in its error message", async () => {
    mockLoadUserDepartmentIds.mockResolvedValue([]);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "R" }, member, TENANT, DEPT, LETTER_STEP_RULES),
    ).rejects.toThrow(/letter belongs to a department/);
    await expect(
      assertRoleStepDepartmentScope({ assignedRole: "R" }, member, TENANT, DEPT, ENGINE_STEP_RULES),
    ).rejects.toThrow(/item belongs to a department/);
  });
});


// The picker half of the same rule. resolveRoleStepEligibility exists so a
// dropdown can say "nobody in Audit holds this" BEFORE the user submits,
// instead of the backend refusing it afterwards with ERR-STEP-ROLE-UNSTAFFED
// (the failure a user hit on 2026-09-10). Its whole value is that it is the
// SAME code assertStepIsActionable runs — so these tests assert agreement,
// not merely that each works.
describe("resolveRoleStepEligibility", () => {
  const eligibility = (departmentId: string | null) =>
    resolveRoleStepEligibility(
      "DEPT_MANAGER",
      PERMISSIONS.LETTER_APPROVE,
      LETTER_STEP_RULES.crossDepartmentPermission,
      TENANT,
      departmentId,
    );

  it("reports zero holders exactly when the validator would refuse the step", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([]);

    const result = await eligibility(DEPT);
    expect(result).toEqual({ grantsPermission: true, departmentScoped: true, holderCount: 0 });

    // Same inputs, the validator: refuses, and for the staffing reason.
    await expect(
      assertStepIsActionable(
        { stepType: "APPROVE", assignedRole: "DEPT_MANAGER" },
        TENANT,
        DEPT,
        LETTER_STEP_RULES,
      ),
    ).rejects.toMatchObject({ code: "ERR-STEP-ROLE-UNSTAFFED" });
  });

  it("reports holders when the validator would accept the step", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);

    expect(await eligibility(DEPT)).toMatchObject({ holderCount: 1, departmentScoped: true });
    await expect(
      assertStepIsActionable(
        { stepType: "APPROVE", assignedRole: "DEPT_MANAGER" },
        TENANT,
        DEPT,
        LETTER_STEP_RULES,
      ),
    ).resolves.toBeUndefined();
  });

  it("separates 'role cannot decide this' from 'role has nobody here'", async () => {
    // The two failures have different fixes — change the step, versus staff
    // the department — so they must not collapse into one boolean.
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_READ]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);

    const result = await eligibility(DEPT);
    expect(result.grantsPermission).toBe(false);
    expect(result.holderCount).toBe(1);
  });

  it("counts tenant-wide for a role with the cross-department escape hatch", async () => {
    // Matches the hatch the decide path grants: a read-all role's holders
    // qualify from outside the item's department, so scoping them would
    // under-report and the picker would wrongly grey the role out.
    mockGetResolvedRolePermissions.mockResolvedValue([
      PERMISSIONS.LETTER_APPROVE,
      PERMISSIONS.LETTER_READ_ALL,
    ]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);

    expect(await eligibility(DEPT)).toMatchObject({ departmentScoped: false, holderCount: 1 });
    expect(scopedToDepartment()).toBe(false);
  });

  it("treats the synthetic UNCAT bucket as no department", async () => {
    mockDepartment.findOne.mockResolvedValue({ id: DEPT, code: "UNCAT" });
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);

    expect(await eligibility(DEPT)).toMatchObject({ departmentScoped: false });
    expect(scopedToDepartment()).toBe(false);
  });

  it("is tenant-wide when the item has no department at all", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.LETTER_APPROVE]);
    mockSequelize.query.mockResolvedValue([{ user_id: USER_ID }]);

    expect(await eligibility(null)).toMatchObject({ departmentScoped: false, holderCount: 1 });
  });
});