// Approval engine follow-ups (module audit 2026-10-04, items E1-E7 + finding #23). Fully mocked, no live DB, in the
// style of approvals.engine.test.ts. Each block pins one defect that existed before and fails without its fix:
//
//   E1  activating a template version left the previous active version active;
//   E2  engine audit events for a form carried no documentId;
//   E3  a form's chain view never listed its audit-stage reviews (looked up as FORM_INSTANCE, stored as DOCUMENT);
//   E4  the hidden platform administrator showed up in chain views and could be named as an approver / delegate / auditor;
//   E5  chain participants got read on the main PDF only, not on the form's attachments;
//   E6  approving a form TEMPLATE had no recipe/scope: any department manager could activate a company-wide template;
//       recipes had no department / org-unit scope;
//   E7  (engine half) the filer could not take a submission back out of review;
//   #23 step delegation (rules below) and escalation of an overdue step (approvals.escalation.test.ts).

const mockApprovalChain = { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() };
const mockApprovalStep = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() };
const mockApprovalChainTemplate = { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), update: jest.fn() };
const mockDocument = { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn() };
const mockFormTemplate = { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() };
const mockFormInstance = { findByPk: jest.fn(), findOne: jest.fn() };
const mockDocumentType = { findByPk: jest.fn(), findOne: jest.fn() };
const mockUserTenant = { findAll: jest.fn(), findOne: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };
const mockUser = { findAll: jest.fn(), findOne: jest.fn(), findByPk: jest.fn() };
const mockDepartment = { findOne: jest.fn() };
const mockOrgUnit = { findOne: jest.fn() };
const mockAclEntry = { bulkCreate: jest.fn(), findOne: jest.fn() };
const mockAuditStageReview = { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() };
const mockSequelizeQuery = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: mockAclEntry,
  ApprovalChain: mockApprovalChain,
  ApprovalChainTemplate: mockApprovalChainTemplate,
  ApprovalStep: mockApprovalStep,
  AuditStageReview: mockAuditStageReview,
  Department: mockDepartment,
  Document: mockDocument,
  DocumentType: mockDocumentType,
  FormInstance: mockFormInstance,
  FormTemplate: mockFormTemplate,
  OrgUnit: mockOrgUnit,
  User: mockUser,
  UserDepartment: mockUserDepartment,
  UserTenant: mockUserTenant,
  Role: { findOne: jest.fn() },
  UserRole: { findAll: jest.fn() },
  sequelize: { query: (...a: unknown[]) => mockSequelizeQuery(...a) },
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a) }));
const mockFanOut = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: (...a: unknown[]) => mockFanOut(...a) }));
const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));
jest.mock("../src/shared/documentGuards.js", () => ({ requireDocumentAccess: jest.fn(), requireLegalHoldClear: jest.fn() }));
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({ validateTransition: jest.fn() }));
const mockGetResolvedRolePermissions = jest.fn();
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getResolvedRolePermissions: (...a: unknown[]) => mockGetResolvedRolePermissions(...a),
}));
// getUserDepartmentIds reads through this cache module (otherwise a real database query).
const mockLoadUserDepartmentIds = jest.fn();
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: (...a: unknown[]) => mockLoadUserDepartmentIds(...a),
}));
const mockHiddenUserIds = jest.fn();
const mockAssertNotHiddenUser = jest.fn();
jest.mock("../src/shared/platformAdmin.js", () => ({
  notPlatformAdminSql: () => "TRUE",
  withoutHiddenIds: async (ids: string[]) => ids,
  hiddenUserIds: (...a: unknown[]) => mockHiddenUserIds(...a),
  assertNotHiddenUser: (...a: unknown[]) => mockAssertNotHiddenUser(...a),
}));

import { Op } from "sequelize";
import { PERMISSIONS } from "../src/config/permissions.js";
import { config } from "../src/config/env.js";
import {
  decideStep,
  getChain,
  getChainHistory,
  getSubmitPrefill,
  reassignStep,
  cancelChain,
  upsertChainTemplate,
  attachmentDocumentIds,
} from "../src/modules/approvals/approvals.service.js";
import { delegateStep } from "../src/modules/approvals/delegation.service.js";
import { withdrawOwnSubmission } from "../src/modules/approvals/withdraw.service.js";

const TENANT = "examplecorp";
const HIDDEN = "00000000-0000-4000-8000-0000000000ad";
const FILER = "00000000-0000-4000-8000-0000000000f1";
const APPROVER = "00000000-0000-4000-8000-0000000000a1";
const DELEGATE = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-000000000099";
const CHAIN_ID = "00000000-0000-4000-8000-00000000c001";
const STEP_ID = "00000000-0000-4000-8000-00000000a001";
const ATT_DOC = "00000000-0000-4000-8000-00000000a7a7";

