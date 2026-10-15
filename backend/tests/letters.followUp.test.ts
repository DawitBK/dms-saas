// Letters follow-up (2026-10-04): L13 L15 L17 L18 L19 L20 behaviours of letters.service.ts.
// Every test here fails against the code before the follow-up.
// Fully mocked (no live DB), same style as letters.workflowGuards.test.ts.

const mockLetter = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), findAndCountAll: jest.fn(), update: jest.fn() };
const mockLetterApprovalStep = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() };
const mockOrgUnit = { findOne: jest.fn(), findByPk: jest.fn() };
const mockDepartment = { findOne: jest.fn().mockResolvedValue(null), findByPk: jest.fn() };
const mockUser = { findOne: jest.fn(), findAll: jest.fn() };
const mockOutboxEvent = { create: jest.fn(), bulkCreate: jest.fn() };
const mockSequelize = { query: jest.fn().mockResolvedValue([]) };
const mockBodyImage = { findAll: jest.fn(), findOne: jest.fn() };

jest.mock("../src/infrastructure/database/index.js", () => ({
  AclEntry: { bulkCreate: jest.fn(), destroy: jest.fn() },
  ArchiveRecord: {},
  Department: mockDepartment,
  Document: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]), update: jest.fn() },
  DocumentDek: {},
  DocumentType: {},
  DocumentVersion: {},
  Letter: mockLetter,
  LetterApprovalStep: mockLetterApprovalStep,
  LetterAttachment: { findAll: jest.fn().mockResolvedValue([]) },
  LetterBodyImage: mockBodyImage,
  LetterBodyImageLink: { bulkCreate: jest.fn(), findAll: jest.fn() },
  LetterDispatch: {},
  LetterLink: {},
  LetterRevision: { findOne: jest.fn(), create: jest.fn() },
  LetterSequence: {},
  OrgUnit: mockOrgUnit,
  OutboxEvent: mockOutboxEvent,
  Role: { findAll: jest.fn() },
  sequelize: mockSequelize,
  SignatureRequest: {},
  SignatureField: {},
  Tenant: {},
  User: mockUser,
  UserDepartment: { findAll: jest.fn().mockResolvedValue([]) },
  UserTenant: { findOne: jest.fn(), findAll: jest.fn() },
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

jest.mock("../src/shared/platformAdmin.js", () => ({
  maskHiddenUsersDeep: jest.fn(async () => undefined),
  assertNotHiddenUser: jest.fn(async () => undefined),
  withoutHiddenIds: jest.fn(async (ids: string[]) => ids),
  notPlatformAdminSql: () => "TRUE",
}));

import { PERMISSIONS } from "../src/config/permissions.js";

type Service = typeof import("../src/modules/letters/letters.service.js");
let svc: Service;

beforeAll(async () => {
  svc = await import("../src/modules/letters/letters.service.js");
}, 60_000);

const TENANT_ID = "tenant-1";
const LETTER_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "44444444-4444-4444-8444-444444444444";
const AUTHOR_ID = "author-1";

const records = {
  userId: "records-1",
  role: "RECORDS_OFFICER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_READ_ALL, PERMISSIONS.LETTER_CREATE],
};
const financeApprover = {
  userId: "fin-manager",
  role: "DEPT_MANAGER",
  tenantId: TENANT_ID,
  permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_CREATE, PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE],
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
    confidentiality: "INTERNAL",
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

// JSON.stringify drops Symbol keys (Op.and / Op.or / Op.in) - walk them explicitly.
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

const deptCache = jest.requireMock("../src/infrastructure/cache/userDeptCache.js") as { loadUserDepartmentIds: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  mockLetterApprovalStep.findAll.mockResolvedValue([]);
  mockLetter.findAll.mockResolvedValue([]);
  mockSequelize.query.mockResolvedValue([]);
  deptCache.loadUserDepartmentIds.mockResolvedValue([]);
});

const approverPerms = [PERMISSIONS.LETTER_READ, PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE];

