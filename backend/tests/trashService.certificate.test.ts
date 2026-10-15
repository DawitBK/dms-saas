// Regression coverage for getCertificateOfDestruction (new in this batch):
// before this, a purge's certificate reference was returned exactly once in
// a toast and never persisted anywhere retrievable — and even that one-time
// response never resolved authorisedById to a name. Unlike access-rules and
// acl (which hand-pick fields and had a real serializer bug), the new
// documents route below is a trivial `res.json({ data: cert })` pass-through
// with no hand-serialization to drop fields, so service-level coverage of
// the include + 404 path is what actually matters here.

const mockCertificateOfDestruction = { findOne: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: {},
  OutboxEvent: {},
  PurgePending: {},
  DocumentVersion: {},
  DocumentDek: {},
  CertificateOfDestruction: mockCertificateOfDestruction,
  ApprovalChain: {},
  ApprovalStep: {},
  AuditStageReview: {},
  DocLock: {},
  DocumentCheckout: {},
  SignatureRequest: {},
  SignatureRecipient: {},
  FormInstance: {},
  User: {},
}));

jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: jest.fn(),
}));

jest.mock("../src/shared/documentGuards.js", () => ({
  requireDocumentAccess: jest.fn(),
  requireLegalHoldClear: jest.fn(),
  assertNotTerminalState: jest.fn(),
}));

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
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let getCertificateOfDestruction: typeof import("../src/modules/documents/trashService.js").getCertificateOfDestruction;

beforeAll(async () => {
  const service = await import("../src/modules/documents/trashService.js");
  getCertificateOfDestruction = service.getCertificateOfDestruction;
});

beforeEach(() => {
  jest.clearAllMocks();
});

const AUTHORISER = { id: "records-1", firstName: "Records", lastName: "Officer", email: "records@examplecorp.com" };

describe("trashService.getCertificateOfDestruction", () => {
  it("requests the authorisedBy association on the certificate lookup", async () => {
    mockCertificateOfDestruction.findOne.mockResolvedValue({
      reference: "COD-2026-ABCD1234",
      documentIds: "doc-1",
      disposalMethod: "SECURE_DELETE",
      authorisedById: "records-1",
      authorisedBy: AUTHORISER,
      authorisedAt: new Date("2026-08-20T00:00:00.000Z"),
      issuedAt: new Date("2026-08-20T00:00:01.000Z"),
    });

    const cert = await getCertificateOfDestruction("COD-2026-ABCD1234");

    const passedInclude = mockCertificateOfDestruction.findOne.mock.calls[0][0].include;
    expect(passedInclude).toEqual([expect.objectContaining({ as: "authorisedBy" })]);
    expect((cert as unknown as { authorisedBy: typeof AUTHORISER }).authorisedBy).toEqual(AUTHORISER);
  });

  it("throws ERR-CERTIFICATE-NOT-FOUND (404) for an unknown reference", async () => {
    mockCertificateOfDestruction.findOne.mockResolvedValue(null);
    await expect(getCertificateOfDestruction("COD-2026-NOPE0000")).rejects.toMatchObject({
      statusCode: 404,
      code: "ERR-CERTIFICATE-NOT-FOUND",
    });
  });

  it("looks the certificate up by its reference, not any other field", async () => {
    mockCertificateOfDestruction.findOne.mockResolvedValue({ reference: "COD-2026-ABCD1234", authorisedBy: AUTHORISER });
    await getCertificateOfDestruction("COD-2026-ABCD1234");
    expect(mockCertificateOfDestruction.findOne.mock.calls[0][0].where).toEqual({ reference: "COD-2026-ABCD1234" });
  });
});