const approver = { userId: APPROVER, tenantId: TENANT, role: "APPROVER", roles: ["APPROVER"], permissions: [PERMISSIONS.APPROVAL_DECIDE] };
const approvalAdmin = { ...approver, userId: "00000000-0000-4000-8000-0000000000b1", role: "DEPT_MANAGER", roles: ["DEPT_MANAGER"], permissions: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN] };
const orgAdmin = { ...approvalAdmin, role: "SYSTEM_ADMIN", roles: ["SYSTEM_ADMIN"], permissions: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.ACL_BYPASS_ADMIN] };

function chainRow(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: CHAIN_ID, tenantId: TENANT, status: "IN_REVIEW", itemType: "DOCUMENT", itemId: "doc-1", submittedBy: OTHER,
    update: jest.fn().mockResolvedValue(undefined), ...over,
  };
  row.get = () => ({ ...row, steps: (row as { _steps?: unknown[] })._steps ?? [] });
  return row;
}
function stepRow(over: Record<string, unknown> = {}) {
  return {
    id: STEP_ID, chainId: CHAIN_ID, status: "PENDING", stepType: "APPROVE", stepOrder: 1, locked: false,
    assignedUserId: APPROVER, assignedRole: null, delegatedAt: null, escalatedToUserIds: [],
    update: jest.fn().mockResolvedValue(undefined), ...over,
  };
}
function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1", tenantId: TENANT, departmentId: null, documentTypeId: null, ownerId: OTHER, title: "Doc", deletedAt: null,
    status: "IN_REVIEW", update: jest.fn().mockResolvedValue(undefined), ...over,
  };
}
function templateRow(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "ft-2", tenantId: TENANT, name: "Leave Form", version: 2, status: "pending_approval", createdBy: OTHER,
    departmentId: null, orgUnitId: null, ...over,
  };
  row.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(row, patch); return row; });
  return row;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockFanOut.mockResolvedValue(undefined);
  mockHiddenUserIds.mockResolvedValue([]);
  mockAssertNotHiddenUser.mockResolvedValue(undefined);
  // normalizeApprovalDepartmentId asks for the UNCAT bucket (never the case here); recipeScopeFor wants the org unit.
  mockDepartment.findOne.mockImplementation(async (q: { where?: { code?: string } }) => (q?.where?.code === "UNCAT" ? null : { orgUnitId: "ou-1" }));
  mockLoadUserDepartmentIds.mockResolvedValue([]);
  mockDocument.findByPk.mockResolvedValue(docRow());
  mockDocument.findAll.mockResolvedValue([]);
  mockApprovalChainTemplate.findAll.mockResolvedValue([]);
  mockAuditStageReview.findAll.mockResolvedValue([]);
  mockApprovalStep.update.mockResolvedValue([1]);
  mockSequelizeQuery.mockResolvedValue([{ name: "EMPLOYEE" }]); // the role rows of any user the engine looks up
  mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE]);
  mockUserTenant.findOne.mockResolvedValue({ userId: DELEGATE, tenantId: TENANT });
  mockUser.findOne.mockResolvedValue({ id: DELEGATE, isActive: true });
  mockUser.findAll.mockResolvedValue([]);
  mockUser.findByPk.mockResolvedValue({ firstName: "Dee", lastName: "Legate" });
});

// ── E1 ───────────────────────────────────────────────────────────────────────
describe("E1 — activating a template version deprecates the version it replaces, atomically", () => {
  it("deprecates older ACTIVE versions of the same template inside the deciding transaction", async () => {
    const tpl = templateRow();
    const older = templateRow({ id: "ft-1", version: 1, status: "active" });
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_TEMPLATE", itemId: "ft-2" }));
    mockApprovalStep.findOne
      .mockResolvedValueOnce(stepRow()) // the step being decided
      .mockResolvedValueOnce(null); // no WAITING step after it: this is the final approval
    mockFormTemplate.findOne.mockResolvedValue(tpl); // loadItem
    mockFormTemplate.findByPk.mockResolvedValue(tpl);
    mockFormTemplate.findAll.mockResolvedValue([older]);

    await decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver);

    expect(mockFormTemplate.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, name: "Leave Form", status: "active", version: { [Op.lt]: 2 } },
        transaction: fakeTx,
      }),
    );
    expect(older.update).toHaveBeenCalledWith({ status: "deprecated" }, { transaction: fakeTx });
    expect(tpl.update).toHaveBeenCalledWith({ status: "active", approvedBy: APPROVER }, { transaction: fakeTx });
    // and it is on the record
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionDetails: expect.objectContaining({ action: "form_template_status_changed", templateId: "ft-1", status: "deprecated", supersededBy: "ft-2" }),
      }),
    );
  });

  it("never deprecates a NEWER version (an older revision approved late must not kill the newer active one)", async () => {
    const tpl = templateRow({ version: 1 });
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_TEMPLATE", itemId: "ft-2" }));
    mockApprovalStep.findOne.mockResolvedValueOnce(stepRow()).mockResolvedValueOnce(null);
    mockFormTemplate.findOne.mockResolvedValue(tpl);
    mockFormTemplate.findByPk.mockResolvedValue(tpl);
    mockFormTemplate.findAll.mockResolvedValue([]);
    await decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, approver);
    expect(mockFormTemplate.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: { [Op.lt]: 1 } }) }));
  });
});

