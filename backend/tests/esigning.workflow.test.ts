// E-signing workflow audit (2026-10-04): state-machine, scope and token regressions in
// modules/esigning/esigning.service.ts. Fully mocked (no live DB) in the style of
// tests/letters.reassignCancel.test.ts. Every case below fails against the pre-audit code.

const mockSignatureRequest = { findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn(), findAll: jest.fn(), findAndCountAll: jest.fn(), update: jest.fn() };
const mockDocVersion = { findByPk: jest.fn() };
const mockFetchAndDecrypt = jest.fn();
const mockSignatureRecipient = { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), bulkCreate: jest.fn() };
const mockSignatureField = { update: jest.fn(), bulkCreate: jest.fn() };
const mockDocument = { findByPk: jest.fn(), findOne: jest.fn() };
const mockUser = { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn().mockResolvedValue([]) };
const mockUserTenant = { findOne: jest.fn() };
const mockFolderNode = { findOne: jest.fn() };
const mockLetter = { findOne: jest.fn().mockResolvedValue(null) };
const mockAuditStageReview = { findOne: jest.fn().mockResolvedValue(null) };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockApprovalChain = { findAll: jest.fn().mockResolvedValue([]) };
const mockApprovalStep = { findOne: jest.fn().mockResolvedValue(null) };
const mockAuditLog = { findAll: jest.fn().mockResolvedValue([]) };
const mockTenant = { findAll: jest.fn().mockResolvedValue([]) };

