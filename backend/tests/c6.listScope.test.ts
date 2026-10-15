/**
 * S19 C6 property test: list-visibility ⊆ detail-visibility.
 *
 * `buildReadScope` (the fast SQL used by listDocuments / dashboard) only
 * APPROXIMATES `resolveACL` (the authoritative per-document check the detail
 * route uses), so on its own it can leak metadata for a document the detail view
 * would DENY. `filterDocsByDetailAcl` closes that by running the SAME resolveACL
 * authority over the candidate page. This test pins the invariant: for any set
 * of candidate documents, the filtered output contains exactly those the detail
 * ACL allows — never a denied one (⊆ detail), and never drops an allowed one.
 *
 * resolveACLBatch is mocked so the property holds regardless of the DB; the
 * point is that list output is a strict function of the detail authority.
 * (filterDocsByDetailAcl now calls resolveACLBatch — one batched call per
 * page instead of resolveACL once per row — to fix an N+1; resolveACLBatch
 * is proven to return identical per-document results to resolveACL via
 * test-scripts/test-acl-batch-equivalence.ts, so mocking it here preserves the
 * same "list ⊆ detail" property this test pins.)
 */
const mockResolveACLBatch = jest.fn();

// documents.service.ts pulls a large module graph at import; mock the heavy deps
// (same pattern as documents.service.test.ts) so we can import the pure helper.
jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: {}, DocumentType: {}, RetentionPolicy: {}, FolderNode: {},
  DocumentVersion: {}, DocumentSequence: {}, Document: {}, RetentionApplication: {},
  AclEntry: {}, DocumentMetadata: {}, DocumentDek: {}, OutboxEvent: {},
  ApprovalChain: {}, ApprovalStep: {}, AuditStageReview: {}, User: {},
  UserDepartment: {}, sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../src/shared/resolveACL.js", () => ({
  resolveACL: jest.fn(),
  resolveACLBatch: (...args: unknown[]) => mockResolveACLBatch(...args),
  requireACL: jest.fn(),
  assertACLAllow: jest.fn(),
}));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: jest.fn() }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn() }));
jest.mock("../src/modules/documents/quotaService.js", () => ({
  reserveStorageQuota: jest.fn(), decrementStorageUsed: jest.fn(), checkStorageQuota: jest.fn(),
}));
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: jest.fn() }));
jest.mock("../src/modules/documents/indexSidecar.js", () => ({ writeIndexSidecar: jest.fn() }));
jest.mock("../src/modules/documents/documentValidation.js", () => ({
  mandatoryMetadataFields: [], sha256: jest.fn(), validateUploadInput: jest.fn(),
}));
jest.mock("../src/config/env.js", () => ({ config: { MINIO_BUCKET_DOCUMENTS: "b" } }));
jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type FilterFn = typeof import("../src/modules/documents/documents.service.js").filterDocsByDetailAcl;
let filterDocsByDetailAcl: FilterFn;

beforeAll(async () => {
  filterDocsByDetailAcl = (await import("../src/modules/documents/documents.service.js")).filterDocsByDetailAcl;
});
beforeEach(() => jest.clearAllMocks());

// Deterministic LCG so the "randomized" configs are reproducible (no flakiness).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const regularUser = { userId: "u1", role: "EMPLOYEE", tenantId: "t1", permissions: ["document:read"] as string[] };

describe("C6 — list-visibility ⊆ detail-visibility", () => {
  it("returns exactly the documents the detail ACL allows, over randomized configs", async () => {
    const rng = makeRng(12345);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rng() * 30);
      const docs = Array.from({ length: n }, (_, i) => ({ id: `doc-${trial}-${i}` }));
      const denied = new Set(docs.filter(() => rng() < 0.5).map((d) => d.id));

      mockResolveACLBatch.mockClear();
      mockResolveACLBatch.mockImplementation(async (documentIds: string[]) => {
        const map = new Map<string, { allowed: boolean; effect: string }>();
        for (const id of documentIds) {
          map.set(id, { allowed: !denied.has(id), effect: denied.has(id) ? "DENY" : "ALLOW" });
        }
        return map;
      });

      const result = await filterDocsByDetailAcl(regularUser, docs);
      const resultIds = new Set(result.map((d) => d.id));

      // ⊆ detail: nothing denied slips through.
      for (const d of result) expect(denied.has(d.id)).toBe(false);
      // completeness: every allowed doc is kept.
      for (const d of docs) if (!denied.has(d.id)) expect(resultIds.has(d.id)).toBe(true);
      // resolveACLBatch — the detail authority, batched — was consulted with every candidate, once.
      expect(mockResolveACLBatch).toHaveBeenCalledTimes(1);
      expect(mockResolveACLBatch.mock.calls[0][0]).toEqual(docs.map((d) => d.id));
    }
  });

  it("checks document:read against the detail authority for the whole candidate set", async () => {
    mockResolveACLBatch.mockResolvedValue(new Map([["d1", { allowed: true, effect: "ALLOW" }]]));
    await filterDocsByDetailAcl(regularUser, [{ id: "d1" }]);
    expect(mockResolveACLBatch).toHaveBeenCalledWith(
      ["d1"],
      expect.objectContaining({ permission: "document:read", userId: "u1", userRole: "EMPLOYEE" }),
    );
  });

  it("filters DOCUMENT_READ_ALL users too — they are NOT exempt (matches the detail route, S19 4.1)", async () => {
    // requireACL (GET /:id) does not honor DOCUMENT_READ_ALL, so the list must
    // not either, or these roles would list docs detail then 403s. They still
    // see everything their role's ACL allows (mocked allow below).
    mockResolveACLBatch.mockResolvedValue(new Map([
      ["a", { allowed: true, effect: "ALLOW" }],
      ["b", { allowed: true, effect: "ALLOW" }],
      ["c", { allowed: true, effect: "ALLOW" }],
    ]));
    const oversight = { userId: "admin", role: "RECORDS_OFFICER", tenantId: "t1", permissions: ["document:read_all"] as string[] };
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = await filterDocsByDetailAcl(oversight, docs);
    expect(result).toHaveLength(3);
    expect(mockResolveACLBatch).toHaveBeenCalledTimes(1); // consulted for the whole page, like detail per-doc
  });

  it("leaves ACL_BYPASS_ADMIN users unfiltered", async () => {
    const admin = { userId: "sa", role: "SYSTEM_ADMIN", tenantId: "t1", permissions: ["acl:bypass_admin"] as string[] };
    const result = await filterDocsByDetailAcl(admin, [{ id: "x" }, { id: "y" }]);
    expect(result).toHaveLength(2);
    expect(mockResolveACLBatch).not.toHaveBeenCalled();
  });
});
