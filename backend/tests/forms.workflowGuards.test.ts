// Forms workflow guards (2026-10-04 audit of the forms module).
//
// Each block pins one hole that existed before the audit and fails without its fix:
//   * template ownership / lifecycle  — any holder of formtemplate:manage (EMPLOYEE has
//     it) could edit a colleague's draft, deprecate the live form, or reopen an active
//     one, and the status endpoint let a template skip the approval engine entirely;
//   * base-PDF key and schemaJson     — client-supplied storage key read from any
//     tenant; an unvalidated schema (crash on every fill, author-controlled regex);
//   * filing                          — no-department fallback filed under an unrelated
//     department, superseded versions still accepted, raw request body stored as the
//     instance data, hidden file fields, storage quota never reserved;
//   * reading                         — purged / trashed / status-restricted forms still
//     served by GET /forms/instances/:id and listed;
//   * the invisible platform admin    — shown as a template's approver.

const mockFormTemplate = { findAndCountAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), max: jest.fn() };
const mockFormInstance = { findAndCountAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() };
const mockDocument = { findByPk: jest.fn(), create: jest.fn(), update: jest.fn() };
const mockDocumentType = { findOne: jest.fn() };
const mockDepartment = { findOne: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };
const mockDocumentVersion = { create: jest.fn() };
const mockDocumentDek = { create: jest.fn() };
const mockOutbox = { bulkCreate: jest.fn() };
const mockFilterDocsByAcl = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  FormTemplate: mockFormTemplate,
  FormInstance: mockFormInstance,
  Document: mockDocument,
  DocumentType: mockDocumentType,
  DocumentVersion: mockDocumentVersion,
  DocumentDek: mockDocumentDek,
  Department: mockDepartment,
  UserDepartment: mockUserDepartment,
  OrgUnit: {},
  OutboxEvent: mockOutbox,
  SignatureRequest: {},
  SignatureRecipient: {},
  User: {},
  ApprovalChainTemplate: { findOne: jest.fn() },
  FormSequence: {},
  sequelize: {},
}));

const mockSubmitForApproval = jest.fn();
jest.mock("../src/modules/approvals/approvals.service.js", () => ({
  resolveRoleHolders: jest.fn(),
  submitForApproval: mockSubmitForApproval,
}));

const mockEncryptAndStore = jest.fn();
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: mockEncryptAndStore }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: jest.fn() }));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn().mockResolvedValue("clean") }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn() }));
jest.mock("../src/modules/documents/documents.service.js", () => ({
  filterDocsByDetailAcl: (...a: unknown[]) => mockFilterDocsByAcl(...a),
  ensureCanCreate: jest.fn(),
  grantDefaultDocumentAcl: jest.fn(),
}));
const mockReserveQuota = jest.fn();
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: mockReserveQuota }));
const mockAssertStatusPermission = jest.fn();
jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({
  assertStatusPermission: mockAssertStatusPermission,
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("../src/config/env.js", () => ({ config: { MINIO_BUCKET_DOCUMENTS: "bucket" } }));
jest.mock("../src/shared/transaction.js", () => ({ runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn() }));
const mockAssertACLAllow = jest.fn();
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: mockAssertACLAllow }));
const mockHiddenUserIds = jest.fn();
jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: mockHiddenUserIds }));
// Template scope rules are pinned in forms.templateScope.test.ts; here the seams are controllable.
const mockTemplateVisibilityWhere = jest.fn();
const mockCanViewTemplate = jest.fn();
const mockAssertScopeWritable = jest.fn();
const mockAssertTemplateUsable = jest.fn();
jest.mock("../src/modules/forms/formTemplateScope.js", () => ({
  ...jest.requireActual("../src/modules/forms/formTemplateScope.js"),
  templateVisibilityWhere: (...a: unknown[]) => mockTemplateVisibilityWhere(...a),
  canViewFormTemplate: (...a: unknown[]) => mockCanViewTemplate(...a),
  assertScopeWritable: (...a: unknown[]) => mockAssertScopeWritable(...a),
  assertTemplateUsableForDepartment: (...a: unknown[]) => mockAssertTemplateUsable(...a),
}));
const mockGetUserDepartmentIds = jest.fn();
jest.mock("../src/modules/approvals/stepRules.js", () => ({ getUserDepartmentIds: (...a: unknown[]) => mockGetUserDepartmentIds(...a) }));