jest.mock("../src/infrastructure/database/index.js", () => ({
  SignatureRequest: mockSignatureRequest,
  SignatureRecipient: mockSignatureRecipient,
  SignatureField: mockSignatureField,
  Document: mockDocument,
  DocumentVersion: mockDocVersion,
  DocumentDek: {},
  OutboxEvent: mockOutboxEvent,
  AuditStageReview: mockAuditStageReview,
  User: mockUser,
  UserTenant: mockUserTenant,
  UserRole: {},
  Role: {},
  UserDepartment: {},
  Department: {},
  DocumentType: {},
  DocumentMetadata: {},
  FolderNode: mockFolderNode,
  RetentionPolicy: {},
  Tenant: mockTenant,
  Letter: mockLetter,
  ApprovalChain: mockApprovalChain,
  ApprovalStep: mockApprovalStep,
  AuditLog: mockAuditLog,
  sequelize: { query: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../src/modules/letters/letters.service.js", () => ({
  finalizeLetterAfterSigning: jest.fn(),
  notifyExecutivesOfLetter: jest.fn(),
}));
jest.mock("../src/shared/workerTenantContext.js", () => ({
  withWorkerTenantContext: (_t: string, fn: () => unknown) => fn(),
}));
jest.mock("../src/modules/documents/documentCrypto.js", () => ({ encryptAndStore: jest.fn(), fetchAndDecrypt: (...a: unknown[]) => mockFetchAndDecrypt(...a) }));
jest.mock("../src/modules/esigning/esignPades.js", () => ({
  padesConfigured: () => false,
  generatePadesSignedPdf: jest.fn(),
  generateFlattenedUnsignedPdf: jest.fn(),
  PADES_CHANGE_SUMMARY: "pades",
  FLATTENED_CHANGE_SUMMARY: "flat",
}));
const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({ writeAuditLog: (...a: unknown[]) => mockWriteAuditLog(...a) }));
jest.mock("../src/infrastructure/queue/outbox.js", () => ({ enqueueWebsocketEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/infrastructure/cache/aclCache.js", () => ({ invalidateResourceACL: jest.fn().mockResolvedValue(undefined) }));
const mockResolveACL = jest.fn();
jest.mock("../src/shared/resolveACL.js", () => ({
  assertACLAllow: jest.fn().mockResolvedValue(undefined),
  resolveACL: (...a: unknown[]) => mockResolveACL(...a),
}));
jest.mock("../src/shared/departmentCodeError.js", () => ({ departmentCodeNotRegistered: jest.fn() }));
jest.mock("../src/modules/roles/roles.service.js", () => ({
  getResolvedRolePermissions: jest.fn().mockResolvedValue([]),
}));
const mockResolveRoleUserIds = jest.fn();
jest.mock("../src/shared/assignmentAdvisory.js", () => ({
  resolveRoleUserIds: (...a: unknown[]) => mockResolveRoleUserIds(...a),
}));
jest.mock("../src/modules/notifications/notifications.service.js", () => ({ fanOut: jest.fn().mockResolvedValue(undefined) }));
const mockIsHiddenUser = jest.fn();
jest.mock("../src/shared/platformAdmin.js", () => ({
  isHiddenUser: (...a: unknown[]) => mockIsHiddenUser(...a),
  withoutHiddenIds: async (ids: string[]) => ids,
}));
const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));
jest.mock("../src/infrastructure/antivirus/clamscan.js", () => ({ scanBuffer: jest.fn() }));
jest.mock("../src/modules/documents/mimeValidation.js", () => ({ validateUploadedFile: jest.fn() }));
jest.mock("../src/modules/documents/documentValidation.js", () => ({ sha256: jest.fn() }));
jest.mock("../src/shared/sanitizeFilename.js", () => ({ sanitizeFilename: (s: string) => s }));
jest.mock("../src/modules/documents/quotaService.js", () => ({ reserveStorageQuota: jest.fn() }));
jest.mock("../src/modules/retention/retentionEngine.js", () => ({ applyRetention: jest.fn() }));
jest.mock("../src/modules/documents/documents.service.js", () => ({
  grantDefaultDocumentAcl: jest.fn(),
  nextDocumentName: jest.fn(),
  ensureCanCreate: jest.fn(),
}));

import {
  createSignatureRequest,
  sendSignatureRequest,
  signDocument,
  declineSignature,
  cancelSignatureRequest,
  fetchSigningDocumentBytes,
  markRecipientViewed,
  recipientTokenHash,
  remindSignatureRequest,
  expireSignatureRequests,
  getSignatureRequestAuditTrail,
  listAllSignatureRequests,
} from "../src/modules/esigning/esigning.service.js";
import { hashAccessToken, mintAccessToken, accessTokenMatches, redactOutboxPayload } from "../src/modules/esigning/esignTokens.js";
import { registerCeremonyEndedHandler } from "../src/modules/esigning/esigning.events.js";

const TENANT = "tenant-a";
const REQ = "11111111-1111-4111-8111-111111111111";
const REC = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const actor = (over: Record<string, unknown> = {}) =>
  ({ userId: ALICE, tenantId: TENANT, role: "EMPLOYEE", roles: ["EMPLOYEE"], permissions: ["signing:manage", "signing:read"], ...over }) as any;

/** A minimal stand-in for a Sequelize row: plain data plus a recording update(). */
function row<T extends Record<string, any>>(data: T) {
  const r: any = { ...data };
  r.update = jest.fn(async (patch: Record<string, unknown>) => { Object.assign(r, patch); return r; });
  return r as T & { update: jest.Mock };
}

const recipientRow = (over: Record<string, unknown> = {}) =>
  row({
    id: REC, signatureRequestId: REQ, orderIndex: 0, name: "Ext", email: "ext@example.com",
    dmsUserId: null, assignedRole: null, status: "pending",
    accessToken: null, accessTokenHash: hashAccessToken("tok-secret"), accessTokenExpires: new Date(Date.now() + 3_600_000),
    ...over,
  });
const requestRow = (over: Record<string, unknown> = {}) =>
  row({
    id: REQ, documentId: DOC, status: "sent", orderingMode: "parallel", expiresAt: null,
    createdBy: ALICE, recipients: [] as any[], fields: [] as any[], document: { tenantId: TENANT, departmentId: "d1", documentName: "Doc" },
    ...over,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsHiddenUser.mockResolvedValue(false);
  mockLetter.findOne.mockResolvedValue(null);
  mockResolveACL.mockResolvedValue({ allowed: false });
  mockApprovalChain.findAll.mockResolvedValue([]);
  mockApprovalStep.findOne.mockResolvedValue(null);
  mockAuditStageReview.findOne.mockResolvedValue(null);
  mockDocument.findByPk.mockResolvedValue({ isOnLegalHold: false, departmentId: "d1", tenantId: TENANT, status: "PENDING_SIGNATURE", documentName: "Doc", update: jest.fn() });
  mockSignatureRequest.findOne.mockResolvedValue(null);
});

describe("token helpers (E24: only a SHA-256 digest is stored)", () => {
  it("a token matches only its own digest and never matches a missing side", () => {
    const h = hashAccessToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(accessTokenMatches("abc", { hash: h })).toBe(true);
    expect(accessTokenMatches("abd", { hash: h })).toBe(false);
    expect(accessTokenMatches("", { hash: h })).toBe(false);
    expect(accessTokenMatches("abc", {})).toBe(false);
    expect(accessTokenMatches(undefined, { hash: h })).toBe(false);
    // presenting the digest itself must not authenticate (the digest is not the secret)
    expect(accessTokenMatches(h, { hash: h })).toBe(false);
  });

  it("mintAccessToken returns a raw value and the digest of exactly that value", () => {
    const { raw, hash } = mintAccessToken();
    expect(raw.length).toBeGreaterThanOrEqual(30);
    expect(hash).toBe(hashAccessToken(raw));
    expect(mintAccessToken().raw).not.toBe(raw);
  });

  it("a legacy plaintext row (rolling-deploy bridge) still matches, but only when no digest exists", () => {
    expect(accessTokenMatches("legacy", { legacyPlaintext: "legacy" })).toBe(true);
    expect(accessTokenMatches("legacy", { hash: hashAccessToken("other"), legacyPlaintext: "legacy" })).toBe(false);
  });

  it("recipientTokenHash reads the raw column through getDataValue, not the (blanked) public property", () => {
    const r: any = { accessTokenHash: undefined, getDataValue: (k: string) => (k === "accessTokenHash" ? "digest" : undefined) };
    expect(recipientTokenHash(r)).toBe("digest");
    expect(recipientTokenHash({ accessTokenHash: null } as any)).toBeNull();
  });

  it("a delivered invite payload is redacted: no accessToken field, token query value replaced", () => {
    const payload = JSON.stringify({ email: "a@b.c", accessToken: "RAW_tok-1", signUrl: "http://x/sign/1/2?token=RAW_tok-1", reminder: true });
    const red = redactOutboxPayload("ESIGNING.RECIPIENT_INVITED", payload)!;
    expect(red).not.toContain("RAW_tok-1");
    expect(JSON.parse(red).signUrl).toBe("http://x/sign/1/2?token=REDACTED");
    expect(JSON.parse(red).email).toBe("a@b.c");
    expect(redactOutboxPayload("OTHER.EVENT", payload)).toBeNull();
    expect(redactOutboxPayload("ESIGNING.RECIPIENT_INVITED", JSON.stringify({ email: "a@b.c" }))).toBeNull();
  });
});

describe("SignatureRecipient serialisation (the access token must never reach a response)", () => {
  it("toJSON / get({plain}) omit accessTokenHash but the raw value is still readable server-side", async () => {
    const { initSignatureRecipient, SignatureRecipient } = await import("../src/infrastructure/database/models/SignatureRecipient.js");
    initSignatureRecipient();
    const r = SignatureRecipient.build({ id: REC, signatureRequestId: REQ, name: "n", email: "e@x.y", accessTokenHash: "digest-secret" } as any);
    expect(JSON.stringify(r)).not.toContain("digest-secret");
    expect(JSON.stringify(r.get({ plain: true }))).not.toContain("digest-secret");
    expect(r.getDataValue("accessTokenHash")).toBe("digest-secret");
  });
});

describe("createSignatureRequest", () => {
  const baseDoc = { id: DOC, tenantId: TENANT, status: "ACTIVE", departmentId: "d1", ownerId: ALICE, latestVersionId: "v1" };
  const external = { name: "Ext", email: "ext@example.com" };

  beforeEach(() => {
    mockDocument.findOne.mockResolvedValue(baseDoc);
    mockUser.findOne.mockResolvedValue(null);
  });

  it("refuses a dmsUserId that is not a member of the caller's tenant", async () => {
    mockUserTenant.findOne.mockResolvedValue(null);
    await expect(
      createSignatureRequest(DOC, { recipients: [{ name: "", email: "", dmsUserId: BOB }], fields: [] }, actor()),
    ).rejects.toMatchObject({ code: "ERR-RECIPIENT-INVALID" });
    expect(mockSignatureRequest.create).not.toHaveBeenCalled();
  });

  it("refuses a hidden platform admin with the same answer as an unknown user", async () => {
    mockUserTenant.findOne.mockResolvedValue({ userId: BOB });
    mockUser.findOne.mockResolvedValue({ id: BOB });
    mockIsHiddenUser.mockResolvedValue(true);
    const hidden = await createSignatureRequest(DOC, { recipients: [{ name: "", email: "", dmsUserId: BOB }], fields: [] }, actor()).catch((e) => e);
    mockUserTenant.findOne.mockResolvedValue(null);
    const unknown = await createSignatureRequest(DOC, { recipients: [{ name: "", email: "", dmsUserId: BOB }], fields: [] }, actor()).catch((e) => e);
    expect(hidden).toMatchObject({ code: "ERR-RECIPIENT-INVALID" });
    expect({ status: hidden.statusCode ?? hidden.status, message: hidden.message }).toEqual({ status: unknown.statusCode ?? unknown.status, message: unknown.message });
  });

  it("does not turn an email that belongs to the hidden platform admin into an internal recipient", async () => {
    mockUser.findOne.mockResolvedValue({ id: BOB });
    mockIsHiddenUser.mockResolvedValue(true);
    mockSignatureRequest.create.mockResolvedValue({ id: REQ });
    mockSignatureRecipient.bulkCreate.mockResolvedValue([{ id: REC }]);
    await createSignatureRequest(DOC, { recipients: [{ name: "Admin", email: "admin@example.com" }], fields: [] }, actor());
    const created = mockSignatureRecipient.bulkCreate.mock.calls[0][0][0];
    expect(created.dmsUserId).toBeNull();
    expect(mockUserTenant.findOne).not.toHaveBeenCalled();
  });

  it("refuses a field that points at a recipient index that does not exist (it used to fall back to recipient 0)", async () => {
    await expect(
      createSignatureRequest(
        DOC,
        { recipients: [external], fields: [{ recipientIndex: 3, pageNumber: 1, x: 0, y: 0, width: 10, height: 10, fieldType: "signature" }] },
        actor(),
      ),
    ).rejects.toMatchObject({ code: "ERR-FIELD-INVALID" });
  });

  it("refuses an already-past expiry", async () => {
    await expect(
      createSignatureRequest(DOC, { recipients: [external], fields: [], expiresAt: new Date(Date.now() - 1000).toISOString() }, actor()),
    ).rejects.toMatchObject({ code: "ERR-EXPIRY-INVALID" });
  });

  it("refuses a completion target folder from another tenant", async () => {
    mockFolderNode.findOne.mockResolvedValue(null);
    await expect(
      createSignatureRequest(
        DOC,
        { recipients: [external], fields: [], completionAction: "move_folder", completionTargetFolderId: "44444444-4444-4444-8444-444444444444" },
        actor(),
      ),
    ).rejects.toMatchObject({ code: "ERR-FOLDER-INVALID" });
    expect(mockFolderNode.findOne.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT });
  });
});

