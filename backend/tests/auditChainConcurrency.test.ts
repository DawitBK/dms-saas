const entries: any[] = [];
const releases = new Map<object, () => void>();
let lockTail: Promise<void> = Promise.resolve();

let nextSequence = 1;
const activeTransactions = new WeakSet<object>();
const sequelizeMock = {
  transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => {
    // Real Sequelize transactions expose `afterCommit(fn)` — writeAuditLog
    // calls it to defer the chain-cache write to the true commit point. This
    // in-memory mock has no real commit/rollback distinction, so it just
    // invokes `fn` immediately once the callback itself resolves.
    const tx: { afterCommit?: (fn: () => void) => void } = {};
    tx.afterCommit = (fn: () => void) => fn();
    try {
      return await callback(tx);
    } finally {
      releases.get(tx)?.();
      releases.delete(tx);
      activeTransactions.delete(tx);
    }
  }),
  query: jest.fn(async (sql: string, options: { transaction: object; type?: unknown }) => {
    if (!activeTransactions.has(options.transaction)) {
      activeTransactions.add(options.transaction);
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.set(options.transaction, release);
      await previous;
    }

    if (sql.includes("SELECT nextval")) {
      return [{ sequence_number: String(nextSequence++) }];
    }
    return [];
  }),
};

const AuditLogMock = {
  findOne: jest.fn(async () => {
    const sorted = [...entries].sort((a, b) => Number(BigInt(b.sequenceNumber) - BigInt(a.sequenceNumber)));
    return sorted[0] ?? null;
  }),
  create: jest.fn(async (entry: any) => {
    const saved = { ...entry };
    entries.push(saved);
    return saved;
  }),
  findAll: jest.fn(async () => [...entries].sort((a, b) => Number(BigInt(a.sequenceNumber) - BigInt(b.sequenceNumber)))),
};

jest.mock("../src/infrastructure/database/index.js", () => ({
  AuditLog: AuditLogMock,
  sequelize: sequelizeMock,
}));

jest.mock("../src/config/env.js", () => ({
  config: {
    AUDIT_HMAC_SECRET: "test-audit-hmac-secret-with-32-chars",
  },
}));

import crypto from "node:crypto";

