/**
 * Seat limit (modules/license/licenseSeats.ts): creating or activating beyond `maxUsers` is refused with
 * 403 LICENSE_SEAT_LIMIT; nothing else is ever refused, existing users are never touched, platform
 * administrators are outside both the count and the refusal.
 */
const PA = "00000000-0000-0000-0000-00000000aaaa";
const USER = "00000000-0000-0000-0000-00000000bbbb";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock("../src/core/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { config } from "../src/config/env.js";
import { invalidatePlatformAdminCache } from "../src/shared/platformAdmin.js";
import * as service from "../src/modules/license/license.service.js";
import { assertSeatAvailable } from "../src/modules/license/licenseSeats.js";
import { claims } from "./licenseTestKit.js";

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };
const future = new Date(Date.now() + 200 * 86_400_000);
const past = new Date(Date.now() - 400 * 86_400_000);

/** `users` rows counted by the seat query; the platform-admin lookup answers PA. */
function db(used: number) {
  mockQuery.mockImplementation(async (sql: string, opts?: { transaction?: unknown }) => {
    if (sql.includes("count(*)")) {
      expect(opts?.transaction).toBeNull(); // own connection: not narrowed to the request's tenant by RLS
      return [{ n: used }];
    }
    return [{ user_id: PA }];
  });
}
const countCalls = () => mockQuery.mock.calls.filter((c) => String(c[0]).includes("count(*)")).length;

beforeEach(() => {
  mockQuery.mockReset();
  invalidatePlatformAdminCache();
  service.__resetLicenseForTesting();
  cfg.LICENSE_ENFORCEMENT = "enforce";
});
afterEach(() => Object.assign(cfg, original));

const withLimit = (maxUsers: number | null, extra: Parameters<typeof claims>[0] = {}) =>
  service.__setLicenseForTesting({ claims: claims({ expiresAt: future, maxUsers, ...extra }) });

describe("refusal", () => {
  it("refuses at exactly the limit (used >= max) with 403 LICENSE_SEAT_LIMIT", async () => {
    db(50);
    withLimit(50);
    await expect(assertSeatAvailable({ via: "t" })).rejects.toMatchObject({
      statusCode: 403,
      code: "LICENSE_SEAT_LIMIT",
      details: { maxUsers: 50, seatsUsed: 50 },
    });
  });
  it("refuses beyond the limit too (a limit lowered below the current headcount refuses new seats, removes none)", async () => {
    db(80);
    withLimit(50);
    await expect(assertSeatAvailable({ via: "t" })).rejects.toMatchObject({ code: "LICENSE_SEAT_LIMIT" });
  });
  it("allows the last free seat (used = max - 1)", async () => {
    db(49);
    withLimit(50);
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
  });
  it("applies in every state except unconfigured/unknown: still refuses while expired", async () => {
    db(5);
    withLimit(5, { expiresAt: past });
    await expect(assertSeatAvailable({ via: "t" })).rejects.toMatchObject({ code: "LICENSE_SEAT_LIMIT" });
  });
  it("refusing an ACTIVATION names the account but counts the same way", async () => {
    db(5);
    withLimit(5);
    await expect(assertSeatAvailable({ userId: USER, via: "users.activate" })).rejects.toMatchObject({ code: "LICENSE_SEAT_LIMIT" });
  });
});

describe("never refuses", () => {
  it("no licence record (unconfigured): no refusal and not even a count query", async () => {
    db(1_000);
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("never fetched (unknown): no refusal, no query", async () => {
    db(1_000);
    service.__setLicenseForTesting({ claims: null });
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("unlimited (maxUsers null): no refusal, no query", async () => {
    db(1_000);
    withLimit(null);
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
    expect(countCalls()).toBe(0);
  });
  it("LICENSE_ENFORCEMENT=off: no refusal, no query", async () => {
    cfg.LICENSE_ENFORCEMENT = "off";
    db(1_000);
    withLimit(1);
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("LICENSE_ENFORCEMENT=warn: logs but lets the account through", async () => {
    cfg.LICENSE_ENFORCEMENT = "warn";
    db(1_000);
    withLimit(1);
    await expect(assertSeatAvailable({ via: "t" })).resolves.toBeUndefined();
  });
  it("a platform administrator is outside the refusal (and no count is taken for them)", async () => {
    db(50);
    withLimit(50);
    await expect(assertSeatAvailable({ userId: PA, via: "users.activate" })).resolves.toBeUndefined();
    expect(countCalls()).toBe(0);
  });
});

describe("the count", () => {
  it("excludes platform administrators and soft-deleted/inactive accounts, across the installation", async () => {
    db(7);
    expect(await service.countSeatsUsed()).toBe(7);
    const sql = String(mockQuery.mock.calls.find((c) => String(c[0]).includes("count(*)"))![0]);
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("PLATFORM_ADMIN"); // notPlatformAdminSql
    expect(sql).not.toMatch(/tenant/i); // installation-wide, not per tenant
  });
});