describe("sendSignatureRequest", () => {
  it("only the requester (or a SYSTEM_ADMIN) may send", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "draft", createdBy: BOB }));
    await expect(sendSignatureRequest(REQ, actor())).rejects.toMatchObject({ code: "ERR-FORBIDDEN" });
  });

  it("refuses to send while another request on the same document is live", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "draft", recipients: [recipientRow()] }));
    mockSignatureRequest.findOne.mockResolvedValue({ id: "other" });
    await expect(sendSignatureRequest(REQ, actor())).rejects.toMatchObject({ code: "ERR-SIGNING-IN-PROGRESS" });
  });

  it("mints the token at send: the digest is stored, the raw token appears only in the emailed link", async () => {
    const rec = recipientRow({ accessTokenHash: null, accessTokenExpires: new Date(Date.now() - 1000) });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "draft", recipients: [rec] }));
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", departmentId: "d1", tenantId: TENANT, update: jest.fn() });
    await sendSignatureRequest(REQ, actor());
    expect(rec.update).toHaveBeenCalledWith(
      expect.objectContaining({ accessTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), accessToken: null, accessTokenExpires: expect.any(Date) }),
      expect.anything(),
    );
    expect(rec.accessTokenExpires.getTime()).toBeGreaterThan(Date.now());
    const payload = JSON.parse(mockOutboxEvent.create.mock.calls[0][0].payload);
    expect(payload.accessToken).toBeUndefined();
    const raw = decodeURIComponent(new URL(payload.signUrl).searchParams.get("token")!);
    expect(hashAccessToken(raw)).toBe(rec.accessTokenHash);
    expect(JSON.stringify(rec.update.mock.calls)).not.toContain(raw);
  });

  it("E23: refuses to send once the document has a newer version than the one pinned", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(
      requestRow({ status: "draft", documentVersionId: "v1", recipients: [recipientRow()], document: { tenantId: TENANT, departmentId: "d1", documentName: "Doc", latestVersionId: "v2" } }),
    );
    await expect(sendSignatureRequest(REQ, actor())).rejects.toMatchObject({ code: "ERR-SIGNING-VERSION-STALE", statusCode: 409 });
    expect(mockOutboxEvent.create).not.toHaveBeenCalled();
  });

  it("sends normally when the pin is still the latest version", async () => {
    const rec = recipientRow({ accessTokenHash: null });
    mockSignatureRequest.findByPk.mockResolvedValue(
      requestRow({ status: "draft", documentVersionId: "v1", recipients: [rec], document: { tenantId: TENANT, departmentId: "d1", documentName: "Doc", latestVersionId: "v1" } }),
    );
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", departmentId: "d1", tenantId: TENANT, update: jest.fn() });
    await expect(sendSignatureRequest(REQ, actor())).resolves.toBeDefined();
  });

  it("refuses to send a draft whose expiry has already passed", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "draft", expiresAt: new Date(Date.now() - 1000), recipients: [recipientRow()] }));
    await expect(sendSignatureRequest(REQ, actor())).rejects.toMatchObject({ code: "ERR-EXPIRY-INVALID" });
  });
});