// ── E2 ───────────────────────────────────────────────────────────────────────
describe("E2 — engine audit events for a form carry the backing document and the form ids", () => {
  it("a decision on a FORM_INSTANCE is audited against its document", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_INSTANCE", itemId: "fi-1" }));
    mockApprovalStep.findOne.mockResolvedValue(stepRow());
    mockFormInstance.findByPk.mockResolvedValue({ id: "fi-1", documentId: "doc-fi", templateId: "ft-1" });
    mockDocument.findByPk.mockResolvedValue(docRow({ id: "doc-fi" }));

    await decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES", comment: "fix the dates" }, approver);

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "doc-fi",
        actionDetails: expect.objectContaining({ itemType: "FORM_INSTANCE", formInstanceId: "fi-1", formTemplateId: "ft-1", documentId: "doc-fi" }),
      }),
    );
  });

  it("a FORM_TEMPLATE event has no document but names the template", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_TEMPLATE", itemId: "ft-2" }));
    mockApprovalStep.findOne.mockResolvedValue(stepRow());
    const tpl = templateRow();
    mockFormTemplate.findOne.mockResolvedValue(tpl);
    mockFormTemplate.findByPk.mockResolvedValue(tpl);
    await decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES", comment: "rework the layout" }, approver);
    const call = mockWriteAuditLog.mock.calls.find((c) => (c[0] as { actionDetails?: { stepId?: string } }).actionDetails?.stepId === STEP_ID)!;
    expect((call[0] as { documentId?: string }).documentId).toBeUndefined();
    expect((call[0] as { actionDetails: Record<string, unknown> }).actionDetails).toMatchObject({ formTemplateId: "ft-2" });
  });
});

// ── E3 + E4 ──────────────────────────────────────────────────────────────────
describe("getChain — audit reviews of a form and the hidden platform administrator", () => {
  function formChain() {
    const row = chainRow({ itemType: "FORM_INSTANCE", itemId: "fi-1", submittedBy: HIDDEN });
    (row as { get: () => unknown }).get = () => ({
      id: CHAIN_ID, itemType: "FORM_INSTANCE", itemId: "fi-1", status: "IN_REVIEW",
      submittedBy: HIDDEN, submitter: { id: HIDDEN, firstName: "Root", lastName: "Admin", email: "root@x" },
      steps: [
        {
          id: "s1", status: "APPROVED", assignedRole: null, assignedUserId: HIDDEN,
          assignedUser: { id: HIDDEN, firstName: "Root" }, decidedBy: HIDDEN, decider: { id: HIDDEN, firstName: "Root" },
          delegatedBy: null, escalatedToUserIds: [HIDDEN, DELEGATE],
        },
      ],
    });
    return row;
  }
  beforeEach(() => {
    mockFormInstance.findByPk.mockResolvedValue({ id: "fi-1", documentId: "doc-fi", templateId: "ft-1" });
    mockDocument.findByPk.mockResolvedValue(docRow({ id: "doc-fi" }));
    mockApprovalChain.findOne.mockResolvedValue(formChain());
    mockUser.findAll.mockResolvedValue([{ id: DELEGATE, firstName: "Dee", lastName: "Legate", email: "d@x" }]);
  });

  it("E3: looks the audit reviews up under the backing DOCUMENT, the way they are stored", async () => {
    await getChain("FORM_INSTANCE", "fi-1", approver);
    expect(mockAuditStageReview.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { itemType: "DOCUMENT", itemId: "doc-fi", tenantId: TENANT } }),
    );
  });

  it("E3: a DOCUMENT is looked up by its own id, unchanged", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    await getChain("DOCUMENT", "doc-1", approver);
    expect(mockAuditStageReview.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { itemType: "DOCUMENT", itemId: "doc-1", tenantId: TENANT } }),
    );
  });

  it("E4: redacts the hidden administrator from submitter, assignee, decider, escalatees and audit reviews", async () => {
    mockHiddenUserIds.mockResolvedValue([HIDDEN]);
    mockAuditStageReview.findAll.mockResolvedValue([
      {
        auditorUserId: HIDDEN, assignedBy: OTHER,
        get: () => ({ id: "r1", auditorUserId: HIDDEN, auditor: { id: HIDDEN, firstName: "Root" }, assignedBy: OTHER, assigner: { id: OTHER } }),
      },
    ]);
    const view = (await getChain("FORM_INSTANCE", "fi-1", approver)) as any;

    expect(mockHiddenUserIds).toHaveBeenCalledWith(APPROVER); // the viewer is never hidden from themselves
    expect(view.submittedBy).toBeNull();
    expect(view.submitter).toBeNull();
    expect(view.steps[0].assignedUserId).toBeNull();
    expect(view.steps[0].assignedUser).toBeNull();
    expect(view.steps[0].decidedBy).toBeNull();
    expect(view.steps[0].decider).toBeNull();
    expect(view.steps[0].escalatedToUserIds).toEqual([DELEGATE]);
    expect(view.auditReviews[0].auditor).toBeNull();
    expect(view.auditReviews[0].auditorUserId).toBeNull();
    expect(view.auditReviews[0].assigner).toEqual({ id: OTHER });
    expect(JSON.stringify(view)).not.toContain("Root");
  });

  it("E4: getChainHistory redacts too", async () => {
    mockHiddenUserIds.mockResolvedValue([HIDDEN]);
    mockApprovalChain.findAll.mockResolvedValue([formChain()]);
    const [view] = (await getChainHistory("FORM_INSTANCE", "fi-1", approver)) as any[];
    expect(view.submitter).toBeNull();
    expect(view.steps[0].assignedUser).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Root");
  });

  it("E4: naming the hidden administrator as a step assignee answers like an unknown user", async () => {
    mockAssertNotHiddenUser.mockRejectedValue(Object.assign(new Error("User not found"), { statusCode: 404, code: "ERR-USER-NOT-FOUND" }));
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    await expect(reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: HIDDEN, reason: "assign the platform owner" }, orgAdmin))
      .rejects.toMatchObject({ code: "ERR-USER-NOT-FOUND", statusCode: 404 });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });
});

