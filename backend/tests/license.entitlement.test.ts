/**
 * Per-application ENTITLEMENT (docs/operations/PLATFORM-LICENSING.md section 9), the service half:
 *   - the pure entitlement function (table),
 *   - the claims added to the token (modes, jti),
 *   - the deployment mode DMS computes from its own SSO configuration,
 *   - who may sign: the pinned LICENSE_TRUST_PUBLIC_KEYS (the ONLY keys when required) versus SSO's JWKS,
 *   - POST /license/install's logic (installLicense), never lowering `ver`, persisted across a restart,
 *   - the SSO 404 drop (revocation) and the transport failures that must never drop anything,
 *   - the boot-time ERROR reports and the status payload.
 * SSO is a stubbed fetch, tokens are signed in-test, no database is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("../src/core/logger.js", () => ({ logger: mockLogger }));

import { config } from "../src/config/env.js";
import {
  __resetLicenseForTesting,
  __setLicenseForTesting,
  buildLicenseStatus,
  deploymentMode,
  getLicenseSnapshot,
  installLicense,
  loadPersistedLicense,
  logLicenseStartupChecks,
  refreshLicense,
  trustedKeys,
} from "../src/modules/license/license.service.js";
import { computeEntitlement, type EntitlementInput } from "../src/modules/license/licenseEntitlement.js";
import { parseLicenseClaims } from "../src/modules/license/licenseToken.js";
import { ISSUER, claims, defaultPayload, installFetch, jsonResponse, makeKey, signLicense } from "./licenseTestKit.js";

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };

// `pinned` is the licence-signing key the owner trusts; `sso` is SSO's own OIDC key (only in the JWKS).
const pinned = makeKey("licence-key-1");
const sso = makeKey("sso-key-1");
const stranger = makeKey("licence-key-1"); // same kid as `pinned`, different key material

const jwks = () => jsonResponse({ keys: [sso.jwk] });
const signedBy = (key: ReturnType<typeof makeKey>, payload: Record<string, unknown> = {}) => signLicense(key, { payload });
const served = (key: ReturnType<typeof makeKey>, payload: Record<string, unknown> = {}) => () => jsonResponse({ token: signedBy(key, payload) });
const trust = (...keys: Array<ReturnType<typeof makeKey>>) => JSON.stringify(keys.map((k) => k.jwk));

const FUTURE = "2099-01-01T00:00:00.000Z";
const LONG_PAST = "2020-01-01T00:00:00.000Z";

let tmpDir: string;
let cacheFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-license-ent-"));
  cacheFile = path.join(tmpDir, "dms-license.json");
  cfg.LICENSE_CACHE_PATH = cacheFile;
  cfg.LICENSE_ENFORCEMENT = "enforce";
  cfg.LICENSE_SSO_URL = "http://sso.test";
  cfg.LICENSE_POLL_SECONDS = 300;
  cfg.AUTH_ISSUER = ISSUER;
  cfg.AUTH_JWKS_URI = "http://sso.test/jwks";
  cfg.LICENSE_REQUIRED = true;
  cfg.LICENSE_TRUST_PUBLIC_KEYS = trust(pinned);
  // an SSO deployment unless a test says otherwise
  cfg.OIDC_CLIENT_ID = "edams";
  cfg.OIDC_CLIENT_SECRET = "secret";
  cfg.OIDC_REDIRECT_URI = "http://localhost:7101/auth/callback";
  __resetLicenseForTesting();
  mockQuery.mockReset();
  Object.values(mockLogger).forEach((f) => f.mockClear());
});

afterEach(() => {
  Object.assign(cfg, original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const jwksCalls = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/jwks")).length;

// ── the pure function ──────────────────────────────────────────────────────────────────────────────────────────

describe("computeEntitlement (pure)", () => {
  const base: EntitlementInput = { required: true, state: "active", modes: ["sso"], deployment: "sso" };
  const table: Array<[string, EntitlementInput, { licensed: boolean; reason: string | null }]> = [
    ["not required: always licensed, even with no token", { ...base, required: false, state: "unconfigured", modes: null }, { licensed: true, reason: null }],
    ["not required: always licensed, even with the wrong mode", { ...base, required: false, modes: ["standalone"] }, { licensed: true, reason: null }],
    ["required, unconfigured: NO_LICENSE", { ...base, state: "unconfigured", modes: null }, { licensed: false, reason: "NO_LICENSE" }],
    ["required, unknown: NO_LICENSE", { ...base, state: "unknown", modes: null }, { licensed: false, reason: "NO_LICENSE" }],
    ["required, sso deployment, modes [sso]: licensed", base, { licensed: true, reason: null }],
    ["required, sso deployment, modes [standalone]: MODE_NOT_LICENSED", { ...base, modes: ["standalone"] }, { licensed: false, reason: "MODE_NOT_LICENSED" }],
    ["required, standalone deployment, modes [sso]: MODE_NOT_LICENSED", { ...base, deployment: "standalone" }, { licensed: false, reason: "MODE_NOT_LICENSED" }],
    ["required, standalone deployment, modes [standalone]: licensed", { ...base, deployment: "standalone", modes: ["standalone"] }, { licensed: true, reason: null }],
    ["required, standalone deployment, modes [sso, standalone]: licensed", { ...base, deployment: "standalone", modes: ["sso", "standalone"] }, { licensed: true, reason: null }],
    ["modes absent (null) means [sso]: licensed on sso", { ...base, modes: null }, { licensed: true, reason: null }],
    ["modes absent (undefined) means [sso]: not licensed on standalone", { ...base, modes: undefined, deployment: "standalone" }, { licensed: false, reason: "MODE_NOT_LICENSED" }],
    ["modes empty means [sso]: licensed on sso", { ...base, modes: [] }, { licensed: true, reason: null }],
    ["modes empty means [sso]: not licensed on standalone", { ...base, modes: [], deployment: "standalone" }, { licensed: false, reason: "MODE_NOT_LICENSED" }],
    ["an expired token is still licensed (expiry is read-only, not entitlement)", { ...base, state: "expired" }, { licensed: true, reason: null }],
    ["grace and expiring are licensed", { ...base, state: "grace" }, { licensed: true, reason: null }],
    ["expiring is licensed", { ...base, state: "expiring" }, { licensed: true, reason: null }],
  ];
  it.each(table)("%s", (_name, input, expected) => {
    expect(computeEntitlement(input)).toEqual(expected);
  });
});

// ── claims ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("token claims `modes` and `jti`", () => {
  const parse = (over: Record<string, unknown>) => parseLicenseClaims(defaultPayload(over));
  it("absent, null and empty `modes` all mean [sso]", () => {
    for (const modes of [undefined, null, []]) {
      const r = parse({ modes });
      expect(r.ok && r.claims.modes).toEqual(["sso"]);
    }
  });
  it("keeps what the token says, de-duplicated", () => {
    expect((parse({ modes: ["standalone"] }) as { claims: { modes: string[] } }).claims.modes).toEqual(["standalone"]);
    expect((parse({ modes: ["sso", "standalone", "sso"] }) as { claims: { modes: string[] } }).claims.modes).toEqual(["sso", "standalone"]);
  });
  it("rejects a `modes` that is not an array of sso | standalone", () => {
    for (const modes of ["sso", ["sso", "cloud"], [1], {}]) expect(parse({ modes }).ok).toBe(false);
  });
  it("reads `jti` when it is a string, otherwise null", () => {
    expect((parse({ jti: "abc-123" }) as { claims: { jti: string } }).claims.jti).toBe("abc-123");
    expect((parse({ jti: 5 }) as { claims: { jti: null } }).claims.jti).toBeNull();
    expect((parse({}) as { claims: { jti: null } }).claims.jti).toBeNull();
  });
});

// ── deployment mode ────────────────────────────────────────────────────────────────────────────────────────────

describe("deployment mode (computed from DMS's own SSO configuration)", () => {
  it("sso when the OIDC sign-in is fully configured", () => {
    expect(deploymentMode()).toBe("sso");
  });
  it.each(["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "AUTH_ISSUER"])("standalone when %s is missing", (k) => {
    cfg[k] = undefined;
    expect(deploymentMode()).toBe("standalone");
  });
  it("LOCAL_JWT_MOCK never makes a deployment `sso`, in production or anywhere else", () => {
    cfg.OIDC_CLIENT_ID = undefined;
    cfg.OIDC_REDIRECT_URI = undefined;
    for (const nodeEnv of ["production", "mirror", "development"]) {
      cfg.NODE_ENV = nodeEnv;
      cfg.LOCAL_JWT_MOCK = true;
      expect(deploymentMode()).toBe("standalone");
    }
  });
  it("feeds the entitlement: a token covering only `standalone` does not license an SSO deployment, and vice versa", async () => {
    __setLicenseForTesting({ claims: claims({ modes: ["standalone"], expiresAt: new Date(FUTURE) }) });
    expect(getLicenseSnapshot()).toMatchObject({ deployment: "sso", licensed: false, reason: "MODE_NOT_LICENSED" });
    cfg.OIDC_CLIENT_ID = undefined;
    expect(getLicenseSnapshot()).toMatchObject({ deployment: "standalone", licensed: true, reason: null });
    __setLicenseForTesting({ claims: claims({ modes: ["sso"], expiresAt: new Date(FUTURE) }) });
    expect(getLicenseSnapshot()).toMatchObject({ deployment: "standalone", licensed: false, reason: "MODE_NOT_LICENSED" });
  });
});

// ── trust: who may sign ────────────────────────────────────────────────────────────────────────────────────────

describe("LICENSE_REQUIRED=true: ONLY the pinned keys verify a licence", () => {
  it("a token signed by the pinned key is accepted and licenses the system (no JWKS fetch at all)", async () => {
    const fetchMock = installFetch({ license: served(pinned, { ver: 4 }), jwks });
    expect(await refreshLicense()).toBe("updated");
    expect(getLicenseSnapshot()).toMatchObject({ state: "active", licensed: true, reason: null, required: true });
    expect(getLicenseSnapshot().claims?.ver).toBe(4);
    expect(jwksCalls(fetchMock)).toBe(0);
  });

  it("SSO's own key (published in its JWKS) is NOT trusted for licences: rejected, JWKS never fetched, system unlicensed", async () => {
    const fetchMock = installFetch({ license: served(sso, { ver: 4 }), jwks });
    expect(await refreshLicense()).toBe("rejected");
    expect(jwksCalls(fetchMock)).toBe(0);
    expect(getLicenseSnapshot()).toMatchObject({ licensed: false, reason: "NO_LICENSE", state: "unknown" });
  });

  it("a wrong key is rejected even when its kid matches the pinned one (a forged signature)", async () => {
    installFetch({ license: served(stranger), jwks });
    expect(await refreshLicense()).toBe("rejected");
    expect(getLicenseSnapshot().licensed).toBe(false);
  });

  it("a token whose kid is not among the pinned keys is rejected", async () => {
    installFetch({ license: served(makeKey("someone-else")), jwks });
    expect(await refreshLicense()).toBe("rejected");
  });

  it("several pinned keys: either may sign (key rotation by adding a second key)", async () => {
    const second = makeKey("licence-key-2");
    cfg.LICENSE_TRUST_PUBLIC_KEYS = trust(pinned, second);
    installFetch({ license: served(second, { ver: 2 }), jwks });
    expect(await refreshLicense()).toBe("updated");
    installFetch({ license: served(pinned, { ver: 3 }), jwks });
    expect(await refreshLicense()).toBe("updated");
  });

  it("a pinned key with no kid verifies a token whatever its kid", async () => {
    const { kid: _kid, ...noKid } = pinned.jwk;
    cfg.LICENSE_TRUST_PUBLIC_KEYS = JSON.stringify([noKid]);
    installFetch({ license: served(pinned), jwks });
    expect(await refreshLicense()).toBe("updated");
  });

  it("`iss` is not compared when keys are pinned (an offline-signed token has no SSO to match), but aud and sys still are", async () => {
    installFetch({ license: served(pinned, { iss: "https://a-licence-office.example" }), jwks });
    expect(await refreshLicense()).toBe("updated");
    installFetch({ license: served(pinned, { ver: 9, aud: "license:gms" }), jwks });
    expect(await refreshLicense()).toBe("rejected");
    installFetch({ license: served(pinned, { ver: 9, sys: "gms" }), jwks });
    expect(await refreshLicense()).toBe("rejected");
    expect(getLicenseSnapshot().claims?.ver).toBe(1);
  });

  it("no usable key configured: nothing can verify, the system is unlicensed (and the boot log says why)", async () => {
    for (const bad of [undefined, "", "not json", "{}", "[]", JSON.stringify([{ kty: "oct", k: "AAAA" }])]) {
      cfg.LICENSE_TRUST_PUBLIC_KEYS = bad;
      __resetLicenseForTesting();
      installFetch({ license: served(pinned), jwks });
      expect(await refreshLicense()).toBe("rejected");
      expect(getLicenseSnapshot()).toMatchObject({ licensed: false, reason: "NO_LICENSE" });
    }
    cfg.LICENSE_TRUST_PUBLIC_KEYS = undefined;
    logLicenseStartupChecks();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("no usable LICENSE_TRUST_PUBLIC_KEYS"));
  });

  it("a PRIVATE JWK in the list is refused (a private key must never be configured as a trust anchor)", () => {
    const withPrivate = { ...pinned.privateKey.export({ format: "jwk" }), kid: "licence-key-1" };
    cfg.LICENSE_TRUST_PUBLIC_KEYS = JSON.stringify([withPrivate]);
    expect(trustedKeys().keys).toHaveLength(0);
    expect(trustedKeys().error).toMatch(/not a public RSA JWK/);
  });
});

describe("LICENSE_REQUIRED=false", () => {
  beforeEach(() => {
    cfg.LICENSE_REQUIRED = false;
  });

  it("with keys pinned, they are used instead of SSO's JWKS (an SSO-key token is rejected, a pinned-key token accepted)", async () => {
    const fetchMock = installFetch({ license: served(sso), jwks });
    expect(await refreshLicense()).toBe("rejected");
    installFetch({ license: served(pinned), jwks });
    expect(await refreshLicense()).toBe("updated");
    expect(jwksCalls(fetchMock)).toBe(0);
  });

  it("with no key pinned, today's JWKS behaviour (SSO's key, iss checked) is unchanged", async () => {
    cfg.LICENSE_TRUST_PUBLIC_KEYS = undefined;
    installFetch({ license: served(sso, { ver: 2 }), jwks });
    expect(await refreshLicense()).toBe("updated");
    installFetch({ license: served(sso, { ver: 3, iss: "https://elsewhere" }), jwks });
    expect(await refreshLicense()).toBe("rejected");
  });

  it("an unusable LICENSE_TRUST_PUBLIC_KEYS falls back to the JWKS, and is reported at error level at start", async () => {
    cfg.LICENSE_TRUST_PUBLIC_KEYS = "not json";
    installFetch({ license: served(sso), jwks });
    expect(await refreshLicense()).toBe("updated");
    logLicenseStartupChecks();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("not valid JSON") }), expect.stringContaining("unusable"));
  });

  it("everything is licensed whatever is held or not held", () => {
    expect(getLicenseSnapshot()).toMatchObject({ required: false, licensed: true, reason: null });
    __setLicenseForTesting({ claims: claims({ modes: ["standalone"] }) });
    expect(getLicenseSnapshot()).toMatchObject({ licensed: true, reason: null });
  });
});

describe("the persisted token under pinned trust", () => {
  it("survives a restart with SSO down: re-verified against the pinned keys", async () => {
    installFetch({ license: served(pinned, { ver: 6, expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    __resetLicenseForTesting();
    installFetch({ license: new Error("ECONNREFUSED"), jwks: new Error("ECONNREFUSED") });
    expect(await loadPersistedLicense()).toBe(true);
    expect(getLicenseSnapshot()).toMatchObject({ source: "cache", state: "expired", licensed: true });
  });

  it("a file planted with a foreign key AND a token signed by it is NOT believed when pinned (the stored key is ignored)", async () => {
    const forged = makeKey("forger");
    fs.writeFileSync(cacheFile, JSON.stringify({ token: signedBy(forged), jwk: forged.jwk, savedAt: new Date().toISOString() }));
    expect(await loadPersistedLicense()).toBe(false);
    expect(getLicenseSnapshot()).toMatchObject({ licensed: false, reason: "NO_LICENSE" });
  });

  it("a file written under SSO-JWKS trust (an old dev token) is ignored once the licence is required", async () => {
    cfg.LICENSE_REQUIRED = false;
    cfg.LICENSE_TRUST_PUBLIC_KEYS = undefined;
    installFetch({ license: served(sso, { ver: 2 }), jwks });
    await refreshLicense();
    __resetLicenseForTesting();
    cfg.LICENSE_REQUIRED = true;
    cfg.LICENSE_TRUST_PUBLIC_KEYS = trust(pinned);
    expect(await loadPersistedLicense()).toBe(false);
  });
});

// ── install ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("installLicense (POST /license/install)", () => {
  it("a token signed by a trusted key is held, licenses the system and is persisted as installed", async () => {
    expect(getLicenseSnapshot().licensed).toBe(false);
    expect(await installLicense(signedBy(pinned, { ver: 5, jti: "tok-1", customer: "Acme" }))).toEqual({ outcome: "updated" });
    const s = getLicenseSnapshot();
    expect(s).toMatchObject({ licensed: true, reason: null, state: "active", source: "cache" });
    expect(s.claims).toMatchObject({ ver: 5, jti: "tok-1", customer: "Acme", modes: ["sso"] });
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))).toMatchObject({ origin: "install" });
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ ver: 5, jti: "tok-1" }), expect.stringContaining("installed"));
  });

  it("survives a restart (loaded back from the file, still installed)", async () => {
    await installLicense(signedBy(pinned, { ver: 5 }));
    __resetLicenseForTesting();
    expect(await loadPersistedLicense()).toBe(true);
    expect(getLicenseSnapshot()).toMatchObject({ licensed: true, source: "cache" });
  });

  it("a bad signature is rejected and changes nothing", async () => {
    await installLicense(signedBy(pinned, { ver: 5 }));
    expect(await installLicense(signedBy(stranger, { ver: 8 }))).toEqual({ outcome: "rejected" });
    const [h, p, s] = signedBy(pinned, { ver: 9 }).split(".");
    expect(await installLicense(`${h}.${p}.${s.slice(0, -4)}AAAA`)).toEqual({ outcome: "rejected" });
    expect(getLicenseSnapshot().claims?.ver).toBe(5);
  });

  it("SSO's own key does not install a licence while required", async () => {
    installFetch({ license: new Error("unused"), jwks });
    expect(await installLicense(signedBy(sso))).toEqual({ outcome: "rejected" });
  });

  it("a token for another system (aud or sys) is rejected", async () => {
    expect(await installLicense(signedBy(pinned, { aud: "license:gms", sys: "gms" }))).toEqual({ outcome: "rejected" });
    expect(await installLicense(signedBy(pinned, { sys: "gms" }))).toEqual({ outcome: "rejected" });
    expect(await installLicense(signedBy(pinned, { aud: "license:sso" }))).toEqual({ outcome: "rejected" });
  });

  it("never lowers the stored ver: an older token is ignored, the same one is `unchanged`, a newer one wins", async () => {
    await installLicense(signedBy(pinned, { ver: 5, maxUsers: 10 }));
    expect(await installLicense(signedBy(pinned, { ver: 4, maxUsers: 999 }))).toEqual({ outcome: "ignored-older" });
    expect(getLicenseSnapshot().claims).toMatchObject({ ver: 5, maxUsers: 10 });
    expect(await installLicense(signedBy(pinned, { ver: 5, maxUsers: 10 }))).toEqual({ outcome: "unchanged" });
    expect(await installLicense(signedBy(pinned, { ver: 6, maxUsers: 20 }))).toEqual({ outcome: "updated" });
    expect(getLicenseSnapshot().claims).toMatchObject({ ver: 6, maxUsers: 20 });
  });

  it("a token an SSO poll already delivered is not lowered by an older install either", async () => {
    installFetch({ license: served(pinned, { ver: 7 }), jwks });
    await refreshLicense();
    expect(await installLicense(signedBy(pinned, { ver: 3 }))).toEqual({ outcome: "ignored-older" });
    expect(getLicenseSnapshot().claims?.ver).toBe(7);
  });

  it("garbage never throws", async () => {
    for (const t of ["", "x", "a.b.c", "....", "a.b"]) expect(await installLicense(t)).toEqual({ outcome: "rejected" });
  });

  it("an install is honoured whatever LICENSE_ENFORCEMENT says (stored even while the guard is off)", async () => {
    cfg.LICENSE_ENFORCEMENT = "off";
    expect(await installLicense(signedBy(pinned))).toEqual({ outcome: "updated" });
  });

  it("not required, no pinned key: verified against SSO's JWKS like a fetched token; JWKS down is `unavailable`, not a verdict", async () => {
    cfg.LICENSE_REQUIRED = false;
    cfg.LICENSE_TRUST_PUBLIC_KEYS = undefined;
    installFetch({ license: new Error("unused"), jwks });
    expect(await installLicense(signedBy(sso, { ver: 2 }))).toEqual({ outcome: "updated" });
    __resetLicenseForTesting();
    // a token the JWKS cannot vouch for (the fetch is rejected inside the verifier, so it reads as `rejected`)
    installFetch({ license: new Error("unused"), jwks: new Error("JWKS down") });
    expect(await installLicense(signedBy(sso, { ver: 3 }))).toEqual({ outcome: "rejected" });
  });
});

// ── SSO 404 and the failures that must never drop a token ───────────────────────────────────────────────────────

describe("an SSO 404 (the licence record was removed or revoked)", () => {
  const notFound = () => jsonResponse({ error: "none" }, 404);

  it("required: a token SSO had served is dropped, the file removed, and the system is unlicensed (NO_LICENSE)", async () => {
    installFetch({ license: served(pinned, { ver: 3 }), jwks });
    await refreshLicense();
    expect(getLicenseSnapshot().licensed).toBe(true);
    expect(fs.existsSync(cacheFile)).toBe(true);

    installFetch({ license: notFound, jwks });
    expect(await refreshLicense()).toBe("no-record");
    expect(getLicenseSnapshot()).toMatchObject({ state: "unconfigured", licensed: false, reason: "NO_LICENSE", required: true });
    expect(getLicenseSnapshot().claims).toBeNull();
    expect(fs.existsSync(cacheFile)).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ required: true }), expect.stringContaining("unlicensed"));
  });

  it("not required: the token is released to `unconfigured` and nothing is enforced (today's behaviour)", async () => {
    cfg.LICENSE_REQUIRED = false;
    cfg.LICENSE_TRUST_PUBLIC_KEYS = undefined;
    installFetch({ license: served(sso, { ver: 3, expiresAt: LONG_PAST }), jwks });
    await refreshLicense();
    expect(getLicenseSnapshot().state).toBe("expired");
    installFetch({ license: notFound, jwks });
    await refreshLicense();
    expect(getLicenseSnapshot()).toMatchObject({ state: "unconfigured", licensed: true, reason: null, required: false });
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("when nothing was held, a 404 changes nothing but the state label (required: still NO_LICENSE)", async () => {
    installFetch({ license: notFound, jwks });
    expect(await refreshLicense()).toBe("no-record");
    expect(getLicenseSnapshot()).toMatchObject({ state: "unconfigured", licensed: false, reason: "NO_LICENSE" });
  });

  it("a token an operator INSTALLED, which SSO has never served, is not taken away by SSO saying it has no record", async () => {
    await installLicense(signedBy(pinned, { ver: 5 }));
    installFetch({ license: notFound, jwks });
    expect(await refreshLicense()).toBe("no-record");
    expect(getLicenseSnapshot()).toMatchObject({ licensed: true, state: "active" });
    expect(fs.existsSync(cacheFile)).toBe(true);
  });

  it("...but once SSO has served that same token, a later 404 does mean revoked", async () => {
    const token = signedBy(pinned, { ver: 5 });
    await installLicense(token);
    installFetch({ license: () => jsonResponse({ token }), jwks });
    expect(await refreshLicense()).toBe("unchanged");
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8")).origin).toBe("sso");
    installFetch({ license: notFound, jwks });
    await refreshLicense();
    expect(getLicenseSnapshot()).toMatchObject({ licensed: false, reason: "NO_LICENSE" });
  });

  it("the drop also survives a restart (the file is gone, so nothing is loaded back)", async () => {
    installFetch({ license: served(pinned), jwks });
    await refreshLicense();
    installFetch({ license: notFound, jwks });
    await refreshLicense();
    __resetLicenseForTesting();
    expect(await loadPersistedLicense()).toBe(false);
  });
});

describe("an unreachable SSO never drops anything, required or not", () => {
  const failures: Array<[string, () => void]> = [
    ["connection refused", () => installFetch({ license: new Error("ECONNREFUSED"), jwks })],
    ["a timeout (abort)", () => installFetch({ license: Object.assign(new Error("aborted"), { name: "AbortError" }), jwks })],
    ["HTTP 500", () => installFetch({ license: () => new Response("boom", { status: 500 }), jwks })],
    ["HTTP 502 from a proxy", () => installFetch({ license: () => new Response("bad gateway", { status: 502 }), jwks })],
    ["HTTP 503", () => installFetch({ license: () => new Response("busy", { status: 503 }), jwks })],
    ["HTTP 403", () => installFetch({ license: () => new Response("no", { status: 403 }), jwks })],
    ["a token that does not verify", () => installFetch({ license: () => jsonResponse({ token: "a.b.c" }), jwks })],
  ];
  it.each(failures)("%s: the held token is kept and the system stays licensed", async (_n, breakIt) => {
    installFetch({ license: served(pinned, { ver: 3 }), jwks });
    await refreshLicense();
    breakIt();
    await refreshLicense();
    expect(getLicenseSnapshot()).toMatchObject({ licensed: true, state: "active" });
    expect(getLicenseSnapshot().claims?.ver).toBe(3);
    expect(fs.existsSync(cacheFile)).toBe(true);
  });
});

// ── boot report and status ─────────────────────────────────────────────────────────────────────────────────────

describe("boot-time ERROR reports", () => {
  const errors = () => mockLogger.error.mock.calls.map((c) => String(c[c.length - 1]));

  it("LICENSE_REQUIRED=false in a production process is an ERROR (production and mirror)", () => {
    cfg.LICENSE_REQUIRED = false;
    for (const nodeEnv of ["production", "mirror"]) {
      mockLogger.error.mockClear();
      cfg.NODE_ENV = nodeEnv;
      logLicenseStartupChecks();
      expect(errors().some((m) => m.includes("LICENSE_REQUIRED=false in a production process"))).toBe(true);
    }
  });

  it("LICENSE_REQUIRED=false in development or test logs no error", () => {
    cfg.LICENSE_REQUIRED = false;
    for (const nodeEnv of ["development", "test"]) {
      cfg.NODE_ENV = nodeEnv;
      logLicenseStartupChecks();
    }
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it.each(["warn", "off"])("LICENSE_ENFORCEMENT=%s while required is an ERROR (the emergency brake is reported at every start)", (mode) => {
    cfg.LICENSE_ENFORCEMENT = mode;
    logLicenseStartupChecks();
    expect(errors().some((m) => m.includes("LICENSE_ENFORCEMENT is not 'enforce'"))).toBe(true);
  });

  it("a healthy required configuration logs no error", () => {
    logLicenseStartupChecks();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("LICENSE_ENFORCEMENT=warn when not required is not an error", () => {
    cfg.LICENSE_REQUIRED = false;
    cfg.NODE_ENV = "development";
    cfg.LICENSE_ENFORCEMENT = "warn";
    logLicenseStartupChecks();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("status payload additions", () => {
  it("required, nothing held: required true, licensed false, reason NO_LICENSE, deployment sso", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    expect(await buildLicenseStatus()).toMatchObject({ required: true, licensed: false, reason: "NO_LICENSE", deployment: "sso" });
  });

  it("licensed after an install: reason null", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    await installLicense(signedBy(pinned));
    expect(await buildLicenseStatus()).toMatchObject({ required: true, licensed: true, reason: null, deployment: "sso", state: "active" });
  });

  it("wrong mode: MODE_NOT_LICENSED, with the token's own dates still reported", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    await installLicense(signedBy(pinned, { modes: ["standalone"], expiresAt: FUTURE }));
    expect(await buildLicenseStatus()).toMatchObject({ licensed: false, reason: "MODE_NOT_LICENSED", state: "active", expiresAt: FUTURE });
  });

  it("standalone deployment with a standalone token", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    cfg.OIDC_CLIENT_SECRET = undefined;
    await installLicense(signedBy(pinned, { modes: ["standalone"] }));
    expect(await buildLicenseStatus()).toMatchObject({ licensed: true, deployment: "standalone" });
  });

  it("not required: licensed true, required false", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    cfg.LICENSE_REQUIRED = false;
    expect(await buildLicenseStatus()).toMatchObject({ required: false, licensed: true, reason: null });
  });

  it("enforcement off still reports the entitlement honestly (no token is held while the fetcher is off)", async () => {
    mockQuery.mockResolvedValue([{ n: 2 }]);
    cfg.LICENSE_ENFORCEMENT = "off";
    expect(await buildLicenseStatus()).toMatchObject({ enforcement: "off", required: true, licensed: false, reason: "NO_LICENSE" });
  });
});