describe("signDocument", () => {
  const sigField = { id: "f1", recipientId: REC, fieldType: "signature" };
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  function arrange(over: { request?: Record<string, unknown>; recipient?: Record<string, unknown> } = {}) {
    const rec = recipientRow({ dmsUserId: ALICE, accessToken: null, accessTokenExpires: null, ...over.recipient });
    const req = requestRow({ recipients: [rec], fields: [sigField], ...over.request });
    mockSignatureRequest.findByPk.mockResolvedValue(req);
    mockSignatureRecipient.findByPk.mockResolvedValue(rec);
    mockSignatureRecipient.findAll.mockResolvedValue([{ ...rec, status: "signed" }]);
    return { rec, req };
  }

  it("refuses to sign without the mark: an empty fieldValues used to complete the ceremony with a blank signature", async () => {
    arrange();
    await expect(signDocument(REQ, REC, [], "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-SIGNATURE-REQUIRED" });
    await expect(signDocument(REQ, REC, [{ fieldId: "f1", value: "  " }], "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-SIGNATURE-REQUIRED" });
  });

  it("refuses a signature image that is not a PNG/JPEG data URL", async () => {
    arrange();
    await expect(
      signDocument(REQ, REC, [{ fieldId: "f1", value: "data:text/html;base64,PHNjcmlwdD4=" }], "1.2.3.4", actor()),
    ).rejects.toMatchObject({ code: "ERR-SIGNATURE-INVALID" });
  });

  it("answers 404 when the caller's tenant is not the document's tenant (role-based claim across tenants)", async () => {
    arrange({ recipient: { dmsUserId: null, assignedRole: "EXECUTIVE" } });
    mockDocument.findByPk.mockResolvedValue({ isOnLegalHold: false, departmentId: "d1", tenantId: "tenant-b" });
    await expect(
      signDocument(REQ, REC, [{ fieldId: "f1", value: PNG }], "1.2.3.4", actor({ roles: ["EXECUTIVE"] })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("re-checks the request status under the row lock (a decline that committed in between must win)", async () => {
    const { req } = arrange();
    const locked = row({ ...req, status: "voided" });
    mockSignatureRequest.findByPk.mockResolvedValueOnce(req).mockResolvedValueOnce(locked);
    await expect(signDocument(REQ, REC, [{ fieldId: "f1", value: PNG }], "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
  });

  it("an external token is compared exactly and a wrong one is refused", async () => {
    arrange({ recipient: { dmsUserId: null } });
    await expect(
      signDocument(REQ, REC, [{ fieldId: "f1", value: PNG }], "1.2.3.4", undefined, "wrong"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("still signs normally (happy path) and completes a single-recipient request", async () => {
    const { req } = arrange();
    const result = await signDocument(REQ, REC, [{ fieldId: "f1", value: PNG }], "1.2.3.4", actor());
    expect(result.allSigned).toBe(true);
    expect(req.update).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }), expect.anything());
    expect(mockSignatureField.update).toHaveBeenCalled();
  });

  it("enforces serial order", async () => {
    const first = recipientRow({ id: "r-first", orderIndex: 0, dmsUserId: BOB, accessToken: null, accessTokenExpires: null });
    const second = recipientRow({ id: REC, orderIndex: 1, dmsUserId: ALICE, accessToken: null, accessTokenExpires: null });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ orderingMode: "serial", recipients: [first, second], fields: [sigField] }));
    await expect(signDocument(REQ, REC, [{ fieldId: "f1", value: PNG }], "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-SIGNING-OUT-OF-ORDER" });
  });
});

describe("declineSignature", () => {
  function arrange(reqOver: Record<string, unknown> = {}, recOver: Record<string, unknown> = {}) {
    const rec = recipientRow({ dmsUserId: ALICE, accessToken: null, accessTokenExpires: null, ...recOver });
    const req = requestRow(reqOver);
    mockSignatureRecipient.findOne.mockResolvedValue(rec);
    mockSignatureRecipient.findByPk.mockResolvedValue(rec);
    mockSignatureRequest.findByPk.mockResolvedValue(req);
    return { rec, req };
  }

  it("a recipient who already SIGNED cannot decline and void a completed request", async () => {
    const { rec, req } = arrange({ status: "completed" }, { status: "signed" });
    await expect(declineSignature(REQ, REC, "changed my mind", "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
    expect(req.update).not.toHaveBeenCalled();
    expect(rec.update).not.toHaveBeenCalled();
  });

  it.each(["voided", "expired", "draft", "completed"])("cannot decline a %s request", async (status) => {
    const { req } = arrange({ status });
    await expect(declineSignature(REQ, REC, "no", "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
    expect(req.update).not.toHaveBeenCalled();
  });

  it("a signed recipient cannot decline a still-open request either", async () => {
    const { req } = arrange({ status: "partially_signed" }, { status: "signed" });
    await expect(declineSignature(REQ, REC, "x", "1.2.3.4", actor())).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
    expect(req.update).not.toHaveBeenCalled();
  });

  it("an open request is voided and the parent document returns to SIGNING_DECLINED", async () => {
    const { rec, req } = arrange({ status: "sent" });
    const doc = { status: "PENDING_SIGNATURE", tenantId: TENANT, departmentId: "d1", update: jest.fn() };
    mockDocument.findByPk.mockResolvedValue(doc);
    await declineSignature(REQ, REC, "no thanks", "1.2.3.4", actor());
    expect(rec.update).toHaveBeenCalledWith(expect.objectContaining({ status: "declined" }), expect.anything());
    expect(req.update).toHaveBeenCalledWith(expect.objectContaining({ status: "voided" }), expect.anything());
    expect(doc.update).toHaveBeenCalledWith({ status: "SIGNING_DECLINED" }, expect.anything());
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionDetails: expect.objectContaining({ action: "signature_declined" }) }));
  });

  it("another tenant's session is answered 404", async () => {
    arrange({ status: "sent" });
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", tenantId: "tenant-b", departmentId: "d1" });
    await expect(declineSignature(REQ, REC, "x", "1.2.3.4", actor())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a qualified role holder can decline an unclaimed role-based recipient (it used to demand a token)", async () => {
    const { rec } = arrange({ status: "sent" }, { dmsUserId: null, assignedRole: "EXECUTIVE" });
    mockResolveRoleUserIds.mockResolvedValue([ALICE]);
    mockUser.findByPk.mockResolvedValue({ id: ALICE, firstName: "A", lastName: "L", email: "a@x.y" });
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", tenantId: TENANT, departmentId: "d1", update: jest.fn() });
    await declineSignature(REQ, REC, "no", "1.2.3.4", actor({ roles: ["EXECUTIVE"] }));
    expect(rec.update).toHaveBeenCalledWith(expect.objectContaining({ status: "declined", dmsUserId: ALICE }), expect.anything());
  });

  it("a wrong external token is refused", async () => {
    arrange({ status: "sent" }, { dmsUserId: null, accessTokenHash: hashAccessToken("tok-secret") });
    await expect(declineSignature(REQ, REC, "x", "1.2.3.4", undefined, "nope")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("fetchSigningDocumentBytes / markRecipientViewed (external token)", () => {
  it.each(["voided", "expired", "draft"])("a valid token no longer serves the document once the request is %s", async (status) => {
    const rec = recipientRow();
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status, recipients: [rec] }));
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v1", tenantId: TENANT });
    await expect(fetchSigningDocumentBytes(REQ, REC, { accessToken: "tok-secret" })).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
  });

  it("an expired token is refused", async () => {
    const rec = recipientRow({ accessTokenExpires: new Date(Date.now() - 1000) });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ recipients: [rec] }));
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v1", tenantId: TENANT });
    await expect(fetchSigningDocumentBytes(REQ, REC, { accessToken: "tok-secret" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("a token for one recipient does not open another recipient's document", async () => {
    const mine = recipientRow({ id: REC, accessTokenHash: hashAccessToken("tok-mine") });
    const other = recipientRow({ id: "other-rec", accessTokenHash: hashAccessToken("tok-other") });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ recipients: [mine, other] }));
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v1", tenantId: TENANT });
    await expect(fetchSigningDocumentBytes(REQ, "other-rec", { accessToken: "tok-mine" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("opening a link on a voided request does not stamp a 'viewed' state or audit row", async () => {
    const rec = recipientRow();
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "voided", recipients: [rec] }));
    await markRecipientViewed(REQ, REC, "tok-secret");
    expect(rec.update).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});

describe("cancelSignatureRequest", () => {
  it("lets the requester withdraw a live request: voided, document back to SIGNING_DECLINED, audited", async () => {
    const req = requestRow({ status: "sent", recipients: [recipientRow()] });
    mockSignatureRequest.findByPk.mockResolvedValue(req);
    const doc = { status: "PENDING_SIGNATURE", update: jest.fn() };
    mockDocument.findByPk.mockResolvedValue(doc);
    await cancelSignatureRequest(REQ, "wrong signer", actor());
    expect(req.update).toHaveBeenCalledWith(expect.objectContaining({ status: "voided" }), expect.anything());
    expect(doc.update).toHaveBeenCalledWith({ status: "SIGNING_DECLINED" }, expect.anything());
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionDetails: expect.objectContaining({ action: "signature_request_cancelled" }) }));
  });

  it("refuses anyone but the requester or a SYSTEM_ADMIN", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "sent", createdBy: BOB }));
    await expect(cancelSignatureRequest(REQ, "", actor())).rejects.toMatchObject({ code: "ERR-FORBIDDEN" });
    const admin = actor({ roles: ["SYSTEM_ADMIN"] });
    await expect(cancelSignatureRequest(REQ, "", admin)).resolves.toBeDefined();
  });

  it.each(["completed", "voided", "expired"])("cannot cancel a %s request", async (status) => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status }));
    await expect(cancelSignatureRequest(REQ, "", actor())).rejects.toMatchObject({ code: "ERR-INVALID-STATE", statusCode: 409 });
  });
});

