// Regression coverage for the CAMS approval-chain deadlock recovery fix
// (UNKNOWN-UNKNOWNS-DMS.md finding #12): a step whose assignee is deactivated,
// or a role-step whose every holder leaves the department, must be
// reassignable — and a letter stuck IN_REVIEW must be cancellable by an admin.
// Fully mocked (no live DB), mirroring tests/documents.service.test.ts's style.

const mockLetter = { findOne: jest.fn(), update: jest.fn() };
const mockLetterApprovalStep = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() };
const mockUser = { findOne: jest.fn() };
const mockUserTenant = { findOne: jest.fn() };
// R-08: the step-assignment rules now live in one place (approvals/stepRules.ts)
// and always normalize the tenant UNCAT bucket to "no department" — so the
// letter path reaches Department.findOne, which this mock previously stubbed
// as a bare {}. Resolving null means "this department is not UNCAT", i.e.
// department scoping applies as before.
const mockDepartment = { findOne: jest.fn().mockResolvedValue(null) };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockSequelize = {
  query: jest.fn().mockResolvedValue([]),
};

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  Document: {},
  DocumentDek: {},
  DocumentType: {},
  DocumentVersion: {},
  Letter: mockLetter,
  LetterApprovalStep: mockLetterApprovalStep,
  LetterDispatch: {},
  LetterLink: {},
  LetterRevision: {},
  LetterSequence: {},
  OrgUnit: {},
  OutboxEvent: mockOutboxEvent,
  sequelize: mockSequelize,
  User: mockUser,
  UserTenant: mockUserTenant,
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Fake transaction object carries just enough shape (LOCK.UPDATE) for
// lockLetterInReview()'s `{ lock: tx.LOCK.UPDATE }` option to not blow up.
const fakeTx = { LOCK: { UPDATE: "UPDATE" } };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));

jest.mock("../src/infrastructure/queue/outbox.js", () => ({
  enqueueWebsocketEvent: jest.fn().mockResolvedValue(undefined),
}));

// reassignStep / cancelLetter now check the platform-admin rule for a named assignee
// (shared/platformAdmin.ts reads the DB through its own sequelize import, not the
// mocked index above) — nobody is hidden in these tests.
jest.mock("../src/shared/platformAdmin.js", () => ({
  maskHiddenUsersDeep: jest.fn(async () => undefined),
  assertNotHiddenUser: jest.fn().mockResolvedValue(undefined),
  withoutHiddenIds: jest.fn(async (ids: string[]) => ids),
  notPlatformAdminSql: () => "TRUE",
}));

jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));

jest.mock("../src/modules/notifications/notifications.service.js", () => ({
  fanOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
  fetchAndDecrypt: jest.fn(),
}));

jest.mock("../src/modules/letters/letterPdf.js", () => ({
  generateLetterPdf: jest.fn(),
  generateLetterSignableDraft: jest.fn(),
  htmlToPlainText: jest.fn().mockReturnValue(""),
}));

// letters.service.ts now imports the signing ceremony functions at module
// top-level (real e-signing for outgoing composed letters) — the real
// esigning.service.ts transitively pulls in documents.service.ts, which
// constructs a real MinIO client at *module-eval* time, blowing up with
// this file's minimal mocked config. None of these tests exercise the
// signing path, so a bare stub is enough to keep the import graph light.
jest.mock("../src/modules/esigning/esigning.service.js", () => ({
  createSignatureRequest: jest.fn(),
  sendSignatureRequest: jest.fn(),
}));

// letters.service.ts also now imports grantDefaultDocumentAcl directly from
// documents.service.ts (the ACL grant enterPendingSignatureInTx needs for its
// signable-draft document — see that function) — a second direct edge into
// the same real-MinIO-at-module-eval module the esigning mock above already
// works around. Same stub treatment.
jest.mock("../src/modules/documents/documents.service.js", () => ({
  grantDefaultDocumentAcl: jest.fn(),
}));

jest.mock("../src/config/env.js", () => ({
  config: { CAMS_VERIFY_BASE_URL: "http://verify.test", MINIO_BUCKET_DOCUMENTS: "bucket" },
}));

// assertStepIsActionable resolves a role's permissions PER TENANT now
// (role_permissions rows, with the static ROLE_PERMISSIONS map as fallback)
// so it agrees with decideStep, which authorizes off the JWT's own
// tenant-resolved set. These tests run against a fully mocked DB with no
// role_permissions table, so short-circuit straight to the static fallback —
// which is exactly what an un-customised tenant resolves to anyway.
jest.mock("../src/modules/roles/roles.service.js", () => {
  const { ROLE_PERMISSIONS } = jest.requireActual("../src/config/permissions.js");
  return {
    getResolvedRolePermissions: jest.fn(async (roleName: string) => ROLE_PERMISSIONS[roleName] ?? []),
  };
});

