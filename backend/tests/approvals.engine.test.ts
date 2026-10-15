// Unified approval engine (modules/approvals) — guard/invariant coverage for
// the largest previously-untested subsystem. Fully mocked (no live DB),
// mirroring letters.reassignCancel.test.ts's style. Scope: the validation and
// permission surface of decideStep / reassignStep / cancelChain /
// upsertChainTemplate — the sequential-step engine's happy paths stay covered
// end-to-end by the live verifiers (verify-runtime-flows, brd.scenarios).

const mockApprovalChain = { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn() };
const mockApprovalStep = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), bulkCreate: jest.fn() };
const mockApprovalChainTemplate = { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() };
// findAll: grantChainParticipantAcl now asks which documents are classified (approvals/classifiedParticipants.ts); none here are.
const mockDocument = { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]) };
const mockFormTemplate = { findOne: jest.fn(), findByPk: jest.fn() };
const mockDocumentType = { findByPk: jest.fn(), findOne: jest.fn() };
const mockUserTenant = { findAll: jest.fn(), findOne: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };
const mockUser = { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn() };
// normalizeApprovalDepartmentId (approvals.service.ts) looks this up to
// detect the synthetic UNCAT department; default (set in beforeEach) is "not
// UNCAT" so departmentId passes through unchanged for every existing test.
const mockDepartment = { findOne: jest.fn() };
// The engine now grants document:read to the people a chain routes work to
// (grantChainParticipantAcl) — without this the mock would be undefined the
// moment a reassignment actually succeeds.
const mockAclEntry = { bulkCreate: jest.fn(), findOne: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: mockAclEntry,
  ApprovalChain: mockApprovalChain,
  ApprovalChainTemplate: mockApprovalChainTemplate,
  ApprovalStep: mockApprovalStep,
  AuditStageReview: { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
  Department: mockDepartment,
  Document: mockDocument,
  DocumentType: mockDocumentType,
  FormInstance: { findByPk: jest.fn(), findOne: jest.fn() },
  FormTemplate: mockFormTemplate,
  User: mockUser,
  UserDepartment: mockUserDepartment,
  UserTenant: mockUserTenant,
  Role: { findOne: jest.fn() },
  UserRole: { findAll: jest.fn() },
  sequelize: { query: jest.fn().mockResolvedValue([]) },
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));
// The hidden platform administrator (shared/platformAdmin.ts) is a DB lookup; nobody is hidden unless a test says so.
const mockHiddenUserIds = jest.fn();
const mockAssertNotHiddenUser = jest.fn();
jest.mock("../src/shared/platformAdmin.js", () => ({
  notPlatformAdminSql: () => "TRUE",
  withoutHiddenIds: async (ids: string[]) => ids,
  hiddenUserIds: (...a: unknown[]) => mockHiddenUserIds(...a),
  assertNotHiddenUser: (...a: unknown[]) => mockAssertNotHiddenUser(...a),
}));
jest.mock("../src/modules/notifications/notifications.service.js", () => ({
  fanOut: jest.fn().mockResolvedValue(undefined),
}));
const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));
const mockRequireDocumentAccess = jest.fn();
jest.mock("../src/shared/documentGuards.js", () => ({
  requireDocumentAccess: (...args: unknown[]) => mockRequireDocumentAccess(...args),
  requireLegalHoldClear: jest.fn(),
}));
jest.mock("../src/shared/resolveACL.js", () => ({
  assertACLAllow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({
  validateTransition: jest.fn(),
}));
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getResolvedRolePermissions: jest.fn().mockResolvedValue(["approval:decide"]),
}));

import { decideStep, reassignStep, cancelChain, upsertChainTemplate, submitForApproval } from "../src/modules/approvals/approvals.service.js";
import { PERMISSIONS } from "../src/config/permissions.js";
import { AppError } from "../src/core/AppError.js";

const approver = {
  userId: "00000000-0000-4000-8000-000000000001",
  tenantId: "examplecorp",
  role: "DEPT_MANAGER",
  permissions: [PERMISSIONS.APPROVAL_DECIDE],
};
const admin = {
  ...approver,
  role: "SYSTEM_ADMIN",
  // acl:bypass_admin = organisation-level authority (the SYSTEM_ADMIN reality): may define recipes at any scope.
  permissions: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.ACL_BYPASS_ADMIN],
};

