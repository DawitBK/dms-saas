// Automatic escalation of overdue approval steps (audit finding #23; escalation.service.ts). Fully mocked.
//
// An overdue step (SLA already flagged by the sweep) escalates ONCE, after the grace period, to the item's department
// head(s), else the tenant's approval admins: they are ADDED as co-deciders, never substituted for the assignee, and
// never include the assignee, the item's author, the submitter or the hidden platform administrator.

const mockApprovalChain = { findOne: jest.fn() };
const mockApprovalStep = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() };
const mockDocument = { findByPk: jest.fn(), findAll: jest.fn() };
const mockFormTemplate = { findOne: jest.fn() };
const mockFormInstance = { findByPk: jest.fn(), findOne: jest.fn() };
const mockDepartment = { findOne: jest.fn() };
const mockUser = { findAll: jest.fn() };
const mockAclEntry = { bulkCreate: jest.fn() };
const mockQuery = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: mockAclEntry,
  ApprovalChain: mockApprovalChain,
  ApprovalChainTemplate: {},
  ApprovalStep: mockApprovalStep,
  AuditStageReview: {},
  Department: mockDepartment,
  Document: mockDocument,
  DocumentType: {},
  FormInstance: mockFormInstance,
  FormTemplate: mockFormTemplate,
  OrgUnit: {},
  User: mockUser,
  UserDepartment: {},
  UserTenant: {},
  Role: {},
  UserRole: {},
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a) }));
const mockFanOut = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: (...a: unknown[]) => mockFanOut(...a) }));
const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({ runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx) }));
jest.mock("../src/shared/documentGuards.js", () => ({ requireDocumentAccess: jest.fn(), requireLegalHoldClear: jest.fn() }));
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: jest.fn() }));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({ validateTransition: jest.fn() }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn() }));
jest.mock("../src/infrastructure/cache/aclCache.js", () => ({ invalidateResourceACL: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn(),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));
const mockPerms = jest.fn();
jest.mock("../src/modules/roles/roles.service.js", () => ({ getResolvedRolePermissions: (...a: unknown[]) => mockPerms(...a) }));
jest.mock("../src/modules/forms/formTemplateScope.js", () => ({ hasOrgWideTemplateAuthority: () => false }));
jest.mock("../src/shared/orgScope.js", () => ({ assertCanManageDepartment: jest.fn() }));
// the REAL notPlatformAdminSql, so the hidden-administrator exclusion in the candidate SQL is asserted for real
jest.mock("../src/shared/platformAdmin.js", () => ({
  ...jest.requireActual("../src/shared/platformAdmin.js"),
  hiddenUserIds: jest.fn().mockResolvedValue([]),
  assertNotHiddenUser: jest.fn(),
}));

import { config } from "../src/config/env.js";
import { PERMISSIONS } from "../src/config/permissions.js";
import { APPROVAL_ESCALATION, escalateOverdueSteps, escalateStep, resolveEscalationTargets } from "../src/modules/approvals/escalation.service.js";

const T = "examplecorp";
const SUBMITTER = "00000000-0000-4000-8000-0000000000a5";
const OWNER = "00000000-0000-4000-8000-0000000000a6";
const ASSIGNEE = "00000000-0000-4000-8000-0000000000a7";
const HEAD = "00000000-0000-4000-8000-0000000000a8";
const ADMIN = "00000000-0000-4000-8000-0000000000a9";
const cfg = config as unknown as Record<string, unknown>;

const PERMS: Record<string, string[]> = {
  DEPT_MANAGER: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.DEPT_MANAGE, PERMISSIONS.APPROVAL_ADMIN],
  EMPLOYEE: [PERMISSIONS.APPROVAL_DECIDE],
  SYSTEM_ADMIN: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.DOCUMENT_READ_ALL],
  AUDITOR: [PERMISSIONS.DOCUMENT_READ],
};

