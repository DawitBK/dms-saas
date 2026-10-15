// Regression coverage for the "*By field never resolved to a name" batch fix
// (associations.ts): DocumentCheckout.checkedOutBy -> checkedOutByUser and
// WorkflowInstance.initiatedById -> initiator were real user ids all along,
// but with no belongsTo association nothing could ever turn them into a
// display name. This asserts getDocument()/listDocuments() actually ask
// Sequelize to include those associations, not just that the association
// exists somewhere in associations.ts (which live curl testing already
// verified once — this locks that shape in so a future refactor of
// getDocumentInclude/listDocuments can't silently drop it again).

const mockDocument = { findByPk: jest.fn(), findAll: jest.fn(), count: jest.fn() };
const mockFormInstance = { findOne: jest.fn() };
const mockApprovalChain = { findAll: jest.fn().mockResolvedValue([]) };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: {},
  ApprovalChain: mockApprovalChain,
  ApprovalStep: {},
  ArchiveRecord: {},
  Department: {},
  DocLock: {},
  Document: mockDocument,
  DocumentCheckout: {},
  DocumentDek: {},
  DocumentMetadata: {},
  DocumentLegalHold: {},
  DocumentSequence: {},
  DocumentType: {},
  DocumentVersion: {},
  FolderNode: {},
  FormInstance: mockFormInstance,
  FormTemplate: { findByPk: jest.fn() },
  LegalHold: {},
  OutboxEvent: {},
  PurgePending: {},
  RetentionPolicy: {},
  SignatureRecord: {},
  SignatureRequest: {},
  SignatureRecipient: {},
  AuditStageReview: {},
  sequelize: { query: jest.fn().mockResolvedValue([]) },
  User: {},
  UserDepartment: { findAll: jest.fn().mockResolvedValue([]) },
  WorkflowDefinition: {},
  WorkflowInstance: {},
  WorkflowTask: {},
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
  fetchAndDecrypt: jest.fn(),
  fetchDecryptStream: jest.fn(),
}));

jest.mock("../src/modules/documents/mimeValidation.js", () => ({
  validateUploadedFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/quotaService.js", () => ({
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/indexSidecar.js", () => ({
  writeIndexSidecar: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/documentValidation.js", () => ({
  mandatoryMetadataFields: [],
  sha256: jest.fn().mockReturnValue("plaintext-hash"),
  validateUploadInput: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/shared/documentGuards.js", () => ({
  requireDocumentAccess: jest.fn(),
  requireLegalHoldClear: jest.fn(),
  assertNotTerminalState: jest.fn(),
  assertNotTrashed: jest.fn(),
}));

jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({
  assertStatusPermission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/env.js", () => ({
  config: { MINIO_BUCKET_DOCUMENTS: "documents-bucket" },
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { PERMISSIONS } from "../src/config/permissions.js";

let getDocument: typeof import("../src/modules/documents/documents.service.js").getDocument;
let listDocuments: typeof import("../src/modules/documents/documents.service.js").listDocuments;

beforeAll(async () => {
  const service = await import("../src/modules/documents/documents.service.js");
  getDocument = service.getDocument;
  listDocuments = service.listDocuments;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFormInstance.findOne.mockResolvedValue(null);
  mockApprovalChain.findAll.mockResolvedValue([]);
});

// Recursively find the first include entry whose `as` matches, anywhere in a
// Sequelize include tree (top-level or nested under another include).
function findIncludeByAs(include: unknown, as: string): Record<string, unknown> | null {
  if (!Array.isArray(include)) return null;
  for (const entry of include) {
    const e = entry as Record<string, unknown>;
    if (e.as === as) return e;
    const nested = findIncludeByAs(e.include, as);
    if (nested) return nested;
  }
  return null;
}

const reader = { userId: "u-1", role: "SYSTEM_ADMIN", tenantId: "t1", permissions: [PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.ACL_BYPASS_ADMIN] };

describe("getDocument — who-did-this associations are actually requested", () => {
  it("includes DocumentCheckout.checkedOutByUser nested under the checkout association", async () => {
    mockDocument.findByPk.mockResolvedValue({
      id: "doc-1",
      deletedAt: null,
      get: () => ({ id: "doc-1", documentType: { code: "GEN" } }),
    });

    await getDocument("doc-1", reader);

    const passedInclude = mockDocument.findByPk.mock.calls[0][1].include;
    const checkout = findIncludeByAs(passedInclude, "checkout");
    expect(checkout).toBeTruthy();
    const checkedOutByUser = findIncludeByAs(checkout!.include, "checkedOutByUser");
    expect(checkedOutByUser).toBeTruthy();
  });

  it("includes WorkflowInstance.initiator nested under the workflowInstances association", async () => {
    mockDocument.findByPk.mockResolvedValue({
      id: "doc-1",
      deletedAt: null,
      get: () => ({ id: "doc-1", documentType: { code: "GEN" } }),
    });

    await getDocument("doc-1", reader);

    const passedInclude = mockDocument.findByPk.mock.calls[0][1].include;
    const workflowInstances = findIncludeByAs(passedInclude, "workflowInstances");
    expect(workflowInstances).toBeTruthy();
    const initiator = findIncludeByAs(workflowInstances!.include, "initiator");
    expect(initiator).toBeTruthy();
  });

  it("404s before ever touching the include shape when the document is soft-deleted", async () => {
    mockDocument.findByPk.mockResolvedValue({ id: "doc-1", deletedAt: new Date() });
    await expect(getDocument("doc-1", reader)).rejects.toMatchObject({ code: "ERR-DOCUMENT-NOT-FOUND" });
  });
});

describe("listDocuments — checkout include carries checkedOutByUser", () => {
  it("includes checkedOutByUser under the checkout association on the list query", async () => {
    mockDocument.findAll.mockResolvedValue([]);
    mockDocument.count.mockResolvedValue(0);

    await listDocuments(reader, 0, 50, {});

    const passedInclude = mockDocument.findAll.mock.calls[0][0].include;
    const checkout = findIncludeByAs(passedInclude, "checkout");
    expect(checkout).toBeTruthy();
    const checkedOutByUser = findIncludeByAs(checkout!.include, "checkedOutByUser");
    expect(checkedOutByUser).toBeTruthy();
  });

  it("makes the checkout join required (INNER JOIN) only when explicitly filtering to checked-out documents", async () => {
    mockDocument.findAll.mockResolvedValue([]);
    mockDocument.count.mockResolvedValue(0);

    await listDocuments(reader, 0, 50, { checkedOut: true });

    const passedInclude = mockDocument.findAll.mock.calls[0][0].include;
    const checkout = findIncludeByAs(passedInclude, "checkout");
    expect(checkout!.required).toBe(true);
  });
});
