/**
 * The licence fetcher / holder (modules/license/license.service.ts). The two principles are the point of this file:
 *
 *   1. NO RECORD = NO ENFORCEMENT  (unconfigured, unknown)
 *   2. NEVER BLOCK BECAUSE SSO IS UNREACHABLE  (every transport failure keeps the last verified token and judges it
 *      by its own dates; only a verified, expired token can make the system read-only)
 *
 * SSO is replaced by a stubbed fetch and tokens are signed in-test; no database is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock("../src/core/logger.js", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { config } from "../src/config/env.js";
import {
  __resetLicenseForTesting,
  __setLicenseForTesting,
  buildLicenseStatus,
  getLicenseSnapshot,
  isModuleEnabled,
  isReadOnly,
  loadPersistedLicense,
  refreshLicense,
  startLicensePolling,
  stopLicensePolling,
} from "../src/modules/license/license.service.js";
import { DAY_MS } from "../src/modules/license/licenseState.js";
import { ISSUER, claims, installFetch, jsonResponse, makeKey, signLicense } from "./licenseTestKit.js";

const key = makeKey("sso-key-1");
const jwks = () => jsonResponse({ keys: [key.jwk] });
const tokenOf = (payload: Record<string, unknown> = {}) => signLicense(key, { payload });
const ok = (payload: Record<string, unknown> = {}) => () => jsonResponse({ token: tokenOf(payload) });

const FUTURE = "2099-01-01T00:00:00.000Z";
const LONG_PAST = "2020-01-01T00:00:00.000Z";

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };
let tmpDir: string;
let cacheFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-license-"));
  cacheFile = path.join(tmpDir, "dms-license.json");
  cfg.LICENSE_CACHE_PATH = cacheFile;
  cfg.LICENSE_ENFORCEMENT = "enforce";
  cfg.LICENSE_SSO_URL = "http://sso.test";
  cfg.LICENSE_POLL_SECONDS = 300;
  cfg.AUTH_ISSUER = ISSUER;
  cfg.AUTH_JWKS_URI = "http://sso.test/jwks";
  __resetLicenseForTesting();
  mockQuery.mockReset();
});

afterEach(() => {
  stopLicensePolling();
  jest.useRealTimers();
  Object.assign(cfg, original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("principle 1: no record = no enforcement", () => {
  it("a process that has never obtained a token is `unknown`: not read-only, every module on", async () => {
    installFetch({ license: new Error("ECONNREFUSED"), jwks });
    expect(await refreshLicense()).toBe("unreachable");
    const s = getLicenseSnapshot();
    expect(s.state).toBe("unknown");
    expect(isReadOnly(s)).toBe(false);
    expect(isModuleEnabled("letters", s)).toBe(true);
    expect(s.source).toBe("none");
  });

  it("SSO answering 404 (no record) is `unconfigured`: nothing enforced", async () => {
    installFetch({ license: () => jsonResponse({ error: "none" }, 404), jwks });
    expect(await refreshLicense()).toBe("no-record");
    const s = getLicenseSnapshot();
    expect(s.state).toBe("unconfigured");
    expect(isReadOnly(s)).toBe(false);
    expect(isModuleEnabled("webhooks", s)).toBe(true);
  });

  it("a record revoked in SSO (404 after a token was held) releases enforcement and forgets the persisted token", async () => {
    const fetchMock = installFetch({ license: ok({ expiresAt: LONG_PAST }), jwks });
    expect(await refreshLicense()).toBe("updated");
    expect(isReadOnly()).toBe(true);
    expect(fs.existsSync(cacheFile)).toBe(true);

    fetchMock.mockImplementation(async (input: unknown) => (String(input).includes("/licenses/public/") ? jsonResponse({}, 404) : jwks()));
    expect(await refreshLicense()).toBe("no-record");
    expect(getLicenseSnapshot().state).toBe("unconfigured");
    expect(isReadOnly()).toBe(false);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("LICENSE_ENFORCEMENT=off: no fetch at all, state unknown, never read-only", async () => {
    cfg.LICENSE_ENFORCEMENT = "off";
    const fetchMock = installFetch({ license: ok(), jwks });
    expect(await refreshLicense()).toBe("disabled");
    await startLicensePolling();
    expect(fetchMock).not.toHaveBeenCalled();
    __setLicenseForTesting({ claims: claims({ expiresAt: new Date(LONG_PAST) }) });
    const s = getLicenseSnapshot();
    expect(s.state).toBe("unknown");
    expect(isReadOnly(s)).toBe(false);
  });

  it("LICENSE_ENFORCEMENT=warn computes `expired` (the banner needs it) but is never read-only", async () => {
    cfg.LICENSE_ENFORCEMENT = "warn";
    installFetch({ license: ok({ expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    const s = getLicenseSnapshot();
    expect(s.state).toBe("expired");
    expect(isReadOnly(s)).toBe(false);
  });
});

describe("principle 2: never block because SSO is unreachable", () => {
  const failures: Array<[string, () => void]> = [
    ["connection refused", () => installFetch({ license: new Error("ECONNREFUSED"), jwks })],
    ["DNS failure", () => installFetch({ license: new Error("getaddrinfo ENOTFOUND"), jwks })],
    ["HTTP 500", () => installFetch({ license: () => new Response("boom", { status: 500 }), jwks })],
    ["HTTP 503 from a proxy", () => installFetch({ license: () => new Response("<html>bad gateway</html>", { status: 503 }), jwks })],
    ["HTTP 401/403", () => installFetch({ license: () => new Response("no", { status: 403 }), jwks })],
    ["non-JSON body", () => installFetch({ license: () => new Response("<html>login</html>", { status: 200 }), jwks })],
    ["JSON with no token", () => installFetch({ license: () => jsonResponse({ nope: 1 }), jwks })],
    ["token that does not verify", () => installFetch({ license: () => jsonResponse({ token: "a.b.c" }), jwks })],
    ["token signed by another key", () => installFetch({ license: () => jsonResponse({ token: signLicense(makeKey("sso-key-1")) }), jwks })],
    ["token for another system", () => installFetch({ license: () => jsonResponse({ token: tokenOf({ aud: "license:gms", sys: "gms" }) }), jwks })],
  ];

  it.each(failures)("%s: the last verified token is kept and still enforced by its own dates", async (_name, breakIt) => {
    installFetch({ license: ok({ ver: 3, expiresAt: LONG_PAST, maxUsers: 5, modules: ["letters"] }), jwks });
    expect(await refreshLicense()).toBe("updated");
    const before = getLicenseSnapshot();
    expect(before.state).toBe("expired");

    breakIt();
    const outcome = await refreshLicense();
    expect(["unreachable", "rejected"]).toContain(outcome);

    const after = getLicenseSnapshot();
    expect(after.state).toBe("expired");
    expect(after.claims?.ver).toBe(3);
    expect(after.claims?.maxUsers).toBe(5);
    expect(isReadOnly(after)).toBe(true);
    expect(isModuleEnabled("letters", after)).toBe(true);
    expect(isModuleEnabled("webhooks", after)).toBe(false);
  });

  it("a held, still-valid token keeps being judged by its own dates as the clock moves, with SSO down the whole time", async () => {
    installFetch({ license: ok({ expiresAt: "2030-01-01T00:00:00.000Z", graceDays: 14, warnDays: 30 }), jwks });
    await refreshLicense();
    installFetch({ license: new Error("ECONNREFUSED"), jwks: new Error("ECONNREFUSED") });
    const exp = new Date("2030-01-01T00:00:00.000Z").getTime();
    expect(getLicenseSnapshot(new Date(exp - 31 * DAY_MS)).state).toBe("active");
    expect(getLicenseSnapshot(new Date(exp - 1 * DAY_MS)).state).toBe("expiring");
    expect(getLicenseSnapshot(new Date(exp + 1 * DAY_MS)).state).toBe("grace");
    expect(getLicenseSnapshot(new Date(exp + 15 * DAY_MS)).state).toBe("expired");
    expect(await refreshLicense()).toBe("unreachable");
    expect(getLicenseSnapshot(new Date(exp + 15 * DAY_MS)).state).toBe("expired");
  });

  it("a fetch that hangs is cut off at the 5 s timeout and changes nothing", async () => {
    jest.useFakeTimers();
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const p = refreshLicense();
    await jest.advanceTimersByTimeAsync(5_001);
    expect(await p).toBe("unreachable");
    expect(getLicenseSnapshot().state).toBe("unknown");
  });

  it("refreshLicense never rejects, whatever fetch does", async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw new TypeError("synchronous explosion");
    });
    await expect(refreshLicense()).resolves.toBe("unreachable");
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ status: 200, ok: true, json: async () => { throw new Error("bad json"); } }));
    await expect(refreshLicense()).resolves.toBe("rejected");
  });

  it("concurrent refreshes share one request", async () => {
    const fetchMock = installFetch({ license: ok(), jwks });
    const [a, b] = await Promise.all([refreshLicense(), refreshLicense()]);
    expect(a).toBe(b);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/licenses/public/")).length).toBe(1);
  });

  it("JWKS unreachable while a token is being verified (cold key cache): rejected, the persisted token stays in force", async () => {
    installFetch({ license: ok({ ver: 3, expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    __resetLicenseForTesting(); // restart: memory and the JWKS cache are empty, the persisted file remains
    await loadPersistedLicense();
    installFetch({ license: ok({ ver: 4, expiresAt: FUTURE }), jwks: new Error("JWKS down") });
    expect(await refreshLicense()).toBe("rejected");
    expect(getLicenseSnapshot()).toMatchObject({ state: "expired", source: "cache" });
    expect(getLicenseSnapshot().claims?.ver).toBe(3);
  });
});

describe("versions", () => {
  it("a token with a LOWER ver than the one held is ignored", async () => {
    installFetch({ license: ok({ ver: 5, maxUsers: 10 }), jwks });
    await refreshLicense();
    installFetch({ license: ok({ ver: 4, maxUsers: 999 }), jwks });
    expect(await refreshLicense()).toBe("ignored-older");
    expect(getLicenseSnapshot().claims).toMatchObject({ ver: 5, maxUsers: 10 });
  });
  it("a higher ver replaces it; the same ver is `unchanged`", async () => {
    installFetch({ license: ok({ ver: 5, maxUsers: 10 }), jwks });
    await refreshLicense();
    installFetch({ license: ok({ ver: 5, maxUsers: 10 }), jwks });
    expect(await refreshLicense()).toBe("unchanged");
    installFetch({ license: ok({ ver: 6, maxUsers: 20 }), jwks });
    expect(await refreshLicense()).toBe("updated");
    expect(getLicenseSnapshot().claims).toMatchObject({ ver: 6, maxUsers: 20 });
  });
});

describe("persistence: a restart while SSO is down still enforces the last token", () => {
  it("writes the token after a good fetch and re-verifies it at boot with SSO down", async () => {
    installFetch({ license: ok({ ver: 2, expiresAt: LONG_PAST, modules: ["search"] }), jwks });
    await refreshLicense();
    expect(fs.existsSync(cacheFile)).toBe(true);

    // "restart": drop everything in memory, SSO and its JWKS are unreachable
    __resetLicenseForTesting();
    installFetch({ license: new Error("ECONNREFUSED"), jwks: new Error("ECONNREFUSED") });
    expect(getLicenseSnapshot().state).toBe("unknown");

    expect(await loadPersistedLicense()).toBe(true);
    const s = getLicenseSnapshot();
    expect(s.source).toBe("cache");
    expect(s.state).toBe("expired");
    expect(isReadOnly(s)).toBe(true);
    expect(isModuleEnabled("search", s)).toBe(true);
    expect(isModuleEnabled("letters", s)).toBe(false);
  });

  it("startLicensePolling loads the persisted token before (and regardless of) the first fetch", async () => {
    installFetch({ license: ok({ ver: 2, expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    __resetLicenseForTesting();
    installFetch({ license: new Error("ECONNREFUSED"), jwks: new Error("ECONNREFUSED") });
    await startLicensePolling();
    expect(getLicenseSnapshot().state).toBe("expired");
    await refreshLicense(); // the boot fetch, failing
    expect(getLicenseSnapshot().state).toBe("expired");
  });

  it("ignores a persisted file that was edited (signature no longer verifies)", async () => {
    installFetch({ license: ok({ ver: 2, expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    const saved = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    const [h, , s] = saved.token.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: "license:dms", sys: "dms", ver: 2, expiresAt: FUTURE, graceDays: 14, warnDays: 30, maxUsers: null, modules: null })).toString("base64url");
    fs.writeFileSync(cacheFile, JSON.stringify({ ...saved, token: `${h}.${forged}.${s}` }));
    __resetLicenseForTesting();
    expect(await loadPersistedLicense()).toBe(false);
    expect(getLicenseSnapshot().state).toBe("unknown");
  });

  it("ignores a persisted file signed by a key other than the one stored beside it", async () => {
    const foreign = makeKey("sso-key-1");
    fs.writeFileSync(cacheFile, JSON.stringify({ token: signLicense(foreign), jwk: key.jwk, savedAt: new Date().toISOString() }));
    expect(await loadPersistedLicense()).toBe(false);
  });

  it("ignores garbage and missing files without throwing", async () => {
    expect(await loadPersistedLicense()).toBe(false);
    fs.writeFileSync(cacheFile, "{{{ not json");
    expect(await loadPersistedLicense()).toBe(false);
    fs.writeFileSync(cacheFile, JSON.stringify({ token: 7 }));
    expect(await loadPersistedLicense()).toBe(false);
    expect(getLicenseSnapshot().state).toBe("unknown");
  });

  it("an unwritable cache path does not break fetching (the token stays in memory)", async () => {
    cfg.LICENSE_CACHE_PATH = path.join(cacheFile, "nested", "x.json"); // cacheFile does not exist as a dir; make a file there
    fs.writeFileSync(cacheFile, "i am a file, not a directory");
    installFetch({ license: ok({ ver: 2 }), jwks });
    await expect(refreshLicense()).resolves.toBe("updated");
    expect(getLicenseSnapshot().claims?.ver).toBe(2);
  });
});

describe("JWKS handling", () => {
  it("refreshes the JWKS once when the token's kid is not in the cached set (key rotation)", async () => {
    const rotated = makeKey("sso-key-2");
    const routes = { n: 0 };
    installFetch({ license: ok({ ver: 1 }), jwks });
    await refreshLicense(); // caches key 1

    (globalThis as { fetch: unknown }).fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/licenses/public/")) return jsonResponse({ token: signLicense(rotated, { payload: { ver: 2 } }) });
      routes.n++;
      return jsonResponse({ keys: [key.jwk, rotated.jwk] });
    });
    expect(await refreshLicense()).toBe("updated");
    expect(routes.n).toBe(1);
  });

  it("falls back to {LICENSE_SSO_URL}/jwks when AUTH_JWKS_URI is unset", async () => {
    cfg.AUTH_JWKS_URI = undefined;
    const fetchMock = installFetch({ license: ok(), jwks });
    await refreshLicense();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("http://sso.test/jwks");
  });

  it("asks SSO for exactly the one configured route", async () => {
    const fetchMock = installFetch({ license: ok(), jwks });
    await refreshLicense();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://sso.test/api/v1/licenses/public/dms");
  });
});

describe("polling", () => {
  it("polls at start and every LICENSE_POLL_SECONDS, and stops", async () => {
    jest.useFakeTimers();
    cfg.LICENSE_POLL_SECONDS = 60;
    const fetchMock = installFetch({ license: ok(), jwks });
    await startLicensePolling();
    await jest.advanceTimersByTimeAsync(0);
    const polls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/licenses/public/")).length;
    expect(polls()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(polls()).toBe(2);
    stopLicensePolling();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(polls()).toBe(2);
  });
});

describe("the status answer (contract section 5)", () => {
  it("has the contract's shape, with seatsUsed from the installation-wide count", async () => {
    mockQuery.mockResolvedValue([{ n: 41 }]);
    installFetch({ license: ok({ ver: 7, maxUsers: 50, modules: ["letters", "search"], expiresAt: LONG_PAST, graceDays: 14 }), jwks });
    await refreshLicense();
    const st = await buildLicenseStatus();
    expect(st).toMatchObject({
      system: "dms",
      state: "expired",
      customer: "Example Corp",
      expiresAt: new Date(LONG_PAST).toISOString(),
      warnDays: 30,
      graceDays: 14,
      readOnly: true,
      maxUsers: 50,
      seatsUsed: 41,
      modules: ["letters", "search"],
      source: "sso",
      version: 7,
      enforcement: "enforce",
    });
    expect(st.graceEndsAt).toBe(new Date(new Date(LONG_PAST).getTime() + 14 * DAY_MS).toISOString());
    expect(st.daysRemaining).toBeLessThan(0);
    expect(typeof st.fetchedAt).toBe("string");
  });

  it("an unconfigured system reports nulls and is not read-only", async () => {
    mockQuery.mockResolvedValue([{ n: 3 }]);
    __setLicenseForTesting({ claims: null, noRecord: true });
    const st = await buildLicenseStatus();
    expect(st).toMatchObject({ state: "unconfigured", readOnly: false, maxUsers: null, modules: null, expiresAt: null, version: null, source: "none", fetchedAt: null });
  });

  it("a failing seat count does not fail the status answer", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    __setLicenseForTesting({ claims: null });
    const st = await buildLicenseStatus();
    expect(st.seatsUsed).toBeNull();
    expect(st.state).toBe("unknown");
  });
});