import { PERMISSIONS } from "../src/config/permissions.js";
import { enqueueWebsocketEvent } from "../src/infrastructure/queue/outbox.js";

let reassignStep: typeof import("../src/modules/letters/letters.service.js").reassignStep;
let cancelLetter: typeof import("../src/modules/letters/letters.service.js").cancelLetter;

beforeAll(async () => {
  const service = await import("../src/modules/letters/letters.service.js");
  reassignStep = service.reassignStep;
  cancelLetter = service.cancelLetter;
});

const TENANT_ID = "tenant-1";
const DEPARTMENT_ID = "dept-1";
const LETTER_ID = "letter-1";
const STEP_ID = "step-1";

const adminUser = {
  userId: "admin-1",
  role: "DEPT_MANAGER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.DEPT_MANAGE, PERMISSIONS.LETTER_CREATE, PERMISSIONS.LETTER_APPROVE, PERMISSIONS.LETTER_REVIEW],
};

const nonAdminUser = {
  userId: "user-2",
  role: "EMPLOYEE",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_CREATE],
};

function makeLetter(overrides: Partial<Record<string, unknown>> = {}) {
  const letter: Record<string, unknown> = {
    id: LETTER_ID,
    tenantId: TENANT_ID,
    departmentId: DEPARTMENT_ID,
    direction: "OUTGOING",
    status: "IN_REVIEW",
    subject: "Test letter",
    createdBy: "creator-1",
    ...overrides,
  };
  letter.update = jest.fn(async (values: Record<string, unknown>) => {
    Object.assign(letter, values);
    return letter;
  });
  return letter;
}

function makeStep(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: STEP_ID,
    letterId: LETTER_ID,
    stepType: "APPROVE",
    assignedUserId: "old-user-1",
    assignedRole: null,
    status: "PENDING",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSequelize.query.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("SELECT r.name FROM roles")) {
      return Promise.resolve([{ name: "APPROVER" }]);
    }
    if (typeof sql === "string" && sql.includes("SELECT DISTINCT ur.user_id")) {
      return Promise.resolve([{ user_id: "staffer-1" }]);
    }
    // shared/orgScope.ts getManagedDepartmentIds: the admin heads the letter's department.
    if (typeof sql === "string" && sql.includes("WITH RECURSIVE managed")) {
      return Promise.resolve([{ id: DEPARTMENT_ID }]);
    }
    return Promise.resolve([]);
  });
  mockOutboxEvent.create.mockResolvedValue(undefined);
  mockOutboxEvent.bulkCreate.mockResolvedValue(undefined);
});