import { PERMISSIONS } from "../src/config/permissions.js";

type Svc = typeof import("../src/modules/forms/forms.service.js");
let svc: Svc;

beforeAll(async () => {
  svc = await import("../src/modules/forms/forms.service.js");
});

beforeEach(() => {
  jest.resetAllMocks();
  mockHiddenUserIds.mockResolvedValue([]);
  mockTemplateVisibilityWhere.mockResolvedValue(null);
  mockCanViewTemplate.mockResolvedValue(true);
  mockAssertScopeWritable.mockImplementation(async (_u: unknown, s: { departmentId?: string | null; orgUnitId?: string | null } = {}) => ({ departmentId: s.departmentId ?? null, orgUnitId: s.orgUnitId ?? null }));
  mockGetUserDepartmentIds.mockResolvedValue([]);
  mockFormTemplate.max.mockResolvedValue(1);
  mockFilterDocsByAcl.mockImplementation(async (_user: unknown, docs: unknown[]) => docs);
  mockDocumentVersion.create.mockResolvedValue({ id: "ver-1" });
});

const T = "t1";
const user = (id: string, permissions: string[] = [PERMISSIONS.FORM_TEMPLATE_MANAGE], role = "EMPLOYEE") =>
  ({ userId: id, role, roles: [role], tenantId: T, permissions }) as never;

/** A model-like template row: update() merges into it, dataValues mirrors it. */
function tpl(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "ft-1", tenantId: T, name: "Leave Form", status: "draft", version: 1, createdBy: "u-owner", approvedBy: null,
    instanceApproval: "none", auditPolicy: "never", signingPolicy: "none", schemaJson: [[]], basePdfObjectKey: null,
    isLetterhead: false, sectionsJson: null, category: null, layoutMode: "static", ...over,
  };
  row.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(row, patch); return row; });
  row.dataValues = row;
  return row;
}

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  name, type: "text", position: { x: 20, y: 20 }, width: 80, height: 10, ...extra,
});

// ── Template lifecycle and ownership ──────────────────────────────────────────

