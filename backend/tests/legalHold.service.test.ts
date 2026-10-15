export {};

// TEST-1 (Documentations/audits/AUDIT-FINDINGS-2026-09-18.md): modules/legal-hold/ had zero test
// coverage of any kind, automated or manual — this is the feature whose
// entire purpose is guaranteeing a document CANNOT be destroyed once placed
// under hold, which makes it one of the two most legally consequential
// features in a records-management system (the other being retention,
// covered in retentionEngine.test.ts).
//
// Mocks the DB layer (same pattern as trashService.certificate.test.ts).

const mockLegalHold = { create: jest.fn(), findOne: jest.fn() };
const mockDocumentLegalHold = { findAll: jest.fn(), count: jest.fn(), create: jest.fn() };
const mockDocument = { findAll: jest.fn(), findByPk: jest.fn(), update: jest.fn() };
const mockOutboxEvent = { create: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: mockDocument,
  DocumentLegalHold: mockDocumentLegalHold,
  LegalHold: mockLegalHold,
  OutboxEvent: mockOutboxEvent,
  User: {},
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/retention/retentionEngine.js", () => ({
  applyRetention: jest.fn().mockResolvedValue(undefined),
}));

// runInTransaction just invokes the callback with a stub transaction — the
// real transaction machinery isn't what this test is verifying.
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: jest.fn((fn: (t: unknown) => unknown) => fn({})),
}));

let createLegalHold: typeof import("../src/modules/legal-hold/legal-hold.service.js").createLegalHold;
let applyHoldToDocuments: typeof import("../src/modules/legal-hold/legal-hold.service.js").applyHoldToDocuments;
let releaseLegalHold: typeof import("../src/modules/legal-hold/legal-hold.service.js").releaseLegalHold;

beforeAll(async () => {
  const service = await import("../src/modules/legal-hold/legal-hold.service.js");
  createLegalHold = service.createLegalHold;
  applyHoldToDocuments = service.applyHoldToDocuments;
  releaseLegalHold = service.releaseLegalHold;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const USER = { userId: "user-1", role: "RECORDS_OFFICER", tenantId: "tenant-a" };

describe("legal-hold.service.createLegalHold", () => {
  it("rejects a description under 20 characters", async () => {
    await expect(
      createLegalHold(USER, { caseReference: "CASE-1", description: "too short", custodianName: "X", legalBasis: "a".repeat(20) }),
    ).rejects.toMatchObject({ code: "ERR-LEGAL-HOLD-VALIDATION" });
    expect(mockLegalHold.create).not.toHaveBeenCalled();
  });

  it("rejects a legal basis under 20 characters", async () => {
    await expect(
      createLegalHold(USER, { caseReference: "CASE-1", description: "a".repeat(20), custodianName: "X", legalBasis: "too short" }),
    ).rejects.toMatchObject({ code: "ERR-LEGAL-HOLD-VALIDATION" });
  });

  it("rejects a case reference with disallowed characters", async () => {
    await expect(
      createLegalHold(USER, {
        caseReference: "CASE #1 !!",
        description: "a".repeat(20),
        custodianName: "X",
        legalBasis: "a".repeat(20),
      }),
    ).rejects.toMatchObject({ code: "ERR-LEGAL-HOLD-VALIDATION" });
  });

  it("creates the hold and applies it to the given documents in one call", async () => {
    mockLegalHold.create.mockResolvedValue({ id: "hold-1", caseReference: "CASE-1" });
    mockLegalHold.findOne.mockResolvedValue({ id: "hold-1", status: "ACTIVE", caseReference: "CASE-1", custodianName: "X" });
    mockDocument.findAll.mockResolvedValue([{ id: "doc-1", tenantId: "tenant-a", departmentId: "dept-1", documentName: "N" }]);
    mockDocumentLegalHold.findAll.mockResolvedValue([]);

    const hold = await createLegalHold(USER, {
      caseReference: "CASE-1",
      description: "a".repeat(20),
      custodianName: "X",
      legalBasis: "a".repeat(20),
      documentIds: ["doc-1"],
    });

    expect(hold).toEqual({ id: "hold-1", caseReference: "CASE-1" });
    expect(mockDocument.update).toHaveBeenCalledWith({ isOnLegalHold: true }, expect.objectContaining({ where: { id: "doc-1" } }));
  });
});

describe("legal-hold.service.applyHoldToDocuments", () => {
  it("throws ERR-HOLD-NOT-FOUND for a hold that doesn't belong to this tenant", async () => {
    mockLegalHold.findOne.mockResolvedValue(null);
    await expect(applyHoldToDocuments("hold-x", ["doc-1"], "user-1", "tenant-a")).rejects.toMatchObject({
      statusCode: 404,
      code: "ERR-HOLD-NOT-FOUND",
    });
  });

  it("throws ERR-HOLD-INACTIVE for a released hold", async () => {
    mockLegalHold.findOne.mockResolvedValue({ id: "hold-1", status: "RELEASED" });
    await expect(applyHoldToDocuments("hold-1", ["doc-1"], "user-1", "tenant-a")).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-HOLD-INACTIVE",
    });
  });

  it("silently drops a documentId that does not belong to this tenant, rather than placing the hold on it", async () => {
    mockLegalHold.findOne.mockResolvedValue({ id: "hold-1", status: "ACTIVE", caseReference: "CASE-1" });
    // Document.findAll is itself tenant-scoped (where: { id: documentIds, tenantId }) —
    // a cross-tenant id simply never comes back from this query.
    mockDocument.findAll.mockResolvedValue([]);
    mockDocumentLegalHold.findAll.mockResolvedValue([]);

    const result = await applyHoldToDocuments("hold-1", ["other-tenants-doc"], "user-1", "tenant-a");

    expect(result).toEqual({ success: true });
    expect(mockDocument.update).not.toHaveBeenCalled();
  });

  it("does not re-apply (or duplicate an audit/outbox event for) a document already actively held", async () => {
    mockLegalHold.findOne.mockResolvedValue({ id: "hold-1", status: "ACTIVE", caseReference: "CASE-1" });
    mockDocument.findAll.mockResolvedValue([{ id: "doc-1", tenantId: "tenant-a" }]);
    mockDocumentLegalHold.findAll.mockResolvedValue([{ documentId: "doc-1", removedAt: null }]);

    await applyHoldToDocuments("hold-1", ["doc-1"], "user-1", "tenant-a");

    expect(mockDocument.update).not.toHaveBeenCalled();
    expect(mockOutboxEvent.create).not.toHaveBeenCalled();
  });
});

