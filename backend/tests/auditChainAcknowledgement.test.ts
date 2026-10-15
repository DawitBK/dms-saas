// A known historical break can be ACKNOWLEDGED (audit_chain_acknowledgements): verification still lists it, but stops
// counting it as an unexplained violation, and only while the row still has the stored hashes it had when acknowledged.
import crypto from "node:crypto";

const SECRET = "test-audit-hmac-secret-with-32-chars";
const rows: any[] = [];
let ackRows: any[] = [];
let ackReadFails = false;

jest.mock("../src/infrastructure/database/index.js", () => ({
  AuditLog: { findAll: jest.fn(async () => rows.map((r) => ({ ...r }))) },
  sequelize: {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("FROM audit_chain_acknowledgements")) {
        if (ackReadFails) throw new Error("table missing");
        return ackRows;
      }
      return [];
    }),
  },
}));
jest.mock("../src/config/env.js", () => ({ config: { AUDIT_HMAC_SECRET: SECRET } }));
jest.mock("../src/core/logger.js", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { verifyAuditChain } from "../src/modules/audit/audit.service.js";

function hashOf(seq: number, ts: Date, eventType: string, previousHash: string | null): string {
  const data = `${seq}${ts.toISOString()}${eventType}${""}${""}${"{}"}${previousHash ?? ""}`;
  return crypto.createHmac("sha256", SECRET).update(data).digest("hex");
}
function row(seq: number, previousHash: string | null, tenantId = "t1") {
  const ts = new Date(2026, 6, 1, 0, 0, seq);
  return { sequenceNumber: seq, tenantId, chainShard: 0, timestamp: ts, eventType: "X", userId: null, documentId: null, actionDetails: "{}", previousHash, entryHash: hashOf(seq, ts, "X", previousHash) };
}
const ack = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t1", sequence_number: "3", kind: "linkage", entry_hash: rows[2]?.entryHash, previous_hash: "bogus",
  reason: "Rolled-back row from the old tip race, long fixed", acknowledged_by: "user-1", acknowledged_at: new Date(), ...over,
});

beforeEach(() => {
  rows.length = 0;
  ackRows = [];
  ackReadFails = false;
  const r1 = row(1, null);
  const r2 = row(2, r1.entryHash);
  const r3 = row(3, "bogus"); // links to a row that does not exist: a linkage break at sequence 3
  rows.push(r1, r2, r3);
});

describe("audit chain: acknowledged historical breaks", () => {
  it("reports an unacknowledged break as invalid", async () => {
    const res = await verifyAuditChain(undefined, "t1");
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(3n);
    expect(res.acknowledgedBreaks).toBe(0);
    expect(res.breaks).toHaveLength(1);
    expect(res.breaks[0]).toMatchObject({ sequenceNumber: "3", kind: "linkage", previousHash: "bogus" });
  });

  it("an acknowledged break stays LISTED but no longer makes the chain invalid", async () => {
    ackRows = [ack()];
    const res = await verifyAuditChain(undefined, "t1");
    expect(res.valid).toBe(true);
    expect(res.acknowledgedBreaks).toBe(1);
    expect(res.breaks).toHaveLength(1);
    expect(res.breaks[0]!.acknowledged).toMatchObject({ by: "user-1", reason: expect.stringContaining("tip race") });
    expect(res.message).toMatch(/acknowledged/);
  });

  it("an acknowledgement stops applying when the row's stored hashes change", async () => {
    ackRows = [ack({ previous_hash: "something-else" })];
    const res = await verifyAuditChain(undefined, "t1");
    expect(res.valid).toBe(false);
    expect(res.acknowledgedBreaks).toBe(0);
  });

  it("an acknowledgement for a different kind or another tenant does not apply", async () => {
    ackRows = [ack({ kind: "hash" }), ack({ tenant_id: "t2" })];
    expect((await verifyAuditChain(undefined, "t1")).valid).toBe(false);
  });

  it("a NEW break after an acknowledged one is still reported", async () => {
    ackRows = [ack()];
    const r4 = row(4, "also-bogus");
    rows.push(r4);
    const res = await verifyAuditChain(undefined, "t1");
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(4n);
    expect(res.acknowledgedBreaks).toBe(1);
  });

  it("if the acknowledgements cannot be read the chain reads as broken, never healthier", async () => {
    ackRows = [ack()];
    ackReadFails = true;
    expect((await verifyAuditChain(undefined, "t1")).valid).toBe(false);
  });

  it("a healthy chain has no breaks and nothing acknowledged", async () => {
    rows.length = 0;
    const r1 = row(1, null);
    rows.push(r1, row(2, r1.entryHash));
    const res = await verifyAuditChain(undefined, "t1");
    expect(res).toMatchObject({ valid: true, breaks: [], acknowledgedBreaks: 0, totalVerified: 2 });
  });
});
