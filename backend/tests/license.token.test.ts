/**
 * The licence token verifier (modules/license/licenseToken.ts), contract section 4. Tokens are signed in-test
 * with a throwaway RSA key; nothing talks to SSO.
 */
import crypto from "node:crypto";
import { verifyLicenseToken, parseLicenseClaims } from "../src/modules/license/licenseToken.js";
import { ISSUER, defaultPayload, makeKey, signLicense } from "./licenseTestKit.js";

const key = makeKey("k1");
const other = makeKey("k1"); // same kid, different key material: a forged signature
const resolve = (kid: string | undefined) => (kid === "k1" ? key.publicKey : null);
const verify = (token: string, issuer: string | undefined = ISSUER) => verifyLicenseToken(token, { resolveKey: resolve, issuer });

const reasonOf = async (token: string, issuer?: string) => {
  const r = await verify(token, issuer);
  return r.ok ? null : r.reason;
};

describe("a well-formed token", () => {
  it("verifies and normalises every claim", async () => {
    const r = await verify(signLicense(key, { payload: { ver: 7, maxUsers: 50, modules: ["letters", "search"], customer: "Acme", expiresAt: "2027-06-30T12:00:00.000Z" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kid).toBe("k1");
    expect(r.claims).toMatchObject({ ver: 7, maxUsers: 50, modules: ["letters", "search"], customer: "Acme", graceDays: 14, warnDays: 30, sys: "dms", aud: "license:dms" });
    expect(r.claims.expiresAt).toEqual(new Date("2027-06-30T12:00:00.000Z"));
  });

  it("accepts the perpetual / unlimited / all-modules forms (nulls)", async () => {
    const r = await verify(signLicense(key, { payload: { expiresAt: null, maxUsers: null, modules: null } }));
    expect(r.ok && r.claims).toMatchObject({ expiresAt: null, maxUsers: null, modules: null });
  });

  it("has no exp claim and is NOT rejected for its age (iat in the distant past)", async () => {
    const token = signLicense(key, { payload: { iat: 1 } });
    expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())).not.toHaveProperty("exp");
    expect((await verify(token)).ok).toBe(true);
  });

  it("is not rejected when the licence's own date is long past (that is the state function's job, not the verifier's)", async () => {
    expect((await verify(signLicense(key, { payload: { expiresAt: "2001-01-01T00:00:00.000Z" } }))).ok).toBe(true);
  });

  it("tolerates a trailing slash difference in the issuer", async () => {
    expect((await verify(signLicense(key, { payload: { iss: `${ISSUER}/` } }))).ok).toBe(true);
  });

  it("does not check iss when no issuer is configured (the signature is still verified against SSO's JWKS)", async () => {
    const token = signLicense(key, { payload: { iss: "http://anything" } });
    expect((await verifyLicenseToken(token, { resolveKey: resolve })).ok).toBe(true);
  });
});

describe("rejections (each leaves the previous good token in place, by the caller)", () => {
  it("wrong typ", async () => {
    expect(await reasonOf(signLicense(key, { header: { typ: "JWT" } }))).toMatch(/typ/);
  });
  it("missing typ", async () => {
    expect(await reasonOf(signLicense(key, { header: { typ: undefined } }))).toMatch(/typ/);
  });
  it("wrong alg (an id_token-style HS256/none header is never accepted)", async () => {
    expect(await reasonOf(signLicense(key, { header: { alg: "HS256" } }))).toMatch(/alg/);
    expect(await reasonOf(signLicense(key, { header: { alg: "none" } }))).toMatch(/alg/);
  });
  it("wrong issuer", async () => {
    expect(await reasonOf(signLicense(key, { payload: { iss: "http://evil.example" } }))).toMatch(/iss/);
  });
  it("wrong audience (a GMS token is not a DMS token)", async () => {
    expect(await reasonOf(signLicense(key, { payload: { aud: "license:gms" } }))).toMatch(/aud/);
    expect(await reasonOf(signLicense(key, { payload: { aud: "dms" } }))).toMatch(/aud/);
  });
  it("wrong sys", async () => {
    expect(await reasonOf(signLicense(key, { payload: { sys: "gms" } }))).toMatch(/sys/);
  });
  it("signature from a different key", async () => {
    expect(await reasonOf(signLicense(other))).toMatch(/signature/);
  });
  it("tampered payload (modules widened after signing)", async () => {
    const [h, , s] = signLicense(key, { payload: { modules: ["letters"] } }).split(".");
    const forged = Buffer.from(JSON.stringify(defaultPayload({ modules: null, maxUsers: null }))).toString("base64url");
    expect(await reasonOf(`${h}.${forged}.${s}`)).toMatch(/signature/);
  });
  it("tampered signature bytes", async () => {
    const t = signLicense(key);
    const bad = t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await reasonOf(bad)).toMatch(/signature/);
  });
  it("unknown kid", async () => {
    expect(await reasonOf(signLicense(makeKey("rotated-away")))).toMatch(/no signing key/);
  });
  it("a key resolver that throws is a rejection, not an exception", async () => {
    const r = await verifyLicenseToken(signLicense(key), { resolveKey: () => { throw new Error("JWKS down"); } });
    expect(r.ok).toBe(false);
  });
  it("not a compact JWS", async () => {
    for (const junk of ["", "abc", "a.b", "a.b.c.d", "..", "not.a.token"]) {
      expect(await reasonOf(junk)).toBeTruthy();
    }
  });
  it("a valid signature over a non-JSON payload", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "kcms-license+jwt", kid: "k1" })).toString("base64url");
    const payload = Buffer.from("not json").toString("base64url");
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key.privateKey).toString("base64url");
    expect(await reasonOf(`${header}.${payload}.${sig}`)).toMatch(/payload/);
  });
});

describe("claim shapes", () => {
  const ok = (over: Record<string, unknown>) => parseLicenseClaims(defaultPayload(over));
  it.each([
    ["ver", { ver: -1 }],
    ["ver", { ver: 1.5 }],
    ["ver", { ver: "7" }],
    ["graceDays", { graceDays: -1 }],
    ["graceDays", { graceDays: 366 }],
    ["graceDays", { graceDays: 1.5 }],
    ["warnDays", { warnDays: 366 }],
    ["warnDays", { warnDays: "30" }],
    ["expiresAt", { expiresAt: "not a date" }],
    ["expiresAt", { expiresAt: 1798761600 }],
    ["maxUsers", { maxUsers: 0 }],
    ["maxUsers", { maxUsers: -5 }],
    ["maxUsers", { maxUsers: "50" }],
    ["modules", { modules: "letters" }],
    ["modules", { modules: ["letters", 3] }],
  ])("rejects a bad %s", (field, over) => {
    const r = ok(over);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(field);
  });

  it("boundary values are accepted: 0 and 365 days, maxUsers 1, empty module list", () => {
    const r = ok({ graceDays: 0, warnDays: 365, maxUsers: 1, modules: [] });
    expect(r.ok && r.claims).toMatchObject({ graceDays: 0, warnDays: 365, maxUsers: 1, modules: [] });
  });
  it("de-duplicates modules", () => {
    const r = ok({ modules: ["letters", "letters", "ai"] });
    expect(r.ok && r.claims.modules).toEqual(["letters", "ai"]);
  });
});
