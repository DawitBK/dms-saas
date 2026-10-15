// Letters workflow audit (2026-10-04) — one regression per hole that was verified in
// letters.service.ts. Every test here fails against the pre-audit code.
// Fully mocked (no live DB), same style as letters.reassignCancel.test.ts.

const mockLetter = { findOne: jest.fn(), findAndCountAll: jest.fn(), update: jest.fn() };
const mockLetterApprovalStep = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() };
const mockLetterDispatch = { create: jest.fn() };
const mockOrgUnit = { findOne: jest.fn(), findByPk: jest.fn() };
const mockDepartment = { findOne: jest.fn().mockResolvedValue(null), findByPk: jest.fn() };
const mockUser = { findOne: jest.fn(), findAll: jest.fn() };
const mockUserTenant = { findOne: jest.fn(), findAll: jest.fn() };
const mockRole = { findAll: jest.fn() };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockSequelize = { query: jest.fn().mockResolvedValue([]) };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: {},
  ArchiveRecord: {},
  Department: mockDepartment,
  Document: {},
  DocumentDek: {},
  DocumentType: {},
  DocumentVersion: {},
  Letter: mockLetter,
  LetterApprovalStep: mockLetterApprovalStep,
  LetterAttachment: {},
  LetterDispatch: mockLetterDispatch,
  LetterLink: {},
  LetterRevision: { findOne: jest.fn(), create: jest.fn() },
  LetterSequence: {},
  OrgUnit: mockOrgUnit,
  OutboxEvent: mockOutboxEvent,
  Role: mockRole,
  sequelize: mockSequelize,
  SignatureRequest: {},
  SignatureField: {},
  Tenant: {},
  User: mockUser,
  UserDepartment: { findAll: jest.fn().mockResolvedValue([]) },
  UserTenant: mockUserTenant,
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

const fakeTx = { LOCK: { UPDATE: "UPDATE" }, afterCommit: jest.fn() };
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
}));

