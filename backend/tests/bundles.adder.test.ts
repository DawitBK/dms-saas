export {};

// Regression coverage for the DocumentBundleItem.addedBy -> adder association
// fix (the "*By field never resolved to a name" batch): addedBy was a bare
// user id with no association, so the bundle detail page could never show
// who added each item.

const mockDocumentBundle = { findOne: jest.fn(), count: jest.fn(), findAll: jest.fn(), create: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: {},
  Document: {},
  DocumentBundle: mockDocumentBundle,
  DocumentBundleItem: {},
  DocumentDek: {},
  DocumentMetadata: {},
  DocumentType: {},
  DocumentVersion: {},
  OutboxEvent: {},
  sequelize: { query: jest.fn().mockResolvedValue([]) },
  User: {},
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
  fetchAndDecrypt: jest.fn(),
}));

jest.mock("../src/modules/documents/quotaService.js", () => ({
  reserveStorageQuota: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let getBundleDetail: typeof import("../src/modules/bundles/bundles.service.js").getBundleDetail;
let listBundles: typeof import("../src/modules/bundles/bundles.service.js").listBundles;

beforeAll(async () => {
  const service = await import("../src/modules/bundles/bundles.service.js");
  getBundleDetail = service.getBundleDetail;
  listBundles = service.listBundles;
});

beforeEach(() => {
  jest.clearAllMocks();
});

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

const user = { userId: "u-1", role: "SYSTEM_ADMIN", tenantId: "t1", roles: [], permissions: [] } as never;

describe("bundles.service — adder association is requested", () => {
  it("getBundleDetail requests the adder association nested under items", async () => {
    mockDocumentBundle.findOne.mockResolvedValue({
      id: "bundle-1",
      createdBy: "u-1",
      get: () => ({ id: "bundle-1", createdBy: "u-1", items: [] }),
    });

    await getBundleDetail("bundle-1", user);

    const passedInclude = mockDocumentBundle.findOne.mock.calls[0][0].include;
    const items = findIncludeByAs(passedInclude, "items");
    expect(items).toBeTruthy();
    const adder = findIncludeByAs(items!.include, "adder");
    expect(adder).toBeTruthy();
  });

  it("listBundles requests the adder association nested under items on every row", async () => {
    mockDocumentBundle.count.mockResolvedValue(0);
    mockDocumentBundle.findAll.mockResolvedValue([]);

    await listBundles(user);

    const passedInclude = mockDocumentBundle.findAll.mock.calls[0][0].include;
    const items = findIncludeByAs(passedInclude, "items");
    expect(items).toBeTruthy();
    const adder = findIncludeByAs(items!.include, "adder");
    expect(adder).toBeTruthy();
  });

  it("404s when the bundle doesn't exist in this tenant", async () => {
    mockDocumentBundle.findOne.mockResolvedValue(null);
    await expect(getBundleDetail("missing", user)).rejects.toMatchObject({ code: "ERR-BUNDLE-NOT-FOUND" });
  });
});