describe("template ownership — formtemplate:manage is not 'any template'", () => {
  it("refuses a status change by someone who neither authored the template nor holds approval:admin", async () => {
    mockFormTemplate.findOne.mockResolvedValue(tpl({ status: "active" }));
    await expect(svc.updateFormTemplateStatus("ft-1", "deprecated", user("u-other"))).rejects.toMatchObject({
      statusCode: 403, code: "ERR-NOT-TEMPLATE-OWNER",
    });
  });

  it("refuses a content edit and a new revision by a non-owner", async () => {
    mockFormTemplate.findOne.mockResolvedValue(tpl());
    await expect(svc.updateFormTemplateContent("ft-1", { name: "x" }, user("u-other"))).rejects.toMatchObject({ code: "ERR-NOT-TEMPLATE-OWNER" });
    mockFormTemplate.findOne.mockResolvedValue(tpl({ status: "active" }));
    await expect(svc.createFormTemplateVersion("ft-1", user("u-other"))).rejects.toMatchObject({ code: "ERR-NOT-TEMPLATE-OWNER" });
  });

  it("lets the author deprecate their own active template, and an approval admin deprecate anyone's", async () => {
    const own = tpl({ status: "active" });
    mockFormTemplate.findOne.mockResolvedValue(own);
    await svc.updateFormTemplateStatus("ft-1", "deprecated", user("u-owner"));
    expect(own.status).toBe("deprecated");

    const theirs = tpl({ status: "active" });
    mockFormTemplate.findOne.mockResolvedValue(theirs);
    // acl:bypass_admin = organisation-level: may manage a template of any scope.
    await svc.updateFormTemplateStatus("ft-1", "deprecated", user("u-admin", [PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.ACL_BYPASS_ADMIN]));
    expect(theirs.status).toBe("deprecated");
  });

  // approval:admin is held by every department manager: it only reaches templates inside its own scope.
  it("a department manager cannot deprecate a tenant-wide template or another department's template", async () => {
    const manager = user("u-mgr", [PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.APPROVAL_ADMIN], "DEPT_MANAGER");
    mockGetUserDepartmentIds.mockResolvedValue(["dept-own"]);
    mockFormTemplate.findOne.mockResolvedValue(tpl({ status: "active" })); // tenant-wide
    await expect(svc.updateFormTemplateStatus("ft-1", "deprecated", manager)).rejects.toMatchObject({ code: "ERR-FORM-TEMPLATE-SCOPE" });
    mockFormTemplate.findOne.mockResolvedValue(tpl({ status: "active", departmentId: "dept-other" }));
    await expect(svc.updateFormTemplateStatus("ft-1", "deprecated", manager)).rejects.toMatchObject({ code: "ERR-FORM-TEMPLATE-SCOPE" });
  });

  it("a department manager can deprecate a template scoped to their own department", async () => {
    const manager = user("u-mgr", [PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.APPROVAL_ADMIN], "DEPT_MANAGER");
    mockGetUserDepartmentIds.mockResolvedValue(["dept-own"]);
    const own = tpl({ status: "active", departmentId: "dept-own" });
    mockFormTemplate.findOne.mockResolvedValue(own);
    await svc.updateFormTemplateStatus("ft-1", "deprecated", manager);
    expect(own.status).toBe("deprecated");
  });

  it("a template with no recorded author is changeable only by an approval admin", async () => {
    mockFormTemplate.findOne.mockResolvedValue(tpl({ status: "active", createdBy: null }));
    await expect(svc.updateFormTemplateStatus("ft-1", "deprecated", user("u-owner"))).rejects.toMatchObject({ code: "ERR-NOT-TEMPLATE-OWNER" });
  });
});

describe("template status endpoint cannot bypass the approval engine", () => {
  it.each([
    ["draft", "pending_approval"],
    ["draft", "active"],
    ["pending_approval", "draft"],
    ["pending_approval", "active"],
    ["active", "draft"],
    ["deprecated", "active"],
    ["deprecated", "draft"],
  ])("%s -> %s is refused", async (from, to) => {
    const row = tpl({ status: from });
    mockFormTemplate.findOne.mockResolvedValue(row);
    await expect(svc.updateFormTemplateStatus("ft-1", to as never, user("u-owner"))).rejects.toMatchObject({ statusCode: 409 });
    expect(row.update).not.toHaveBeenCalled();
    expect(row.status).toBe(from);
  });

  it("active -> deprecated is the one transition it performs", async () => {
    const row = tpl({ status: "active" });
    mockFormTemplate.findOne.mockResolvedValue(row);
    await svc.updateFormTemplateStatus("ft-1", "deprecated", user("u-owner"));
    expect(row.status).toBe("deprecated");
  });
});

// ── base PDF key + schemaJson ─────────────────────────────────────────────────

