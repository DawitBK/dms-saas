// Form template scope (audit item 6: "templates have no department or org-unit scope"). The REAL scope module and the
// REAL forms.service wiring, with the data layer mocked.
//
//   write  assertScopeWritable   ids validated against the tenant; organisation-level roles may go tenant-wide / org-unit,
//                                everyone else must pick a department they belong to;
//   list   templateVisibilityWhere  scoped the way GET /document-types is;
//   read   canViewFormTemplate   out of scope = not found (author, org-level roles and the template's approvers excepted);
//   use    assertTemplateUsableForDepartment   filing needs the template to cover the filing department.

const mockDepartment = { findOne: jest.fn() };
const mockOrgUnit = { findOne: jest.fn() };
const mockApprovalChain = { findAll: jest.fn() };
const mockApprovalStep = { findOne: jest.fn() };
const mockFormTemplate = { findAndCountAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), max: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  OrgUnit: mockOrgUnit,
  ApprovalChain: mockApprovalChain,
  ApprovalStep: mockApprovalStep,
  FormTemplate: mockFormTemplate,
  FormInstance: {}, Document: {}, DocumentType: {}, DocumentVersion: {}, DocumentDek: {}, UserDepartment: {},
  OutboxEvent: {}, SignatureRequest: {}, SignatureRecipient: {}, User: {}, FormSequence: {}, sequelize: {},
}));
const mockGetUserDepartmentIds = jest.fn();
jest.mock("../src/modules/approvals/stepRules.js", () => ({ getUserDepartmentIds: (...a: unknown[]) => mockGetUserDepartmentIds(...a) }));
const mockVisibleDepts = jest.fn();
const mockVisibleUnits = jest.fn();
jest.mock("../src/modules/departments/departments.service.js", () => ({
  getVisibleDepartmentIds: (...a: unknown[]) => mockVisibleDepts(...a),
  getVisibleOrgUnitIds: (...a: unknown[]) => mockVisibleUnits(...a),
}));
jest.mock("../src/shared/orgScope.js", () => ({
  hasTenantWideStructureAuthority: (a: { permissions?: string[] }) =>
    (a.permissions ?? []).includes("acl:bypass_admin") || (a.permissions ?? []).includes("orgunit:manage"),
}));
jest.mock("../src/modules/approvals/approvals.service.js", () => ({}));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: jest.fn() }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: jest.fn() }));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn() }));
jest.mock("../src/modules/documents/documents.service.js", () => ({ filterDocsByDetailAcl: jest.fn(), ensureCanCreate: jest.fn() }));
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: jest.fn() }));
jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({ assertStatusPermission: jest.fn() }));
jest.mock("../src/shared/documentGuards.js", () => ({ requireLegalHoldClear: jest.fn() }));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({ validateTransition: jest.fn() }));
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: jest.fn() }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn() }));
jest.mock("../src/shared/transaction.js", () => ({ runInTransaction: (fn: (t: unknown) => Promise<unknown>) => fn({}) }));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("../src/config/env.js", () => ({ config: {} }));
jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: jest.fn().mockResolvedValue([]) }));

import { Op } from "sequelize";
import { PERMISSIONS } from "../src/config/permissions.js";
import {
  assertScopeWritable,
  assertTemplateUsableForDepartment,
  canViewFormTemplate,
  hasOrgWideTemplateAuthority,
  templateCoversDepartment,
  templateVisibilityWhere,
} from "../src/modules/forms/formTemplateScope.js";

const T = "t1";
const DEPT = "00000000-0000-4000-8000-0000000000d1";
const UNIT = "00000000-0000-4000-8000-0000000000e1";
const actor = (permissions: string[] = [PERMISSIONS.FORM_TEMPLATE_MANAGE], userId = "u-1") => ({ userId, tenantId: T, permissions });
const orgLevel = actor([PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN]);

beforeEach(() => {
  jest.resetAllMocks();
  mockDepartment.findOne.mockResolvedValue({ id: DEPT });
  mockOrgUnit.findOne.mockResolvedValue({ id: UNIT });
  mockGetUserDepartmentIds.mockResolvedValue([]);
  mockVisibleDepts.mockResolvedValue(new Set<string>());
  mockVisibleUnits.mockResolvedValue(new Set<string>());
  mockApprovalChain.findAll.mockResolvedValue([]);
  mockApprovalStep.findOne.mockResolvedValue(null);
});

