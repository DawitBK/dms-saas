/**
 * The seat race, against a REAL Postgres: simultaneous creations at limit-1 must let exactly one through.
 *
 * Everything runs in a throw-away database created for this file (`dms_seat_race_<pid>`) and dropped at the
 * end; no application database (dev, mirror, production) is touched. If no Postgres is reachable on
 * TEST_PG_HOST/PORT/USER/PASSWORD (default localhost:5432, postgres/change-me-dev-password, the dev server's) the tests
 * log that and pass vacuously, like the rest of this hermetic suite would on a machine with no database.
 *
 * Only the pieces licenseSeats.ts touches are stubbed: the sequelize handle (pointed at the scratch DB) and
 * runInTransaction (a real transaction on that handle, as in a worker or script; in a request the ambient
 * transaction takes its place and the lock simply lives until the request's commit).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { QueryTypes, Sequelize, type Transaction } from "sequelize";

const holder: { sequelize?: Sequelize } = {};
const mockHolder = holder;

jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  get sequelize() {
    return mockHolder.sequelize;
  },
}));
jest.mock("../src/shared/transaction.js", () => ({
  runInTransaction: (fn: (tx: Transaction) => Promise<unknown>) => mockHolder.sequelize!.transaction(fn),
}));
jest.mock("../src/shared/platformAdmin.js", () => ({
  notPlatformAdminSql: () => "1=1",
  getPlatformAdminUserIds: jest.fn().mockResolvedValue([]),
}));
jest.mock("../src/core/logger.js", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { config } from "../src/config/env.js";
import * as service from "../src/modules/license/license.service.js";
import { assertSeatAvailable, withSeatGuard } from "../src/modules/license/licenseSeats.js";
import { claims } from "./licenseTestKit.js";

const PG = {
  host: process.env.TEST_PG_HOST ?? "localhost",
  port: Number(process.env.TEST_PG_PORT ?? 5432),
  user: process.env.TEST_PG_USER ?? "postgres",
  password: process.env.TEST_PG_PASSWORD ?? "change-me-dev-password",
};
const DB_NAME = `dms_seat_race_${process.pid}`;
const cfg = config as unknown as Record<string, unknown>;
const originalMode = cfg.LICENSE_ENFORCEMENT;
const future = new Date(Date.now() + 200 * 86_400_000);

let ready = false;
let admin: Client | undefined;

async function insertActiveUser(tx?: Transaction) {
  await holder.sequelize!.query("INSERT INTO users (id, email, is_active) VALUES (:id, :email, true)", {
    replacements: { id: randomUUID(), email: `${randomUUID()}@race.test` },
    transaction: tx,
  });
}
async function activeCount(): Promise<number> {
  const rows = await holder.sequelize!.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE is_active = true", {
    type: QueryTypes.SELECT,
  });
  return rows[0].n;
}
async function reset(existing: number) {
  await holder.sequelize!.query("TRUNCATE users");
  for (let i = 0; i < existing; i++) await insertActiveUser();
}
const limit = (maxUsers: number | null) =>
  service.__setLicenseForTesting({ claims: claims({ expiresAt: future, maxUsers }) });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    admin = new Client({ ...PG, database: "postgres" });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    holder.sequelize = new Sequelize({ dialect: "postgres", host: PG.host, port: PG.port, username: PG.user, password: PG.password, database: DB_NAME, logging: false, pool: { max: 30 } });
    await holder.sequelize.query(
      "CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, is_active boolean NOT NULL, deleted_at timestamptz)",
    );
    ready = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`license.seatRace: no usable Postgres (${(err as Error).message}); the race tests pass vacuously.`);
    await holder.sequelize?.close().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    admin = undefined;
  }
});

afterAll(async () => {
  cfg.LICENSE_ENFORCEMENT = originalMode;
  await holder.sequelize?.close().catch(() => undefined);
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

beforeEach(() => {
  service.__resetLicenseForTesting();
  cfg.LICENSE_ENFORCEMENT = "enforce";
});

const CONTENDERS = 10;
const createGuarded = () =>
  withSeatGuard({ via: "race-test" }, async (tx) => {
    await pause(30); // widen the window between the count and the insert
    await insertActiveUser(tx);
  });

describe("simultaneous creations at limit-1 (real Postgres)", () => {
  it("control: WITHOUT the lock the same race overshoots (proves the scenario is real)", async () => {
    if (!ready) return;
    await reset(4);
    limit(5);
    const unguarded = async () => {
      await assertSeatAvailable({ via: "race-control" });
      await pause(30);
      await insertActiveUser();
    };
    const results = await Promise.allSettled(Array.from({ length: CONTENDERS }, unguarded));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(1);
    expect(await activeCount()).toBeGreaterThan(5);
  });

  it("with withSeatGuard exactly one of N concurrent creations succeeds; the rest are LICENSE_SEAT_LIMIT", async () => {
    if (!ready) return;
    await reset(4);
    limit(5);
    const results = await Promise.allSettled(Array.from({ length: CONTENDERS }, createGuarded));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(CONTENDERS - 1);
    for (const r of refused) expect(r.reason).toMatchObject({ statusCode: 403, code: "LICENSE_SEAT_LIMIT" });
    expect(await activeCount()).toBe(5);
  });

  it("with k free seats exactly k succeed", async () => {
    if (!ready) return;
    await reset(2);
    limit(5); // 3 free
    const results = await Promise.allSettled(Array.from({ length: CONTENDERS }, createGuarded));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await activeCount()).toBe(5);
  });

  it("a refused attempt releases the lock (a later attempt after a seat frees up goes through)", async () => {
    if (!ready) return;
    await reset(5);
    limit(5);
    await expect(createGuarded()).rejects.toMatchObject({ code: "LICENSE_SEAT_LIMIT" });
    await holder.sequelize!.query("UPDATE users SET is_active = false WHERE id = (SELECT id FROM users LIMIT 1)");
    await expect(createGuarded()).resolves.toBeUndefined();
    expect(await activeCount()).toBe(5);
  });

  it("a write that fails after the check rolls back with the lock and the next contender is not blocked", async () => {
    if (!ready) return;
    await reset(4);
    limit(5);
    await expect(
      withSeatGuard({ via: "race-test" }, async () => {
        throw new Error("insert failed");
      }),
    ).rejects.toThrow("insert failed");
    await expect(createGuarded()).resolves.toBeUndefined();
    expect(await activeCount()).toBe(5);
  });
});

describe("no limit in force: no lock, no count", () => {
  for (const [name, arrange] of [
    ["unlimited licence (maxUsers null)", () => limit(null)],
    ["no licence record (unconfigured)", () => service.__setLicenseForTesting({ claims: null, noRecord: true })],
    ["never fetched (unknown)", () => service.__setLicenseForTesting({ claims: null })],
    ["LICENSE_ENFORCEMENT=off", () => { cfg.LICENSE_ENFORCEMENT = "off"; limit(1); }],
  ] as const) {
    it(`${name}: all creations succeed and no advisory-lock or count statement is issued`, async () => {
      if (!ready) return;
      await reset(3);
      arrange();
      const spy = jest.spyOn(holder.sequelize!, "query");
      try {
        const results = await Promise.allSettled(Array.from({ length: 5 }, createGuarded));
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
        const sqls = spy.mock.calls.map((c) => String(c[0]));
        expect(sqls.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(false);
        expect(sqls.some((s) => s.includes("count(*)"))).toBe(false);
      } finally {
        spy.mockRestore();
      }
      expect(await activeCount()).toBe(8);
    });
  }

  it("LICENSE_ENFORCEMENT=warn: counts and logs but takes no lock and refuses nothing", async () => {
    if (!ready) return;
    await reset(5);
    limit(5);
    cfg.LICENSE_ENFORCEMENT = "warn";
    const spy = jest.spyOn(holder.sequelize!, "query");
    try {
      await expect(createGuarded()).resolves.toBeUndefined();
      expect(spy.mock.calls.some((c) => String(c[0]).includes("pg_advisory_xact_lock"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