// ── E23 / E25 / E26 / E27 + audit trail + oversight list (2026-10-04 follow-up) ──────────────────

describe("E25: who may start a ceremony", () => {
  const external = { name: "Ext", email: "ext@example.com" };
  const mk = (over: Record<string, unknown> = {}) => ({ id: DOC, tenantId: TENANT, status: "ACTIVE", departmentId: "d1", ownerId: BOB, latestVersionId: "v9", ...over });

  beforeEach(() => {
    mockUser.findOne.mockResolvedValue(null);
    mockSignatureRequest.create.mockResolvedValue({ id: REQ });
    mockSignatureRecipient.bulkCreate.mockResolvedValue([{ id: REC }]);
  });

  const attempt = (u = actor()) => createSignatureRequest(DOC, { recipients: [external], fields: [] }, u);

  it("document:read + signing:manage alone is refused (403 ERR-SIGNING-NOT-PERMITTED)", async () => {
    mockDocument.findOne.mockResolvedValue(mk());
    await expect(attempt()).rejects.toMatchObject({ code: "ERR-SIGNING-NOT-PERMITTED", statusCode: 403 });
    expect(mockSignatureRequest.create).not.toHaveBeenCalled();
  });

  it("the owner may", async () => {
    mockDocument.findOne.mockResolvedValue(mk({ ownerId: ALICE }));
    await expect(attempt()).resolves.toBeDefined();
  });

  it("a SYSTEM_ADMIN and an acl:bypass_admin holder may", async () => {
    mockDocument.findOne.mockResolvedValue(mk());
    await expect(attempt(actor({ roles: ["SYSTEM_ADMIN"] }))).resolves.toBeDefined();
    await expect(attempt(actor({ permissions: ["signing:manage", "acl:bypass_admin"] }))).resolves.toBeDefined();
  });

  it("someone holding the write-grade document:upload ACL may, and the ACL is asked for exactly that permission", async () => {
    mockDocument.findOne.mockResolvedValue(mk());
    mockResolveACL.mockResolvedValue({ allowed: true });
    await expect(attempt()).resolves.toBeDefined();
    expect(mockResolveACL.mock.calls[0][0]).toMatchObject({ resourceType: "document", resourceId: DOC, permission: "document:upload", userId: ALICE });
  });

  it("the approver who approved the document in the approval engine may", async () => {
    mockDocument.findOne.mockResolvedValue(mk());
    mockApprovalChain.findAll.mockResolvedValue([{ id: "chain-1" }]);
    mockApprovalStep.findOne.mockResolvedValue({ id: "step-1" });
    await expect(attempt()).resolves.toBeDefined();
    expect(mockApprovalStep.findOne.mock.calls[0][0].where).toMatchObject({ decidedBy: ALICE, stepType: "APPROVE", status: "APPROVED" });
  });

  it("a letter's approver (letter:approve) may start the ceremony for the letter's signable draft, but only while the letter awaits signature", async () => {
    mockDocument.findOne.mockResolvedValue(mk());
    mockLetter.findOne.mockResolvedValue({ id: "L1", createdBy: BOB, signatoryUserId: BOB });
    await expect(attempt(actor({ permissions: ["signing:manage", "letter:approve"] }))).resolves.toBeDefined();
    mockLetter.findOne.mockResolvedValue(null);
    await expect(attempt(actor({ permissions: ["signing:manage", "letter:approve"] }))).rejects.toMatchObject({ code: "ERR-SIGNING-NOT-PERMITTED" });
  });
});