const CHAIN_ID = "00000000-0000-4000-8000-00000000c001";
const STEP_ID = "00000000-0000-4000-8000-00000000a001";
const OTHER_USER = "00000000-0000-4000-8000-000000000099";

function inReviewChain(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: CHAIN_ID, tenantId: "examplecorp", status: "IN_REVIEW",
    itemType: "DOCUMENT", itemId: "doc-1", submittedBy: OTHER_USER,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  // Sequelize instances expose .get({ plain: true }); getChain() (which
  // reassignStep calls to return the updated chain) relies on it. Without this
  // any test that gets PAST a guard fails on "chain.get is not a function"
  // rather than on the behaviour it is actually asserting.
  row.get = () => ({ ...row, steps: [] });
  return row;
}
function pendingStep(overrides: Record<string, unknown> = {}) {
  return {
    id: STEP_ID, chainId: CHAIN_ID, status: "PENDING", stepType: "APPROVE",
    assignedUserId: approver.userId, assignedRole: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHiddenUserIds.mockResolvedValue([]);
  mockAssertNotHiddenUser.mockResolvedValue(undefined);
  // clearAllMocks keeps implementations — reset the access guard to a no-op
  // so the throwing implementation from the D9 test never leaks forward.
  mockRequireDocumentAccess.mockReset();
  mockDepartment.findOne.mockResolvedValue(null);
  mockDocument.findByPk.mockResolvedValue({
    id: "doc-1", tenantId: "examplecorp", departmentId: null, documentTypeId: null,
    ownerId: OTHER_USER, title: "Test doc", deletedAt: null,
  });
});

describe("decideStep — guards and invariants", () => {
  it("rejects an unknown decision value (zod)", async () => {
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "MAYBE" }, approver)).rejects.toThrow();
  });

  it("404s when the chain does not exist in the user's tenant", async () => {
    mockApprovalChain.findOne.mockResolvedValue(null);
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-CHAIN-NOT-FOUND" });
  });

  it("409s when the chain is not IN_REVIEW", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain({ status: "APPROVED" }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-CHAIN-STATE-INVALID" });
  });

  it("409s when the step is not the currently-PENDING one", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep({ status: "WAITING" }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-STEP-NOT-PENDING" });
  });

  it("403s when the step is assigned to someone else (named-user step)", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep({ assignedUserId: OTHER_USER }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-STEP-NOT-ASSIGNED" });
  });

  it("403s without the approval:decide permission even when assigned", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, { ...approver, permissions: [] }))
      .rejects.toMatchObject({ code: "ERR-PERMISSION-DENIED" });
  });

  it("D3: DECLINE without a comment is a 422", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "DECLINE", comment: "  " }, approver))
      .rejects.toMatchObject({ code: "ERR-DECLINE-COMMENT-REQUIRED" });
  });

  it("department-scopes role-assigned steps: a non-member cannot decide", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep({ assignedUserId: null, assignedRole: "DEPT_MANAGER" }));
    mockDocument.findByPk.mockResolvedValue({
      id: "doc-1", tenantId: "examplecorp", departmentId: "dept-hr", documentTypeId: null,
      ownerId: OTHER_USER, title: "HR doc", deletedAt: null,
    });
    mockUserDepartment.findAll.mockResolvedValue([{ departmentId: "dept-finance" }]);
    await expect(
      decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, { ...approver, role: "DEPT_MANAGER" }),
    ).rejects.toMatchObject({ code: "ERR-STEP-DEPT-SCOPE" });
  });

  it("propagates the item's own access check (D9 visibility)", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    mockRequireDocumentAccess.mockImplementationOnce(() => {
      throw new AppError(403, "ERR-DOC-ACCESS", "No access");
    });
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-DOC-ACCESS" });
  });
});

