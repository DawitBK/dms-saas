/**
 * grantDefaultDocumentAcl: what a freshly filed document grants, and to whom.
 * assertDocumentTypeInScope: the doc-type scope rule shared by the buffered and
 * the resumable (tus) upload paths.
 */
const mockAclEntry = { bulkCreate: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: {},
  DocumentType: {},
  RetentionPolicy: {},
  FolderNode: {},
  DocumentVersion: {},
  DocumentSequence: {},
  Document: {},
  RetentionApplication: {},
  AclEntry: mockAclEntry,
  UserDepartment: mockUserDepartment,
  DocumentMetadata: {},
  DocumentDek: {},
  OutboxEvent: {},
  sequelize: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: jest.fn() }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn() }));
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: jest.fn() }));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../src/modules/documents/indexSidecar.js", () => ({ writeIndexSidecar: jest.fn() }));
jest.mock("../src/modules/documents/documentValidation.js", () => ({
  mandatoryMetadataFields: [],
  sha256: jest.fn(),
  validateUploadInput: jest.fn(),
}));
jest.mock("../src/config/env.js", () => ({ config: { MINIO_BUCKET_DOCUMENTS: "documents-bucket" } }));
jest.mock("../src/core/logger.js", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

let svc: typeof import("../src/modules/documents/documents.service.js");

beforeAll(async () => {
  svc = await import("../src/modules/documents/documents.service.js");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAclEntry.bulkCreate.mockResolvedValue([]);
  mockUserDepartment.findAll.mockResolvedValue([{ userId: "owner" }, { userId: "colleague" }]);
});

describe("grantDefaultDocumentAcl", () => {
  async function rows() {
    await svc.grantDefaultDocumentAcl("doc-1", "owner", "t1", "dept-1");
    return mockAclEntry.bulkCreate.mock.calls[0][0] as Array<Record<string, unknown>>;
  }

  it("gives the owner read, upload, archive AND checkout (checkout is required to upload a version)", async () => {
    const owner = (await rows()).filter((r) => r.principalType === "user" && r.principalId === "owner");
    expect(owner.map((r) => r.permission).sort()).toEqual(["document:archive", "document:checkout", "document:read", "document:upload"]);
  });

  it("marks the department-member read rows as snapshots, and nothing else", async () => {
    const all = await rows();
    const colleague = all.filter((r) => r.principalId === "colleague");
    expect(colleague).toHaveLength(1);
    expect(colleague[0]).toMatchObject({ permission: "document:read", origin: "DEPT_SNAPSHOT" });
    expect(all.filter((r) => r.origin !== undefined && r.principalId !== "colleague")).toHaveLength(0);
  });

  it("never grants anyone but the owner checkout, and never a role document:read", async () => {
    const all = await rows();
    expect(all.filter((r) => r.permission === "document:checkout").every((r) => r.principalId === "owner")).toBe(true);
    expect(all.some((r) => r.principalType === "role" && r.permission === "document:read")).toBe(false);
  });
});

describe("assertDocumentTypeInScope", () => {
  const user = { userId: "u", role: "EMPLOYEE", tenantId: "t1", permissions: [] as string[] };
  const dept = { id: "dept-1", orgUnitId: "ou-1" };

  it("allows a tenant-wide type", () => {
    expect(() => svc.assertDocumentTypeInScope({ departmentId: null, orgUnitId: null }, dept, user as never)).not.toThrow();
  });
  it("allows the type of the same department and of the same org unit", () => {
    expect(() => svc.assertDocumentTypeInScope({ departmentId: "dept-1" }, dept, user as never)).not.toThrow();
    expect(() => svc.assertDocumentTypeInScope({ orgUnitId: "ou-1" }, dept, user as never)).not.toThrow();
  });
  it("rejects another department's or another org unit's type", () => {
    expect(() => svc.assertDocumentTypeInScope({ departmentId: "dept-2" }, dept, user as never)).toThrow(expect.objectContaining({ code: "ERR-DOCTYPE-SCOPE" }));
    expect(() => svc.assertDocumentTypeInScope({ orgUnitId: "ou-2" }, dept, user as never)).toThrow(expect.objectContaining({ code: "ERR-DOCTYPE-SCOPE" }));
  });
  it("lets ACL_BYPASS_ADMIN holders through", () => {
    const admin = { ...user, permissions: ["acl:bypass_admin"] };
    expect(() => svc.assertDocumentTypeInScope({ departmentId: "dept-2" }, dept, admin as never)).not.toThrow();
  });
});
