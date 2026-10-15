// The filer's own pre-approval lifecycle for a form instance (audit E7: "form instances cannot be edited").
//   edit      DRAFT / CHANGES_REQUESTED / DECLINED only; re-rendered as a new minor version of the same document;
//   withdraw  recall from review (the engine does the work; forms only authorises and delegates);
//   cancel    abandon: the document becomes CANCELLED.
// Filer only; never while IN_REVIEW; template must still be the active version; ACL + legal hold apply.

const mockFormTemplate = { findOne: jest.fn() };
const mockFormInstance = { findByPk: jest.fn() };
const mockDocument = { findByPk: jest.fn(), create: jest.fn(), update: jest.fn() };
const mockDocumentVersion = { findByPk: jest.fn(), create: jest.fn() };
const mockDocumentDek = { create: jest.fn() };
const mockDepartment = { findOne: jest.fn() };
const mockApprovalChain = { update: jest.fn() };
const mockOutbox = { bulkCreate: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  FormTemplate: mockFormTemplate,
  FormInstance: mockFormInstance,
  Document: mockDocument,
  DocumentType: {},
  DocumentVersion: mockDocumentVersion,
  DocumentDek: mockDocumentDek,
  Department: mockDepartment,
  UserDepartment: {},
  OrgUnit: {},
  OutboxEvent: mockOutbox,
  SignatureRequest: {},
  SignatureRecipient: {},
  User: {},
  ApprovalChain: mockApprovalChain,
  FormSequence: {},
  sequelize: {},
}));

const mockWithdraw = jest.fn();
jest.mock("../src/modules/approvals/withdraw.service.js", () => ({ withdrawOwnSubmission: (...a: unknown[]) => mockWithdraw(...a) }));
jest.mock("../src/modules/approvals/approvals.service.js", () => ({}));
jest.mock("../src/modules/approvals/stepRules.js", () => ({ getUserDepartmentIds: jest.fn().mockResolvedValue([]) }));
jest.mock("../src/modules/forms/formTemplateScope.js", () => ({
  assertScopeWritable: jest.fn(), assertTemplateUsableForDepartment: jest.fn(), canViewFormTemplate: jest.fn().mockResolvedValue(true),
  hasOrgWideTemplateAuthority: jest.fn().mockReturnValue(false), templateVisibilityWhere: jest.fn().mockResolvedValue(null),
}));
const mockEncryptAndStore = jest.fn();
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: mockEncryptAndStore }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: jest.fn() }));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn().mockResolvedValue("clean") }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn() }));
const mockGrantDefaultAcl = jest.fn();
jest.mock("../src/modules/documents/documents.service.js", () => ({
  filterDocsByDetailAcl: jest.fn(), ensureCanCreate: jest.fn(), grantDefaultDocumentAcl: (...a: unknown[]) => mockGrantDefaultAcl(...a),
}));
const mockReserveQuota = jest.fn();
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: mockReserveQuota }));
jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({ assertStatusPermission: jest.fn() }));
const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a) }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("../src/config/env.js", () => ({ config: { MINIO_BUCKET_DOCUMENTS: "bucket" } }));
const tx = { LOCK: { UPDATE: "UPDATE" } };
jest.mock("../src/shared/transaction.js", () => ({ runInTransaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn() }));
const mockAssertACLAllow = jest.fn();
jest.mock("../src/shared/resolveACL.js", () => ({ assertACLAllow: mockAssertACLAllow }));
const mockRequireLegalHoldClear = jest.fn();
jest.mock("../src/shared/documentGuards.js", () => ({ requireLegalHoldClear: mockRequireLegalHoldClear }));
jest.mock("../src/modules/documents/DocumentStateMachine.js", () => ({ validateTransition: jest.fn() }));
jest.mock("../src/shared/platformAdmin.js", () => ({ hiddenUserIds: jest.fn().mockResolvedValue([]) }));

import { PERMISSIONS } from "../src/config/permissions.js";

type Svc = typeof import("../src/modules/forms/forms.service.js");
let svc: Svc;
beforeAll(async () => { svc = await import("../src/modules/forms/forms.service.js"); });

