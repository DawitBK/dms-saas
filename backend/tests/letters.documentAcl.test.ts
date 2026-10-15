// Letters L14 (document ACL follows the letter's classification), E27 (a closed signing request returns
// the letter to APPROVED) and L13 (body image download scope). Fully mocked, no live DB.

const mockAclEntry = { bulkCreate: jest.fn(), destroy: jest.fn() };
const mockLetter = { findOne: jest.fn(), findAll: jest.fn() };
const mockStep = { findAll: jest.fn() };
const mockAttachment = { findAll: jest.fn() };
const mockDocument = { findAll: jest.fn(), update: jest.fn() };
const mockUserDept = { findAll: jest.fn() };
const mockSigReq = { findAll: jest.fn() };
const mockImage = { findOne: jest.fn(), findAll: jest.fn() };
const mockImageLink = { findAll: jest.fn(), bulkCreate: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: mockAclEntry,
  Letter: mockLetter,
  LetterApprovalStep: mockStep,
  LetterAttachment: mockAttachment,
  Document: mockDocument,
  UserDepartment: mockUserDept,
  SignatureRequest: mockSigReq,
  LetterBodyImage: mockImage,
  LetterBodyImageLink: mockImageLink,
}));

const mockGrantDefault = jest.fn();
jest.mock("../src/modules/documents/documents.service.js", () => ({
  grantDefaultDocumentAcl: (...a: unknown[]) => mockGrantDefault(...a),
}));

const mockResolveRole = jest.fn();
jest.mock("../src/shared/assignmentAdvisory.js", () => ({
  resolveRoleUserIds: (...a: unknown[]) => mockResolveRole(...a),
}));

const mockInvalidate = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/infrastructure/cache/aclCache.js", () => ({
  invalidateResourceACL: (...a: unknown[]) => mockInvalidate(...a),
}));

const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockAudit(...a) }));
const mockFanOut = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: (...a: unknown[]) => mockFanOut(...a) }));
jest.mock("../src/infrastructure/queue/outbox.js", () => ({ enqueueWebsocketEvent: jest.fn().mockResolvedValue(undefined) }));
const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: undefined as unknown };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn() }));
jest.mock("sharp", () => jest.fn());
const mockStorageGet = jest.fn().mockResolvedValue(Buffer.from("png"));
jest.mock("../src/infrastructure/storage/StorageAdapter.js", () => ({ getStorageAdapter: () => ({ get: mockStorageGet, put: jest.fn() }) }));

import { LETTER_DRAFT_NAME_PREFIX, grantLetterDocumentAcl, syncLetterDocumentAcl } from "../src/modules/letters/letterDocumentAcl.js";
import { reconcileLetterSigning } from "../src/modules/letters/letterSigningRecovery.js";
import { assertBodyImagesUsable, downloadLetterBodyImage, extractBodyImageIds, makeLetterBodyImageResolver } from "../src/modules/letters/letterBodyImages.service.js";

const TENANT = "tenant-1";
const DOC = "doc-1";
const LETTER = "letter-1";

beforeEach(() => {
  jest.clearAllMocks();
  mockStep.findAll.mockResolvedValue([]);
  mockAttachment.findAll.mockResolvedValue([]);
  mockDocument.findAll.mockResolvedValue([]);
  mockUserDept.findAll.mockResolvedValue([]);
  mockResolveRole.mockResolvedValue([]);
  fakeTx.afterCommit = undefined;
});

function readRows() {
  return mockAclEntry.bulkCreate.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
}