describe("L15: the drafter cannot approve their own letter", () => {
  const author = { userId: AUTHOR_ID, role: "DEPT_MANAGER", roles: ["DEPT_MANAGER"], tenantId: TENANT_ID, permissions: approverPerms };

  it("decideStep APPROVE by the drafter answers 403 ERR-SELF-APPROVAL and changes nothing", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "IN_REVIEW", createdBy: AUTHOR_ID }));
    mockLetterApprovalStep.findOne.mockResolvedValue({ id: STEP_ID, letterId: LETTER_ID, status: "PENDING", stepType: "APPROVE", assignedUserId: AUTHOR_ID, assignedRole: null });
    await expect(svc.decideStep(LETTER_ID, STEP_ID, { decision: "APPROVE" }, author as never)).rejects.toMatchObject({
      statusCode: 403,
      code: "ERR-SELF-APPROVAL",
    });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });

  it("applies to a role-assigned REVIEW step held by the drafter too", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "IN_REVIEW", createdBy: AUTHOR_ID }));
    mockLetterApprovalStep.findOne.mockResolvedValue({ id: STEP_ID, letterId: LETTER_ID, status: "PENDING", stepType: "REVIEW", assignedUserId: null, assignedRole: "DEPT_MANAGER" });
    deptCache.loadUserDepartmentIds.mockResolvedValue(["dept-hr"]);
    await expect(svc.decideStep(LETTER_ID, STEP_ID, { decision: "APPROVE" }, author as never)).rejects.toMatchObject({ code: "ERR-SELF-APPROVAL" });
  });

  it("the drafter may still RETURN their own letter (it only sends it back to them)", async () => {
    const letter = makeLetter({ status: "IN_REVIEW", createdBy: AUTHOR_ID });
    mockLetter.findOne.mockResolvedValue(letter);
    mockLetterApprovalStep.findOne.mockResolvedValue({ id: STEP_ID, letterId: LETTER_ID, status: "PENDING", stepType: "APPROVE", assignedUserId: AUTHOR_ID, assignedRole: null });
    mockLetterApprovalStep.update.mockResolvedValue([1]);
    await svc.decideStep(LETTER_ID, STEP_ID, { decision: "RETURN", comment: "Fix the date" }, author as never);
    expect(mockLetterApprovalStep.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "RETURNED", comment: "Fix the date" }),
      expect.anything(),
    );
  });

  const DRAFTER_UUID = "55555555-5555-4555-8555-555555555555";

  it("submitLetter refuses a step named after the drafter (ERR-STEP-SELF-APPROVAL), before creating any step", async () => {
    const me = { ...drafter, userId: DRAFTER_UUID };
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "DRAFT", createdBy: DRAFTER_UUID }));
    await expect(
      svc.submitLetter(LETTER_ID, { steps: [{ stepType: "APPROVE", assignedUserId: DRAFTER_UUID }] }, me as never),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-SELF-APPROVAL" });
    expect(mockLetterApprovalStep.update).not.toHaveBeenCalled();
  });

  it("reassignStep refuses to hand the pending step to the drafter", async () => {
    const admin = { userId: "head-1", role: "DEPT_MANAGER", tenantId: TENANT_ID, permissions: [PERMISSIONS.DEPT_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN] };
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "IN_REVIEW", createdBy: DRAFTER_UUID }));
    mockLetterApprovalStep.findOne.mockResolvedValue({ id: STEP_ID, letterId: LETTER_ID, status: "PENDING", stepType: "APPROVE" });
    await expect(
      svc.reassignStep(LETTER_ID, STEP_ID, { assignedUserId: DRAFTER_UUID }, admin as never),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-STEP-SELF-APPROVAL" });
  });
});