// ── E5 ───────────────────────────────────────────────────────────────────────
describe("E5 — chain participants can open the form's attachments, not only its PDF", () => {
  it("attachmentDocumentIds reads the { documentId } values of file fields and nothing else", () => {
    expect(
      attachmentDocumentIds({ name: "x", cv: { documentId: ATT_DOC, fileName: "cv.pdf" }, bad: { documentId: "not-a-uuid" }, n: 4, nul: null }),
    ).toEqual([ATT_DOC]);
    expect(attachmentDocumentIds(null)).toEqual([]);
  });

  it("a reassignment grants read on the main PDF AND every attachment document of the form", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_INSTANCE", itemId: "fi-1" }));
    mockFormInstance.findByPk.mockResolvedValue({ id: "fi-1", documentId: "doc-fi", templateId: "ft-1" });
    mockFormInstance.findOne.mockResolvedValue({ id: "fi-1", dataJson: { cv: { documentId: ATT_DOC, fileName: "cv.pdf" } } });
    mockDocument.findByPk.mockResolvedValue(docRow({ id: "doc-fi" }));
    mockDocument.findAll.mockResolvedValue([{ id: ATT_DOC }]);

    await reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: DELEGATE, reason: "assignee is on leave" }, orgAdmin);

    const [rows] = mockAclEntry.bulkCreate.mock.calls[0]!;
    expect(rows).toEqual([
      expect.objectContaining({ resourceId: "doc-fi", principalId: DELEGATE, permission: "document:read", effect: "ALLOW" }),
      expect.objectContaining({ resourceId: ATT_DOC, principalId: DELEGATE, permission: "document:read", effect: "ALLOW", tenantId: TENANT }),
    ]);
    // tenant-checked: the attachment ids are re-validated against the tenant before any grant
    expect(mockDocument.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { [Op.in]: [ATT_DOC] }, tenantId: TENANT } }));
  });

  it("a plain document with no form behind it gets exactly one grant", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    mockFormInstance.findOne.mockResolvedValue(null);
    await reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: DELEGATE, reason: "assignee is on leave" }, orgAdmin);
    expect(mockAclEntry.bulkCreate.mock.calls[0]![0]).toHaveLength(1);
  });

  it("a reassignment clears any delegation / escalation the step carried", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    await reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: DELEGATE, reason: "assignee is on leave" }, orgAdmin);
    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({ assignedUserId: DELEGATE, assignedRole: null, delegatedBy: null, delegatedAt: null, escalatedToUserIds: [] }),
      expect.anything(),
    );
  });
});