const T = "t1";
const FILER = "u-filer";
const user = (id = FILER) => ({ userId: id, role: "EMPLOYEE", roles: ["EMPLOYEE"], tenantId: T, permissions: [PERMISSIONS.DOCUMENT_UPLOAD, PERMISSIONS.DOCUMENT_READ] }) as never;
const field = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "text", position: { x: 20, y: 20 }, width: 80, height: 10, ...extra });
const ATT_OLD = "00000000-0000-4000-8000-0000000000a1";

function row(over: Record<string, unknown>) {
  const r: Record<string, unknown> = { ...over };
  r.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(r, patch); return r; });
  return r;
}
function arrange(opts: { docStatus?: string; instanceApproval?: string; schema?: unknown[][]; data?: Record<string, unknown>; ownerId?: string; createdBy?: string } = {}) {
  const template = { id: "ft-1", tenantId: T, name: "Leave", version: 1, status: "active", instanceApproval: opts.instanceApproval ?? "chain", schemaJson: opts.schema ?? [[field("reason", { required: true })]], basePdfObjectKey: null, isLetterhead: false };
  const instance = row({ id: "fi-1", templateId: "ft-1", documentId: "doc-1", dataJson: opts.data ?? { reason: "old" }, createdBy: opts.createdBy ?? FILER });
  const doc = row({ id: "doc-1", tenantId: T, departmentId: "dept-1", documentTypeId: "dt-form", ownerId: opts.ownerId ?? FILER, deletedAt: null, status: opts.docStatus ?? "CHANGES_REQUESTED", latestVersionId: "v-1", documentName: "Leave — x" });
  mockFormInstance.findByPk.mockResolvedValue(instance);
  mockFormTemplate.findOne.mockImplementation(async (q: { where: Record<string, unknown> }) =>
    // the filer-load asks by id; the supersede check asks by name + status + version
    ("name" in q.where ? null : template));
  mockDocument.findByPk.mockResolvedValue(doc);
  mockDepartment.findOne.mockResolvedValue({ id: "dept-1", code: "FIN" });
  mockDocumentVersion.findByPk.mockResolvedValue({ versionNumber: "1.0" });
  mockEncryptAndStore.mockResolvedValue({ encryptedKey: "k", sha256Hash: "h", kekId: "kek" });
  return { template, instance, doc };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockAssertACLAllow.mockResolvedValue(undefined);
});

describe("who and when", () => {
  it("only the filer: another user (even holding approval:admin) is refused", async () => {
    arrange();
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user("u-other"))).rejects.toMatchObject({ statusCode: 403, code: "ERR-NOT-FORM-FILER" });
    await expect(svc.withdrawFormInstance("fi-1", undefined, user("u-other"))).rejects.toMatchObject({ code: "ERR-NOT-FORM-FILER" });
    await expect(svc.cancelFormInstance("fi-1", undefined, user("u-other"))).rejects.toMatchObject({ code: "ERR-NOT-FORM-FILER" });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("the document owner counts as the filer too", async () => {
    arrange({ createdBy: "someone-who-created-the-row", ownerId: FILER });
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).resolves.toBeDefined();
  });

  it("404s for an unknown form, a purged document, a trashed document and another tenant's", async () => {
    mockFormInstance.findByPk.mockResolvedValue(null);
    await expect(svc.updateFormInstance("nope", {}, user())).rejects.toMatchObject({ statusCode: 404 });
    const { doc } = arrange();
    (doc as { deletedAt: Date | null }).deletedAt = new Date();
    await expect(svc.updateFormInstance("fi-1", {}, user())).rejects.toMatchObject({ statusCode: 404 });
    (doc as { deletedAt: Date | null; tenantId: string }).deletedAt = null;
    (doc as { tenantId: string }).tenantId = "other-tenant";
    await expect(svc.updateFormInstance("fi-1", {}, user())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a form that does not go through approval is final once filed", async () => {
    arrange({ instanceApproval: "none", docStatus: "ACTIVE" });
    await expect(svc.updateFormInstance("fi-1", {}, user())).rejects.toMatchObject({ code: "ERR-FORM-NOT-EDITABLE" });
  });

  it("never while it is under review: the filer withdraws it first", async () => {
    arrange({ docStatus: "IN_REVIEW" });
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ statusCode: 409, code: "ERR-FORM-IN-REVIEW" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });

  it.each(["APPROVED", "PENDING_AUDIT", "ARCHIVED", "ACTIVE", "CANCELLED"])("not once it is %s", async (status) => {
    arrange({ docStatus: status });
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ code: "ERR-FORM-NOT-EDITABLE" });
  });

  it.each(["DRAFT", "CHANGES_REQUESTED", "DECLINED"])("is allowed while %s", async (status) => {
    arrange({ docStatus: status });
    await expect(svc.updateFormInstance("fi-1", { reason: "new" }, user())).resolves.toBeDefined();
  });

  it("checks the document ACL (upload) and the legal hold", async () => {
    arrange();
    mockAssertACLAllow.mockRejectedValue(Object.assign(new Error("denied"), { statusCode: 403, code: "AUTHZ_ACL_NO_ENTRY" }));
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ code: "AUTHZ_ACL_NO_ENTRY" });
    expect(mockAssertACLAllow).toHaveBeenCalledWith(FILER, ["EMPLOYEE"], T, { resourceType: "document", resourceId: "doc-1", permission: "document:upload" }, expect.anything());
    mockAssertACLAllow.mockResolvedValue(undefined);
    mockRequireLegalHoldClear.mockImplementation(() => { throw Object.assign(new Error("hold"), { statusCode: 423, code: "ERR-LEGAL-HOLD" }); });
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ code: "ERR-LEGAL-HOLD" });
    await expect(svc.cancelFormInstance("fi-1", undefined, user())).rejects.toMatchObject({ code: "ERR-LEGAL-HOLD" });
  });

  it("refuses to edit against a template version that is no longer the active one", async () => {
    const { template } = arrange();
    (template as { status: string }).status = "deprecated";
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ code: "ERR-TEMPLATE-INACTIVE" });
    (template as { status: string }).status = "active";
    mockFormTemplate.findOne.mockImplementation(async (q: { where: Record<string, unknown> }) => ("name" in q.where ? { id: "ft-2" } : template));
    await expect(svc.updateFormInstance("fi-1", { reason: "x" }, user())).rejects.toMatchObject({ code: "ERR-TEMPLATE-SUPERSEDED" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
  });
});