describe("assertOwnBasePdfKey", () => {
  it("accepts the tenant's own template files and an absent key", () => {
    expect(() => svc.assertOwnBasePdfKey(`${T}/forms/base-pdfs/abc/form.pdf`, T)).not.toThrow();
    expect(() => svc.assertOwnBasePdfKey(null, T)).not.toThrow();
    expect(() => svc.assertOwnBasePdfKey(undefined, T)).not.toThrow();
  });

  it.each([
    "t2/forms/base-pdfs/abc/form.pdf", // another tenant's file
    "t1/forms/base-pdfs/../../t2/forms/base-pdfs/x.pdf", // traversal
    "t1/other/dept/FORM/doc/ver/form.pdf", // a filed document's storage key
    "t1\\forms\\base-pdfs\\x.pdf",
    "t1/forms/base-pdfs/./x.pdf",
  ])("refuses %s", (key) => {
    expect(() => svc.assertOwnBasePdfKey(key, T)).toThrow(expect.objectContaining({ code: "ERR-FORM-BASE-PDF-INVALID" }));
  });

  it("is enforced when a draft is edited", async () => {
    mockFormTemplate.findOne.mockResolvedValue(tpl());
    await expect(
      svc.updateFormTemplateContent("ft-1", { basePdfObjectKey: "t2/forms/base-pdfs/abc/form.pdf" }, user("u-owner")),
    ).rejects.toMatchObject({ code: "ERR-FORM-BASE-PDF-INVALID" });
  });
});

describe("validateTemplateSchemaJson", () => {
  it("accepts what the builder produces", () => {
    expect(() => svc.validateTemplateSchemaJson([[field("a"), field("b", { type: "select", options: ["x"] })], []])).not.toThrow();
    expect(() => svc.validateTemplateSchemaJson([[]])).not.toThrow();
  });

  it.each([
    ["not pages", { fields: [] }],
    ["a page that is not a list", [{}]],
    ["an unknown field type", [[field("a", { type: "signature" })]]],
    ["a field with no position", [[{ name: "a", type: "text", width: 10 }]]],
    ["duplicate names", [[field("a")], [field("a")]]],
    ["an invalid regular expression", [[field("a", { validation: { pattern: "(" } })]]],
    ["a nested-quantifier regex", [[field("a", { validation: { pattern: "^(a+)+$" } })]]],
    ["a quantified alternation", [[field("a", { validation: { pattern: "^(a|aa)+$" } })]]],
    ["an over-long pattern", [[field("a", { validation: { pattern: "a".repeat(201) } })]]],
  ])("rejects %s", (_label, schema) => {
    expect(() => svc.validateTemplateSchemaJson(schema)).toThrow(expect.objectContaining({ code: "ERR-FORM-VALIDATION" }));
  });

  it("is enforced on create and on edit", async () => {
    await expect(
      svc.createFormTemplate({ name: "X", schemaJson: [[field("a"), field("a")]] }, user("u-owner")),
    ).rejects.toMatchObject({ code: "ERR-FORM-VALIDATION" });
    mockFormTemplate.findOne.mockResolvedValue(tpl());
    await expect(
      svc.updateFormTemplateContent("ft-1", { schemaJson: [[field("a", { validation: { pattern: "^(a+)+$" } })]] }, user("u-owner")),
    ).rejects.toMatchObject({ code: "ERR-FORM-VALIDATION" });
  });
});

describe("validation.pattern at fill time", () => {
  it("never runs a (possibly catastrophic, legacy) regex against an over-long value", () => {
    const schema = svc.buildZodSchemaFromTemplate([[field("a", { validation: { pattern: "^(a+)+$" } })]], {});
    const started = Date.now();
    const result = schema.safeParse({ a: "a".repeat(5000) + "!" });
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still enforces an ordinary pattern, and skips (not 500s on) a legacy pattern that does not compile", () => {
    const ok = svc.buildZodSchemaFromTemplate([[field("a", { validation: { pattern: "^[A-Z]{3}$" } })]], {});
    expect(ok.safeParse({ a: "ABC" }).success).toBe(true);
    expect(ok.safeParse({ a: "abc" }).success).toBe(false);
    const legacy = svc.buildZodSchemaFromTemplate([[field("a", { validation: { pattern: "(" } })]], {});
    expect(legacy.safeParse({ a: "anything" }).success).toBe(true);
  });
});

describe("template names", () => {
  it("a new template cannot reuse a name already in the tenant (versions are tracked by name)", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "other" });
    await expect(svc.createFormTemplate({ name: "Leave Form", schemaJson: [[]] }, user("u-owner"))).rejects.toMatchObject({
      statusCode: 409, code: "ERR-FORM-TEMPLATE-NAME-TAKEN",
    });
    expect(mockFormTemplate.create).not.toHaveBeenCalled();
  });
});

