// Regression: acl_entries is polymorphic (resource_type / resource_id, no foreign key), so deleting a document
// does not cascade to its access rows. executePurge and deleteDraftPermanently used to leave every grant on a
// destroyed document behind for good. Both must now remove them, inside the same transaction and before the
// document row itself.

const calls: string[] = [];
const rec = (name: string) => jest.fn(async (..._args: unknown[]) => { calls.push(name); return 1; });

const mockAclEntry = { destroy: rec("AclEntry.destroy") };
const mockDocument = { findByPk: jest.fn(), destroy: rec("Document.destroy") };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: mockDocument,
  OutboxEvent: { create: jest.fn().mockResolvedValue({}) },
  PurgePending: { destroy: jest.fn().mockResolvedValue(0) },
  DocumentVersion: { destroy: jest.fn().mockResolvedValue(0) },
  DocumentDek: { destroy: jest.fn().mockResolvedValue(0) },
  CertificateOfDestruction: { create: jest.fn().mockResolvedValue({}) },
  ApprovalChain: { destroy: jest.fn().mockResolvedValue(0) },
  ApprovalStep: {},
  AuditStageReview: { destroy: jest.fn().mockResolvedValue(0) },
  AclEntry: mockAclEntry,
  DocLock: { destroy: jest.fn().mockResolvedValue(0) },
  DocumentCheckout: { destroy: jest.fn().mockResolvedValue(0) },
  SignatureRequest: {},
  SignatureRecipient: {},
  FormInstance: { findOne: jest.fn().mockResolvedValue(null) },
  User: {},
}));

const tx = { afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
}));

jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: jest.fn(() => ({ exists: jest.fn().mockResolvedValue(false), delete: jest.fn() })),
}));
jest.mock("../src/shared/documentGuards.js", () => ({
  requireDocumentAccess: jest.fn(),
  requireLegalHoldClear: jest.fn(),
  assertNotTerminalState: jest.fn(),
}));
jest.mock("../src/modules/documents/statusPermissions.service.js", () => ({ assertStatusPermission: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/documents/quotaService.js", () => ({
  decrementStorageUsed: jest.fn().mockResolvedValue(undefined),
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

let executePurge: typeof import("../src/modules/documents/trashService.js").executePurge;
let deleteDraftPermanently: typeof import("../src/modules/documents/trashService.js").deleteDraftPermanently;

beforeAll(async () => {
  const service = await import("../src/modules/documents/trashService.js");
  executePurge = service.executePurge;
  deleteDraftPermanently = service.deleteDraftPermanently;
});

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});

const doc = (over: Record<string, unknown> = {}) => ({ id: "doc-1", tenantId: "tenant-a", ownerId: "u-1", status: "DRAFT", isOnLegalHold: false, documentName: "x", versions: [], ...over });

describe("deleting a document removes its access rows", () => {
  it("executePurge deletes the document's acl_entries, scoped to its tenant, before the document row", async () => {
    mockDocument.findByPk.mockResolvedValue(doc({ status: "PURGE_PENDING" }));
    await executePurge("doc-1", "approver-1");
    expect(mockAclEntry.destroy).toHaveBeenCalledWith({ where: { tenantId: "tenant-a", resourceType: "document", resourceId: "doc-1" }, transaction: tx });
    expect(calls.indexOf("AclEntry.destroy")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("AclEntry.destroy")).toBeLessThan(calls.indexOf("Document.destroy"));
  });

  it("deleteDraftPermanently does the same", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    await deleteDraftPermanently("doc-1", { userId: "u-1", role: "EMPLOYEE", tenantId: "tenant-a" } as never);
    expect(mockAclEntry.destroy).toHaveBeenCalledWith({ where: { tenantId: "tenant-a", resourceType: "document", resourceId: "doc-1" }, transaction: tx });
    expect(calls.indexOf("AclEntry.destroy")).toBeLessThan(calls.indexOf("Document.destroy"));
  });

  it("a document under legal hold is refused before anything is deleted", async () => {
    mockDocument.findByPk.mockResolvedValue(doc({ isOnLegalHold: true }));
    await expect(executePurge("doc-1", null)).rejects.toMatchObject({ code: "ERR-HOLD-ACTIVE" });
    expect(mockAclEntry.destroy).not.toHaveBeenCalled();
    expect(mockDocument.destroy).not.toHaveBeenCalled();
  });
});
