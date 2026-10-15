// TEST-1 (Documentations/audits/AUDIT-FINDINGS-2026-09-18.md): modules/retention/ had zero test
// coverage of any kind, automated or manual — this is the ONE place
// disposalEligibleDate is computed (retentionEngine.ts's own header comment),
// so a broken applyRetention() silently misfires every disposal warning and
// purge-eligibility decision in the system with nothing to catch it.
//
// Mocks the DB layer (same pattern as trashService.certificate.test.ts) —
// this exercises the real date-arithmetic and branching logic in
// applyRetention(), not a live database.

const mockDocument = { findByPk: jest.fn() };
const mockRetentionPolicy = { findOne: jest.fn() };
const mockRetentionApplication = {
  destroy: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
};

jest.mock("../src/infrastructure/database/index.js", () => ({
  Document: mockDocument,
  RetentionPolicy: mockRetentionPolicy,
  RetentionApplication: mockRetentionApplication,
}));

let applyRetention: typeof import("../src/modules/retention/retentionEngine.js").applyRetention;

beforeAll(async () => {
  const engine = await import("../src/modules/retention/retentionEngine.js");
  applyRetention = engine.applyRetention;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRetentionApplication.destroy.mockResolvedValue(0);
  mockRetentionApplication.findOne.mockResolvedValue(null);
});

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    retentionClass: "RET-CORR-5Y",
    disposalEligibleDate: null as Date | null,
    archivedAt: null as Date | null,
    documentDate: null as Date | null,
    retentionTriggerDate: null as Date | null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    update: jest.fn(),
    ...overrides,
  };
}

