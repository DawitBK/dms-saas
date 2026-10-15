// Regression coverage for two related fixes this session:
//
// 1. getLetterByDocumentId (new): the Documents module's Workflow tab
//    couldn't find a letter's real approval chain for a CORR document,
//    because letters keep their own separate approval-chain implementation
//    entirely apart from the unified engine — this reverse lookup (by the
//    letter's final PDF, attachment, or cover sheet document id) is what
//    lets that tab render the real chain instead of a false "not submitted
//    yet". Returns null (not a 404) when the document isn't letter-backed.
//
// 2. decidedByUser / author / dispatcher associations (the "*By field never
//    resolved to a name" batch): a role-assigned approval step only ever
//    showed the generic role, never the specific person who actually
//    decided it, because decidedBy had no association. Same root cause for
//    LetterRevision.savedBy -> author and LetterDispatch.dispatchedBy ->
//    dispatcher.
//
// Fully mocked (no live DB), mirroring tests/letters.scopeWhere.test.ts's
// style — including its symbol-key-aware deepInspect() helper, since
// scopeWhere() builds its where-clause under Op.and/Op.or symbols that
// JSON.stringify silently drops.

const mockLetter = { findOne: jest.fn(), findAndCountAll: jest.fn() };
const mockLetterApprovalStep = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() };
const mockUser = { findOne: jest.fn() };
const mockUserTenant = { findOne: jest.fn() };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockSequelize = { query: jest.fn().mockResolvedValue([]) };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: {},
  Document: { findOne: jest.fn().mockResolvedValue(null) },
  DocumentDek: {},
  DocumentType: {},
  DocumentVersion: {},
  Letter: mockLetter,
  LetterApprovalStep: mockLetterApprovalStep,
  LetterDispatch: {},
  LetterLink: {},
  LetterRevision: {},
  LetterSequence: {},
  OrgUnit: {},
  OutboxEvent: mockOutboxEvent,
  sequelize: mockSequelize,
  User: mockUser,
  UserTenant: mockUserTenant,
}));

// shared/platformAdmin.ts reads the DB through its own sequelize import (not the mocked index): nobody is hidden here.
jest.mock("../src/shared/platformAdmin.js", () => ({
  assertNotHiddenUser: jest.fn(async () => undefined),
  withoutHiddenIds: jest.fn(async (ids: string[]) => ids),
  maskHiddenUsersDeep: jest.fn(async () => undefined),
  notPlatformAdminSql: () => "TRUE",
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const fakeTx = { LOCK: { UPDATE: "UPDATE" } };
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
  htmlToPlainText: jest.fn().mockReturnValue(""),
}));

// letters.service.ts now imports the signing ceremony functions at module
// top-level (real e-signing for outgoing composed letters) — the real
// esigning.service.ts transitively pulls in documents.service.ts, which
// constructs a real MinIO client at *module-eval* time, blowing up with
// this file's minimal mocked config. None of these tests exercise the
// signing path, so a bare stub is enough to keep the import graph light.
jest.mock("../src/modules/esigning/esigning.service.js", () => ({
  createSignatureRequest: jest.fn(),
  sendSignatureRequest: jest.fn(),
}));

// letters.service.ts also now imports grantDefaultDocumentAcl directly from
// documents.service.ts (the ACL grant enterPendingSignatureInTx needs for its
// signable-draft document — see that function) — a second direct edge into
// the same real-MinIO-at-module-eval module the esigning mock above already
// works around. Same stub treatment.
jest.mock("../src/modules/documents/documents.service.js", () => ({
  grantDefaultDocumentAcl: jest.fn(),
}));

jest.mock("../src/config/env.js", () => ({
  config: { CAMS_VERIFY_BASE_URL: "http://verify.test", MINIO_BUCKET_DOCUMENTS: "bucket" },
}));

import { PERMISSIONS } from "../src/config/permissions.js";

let getLetterByDocumentId: typeof import("../src/modules/letters/letters.service.js").getLetterByDocumentId;