describe("L14: grantLetterDocumentAcl", () => {
  it("INTERNAL letter: ordinary department snapshot, no extra grants", async () => {
    await grantLetterDocumentAcl({ documentId: DOC, ownerId: "owner", tenantId: TENANT, departmentId: "d1", confidentiality: "INTERNAL" }, fakeTx as never);
    expect(mockGrantDefault).toHaveBeenCalledWith(DOC, "owner", TENANT, "d1", fakeTx, { withholdDepartmentSnapshot: false });
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it.each(["CONFIDENTIAL", "RESTRICTED"])("%s letter: snapshot withheld, participants get deliberate reads", async (confidentiality) => {
    await grantLetterDocumentAcl(
      { documentId: DOC, ownerId: "owner", tenantId: TENANT, departmentId: "d1", confidentiality, participantIds: ["owner", "signer"] },
      fakeTx as never,
    );
    expect(mockGrantDefault).toHaveBeenCalledWith(DOC, "owner", TENANT, "d1", fakeTx, { withholdDepartmentSnapshot: true });
    const rows = readRows();
    expect(rows).toHaveLength(1); // the owner already has theirs from grantDefaultDocumentAcl
    expect(rows[0]).toMatchObject({ principalId: "signer", permission: "document:read", effect: "ALLOW", resourceId: DOC });
    expect(rows[0]!.origin).not.toBe("DEPT_SNAPSHOT"); // deliberate, so honoured outside the department
  });
});

describe("L14: syncLetterDocumentAcl", () => {
  const baseLetter = {
    id: LETTER, tenantId: TENANT, departmentId: "d1", createdBy: "drafter", documentId: DOC,
    attachmentDocumentId: null, coverSheetDocumentId: null, signedDraftDocumentId: null,
    assignedToUserId: null, signatoryUserId: null, assignedSignatoryUserId: "signer", assignedSignatoryRole: null,
  };

  it("restricted: removes department snapshot rows, grants participants, drops stale participant grants, invalidates the cache", async () => {
    mockLetter.findOne.mockResolvedValue({ ...baseLetter, confidentiality: "RESTRICTED" });
    mockStep.findAll.mockResolvedValue([{ assignedUserId: "named", assignedRole: null, status: "PENDING", decidedBy: null }]);
    await syncLetterDocumentAcl(LETTER, TENANT, undefined);
    const destroys = mockAclEntry.destroy.mock.calls.map((c) => JSON.stringify(c[0].where, (_k, v) => v));
    expect(destroys.some((d) => d.includes("DEPT_SNAPSHOT"))).toBe(true);
    expect(destroys.some((d) => d.includes("LETTER_PARTICIPANT"))).toBe(true);
    const ids = readRows().map((r) => r.principalId).sort();
    expect(ids).toEqual(["drafter", "named", "signer"]);
    expect(mockInvalidate).toHaveBeenCalledWith(TENANT, "document", DOC);
  });

  it("restricted: holders of an open role step in the letter's department are participants", async () => {
    mockLetter.findOne.mockResolvedValue({ ...baseLetter, confidentiality: "CONFIDENTIAL" });
    mockStep.findAll.mockResolvedValue([{ assignedUserId: null, assignedRole: "DEPT_MANAGER", status: "PENDING", decidedBy: null }]);
    mockResolveRole.mockResolvedValue(["mgr-1"]);
    await syncLetterDocumentAcl(LETTER, TENANT, undefined);
    expect(mockResolveRole).toHaveBeenCalledWith("DEPT_MANAGER", TENANT, "d1");
    expect(readRows().map((r) => r.principalId)).toContain("mgr-1");
  });

  it("non-restricted and no classification change: does nothing at all", async () => {
    mockLetter.findOne.mockResolvedValue({ ...baseLetter, confidentiality: "INTERNAL" });
    await syncLetterDocumentAcl(LETTER, TENANT, undefined);
    expect(mockAclEntry.destroy).not.toHaveBeenCalled();
    expect(mockAclEntry.bulkCreate).not.toHaveBeenCalled();
  });

  it("classification lowered to INTERNAL: document classification updated and the department snapshot restored", async () => {
    mockLetter.findOne.mockResolvedValue({ ...baseLetter, confidentiality: "INTERNAL" });
    mockUserDept.findAll.mockResolvedValue([{ userId: "m1" }, { userId: "m2" }]);
    await syncLetterDocumentAcl(LETTER, TENANT, undefined, { classificationChanged: true });
    expect(mockDocument.update).toHaveBeenCalledWith({ securityClassification: "INTERNAL" }, expect.anything());
    const rows = readRows();
    expect(rows.map((r) => r.principalId).sort()).toEqual(["m1", "m2"]);
    expect(rows.every((r) => r.origin === "DEPT_SNAPSHOT")).toBe(true);
  });

  it("classification raised to CONFIDENTIAL after creation: attachments and signed drafts are covered too", async () => {
    mockLetter.findOne.mockResolvedValue({ ...baseLetter, confidentiality: "CONFIDENTIAL", signedDraftDocumentId: "signed-draft" });
    mockAttachment.findAll.mockResolvedValue([{ documentId: "att-1" }]);
    mockDocument.findAll.mockResolvedValue([{ id: "voided-draft" }]);
    await syncLetterDocumentAcl(LETTER, TENANT, undefined, { classificationChanged: true });
    const docs = new Set(readRows().map((r) => r.resourceId));
    expect([...docs].sort()).toEqual([DOC, "att-1", "signed-draft", "voided-draft"].sort());
    expect(mockDocument.update).toHaveBeenCalledWith({ securityClassification: "CONFIDENTIAL" }, expect.anything());
  });
});

describe("E27: reconcileLetterSigning", () => {
  function pendingLetter() {
    const l: Record<string, unknown> = {
      id: LETTER, tenantId: TENANT, departmentId: "d1", createdBy: "drafter", subject: "S", confidentiality: "INTERNAL",
      status: "PENDING_SIGNATURE", documentId: "draft-doc", signatoryName: "Sam Signer",
    };
    l.update = jest.fn(async (v: Record<string, unknown>) => Object.assign(l, v));
    return l;
  }

  it("a declined (voided) request puts the letter back to APPROVED, frees the draft name, audits the reason and tells the drafter", async () => {
    const letter = pendingLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockSigReq.findAll.mockResolvedValue([{ id: "req-12345678", status: "voided", voidedReason: "Recipient sam declined: wrong addressee" }]);
    const result = await reconcileLetterSigning(LETTER);
    expect(result).toMatchObject({ recovered: true, requestStatus: "voided" });
    expect(letter.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "APPROVED", documentId: null, signatoryUserId: null, assignedSignatoryUserId: null, assignedSignatoryRole: null }),
      expect.anything(),
    );
    expect(mockDocument.update).toHaveBeenCalledWith(
      { documentName: `${LETTER_DRAFT_NAME_PREFIX}${LETTER} (closed req-1234)` },
      expect.objectContaining({ where: { id: "draft-doc" } }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LETTER_UPDATED",
        actionDetails: expect.objectContaining({ from: "PENDING_SIGNATURE", to: "APPROVED", reason: "Recipient sam declined: wrong addressee", requestStatus: "voided" }),
      }),
    );
    expect(mockFanOut).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ["drafter"], payload: expect.objectContaining({ awaitingSigningInitiation: true }) }));
  });

  it("an expired request recovers the same way", async () => {
    const letter = pendingLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockSigReq.findAll.mockResolvedValue([{ id: "req-aaaaaaaa", status: "expired", voidedReason: null }]);
    expect((await reconcileLetterSigning(LETTER)).recovered).toBe(true);
  });

  it.each(["draft", "sent", "partially_signed"])("a %s request is still alive: nothing changes", async (status) => {
    const letter = pendingLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockSigReq.findAll.mockResolvedValue([{ id: "r2", status }, { id: "r1", status: "voided" }]);
    expect((await reconcileLetterSigning(LETTER)).recovered).toBe(false);
    expect(letter.update).not.toHaveBeenCalled();
  });

  it("a completed request is left to the e-signing finalisation", async () => {
    const letter = pendingLetter();
    mockLetter.findOne.mockResolvedValue(letter);
    mockSigReq.findAll.mockResolvedValue([{ id: "r1", status: "completed" }]);
    expect((await reconcileLetterSigning(LETTER)).recovered).toBe(false);
    expect(letter.update).not.toHaveBeenCalled();
  });

  it("a letter that is no longer PENDING_SIGNATURE is not touched", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    expect((await reconcileLetterSigning(LETTER)).recovered).toBe(false);
    expect(mockSigReq.findAll).not.toHaveBeenCalled();
  });
});

