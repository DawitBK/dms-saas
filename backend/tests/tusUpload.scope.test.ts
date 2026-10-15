/**
 * The resumable (tus) upload used to skip three checks the buffered upload makes:
 * the document-type scope (any department's type could be filed anywhere), the
 * retention-class registry, and it silently ignored the chosen folder.
 */
let onUploadFinish: (req: unknown, upload: unknown) => Promise<unknown>;
let serverOptions: { maxSize?: number };

jest.mock("@tus/server", () => ({
  Server: jest.fn().mockImplementation((opts: { onUploadFinish: typeof onUploadFinish; maxSize?: number }) => {
    onUploadFinish = opts.onUploadFinish;
    serverOptions = opts;
    return { handle: jest.fn() };
  }),
  Upload: class {},
}));
jest.mock("@tus/file-store", () => ({ FileStore: class { deleteExpired = jest.fn(); } }));

jest.mock("node:fs/promises", () => ({
  __esModule: true,
  default: {
    stat: jest.fn().mockResolvedValue({ size: 10 }),
    readFile: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4 test")),
    unlink: jest.fn().mockResolvedValue(undefined),
    open: jest.fn(),
  },
}));

const mockDepartment = { findOne: jest.fn() };
const mockDocumentType = { findOne: jest.fn() };
const mockRetentionPolicy = { findOne: jest.fn() };
const mockFolderNode = { findOne: jest.fn() };
const mockDocumentCreate = jest.fn();
const fakeTx = { LOCK: { UPDATE: "UPDATE" } };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: mockDepartment,
  Document: { create: (...a: unknown[]) => mockDocumentCreate(...a), findByPk: jest.fn().mockResolvedValue({ id: "doc", documentName: "N", get: () => ({}) }) },
  DocumentDek: { create: jest.fn() },
  DocumentMetadata: { create: jest.fn() },
  DocumentType: mockDocumentType,
  DocumentVersion: { create: jest.fn() },
  FolderNode: mockFolderNode,
  OutboxEvent: { bulkCreate: jest.fn() },
  RetentionPolicy: mockRetentionPolicy,
  sequelize: {
    transaction: jest.fn(async (a: unknown, b?: (tx: object) => Promise<unknown>) => (typeof a === "function" ? a(fakeTx) : b!(fakeTx))),
    query: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn().mockResolvedValue({ encryptedKey: "k", sha256Hash: "h", kekId: "kek" }),
  encryptStreamAndStore: jest.fn(),
}));
jest.mock("../src/modules/documents/documents.service.js", () => {
  const actual = jest.requireActual("../src/modules/documents/documents.service.js");
  return {
    ...actual,
    nextDocumentName: jest.fn().mockResolvedValue("DEPT-TYPE-20261004-0001"),
    ensureCanCreate: jest.fn().mockResolvedValue(undefined),
    grantDefaultDocumentAcl: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn().mockResolvedValue("clean") }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/documents/quotaService.js", () => ({
  checkStorageQuota: jest.fn().mockResolvedValue(undefined),
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/modules/documents/indexSidecar.js", () => ({ writeIndexSidecar: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn(),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../src/config/env.js", () => ({ config: { MINIO_BUCKET_DOCUMENTS: "b", API_BASE_PATH: "/api/v1" } }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import "../src/modules/documents/tusUpload.js";

const DEPT = "00000000-0000-4000-8000-0000000000e1";
const user = { userId: "u1", role: "EMPLOYEE", tenantId: "t1", permissions: [] as string[] };
const req = { user };
const upload = (extra: Record<string, string> = {}) => ({
  id: "up1",
  metadata: {
    title: "Big file", departmentId: DEPT, documentTypeCode: "TYPE", organisationUnit: "HQ",
    securityClassification: "INTERNAL", retentionClass: "RET-5Y", source: "MANUAL_UPLOAD",
    filename: "big.pdf", ...extra,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDepartment.findOne.mockResolvedValue({ id: DEPT, code: "DEPT", orgUnitId: "ou-1" });
  mockDocumentType.findOne.mockResolvedValue({ id: "dt1", code: "TYPE", departmentId: null, orgUnitId: null, requiresSignature: false });
  mockRetentionPolicy.findOne.mockResolvedValue({ id: "r1" });
  mockFolderNode.findOne.mockResolvedValue(null);
  mockDocumentCreate.mockResolvedValue(undefined);
});

describe("tus upload — checks shared with the buffered upload", () => {
  it("caps a single upload at the documented 500 MB", () => {
    expect(serverOptions.maxSize).toBe(500 * 1024 * 1024);
  });

  it("rejects a document type scoped to another department", async () => {
    mockDocumentType.findOne.mockResolvedValue({ id: "dt1", code: "TYPE", departmentId: "other-dept", orgUnitId: null });
    await expect(onUploadFinish(req, upload())).rejects.toMatchObject({ code: "ERR-DOCTYPE-SCOPE" });
    expect(mockDocumentCreate).not.toHaveBeenCalled();
  });

  it("rejects an unregistered retention class", async () => {
    mockRetentionPolicy.findOne.mockResolvedValue(null);
    await expect(onUploadFinish(req, upload())).rejects.toMatchObject({ code: "ERR-RETENTION-INVALID" });
    expect(mockDocumentCreate).not.toHaveBeenCalled();
  });

  it("rejects a folder that does not exist for this tenant", async () => {
    await expect(onUploadFinish(req, upload({ folderPath: "/nope" }))).rejects.toMatchObject({ code: "ERR-FOLDER-INVALID" });
  });

  it("rejects a folder that belongs to a different department", async () => {
    mockFolderNode.findOne.mockResolvedValue({ id: "f1", departmentId: "other-dept" });
    await expect(onUploadFinish(req, upload({ folderPath: "/hr" }))).rejects.toMatchObject({ code: "ERR-FOLDER-DEPARTMENT-MISMATCH" });
  });

  it("files the document in the chosen folder", async () => {
    mockFolderNode.findOne.mockResolvedValue({ id: "f1", departmentId: DEPT });
    await onUploadFinish(req, upload({ folderPath: "/dept/reports" }));
    expect(mockDocumentCreate).toHaveBeenCalledWith(expect.objectContaining({ folderId: "f1", departmentId: DEPT }), expect.anything());
  });

  it("accepts a tenant-wide type with no folder", async () => {
    await onUploadFinish(req, upload());
    expect(mockDocumentCreate).toHaveBeenCalledWith(expect.objectContaining({ folderId: null }), expect.anything());
  });
});