describe("reassignStep", () => {
  it("reassigns a PENDING step to a new user, validating the candidate and writing an audit log of old -> new", async () => {
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    const before = makeStep();
    const after = makeStep({ assignedUserId: "11111111-1111-1111-1111-111111111111" });
    mockLetterApprovalStep.findOne
      .mockResolvedValueOnce(before) // initial fetch
      .mockResolvedValueOnce(after); // post-update fetch for notification
    mockLetterApprovalStep.update.mockResolvedValue([1]);
    mockUserTenant.findOne.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111", tenantId: TENANT_ID });
    mockUser.findOne.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", isActive: true });

    await reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "11111111-1111-1111-1111-111111111111" }, adminUser as any);

    expect(mockLetterApprovalStep.update).toHaveBeenCalledWith(
      { assignedUserId: "11111111-1111-1111-1111-111111111111", assignedRole: null, dueAt: null, slaBreachedAt: null, escalatedAt: null, escalatedToUserIds: [] },
      { where: { id: STEP_ID, letterId: LETTER_ID, status: "PENDING" }, transaction: fakeTx },
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LETTER_STEP_REASSIGNED",
        actionDetails: expect.objectContaining({
          letterId: LETTER_ID,
          stepId: STEP_ID,
          from: { assignedUserId: "old-user-1", assignedRole: null },
          to: { assignedUserId: "11111111-1111-1111-1111-111111111111", assignedRole: null },
        }),
      }),
    );
  });

  it("reassigns a PENDING step to a new role", async () => {
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    const before = makeStep({ stepType: "REVIEW", assignedUserId: null, assignedRole: "APPROVER" });
    mockLetterApprovalStep.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(before);
    mockLetterApprovalStep.update.mockResolvedValue([1]);

    await reassignStep(LETTER_ID, STEP_ID, { assignedRole: "DEPT_MANAGER" }, adminUser as any);

    expect(mockLetterApprovalStep.update).toHaveBeenCalledWith(
      { assignedUserId: null, assignedRole: "DEPT_MANAGER", dueAt: null, slaBreachedAt: null, escalatedAt: null, escalatedToUserIds: [] },
      { where: { id: STEP_ID, letterId: LETTER_ID, status: "PENDING" }, transaction: fakeTx },
    );
  });

  it("rejects reassignment without department:manage / admin bypass", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter());
    await expect(
      reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "11111111-1111-1111-1111-111111111111" }, nonAdminUser as any),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });

  it("rejects reassignment of a step that is no longer PENDING", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter());
    mockLetterApprovalStep.findOne.mockResolvedValueOnce(makeStep({ status: "APPROVED" }));
    await expect(
      reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "11111111-1111-1111-1111-111111111111" }, adminUser as any),
    ).rejects.toMatchObject({ statusCode: 409, code: "ERR-STEP-NOT-PENDING" });
  });

  it("reuses the submit-time actionable-assignee validation: an inactive candidate is rejected", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter());
    mockLetterApprovalStep.findOne.mockResolvedValueOnce(makeStep());
    mockUserTenant.findOne.mockResolvedValue({ userId: "22222222-2222-2222-2222-222222222222", tenantId: TENANT_ID });
    mockUser.findOne.mockResolvedValue(null); // not active / not found

    await expect(
      reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "22222222-2222-2222-2222-222222222222" }, adminUser as any),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-ASSIGNEE-INVALID" });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });

  // Live browser testing (2026-08-11) found LETTER.STEP_PENDING routed by
  // departmentId only — the same gap already fixed for APPROVAL_CHAIN.UPDATED
  // and SIGNING.UPDATED. A named reassignment target isn't guaranteed to be a
  // member of the letter's own department, so they never got a live update.
  it("routes the LETTER.STEP_PENDING websocket event straight to the newly-reassigned user, not just their department", async () => {
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    const before = makeStep();
    const after = makeStep({ assignedUserId: "11111111-1111-1111-1111-111111111111" });
    mockLetterApprovalStep.findOne
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    mockLetterApprovalStep.update.mockResolvedValue([1]);
    mockUserTenant.findOne.mockResolvedValue({ userId: "11111111-1111-1111-1111-111111111111", tenantId: TENANT_ID });
    mockUser.findOne.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111", isActive: true });

    await reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "11111111-1111-1111-1111-111111111111" }, adminUser as any);

    expect(enqueueWebsocketEvent).toHaveBeenCalledWith(
      "LETTER.STEP_PENDING",
      expect.objectContaining({
        departmentId: DEPARTMENT_ID,
        recipientUserIds: ["11111111-1111-1111-1111-111111111111"],
      }),
    );
  });
});

describe("cancelLetter — IN_REVIEW admin override", () => {
  it("rejects cancellation of an IN_REVIEW letter without department:manage / admin bypass", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter());
    await expect(
      cancelLetter(LETTER_ID, { reason: "Assignee left the company months ago" }, nonAdminUser as any),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects cancellation of an IN_REVIEW letter without a sufficiently long reason", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter());
    await expect(cancelLetter(LETTER_ID, {}, adminUser as any)).rejects.toMatchObject({
      statusCode: 422,
      code: "ERR-REASON-REQUIRED",
    });
    await expect(
      cancelLetter(LETTER_ID, { reason: "too short" }, adminUser as any),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-REASON-REQUIRED" });
  });

  it("cancels an IN_REVIEW letter and every still-open approval step, with an audit trail", async () => {
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockLetterApprovalStep.update.mockResolvedValue([2]);

    const result = await cancelLetter(
      LETTER_ID,
      { reason: "Every DEPT_MANAGER holder in Finance left; chain is unrecoverable" },
      adminUser as any,
    );

    const stepUpdateArgs = mockLetterApprovalStep.update.mock.calls[0];
    expect(stepUpdateArgs[0]).toEqual({ status: "CANCELLED" });
    expect(stepUpdateArgs[1].where.letterId).toBe(LETTER_ID);
    expect(stepUpdateArgs[1].transaction).toBe(fakeTx);

    expect(letter.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: fakeTx });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LETTER_CANCELLED",
        actionDetails: expect.objectContaining({ letterId: LETTER_ID, forced: true, previousStatus: "IN_REVIEW" }),
      }),
    );
    expect(result).toBe(letter);
  });

  it("still allows the drafter to cancel a DRAFT letter without a reason (regression)", async () => {
    const letter = makeLetter({ status: "DRAFT", createdBy: nonAdminUser.userId });
    mockLetter.findOne.mockResolvedValue(letter);

    mockLetter.update.mockResolvedValue([1]);

    await cancelLetter(LETTER_ID, {}, nonAdminUser as any);

    // Guarded on the state that was checked (so a concurrent submit cannot be overwritten).
    expect(mockLetter.update).toHaveBeenCalledWith(
      { status: "CANCELLED" },
      { where: { id: LETTER_ID, tenantId: TENANT_ID, status: "DRAFT" } },
    );
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });

  it("still rejects cancellation of a terminal-state letter (e.g. DISPATCHED)", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "DISPATCHED" }));
    await expect(cancelLetter(LETTER_ID, {}, adminUser as any)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-STATE-INVALID",
    });
  });
});