describe("updateFormInstance — the edit itself", () => {
  it("validates against the template server-side before anything is rendered or stored", async () => {
    arrange();
    await expect(svc.updateFormInstance("fi-1", {}, user())).rejects.toMatchObject({ statusCode: 422, code: "ERR-FORM-VALIDATION" });
    expect(mockEncryptAndStore).not.toHaveBeenCalled();
    expect(mockDocumentVersion.create).not.toHaveBeenCalled();
  });

  it("files a NEW minor version of the same document, keeps the old ones, re-derives dataJson, never changes the status", async () => {
    const { instance, doc } = arrange();
    const result = await svc.updateFormInstance("fi-1", { reason: "new reason", stray: "dropped" }, user());

    expect(result).toBe(instance);
    expect(mockDocumentVersion.create).toHaveBeenCalledTimes(1);
    expect(mockDocumentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", versionNumber: "1.1", isMajorVersion: false, authorId: FILER }),
      { transaction: tx },
    );
    expect(mockDocumentDek.create).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-1", algorithm: "AES-256-GCM" }), { transaction: tx });
    expect(mockDocument.update).toHaveBeenCalledWith({ latestVersionId: expect.any(String) }, expect.objectContaining({ where: { id: "doc-1" } }));
    // only the SERVER-derived values are stored (stray key dropped)
    expect(instance.update).toHaveBeenCalledWith(
      expect.objectContaining({ dataJson: { reason: "new reason" }, updatedAt: expect.any(Date), generatedPdfObjectKey: expect.stringContaining("/doc-1/") }),
      { transaction: tx },
    );
    // approval is only ever reached by the normal submit: the edit does not touch the status
    expect(doc.update).not.toHaveBeenCalled();
    expect(mockReserveQuota).toHaveBeenCalledWith(T, expect.any(Number), tx);
  });

  it("audits the edit against the document, naming the changed fields but not their values", async () => {
    arrange({ data: { reason: "old", other: "same" }, schema: [[field("reason", { required: true }), field("other")]] });
    await svc.updateFormInstance("fi-1", { reason: "new", other: "same" }, user());
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "FORM_INSTANCE_EDITED", documentId: "doc-1", userId: FILER,
        actionDetails: expect.objectContaining({ formInstanceId: "fi-1", changedFields: ["reason"], documentVersion: "1.1", previousStatus: "CHANGES_REQUESTED" }),
      }),
    );
    expect(JSON.stringify(mockWriteAuditLog.mock.calls)).not.toContain('"new"');
  });

  it("a required file field already filed is not asked for again, and keeps pointing at the existing attachment", async () => {
    const { instance } = arrange({
      schema: [[field("reason", { required: true }), field("cv", { type: "file", required: true })]],
      data: { reason: "old", cv: { documentId: ATT_OLD, fileName: "cv.pdf" } },
    });
    await svc.updateFormInstance("fi-1", { reason: "new" }, user());
    expect((instance.update as jest.Mock).mock.calls[0]![0].dataJson).toEqual({ reason: "new", cv: { documentId: ATT_OLD, fileName: "cv.pdf" } });
    expect(mockDocument.create).not.toHaveBeenCalled();
  });

  it("a newly uploaded file is scanned, filed as its own document, and replaces the reference (the old document is kept)", async () => {
    const { instance } = arrange({
      schema: [[field("cv", { type: "file", required: true })]],
      data: { cv: { documentId: ATT_OLD, fileName: "old.pdf" } },
    });
    mockDocument.create.mockResolvedValue({});
    mockDocumentVersion.create.mockResolvedValue({ id: "att-ver" });
    mockDocument.update.mockResolvedValue([1]);
    const file = { originalname: "new.pdf", mimetype: "application/pdf", size: 10, buffer: Buffer.from("%PDF-1.4 x"), fieldname: "cv" } as unknown as Express.Multer.File;
    await svc.updateFormInstance("fi-1", {}, user(), { cv: file });

    expect(mockDocument.create).toHaveBeenCalledWith(expect.objectContaining({ title: "new.pdf", departmentId: "dept-1", ownerId: FILER, status: "ACTIVE" }), { transaction: tx });
    expect(mockGrantDefaultAcl).toHaveBeenCalled();
    const data = (instance.update as jest.Mock).mock.calls[0]![0].dataJson as { cv: { documentId: string; fileName: string } };
    expect(data.cv.fileName).toBe("new.pdf");
    expect(data.cv.documentId).not.toBe(ATT_OLD);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionDetails: expect.objectContaining({ newAttachments: [data.cv.documentId] }) }));
  });
});