describe("reassignStep — admin recovery", () => {
  const valid = { assignedUserId: OTHER_USER, reason: "assignee left the company" };

  it("requires approval:admin", async () => {
    await expect(reassignStep(CHAIN_ID, STEP_ID, valid, approver))
      .rejects.toMatchObject({ code: "ERR-PERMISSION-DENIED" });
  });

  it("rejects providing BOTH a user and a role (XOR invariant)", async () => {
    await expect(
      reassignStep(CHAIN_ID, STEP_ID, { ...valid, assignedRole: "DEPT_MANAGER" }, admin),
    ).rejects.toThrow();
  });

  it("rejects a reason shorter than 10 chars", async () => {
    await expect(reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: OTHER_USER, reason: "short" }, admin))
      .rejects.toThrow();
  });


  // ── Cross-department assignee must be able to OPEN their work ───────────
  //
  // Live-reproduced bug: assigning a step to a NAMED user outside the item's
  // department is deliberately allowed (a named assignee is globally scoped by
  // design; the picker only shows a cross-department advisory). But nothing
  // granted that person access to the document — grantDefaultDocumentAcl
  // grants document:read to the owner and a SNAPSHOT of the document's own
  // department, and this module wrote no ACL entries at all. So the assignee's
  // first click died with AUTHZ_ACL_NO_ENTRY, "No access control entry for
  // this resource", and they could never reach the Workflow tab to act.
  //
  // getChain() lets a chain participant bypass its own ACL check, but the page
  // loads GET /documents/:id first and that has no such bypass — so the
  // document fetch is what failed. letters.service.ts already does this for
  // its signatory; these pin the engine's equivalent.

  it("grants the new named assignee document:read so they can open the item", async () => {
    const db = jest.requireMock("../src/infrastructure/database/index.js") as any;
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    db.UserTenant.findOne.mockResolvedValue({ userId: OTHER_USER, tenantId: "examplecorp" });
    mockUser.findOne.mockResolvedValue({ id: OTHER_USER, isActive: true });
    db.sequelize.query.mockResolvedValue([{ name: "DEPT_MANAGER" }]);
    mockApprovalStep.update.mockResolvedValue([1]);
    // reassignStep returns the refreshed chain via getChain() — give that read
    // path enough to complete so the assertion is about the ACL grant.
    mockApprovalStep.findAll.mockResolvedValue([]);
    db.AuditStageReview.findAll.mockResolvedValue([]);

    await reassignStep(CHAIN_ID, STEP_ID, valid, admin);

    expect(mockAclEntry.bulkCreate).toHaveBeenCalledTimes(1);
    const [rows] = mockAclEntry.bulkCreate.mock.calls[0]!;
    expect(rows).toEqual([
      expect.objectContaining({
        tenantId: "examplecorp",
        resourceType: "document",
        resourceId: "doc-1",
        principalType: "user",
        principalId: OTHER_USER,
        effect: "ALLOW",
        permission: "document:read",
      }),
    ]);
  });

  it("grants a reassigned ROLE as a role principal, read-only", async () => {
    // resolveACL matches an ACL role principal against the acting user's role
    // NAMES. It is only a READ grant — deciding still requires
    // department-scoped role membership, checked separately at decide time.
    const db = jest.requireMock("../src/infrastructure/database/index.js") as any;
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    db.sequelize.query.mockResolvedValue([{ name: "DEPT_MANAGER" }]);
    mockUser.findAll.mockResolvedValue([{ id: OTHER_USER }]);
    mockApprovalStep.update.mockResolvedValue([1]);
    mockApprovalStep.findAll.mockResolvedValue([]);
    db.AuditStageReview.findAll.mockResolvedValue([]);

    await reassignStep(
      CHAIN_ID,
      STEP_ID,
      { assignedRole: "DEPT_MANAGER", reason: "role queue takes it over" },
      admin,
    );

    const [rows] = mockAclEntry.bulkCreate.mock.calls[0]!;
    expect(rows).toEqual([
      expect.objectContaining({
        principalType: "role",
        principalId: "DEPT_MANAGER",
        permission: "document:read",
        effect: "ALLOW",
      }),
    ]);
  });

  it("grants nothing when the reassignment itself fails", async () => {
    // The grant lives inside the same transaction as the step update, so a
    // rejected reassignment must not leave behind access to a document the
    // person was never actually assigned.
    const db = jest.requireMock("../src/infrastructure/database/index.js") as any;
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    db.UserTenant.findOne.mockResolvedValue({ userId: OTHER_USER, tenantId: "examplecorp" });
    mockUser.findOne.mockResolvedValue({ id: OTHER_USER, isActive: true });
    db.sequelize.query.mockResolvedValue([{ name: "DEPT_MANAGER" }]);
    mockApprovalStep.update.mockResolvedValue([0]);

    await expect(reassignStep(CHAIN_ID, STEP_ID, valid, admin)).rejects.toMatchObject({
      code: "ERR-STEP-NOT-REASSIGNABLE",
    });
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it("409s when the target step is already decided (guarded update matched 0 rows)", async () => {
    const db = jest.requireMock("../src/infrastructure/database/index.js") as any;
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain());
    // assertStepIsActionable: tenant member, active, holds a decide-granting role
    db.UserTenant.findOne.mockResolvedValue({ userId: OTHER_USER, tenantId: "examplecorp" });
    mockUser.findOne.mockResolvedValue({ id: OTHER_USER, isActive: true });
    db.sequelize.query.mockResolvedValue([{ name: "DEPT_MANAGER" }]);
    mockApprovalStep.update.mockResolvedValue([0]);
    await expect(reassignStep(CHAIN_ID, STEP_ID, valid, admin)).rejects.toMatchObject({
      code: "ERR-STEP-NOT-REASSIGNABLE",
    });
  });
});

