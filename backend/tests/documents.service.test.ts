const mockDepartment = { findOne: jest.fn() };
const mockDocumentType = { findOne: jest.fn() };
const mockRetentionPolicy = { findOne: jest.fn() };
const mockFolderNode = { findOne: jest.fn() };
const mockDocumentVersion = { findOne: jest.fn(), create: jest.fn() };
const mockDocumentSequence = { findOne: jest.fn() };
const mockDocument = { create: jest.fn(), findByPk: jest.fn() };
const mockRetentionApplication = { findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() };
const mockAclEntry = { bulkCreate: jest.fn() };
const mockUserDepartment = { findAll: jest.fn().mockResolvedValue([]) };
const mockDocumentMetadata = { create: jest.fn() };
const mockDocumentDek = { create: jest.fn() };
const mockOutboxEvent = { bulkCreate: jest.fn() };
const mockSequelize = {
  transaction: jest.fn(async (_options: unknown, callback: (tx: object) => Promise<unknown>) => {
    // nextDocumentName (documents.service.ts) locks the sequence row via
    // `tx.LOCK.UPDATE` — real Sequelize transactions expose this (it's just
    // the string constant Sequelize passes through to `FOR UPDATE`), so the
    // fake transaction needs the same shape or the lock lookup throws before
    // DocumentSequence.findOne is ever called.
    return callback({ LOCK: { UPDATE: 'UPDATE' } });
  }),
  // SELECT-type queries (e.g. nextDocumentName's max-existing-sequence
  // alignment probe) destructure the result, so resolve to an empty row set.
  query: jest.fn().mockResolvedValue([]),
};

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  DocumentType: mockDocumentType,
  RetentionPolicy: mockRetentionPolicy,
  FolderNode: mockFolderNode,
  DocumentVersion: mockDocumentVersion,
  DocumentSequence: mockDocumentSequence,
  Document: mockDocument,
  RetentionApplication: mockRetentionApplication,
  AclEntry: mockAclEntry,
  UserDepartment: mockUserDepartment,
  DocumentMetadata: mockDocumentMetadata,
  DocumentDek: mockDocumentDek,
  OutboxEvent: mockOutboxEvent,
  sequelize: mockSequelize,
}));

// ensureCanCreate's department-membership check goes through userDeptCache.ts's
// cache-then-DB helper, not UserDepartment.findAll directly (that model mock
// above is still exercised separately, by the ACL-fanout code inside
// createAclGrantsForDepartment) — mock it here too, or a cache miss falls
// through to loadUserDepartmentIds's REAL raw sequelize.query and tries a
// live DB connection.
const mockLoadUserDepartmentIds = jest.fn().mockResolvedValue([]);
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: (...args: unknown[]) => mockLoadUserDepartmentIds(...args),
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn().mockResolvedValue({
    encryptedKey: "encrypted-key",
    sha256Hash: "encrypted-hash",
    kekId: "kek-id",
  }),
}));

jest.mock("../src/modules/documents/mimeValidation.js", () => ({
  validateUploadedFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/quotaService.js", () => ({
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/indexSidecar.js", () => ({
  writeIndexSidecar: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/documentValidation.js", () => ({
  mandatoryMetadataFields: [],
  sha256: jest.fn().mockReturnValue("plaintext-hash"),
  validateUploadInput: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/env.js", () => ({
  config: {
    MINIO_BUCKET_DOCUMENTS: "documents-bucket",
  },
}));