// department:manage is a permission, not a place. Before the scope check every
// DEPT_MANAGER (a head of ANY department) could cancel any in-flight letter in the
// tenant and reassign any pending step — including to themselves, after which
// decideStep (named assignees are never department-scoped) lets them approve it.
describe("recovery actions are limited to the departments the actor heads", () => {
  const outsideManager = { ...adminUser, userId: "other-dept-manager" };
  const tenantAdmin = {
    userId: "sysadmin-1",
    role: "SYSTEM_ADMIN",
    tenantId: TENANT_ID,
    permissions: [PERMISSIONS.DEPT_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.LETTER_CREATE],
  };

  function headsOnly(departmentIds: string[]) {
    mockSequelize.query.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("WITH RECURSIVE managed")) {
        return Promise.resolve(departmentIds.map((id) => ({ id })));
      }
      if (typeof sql === "string" && sql.includes("SELECT r.name FROM roles")) return Promise.resolve([{ name: "APPROVER" }]);
      if (typeof sql === "string" && sql.includes("SELECT DISTINCT ur.user_id")) return Promise.resolve([{ user_id: "staffer-1" }]);
      return Promise.resolve([]);
    });
  }

  it("refuses reassignStep to a manager of a DIFFERENT department, and changes nothing", async () => {
    headsOnly(["some-other-dept"]);
    mockLetter.findOne.mockResolvedValue(makeLetter());
    mockLetterApprovalStep.findOne.mockResolvedValue(makeStep());
    await expect(
      reassignStep(LETTER_ID, STEP_ID, { assignedRole: "DEPT_MANAGER" }, outsideManager as any),
    ).rejects.toMatchObject({ statusCode: 403, code: "ERR-DEPT-SCOPE" });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("refuses cancelling an in-flight letter of a DIFFERENT department, and changes nothing", async () => {
    headsOnly(["some-other-dept"]);
    mockLetter.findOne.mockResolvedValue(makeLetter());
    await expect(
      cancelLetter(LETTER_ID, { reason: "Not my department but I would like to cancel it" }, outsideManager as any),
    ).rejects.toMatchObject({ statusCode: 403, code: "ERR-DEPT-SCOPE" });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("lets the head of a PARENT department act on a sub-department's letter (the managed set includes descendants)", async () => {
    headsOnly(["parent-dept", DEPARTMENT_ID]);
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockLetterApprovalStep.update.mockResolvedValue([1]);
    await cancelLetter(
      LETTER_ID,
      { reason: "Sub-department chain is unrecoverable, cancelling" },
      outsideManager as any,
    );
    expect(letter.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: fakeTx });
  });

  it("lets tenant-wide authority (acl:bypass_admin) act in any department without membership", async () => {
    headsOnly([]);
    const letter = makeLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockLetterApprovalStep.update.mockResolvedValue([1]);
    await cancelLetter(
      LETTER_ID,
      { reason: "Tenant administrator clearing a stuck chain" },
      tenantAdmin as any,
    );
    expect(letter.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: fakeTx });
  });

  it("answers as user-not-found when the new assignee is the hidden platform administrator", async () => {
    const platformAdmin = jest.requireMock("../src/shared/platformAdmin.js") as { assertNotHiddenUser: jest.Mock };
    const { AppError } = jest.requireActual("../src/core/AppError.js");
    platformAdmin.assertNotHiddenUser.mockRejectedValueOnce(new AppError(404, "ERR-USER-NOT-FOUND", "User not found"));
    mockLetter.findOne.mockResolvedValue(makeLetter());
    mockLetterApprovalStep.findOne.mockResolvedValue(makeStep());
    await expect(
      reassignStep(LETTER_ID, STEP_ID, { assignedUserId: "11111111-1111-1111-1111-111111111111" }, adminUser as any),
    ).rejects.toMatchObject({ statusCode: 404, code: "ERR-USER-NOT-FOUND" });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });
});
