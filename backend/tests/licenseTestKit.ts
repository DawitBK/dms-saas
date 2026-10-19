/**
 * Shared fixtures for the licensing suites: an RSA key pair generated per run, a signer that produces tokens in
 * the exact shape SSO issues (contract section 4), and the matching JWKS. No live SSO is ever needed.
 */
import crypto from "node:crypto";
import { LICENSE_TOKEN_TYP } from "../src/modules/license/license.constants.js";
import type { LicenseClaims } from "../src/modules/license/licenseToken.js";

export const ISSUER = "http://localhost:7301";

export interface TestKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  jwk: crypto.JsonWebKey & { kid: string; use: string; alg: string };
}

export function makeKey(kid = "test-key-1"): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } as TestKey["jwk"];
  return { kid, privateKey, publicKey, jwk };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export interface SignOptions {
  header?: Record<string, unknown>;
  /** Payload overrides; a key set to `undefined` is removed. */
  payload?: Record<string, unknown>;
}

export function defaultPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    iss: ISSUER,
    aud: "license:dms",
    sys: "dms",
    ver: 1,
    iat: 1_700_000_000,
    customer: "Example Corp",
    expiresAt: "2030-01-01T00:00:00.000Z",
    graceDays: 14,
    warnDays: 30,
    maxUsers: null,
    modules: null,
    ...over,
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

export function signLicense(key: TestKey, opts: SignOptions = {}): string {
  const header = { alg: "RS256", typ: LICENSE_TOKEN_TYP, kid: key.kid, ...opts.header };
  const payload = defaultPayload(opts.payload);
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

export function claims(over: Partial<LicenseClaims> = {}): LicenseClaims {
  return {
    iss: ISSUER,
    aud: "license:dms",
    sys: "dms",
    ver: 1,
    iat: 1_700_000_000,
    customer: "Example Corp",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    graceDays: 14,
    warnDays: 30,
    maxUsers: null,
    modules: null,
    ...over,
  };
}

/** A fetch() stand-in routing the licence URL and the JWKS URL; each can be a response factory or an error. */
export type Route = (() => Response | Promise<Response>) | Error;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installFetch(routes: { license: Route; jwks: Route }): jest.Mock {
  const mock = jest.fn(async (input: unknown) => {
    const url = String(input);
    const route = url.includes("/licenses/public/") ? routes.license : routes.jwks;
    if (route instanceof Error) throw route;
    return route();
  });
  (globalThis as { fetch: unknown }).fetch = mock;
  return mock;
}