/** The holders query is told which roles / department it is asked about; this answers from a small fixture. */
function installDirectory(opts: { headsInDept?: Record<string, string[]>; admins?: string[]; adminsInDept?: Record<string, string[]> } = {}) {
  mockQuery.mockImplementation(async (sql: string, o?: { replacements?: Record<string, unknown> }) => {
    if (sql.includes("SELECT name FROM roles")) return Object.keys(PERMS).map((name) => ({ name }));
    if (sql.includes("FROM users u")) {
      const r = o?.replacements ?? {};
      const roles = r.roleNames as string[];
      const dept = r.departmentId as string | null;
      const exclude = r.exclude as string[];
      const pick = (ids: string[] | undefined) => (ids ?? []).filter((id) => !exclude.includes(id)).map((id) => ({ id }));
      if (roles.includes("DEPT_MANAGER") && !roles.includes("SYSTEM_ADMIN")) return pick(dept ? opts.headsInDept?.[dept] : []);
      if (roles.includes("SYSTEM_ADMIN") && roles.includes("DEPT_MANAGER")) return dept ? pick(opts.adminsInDept?.[dept]) : pick(opts.admins);
      if (roles.includes("SYSTEM_ADMIN")) return dept ? [] : pick(opts.admins);
      return [];
    }
    return [];
  });
}

function overdueStep(over: Record<string, unknown> = {}) {
  return {
    id: "step-1", tenantId: T, chainId: "chain-1", status: "PENDING", stepType: "APPROVE", assignedUserId: ASSIGNEE,
    assignedRole: null, slaBreachedAt: new Date("2026-10-01T00:00:00Z"), escalatedAt: null, ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockFanOut.mockResolvedValue(undefined);
  mockPerms.mockImplementation(async (role: string) => PERMS[role] ?? []);
  cfg.APPROVAL_ESCALATION_ENABLED = true;
  cfg.APPROVAL_ESCALATION_GRACE_HOURS = 24;
  cfg.APPROVAL_ESCALATION_MAX_TARGETS = 3;
  mockApprovalStep.findOne.mockResolvedValue(overdueStep());
  mockApprovalStep.update.mockResolvedValue([1]);
  mockApprovalChain.findOne.mockResolvedValue({ id: "chain-1", status: "IN_REVIEW", itemType: "DOCUMENT", itemId: "doc-1", submittedBy: SUBMITTER });
  mockDocument.findByPk.mockResolvedValue({ id: "doc-1", tenantId: T, title: "Budget", departmentId: "dept-1", ownerId: OWNER, deletedAt: null });
  mockDocument.findAll.mockResolvedValue([]);
  mockDepartment.findOne.mockResolvedValue(null); // not UNCAT, no parent
  mockFormInstance.findOne.mockResolvedValue(null);
  mockUser.findAll.mockResolvedValue([{ id: HEAD, firstName: "Hana", lastName: "Head" }]);
  installDirectory({ headsInDept: { "dept-1": [HEAD] }, admins: [ADMIN] });
});

describe("the escalation policy is one config constant", () => {
  it("reads APPROVAL_ESCALATION_* from config, every time", () => {
    cfg.APPROVAL_ESCALATION_GRACE_HOURS = 6;
    cfg.APPROVAL_ESCALATION_MAX_TARGETS = 2;
    cfg.APPROVAL_ESCALATION_ENABLED = false;
    expect(APPROVAL_ESCALATION).toMatchObject({ enabled: false, graceHours: 6, maxTargets: 2 });
  });

  it("does nothing at all while disabled", async () => {
    cfg.APPROVAL_ESCALATION_ENABLED = false;
    expect(await escalateStep("step-1", T)).toEqual({ escalated: false, targets: [] });
    expect(await escalateOverdueSteps(T)).toBe(0);
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
    expect(mockApprovalStep.findAll).not.toHaveBeenCalled();
  });
});

