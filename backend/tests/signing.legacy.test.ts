// Legacy single-signatory flow (modules/signing/signing.service.ts, reached through
// /documents/:id/sign/* and /signing/:documentId/sign). Audit 2026-10-04: it must not
// run over a live e-signing ceremony, must not record one user's signature for another,
// and must respect tenant boundaries. Fully mocked (no live DB).

const mockDocument = { findByPk: jest.fn() };
const mockDocumentVersion = { findByPk: jest.fn() };
const mockSignatureRecord = { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() };
const mockSignatureRequest = { findOne: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: mockDocument,
  DocumentVersion: mockDocumentVersion,
  SignatureRecord: mockSignatureRecord,
  SignatureRequest: mockSignatureRequest,
}));
const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a) }));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({
  getStorageAdapter: () => ({ get: jest.fn().mockRejectedValue(new Error("storage down")) }),
}));
jest.mock("../src/infrastructure/vault/VaultService.js", () => ({ getVaultService: () => ({}) }));
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

import { executeSigning, declineSigning, requestSigning, verifySigning } from "../src/modules/signing/signing.service.js";

const TENANT = "tenant-a";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user = (id = ALICE, tenantId = TENANT) => ({ userId: id, role: "EMPLOYEE", tenantId });

function doc(over: Record<string, unknown> = {}) {
  const d: any = {
    id: "doc1", tenantId: TENANT, status: "PENDING_SIGNATURE", isOnLegalHold: false,
    versions: [{ id: "v1", storageKey: "k", sha256Hash: "h" }],
    update: jest.fn(async (p: Record<string, unknown>) => Object.assign(d, p)),
    ...over,
  };
  return d;
}
const pending = (signatoryUserId: string) => {
  const p: any = { id: "sig1", signatoryUserId, status: "PENDING" };
  p.update = jest.fn(async (patch: Record<string, unknown>) => Object.assign(p, patch));
  return p;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSignatureRequest.findOne.mockResolvedValue(null);
  mockSignatureRecord.findOne.mockResolvedValue(null);
});

describe("legacy executeSigning", () => {
  const extras = { consentAcknowledged: true, ipAddress: "1.2.3.4" };

  it("is refused while an e-signing ceremony is live on the document (it used to mark the document SIGNED, bypassing the request)", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    mockSignatureRequest.findOne.mockResolvedValue({ id: "req1" });
    await expect(executeSigning("doc1", user(), "ELECTRONIC", extras)).rejects.toMatchObject({ code: "ERR-SIGN-CEREMONY-ACTIVE" });
  });

  it("a user other than the one the pending record names cannot sign it", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    mockSignatureRecord.findOne.mockResolvedValue(pending(ALICE));
    await expect(executeSigning("doc1", user(BOB), "ELECTRONIC", extras)).rejects.toMatchObject({ code: "ERR-SIGN-NOT-SIGNATORY" });
  });

  it("with no pending record at all, nobody can sign (the old code recorded whoever called)", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    await expect(executeSigning("doc1", user(), "ELECTRONIC", extras)).rejects.toMatchObject({ code: "ERR-SIGN-NOT-SIGNATORY" });
  });

  it("another tenant's document is answered 404", async () => {
    mockDocument.findByPk.mockResolvedValue(doc({ tenantId: "tenant-b" }));
    await expect(executeSigning("doc1", user(), "ELECTRONIC", extras)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an unknown signingType", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    await expect(executeSigning("doc1", user(), "WHATEVER" as any, extras)).rejects.toMatchObject({ code: "ERR-SIGN-TYPE-INVALID" });
  });

  it("the named signatory still signs, and the signed version id is stamped on the record", async () => {
    const d = doc();
    mockDocument.findByPk.mockResolvedValue(d);
    const p = pending(ALICE);
    mockSignatureRecord.findOne.mockResolvedValue(p);
    const out = await executeSigning("doc1", user(), "ELECTRONIC", extras);
    expect(out.status).toBe("SIGNED");
    expect(p.update).toHaveBeenCalledWith(expect.objectContaining({ status: "SIGNED", documentVersionId: "v1" }), expect.anything());
  });
});

describe("legacy declineSigning", () => {
  it("is refused while an e-signing ceremony is live", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    mockSignatureRequest.findOne.mockResolvedValue({ id: "req1" });
    await expect(declineSigning("doc1", user(), "not appropriate")).rejects.toMatchObject({ code: "ERR-SIGN-CEREMONY-ACTIVE" });
  });

  it("only the named signatory can decline", async () => {
    mockDocument.findByPk.mockResolvedValue(doc());
    mockSignatureRecord.findOne.mockResolvedValue(pending(ALICE));
    await expect(declineSigning("doc1", user(BOB), "not appropriate")).rejects.toMatchObject({ code: "ERR-SIGN-NOT-SIGNATORY" });
  });
});

describe("legacy requestSigning / verifySigning", () => {
  it("requestSigning is refused over a live ceremony and across tenants", async () => {
    mockDocument.findByPk.mockResolvedValue(doc({ status: "ACTIVE" }));
    mockSignatureRequest.findOne.mockResolvedValue({ id: "req1" });
    await expect(requestSigning("doc1", user())).rejects.toMatchObject({ code: "ERR-SIGN-CEREMONY-ACTIVE" });
    mockDocument.findByPk.mockResolvedValue(doc({ status: "ACTIVE", tenantId: "tenant-b" }));
    await expect(requestSigning("doc1", user())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("verifySigning answers 404 for another tenant's document", async () => {
    mockDocument.findByPk.mockResolvedValue(doc({ tenantId: "tenant-b" }));
    await expect(verifySigning("doc1", user())).rejects.toMatchObject({ statusCode: 404 });
  });
});