describe("who may set a scope", () => {
  it("organisation-level authority = acl:bypass_admin, orgunit:manage or document:read_all (the doc-type rule)", () => {
    expect(hasOrgWideTemplateAuthority(actor([PERMISSIONS.ACL_BYPASS_ADMIN]))).toBe(true);
    expect(hasOrgWideTemplateAuthority(actor([PERMISSIONS.ORG_UNIT_MANAGE]))).toBe(true);
    expect(hasOrgWideTemplateAuthority(actor([PERMISSIONS.DOCUMENT_READ_ALL]))).toBe(true);
    expect(hasOrgWideTemplateAuthority(actor([PERMISSIONS.FORM_TEMPLATE_MANAGE, PERMISSIONS.APPROVAL_ADMIN]))).toBe(false);
  });

  it("a scope names a department OR an org unit, never both", async () => {
    await expect(assertScopeWritable(orgLevel, { departmentId: DEPT, orgUnitId: UNIT })).rejects.toMatchObject({ statusCode: 422, code: "ERR-FORM-SCOPE-INVALID" });
  });

  it("is validated against THIS tenant", async () => {
    mockDepartment.findOne.mockResolvedValue(null);
    await expect(assertScopeWritable(orgLevel, { departmentId: DEPT })).rejects.toMatchObject({ code: "ERR-FORM-SCOPE-INVALID" });
    expect(mockDepartment.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DEPT, tenantId: T } }));
    mockOrgUnit.findOne.mockResolvedValue(null);
    await expect(assertScopeWritable(orgLevel, { orgUnitId: UNIT })).rejects.toMatchObject({ code: "ERR-FORM-SCOPE-INVALID" });
    expect(mockOrgUnit.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UNIT, tenantId: T } }));
  });

  it("an organisation-level role may leave a template tenant-wide, or scope it to any department or org unit", async () => {
    await expect(assertScopeWritable(orgLevel, {})).resolves.toEqual({ departmentId: null, orgUnitId: null });
    await expect(assertScopeWritable(orgLevel, { orgUnitId: UNIT })).resolves.toEqual({ departmentId: null, orgUnitId: UNIT });
    await expect(assertScopeWritable(orgLevel, { departmentId: DEPT })).resolves.toEqual({ departmentId: DEPT, orgUnitId: null });
  });

  it("everyone else must choose a department — tenant-wide and org-unit scope are refused", async () => {
    await expect(assertScopeWritable(actor(), {})).rejects.toMatchObject({ statusCode: 422, code: "ERR-FORM-SCOPE-REQUIRED" });
    await expect(assertScopeWritable(actor(), { orgUnitId: UNIT })).rejects.toMatchObject({ code: "ERR-FORM-SCOPE-REQUIRED" });
  });

  it("…and a department they belong to", async () => {
    mockGetUserDepartmentIds.mockResolvedValue(["some-other-dept"]);
    await expect(assertScopeWritable(actor(), { departmentId: DEPT })).rejects.toMatchObject({ statusCode: 403, code: "ERR-FORM-SCOPE" });
    mockGetUserDepartmentIds.mockResolvedValue([DEPT]);
    await expect(assertScopeWritable(actor(), { departmentId: DEPT })).resolves.toEqual({ departmentId: DEPT, orgUnitId: null });
  });
});

describe("use: the template must cover the filing department (the document-type rule)", () => {
  const dept = { id: DEPT, orgUnitId: UNIT };
  it("tenant-wide covers everything; a department scope covers exactly that department; an org-unit scope its departments", () => {
    expect(templateCoversDepartment({}, dept)).toBe(true);
    expect(templateCoversDepartment({ departmentId: DEPT }, dept)).toBe(true);
    expect(templateCoversDepartment({ departmentId: "other" }, dept)).toBe(false);
    expect(templateCoversDepartment({ orgUnitId: UNIT }, dept)).toBe(true);
    expect(templateCoversDepartment({ orgUnitId: "other-unit" }, dept)).toBe(false);
  });

  it("refuses filing outside the scope (403), except for acl:bypass_admin", () => {
    expect(() => assertTemplateUsableForDepartment({ departmentId: "other" }, dept, actor())).toThrow(expect.objectContaining({ statusCode: 403, code: "ERR-FORM-TEMPLATE-SCOPE" }));
    expect(() => assertTemplateUsableForDepartment({ departmentId: "other" }, dept, actor([PERMISSIONS.ACL_BYPASS_ADMIN]))).not.toThrow();
    expect(() => assertTemplateUsableForDepartment({ departmentId: DEPT }, dept, actor())).not.toThrow();
  });
});

describe("list: templates are filtered by scope the way document types are", () => {
  it("administrators and read-all roles are not narrowed", async () => {
    expect(await templateVisibilityWhere(actor([PERMISSIONS.ACL_BYPASS_ADMIN]))).toBeNull();
    expect(await templateVisibilityWhere(actor([PERMISSIONS.DOCUMENT_READ_ALL]))).toBeNull();
  });

  it("everyone else sees tenant-wide templates, those scoped to a department / org unit they can see, and their own", async () => {
    mockVisibleDepts.mockResolvedValue(new Set([DEPT]));
    mockVisibleUnits.mockResolvedValue(new Set([UNIT]));
    const where = (await templateVisibilityWhere(actor([PERMISSIONS.FORM_TEMPLATE_MANAGE], "u-me"))) as Record<symbol, unknown[]>;
    expect(where[Op.or]).toEqual([
      { departmentId: null, orgUnitId: null },
      { departmentId: { [Op.in]: [DEPT] } },
      { orgUnitId: { [Op.in]: [UNIT] } },
      { createdBy: "u-me" },
    ]);
    expect(mockVisibleDepts).toHaveBeenCalledWith(T, "u-me");
  });
});