describe("escalateStep", () => {
  it("adds the department head as a co-decider: step stays PENDING, assignee untouched, access granted, audited, notified", async () => {
    const result = await escalateStep("step-1", T, new Date("2026-10-03T00:00:00Z"));

    expect(result).toEqual({ escalated: true, targets: [HEAD] });
    // ONLY the escalation columns change: nobody is removed or re-assigned, the status is not touched.
    const [patch, opts] = mockApprovalStep.update.mock.calls[0]!;
    expect(Object.keys(patch).sort()).toEqual(["escalatedAt", "escalatedToUserIds"]);
    expect(patch.escalatedToUserIds).toEqual([HEAD]);
    expect(opts.where).toMatchObject({ id: "step-1", status: "PENDING" }); // guarded claim: one sweep wins
    expect(mockAclEntry.bulkCreate.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ resourceId: "doc-1", principalType: "user", principalId: HEAD, permission: "document:read" }),
    ]);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "APPROVAL_STEP_ESCALATED", documentId: "doc-1",
        actionDetails: expect.objectContaining({ stepId: "step-1", escalatedTo: [HEAD], assignedUserId: ASSIGNEE }),
      }),
    );
    const note = mockFanOut.mock.calls[0]![0];
    expect(note).toMatchObject({ type: "APPROVAL_STEP_ESCALATED", severity: "WARNING" });
    expect(note.recipientIds.sort()).toEqual([ASSIGNEE, HEAD, SUBMITTER].sort());
    expect(note.payload).toMatchObject({ documentId: "doc-1", escalatedToNames: "Hana Head" });
  });

  it("NEVER escalates to the assignee, the item's author or the submitter, nor to the hidden platform administrator", async () => {
    await escalateStep("step-1", T);
    const holderCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("FROM users u"))!;
    expect(holderCall[1].replacements.exclude).toEqual(expect.arrayContaining([SUBMITTER, OWNER, ASSIGNEE]));
    expect(String(holderCall[0])).toContain("PLATFORM_ADMIN"); // notPlatformAdminSql
  });

  it("walks up to the parent department when the item's own department has no head", async () => {
    mockDepartment.findOne.mockImplementation(async (q: { where?: { code?: string } }) => (q?.where?.code === "UNCAT" ? null : { id: "dept-1", parentId: "dept-parent" }));
    installDirectory({ headsInDept: { "dept-parent": [HEAD] } });
    expect((await escalateStep("step-1", T)).targets).toEqual([HEAD]);
  });

  it("falls back to approval admins in the department or reading across departments when there is no head", async () => {
    installDirectory({ headsInDept: {}, adminsInDept: { "dept-1": [] }, admins: [ADMIN] });
    // approval admins who can actually decide it: in the department, or with document:read_all
    const result = await escalateStep("step-1", T);
    expect(result.targets).toEqual([ADMIN]);
  });

  it("with nobody eligible it is still marked escalated (so the sweep does not retry forever), audited, and nobody is granted anything", async () => {
    installDirectory({ headsInDept: {}, admins: [] });
    const result = await escalateStep("step-1", T);
    expect(result).toEqual({ escalated: true, targets: [] });
    expect(mockApprovalStep.update.mock.calls[0]![0].escalatedToUserIds).toEqual([]);
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
    expect(mockFanOut).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionDetails: expect.objectContaining({ escalatedTo: [] }) }));
  });

  it("escalates ONCE: a sweep that loses the guarded claim does nothing", async () => {
    mockApprovalStep.update.mockResolvedValue([0]);
    expect(await escalateStep("step-1", T)).toEqual({ escalated: false, targets: [] });
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it("skips a step that is already escalated, decided, or whose chain is no longer in review", async () => {
    mockApprovalStep.findOne.mockResolvedValue(null); // the lookup requires PENDING and escalated_at IS NULL
    expect((await escalateStep("step-1", T)).escalated).toBe(false);
    mockApprovalStep.findOne.mockResolvedValue(overdueStep());
    mockApprovalChain.findOne.mockResolvedValue(null);
    expect((await escalateStep("step-1", T)).escalated).toBe(false);
    expect(mockApprovalStep.update).not.toHaveBeenCalled();
  });

  it("skips an item that is gone or trashed", async () => {
    mockDocument.findByPk.mockResolvedValue({ id: "doc-1", tenantId: T, deletedAt: new Date() });
    expect((await escalateStep("step-1", T)).escalated).toBe(false);
  });

  it("a form instance escalation grants the head the form's attachments too (E5) and audits against the form's document", async () => {
    mockApprovalChain.findOne.mockResolvedValue({ id: "chain-1", status: "IN_REVIEW", itemType: "FORM_INSTANCE", itemId: "fi-1", submittedBy: SUBMITTER });
    mockFormInstance.findByPk.mockResolvedValue({ id: "fi-1", documentId: "doc-fi" });
    mockFormInstance.findOne.mockResolvedValue({ dataJson: { cv: { documentId: "00000000-0000-4000-8000-00000000a7a7", fileName: "cv.pdf" } } });
    mockDocument.findByPk.mockResolvedValue({ id: "doc-fi", tenantId: T, title: "Leave", departmentId: "dept-1", ownerId: OWNER, deletedAt: null });
    mockDocument.findAll.mockResolvedValue([{ id: "00000000-0000-4000-8000-00000000a7a7" }]);
    await escalateStep("step-1", T);
    expect(mockAclEntry.bulkCreate.mock.calls[0]![0].map((r: { resourceId: string }) => r.resourceId)).toEqual([
      "doc-fi", "00000000-0000-4000-8000-00000000a7a7",
    ]);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-fi" }));
  });

  it("an organisation-wide form template (no department) escalates to approval admins", async () => {
    mockApprovalChain.findOne.mockResolvedValue({ id: "chain-1", status: "IN_REVIEW", itemType: "FORM_TEMPLATE", itemId: "ft-1", submittedBy: SUBMITTER });
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", name: "Leave", departmentId: null, createdBy: OWNER });
    const result = await escalateStep("step-1", T);
    expect(result.targets).toEqual([ADMIN]);
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled(); // a template has no document to open
  });
});