// ── E6 ───────────────────────────────────────────────────────────────────────
describe("E6 — template approval has a recipe, a scope-aware default, and org-level administration", () => {
  it("a tenant-wide form template is approved by an ORGANISATION-LEVEL role, not a department manager", async () => {
    mockFormTemplate.findOne.mockResolvedValue(templateRow({ status: "draft" }));
    const prefill = await getSubmitPrefill("FORM_TEMPLATE", "ft-2", approver);
    expect(prefill.steps).toEqual([expect.objectContaining({ stepType: "APPROVE", assignedRole: "SYSTEM_ADMIN" })]);
  });

  it("an org-unit-scoped template is also organisation-level (no single department to scope a role step to)", async () => {
    mockFormTemplate.findOne.mockResolvedValue(templateRow({ status: "draft", orgUnitId: "ou-1" }));
    const prefill = await getSubmitPrefill("FORM_TEMPLATE", "ft-2", approver);
    expect(prefill.steps[0]).toMatchObject({ assignedRole: "SYSTEM_ADMIN" });
  });

  it("a department-scoped template is approved by the head of THAT department (role step scoped to it)", async () => {
    mockFormTemplate.findOne.mockResolvedValue(templateRow({ status: "draft", departmentId: "dept-hr" }));
    const prefill = await getSubmitPrefill("FORM_TEMPLATE", "ft-2", approver);
    expect(prefill.steps[0]).toMatchObject({ assignedRole: "DEPT_MANAGER" });
    // role holders are resolved inside the template's department
    const holderQuery = mockSequelizeQuery.mock.calls.find((c) => String(c[0]).includes("user_roles"));
    expect(holderQuery?.[1]?.replacements).toMatchObject({ departmentId: "dept-hr" });
  });

  it("a recipe for approving form templates wins over the default, most specific scope first", async () => {
    mockFormTemplate.findOne.mockResolvedValue(templateRow({ status: "draft", departmentId: "dept-hr" }));
    mockDepartment.findOne.mockResolvedValue({ orgUnitId: "ou-1" });
    const step = [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "EXECUTIVE" }];
    mockApprovalChainTemplate.findAll.mockResolvedValue([
      { id: "r-wide", departmentId: null, orgUnitId: null, steps: [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "RECORDS_OFFICER" }], name: "wide" },
      { id: "r-ou", departmentId: null, orgUnitId: "ou-1", steps: [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "AUDITOR" }], name: "ou" },
      { id: "r-dept", departmentId: "dept-hr", orgUnitId: null, steps: step, name: "dept" },
      { id: "r-elsewhere", departmentId: "dept-fin", orgUnitId: null, steps: step, name: "elsewhere" },
    ]);
    const prefill = await getSubmitPrefill("FORM_TEMPLATE", "ft-2", approver);
    expect(prefill.templateId).toBe("r-dept");
    expect(mockApprovalChainTemplate.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, forFormTemplates: true, isActive: true } }),
    );
  });

  it("falls back to the org-unit recipe, then the tenant-wide one; a recipe scoped to another department never applies", async () => {
    mockDocument.findByPk.mockResolvedValue(docRow({ departmentId: "dept-hr", documentTypeId: "dt-1" }));
    const rows = [
      { id: "r-wide", departmentId: null, orgUnitId: null, steps: [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "A" }], name: "w" },
      { id: "r-ou", departmentId: null, orgUnitId: "ou-1", steps: [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "B" }], name: "o" },
      { id: "r-elsewhere", departmentId: "dept-fin", orgUnitId: null, steps: [{ stepOrder: 1, stepType: "APPROVE", assignedRole: "C" }], name: "e" },
    ];
    mockApprovalChainTemplate.findAll.mockResolvedValue(rows);
    expect((await getSubmitPrefill("DOCUMENT", "doc-1", approver)).templateId).toBe("r-ou");
    mockApprovalChainTemplate.findAll.mockResolvedValue([rows[0], rows[2]]);
    expect((await getSubmitPrefill("DOCUMENT", "doc-1", approver)).templateId).toBe("r-wide");
    mockApprovalChainTemplate.findAll.mockResolvedValue([rows[2]]);
    expect((await getSubmitPrefill("DOCUMENT", "doc-1", approver)).templateId).toBeNull();
  });

  it("only an organisation-level role can reassign or cancel the approval of an org-wide template", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_TEMPLATE", itemId: "ft-2" }));
    mockFormTemplate.findOne.mockResolvedValue(templateRow());
    await expect(reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: DELEGATE, reason: "take it over please" }, approvalAdmin))
      .rejects.toMatchObject({ code: "ERR-FORM-TEMPLATE-ORG-SCOPE" });
    await expect(cancelChain(CHAIN_ID, "cancelling for a documented reason", approvalAdmin))
      .rejects.toMatchObject({ code: "ERR-FORM-TEMPLATE-ORG-SCOPE" });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
    // the organisation-level admin still can
    await expect(reassignStep(CHAIN_ID, STEP_ID, { assignedUserId: DELEGATE, reason: "take it over please" }, orgAdmin)).resolves.toBeDefined();
  });

  describe("upsertChainTemplate — scope", () => {
    const step = { stepType: "APPROVE", assignedRole: "DEPT_MANAGER" };
    const DEPT = "00000000-0000-4000-8000-0000000000d0";
    const UNIT = "00000000-0000-4000-8000-0000000000e0";
    const DT = "00000000-0000-4000-8000-0000000000c0";
    beforeEach(() => {
      mockDocumentType.findOne.mockResolvedValue({ id: DT });
      mockDepartment.findOne.mockResolvedValue({ id: DEPT });
      mockOrgUnit.findOne.mockResolvedValue({ id: UNIT });
      mockApprovalChainTemplate.create.mockResolvedValue({ id: "new" });
    });

    it("rejects a recipe scoped to both a department and an org unit", async () => {
      await expect(upsertChainTemplate({ documentTypeId: DT, departmentId: DEPT, orgUnitId: UNIT, name: "x", steps: [step] }, orgAdmin))
        .rejects.toMatchObject({ code: "ERR-TEMPLATE-SCOPE" });
    });

    it("validates the department and the org unit against the tenant", async () => {
      mockDepartment.findOne.mockResolvedValue(null);
      await expect(upsertChainTemplate({ documentTypeId: DT, departmentId: DEPT, name: "x", steps: [step] }, orgAdmin))
        .rejects.toMatchObject({ code: "ERR-TEMPLATE-SCOPE" });
      mockOrgUnit.findOne.mockResolvedValue(null);
      await expect(upsertChainTemplate({ documentTypeId: DT, orgUnitId: UNIT, name: "x", steps: [step] }, orgAdmin))
        .rejects.toMatchObject({ code: "ERR-TEMPLATE-SCOPE" });
      expect(mockDepartment.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DEPT, tenantId: TENANT } }));
    });

    it("exactly one target: a document type, a form template, or the approval of form templates", async () => {
      await expect(upsertChainTemplate({ documentTypeId: DT, forFormTemplates: true, name: "x", steps: [step] }, orgAdmin))
        .rejects.toMatchObject({ code: "ERR-TEMPLATE-TARGET" });
      await expect(upsertChainTemplate({ name: "x", steps: [step] }, orgAdmin)).rejects.toMatchObject({ code: "ERR-TEMPLATE-TARGET" });
    });

    it("deactivates only the recipe at the SAME scope and stores the scope on the new one", async () => {
      await upsertChainTemplate({ forFormTemplates: true, orgUnitId: UNIT, name: "template approval", steps: [step] }, orgAdmin);
      expect(mockApprovalChainTemplate.update).toHaveBeenCalledWith(
        { isActive: false },
        expect.objectContaining({ where: { tenantId: TENANT, forFormTemplates: true, departmentId: null, orgUnitId: UNIT, isActive: true } }),
      );
      expect(mockApprovalChainTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({ forFormTemplates: true, orgUnitId: UNIT, departmentId: null, documentTypeId: null, formTemplateId: null }),
        expect.anything(),
      );
    });

    it("a workflow manager without organisation-level authority is limited to a department they manage", async () => {
      const manager = { ...approvalAdmin, permissions: [PERMISSIONS.WORKFLOW_MANAGE, PERMISSIONS.APPROVAL_DECIDE] };
      await expect(upsertChainTemplate({ documentTypeId: DT, name: "x", steps: [step] }, manager)).rejects.toMatchObject({ code: "ERR-TEMPLATE-SCOPE", statusCode: 403 });
      await expect(upsertChainTemplate({ documentTypeId: DT, orgUnitId: UNIT, name: "x", steps: [step] }, manager)).rejects.toMatchObject({ code: "ERR-TEMPLATE-SCOPE" });
      mockSequelizeQuery.mockResolvedValue([{ id: "some-other-dept" }]); // departments this manager heads
      await expect(upsertChainTemplate({ documentTypeId: DT, departmentId: DEPT, name: "x", steps: [step] }, manager)).rejects.toMatchObject({ statusCode: 403 });
      mockSequelizeQuery.mockResolvedValue([{ id: DEPT }]);
      await expect(upsertChainTemplate({ documentTypeId: DT, departmentId: DEPT, name: "x", steps: [step] }, manager)).resolves.toBeDefined();
    });
  });
});