describe("E23: the request pins the document version", () => {
  beforeEach(() => {
    mockUser.findOne.mockResolvedValue(null);
    mockSignatureRequest.create.mockResolvedValue({ id: REQ });
    mockSignatureRecipient.bulkCreate.mockResolvedValue([{ id: REC }]);
  });
  const doc = (over: Record<string, unknown> = {}) => ({ id: DOC, tenantId: TENANT, status: "ACTIVE", departmentId: "d1", ownerId: ALICE, latestVersionId: "v7", ...over });

  it("create pins the latest version and creates NO token (it is minted at send)", async () => {
    mockDocument.findOne.mockResolvedValue(doc());
    await createSignatureRequest(DOC, { recipients: [{ name: "Ext", email: "ext@example.com" }], fields: [] }, actor());
    expect(mockSignatureRequest.create.mock.calls[0][0]).toMatchObject({ documentVersionId: "v7" });
    const rec = mockSignatureRecipient.bulkCreate.mock.calls[0][0][0];
    expect(rec.accessToken).toBeNull();
    expect(rec.accessTokenHash).toBeNull();
  });

  it("create refuses a document with no filed version", async () => {
    mockDocument.findOne.mockResolvedValue(doc({ latestVersionId: null }));
    await expect(createSignatureRequest(DOC, { recipients: [{ name: "Ext", email: "ext@example.com" }], fields: [] }, actor())).rejects.toMatchObject({ code: "ERR-DOCUMENT-NOT-SIGNABLE" });
  });

  it("sign is refused when a newer version exists", async () => {
    const rec = recipientRow({ dmsUserId: ALICE, accessTokenHash: null, accessTokenExpires: null });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ documentVersionId: "v1", recipients: [rec], fields: [{ id: "f1", recipientId: REC, fieldType: "signature" }] }));
    mockDocument.findByPk.mockResolvedValue({ isOnLegalHold: false, departmentId: "d1", tenantId: TENANT, latestVersionId: "v2" });
    await expect(
      signDocument(REQ, REC, [{ fieldId: "f1", value: "data:image/png;base64,iVBORw0KGgo=" }], "1.2.3.4", actor()),
    ).rejects.toMatchObject({ code: "ERR-SIGNING-VERSION-STALE" });
  });

  it("the document is served from the PINNED version, not the latest", async () => {
    const rec = recipientRow({ dmsUserId: ALICE, accessTokenHash: null });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ documentVersionId: "v1", recipients: [rec] }));
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v1", tenantId: TENANT });
    mockDocVersion.findByPk.mockResolvedValue({ id: "v1", documentId: DOC, storageKey: "k1", originalFilename: "a.pdf", mimeType: "application/pdf" });
    mockFetchAndDecrypt.mockResolvedValue(Buffer.from("pdf"));
    const out = await fetchSigningDocumentBytes(REQ, REC, { user: actor() });
    expect(mockDocVersion.findByPk).toHaveBeenCalledWith("v1");
    expect(out.filename).toBe("a.pdf");
  });

  it("a live request whose document moved on is refused at fetch, a completed one serves its signed copy", async () => {
    const rec = recipientRow({ dmsUserId: ALICE, accessTokenHash: null });
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v3", tenantId: TENANT });
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ documentVersionId: "v1", recipients: [rec] }));
    await expect(fetchSigningDocumentBytes(REQ, REC, { user: actor() })).rejects.toMatchObject({ code: "ERR-SIGNING-VERSION-STALE" });

    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "completed", documentVersionId: "v1", signedVersionId: "v3", recipients: [rec] }));
    mockDocVersion.findByPk.mockResolvedValue({ id: "v3", documentId: DOC, storageKey: "k3", originalFilename: "a-signed.pdf", mimeType: "application/pdf" });
    mockFetchAndDecrypt.mockResolvedValue(Buffer.from("pdf"));
    const out = await fetchSigningDocumentBytes(REQ, REC, { user: actor() });
    expect(mockDocVersion.findByPk).toHaveBeenLastCalledWith("v3");
    expect(out.filename).toBe("a-signed.pdf");
  });
});