jest.mock("../src/core/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

let createDocument: typeof import("../src/modules/documents/documents.service.js").createDocument;

beforeAll(async () => {
  const service = await import("../src/modules/documents/documents.service.js");
  createDocument = service.createDocument;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDepartment.findOne.mockResolvedValue({ id: "dept-1" });
  mockDocumentType.findOne.mockResolvedValue({ id: "doctype-1", requiresSignature: false });
  mockRetentionPolicy.findOne.mockResolvedValue({ id: "retention-1" });
  mockFolderNode.findOne.mockResolvedValue(null);
  mockDocumentVersion.findOne.mockResolvedValue(null);
  mockDocumentSequence.findOne.mockResolvedValue({ lastSeq: 1, update: jest.fn().mockResolvedValue(undefined) });
  mockDocument.create.mockResolvedValue(undefined);
  mockDocumentMetadata.create.mockResolvedValue(undefined);
  mockDocumentDek.create.mockResolvedValue(undefined);
  mockOutboxEvent.bulkCreate.mockResolvedValue(undefined);
  mockRetentionApplication.findOne.mockResolvedValue(null);
  mockRetentionApplication.create.mockResolvedValue(undefined);
  mockRetentionApplication.destroy.mockResolvedValue(0);
  mockAclEntry.bulkCreate.mockResolvedValue([]);
  mockDocument.findByPk.mockResolvedValue({
    id: "doc-1",
    disposalEligibleDate: null,
    documentDate: new Date("2026-06-25T00:00:00.000Z"),
    retentionTriggerDate: new Date("2026-06-25T00:00:00.000Z"),
    createdAt: new Date("2026-06-25T00:00:00.000Z"),
    retentionClass: "RET-CORP-5Y",
    update: jest.fn().mockResolvedValue(undefined),
    get: () => ({
      id: "doc-1",
      documentDate: new Date("2026-06-25T00:00:00.000Z"),
      documentName: "DEPT-DOCTYPE-20260625-0001",
    }),
  });
});

describe("documents service", () => {
  it("persists documentDate when provided during upload", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };

    const user = {
      userId: "user-1",
      role: "SYSTEM_ADMIN",
      tenantId: "tenant-1",
    };

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await createDocument(input, file as any, user as any);

    expect(mockDocument.create).toHaveBeenCalled();
    const createdDocument = mockDocument.create.mock.calls[0][0];
    expect(createdDocument.documentDate).toEqual(new Date("2026-06-25"));
  });

  // Regression for the DAWORG/IT report: the Upload wizard's dropdown
  // already filters document types to the caller's own department
  // client-side, but nothing re-checked it server-side — any authenticated
  // user could submit a documentTypeCode scoped to a completely different
  // department (or org unit) and have it persist.
  it("rejects a document type scoped to a different department", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };
    const user = {
      userId: "user-1",
      role: "STAFF",
      tenantId: "tenant-1",
      permissions: [],
    };
    mockDocumentType.findOne.mockResolvedValue({
      id: "doctype-1",
      departmentId: "dept-other",
      requiresSignature: false,
    });

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await expect(createDocument(input, file as any, user as any)).rejects.toMatchObject({
      statusCode: 403,
      code: "ERR-DOCTYPE-SCOPE",
    });
    expect(mockDocument.create).not.toHaveBeenCalled();
  });

  it("allows a document type scoped to the same department as the upload", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };
    const user = {
      userId: "user-1",
      role: "STAFF",
      tenantId: "tenant-1",
      permissions: ["document:upload"],
    };
    // mockDepartment.findOne (beforeEach) resolves { id: "dept-1" } — same id
    // as ensureCanCreate's own membership check below expects.
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-1"]);
    mockDocumentType.findOne.mockResolvedValue({
      id: "doctype-1",
      departmentId: "dept-1",
      requiresSignature: false,
    });

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await createDocument(input, file as any, user as any);
    expect(mockDocument.create).toHaveBeenCalled();
  });

  it("allows an ACL_BYPASS_ADMIN holder to use an out-of-scope document type", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };
    const user = {
      userId: "admin-1",
      role: "SYSTEM_ADMIN",
      tenantId: "tenant-1",
      permissions: ["document:upload", "acl:bypass_admin"],
    };
    mockDocumentType.findOne.mockResolvedValue({
      id: "doctype-1",
      departmentId: "dept-other",
      requiresSignature: false,
    });

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await createDocument(input, file as any, user as any);
    expect(mockDocument.create).toHaveBeenCalled();
  });

  // Tri-level scope regression: a type scoped to an org unit (orgUnitId set,
  // departmentId null) must be usable by any department under that org unit,
  // and rejected for a department under a different org unit.
  it("allows a document type scoped to the target department's org unit", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };
    const user = {
      userId: "user-1",
      role: "STAFF",
      tenantId: "tenant-1",
      permissions: ["document:upload"],
    };
    mockDepartment.findOne.mockResolvedValue({ id: "dept-1", orgUnitId: "ou-1" });
    mockLoadUserDepartmentIds.mockResolvedValue(["dept-1"]);
    mockDocumentType.findOne.mockResolvedValue({
      id: "doctype-1",
      departmentId: null,
      orgUnitId: "ou-1",
      requiresSignature: false,
    });

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await createDocument(input, file as any, user as any);
    expect(mockDocument.create).toHaveBeenCalled();
  });

  it("rejects a document type scoped to a different org unit", async () => {
    const file = {
      buffer: Buffer.from("dummy content"),
      mimetype: "application/pdf",
      size: 1024,
      originalname: "plan.pdf",
    };
    const user = {
      userId: "user-1",
      role: "STAFF",
      tenantId: "tenant-1",
      permissions: [],
    };
    mockDepartment.findOne.mockResolvedValue({ id: "dept-1", orgUnitId: "ou-1" });
    mockDocumentType.findOne.mockResolvedValue({
      id: "doctype-1",
      departmentId: null,
      orgUnitId: "ou-other",
      requiresSignature: false,
    });

    const input = {
      title: "Project Plan",
      departmentCode: "DEPT",
      documentTypeCode: "DOCTYPE",
      organisationUnit: "HQ",
      securityClassification: "INTERNAL",
      retentionClass: "RET-CORP-5Y",
      source: "MANUAL_UPLOAD",
      documentDate: "2026-06-25",
      retentionTriggerDate: "2026-06-25",
    };

    await expect(createDocument(input, file as any, user as any)).rejects.toMatchObject({
      statusCode: 403,
      code: "ERR-DOCTYPE-SCOPE",
    });
    expect(mockDocument.create).not.toHaveBeenCalled();
  });
});