// ── E7 (engine half): the filer takes a submission back ─────────────────────
describe("withdrawOwnSubmission — the filer recalls an item from review", () => {
  beforeEach(() => {
    mockFormInstance.findByPk.mockResolvedValue({ id: "fi-1", documentId: "doc-fi", templateId: "ft-1" });
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: APPROVER }));
  });
  const filer = { userId: FILER, tenantId: TENANT, role: "EMPLOYEE", roles: ["EMPLOYEE"], permissions: [PERMISSIONS.DOCUMENT_READ] };

  it("cancels the live chain and its open steps, returns the document to DRAFT, audits it and tells the approver", async () => {
    const doc = docRow({ id: "doc-fi", ownerId: FILER });
    mockDocument.findByPk.mockResolvedValue(doc);
    const live = chainRow({ itemType: "FORM_INSTANCE", itemId: "fi-1", submittedBy: FILER });
    mockApprovalChain.findOne.mockResolvedValue(live);

    await withdrawOwnSubmission("FORM_INSTANCE", "fi-1", "  wrong dates  ", filer);

    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      { status: "CANCELLED" },
      expect.objectContaining({ where: expect.objectContaining({ chainId: CHAIN_ID }) }),
    );
    expect(live.update).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELLED" }), expect.anything());
    expect(doc.update).toHaveBeenCalledWith({ status: "DRAFT", approvalStatus: "PENDING" }, expect.anything());
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "FORM_INSTANCE_WITHDRAWN", documentId: "doc-fi",
        actionDetails: expect.objectContaining({ reason: "wrong dates", formInstanceId: "fi-1" }),
      }),
    );
    expect(mockFanOut).toHaveBeenCalledWith(expect.objectContaining({ type: "APPROVAL_WITHDRAWN", recipientIds: [APPROVER] }));
  });

  it("refuses anyone but the filer, even an approval admin (they have cancelChain)", async () => {
    mockDocument.findByPk.mockResolvedValue(docRow({ id: "doc-fi", ownerId: FILER }));
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_INSTANCE", itemId: "fi-1", submittedBy: FILER }));
    await expect(withdrawOwnSubmission("FORM_INSTANCE", "fi-1", undefined, orgAdmin)).rejects.toMatchObject({ code: "ERR-NOT-ITEM-OWNER" });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("409s when nothing is in review", async () => {
    mockDocument.findByPk.mockResolvedValue(docRow({ id: "doc-fi", ownerId: FILER }));
    mockApprovalChain.findOne.mockResolvedValue(null);
    await expect(withdrawOwnSubmission("FORM_INSTANCE", "fi-1", undefined, filer)).rejects.toMatchObject({ code: "ERR-CHAIN-STATE-INVALID" });
  });
});