describe("L20: returning a letter needs a comment", () => {
  it("rejects RETURN without a comment, and with a blank one; APPROVE needs none", async () => {
    const approver = { ...financeApprover, roles: ["DEPT_MANAGER"] };
    await expect(svc.decideStep(LETTER_ID, STEP_ID, { decision: "RETURN" }, approver as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(svc.decideStep(LETTER_ID, STEP_ID, { decision: "RETURN", comment: "   " }, approver as never)).rejects.toMatchObject({ name: "ZodError" });
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.decideStep(LETTER_ID, STEP_ID, { decision: "APPROVE" }, approver as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
  });
});

describe("L17: an approved but unsigned letter can be withdrawn", () => {
  it("the drafter cancels it with a reason, under the row lock", async () => {
    const letter = makeLetter({ status: "APPROVED", createdBy: drafter.userId, referenceNumber: null });
    mockLetter.findOne.mockResolvedValue(letter);
    await svc.cancelLetter(LETTER_ID, { reason: "Superseded by a new draft" }, drafter as never);
    expect(letter.update).toHaveBeenCalledWith({ status: "CANCELLED" }, { transaction: fakeTx });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "LETTER_CANCELLED",
        actionDetails: expect.objectContaining({ previousStatus: "APPROVED", reason: "Superseded by a new draft" }),
      }),
    );
  });

  it("requires a reason of 10+ characters", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "APPROVED", createdBy: drafter.userId, referenceNumber: null }));
    await expect(svc.cancelLetter(LETTER_ID, { reason: "no" }, drafter as never)).rejects.toMatchObject({ statusCode: 422, code: "ERR-REASON-REQUIRED" });
  });

  it("a NUMBERED letter of record is never cancellable", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "APPROVED", createdBy: drafter.userId, referenceNumber: "REF/HQ/HR/OUT/2026/00001" }));
    await expect(svc.cancelLetter(LETTER_ID, { reason: "I changed my mind about it" }, drafter as never)).rejects.toMatchObject({
      statusCode: 409,
      code: "ERR-LETTER-NOT-CANCELLABLE",
    });
  });

  it("someone who is neither the drafter nor a department head cannot cancel it", async () => {
    mockLetter.findOne.mockResolvedValue(makeLetter({ status: "APPROVED", createdBy: "someone-else", referenceNumber: null }));
    await expect(svc.cancelLetter(LETTER_ID, { reason: "Not my letter to cancel" }, financeApprover as never)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("L18: letters for a parent-department head", () => {
  const head = { userId: "head-1", role: "DEPT_MANAGER", roles: ["DEPT_MANAGER"], tenantId: TENANT_ID, permissions: [PERMISSIONS.LETTER_READ, PERMISSIONS.DEPT_MANAGE, PERMISSIONS.LETTER_DISPATCH] };

  it("READ scope does NOT include the sub-departments the head manages (owner decision 2026-10-09)", async () => {
    deptCache.loadUserDepartmentIds.mockResolvedValue(["dept-parent"]);
    mockSequelize.query.mockResolvedValue([{ id: "dept-parent" }, { id: "dept-child" }]);
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.getLetter(LETTER_ID, head as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
    expect(deepInspect(mockLetter.findOne.mock.calls[0][0].where)).not.toContain("dept-child");
  });

  it("WRITE scope (dispatch) stays on direct membership: the sub-department is not in it", async () => {
    deptCache.loadUserDepartmentIds.mockResolvedValue(["dept-parent"]);
    mockSequelize.query.mockResolvedValue([{ id: "dept-parent" }, { id: "dept-child" }]);
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.recordDispatch(LETTER_ID, { channel: "PRINT" }, head as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
    const where = deepInspect(mockLetter.findOne.mock.calls[0][0].where);
    expect(where).toContain("dept-parent");
    expect(where).not.toContain("dept-child");
  });

  it("a plain member (no department:manage) never gets sub-departments, even for reading", async () => {
    deptCache.loadUserDepartmentIds.mockResolvedValue(["dept-parent"]);
    mockSequelize.query.mockResolvedValue([{ id: "dept-parent" }, { id: "dept-child" }]);
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.getLetter(LETTER_ID, { ...drafter, roles: ["EMPLOYEE"] } as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
    expect(deepInspect(mockLetter.findOne.mock.calls[0][0].where)).not.toContain("dept-child");
  });
});

describe("L19 and role steps: who counts as a participant", () => {
  it("cancelled steps no longer grant access; actual deciders still do", async () => {
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.getLetter(LETTER_ID, { ...drafter, roles: ["EMPLOYEE"] } as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
    const q = deepInspect(mockLetterApprovalStep.findAll.mock.calls[0][0].where);
    expect(q).toContain("Symbol(ne):CANCELLED");
    expect(q).toContain("decidedBy:drafter-1");
  });

  it("a holder of an OPEN role step is a participant inside the letter's department only", async () => {
    deptCache.loadUserDepartmentIds.mockResolvedValue(["dept-hr"]);
    mockLetterApprovalStep.findAll
      .mockResolvedValueOnce([]) // named / decided
      .mockResolvedValueOnce([{ letterId: LETTER_ID }]); // open role step
    mockLetter.findOne.mockResolvedValue(null);
    await expect(svc.getLetter(LETTER_ID, { ...financeApprover, roles: ["DEPT_MANAGER"] } as never)).rejects.toMatchObject({ code: "ERR-LETTER-NOT-FOUND" });
    const roleQuery = deepInspect(mockLetterApprovalStep.findAll.mock.calls[1][0].where);
    expect(roleQuery).toContain("DEPT_MANAGER");
    expect(roleQuery).toContain("PENDING");
    expect(roleQuery).not.toContain("CANCELLED");
    const where = deepInspect(mockLetter.findOne.mock.calls[0][0].where);
    expect(where).toContain(LETTER_ID);
    expect(where).toContain("dept-hr");
  });
});

describe("L13: letter body images", () => {
  const imgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const body = JSON.stringify({ type: "doc", content: [{ type: "image", attrs: { src: `/letters/body-images/${imgA}` } }] });

  it("createLetter refuses a body that embeds an image the author did not upload", async () => {
    mockOrgUnit.findOne.mockResolvedValue({ id: "unit-1", code: "HQ", name: "HQ" });
    mockDepartment.findOne.mockResolvedValueOnce({ id: "dept-hr", code: "HR", name: "HR", orgUnitId: "unit-1" });
    mockBodyImage.findAll.mockResolvedValue([]); // not uploaded by this user / not in this tenant
    await expect(
      svc.createLetter(
        { orgUnitId: "22222222-2222-4222-8222-222222222222", departmentId: "33333333-3333-4333-8333-333333333333", subject: "S", bodyHtml: body },
        records as never,
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: "ERR-BODY-IMAGE-FORBIDDEN" });
    const where = mockBodyImage.findAll.mock.calls[0][0].where;
    expect(where.uploadedBy).toBe(records.userId);
    expect(where.tenantId).toBe(TENANT_ID);
  });

  it("updateLetter refuses it too, and writes nothing", async () => {
    const letter = makeLetter({ status: "DRAFT", createdBy: drafter.userId });
    mockLetter.findOne.mockResolvedValue(letter);
    mockBodyImage.findAll.mockResolvedValue([]);
    await expect(svc.updateLetter(LETTER_ID, { bodyHtml: body }, drafter as never)).rejects.toMatchObject({ code: "ERR-BODY-IMAGE-FORBIDDEN" });
    expect(letter.update).not.toHaveBeenCalled();
  });

  it("canReadAnyLetter asks the real letter scope", async () => {
    expect(await svc.canReadAnyLetter([], drafter as never)).toBe(false);
    mockLetter.findOne.mockResolvedValue(null);
    expect(await svc.canReadAnyLetter([LETTER_ID], drafter as never)).toBe(false);
    mockLetter.findOne.mockResolvedValue({ id: LETTER_ID });
    expect(await svc.canReadAnyLetter([LETTER_ID], drafter as never)).toBe(true);
    expect(deepInspect(mockLetter.findOne.mock.calls[1][0].where)).toContain("Symbol(and)");
  });
});