jest.mock("../src/core/logger.js", () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

let writeAuditLog: typeof import("../src/modules/audit/audit.service.js").writeAuditLog;
let verifyAuditChain: typeof import("../src/modules/audit/audit.service.js").verifyAuditChain;

describe("audit chain concurrency", () => {
  beforeAll(async () => {
    const auditService = await import("../src/modules/audit/audit.service.js");
    writeAuditLog = auditService.writeAuditLog;
    verifyAuditChain = auditService.verifyAuditChain;
  });
  beforeEach(() => {
    entries.length = 0;
    releases.clear();
    lockTail = Promise.resolve();
    jest.clearAllMocks();
  });

  it("serializes concurrent audit writes into a valid sequence without duplicates or gaps", async () => {
    const count = 25;

    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeAuditLog({
          eventType: "AUTH_LOGIN",
          userId: null,
          userRole: "SYSTEM_ADMIN",
          actionDetails: { index },
          isSuccess: true,
        }),
      ),
    );

    const sequenceNumbers = entries
      .map((entry) => Number(entry.sequenceNumber))
      .sort((a, b) => a - b);

    expect(sequenceNumbers).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(new Set(sequenceNumbers).size).toBe(count);

    const verification = await verifyAuditChain();
    expect(verification).toEqual({
      valid: true,
      message: `Verified ${count} audit entries successfully`,
      // verifyAuditChain now scans the WHOLE range and reports every break it
      // finds instead of returning at the first — an empty `breaks` array is
      // the "clean chain" answer.
      breaks: [],
      totalVerified: count,
      acknowledgedBreaks: 0,
    });
  });

  it("detects a broken hash linkage in the audit chain", async () => {
    const hmacKey = "test-audit-hmac-secret-with-32-chars";
    const entry1 = {
      sequenceNumber: 1n,
      timestamp: new Date().toISOString(),
      eventType: "AUTH_LOGIN",
      userId: null,
      documentId: null,
      actionDetails: "{}",
      previousHash: null,
    };
    const entry1Hash = crypto
      .createHmac("sha256", hmacKey)
      .update(`${entry1.sequenceNumber}${entry1.timestamp}${entry1.eventType}${entry1.userId ?? ""}${entry1.documentId ?? ""}${entry1.actionDetails}${entry1.previousHash ?? ""}`)
      .digest("hex");

    const entry2 = {
      sequenceNumber: 2n,
      timestamp: new Date().toISOString(),
      eventType: "AUTH_LOGOUT",
      userId: null,
      documentId: null,
      actionDetails: "{}",
      previousHash: entry1Hash,
    };
    const entry2Hash = crypto
      .createHmac("sha256", hmacKey)
      .update(`${entry2.sequenceNumber}${entry2.timestamp}${entry2.eventType}${entry2.userId ?? ""}${entry2.documentId ?? ""}${entry2.actionDetails}${entry2.previousHash ?? ""}`)
      .digest("hex");

    // entry3 deliberately uses a WRONG previousHash (not entry2Hash) — simulates tampering
    const entry3 = {
      sequenceNumber: 3n,
      timestamp: new Date().toISOString(),
      eventType: "AUTH_LOGIN",
      userId: null,
      documentId: null,
      actionDetails: "{}",
      previousHash: "deliberately-wrong-hash-000000000000000000000000000000",
    };
    const entry3Hash = crypto
      .createHmac("sha256", hmacKey)
      .update(`${entry3.sequenceNumber}${entry3.timestamp}${entry3.eventType}${entry3.userId ?? ""}${entry3.documentId ?? ""}${entry3.actionDetails}${entry3.previousHash ?? ""}`)
      .digest("hex");

    entries.push(
      { ...entry1, entryHash: entry1Hash },
      { ...entry2, entryHash: entry2Hash },
      { ...entry3, entryHash: entry3Hash },
    );

    const verification = await verifyAuditChain();
    expect(verification).toMatchObject({
      valid: false,
      brokenAt: 3n,
      message: expect.stringContaining("linkage broken"),
    });
  });

  // Regression for the 2026-09-03 audit finding: verifyAuditChain used to
  // RETURN at the first break, so one historical break (this platform's dev
  // DB carries one from the pre-fix Redis-tip race) permanently pinned the
  // answer and made every LATER tamper invisible. It must now report all of
  // them, so an operator can baseline known damage and still be alerted to
  // anything new appearing after it.
  it("keeps scanning past the first break and reports every later one", async () => {
    const hmacKey = "test-audit-hmac-secret-with-32-chars";
    const hashOf = (e: {
      sequenceNumber: bigint; timestamp: string; eventType: string;
      userId: string | null; documentId: string | null; actionDetails: string; previousHash: string | null;
    }) =>
      crypto
        .createHmac("sha256", hmacKey)
        .update(`${e.sequenceNumber}${e.timestamp}${e.eventType}${e.userId ?? ""}${e.documentId ?? ""}${e.actionDetails}${e.previousHash ?? ""}`)
        .digest("hex");

    const base = { timestamp: new Date().toISOString(), userId: null, documentId: null, actionDetails: "{}" };
    const e1 = { ...base, sequenceNumber: 1n, eventType: "AUTH_LOGIN", previousHash: null };
    const h1 = hashOf(e1);
    // Break #1: wrong previousHash at sequence 2.
    const e2 = { ...base, sequenceNumber: 2n, eventType: "AUTH_LOGOUT", previousHash: "wrong-link-aaaa" };
    const h2 = hashOf(e2);
    // Correctly linked to e2 — must NOT be reported (no cascade off break #1).
    const e3 = { ...base, sequenceNumber: 3n, eventType: "AUTH_LOGIN", previousHash: h2 };
    const h3 = hashOf(e3);
    // Break #2: an independent, LATER wrong link — the one the old
    // return-on-first-break behaviour could never surface.
    const e4 = { ...base, sequenceNumber: 4n, eventType: "AUTH_LOGOUT", previousHash: "wrong-link-bbbb" };
    const h4 = hashOf(e4);

    entries.push(
      { ...e1, entryHash: h1 },
      { ...e2, entryHash: h2 },
      { ...e3, entryHash: h3 },
      { ...e4, entryHash: h4 },
    );

    const verification = await verifyAuditChain();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe(2n);
    expect(verification.totalVerified).toBe(4);
    expect(verification.breaks.map((b) => b.sequenceNumber)).toEqual(["2", "4"]);
    expect(verification.breaks.every((b) => b.kind === "linkage")).toBe(true);
  });
});