// ── #23: delegation ──────────────────────────────────────────────────────────
describe("delegateStep — the assignee hands a step to another eligible user", () => {
  const input = { toUserId: DELEGATE, reason: "on leave until Monday" };
  beforeEach(() => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    mockApprovalStep.findOne.mockResolvedValue(stepRow());
    mockSequelizeQuery.mockResolvedValue([{ name: "EMPLOYEE" }]);
  });

  it("re-assigns to the delegate by name, records who/why, grants read, audits and notifies", async () => {
    await delegateStep(CHAIN_ID, STEP_ID, input, approver);

    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedUserId: DELEGATE, assignedRole: null, delegatedBy: APPROVER, delegatedFromRole: null,
        delegationReason: "on leave until Monday", escalatedToUserIds: [],
      }),
      expect.objectContaining({
        // guarded: still PENDING, not already delegated, still held by the delegator
        where: expect.objectContaining({ id: STEP_ID, status: "PENDING", assignedUserId: APPROVER }),
      }),
    );
    expect(mockAclEntry.bulkCreate.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ resourceId: "doc-1", principalType: "user", principalId: DELEGATE, permission: "document:read" }),
    ]);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "APPROVAL_STEP_DELEGATED", userId: APPROVER, documentId: "doc-1",
        actionDetails: expect.objectContaining({ fromUserId: APPROVER, toUserId: DELEGATE, reason: "on leave until Monday", stepId: STEP_ID }),
      }),
    );
    expect(mockFanOut).toHaveBeenCalledWith(expect.objectContaining({ type: "APPROVAL_STEP_DELEGATED", recipientIds: [DELEGATE] }));
  });

  it("a role holder delegating a ROLE step records the role it came from (the delegate must hold that role)", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: null, assignedRole: "DEPT_MANAGER" }));
    mockSequelizeQuery.mockResolvedValue([{ name: "DEPT_MANAGER" }]);
    await delegateStep(CHAIN_ID, STEP_ID, input, { ...approver, roles: ["DEPT_MANAGER"] });
    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({ assignedUserId: DELEGATE, assignedRole: null, delegatedFromRole: "DEPT_MANAGER" }),
      expect.objectContaining({ where: expect.objectContaining({ assignedRole: "DEPT_MANAGER" }) }),
    );
  });

  it("NO ESCALATION OF RIGHTS: a role step cannot be delegated to someone who does not hold the role", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: null, assignedRole: "DEPT_MANAGER" }));
    mockSequelizeQuery.mockResolvedValue([{ name: "EMPLOYEE" }]); // holds approval:decide but not the role
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, { ...approver, roles: ["DEPT_MANAGER"] }))
      .rejects.toMatchObject({ code: "ERR-DELEGATE-OUT-OF-SCOPE" });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("NO ESCALATION OF RIGHTS: the delegate must hold approval:decide", async () => {
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.DOCUMENT_READ]);
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-ASSIGNEE-INVALID" });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("NO ESCALATION OF RIGHTS: the delegate must belong to the item's department (so no new document access is created)", async () => {
    mockDocument.findByPk.mockResolvedValue(docRow({ departmentId: "dept-hr" }));
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-finance"]);
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-DELEGATE-OUT-OF-SCOPE" });
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it("NO ESCALATION OF RIGHTS: an organisation-wide form template can only be delegated to an organisation-level approver", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ itemType: "FORM_TEMPLATE", itemId: "ft-2" }));
    mockFormTemplate.findOne.mockResolvedValue(templateRow());
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-DELEGATE-OUT-OF-SCOPE" });
    mockGetResolvedRolePermissions.mockResolvedValue([PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.DOCUMENT_READ_ALL]);
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).resolves.toBeDefined();
  });

  it("never the hidden platform administrator (answers like an unknown user)", async () => {
    mockAssertNotHiddenUser.mockRejectedValue(Object.assign(new Error("User not found"), { statusCode: 404, code: "ERR-USER-NOT-FOUND" }));
    await expect(delegateStep(CHAIN_ID, STEP_ID, { toUserId: HIDDEN }, approver)).rejects.toMatchObject({ code: "ERR-USER-NOT-FOUND", statusCode: 404 });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("never the delegator, and never the item's author or the chain's submitter", async () => {
    await expect(delegateStep(CHAIN_ID, STEP_ID, { toUserId: APPROVER }, approver)).rejects.toMatchObject({ code: "ERR-DELEGATE-SELF" });
    await expect(delegateStep(CHAIN_ID, STEP_ID, { toUserId: OTHER }, approver)).rejects.toMatchObject({ code: "ERR-STEP-SELF-APPROVAL" });
  });

  it("only the assignee can delegate (not a stranger, not an approval admin)", async () => {
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, orgAdmin)).rejects.toMatchObject({ code: "ERR-STEP-NOT-ASSIGNED" });
  });

  it("a mandatory (locked) recipe step cannot be delegated", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ locked: true }));
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-STEP-LOCKED" });
  });

  it("a delegated step cannot be delegated again", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ delegatedAt: new Date() }));
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-STEP-ALREADY-DELEGATED" });
  });

  it("refuses a decided step and a chain that is not in review", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ status: "APPROVED" }));
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-STEP-NOT-PENDING" });
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ status: "APPROVED" }));
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-CHAIN-STATE-INVALID" });
  });

  it("a concurrent change (the guarded update matched nothing) is a 409, with no grant", async () => {
    mockApprovalStep.update.mockResolvedValue([0]);
    await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-STEP-NOT-PENDING" });
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it("is switched off by APPROVAL_DELEGATION_ENABLED", async () => {
    const cfg = config as unknown as { APPROVAL_DELEGATION_ENABLED: boolean };
    const before = cfg.APPROVAL_DELEGATION_ENABLED;
    cfg.APPROVAL_DELEGATION_ENABLED = false;
    try {
      await expect(delegateStep(CHAIN_ID, STEP_ID, input, approver)).rejects.toMatchObject({ code: "ERR-DELEGATION-DISABLED" });
    } finally {
      cfg.APPROVAL_DELEGATION_ENABLED = before;
    }
  });
});