describe("cancelChain — admin override", () => {
  it("requires approval:admin", async () => {
    await expect(cancelChain(CHAIN_ID, "a sufficiently long reason", approver))
      .rejects.toMatchObject({ code: "ERR-PERMISSION-DENIED" });
  });

  it("requires a substantive reason (>=10 chars)", async () => {
    await expect(cancelChain(CHAIN_ID, "nope", admin))
      .rejects.toMatchObject({ code: "ERR-CANCEL-REASON-REQUIRED" });
  });

  it("409s when the chain is already terminal", async () => {
    mockApprovalChain.findOne
      .mockResolvedValueOnce(inReviewChain({ status: "APPROVED" })) // initial load
      .mockResolvedValueOnce(null); // locked re-read filtered by cancellable states
    await expect(cancelChain(CHAIN_ID, "cancelling for a valid documented reason", admin))
      .rejects.toMatchObject({ code: "ERR-CHAIN-STATE-INVALID" });
  });

  it("cancels a running chain: steps bulk-cancelled, chain CANCELLED, submitter notified", async () => {
    const locked = inReviewChain();
    mockApprovalChain.findOne.mockResolvedValue(locked);
    mockApprovalStep.update.mockResolvedValue([2]);
    mockDocument.findOne.mockResolvedValue(null);
    mockDocument.findByPk.mockResolvedValue({
      id: "doc-1", tenantId: "examplecorp", departmentId: null, documentTypeId: null,
      ownerId: OTHER_USER, title: "Test doc", deletedAt: null, status: "ACTIVE",
    });

    const result = await cancelChain(CHAIN_ID, "cancelling for a valid documented reason", admin);

    expect(result).toEqual({ success: true });
    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      { status: "CANCELLED" },
      expect.objectContaining({ where: expect.objectContaining({ chainId: CHAIN_ID }) }),
    );
    expect(locked.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
      expect.anything(),
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actionDetails: expect.objectContaining({ chainId: CHAIN_ID }) }),
    );
  });
});

describe("upsertChainTemplate — template invariants", () => {
  it("rejects a step naming BOTH a user and a role", async () => {
    await expect(
      upsertChainTemplate(
        {
          documentTypeId: "00000000-0000-4000-8000-00000000d001",
          name: "Contract chain",
          steps: [{ stepType: "APPROVE", assignedUserId: OTHER_USER, assignedRole: "DEPT_MANAGER" }],
        },
        admin,
      ),
    ).rejects.toThrow();
  });

  it("rejects an empty step list", async () => {
    await expect(
      upsertChainTemplate(
        { documentTypeId: "00000000-0000-4000-8000-00000000d001", name: "Empty", steps: [] },
        admin,
      ),
    ).rejects.toThrow();
  });

  it("rejects sub-hour SLA values (floor is 1 hour)", async () => {
    await expect(
      upsertChainTemplate(
        {
          documentTypeId: "00000000-0000-4000-8000-00000000d001",
          name: "Bad SLA",
          steps: [{ stepType: "APPROVE", assignedRole: "DEPT_MANAGER", slaHours: 0 }],
        },
        admin,
      ),
    ).rejects.toThrow();
  });
});

