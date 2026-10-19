/**
 * The licence state function (modules/license/licenseState.ts), contract section 3. Every boundary is exercised
 * at the exact millisecond on both sides, because off-by-one here is the difference between a banner and a lockout.
 */
import { computeLicenseState, DAY_MS, type LicenseTerms } from "../src/modules/license/licenseState.js";

const EXPIRES = new Date("2027-01-01T00:00:00.000Z");
const T = EXPIRES.getTime();
const terms = (over: Partial<LicenseTerms> = {}): LicenseTerms => ({ expiresAt: EXPIRES, graceDays: 14, warnDays: 30, ...over });
const at = (ms: number) => new Date(ms);
const state = (ms: number, t: LicenseTerms = terms()) => computeLicenseState(t, at(ms)).state;

describe("no licence, no enforcement", () => {
  it("is unconfigured when there is no record", () => {
    expect(computeLicenseState(null, at(T))).toEqual({ state: "unconfigured", daysRemaining: null, graceEndsAt: null });
  });
  it("is unknown when this process never obtained a token", () => {
    expect(computeLicenseState(null, at(T), "unknown")).toEqual({ state: "unknown", daysRemaining: null, graceEndsAt: null });
  });
  it("neither of the two is ever expired, however late the clock", () => {
    expect(computeLicenseState(null, at(T * 2), "unconfigured").state).toBe("unconfigured");
    expect(computeLicenseState(null, at(T * 2), "unknown").state).toBe("unknown");
  });
});

describe("a perpetual licence", () => {
  it("is active forever and has no days or grace end", () => {
    const r = computeLicenseState(terms({ expiresAt: null }), at(T * 10));
    expect(r).toEqual({ state: "active", daysRemaining: null, graceEndsAt: null });
  });
});

describe("boundaries (warn 30 days, grace 14 days)", () => {
  const warnStart = T - 30 * DAY_MS;
  const graceEnd = T + 14 * DAY_MS;

  it("active up to the last millisecond before the warning window", () => {
    expect(state(warnStart - 1)).toBe("active");
  });
  it("expiring at exactly expires - warnDays (inclusive)", () => {
    expect(state(warnStart)).toBe("expiring");
  });
  it("expiring up to the last millisecond before expiry", () => {
    expect(state(T - 1)).toBe("expiring");
  });
  it("grace at exactly expires_at (inclusive)", () => {
    expect(state(T)).toBe("grace");
  });
  it("grace up to the last millisecond before the grace end", () => {
    expect(state(graceEnd - 1)).toBe("grace");
  });
  it("expired at exactly expires_at + graceDays (inclusive)", () => {
    expect(state(graceEnd)).toBe("expired");
  });
  it("expired from then on, however late", () => {
    expect(state(graceEnd + 365 * DAY_MS)).toBe("expired");
  });
  it("graceEndsAt is expires_at + graceDays in every state", () => {
    for (const ms of [warnStart - 1, T - 1, T, graceEnd]) {
      expect(computeLicenseState(terms(), at(ms)).graceEndsAt).toEqual(new Date(graceEnd));
    }
  });
});

describe("zero-length windows", () => {
  it("warnDays 0: no expiring state, active straight into grace at expiry", () => {
    const t = terms({ warnDays: 0 });
    expect(state(T - 1, t)).toBe("active");
    expect(state(T, t)).toBe("grace");
  });
  it("graceDays 0: no grace state, expiring straight into expired at expiry", () => {
    const t = terms({ graceDays: 0 });
    expect(state(T - 1, t)).toBe("expiring");
    expect(state(T, t)).toBe("expired");
  });
  it("both 0: active, then expired, at the exact instant", () => {
    const t = terms({ warnDays: 0, graceDays: 0 });
    expect(state(T - 1, t)).toBe("active");
    expect(state(T, t)).toBe("expired");
  });
  it("maximum windows (365) work", () => {
    const t = terms({ warnDays: 365, graceDays: 365 });
    expect(state(T - 365 * DAY_MS - 1, t)).toBe("active");
    expect(state(T - 365 * DAY_MS, t)).toBe("expiring");
    expect(state(T + 365 * DAY_MS - 1, t)).toBe("grace");
    expect(state(T + 365 * DAY_MS, t)).toBe("expired");
  });
});

describe("daysRemaining (whole days, truncated toward zero, as in SSO's state.ts)", () => {
  const days = (ms: number) => computeLicenseState(terms(), at(ms)).daysRemaining;
  it("counts whole days before expiry", () => {
    expect(days(T - 30 * DAY_MS)).toBe(30);
    expect(days(T - 30 * DAY_MS + 1)).toBe(29);
    expect(days(T - 1)).toBe(0);
  });
  it("is 0 within a day either side of expiry (never -0), and negative from a full day after", () => {
    expect(days(T)).toBe(0);
    expect(Object.is(days(T), 0)).toBe(true);
    expect(days(T + 1)).toBe(0);
    expect(Object.is(days(T + 1), 0)).toBe(true);
    expect(days(T + DAY_MS - 1)).toBe(0);
    expect(days(T + DAY_MS)).toBe(-1);
    expect(days(T + 3 * DAY_MS)).toBe(-3);
    expect(days(T + 3 * DAY_MS + 1)).toBe(-3);
    expect(days(T + 3.9 * DAY_MS)).toBe(-3);
  });
});