describe("L13: body image ownership", () => {
  const IMG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const user = { userId: "u1", tenantId: TENANT, role: "EMPLOYEE" };

  it("extractBodyImageIds finds ids in structured and plain bodies, de-duplicated and lower-cased", () => {
    const body = `{"a":"/letters/body-images/${IMG.toUpperCase()}","b":"/letters/body-images/${IMG}"} and /letters/body-images/not-a-uuid`;
    expect(extractBodyImageIds(body)).toEqual([IMG]);
    expect(extractBodyImageIds(null)).toEqual([]);
  });

  it("assertBodyImagesUsable queries by tenant AND uploader and refuses a mismatch", async () => {
    mockImage.findAll.mockResolvedValue([]);
    await expect(assertBodyImagesUsable(`/letters/body-images/${IMG}`, user)).rejects.toMatchObject({ statusCode: 422, code: "ERR-BODY-IMAGE-FORBIDDEN" });
    expect(mockImage.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, uploadedBy: "u1" });
    mockImage.findAll.mockResolvedValue([{ id: IMG }]);
    await expect(assertBodyImagesUsable(`/letters/body-images/${IMG}`, user)).resolves.toEqual([IMG]);
  });

  it("download: the uploader may always fetch", async () => {
    mockImage.findOne.mockResolvedValue({ id: IMG, uploadedBy: "u1", storageKey: "k", mimeType: "image/png" });
    const canRead = jest.fn();
    await downloadLetterBodyImage(IMG, user as never, canRead);
    expect(canRead).not.toHaveBeenCalled();
  });

  it("download: someone else needs a readable letter that embeds it; otherwise it answers 404", async () => {
    mockImage.findOne.mockResolvedValue({ id: IMG, uploadedBy: "other", storageKey: "k", mimeType: "image/png" });
    mockImageLink.findAll.mockResolvedValue([{ letterId: "L1" }]);
    await expect(downloadLetterBodyImage(IMG, user as never, async () => false)).rejects.toMatchObject({ statusCode: 404, code: "ERR-IMAGE-NOT-FOUND" });
    const canRead = jest.fn().mockResolvedValue(true);
    await expect(downloadLetterBodyImage(IMG, user as never, canRead)).resolves.toMatchObject({ mimeType: "image/png" });
    expect(canRead).toHaveBeenCalledWith(["L1"], user);
  });

  it("download: an image no letter embeds is invisible to anyone but its uploader", async () => {
    mockImage.findOne.mockResolvedValue({ id: IMG, uploadedBy: "other", storageKey: "k", mimeType: "image/png" });
    mockImageLink.findAll.mockResolvedValue([]);
    const canRead = jest.fn();
    await expect(downloadLetterBodyImage(IMG, user as never, canRead)).rejects.toMatchObject({ statusCode: 404 });
    expect(canRead).not.toHaveBeenCalled();
  });

  it("the PDF resolver only reads the letter author's own images in the tenant", async () => {
    mockImage.findOne.mockResolvedValue(null);
    const resolve = makeLetterBodyImageResolver(TENANT, "author");
    expect(await resolve(`/letters/body-images/${IMG}`)).toBeNull();
    expect(mockImage.findOne.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, uploadedBy: "author" });
  });
});
