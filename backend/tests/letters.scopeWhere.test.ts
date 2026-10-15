// Regression coverage for the CAMS "approval-chain read gap" fix (commit
// 041ae0d): a named (non-role) approval-step assignee outside the letter's
// own department must still be able to read it via getLetter()/listLetters()
// — decideStep() never department-scoped named-user steps, but scopeWhere()
// previously did, so a validly-assigned named approver outside the letter's
// department hit "letter not found / outside your access scope" opening it.
// Fully mocked (no live DB), mirroring tests/letters.reassignCancel.test.ts's style.

const mockLetter = { findOne: jest.fn(), findAndCountAll: jest.fn() };
const mockLetterApprovalStep = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() };
const mockUser = { findOne: jest.fn() };
const mockUserTenant = { findOne: jest.fn() };
const mockUserDepartment = { findAll: jest.fn().mockResolvedValue([]) };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockSequelize = { query: jest.fn().mockResolvedValue([]) };

jest.mock("../src/infrastructure/database/index.js", () => ({
  Department: {},
  Document: {},
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
  UserDepartment: mockUserDepartment,
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

let getLetter: typeof import("../src/modules/letters/letters.service.js").getLetter;
let listLetters: typeof import("../src/modules/letters/letters.service.js").listLetters;

beforeAll(async () => {
  const service = await import("../src/modules/letters/letters.service.js");
  getLetter = service.getLetter;
  listLetters = service.listLetters;
});

const TENANT_ID = "tenant-1";
const LETTER_ID = "letter-1";
const OTHER_DEPT_ID = "dept-other";

// Named approver, no departments, no participant role on the letter — the
// exact victim of the bug: assigned a step, but scopeWhere() had no other way
// to grant them access.
const namedApproverOutsideDept = {
  userId: "approver-9",
  role: "EMPLOYEE",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_REVIEW],
};

function makeLetter(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: LETTER_ID,
    tenantId: TENANT_ID,
    departmentId: OTHER_DEPT_ID,
    direction: "OUTGOING",
    status: "IN_REVIEW",
    createdBy: "someone-else",
    toJSON() {
      return { ...this };
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDepartment.findAll.mockResolvedValue([]);
});

// JSON.stringify silently DROPS symbol-keyed properties — and Sequelize's
// Op.and/Op.or/Op.in are symbols, which is exactly how scopeWhere() builds
// its where-clause (`[Op.and as unknown as string]: [...]`, a cast that
// changes the TS type but not the actual runtime key). A plain
// JSON.stringify(where) on that object silently sees an empty `{}` for
// everything scopeWhere() added — asserting against it would pass even if
// scopeWhere() were deleted outright. Walk own string AND symbol keys so the
// assertions below actually exercise what scopeWhere() returned.
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

describe("scopeWhere — named approval-step assignee bypass (via getLetter)", () => {
  it("includes the assignee's step-assigned letter ids in the id/department OR-clause when they have a pending step", async () => {
    mockLetterApprovalStep.findAll.mockResolvedValue([{ letterId: LETTER_ID }]);
    mockLetter.findOne.mockResolvedValue(makeLetter());

    const letter = await getLetter(LETTER_ID, namedApproverOutsideDept as never);
    expect(letter).toBeTruthy();

    // getUserDepartmentIds() (via UserDepartment) and getAssignedStepLetterIds()
    // (via LetterApprovalStep) must both be consulted before Letter.findOne runs.
    // L19: a CANCELLED step no longer grants access; the user's actual decisions still do.
    const stepQueries = mockLetterApprovalStep.findAll.mock.calls.map((c) => deepInspect(c[0].where));
    expect(stepQueries[0]).toContain(namedApproverOutsideDept.userId);
    expect(stepQueries[0]).toContain("CANCELLED");
    expect(stepQueries[0]).toContain("decidedBy");

    const passedWhere = mockLetter.findOne.mock.calls[0][0].where;
    const serialized = deepInspect(passedWhere);
    // The step-assignee grant ({ id: { [Op.in]: [LETTER_ID] } }) must appear
    // in the where clause — this is the exact bypass the fix added.
    expect(serialized).toContain(LETTER_ID);
    expect(serialized).toContain("Symbol(in)");
  });

  it("still 404s a named step assignee for a DIFFERENT letter they were never assigned to", async () => {
    // getAssignedStepLetterIds resolves to a different letter id than the one
    // being fetched, and the user has no department/participant grant either
    // — Letter.findOne (mocking the real WHERE evaluation a live DB would do)
    // returns null, exactly as a real query would filter it out.
    mockLetterApprovalStep.findAll.mockResolvedValue([{ letterId: "some-other-letter" }]);
    mockLetter.findOne.mockResolvedValue(null);

    await expect(getLetter(LETTER_ID, namedApproverOutsideDept as never)).rejects.toMatchObject({
      code: "ERR-LETTER-NOT-FOUND",
    });
  });

  it("listLetters carries the same step-assignee grant into its OR-clause", async () => {
    mockLetterApprovalStep.findAll.mockResolvedValue([{ letterId: LETTER_ID }]);
    mockLetter.findAndCountAll.mockResolvedValue({ rows: [makeLetter()], count: 1 });

    await listLetters({} as never, namedApproverOutsideDept as never);

    const passedWhere = mockLetter.findAndCountAll.mock.calls[0][0].where;
    const serialized = deepInspect(passedWhere);
    expect(serialized).toContain(LETTER_ID);
  });
});