jest.mock("../src/infrastructure/queue/outbox.js", () => ({
  enqueueWebsocketEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/infrastructure/cache/userDeptCache.js", () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(null),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));

jest.mock("../src/modules/notifications/notifications.service.js", () => ({
  fanOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/modules/documents/documentCrypto.js", () => ({
  encryptAndStore: jest.fn(),
  fetchAndDecrypt: jest.fn(),
}));

jest.mock("../src/modules/letters/letterPdf.js", () => ({
  generateLetterPdf: jest.fn(),
  generateLetterSignableDraft: jest.fn(),
  generateLetterCoverSheet: jest.fn(),
  htmlToPlainText: jest.fn().mockReturnValue(""),
}));

jest.mock("../src/modules/esigning/esigning.service.js", () => ({
  createSignatureRequest: jest.fn(),
  sendSignatureRequest: jest.fn(),
}));

jest.mock("../src/modules/documents/documents.service.js", () => ({
  grantDefaultDocumentAcl: jest.fn(),
}));

jest.mock("../src/config/env.js", () => ({
  config: { CAMS_VERIFY_BASE_URL: "http://verify.test", MINIO_BUCKET_DOCUMENTS: "bucket" },
}));

jest.mock("../src/modules/roles/roles.service.js", () => {
  const { ROLE_PERMISSIONS } = jest.requireActual("../src/config/permissions.js");
  return {
    getResolvedRolePermissions: jest.fn(async (roleName: string) => ROLE_PERMISSIONS[roleName] ?? []),
  };
});

// "hidden-admin" plays the platform administrator. The real module reads the DB through its own
// sequelize import, so it is stubbed with the same observable contract (404 for a hidden id).
const HIDDEN_ID = "00000000-0000-4000-8000-00000000dead";
jest.mock("../src/shared/platformAdmin.js", () => {
  const { AppError } = jest.requireActual("../src/core/AppError.js");
  return {
    maskHiddenUsersDeep: jest.fn(async () => undefined),
  assertNotHiddenUser: jest.fn(async (id: string) => {
      if (id === "00000000-0000-4000-8000-00000000dead") throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
    }),
    withoutHiddenIds: jest.fn(async (ids: string[]) => ids.filter((id) => id !== "00000000-0000-4000-8000-00000000dead")),
    notPlatformAdminSql: () => "TRUE",
  };
});

import { PERMISSIONS } from "../src/config/permissions.js";

type Service = typeof import("../src/modules/letters/letters.service.js");
let svc: Service;

beforeAll(async () => {
  svc = await import("../src/modules/letters/letters.service.js");
});

const TENANT_ID = "tenant-1";
const LETTER_ID = "11111111-1111-4111-8111-111111111111";

const records = {
  userId: "records-1",
  role: "RECORDS_OFFICER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.LETTER_DISPATCH, PERMISSIONS.LETTER_REGISTER, PERMISSIONS.LETTER_CREATE],
};
const financeApprover = {
  userId: "fin-manager",
  role: "DEPT_MANAGER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_CREATE, PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE, PERMISSIONS.LETTER_REGISTER],
};
const drafter = {
  userId: "drafter-1",
  role: "EMPLOYEE",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_CREATE],
};

function makeLetter(overrides: Partial<Record<string, unknown>> = {}) {
  const letter: Record<string, unknown> = {
    id: LETTER_ID,
    tenantId: TENANT_ID,
    departmentId: "dept-hr",
    orgUnitId: "unit-1",
    direction: "OUTGOING",
    originType: "COMPOSED",
    status: "DRAFT",
    subject: "Subject",
    createdBy: drafter.userId,
    referenceNumber: null,
    documentId: null,
    ...overrides,
  };
  letter.update = jest.fn(async (values: Record<string, unknown>) => {
    Object.assign(letter, values);
    return letter;
  });
  return letter;
}

// JSON.stringify drops Symbol keys (Op.and / Op.or / Op.in) — walk them explicitly.
function deepInspect(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((v) => deepInspect(v, seen)).join(",")}]`;
  const parts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) parts.push(`${key}:${deepInspect((value as Record<string, unknown>)[key], seen)}`);
  for (const sym of Object.getOwnPropertySymbols(value)) parts.push(`${sym.toString()}:${deepInspect((value as Record<symbol, unknown>)[sym], seen)}`);
  return `{${parts.join(",")}}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLetterApprovalStep.findAll.mockResolvedValue([]);
  mockSequelize.query.mockResolvedValue([]);
});

describe("dispatch / archive need a letter of record (reference number)", () => {
  it("refuses to dispatch an APPROVED composed letter that is still awaiting signing (no reference number)", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "APPROVED", referenceNumber: null }));
    await expect(svc.recordDispatch(LETTER_ID, { channel: "PRINT" }, records as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-NOT-FINALIZED",
    });
    expect(mockLetterDispatch.create).not.toHaveBeenCalled();
  });

  it("still dispatches a finalized (numbered) APPROVED letter", async () => {
    const letter = makeLetter({ status: "APPROVED", referenceNumber: "REF/HQ/HR/OUT/2026/00001" });
    mockLetter.findOne.mockResolvedValue(letter);
    mockLetterDispatch.create.mockResolvedValue({ id: "d1" });
    await svc.recordDispatch(LETTER_ID, { channel: "PRINT" }, records as never);
    expect(mockLetterDispatch.create).toHaveBeenCalled();
    expect(letter.update).toHaveBeenCalledWith({ status: "DISPATCHED" }, { transaction: fakeTx });
  });

  it("refuses to archive an APPROVED letter that has no reference number yet", async () => {
    const letter = makeLetter({ status: "APPROVED", referenceNumber: null });
    mockLetter.findOne.mockResolvedValue(letter);
    await expect(svc.archiveLetter(LETTER_ID, records as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-NOT-FINALIZED",
    });
    expect(letter.update).not.toHaveBeenCalled();
  });
});

