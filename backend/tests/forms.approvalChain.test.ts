export {};

// Forms approver selection (audit 2026-09-03, item 3).
//
// The bug: `createFormInstance` called
// `submitForApproval('FORM_INSTANCE', id, {}, user)` — an EMPTY step list — so
// the engine fell through to its hardcoded single [{ APPROVE, DEPT_MANAGER }]
// default for every form ever filed, regardless of who the submitter wanted.
// Every form chain in the live database was exactly that shape. The engine has
// always accepted author-chosen users and roles (documents and letters both use
// it); only this path never passed any.
//
// Two behaviours are asserted here, and the second matters as much as the first:
//   * a chosen chain reaches the engine intact, and
//   * choosing NOTHING still sends `{}` — the template recipe / engine default —
//     so every existing caller and every already-filed form is unaffected.
//
// getFormInstanceApprovalPrefill is covered too, because it is what makes the
// choice possible at all: the engine's own getSubmitPrefill needs an item id,
// and a form instance has none until it is filed, so the recipe has to be
// resolved from the FORM TEMPLATE instead. It must resolve from the same source
// submitForApproval will use (findActiveTemplate: the active
// ApprovalChainTemplate for this formTemplateId, else the engine default) or the
// picker would show one chain and the engine build another.

const mockFormTemplate = { findAndCountAll: jest.fn(), findOne: jest.fn(), create: jest.fn() };
const mockApprovalChainTemplate = { findOne: jest.fn() };
const mockDepartment = { findOne: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  FormTemplate: mockFormTemplate,
  FormInstance: {},
  Document: {},
  DocumentType: { findOne: jest.fn().mockResolvedValue({ id: "doctype-form" }) },
  DocumentVersion: {},
  DocumentDek: {},
  Department: mockDepartment,
  UserDepartment: mockUserDepartment,
  OutboxEvent: {},
  SignatureRequest: {},
  SignatureRecipient: {},
  User: {},
  ApprovalChainTemplate: mockApprovalChainTemplate,
}));

const mockResolveRoleHolders = jest.fn();
const mockSubmitForApproval = jest.fn();
// The recipe resolution itself (form template recipe, then FORM doc type; department > org unit > tenant-wide)
// lives in the engine and is covered by approvals.engineFollowUps.test.ts; here it is the seam.
const mockFindRecipe = jest.fn();
jest.mock("../src/modules/approvals/approvals.service.js", () => ({
  resolveRoleHolders: mockResolveRoleHolders,
  submitForApproval: mockSubmitForApproval,
  findFormInstanceRecipe: (...a: unknown[]) => mockFindRecipe(...a),
}));
// Template scope is covered by forms.templateScope.test.ts; these tests are about the approval chain.
jest.mock("../src/modules/forms/formTemplateScope.js", () => ({
  ...jest.requireActual("../src/modules/forms/formTemplateScope.js"),
  canViewFormTemplate: jest.fn().mockResolvedValue(true),
  templateVisibilityWhere: jest.fn().mockResolvedValue(null),
  assertTemplateUsableForDepartment: jest.fn(),
}));

jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: jest.fn().mockResolvedValue([]) }));
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: jest.fn() }));
jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({ assertStatusPermission: jest.fn() }));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: jest.fn() }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: jest.fn() }));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn() }));
jest.mock("../src/modules/documents/documents.service.js", () => ({
  filterDocsByDetailAcl: jest.fn((_user: unknown, docs: unknown[]) => docs),
  ensureCanCreate: jest.fn(),
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("../src/config/env.js", () => ({ config: {} }));

let getFormInstanceApprovalPrefill: typeof import("../src/modules/forms/forms.service.js").getFormInstanceApprovalPrefill;
let createFormInstance: typeof import("../src/modules/forms/forms.service.js").createFormInstance;

beforeAll(async () => {
  ({ getFormInstanceApprovalPrefill, createFormInstance } = await import("../src/modules/forms/forms.service.js"));
});

const DEPT = { id: 'dept-audit', name: 'Audit', code: 'AUDIT' };

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRoleHolders.mockResolvedValue(new Map());
  // The prefill resolves the department the instance will actually be filed
  // under, via the SAME helper createFormInstance uses — that shared rule is
  // what stopped the picker reporting a role as staffed in a department where
  // the engine would refuse it.
  mockDepartment.findOne.mockResolvedValue(DEPT);
  // The caller is a member of DEPT, which is where a form with no chosen
  // department is filed (resolveFormDepartment: the caller's OWN first department).
  mockUserDepartment.findAll.mockResolvedValue([{ departmentId: DEPT.id }]);
});

const user = { userId: "u-1", role: "SYSTEM_ADMIN", tenantId: "t1", roles: [], permissions: [] } as never;

const chainTemplateRow = (steps: unknown[]) => ({ id: "act-1", name: "Leave approval", steps });

describe("getFormInstanceApprovalPrefill", () => {
  it("returns the template's active chain recipe, keyed on formTemplateId", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "chain" });
    mockFindRecipe.mockResolvedValue(
      chainTemplateRow([
        { stepOrder: 1, stepType: "REVIEW", assignedRole: "APPROVER", locked: true },
        { stepOrder: 2, stepType: "APPROVE", assignedRole: "DEPT_MANAGER" },
      ]),
    );

    const result = await getFormInstanceApprovalPrefill("ft-1", user);

    // The lookup must match findActiveTemplate's own, or the picker and the
    // engine would disagree about which recipe applies.
    expect(mockFindRecipe).toHaveBeenCalledWith("t1", DEPT.id, "ft-1", "doctype-form");
    expect(result.instanceApproval).toBe("chain");
    expect(result.chainTemplateId).toBe("act-1");
    expect(result.chainTemplateName).toBe("Leave approval");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.locked).toBe(true);
  });

  it("falls back to the engine's own default when no chain template is configured", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "chain" });
    mockFindRecipe.mockResolvedValue(null);

    const result = await getFormInstanceApprovalPrefill("ft-1", user);

    // Same default submitForApproval would apply — a single APPROVE to
    // DEPT_MANAGER — so what the author sees is what they would have got.
    expect(result.chainTemplateId).toBeNull();
    expect(result.steps).toEqual([
      expect.objectContaining({ stepType: "APPROVE", assignedRole: "DEPT_MANAGER", locked: false }),
    ]);
  });

  it("returns no chain at all for a template that does not use chain approval", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "none" });

    const result = await getFormInstanceApprovalPrefill("ft-1", user);

    // The department is still resolved and returned: the dialog names it even
    // when there is no chain to show, and resolving it here keeps the one
    // "where will this be filed" rule in a single place.
    expect(result).toEqual({
      instanceApproval: "none",
      chainTemplateId: null,
      chainTemplateName: null,
      departmentId: DEPT.id,
      departmentName: DEPT.name,
      departmentCode: DEPT.code,
      steps: [],
    });
    // No point resolving holders for a chain that will never be built.
    expect(mockFindRecipe).not.toHaveBeenCalled();
    expect(mockResolveRoleHolders).not.toHaveBeenCalled();
  });

  it("scopes role-holder resolution to the chosen department", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "chain" });
    mockFindRecipe.mockResolvedValue(
      chainTemplateRow([{ stepOrder: 1, stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }]),
    );
    mockResolveRoleHolders.mockResolvedValue(
      new Map([["DEPT_MANAGER", [{ id: "u-9", firstName: "Ops", lastName: "Manager", email: "ops@x.co" }]]]),
    );

    mockDepartment.findOne.mockResolvedValue({ id: "dept-7", name: "Finance", code: "FIN" });

    const result = await getFormInstanceApprovalPrefill("ft-1", user, "dept-7");

    // A role step is department-scoped at decide time (ERR-STEP-DEPT-SCOPE), so
    // resolving holders tenant-wide here would tell the author someone can act
    // on this form when the engine will refuse them.
    expect(mockResolveRoleHolders).toHaveBeenCalledWith(["DEPT_MANAGER"], "t1", "dept-7");
    expect(result.departmentId).toBe("dept-7");
    expect(result.steps[0]!.roleHolders).toEqual([
      { id: "u-9", firstName: "Ops", lastName: "Manager", email: "ops@x.co" },
    ]);
  });

  it("still scopes to the fallback department when the caller chooses none", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "chain" });
    mockFindRecipe.mockResolvedValue(
      chainTemplateRow([{ stepOrder: 1, stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }]),
    );

    const result = await getFormInstanceApprovalPrefill("ft-1", user);

    // NOT tenant-wide. Choosing no department does not mean "any department" —
    // createFormInstance still files the form somewhere (the caller's own first
    // department, by code), so the picker has to answer about THAT department or
    // it reports a role as staffed when the engine will refuse it.
    expect(mockResolveRoleHolders).toHaveBeenCalledWith(["DEPT_MANAGER"], "t1", DEPT.id);
    expect(result.departmentCode).toBe(DEPT.code);
  });

  it("does not resolve holders for a step assigned to a named person", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: "t1", instanceApproval: "chain" });
    mockFindRecipe.mockResolvedValue(
      chainTemplateRow([{ stepOrder: 1, stepType: "APPROVE", assignedUserId: "u-5", assignedRole: null }]),
    );

    const result = await getFormInstanceApprovalPrefill("ft-1", user);

    expect(mockResolveRoleHolders).toHaveBeenCalledWith([], "t1", DEPT.id);
    expect(result.steps[0]!).not.toHaveProperty("roleHolders");
  });

  it("propagates the template's own read authorization", async () => {
    // getFormTemplate is scoped by tenant and 404s otherwise — a caller who
    // cannot see the template must not learn its approval routing either.
    mockFormTemplate.findOne.mockResolvedValue(null);

    await expect(getFormInstanceApprovalPrefill("ft-1", user)).rejects.toMatchObject({ code: "ERR-NOT-FOUND" });
    expect(mockFindRecipe).not.toHaveBeenCalled();
  });
});