beforeAll(async () => {
  const service = await import("../src/modules/letters/letters.service.js");
  getLetterByDocumentId = service.getLetterByDocumentId;
});

const TENANT_ID = "tenant-1";
const LETTER_ID = "letter-1";
const DOC_ID = "doc-corr-1";

const readAllUser = {
  userId: "records-1",
  role: "RECORDS_OFFICER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.LETTER_REVIEW],
};

function makeLetter(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LETTER_ID,
    tenantId: TENANT_ID,
    departmentId: "dept-1",
    direction: "OUTGOING",
    status: "ARCHIVED",
    createdBy: "someone-else",
    toJSON() {
      return { ...this };
    },
    ...overrides,
  };
}

// Mirrors letters.scopeWhere.test.ts's own helper: JSON.stringify silently
// drops symbol-keyed properties (Op.and/Op.or), so a plain stringify would
// pass even if the reverse-lookup OR-clause were deleted outright.
function deepInspect(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((v) => deepInspect(v, seen)).join(",")}]`;
  const parts: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    parts.push(`${key}:${deepInspect((value as Record<string, unknown>)[key], seen)}`);
  }
  for (const sym of Object.getOwnPropertySymbols(value)) {
    parts.push(`${sym.toString()}:${deepInspect((value as Record<symbol, unknown>)[sym], seen)}`);
  }
  return `{${parts.join(",")}}`;
}

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

beforeEach(() => {
  jest.clearAllMocks();
  mockLetterApprovalStep.findAll.mockResolvedValue([]);
});

describe("getLetterByDocumentId", () => {
  it("returns null (not a 404) when the document isn't letter-backed", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    const result = await getLetterByDocumentId(DOC_ID, readAllUser);
    expect(result).toBeNull();
  });

  it("matches on documentId, attachmentDocumentId, or coverSheetDocumentId via an OR clause", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    await getLetterByDocumentId(DOC_ID, readAllUser);

    const passedWhere = mockLetter.findOne.mock.calls[0][0].where;
    const serialized = deepInspect(passedWhere);
    expect(serialized).toContain("documentId");
    expect(serialized).toContain("attachmentDocumentId");
    expect(serialized).toContain("coverSheetDocumentId");
    expect(serialized).toContain(DOC_ID);
    expect(serialized).toContain("Symbol(or)");
  });

  it("scopes the reverse lookup to the caller's tenant", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    await getLetterByDocumentId(DOC_ID, readAllUser);

    const passedWhere = mockLetter.findOne.mock.calls[0][0].where;
    expect(passedWhere.tenantId).toBe(TENANT_ID);
  });

  it("delegates to getLetter() when a matching letter is found, returning its full approval chain", async () => {
    // First call: the reverse-lookup Letter.findOne (attributes: ['id']).
    // Second call: getLetter()'s own Letter.findOne for the full record.
    mockLetter.findOne
      .mockResolvedValueOnce({ id: LETTER_ID })
      .mockResolvedValueOnce(makeLetter());

    const letter = await getLetterByDocumentId(DOC_ID, readAllUser);
    expect(letter).toBeTruthy();
    expect(mockLetter.findOne).toHaveBeenCalledTimes(2);

    // The second call is getLetter()'s — its include must carry the new
    // decidedByUser/author/dispatcher associations from the same batch fix.
    const fullInclude = mockLetter.findOne.mock.calls[1][0].include;
    const approvalSteps = findIncludeByAs(fullInclude, "approvalSteps");
    expect(findIncludeByAs(approvalSteps!.include, "decidedByUser")).toBeTruthy();
    expect(findIncludeByAs(approvalSteps!.include, "assignedUser")).toBeTruthy();

    const revisions = findIncludeByAs(fullInclude, "revisions");
    expect(findIncludeByAs(revisions!.include, "author")).toBeTruthy();

    const dispatches = findIncludeByAs(fullInclude, "dispatches");
    expect(findIncludeByAs(dispatches!.include, "dispatcher")).toBeTruthy();
  });
});