describe("resolveEscalationTargets", () => {
  it("caps the number of people at APPROVAL_ESCALATION_MAX_TARGETS", async () => {
    await resolveEscalationTargets({ tenantId: T, departmentId: "dept-1", exclude: [], max: 2 });
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes("FROM users u"))!;
    expect(call[1].replacements.max).toBe(2);
    expect(String(call[0])).toContain("LIMIT :max");
  });

  it("only considers roles that can decide AND head a department (first choice), then decide AND administer approvals", async () => {
    await resolveEscalationTargets({ tenantId: T, departmentId: "dept-1", exclude: [] });
    const roleCalls = mockQuery.mock.calls.filter((c) => String(c[0]).includes("FROM users u")).map((c) => c[1].replacements.roleNames as string[]);
    expect(roleCalls[0]).toEqual(["DEPT_MANAGER"]); // EMPLOYEE decides but heads nothing; AUDITOR cannot decide
  });
});

describe("escalateOverdueSteps — the sweep", () => {
  it("only picks breached, still-pending, un-escalated steps older than the grace period", async () => {
    const now = new Date("2026-10-04T12:00:00Z");
    mockApprovalStep.findAll.mockResolvedValue([{ id: "step-1" }]);
    expect(await escalateOverdueSteps(T, now)).toBe(1);
    const where = mockApprovalStep.findAll.mock.calls[0]![0].where;
    expect(where.tenantId).toBe(T);
    expect(where.status).toBe("PENDING");
    expect(where.escalatedAt).toBeDefined();
    const cutoff = (where.slaBreachedAt as Record<symbol, Date>)[Object.getOwnPropertySymbols(where.slaBreachedAt)[0]!]!;
    expect(cutoff.toISOString()).toBe("2026-10-03T12:00:00.000Z"); // now - 24 h grace
  });

  it("grace 0 escalates on the same sweep that flagged the breach", async () => {
    cfg.APPROVAL_ESCALATION_GRACE_HOURS = 0;
    const now = new Date("2026-10-04T12:00:00Z");
    mockApprovalStep.findAll.mockResolvedValue([]);
    await escalateOverdueSteps(T, now);
    const sla = mockApprovalStep.findAll.mock.calls[0]![0].where.slaBreachedAt as Record<symbol, Date>;
    const cutoff = sla[Object.getOwnPropertySymbols(sla)[0]!]!;
    expect(cutoff.toISOString()).toBe(now.toISOString());
  });

  it("one failing step does not stop the others", async () => {
    mockApprovalStep.findAll.mockResolvedValue([{ id: "bad" }, { id: "step-1" }]);
    mockApprovalStep.findOne.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(overdueStep());
    expect(await escalateOverdueSteps(T)).toBe(1);
  });
});