describe("E26: refused token attempts and external document fetches are audited", () => {
  const live = (rec: any) => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ recipients: [rec] }));
    mockDocument.findByPk.mockResolvedValue({ id: DOC, departmentId: "d1", latestVersionId: "v1", tenantId: TENANT });
  };

  it("a wrong token leaves a failed audit row carrying the request, recipient, address and browser", async () => {
    live(recipientRow());
    await expect(
      fetchSigningDocumentBytes(REQ, REC, { accessToken: "nope" }, { ip: "203.0.113.7", userAgent: "UA/1.0" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const call = mockWriteAuditLog.mock.calls.find((c) => c[0].actionDetails?.action === "signature_token_rejected")![0];
    expect(call).toMatchObject({ isSuccess: false, errorCode: "ERR-FORBIDDEN", documentId: DOC, tenantId: TENANT });
    expect(call.actionDetails).toMatchObject({ requestId: REQ, recipientId: REC, attempt: "document", reason: "invalid", ipAddress: "203.0.113.7", userAgent: "UA/1.0" });
    expect(JSON.stringify(call)).not.toContain("nope");
  });

  it("repeated bad attempts from one address are throttled to one row per minute", async () => {
    live(recipientRow());
    for (let i = 0; i < 3; i += 1) {
      await expect(fetchSigningDocumentBytes(REQ, REC, { accessToken: "x" + i }, { ip: "203.0.113.8" })).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(mockWriteAuditLog.mock.calls.filter((c) => c[0].actionDetails?.action === "signature_token_rejected")).toHaveLength(1);
  });

  it("an expired token is audited as expired", async () => {
    live(recipientRow({ accessTokenExpires: new Date(Date.now() - 1000) }));
    await expect(fetchSigningDocumentBytes(REQ, REC, { accessToken: "tok-secret" }, { ip: "203.0.113.9" })).rejects.toMatchObject({ statusCode: 403 });
    const call = mockWriteAuditLog.mock.calls.find((c) => c[0].actionDetails?.action === "signature_token_rejected")![0];
    expect(call.actionDetails.reason).toBe("expired");
  });

  it("a successful external fetch is audited, an internal one is not", async () => {
    live(recipientRow());
    mockDocVersion.findByPk.mockResolvedValue({ id: "v1", documentId: DOC, storageKey: "k", originalFilename: "a.pdf", mimeType: "application/pdf" });
    mockFetchAndDecrypt.mockResolvedValue(Buffer.from("pdf"));
    await fetchSigningDocumentBytes(REQ, REC, { accessToken: "tok-secret" }, { ip: "203.0.113.10", userAgent: "UA" });
    const call = mockWriteAuditLog.mock.calls.find((c) => c[0].actionDetails?.action === "signature_document_fetched")![0];
    expect(call.actionDetails).toMatchObject({ requestId: REQ, recipientId: REC, ipAddress: "203.0.113.10" });
  });
});

describe("E27: the ceremony-ended hook", () => {
  let unregister: () => void;
  const events: Array<{ event: any; tx: unknown }> = [];
  beforeEach(() => {
    events.length = 0;
    unregister = registerCeremonyEndedHandler((event, tx) => { events.push({ event, tx }); });
  });
  afterEach(() => unregister());

  it("a decline reports outcome 'declined' with the reason, inside the transaction", async () => {
    const rec = recipientRow({ dmsUserId: ALICE, accessTokenHash: null, accessTokenExpires: null });
    mockSignatureRecipient.findOne.mockResolvedValue(rec);
    mockSignatureRecipient.findByPk.mockResolvedValue(rec);
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "sent" }));
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", tenantId: TENANT, departmentId: "d1", update: jest.fn() });
    await declineSignature(REQ, REC, "wrong person", "1.2.3.4", actor());
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ requestId: REQ, documentId: DOC, tenantId: TENANT, outcome: "declined", reason: "wrong person", actorUserId: ALICE, recipientId: REC });
    expect(events[0].tx).toBe(fakeTx);
  });

  it("a cancel reports outcome 'cancelled'", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "sent", recipients: [recipientRow()] }));
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", update: jest.fn() });
    await cancelSignatureRequest(REQ, "typo", actor());
    expect(events[0].event).toMatchObject({ outcome: "cancelled", reason: "typo", actorUserId: ALICE });
  });

  it("a handler failure propagates so the decline is not committed half-way", async () => {
    unregister();
    unregister = registerCeremonyEndedHandler(() => { throw new Error("letters handler failed"); });
    const rec = recipientRow({ dmsUserId: ALICE, accessTokenHash: null, accessTokenExpires: null });
    mockSignatureRecipient.findOne.mockResolvedValue(rec);
    mockSignatureRecipient.findByPk.mockResolvedValue(rec);
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "sent" }));
    mockDocument.findByPk.mockResolvedValue({ status: "PENDING_SIGNATURE", tenantId: TENANT, departmentId: "d1", update: jest.fn() });
    await expect(declineSignature(REQ, REC, "x", "1.2.3.4", actor())).rejects.toThrow("letters handler failed");
  });

  it("the expiry sweep expires a stale request in its own transaction and reports 'expired'", async () => {
    mockTenant.findAll.mockResolvedValue([{ id: TENANT }]);
    mockSignatureRequest.findAll.mockResolvedValue([{ id: REQ, documentId: DOC }]);
    const locked = requestRow({ status: "sent" });
    mockSignatureRequest.findByPk.mockResolvedValue(locked);
    const doc = { status: "PENDING_SIGNATURE", tenantId: TENANT, update: jest.fn() };
    mockDocument.findByPk.mockResolvedValue(doc);
    const count = await expireSignatureRequests();
    expect(count).toBe(1);
    expect(locked.update).toHaveBeenCalledWith({ status: "expired" }, expect.anything());
    expect(doc.update).toHaveBeenCalledWith({ status: "SIGNING_DECLINED" }, expect.anything());
    expect(events[0].event).toMatchObject({ outcome: "expired", requestId: REQ, actorUserId: null });
  });

  it("a request that was signed or cancelled while the sweep ran is not expired", async () => {
    mockTenant.findAll.mockResolvedValue([{ id: TENANT }]);
    mockSignatureRequest.findAll.mockResolvedValue([{ id: REQ, documentId: DOC }]);
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "completed" }));
    expect(await expireSignatureRequests()).toBe(0);
    expect(events).toHaveLength(0);
  });
});