describe("retentionEngine.applyRetention", () => {
  it("does nothing for a document that no longer exists", async () => {
    mockDocument.findByPk.mockResolvedValue(null);
    await applyRetention("missing-doc");
    expect(mockRetentionPolicy.findOne).not.toHaveBeenCalled();
  });

  it("clears disposalEligibleDate and any pending warning row for a permanent-retention policy", async () => {
    const doc = makeDoc({ disposalEligibleDate: new Date("2030-01-01") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ isPermanent: true, retentionYears: null, triggerEvent: "CREATION" });

    await applyRetention("doc-1");

    expect(doc.update).toHaveBeenCalledWith({ disposalEligibleDate: null }, expect.anything());
    expect(mockRetentionApplication.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: "doc-1", disposalAuthorisedAt: null } }),
    );
  });

  it("clears disposalEligibleDate when the document has no retention class at all (no policy lookup)", async () => {
    const doc = makeDoc({ retentionClass: null, disposalEligibleDate: new Date("2030-01-01") });
    mockDocument.findByPk.mockResolvedValue(doc);

    await applyRetention("doc-1");

    expect(mockRetentionPolicy.findOne).not.toHaveBeenCalled();
    expect(doc.update).toHaveBeenCalledWith({ disposalEligibleDate: null }, expect.anything());
  });

  it("does not write again when disposalEligibleDate is already null and stays null (idempotent no-op)", async () => {
    const doc = makeDoc({ disposalEligibleDate: null });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ isPermanent: true, retentionYears: null, triggerEvent: "CREATION" });

    await applyRetention("doc-1");

    expect(doc.update).not.toHaveBeenCalled();
  });

  it("an ARCHIVE-triggered policy on a not-yet-archived document leaves the clock unstarted", async () => {
    const doc = makeDoc({ archivedAt: null });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ isPermanent: false, retentionYears: 7, triggerEvent: "ARCHIVE_DATE" });

    await applyRetention("doc-1");

    // No usable base date (archivedAt is null) -> same as "no policy" branch.
    expect(mockRetentionApplication.destroy).toHaveBeenCalled();
    expect(mockRetentionApplication.create).not.toHaveBeenCalled();
  });

  it("an ARCHIVE-triggered policy computes eligibleAt from archivedAt, not createdAt", async () => {
    const doc = makeDoc({ archivedAt: new Date("2026-03-01T00:00:00.000Z"), createdAt: new Date("2020-01-01") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-1", isPermanent: false, retentionYears: 5, triggerEvent: "ARCHIVE_DATE" });

    await applyRetention("doc-1");

    const expected = new Date("2026-03-01T00:00:00.000Z");
    expected.setFullYear(expected.getFullYear() + 5);
    expect(doc.update).toHaveBeenCalledWith({ disposalEligibleDate: expected }, expect.anything());
  });

  it("a DOCUMENT_DATE-triggered policy computes eligibleAt from documentDate", async () => {
    const doc = makeDoc({ documentDate: new Date("2025-06-15T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-2", isPermanent: false, retentionYears: 3, triggerEvent: "DOCUMENT_DATE" });

    await applyRetention("doc-1");

    const expected = new Date("2025-06-15T00:00:00.000Z");
    expected.setFullYear(expected.getFullYear() + 3);
    expect(doc.update).toHaveBeenCalledWith({ disposalEligibleDate: expected }, expect.anything());
  });

  it("a CREATION-triggered policy falls back to retentionTriggerDate, then createdAt", async () => {
    const doc = makeDoc({ retentionTriggerDate: null, createdAt: new Date("2024-01-01T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-3", isPermanent: false, retentionYears: 10, triggerEvent: "CREATION" });

    await applyRetention("doc-1");

    const expected = new Date("2024-01-01T00:00:00.000Z");
    expected.setFullYear(expected.getFullYear() + 10);
    expect(doc.update).toHaveBeenCalledWith({ disposalEligibleDate: expected }, expect.anything());
  });

  it("creates a RetentionApplication row when none exists yet for this policy", async () => {
    const doc = makeDoc({ createdAt: new Date("2024-01-01T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-4", isPermanent: false, retentionYears: 5, triggerEvent: "CREATION" });
    mockRetentionApplication.findOne.mockResolvedValue(null);

    await applyRetention("doc-1");

    expect(mockRetentionApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", policyId: "pol-4" }),
      expect.anything(),
    );
  });

  it("re-arms the 90/30-day warning flags when the eligibility date moves (e.g. document archived later)", async () => {
    const doc = makeDoc({ createdAt: new Date("2024-01-01T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-5", isPermanent: false, retentionYears: 5, triggerEvent: "CREATION" });
    const existingApp = {
      eligibleAt: new Date("2020-01-01T00:00:00.000Z"), // stale — does not match the freshly computed date
      notified90Days: true,
      notified30Days: true,
      update: jest.fn(),
    };
    mockRetentionApplication.findOne.mockResolvedValue(existingApp);

    await applyRetention("doc-1");

    expect(existingApp.update).toHaveBeenCalledWith(
      expect.objectContaining({ notified90Days: false, notified30Days: false }),
      expect.anything(),
    );
  });

  it("does NOT reset warning flags when the eligibility date is unchanged (would re-send warnings that already went out)", async () => {
    const doc = makeDoc({ createdAt: new Date("2024-01-01T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-6", isPermanent: false, retentionYears: 5, triggerEvent: "CREATION" });
    const expected = new Date("2024-01-01T00:00:00.000Z");
    expected.setFullYear(expected.getFullYear() + 5);
    const existingApp = { eligibleAt: expected, notified90Days: true, notified30Days: false, update: jest.fn() };
    mockRetentionApplication.findOne.mockResolvedValue(existingApp);

    await applyRetention("doc-1");

    expect(existingApp.update).not.toHaveBeenCalled();
  });

  it("purges a stale pending application left over from a different (now-changed) retention policy", async () => {
    const doc = makeDoc({ createdAt: new Date("2024-01-01T00:00:00.000Z") });
    mockDocument.findByPk.mockResolvedValue(doc);
    mockRetentionPolicy.findOne.mockResolvedValue({ id: "pol-new", isPermanent: false, retentionYears: 5, triggerEvent: "CREATION" });

    await applyRetention("doc-1");

    expect(mockRetentionApplication.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ documentId: "doc-1", disposalAuthorisedAt: null }),
      }),
    );
  });
});