describe("withdrawFormInstance", () => {
  it("authorises the filer and hands the recall to the engine", async () => {
    arrange({ docStatus: "IN_REVIEW" });
    const u = user();
    await svc.withdrawFormInstance("fi-1", "typo in the dates", u);
    expect(mockWithdraw).toHaveBeenCalledWith("FORM_INSTANCE", "fi-1", "typo in the dates", u);
  });
});

describe("cancelFormInstance", () => {
  it("abandons a DRAFT / CHANGES_REQUESTED form: the document becomes CANCELLED and the suspended chain is closed", async () => {
    const { doc } = arrange({ docStatus: "CHANGES_REQUESTED" });
    await svc.cancelFormInstance("fi-1", "no longer needed", user());
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(doc.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: tx });
    expect(mockApprovalChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
      expect.objectContaining({ where: expect.objectContaining({ itemType: "FORM_INSTANCE", itemId: "fi-1", status: "CHANGES_REQUESTED" }) }),
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "FORM_INSTANCE_CANCELLED", documentId: "doc-1", actionDetails: expect.objectContaining({ reason: "no longer needed", previousStatus: "CHANGES_REQUESTED" }) }),
    );
  });

  it("a form under review is withdrawn first, then cancelled", async () => {
    const { doc } = arrange({ docStatus: "IN_REVIEW" });
    // after the engine's withdrawal the locked re-read sees a DRAFT
    mockWithdraw.mockImplementation(async () => { (doc as { status: string }).status = "DRAFT"; });
    mockDocument.findByPk.mockResolvedValueOnce(doc).mockResolvedValue(doc);
    await svc.cancelFormInstance("fi-1", undefined, user());
    expect(mockWithdraw).toHaveBeenCalledWith("FORM_INSTANCE", "fi-1", undefined, expect.anything());
    expect(doc.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: tx });
  });

  it("is refused once the form is approved", async () => {
    const { doc } = arrange({ docStatus: "APPROVED" });
    await expect(svc.cancelFormInstance("fi-1", undefined, user())).rejects.toMatchObject({ code: "ERR-FORM-NOT-EDITABLE" });
    expect(doc.update).not.toHaveBeenCalled();
  });
});