describe("E24: a reminder rotates the token", () => {
  it("stores a new digest, invalidates the old one, and emails only a link", async () => {
    const rec = recipientRow();
    const oldHash = rec.accessTokenHash;
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ status: "sent", recipients: [rec] }));
    await remindSignatureRequest(REQ, actor(), { ip: "198.51.100.1", userAgent: "UA" });
    expect(rec.accessTokenHash).not.toBe(oldHash);
    expect(accessTokenMatches("tok-secret", { hash: rec.accessTokenHash })).toBe(false);
    const payload = JSON.parse(mockOutboxEvent.create.mock.calls[0][0].payload);
    expect(payload.accessToken).toBeUndefined();
    expect(payload.reminder).toBe(true);
    const raw = decodeURIComponent(new URL(payload.signUrl).searchParams.get("token")!);
    expect(accessTokenMatches(raw, { hash: rec.accessTokenHash })).toBe(true);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionDetails: expect.objectContaining({ action: "signature_request_reminded", ipAddress: "198.51.100.1", userAgent: "UA" }) }));
  });

  it("refuses to remind a request whose document has a newer version", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(
      requestRow({ status: "sent", documentVersionId: "v1", recipients: [recipientRow()], document: { tenantId: TENANT, departmentId: "d1", documentName: "Doc", latestVersionId: "v2" } }),
    );
    await expect(remindSignatureRequest(REQ, actor())).rejects.toMatchObject({ code: "ERR-SIGNING-VERSION-STALE" });
  });
});

describe("per-request audit trail", () => {
  const auditRow = (over: Record<string, unknown>, details: Record<string, unknown>) => ({
    id: "a" + Math.random(), timestamp: new Date("2026-10-04T10:00:00Z"), eventType: "DOCUMENT_UPDATED", userId: ALICE, userRole: "EMPLOYEE",
    sourceIp: "10.0.0.5", isSuccess: true, actionDetails: JSON.stringify(details), ...over,
  });

  it("returns who/when/IP/user-agent/action for this request only, in order", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow());
    mockAuditLog.findAll.mockResolvedValue([
      auditRow({}, { action: "signature_request_sent", requestId: REQ, userAgent: "Chrome" }),
      auditRow({ userId: null, sourceIp: "203.0.113.4" }, { action: "document_signed_completed", requestId: REQ, recipientId: REC, externalSigner: "ex***@example.com", userAgent: "Safari" }),
      auditRow({}, { action: "something_else", requestId: "99999999-9999-4999-8999-999999999999" }),
    ]);
    mockUser.findAll.mockResolvedValue([{ id: ALICE, firstName: "Alice", lastName: "L" }]);
    const trail = await getSignatureRequestAuditTrail(REQ, actor());
    expect(trail.map((t) => t.action)).toEqual(["signature_request_sent", "document_signed_completed"]);
    expect(trail[0]).toMatchObject({ actor: { userId: ALICE, name: "Alice L" }, ipAddress: "10.0.0.5", userAgent: "Chrome" });
    expect(trail[1]).toMatchObject({ actor: null, externalSigner: "ex***@example.com", ipAddress: "203.0.113.4", userAgent: "Safari", recipientId: REC });
    expect(mockAuditLog.findAll.mock.calls[0][0].where).toMatchObject({ documentId: DOC, tenantId: TENANT });
  });

  it("is refused to a plain reader who is neither the requester nor an oversight holder", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ createdBy: BOB }));
    await expect(getSignatureRequestAuditTrail(REQ, actor())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAuditLog.findAll).not.toHaveBeenCalled();
  });

  it("is open to an auditor (audit:read) and to document:read_all holders", async () => {
    mockSignatureRequest.findByPk.mockResolvedValue(requestRow({ createdBy: BOB }));
    mockAuditLog.findAll.mockResolvedValue([]);
    await expect(getSignatureRequestAuditTrail(REQ, actor({ permissions: ["signing:read", "audit:read"] }))).resolves.toEqual([]);
    await expect(getSignatureRequestAuditTrail(REQ, actor({ permissions: ["signing:read", "document:read_all"] }))).resolves.toEqual([]);
  });
});

describe("tenant-wide oversight list", () => {
  it("is refused to anyone without document:read_all (and not a SYSTEM_ADMIN)", async () => {
    await expect(listAllSignatureRequests(actor())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockSignatureRequest.findAndCountAll).not.toHaveBeenCalled();
  });

  it("lists every request of the caller's tenant (not only their own), filtered by status, read-only", async () => {
    const row: any = { toJSON: () => ({ id: REQ, status: "sent", createdBy: BOB }), createdBy: BOB };
    mockSignatureRequest.findAndCountAll.mockResolvedValue({ rows: [row], count: 1 });
    mockUser.findAll.mockResolvedValue([{ id: BOB, firstName: "Bob", lastName: "B" }]);
    const out = await listAllSignatureRequests(actor({ permissions: ["signing:read", "document:read_all"] }), { status: "sent", q: "lease" });
    expect(out.total).toBe(1);
    expect(out.data[0]).toMatchObject({ id: REQ, createdByName: "Bob B" });
    const arg = mockSignatureRequest.findAndCountAll.mock.calls[0][0];
    expect(arg.where).toEqual({ status: "sent" });
    expect(arg.where.createdBy).toBeUndefined();
    expect(arg.include[0].where.tenantId).toBe(TENANT);
  });

  it("rejects an unknown status filter", async () => {
    await expect(listAllSignatureRequests(actor({ roles: ["SYSTEM_ADMIN"] }), { status: "bogus" })).rejects.toMatchObject({ code: "ERR-VALIDATION" });
  });
});