describe("initiateLetterSigning is scoped like every other act on a letter", () => {
  it("looks the letter up through scopeWhere, so an approver from another department gets 404", async () => {
    mockLetter.findOne.mockResolvedValue(null); // what the scoped WHERE yields for a letter outside the actor's scope
    await expect(
      svc.initiateLetterSigning(LETTER_ID, { signatory: { assignedUserId: "22222222-2222-4222-8222-222222222222" } }, financeApprover as never),
    ).rejects.toMatchObject({ statusCode: 404, code: "ERR-LETTER-NOT-FOUND" });
    const where = mockLetter.findOne.mock.calls[0][0].where;
    // scopeWhere() adds an Op.and group (department / participant + confidentiality); tenant-only did not.
    expect(deepInspect(where)).toContain("Symbol(and)");
    expect(where.tenantId).toBe(TENANT_ID);
  });
});

describe("createLetter: the department must belong to the chosen org unit", () => {
  it("rejects a (unit, department) pair that does not match with ERR-DEPT-ORG-UNIT-MISMATCH", async () => {
    mockOrgUnit.findOne.mockResolvedValue({ id: "unit-hq", code: "HQ", name: "HQ" });
    mockDepartment.findOne.mockResolvedValueOnce({ id: "dept-branch", code: "FIN", name: "Finance", orgUnitId: "unit-branch" });
    await expect(
      svc.createLetter(
        { orgUnitId: "22222222-2222-4222-8222-222222222222", departmentId: "33333333-3333-4333-8333-333333333333", subject: "S" },
        records as never,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-DEPT-ORG-UNIT-MISMATCH" });
    expect(mockLetter.findOne).not.toHaveBeenCalled();
  });
});

describe("scopeWhere: a named signatory can open the letter they were asked to sign", () => {
  it("puts signatoryUserId in the department/participant OR-group, not only in the confidentiality group", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.getLetter(LETTER_ID, { ...drafter, userId: "signatory-9" } as never)).rejects.toMatchObject({
      code: "ERR-LETTER-NOT-FOUND",
    });
    const where = mockLetter.findOne.mock.calls[0][0].where as Record<symbol, unknown[]>;
    const groups = Object.getOwnPropertySymbols(where).flatMap((s) => where[s] as unknown[]);
    // groups[0] = who may reach the letter at all; groups[1] = confidentiality gate.
    const reach = deepInspect(groups[0]);
    expect(reach).toContain("signatoryUserId:signatory-9");
  });
});

describe("platform administrator stays hidden in letters", () => {
  it("assignLetter answers 404 when the target is the hidden platform admin", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ direction: "INCOMING", status: "RECEIVED", referenceNumber: "REF/HQ/HR/IN/2026/00001" }));
    await expect(svc.assignLetter(LETTER_ID, { assignedToUserId: HIDDEN_ID }, records as never)).rejects.toMatchObject({
      statusCode: 404,
      code: "ERR-USER-NOT-FOUND",
    });
  });

  it("submitLetter refuses a chain step that names the hidden platform admin, before creating any step", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "DRAFT", createdBy: drafter.userId }));
    await expect(
      svc.submitLetter(LETTER_ID, { steps: [{ stepType: "APPROVE", assignedUserId: HIDDEN_ID }] }, drafter as never),
    ).rejects.toMatchObject({ statusCode: 404, code: "ERR-USER-NOT-FOUND" });
  });

  it("initiateLetterSigning refuses a signatory that is the hidden platform admin", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "APPROVED", createdBy: drafter.userId }));
    await expect(
      svc.initiateLetterSigning(LETTER_ID, { signatory: { assignedUserId: HIDDEN_ID } }, drafter as never),
    ).rejects.toMatchObject({ statusCode: 404, code: "ERR-USER-NOT-FOUND" });
  });

  it("the approver/reviewer picker never offers a hidden user even if a role query returned it", async () => {
    mockRole.findAll.mockResolvedValue([{ id: "r1", name: "DEPT_MANAGER" }]);
    mockSequelize.query.mockResolvedValue([{ id: "visible-1" }, { id: HIDDEN_ID }]);
    mockUser.findAll.mockResolvedValue([]);
    await svc.listLetterAssignableUsers(financeApprover as never, "APPROVE");
    const idFilter = mockUser.findAll.mock.calls[0][0].where.id;
    const ids = Object.getOwnPropertySymbols(idFilter).flatMap((s) => idFilter[s] as string[]);
    expect(ids).toEqual(["visible-1"]);
  });
});