describe("read: a template out of scope is not found", () => {
  const scoped = { id: "ft-1", tenantId: T, departmentId: DEPT, orgUnitId: null, createdBy: "someone" };

  it("unscoped templates are visible to anyone in the tenant", async () => {
    expect(await canViewFormTemplate({ id: "ft", tenantId: T, departmentId: null, orgUnitId: null }, actor())).toBe(true);
  });

  it("scoped: not visible to a stranger, visible to the author, to org-level roles, to people who see the department", async () => {
    expect(await canViewFormTemplate(scoped, actor())).toBe(false);
    expect(await canViewFormTemplate({ ...scoped, createdBy: "u-1" }, actor())).toBe(true);
    expect(await canViewFormTemplate(scoped, orgLevel)).toBe(true);
    mockVisibleDepts.mockResolvedValue(new Set([DEPT]));
    expect(await canViewFormTemplate(scoped, actor())).toBe(true);
    mockVisibleDepts.mockResolvedValue(new Set());
    mockVisibleUnits.mockResolvedValue(new Set([UNIT]));
    expect(await canViewFormTemplate({ ...scoped, departmentId: null, orgUnitId: UNIT }, actor())).toBe(true);
  });

  it("…and to someone holding a step on its approval chain, so a template can never become un-reviewable", async () => {
    mockApprovalChain.findAll.mockResolvedValue([{ id: "chain-1" }]);
    mockApprovalStep.findOne.mockResolvedValue({ id: "step-1" });
    expect(await canViewFormTemplate(scoped, actor())).toBe(true);
    const where = mockApprovalStep.findOne.mock.calls[0]![0].where;
    expect(where.chainId).toBeDefined();
    expect(JSON.stringify(Object.getOwnPropertySymbols(where).map((s) => String(s)))).toContain("or");
    mockApprovalStep.findOne.mockResolvedValue(null);
    expect(await canViewFormTemplate(scoped, actor())).toBe(false);
  });
});

describe("forms.service wiring", () => {
  let svc: typeof import("../src/modules/forms/forms.service.js");
  beforeAll(async () => { svc = await import("../src/modules/forms/forms.service.js"); });

  it("createFormTemplate stores the validated scope and refuses a tenant-wide template from a non-organisation-level author", async () => {
    mockFormTemplate.findOne.mockResolvedValue(null); // name free
    mockFormTemplate.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "ft-new", ...row }));
    mockGetUserDepartmentIds.mockResolvedValue([DEPT]);
    await expect(svc.createFormTemplate({ name: "Leave", schemaJson: [[]] }, actor() as never)).rejects.toMatchObject({ code: "ERR-FORM-SCOPE-REQUIRED" });
    expect(mockFormTemplate.create).not.toHaveBeenCalled();

    await svc.createFormTemplate({ name: "Leave", schemaJson: [[]], departmentId: DEPT }, actor() as never);
    expect(mockFormTemplate.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: DEPT, orgUnitId: null, tenantId: T }));
  });

  it("listFormTemplates applies the visibility filter on top of the status filter", async () => {
    mockFormTemplate.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    await svc.listFormTemplates(actor() as never, "active");
    const where = mockFormTemplate.findAndCountAll.mock.calls[0]![0].where as Record<symbol, unknown[]>;
    expect(where[Op.and]).toHaveLength(2); // superseded-versions literal + the scope filter
    await svc.listFormTemplates(actor([PERMISSIONS.ACL_BYPASS_ADMIN]) as never, "active");
    const adminWhere = mockFormTemplate.findAndCountAll.mock.calls[1]![0].where as Record<symbol, unknown[]>;
    expect(adminWhere[Op.and]).toHaveLength(1);
  });

  it("getFormTemplate answers 404 for a template outside the caller's scope", async () => {
    mockFormTemplate.findOne.mockResolvedValue({ id: "ft-1", tenantId: T, departmentId: DEPT, orgUnitId: null, createdBy: "someone", dataValues: {}, approvedBy: null });
    await expect(svc.getFormTemplate("ft-1", actor() as never)).rejects.toMatchObject({ statusCode: 404, code: "ERR-NOT-FOUND" });
  });

  it("a new version inherits the scope", async () => {
    const source = {
      id: "ft-1", tenantId: T, name: "Leave", version: 1, status: "active", createdBy: "u-1", category: null, basePdfObjectKey: null,
      isLetterhead: false, schemaJson: [[]], sectionsJson: null, layoutMode: "static", instanceApproval: "none", auditPolicy: "never",
      signingPolicy: "none", departmentId: DEPT, orgUnitId: null,
    };
    mockFormTemplate.findOne.mockResolvedValue(source);
    mockFormTemplate.max.mockResolvedValue(1);
    mockFormTemplate.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "ft-2", ...row }));
    await svc.createFormTemplateVersion("ft-1", actor() as never);
    expect(mockFormTemplate.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: DEPT, orgUnitId: null, version: 2, status: "draft" }));
  });
});
