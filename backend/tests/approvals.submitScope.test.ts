// submitForApproval must require the caller to be able to READ the item. approval:admin is held by every
// department manager and lets them submit someone else's item, but it never meant "any department's item":
// without the read-ACL check a manager of one department could push another department's draft into review,
// name themselves approver and be granted read access to it.

const mockApprovalChain = { findOne: jest.fn(), create: jest.fn() };
const mockApprovalStep = { create: jest.fn() };
const mockDocument = { findByPk: jest.fn() };
const mockAclEntry = { bulkCreate: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: mockAclEntry,
  ApprovalChain: mockApprovalChain,
  ApprovalChainTemplate: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn() },
  ApprovalStep: mockApprovalStep,
  AuditStageReview: {},
  Department: { findOne: jest.fn().mockResolvedValue(null) },
  Document: mockDocument,
  DocumentType: { findByPk: jest.fn(), findOne: jest.fn() },
  FormInstance: { findByPk: jest.fn(), findOne: jest.fn() },
  FormTemplate: { findOne: jest.fn(), findByPk: jest.fn() },
  User: { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn() },
  UserDepartment: { findAll: jest.fn() },
  UserTenant: { findAll: jest.fn(), findOne: jest.fn() },
  Role: { findOne: jest.fn() },
  UserRole: { findAll: jest.fn() },
  sequelize: { query: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../src/shared/platformAdmin.js", () => ({
  notPlatformAdminSql: () => "TRUE",
  withoutHiddenIds: async (ids: string[]) => ids,
  hiddenUserIds: jest.fn().mockResolvedValue([]),
  assertNotHiddenUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() }),
}));
jest.mock("../src/shared/documentGuards.js", () => ({ requireDocumentAccess: jest.fn(), requireLegalHoldClear: jest.fn() }));
const mockAssertAcl = jest.fn();
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: (...a: unknown[]) => mockAssertAcl(...a) }));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({ validateTransition: jest.fn() }));
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getResolvedRolePermissions: jest.fn().mockResolvedValue(["approval:decide"]),
}));

import { submitForApproval } from "../src/modules/approvals/approvals.service.js";
import { PERMISSIONS } from "../src/config/permissions.js";
import { AppError } from "../src/core/AppError.js";

const manager = {
  userId: "00000000-0000-4000-8000-000000000001",
  tenantId: "examplecorp",
  role: "DEPT_MANAGER",
  roles: ["DEPT_MANAGER"],
  permissions: [PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN],
};

beforeEach(() => {
  jest.clearAllMocks();
  // a draft that belongs to somebody else, in another department
  mockDocument.findByPk.mockResolvedValue({
    id: "doc-hr", tenantId: "examplecorp", departmentId: null, documentTypeId: null,
    ownerId: "00000000-0000-4000-8000-000000000099", title: "HR draft", deletedAt: null,
  });
});

describe("submitForApproval — item read scope", () => {
  it("refuses an approval admin who cannot read the document, before creating any chain or grant", async () => {
    mockAssertAcl.mockRejectedValue(new AppError(403, "AUTHZ_ACL_NO_ENTRY", "No access control entry for this resource"));
    await expect(submitForApproval("DOCUMENT", "doc-hr", {}, manager as never)).rejects.toMatchObject({ code: "AUTHZ_ACL_NO_ENTRY" });
    expect(mockApprovalChain.create).not.toHaveBeenCalled();
    expect(mockApprovalStep.create).not.toHaveBeenCalled();
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it("checks document:read on the backing document", async () => {
    mockAssertAcl.mockRejectedValue(new AppError(403, "AUTHZ_ACL_DENIED", "Access denied by ACL"));
    await expect(submitForApproval("DOCUMENT", "doc-hr", {}, manager as never)).rejects.toBeInstanceOf(AppError);
    expect(mockAssertAcl).toHaveBeenCalledWith(
      manager.userId, ["DEPT_MANAGER"], "examplecorp",
      { resourceType: "document", resourceId: "doc-hr", permission: "document:read" },
      manager.permissions,
    );
  });

  it("still refuses a non-owner without approval:admin first (ownership rule unchanged)", async () => {
    const employee = { ...manager, permissions: [PERMISSIONS.APPROVAL_SUBMIT] };
    await expect(submitForApproval("DOCUMENT", "doc-hr", {}, employee as never)).rejects.toMatchObject({ code: "ERR-NOT-ITEM-OWNER" });
    expect(mockAssertAcl).not.toHaveBeenCalled();
  });
});