describe("legal-hold.service.releaseLegalHold — the multi-hold safety property", () => {
  const holdFindOne = () => mockLegalHold.findOne.mockResolvedValue({
    id: "hold-1",
    status: "ACTIVE",
    caseReference: "CASE-1",
    update: jest.fn(),
  });

  it("clears isOnLegalHold when this was the document's only active hold", async () => {
    holdFindOne();
    mockDocumentLegalHold.findAll.mockResolvedValue([{ documentId: "doc-1", removedAt: null, update: jest.fn() }]);
    mockDocumentLegalHold.count.mockResolvedValue(0); // no OTHER active hold on this document
    mockDocument.findByPk.mockResolvedValue({ id: "doc-1", tenantId: "tenant-a", departmentId: "dept-1" });

    await releaseLegalHold("hold-1", "user-1", "RECORDS_OFFICER", "CLOSURE-1", "case closed", "tenant-a");

    expect(mockDocument.update).toHaveBeenCalledWith({ isOnLegalHold: false }, expect.objectContaining({ where: { id: "doc-1" } }));
  });

  it("does NOT clear isOnLegalHold when a DIFFERENT active hold still covers this document — the case this feature exists for", async () => {
    holdFindOne();
    mockDocumentLegalHold.findAll.mockResolvedValue([{ documentId: "doc-1", removedAt: null, update: jest.fn() }]);
    // A second, unrelated hold (e.g. a different matter) still actively covers this document.
    mockDocumentLegalHold.count.mockResolvedValue(1);

    await releaseLegalHold("hold-1", "user-1", "RECORDS_OFFICER", "CLOSURE-1", "case closed", "tenant-a");

    expect(mockDocument.update).not.toHaveBeenCalledWith({ isOnLegalHold: false }, expect.anything());
  });

  it("throws ERR-HOLD-NOT-FOUND for a hold outside this tenant", async () => {
    mockLegalHold.findOne.mockResolvedValue(null);
    await expect(
      releaseLegalHold("hold-x", "user-1", "RECORDS_OFFICER", "CLOSURE-1", "reason", "tenant-a"),
    ).rejects.toMatchObject({ statusCode: 404, code: "ERR-HOLD-NOT-FOUND" });
  });

  it("throws ERR-HOLD-INACTIVE when releasing an already-released hold", async () => {
    mockLegalHold.findOne.mockResolvedValue({ id: "hold-1", status: "RELEASED" });
    await expect(
      releaseLegalHold("hold-1", "user-1", "RECORDS_OFFICER", "CLOSURE-1", "reason", "tenant-a"),
    ).rejects.toMatchObject({ statusCode: 409, code: "ERR-HOLD-INACTIVE" });
  });
});