// ── listing ───────────────────────────────────────────────────────────────────

describe("listFormTemplates", () => {
  it("the active list excludes a template that a newer active revision supersedes", async () => {
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await svc.listFormTemplates(user("u-1"), "active");
    const where = mockFormTemplate.findAndCountAll.mock.calls[0][0].where as Record<symbol, unknown[]>;
    const [clause] = Object.getOwnPropertySymbols(where).map((s) => where[s]).flat() as Array<{ val: string }>;
    expect(clause.val).toMatch(/newer\.version > "FormTemplate"\.version/);
    expect(clause.val).toMatch(/newer\.status = 'active'/);
  });

  it("other status filters are not narrowed", async () => {
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await svc.listFormTemplates(user("u-1"), "deprecated");
    expect(Object.getOwnPropertySymbols(mockFormTemplate.findAndCountAll.mock.calls[0][0].where)).toHaveLength(0);
  });

  it("clamps skip/take instead of passing NaN or negatives to the query", async () => {
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await svc.listFormTemplates(user("u-1"), undefined, Number.NaN, -5);
    const opts = mockFormTemplate.findAndCountAll.mock.calls[0][0];
    expect(opts.offset).toBe(0);
    expect(opts.limit).toBe(1);
  });

  it("never shows the hidden platform admin as a template's approver (list and detail)", async () => {
    mockHiddenUserIds.mockResolvedValue(["u-platform"]);
    const approved = tpl({ status: "active", approvedBy: "u-platform" });
    (approved.dataValues as Record<string, unknown>).approver = { id: "u-platform", email: "owner@platform" };
    const normal = tpl({ id: "ft-2", status: "active", approvedBy: "u-real" });
    (normal.dataValues as Record<string, unknown>).approver = { id: "u-real", email: "real@x" };
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [approved, normal], count: 2 });

    const { data } = await svc.listFormTemplates(user("u-1"));
    const values = data.map((r) => r.dataValues as unknown as Record<string, unknown>);
    expect(values[0]!.approver).toBeNull();
    expect(values[0]!.approvedBy).toBeNull();
    expect(values[1]!.approver).toEqual({ id: "u-real", email: "real@x" });

    const again = tpl({ status: "active", approvedBy: "u-platform" });
    (again.dataValues as Record<string, unknown>).approver = { id: "u-platform" };
    mockFormTemplate.findOne.mockResolvedValue(again);
    const detail = await svc.getFormTemplate("ft-1", user("u-1"));
    expect((detail.dataValues as unknown as Record<string, unknown>).approver).toBeNull();
  });

  it("the platform admin still sees themself (hiddenUserIds already excludes the viewer)", async () => {
    mockHiddenUserIds.mockResolvedValue([]); // the helper drops the viewer's own id
    const row = tpl({ status: "active", approvedBy: "u-platform" });
    (row.dataValues as Record<string, unknown>).approver = { id: "u-platform" };
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [row], count: 1 });
    const { data } = await svc.listFormTemplates(user("u-platform"));
    expect((data[0]!.dataValues as unknown as Record<string, unknown>).approver).toEqual({ id: "u-platform" });
  });
});

// ── filing a submission ───────────────────────────────────────────────────────

