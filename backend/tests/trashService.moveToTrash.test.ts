export {};

// TEST-1/TEST-2 (audit 2026-09-18): "legal hold blocks trash" was
// one of the 8 scenarios `sprint4.integration.test.ts` claimed to cover —
// its assertion was `expect(error.statusCode).toBe(403)` against a
// hand-written literal object that was never produced by any application
// code. This is the real thing: it drives the actual moveToTrash() service
// function and, critically, does NOT mock requireLegalHoldClear — the real
// guard from shared/documentGuards.ts is what's under test here.

const mockDocument = { findByPk: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: mockDocument,
  OutboxEvent: { create: jest.fn() },
  PurgePending: { create: jest.fn() },
  DocumentVersion: {},
  DocumentDek: {},
  CertificateOfDestruction: {},
  ApprovalChain: { findAll: jest.fn().mockResolvedValue([]) },
  ApprovalStep: { update: jest.fn() },
  AuditStageReview: { destroy: jest.fn() },
  DocLock: { destroy: jest.fn() },
  DocumentCheckout: { destroy: jest.fn() },
  SignatureRequest: { findAll: jest.fn().mockResolvedValue([]) },
  SignatureRecipient: {},
  FormInstance: { findOne: jest.fn().mockResolvedValue(null) },
  User: {},
}));

jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: jest.fn(() => ({ exists: jest.fn().mockResolvedValue(false) })),
}));

// runInTransaction falls back to a real sequelize.transaction() with no
// ambient request transaction (the normal case outside an HTTP request) —
// which would try to open a real DB connection here. Stub it the same way
// legalHold.service.test.ts does: just invoke the callback with a fake
// transaction whose afterCommit() records the callback without running it
// (matching real semantics — it only fires once the transaction truly
// commits, which never happens synchronously in a unit test either way).
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: jest.fn((fn: (t: unknown) => unknown) => fn({ afterCommit: jest.fn() })),
  runInSavepoint: jest.fn((fn: (t: unknown) => unknown) => fn({})),
}));

// Deliberately real: shared/documentGuards.js is NOT mocked. requireDocumentAccess
// and assertNotTerminalState run for real too — the test document below is built
// to pass both naturally rather than stub them away.

jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({
  assertStatusPermission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/quotaService.js", () => ({
  decrementStorageUsed: jest.fn().mockResolvedValue(undefined),
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let moveToTrash: typeof import("../src/modules/documents/trashService.js").moveToTrash;

beforeAll(async () => {
  const service = await import("../src/modules/documents/trashService.js");
  moveToTrash = service.moveToTrash;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const USER = { userId: "user-1", role: "RECORDS_OFFICER", tenantId: "tenant-a" };

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    tenantId: "tenant-a",
    ownerId: "user-1",
    departmentId: "dept-1",
    status: "ACTIVE",
    isOnLegalHold: false,
    securityClassification: "INTERNAL",
    deletedAt: null,
    versions: [],
    update: jest.fn(),
    ...overrides,
  };
}

describe("trashService.moveToTrash — legal hold enforcement (COMP-1/TEST-1 sibling coverage)", () => {
  it("blocks trashing a document that is under legal hold", async () => {
    mockDocument.findByPk.mockResolvedValue(makeDocument({ isOnLegalHold: true }));

    await expect(moveToTrash("doc-1", USER)).rejects.toMatchObject({
      statusCode: 403,
      code: "ERR-HOLD-MODIFICATION-BLOCKED",
    });
  });

  it("does not touch the document row at all once the legal-hold guard rejects it", async () => {
    const doc = makeDocument({ isOnLegalHold: true });
    mockDocument.findByPk.mockResolvedValue(doc);

    await expect(moveToTrash("doc-1", USER)).rejects.toBeDefined();

    expect(doc.update).not.toHaveBeenCalled();
  });

  it("allows trashing an otherwise-identical document that is NOT under legal hold", async () => {
    mockDocument.findByPk.mockResolvedValue(makeDocument({ isOnLegalHold: false }));

    const result = await moveToTrash("doc-1", USER);

    expect(result).toMatchObject({ success: true });
  });

  it("rejects a document that is already in the trash", async () => {
    mockDocument.findByPk.mockResolvedValue(makeDocument({ status: "TRASHED" }));

    await expect(moveToTrash("doc-1", USER)).rejects.toMatchObject({
      statusCode: 400,
      code: "ERR-ALREADY-TRASHED",
    });
  });

  it("404s for a document that doesn't exist", async () => {
    mockDocument.findByPk.mockResolvedValue(null);

    await expect(moveToTrash("doc-missing", USER)).rejects.toMatchObject({
      statusCode: 404,
      code: "ERR-DOCUMENT-NOT-FOUND",
    });
  });
});
