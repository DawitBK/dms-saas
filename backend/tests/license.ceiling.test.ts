/**
 * The "SSO ends on this date" note (modules/license/licenseCeiling.ts) and how the holder uses it with an OFFLINE licence: DMS ends at the EARLIER of its own
 * licence date and SSO's, the note can never extend anything, and blocking SSO cannot bring an ended system back. SSO is a stubbed fetch; no database.
 */
import crypto from "node:crypto";
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
  buildLicenseStatus,
  getLicenseSnapshot,
  installLicense,
  loadPersistedCeiling,
  loadPersistedLicense,
  refreshLicense,
  stopLicensePolling,
} from "../src/modules/license/license.service.js";
import { applyCeiling, verifyCeilingToken } from "../src/modules/license/licenseCeiling.js";
import { ISSUER, claims, jsonResponse, makeKey, signLicense, type TestKey } from "./licenseTestKit.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function signCeiling(key: TestKey, payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const h = { alg: "RS256", typ: "kcms-license-ceiling+jwt", kid: key.kid, ...header };
  const p = {
    iss: ISSUER, aud: "license:ceiling", sys: "sso", ver: 1, iat: 1_700_000_000, customer: "Example Corp",
    expiresAt: "2099-01-01T00:00:00.000Z", graceDays: 14, warnDays: 30, jti: "sso-ceiling-v1", ...payload,
  };
  const input = `${b64(h)}.${b64(p)}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

const ssoKey = makeKey("sso-oidc-key");
const ownerKey = makeKey("owner-licence-key");

type Answer = { status: number; body: unknown } | "throw" | undefined;
const sso: { ceiling: Answer; license: Answer } = { ceiling: undefined, license: undefined };
function installSso(): jest.Mock {
  const mock = jest.fn(async (input: unknown) => {
    const url = String(input);
    const answer = (a: Answer) => {
      if (a === "throw") throw new Error("ECONNREFUSED");
      return jsonResponse(a?.body ?? { error: "invalid_request" }, a?.status ?? 404);
    };
    if (url.includes("/licenses/public/sso-expiry")) return answer(sso.ceiling);
    if (url.includes("/licenses/public/")) return answer(sso.license);
    return jsonResponse({ keys: [ssoKey.jwk] });
  });
  (globalThis as { fetch: unknown }).fetch = mock;
  return mock;
}
const note = (over: Record<string, unknown> = {}) => { sso.ceiling = { status: 200, body: { token: signCeiling(ssoKey, over) } }; };
const installOffline = async (over: Record<string, unknown> = {}) => {
  const out = await installLicense(signLicense(ownerKey, { payload: { expiresAt: "2027-12-31T23:59:59.999Z", ...over } }));
  expect(out.outcome).toBe("updated");
};

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-ceiling-"));
  cfg.LICENSE_CACHE_PATH = path.join(tmpDir, "dms-license.json");
  cfg.LICENSE_ENFORCEMENT = "enforce";
  cfg.LICENSE_SSO_URL = "http://sso.test";
  cfg.LICENSE_POLL_SECONDS = 300;
  cfg.AUTH_ISSUER = ISSUER;
  cfg.AUTH_JWKS_URI = "http://sso.test/jwks";
  cfg.LICENSE_REQUIRED = true;
  cfg.LICENSE_TRUST_PUBLIC_KEYS = JSON.stringify([ownerKey.jwk]);
  // the `sso` deployment mode: DMS's own sign-in through SSO is configured
  cfg.OIDC_CLIENT_ID = "edams";
  cfg.OIDC_CLIENT_SECRET = "secret";
  cfg.OIDC_REDIRECT_URI = "http://localhost/dms/auth/callback";
  sso.ceiling = undefined;
  sso.license = undefined;
  __resetLicenseForTesting();
  mockQuery.mockReset();
  installSso();
});

afterEach(() => {
  stopLicensePolling();
  Object.assign(cfg, original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("applyCeiling: the earlier of the licence and SSO, never later than the licence", () => {
  const ceilingOf = (over = {}) => ({ iss: ISSUER, ver: 1, iat: null, customer: null, expiresAt: new Date("2026-12-31T23:59:59.999Z"), graceDays: 3, warnDays: 9, jti: null, ...over });
  it("no note or an SSO that never expires: untouched", () => {
    const c = claims({ expiresAt: new Date("2030-01-01") });
    expect(applyCeiling(c, null)).toEqual({ claims: c, limitedBy: "licence" });
    expect(applyCeiling(c, ceilingOf({ expiresAt: null }))).toEqual({ claims: c, limitedBy: "licence" });
  });
  it("SSO ends first: SSO's date, grace and warning days apply; a perpetual licence ends with SSO", () => {
    for (const own of [new Date("2030-01-01"), null]) {
      const out = applyCeiling(claims({ expiresAt: own, maxUsers: 50 }), ceilingOf());
      expect(out.limitedBy).toBe("sso");
      expect(out.claims).toMatchObject({ expiresAt: new Date("2026-12-31T23:59:59.999Z"), graceDays: 3, warnDays: 9, maxUsers: 50 });
    }
  });
  it("the licence ends first or at the same instant: its own dates count (a note can never extend)", () => {
    const c = claims({ expiresAt: new Date("2026-06-30"), graceDays: 14 });
    expect(applyCeiling(c, ceilingOf())).toEqual({ claims: c, limitedBy: "licence" });
    expect(applyCeiling(claims({ expiresAt: new Date("2026-12-31T23:59:59.999Z") }), ceilingOf()).limitedBy).toBe("licence");
  });
  it("SSO's grace days never carry the system past the end of its own grace period (a note only shortens)", () => {
    const c = claims({ expiresAt: new Date("2027-03-31T23:59:59.999Z"), graceDays: 3 });
    const out = applyCeiling(c, ceilingOf({ expiresAt: new Date("2027-03-30T23:59:59.999Z"), graceDays: 30 }));
    expect(out.limitedBy).toBe("sso");
    expect(out.claims.graceDays).toBe(4);
    expect(out.claims.expiresAt!.getTime() + out.claims.graceDays * 86_400_000).toBeLessThanOrEqual(c.expiresAt!.getTime() + 3 * 86_400_000);
    // a perpetual licence has no own hard stop to respect: SSO's grace days apply as given
    expect(applyCeiling(claims({ expiresAt: null }), ceilingOf({ graceDays: 30 })).claims.graceDays).toBe(30);
  });
  it("a licence that may also run standalone keeps its own dates: only an SSO-only licence ends with SSO", () => {
    const c = claims({ expiresAt: new Date("2030-01-01"), modes: ["sso", "standalone"] });
    expect(applyCeiling(c, ceilingOf())).toEqual({ claims: c, limitedBy: "licence" });
    expect(applyCeiling(claims({ expiresAt: new Date("2030-01-01"), modes: ["sso"] }), ceilingOf()).limitedBy).toBe("sso");
  });
});

describe("verifyCeilingToken", () => {
  const verify = (token: string) => verifyCeilingToken(token, { issuer: ISSUER, resolveKey: (kid) => (kid === ssoKey.kid ? ssoKey.publicKey : null) });
  it("accepts a note signed by the key in SSO's JWKS", async () => {
    expect(await verify(signCeiling(ssoKey, { ver: 9, expiresAt: "2027-01-01T00:00:00.000Z" }))).toMatchObject({ ok: true, claims: { ver: 9, expiresAt: new Date("2027-01-01T00:00:00.000Z") } });
    expect(await verify(signCeiling(ssoKey, { expiresAt: null }))).toMatchObject({ ok: true, claims: { expiresAt: null } });
  });
  it.each([
    ["a different key under the same kid", () => signCeiling(makeKey("sso-oidc-key"))],
    ["a client licence audience", () => signCeiling(ssoKey, { aud: "license:dms" })],
    ["the wrong system", () => signCeiling(ssoKey, { sys: "dms" })],
    ["the wrong issuer", () => signCeiling(ssoKey, { iss: "http://evil.test" })],
    ["the licence typ", () => signCeiling(ssoKey, {}, { typ: "kcms-license+jwt" })],
    ["a non-RS256 alg", () => signCeiling(ssoKey, {}, { alg: "HS256" })],
    ["graceDays out of range", () => signCeiling(ssoKey, { graceDays: 400 })],
    ["a malformed expiresAt", () => signCeiling(ssoKey, { expiresAt: "soon" })],
    ["a licence token", () => signLicense(ssoKey)],
  ])("rejects %s", async (_l, make) => {
    expect((await verify(make())).ok).toBe(false);
  });
});

describe("the holder follows SSO's note while holding an OFFLINE licence", () => {
  it("before any note: the licence's own date; after a note that ends sooner: SSO's date, grace and warning days", async () => {
    await installOffline();
    await refreshLicense();
    expect(getLicenseSnapshot()).toMatchObject({ state: "active", limitedBy: "licence" });
    note({ ver: 5, expiresAt: "2026-10-19T00:00:00.000Z", graceDays: 3, warnDays: 9 });
    await refreshLicense();
    const s = getLicenseSnapshot(new Date("2026-10-19T12:00:00.000Z"));
    expect(s).toMatchObject({ state: "grace", limitedBy: "sso" });
    expect(s.claims?.expiresAt?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(getLicenseSnapshot(new Date("2026-10-23T00:00:00.000Z")).state).toBe("expired");
    const status = await buildLicenseStatus(new Date("2026-10-23T00:00:00.000Z"));
    expect(status).toMatchObject({ limitedBy: "sso", readOnly: true, expiresAt: "2026-10-19T00:00:00.000Z" });
  });

  it("a note signed by anything but SSO's published key is ignored", async () => {
    await installOffline();
    sso.ceiling = { status: 200, body: { token: signCeiling(makeKey("sso-oidc-key"), { expiresAt: "2020-01-01T00:00:00.000Z" }) } };
    await refreshLicense();
    expect(getLicenseSnapshot().limitedBy).toBe("licence");
  });

  it("a note can never extend: SSO renewed beyond the licence leaves the licence's own date in force", async () => {
    await installOffline({ expiresAt: "2026-11-30T00:00:00.000Z" });
    note({ ver: 2, expiresAt: "2031-01-01T00:00:00.000Z" });
    await refreshLicense();
    const s = getLicenseSnapshot(new Date("2026-10-19T00:00:00.000Z"));
    expect(s.limitedBy).toBe("licence");
    expect(s.claims?.expiresAt?.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("SSO unreachable, an error or garbage: the last note keeps ending the system", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    expect(getLicenseSnapshot().state).toBe("expired");
    for (const answer of ["throw", { status: 500, body: {} }, { status: 200, body: { token: "garbage" } }] as Answer[]) {
      sso.ceiling = answer;
      await refreshLicense();
      expect(getLicenseSnapshot().state).toBe("expired");
    }
  });

  it("survives a restart while SSO is down (the note is cached and re-verified against the key stored with it)", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    __resetLicenseForTesting();
    sso.ceiling = "throw";
    expect(await loadPersistedLicense()).toBe(true);
    expect(await loadPersistedCeiling()).toBe(true);
    expect(getLicenseSnapshot()).toMatchObject({ state: "expired", limitedBy: "sso" });
  });

  it("an edited cache file is not believed", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    const file = `${path.join(tmpDir, "dms-license.json")}.sso-expiry`;
    const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
    const [h, , s] = saved.token.split(".");
    saved.token = `${h}.${b64({ iss: ISSUER, aud: "license:ceiling", sys: "sso", ver: 5, expiresAt: "2001-01-01T00:00:00.000Z", graceDays: 0, warnDays: 0 })}.${s}`;
    fs.writeFileSync(file, JSON.stringify(saved));
    __resetLicenseForTesting();
    await loadPersistedLicense();
    expect(await loadPersistedCeiling()).toBe(false);
    expect(getLicenseSnapshot().limitedBy).toBe("licence");
  });

  it("an older note does not replace a newer one (a replayed, later-dated note changes nothing)", async () => {
    await installOffline();
    note({ ver: 9, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    note({ ver: 3, expiresAt: "2029-01-01T00:00:00.000Z" });
    await refreshLicense();
    expect(getLicenseSnapshot().state).toBe("expired");
  });

  it("SSO's 'no licence' answer drops the note; an SSO without the route does not", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    sso.ceiling = undefined; // the generic 404 of an SSO that does not know the route
    await refreshLicense();
    expect(getLicenseSnapshot().limitedBy).toBe("sso");
    sso.ceiling = { status: 404, body: { error: { code: "ERR-LICENSE-NOT-FOUND" } } };
    await refreshLicense();
    expect(getLicenseSnapshot().limitedBy).toBe("licence");
    expect(fs.existsSync(`${path.join(tmpDir, "dms-license.json")}.sso-expiry`)).toBe(false);
  });

  it("a JSON 404 that is not SSO's own 'no licence' answer (a gateway, a proxy, an SSO mid-update) keeps the note", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z", graceDays: 0 });
    await refreshLicense();
    for (const body of [{ error: { code: "ERR-SOMETHING-ELSE" } }, { message: "Not Found" }, { error: "not_found" }]) {
      sso.ceiling = { status: 404, body };
      await refreshLicense();
      expect(getLicenseSnapshot().limitedBy).toBe("sso");
    }
    expect(fs.existsSync(`${path.join(tmpDir, "dms-license.json")}.sso-expiry`)).toBe(true);
  });

  it("an SSO that never expires limits nothing", async () => {
    await installOffline();
    note({ ver: 5, expiresAt: null });
    await refreshLicense();
    expect(getLicenseSnapshot().limitedBy).toBe("licence");
  });

  it("a standalone deployment (no SSO sign-in configured) never asks SSO for the note", async () => {
    cfg.OIDC_CLIENT_ID = undefined;
    const fetchMock = installSso();
    await installOffline();
    note({ ver: 5, expiresAt: "2026-10-01T00:00:00.000Z" });
    await refreshLicense();
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith("sso-expiry"))).toEqual([]);
    expect(getLicenseSnapshot().limitedBy).toBe("licence");
  });

  it("LICENSE_ENFORCEMENT=off: no fetch at all", async () => {
    cfg.LICENSE_ENFORCEMENT = "off";
    const fetchMock = installSso();
    expect(await refreshLicense()).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