describe("createFormInstance", () => {
  const DEPT = { id: "dept-own", name: "Finance", code: "FIN" };
  const activeTemplate = (over: Record<string, unknown> = {}) =>
    tpl({ status: "active", instanceApproval: "none", schemaJson: [[]], ...over });

  function arrangeFiling(template: Record<string, unknown>) {
    mockFormTemplate.findOne
      .mockResolvedValueOnce(template) // getFormTemplate
      .mockResolvedValueOnce(null); // no newer active revision
    mockDocumentType.findOne.mockResolvedValue({ id: "doctype-form" });
    mockDepartment.findOne.mockResolvedValue(DEPT);
    mockUserDepartment.findAll.mockResolvedValue([{ departmentId: DEPT.id }]);
    let n = 0;
    mockEncryptAndStore.mockImplementation(async () => ({ encryptedKey: `k${n++}`, sha256Hash: "h", kekId: "kek" }));
    mockDocument.create.mockResolvedValue({});
    mockDocument.update.mockResolvedValue([1]);
    mockFormInstance.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "fi-1", ...row }));
  }

  it("saveAsDraft files a chain-approval form as a DRAFT and does NOT submit it; without the flag it is submitted", async () => {
    arrangeFiling(activeTemplate({ instanceApproval: "chain" }));
    mockSubmitForApproval.mockResolvedValue({});
    await svc.createFormInstance("ft-1", {}, user("u-1"), undefined, undefined, undefined, { saveAsDraft: true });
    expect(mockSubmitForApproval).not.toHaveBeenCalled();
    expect(mockDocument.create).toHaveBeenCalledWith(expect.objectContaining({ status: "DRAFT" }), expect.anything());

    mockDocument.create.mockClear();
    arrangeFiling(activeTemplate({ instanceApproval: "chain" }));
    await svc.createFormInstance("ft-1", {}, user("u-1"));
    expect(mockSubmitForApproval).toHaveBeenCalledTimes(1);
  });

  it("saveAsDraft is refused for a form that has no approval (filing it is final)", async () => {
    mockFormTemplate.findOne.mockResolvedValueOnce(activeTemplate({ instanceApproval: "none" }));
    await expect(svc.createFormInstance("ft-1", {}, user("u-1"), undefined, undefined, undefined, { saveAsDraft: true }))
      .rejects.toMatchObject({ statusCode: 422, code: "ERR-FORM-DRAFT-NOT-USED" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });

  it("filing checks the template covers the filing department", async () => {
    arrangeFiling(activeTemplate());
    mockAssertTemplateUsable.mockImplementation(() => { throw Object.assign(new Error("scope"), { statusCode: 403, code: "ERR-FORM-TEMPLATE-SCOPE" }); });
    await expect(svc.createFormInstance("ft-1", {}, user("u-1"))).rejects.toMatchObject({ code: "ERR-FORM-TEMPLATE-SCOPE" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });

  it("refuses a superseded template version", async () => {
    mockFormTemplate.findOne
      .mockResolvedValueOnce(activeTemplate({ version: 1 }))
      .mockResolvedValueOnce({ id: "ft-2", version: 2 });
    await expect(svc.createFormInstance("ft-1", {}, user("u-1"))).rejects.toMatchObject({
      statusCode: 409, code: "ERR-TEMPLATE-SUPERSEDED",
    });
    const lookup = mockFormTemplate.findOne.mock.calls[1][0].where;
    expect(lookup).toMatchObject({ tenantId: T, name: "Leave Form", status: "active" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });

  it("with no department chosen, files under the CALLER's own department — never an unrelated one", async () => {
    arrangeFiling(activeTemplate());
    await svc.createFormInstance("ft-1", {}, user("u-1"));
    // The department lookup is restricted to the caller's memberships.
    const lookup = mockDepartment.findOne.mock.calls[0][0];
    const inClause = lookup.where.id as Record<symbol, unknown>;
    expect(Object.getOwnPropertySymbols(inClause).map((s) => inClause[s])).toEqual([["dept-own"]]);
    expect(mockUserDepartment.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-1" } }));
  });

  it("with no department chosen and none of their own, refuses rather than picking the tenant's first", async () => {
    mockFormTemplate.findOne.mockResolvedValueOnce(activeTemplate()).mockResolvedValueOnce(null);
    mockDocumentType.findOne.mockResolvedValue({ id: "doctype-form" });
    mockUserDepartment.findAll.mockResolvedValue([]);
    await expect(svc.createFormInstance("ft-1", {}, user("u-1"))).rejects.toMatchObject({ code: "ERR-DEPT-INVALID" });
    expect(mockDepartment.findOne).not.toHaveBeenCalled();
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });

  it("keeps the tenant-wide fallback for a holder of acl:bypass_admin with no department", async () => {
    arrangeFiling(activeTemplate());
    mockUserDepartment.findAll.mockResolvedValue([]);
    await svc.createFormInstance("ft-1", {}, user("u-admin", [PERMISSIONS.ACL_BYPASS_ADMIN]));
    expect(mockDepartment.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T }, order: [["code", "ASC"]] }));
  });

  it("stores the server-derived values, not the raw request body", async () => {
    const template = activeTemplate({
      schemaJson: [[
        field("date_from", { type: "date" }),
        field("date_to", { type: "date" }),
        field("days", { type: "number", computed: { type: "dateDiffDays", fromField: "date_from", toField: "date_to" } }),
        field("kind", { type: "select", options: ["General", "Confidential"] }),
        field("secret_note", { conditionalOn: { field: "kind", operator: "equals", value: "Confidential" } }),
      ]],
    });
    arrangeFiling(template);

    await svc.createFormInstance("ft-1", {
      date_from: "2026-01-01", date_to: "2026-01-04", kind: "General",
      days: "-8", // client-forged computed value
      secret_note: "stale text typed before the answer hid it",
      __proto_extra: { arbitrary: "blob" }, // belongs to no field
    }, user("u-1"));

    const stored = mockFormInstance.create.mock.calls[0][0].dataJson as Record<string, unknown>;
    expect(stored.days).toBe("3"); // recomputed, not "-8"
    expect(stored).not.toHaveProperty("secret_note");
    expect(stored).not.toHaveProperty("__proto_extra");
    expect(stored).toMatchObject({ date_from: "2026-01-01", date_to: "2026-01-04", kind: "General" });
  });

  it("a file field its condition hides is neither required nor filed", async () => {
    const template = activeTemplate({
      schemaJson: [[
        field("kind", { type: "select", options: ["General", "Medical"] }),
        field("certificate", { type: "file", required: true, conditionalOn: { field: "kind", operator: "equals", value: "Medical" } }),
      ]],
    });
    arrangeFiling(template);
    const upload = { fieldname: "certificate", originalname: "c.pdf", mimetype: "application/pdf", size: 10, buffer: Buffer.from("x") } as Express.Multer.File;

    // Hidden and absent: the required rule must not fire.
    await expect(svc.createFormInstance("ft-1", { kind: "General" }, user("u-1"))).resolves.toBeDefined();

    // Hidden but uploaded anyway: not filed as an attachment document.
    mockFormTemplate.findOne.mockResolvedValueOnce(template).mockResolvedValueOnce(null);
    mockEncryptAndStore.mockClear();
    await svc.createFormInstance("ft-1", { kind: "General" }, user("u-1"), undefined, { certificate: upload });
    expect(mockEncryptAndStore).toHaveBeenCalledTimes(1); // the form PDF only

    // Visible and missing: still required.
    mockFormTemplate.findOne.mockResolvedValueOnce(template).mockResolvedValueOnce(null);
    await expect(svc.createFormInstance("ft-1", { kind: "Medical" }, user("u-1"))).rejects.toMatchObject({ code: "ERR-FORM-VALIDATION" });
  });

  it("reserves the tenant's storage quota for the PDF and every attachment", async () => {
    const template = activeTemplate({ schemaJson: [[field("scan", { type: "file" })]] });
    arrangeFiling(template);
    const upload = { fieldname: "scan", originalname: "s.pdf", mimetype: "application/pdf", size: 1000, buffer: Buffer.alloc(1000) } as Express.Multer.File;
    await svc.createFormInstance("ft-1", {}, user("u-1"), undefined, { scan: upload });
    const pdfBytes = Buffer.from("%PDF-1.4 mock").length;
    expect(mockReserveQuota).toHaveBeenCalledWith(T, pdfBytes + 1000, expect.anything());
  });

  it("a full tenant stops the filing (413 from the reservation) before any row is written", async () => {
    arrangeFiling(activeTemplate());
    const { AppError } = jest.requireActual("../src/core/AppError.js");
    mockReserveQuota.mockRejectedValue(new AppError(413, "STORAGE_QUOTA_EXCEEDED", "full"));
    await expect(svc.createFormInstance("ft-1", {}, user("u-1"))).rejects.toMatchObject({ statusCode: 413 });
    expect(mockDocument.create).not.toHaveBeenCalled();
    expect(mockFormInstance.create).not.toHaveBeenCalled();
  });
});

// ── reading an instance ───────────────────────────────────────────────────────

describe("getFormInstance", () => {
  const instance = (over: Record<string, unknown> = {}) => ({
    id: "fi-1", templateId: "ft-1", documentId: "doc-1", dataJson: { a: 1 }, template: { tenantId: T }, ...over,
  });
  const doc = (over: Record<string, unknown> = {}) => ({ id: "doc-1", tenantId: T, status: "ACTIVE", deletedAt: null, ...over });

  it("serves a live, readable instance and applies ACL + the status-conditioned read rule", async () => {
    mockFormInstance.findByPk.mockResolvedValue(instance());
    mockDocument.findByPk.mockResolvedValue(doc());
    const got = await svc.getFormInstance("fi-1", user("u-1"));
    expect(got).toMatchObject({ id: "fi-1" });
    expect(mockAssertACLAllow).toHaveBeenCalledWith("u-1", ["EMPLOYEE"], T, expect.objectContaining({ resourceId: "doc-1" }), expect.anything());
    expect(mockAssertStatusPermission).toHaveBeenCalledWith(expect.objectContaining({ status: "ACTIVE" }), "read", expect.anything());
  });

  it("a destroyed document leaves the instance unreadable (it used to be open to every document:read holder)", async () => {
    mockFormInstance.findByPk.mockResolvedValue(instance({ documentId: null }));
    await expect(svc.getFormInstance("fi-1", user("u-1"))).rejects.toMatchObject({ statusCode: 404 });
    expect(mockAssertACLAllow).not.toHaveBeenCalled();
  });

  it("a trashed form is not served", async () => {
    mockFormInstance.findByPk.mockResolvedValue(instance());
    mockDocument.findByPk.mockResolvedValue(doc({ deletedAt: new Date() }));
    await expect(svc.getFormInstance("fi-1", user("u-1"))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("another tenant's instance is a 404, not a 403 that confirms it exists", async () => {
    mockFormInstance.findByPk.mockResolvedValue(instance({ template: { tenantId: "t-other" } }));
    await expect(svc.getFormInstance("fi-1", user("u-1"))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("honours a tenant rule that restricts reading documents in this status", async () => {
    mockFormInstance.findByPk.mockResolvedValue(instance());
    mockDocument.findByPk.mockResolvedValue(doc({ status: "ARCHIVED" }));
    const { AppError } = jest.requireActual("../src/core/AppError.js");
    mockAssertStatusPermission.mockRejectedValue(new AppError(403, "ERR-STATUS-ACTION-DENIED", "no"));
    await expect(svc.getFormInstance("fi-1", user("u-1"))).rejects.toMatchObject({ code: "ERR-STATUS-ACTION-DENIED" });
  });
});

describe("listFormInstances", () => {
  it("leaves trashed forms out and validates its id filters", async () => {
    mockFormInstance.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await svc.listFormInstances(user("u-1"), {}, 0, 25);
    const documentInclude = (mockFormInstance.findAndCountAll.mock.calls[0][0].include as Array<{ as: string; where: Record<string, unknown> }>)
      .find((i) => i.as === "document")!;
    expect(documentInclude.where.tenantId).toBe(T);
    expect(documentInclude.where).toHaveProperty("deletedAt");

    await expect(svc.listFormInstances(user("u-1"), { createdBy: "not-a-uuid" })).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.listFormInstances(user("u-1"), { templateId: "nope" })).rejects.toMatchObject({ statusCode: 422 });
  });
});