describe("incoming letters: no re-routing of finished records, and a truthful audit trail", () => {
  it("assignLetter refuses a CLOSED incoming letter", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ direction: "INCOMING", status: "CLOSED", referenceNumber: "REF/HQ/HR/IN/2026/00001" }));
    await expect(svc.assignLetter(LETTER_ID, { assignedToUserId: null }, records as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-STATE-INVALID",
    });
  });

  it("closing an incoming letter is audited as LETTER_UPDATED with from/to, never as LETTER_ARCHIVED", async () => {
    const letter = makeLetter({ direction: "INCOMING", status: "RESPONDED", referenceNumber: "REF/HQ/HR/IN/2026/00001" });
    mockLetter.findOne.mockResolvedValue(letter);
    await svc.resolveIncomingLetter(LETTER_ID, "CLOSED", records as never);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LETTER_UPDATED",
        actionDetails: expect.objectContaining({ action: "mark_closed", from: "RESPONDED", to: "CLOSED" }),
      }),
    );
  });
});

describe("races: edit / cancel / finalize re-assert state under the row lock", () => {
  it("updateLetter does not write when a concurrent submit moved the letter out of DRAFT", async () => {
    const letter = makeLetter({ status: "DRAFT", createdBy: drafter.userId });
    mockLetter.findOne
      .mockResolvedValueOnce(letter) // the unlocked pre-check still sees DRAFT
      .mockResolvedValueOnce(null); // the locked re-read (status IN DRAFT/RETURNED) finds it already IN_REVIEW
    await expect(svc.updateLetter(LETTER_ID, { subject: "Changed after submit" }, drafter as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-STATE-INVALID",
    });
    expect(letter.update).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("cancelLetter (drafter path) loses to a concurrent submit instead of overwriting IN_REVIEW", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "DRAFT", createdBy: drafter.userId }));
    mockLetter.update.mockResolvedValue([0]); // guarded UPDATE matched no DRAFT row any more
    await expect(svc.cancelLetter(LETTER_ID, {}, drafter as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-STATE-INVALID",
    });
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("finalizeLetterAfterSigning re-locks and refreshes the letter, and refuses one that was cancelled meanwhile", async () => {
    const letter = makeLetter({ status: "PENDING_SIGNATURE", documentId: "draft-doc" });
    (letter as { reload: unknown }).reload = jest.fn(async () => {
      letter.status = "CANCELLED"; // what the locked re-read returns after a committed cancelLetter
      return letter;
    });
    await expect(
      svc.finalizeLetterAfterSigning(letter as never, { userId: "signer", role: "DEPT_MANAGER", tenantId: TENANT_ID } as never, fakeTx as never),
    ).rejects.toMatchObject({ statusCode: 409, code: "ERR-LETTER-ALREADY-FINALIZED" });
    expect((letter as { reload: jest.Mock }).reload).toHaveBeenCalledWith({ transaction: fakeTx, lock: "UPDATE" });
    // No reference number may be drawn from letter_sequences for a cancelled letter.
    expect(mockSequelize.query).not.toHaveBeenCalled();
  });
});
