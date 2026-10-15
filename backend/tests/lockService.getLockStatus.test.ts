// Regression coverage for the "*By field never resolved to a name" batch fix:
// DocLock.lockedBy was a bare user id with no association, so getLockStatus()
// could only ever return the UUID — nothing could turn it into a display
// name. Mirrors tests/lockService.forceUnlock.test.ts's fully-mocked style.

const mockDocLockFindOne = jest.fn();

jest.mock("../src/infrastructure/database/index.js", () => ({
  DocLock: { findOne: mockDocLockFindOne },
  Document: { findByPk: jest.fn() },
  DocumentCheckout: { findOne: jest.fn() },
  Tenant: { findOne: jest.fn() },
  User: {},
}));

jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/core/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let getLockStatus: typeof import("../src/modules/documents/lockService.js").getLockStatus;

beforeAll(async () => {
  const service = await import("../src/modules/documents/lockService.js");
  getLockStatus = service.getLockStatus;
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("lockService.getLockStatus", () => {
  it("requests the lockedByUser association on the DocLock lookup", async () => {
    mockDocLockFindOne.mockResolvedValue(null);
    await getLockStatus("doc-1");

    const passedInclude = mockDocLockFindOne.mock.calls[0][0].include;
    expect(passedInclude).toEqual([
      expect.objectContaining({ as: "lockedByUser" }),
    ]);
  });

  it("returns locked:false with no lockedByUser when nothing has the document locked", async () => {
    mockDocLockFindOne.mockResolvedValue(null);
    const result = await getLockStatus("doc-1");
    expect(result).toEqual({ locked: false });
  });

  it("surfaces the resolved lockedByUser alongside the bare lockedBy id when a live lock exists", async () => {
    const futureExpiry = new Date(Date.now() + 60_000);
    mockDocLockFindOne.mockResolvedValue({
      lockedBy: "user-2",
      lockedByUser: { id: "user-2", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      lockedAt: new Date("2026-08-01T00:00:00.000Z"),
      expiresAt: futureExpiry,
      reason: "editing",
    });

    const result = await getLockStatus("doc-1");

    expect(result.locked).toBe(true);
    expect(result.lockedBy).toBe("user-2");
    expect(result.lockedByUser).toEqual({ id: "user-2", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });
  });

  it("falls back to lockedByUser: null when the lock row has no resolvable user", async () => {
    const futureExpiry = new Date(Date.now() + 60_000);
    mockDocLockFindOne.mockResolvedValue({
      lockedBy: "user-2",
      lockedAt: new Date("2026-08-01T00:00:00.000Z"),
      expiresAt: futureExpiry,
      reason: "editing",
    });

    const result = await getLockStatus("doc-1");
    expect(result.lockedByUser).toBeNull();
  });

  it("still reports locked:false for an expired lock even though the row is returned", async () => {
    const pastExpiry = new Date(Date.now() - 60_000);
    mockDocLockFindOne.mockResolvedValue({
      lockedBy: "user-2",
      lockedByUser: { id: "user-2", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      lockedAt: new Date("2026-08-01T00:00:00.000Z"),
      expiresAt: pastExpiry,
      reason: "editing",
    });

    const result = await getLockStatus("doc-1");
    expect(result.locked).toBe(false);
  });
});