// The chain is parsed and validated at the very top of createFormInstance,
// before a PDF is rendered or a document filed. That ordering is the point: the
// fill transaction commits before submitForApproval runs, so a chain rejected
// late would leave a filed instance with no approval chain and no way to add
// one. These assertions therefore double as a guard on that ordering — each one
// reaches its error without any storage, ClamAV or pdfme mock being satisfied.
describe("createFormInstance — chain validation happens before anything is filed", () => {
  const activeChainTemplate = { id: "ft-1", tenantId: "t1", status: "active", instanceApproval: "chain", schemaJson: [[]] };

  it("rejects approvers chosen for a template that does not use chain approval", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ ...activeChainTemplate, instanceApproval: "none" });

    await expect(
      createFormInstance("ft-1", {}, user, undefined, undefined, [{ stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }]),
    ).rejects.toMatchObject({ code: "ERR-FORM-APPROVAL-NOT-USED" });
  });

  it("rejects a chain whose last step is not an Approve", async () => {
    mockFormTemplate.findOne.mockResolvedValue(activeChainTemplate);

    await expect(
      createFormInstance("ft-1", {}, user, undefined, undefined, [{ stepType: "REVIEW", assignedRole: "APPROVER" }]),
    ).rejects.toMatchObject({ code: "ERR-CHAIN-FINAL-STEP" });
  });

  it("rejects a step carrying both a role and a named person", async () => {
    mockFormTemplate.findOne.mockResolvedValue(activeChainTemplate);

    await expect(
      createFormInstance("ft-1", {}, user, undefined, undefined, [
        { stepType: "APPROVE", assignedRole: "DEPT_MANAGER", assignedUserId: "8f1a0f4c-8a2b-4c6e-9f9d-3f1b2c4d5e6f" },
      ]),
    ).rejects.toThrow();
  });

  it("rejects a step carrying neither", async () => {
    mockFormTemplate.findOne.mockResolvedValue(activeChainTemplate);

    await expect(
      createFormInstance("ft-1", {}, user, undefined, undefined, [{ stepType: "APPROVE" }]),
    ).rejects.toThrow();
  });

  it("rejects an inactive template before looking at the chain at all", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ ...activeChainTemplate, status: "draft" });

    await expect(
      createFormInstance("ft-1", {}, user, undefined, undefined, [{ stepType: "APPROVE", assignedRole: "DEPT_MANAGER" }]),
    ).rejects.toMatchObject({ code: "ERR-TEMPLATE-INACTIVE" });
  });
});