// Separation of duties: nobody approves what they authored or submitted.
describe("decideStep — no self-approval", () => {
  it("refuses APPROVE from the person who submitted the chain", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain({ submittedBy: approver.userId }));
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ statusCode: 403, code: "ERR-SELF-APPROVAL" });
  });

  it("refuses APPROVE from the document's owner even when someone else submitted it", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain({ submittedBy: OTHER_USER }));
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    mockDocument.findByPk.mockResolvedValue({
      id: "doc-1", tenantId: "examplecorp", departmentId: null, documentTypeId: null,
      ownerId: approver.userId, title: "Mine", deletedAt: null,
    });
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver))
      .rejects.toMatchObject({ code: "ERR-SELF-APPROVAL" });
  });

  it("applies to a role-assigned step too (the DEPT_MANAGER who uploaded and submitted cannot approve as DEPT_MANAGER)", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain({ submittedBy: approver.userId }));
    mockApprovalStep.findOne.mockResolvedValue(pendingStep({ assignedUserId: null, assignedRole: "DEPT_MANAGER" }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, { ...approver, roles: ["DEPT_MANAGER"] }))
      .rejects.toMatchObject({ code: "ERR-SELF-APPROVAL" });
  });

  it("does not stop the author sending their own item back (REQUEST_CHANGES is not an approval)", async () => {
    mockApprovalChain.findOne.mockResolvedValue(inReviewChain({ submittedBy: approver.userId }));
    mockApprovalStep.findOne.mockResolvedValue(pendingStep());
    const outcome = await decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES", comment: "pulling it back" }, approver).catch((e) => e);
    expect(outcome?.code).not.toBe("ERR-SELF-APPROVAL");
  });
});

describe("submitForApproval — no step addressed to the author or submitter", () => {
  it.each([
    ["the submitter", admin.userId],
    ["the item's author", OTHER_USER],
  ])("rejects a named step for %s before creating the chain", async (_label, assignedUserId) => {
    mockApprovalChain.findOne.mockResolvedValue(null);
    mockApprovalChainTemplate.findOne.mockResolvedValue(null);
    await expect(
      submitForApproval("DOCUMENT", "doc-1", { steps: [{ stepType: "APPROVE", assignedUserId }] }, admin),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-SELF-APPROVAL" });
    expect(mockApprovalChain.create).not.toHaveBeenCalled();
  });
});

describe("upsertChainTemplate — targets and assignees belong to the tenant", () => {
  const DOC_TYPE = "00000000-0000-4000-8000-00000000d001";
  const FORM_TPL = "00000000-0000-4000-8000-00000000f001";
  const step = { stepType: "APPROVE" as const, assignedRole: "DEPT_MANAGER" };

  it("rejects a document type that is not in the caller's tenant", async () => {
    mockDocumentType.findOne.mockResolvedValue(null);
    await expect(upsertChainTemplate({ documentTypeId: DOC_TYPE, name: "x", steps: [step] }, admin))
      .rejects.toMatchObject({ statusCode: 422, code: "ERR-TEMPLATE-TARGET" });
    expect(mockApprovalChainTemplate.create).not.toHaveBeenCalled();
    expect(mockDocumentType.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DOC_TYPE, tenantId: "examplecorp" } }));
  });

  it("rejects a form template that is not in the caller's tenant", async () => {
    mockFormTemplate.findOne.mockResolvedValue(null);
    await expect(upsertChainTemplate({ formTemplateId: FORM_TPL, name: "x", steps: [step] }, admin))
      .rejects.toMatchObject({ code: "ERR-TEMPLATE-TARGET" });
  });

  it("rejects a named approver who is not a member of the tenant", async () => {
    mockDocumentType.findOne.mockResolvedValue({ id: DOC_TYPE });
    mockUserTenant.findOne.mockResolvedValue(null);
    await expect(
      upsertChainTemplate({ documentTypeId: DOC_TYPE, name: "x", steps: [{ stepType: "APPROVE", assignedUserId: OTHER_USER }] }, admin),
    ).rejects.toMatchObject({ code: "ERR-ASSIGNEE-INVALID" });
  });

  it("rejects the platform-admin role as an approver", async () => {
    mockDocumentType.findOne.mockResolvedValue({ id: DOC_TYPE });
    await expect(
      upsertChainTemplate({ documentTypeId: DOC_TYPE, name: "x", steps: [{ stepType: "APPROVE", assignedRole: "PLATFORM_ADMIN" }] }, admin),
    ).rejects.toMatchObject({ code: "ERR-STEP-ROLE-INVALID" });
  });

  it("accepts a template for a type in the tenant", async () => {
    mockDocumentType.findOne.mockResolvedValue({ id: DOC_TYPE });
    mockApprovalChainTemplate.create.mockResolvedValue({ id: "tpl-1" });
    await expect(upsertChainTemplate({ documentTypeId: DOC_TYPE, name: "x", steps: [step] }, admin)).resolves.toMatchObject({ id: "tpl-1" });
  });
});