// ── #23: an escalatee decides through the same guarded path ─────────────────
describe("decideStep — an escalatee", () => {
  const escalatee = { ...approver, userId: "00000000-0000-4000-8000-0000000000e5", roles: ["DEPT_MANAGER"] };
  beforeEach(() => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow());
    mockDocument.findByPk.mockResolvedValue(docRow({ departmentId: "dept-hr" }));
  });

  it("is refused when the step is neither theirs nor escalated to them", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: DELEGATE, escalatedToUserIds: [] }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES" }, escalatee)).rejects.toMatchObject({ code: "ERR-STEP-NOT-ASSIGNED" });
  });

  it("may decide a step escalated to them, if they are inside the item's department", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: DELEGATE, escalatedToUserIds: [escalatee.userId] }));
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-hr"]);
    mockUserDepartment.findAll.mockResolvedValue([{ departmentId: "dept-hr" }]); // getChain's own department check
    await decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES", comment: "returned by the department head" }, escalatee);
    expect(mockApprovalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CHANGES_REQUESTED", decidedBy: escalatee.userId }),
      expect.anything(),
    );
  });

  it("is still held to the item's department", async () => {
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: DELEGATE, escalatedToUserIds: [escalatee.userId] }));
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-finance"]);
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "REQUEST_CHANGES" }, escalatee))
      .rejects.toMatchObject({ code: "ERR-STEP-DEPT-SCOPE" });
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("still cannot approve what it authored (self-approval stays impossible)", async () => {
    mockApprovalChain.findOne.mockResolvedValue(chainRow({ submittedBy: escalatee.userId }));
    mockApprovalStep.findOne.mockResolvedValue(stepRow({ assignedUserId: DELEGATE, escalatedToUserIds: [escalatee.userId] }));
    await expect(decideStep(CHAIN_ID, STEP_ID, { decision: "APPROVE" }, escalatee)).rejects.toMatchObject({ code: "ERR-SELF-APPROVAL" });
  });
});
