/**
 * Owner authorisation tickets (modules/auth/ownerAuthorisation.ts) guarding POST /tenants.
 *
 * SSO is replaced by a stubbed fetch serving a JWKS made from a throwaway RSA key generated in this file; tickets
 * are signed here in the shape SSO issues them. The route under test is the REAL tenantRoutes router (so the wiring is
 * proven), with a fake authenticate step and a mocked createTenant service call. No database is touched.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
const mockCreateTenant = jest.fn();
jest.mock("../src/modules/tenants/tenants.service.js", () => ({
  createTenant: (...a: unknown[]) => mockCreateTenant(...a),
  deactivateTenant: jest.fn(),
  getTenant: jest.fn(),
  listTenants: jest.fn(),
  updateTenant: jest.fn(),
}));
const mockFindByPk = jest.fn();

import { config } from "../src/config/env.js";
import { PERMISSIONS } from "../src/config/permissions.js";
import { logger } from "../src/core/logger.js";
import { User } from "../src/infrastructure/database/index.js";
import { errorHandler } from "../src/shared/middleware.js";
import { tenantRoutes } from "../src/modules/tenants/tenants.routes.js";
import { __resetOwnerTicketsForTesting } from "../src/modules/auth/ownerAuthorisation.js";

const ISSUER = "http://sso.test:7300";
const JWKS_URL = "http://sso.test:7300/jwks";
const KID = "sso-test-kid";
const OP = "dms.tenant.create";
const OWNER_SUB = "sso-owner-sub-1";
const CALLER_ID = "11111111-1111-1111-1111-111111111111";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
// A second key SSO never published: signatures from it must not verify.
const rogue = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

function ticket(over: { header?: Record<string, unknown>; payload?: Record<string, unknown>; key?: crypto.KeyObject } = {}) {
  const iat = nowSec();
  const header = { alg: "RS256", typ: "kcms-owner-ticket+jwt", kid: KID, ...over.header };
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    aud: "dms",
    sub: OWNER_SUB,
    jti: crypto.randomUUID(),
    op: OP,
    iat,
    exp: iat + 300,
    ...over.payload,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), over.key ?? privateKey).toString("base64url");
  return `${input}.${sig}`;
}

let jwksReachable = true;
const fetchMock = jest.fn(async () => {
  if (!jwksReachable) throw new Error("connect ECONNREFUSED");
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
});

function makeApp() {
  const app: any = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: CALLER_ID, tenantId: "t1", role: "PLATFORM_ADMIN", roles: ["PLATFORM_ADMIN"], permissions: [PERMISSIONS.PLATFORM_ADMIN] };
    next();
  });
  app.use("/tenants", tenantRoutes);
  app.use(errorHandler);
  return app;
}
const app = makeApp();
const post = (hdr?: string, body: object = { id: "acme", name: "Acme" }) => {
  const r = request(app).post("/tenants").send(body);
  return hdr === undefined ? r : r.set("X-Owner-Authorisation", hdr);
};

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };
const realFetch = globalThis.fetch;

beforeAll(() => {
  jest.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
  jest.spyOn(logger, "info").mockImplementation((() => undefined) as never);
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  jest.spyOn(User, "findByPk").mockImplementation(((...a: unknown[]) => mockFindByPk(...a)) as never);
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});
beforeEach(() => {
  (logger.warn as unknown as jest.Mock).mockClear();
  mockCreateTenant.mockReset();
  fetchMock.mockClear();
  __resetOwnerTicketsForTesting();
  jwksReachable = true;
  cfg.OWNER_VERIFICATION_REQUIRED = true;
  cfg.AUTH_JWKS_URI = JWKS_URL;
  cfg.AUTH_ISSUER = ISSUER;
  mockFindByPk.mockResolvedValue({ id: CALLER_ID, externalSub: OWNER_SUB });
  mockCreateTenant.mockResolvedValue({ id: "acme" });
});
afterEach(() => Object.assign(cfg, original));

const code = (res: request.Response) => res.body?.error?.code;

describe("OWNER_VERIFICATION_REQUIRED = true: POST /tenants", () => {
  it("no header -> 403 OWNER_AUTHORISATION_REQUIRED, tenant not created", async () => {
    const res = await post();
    expect(res.status).toBe(403);
    expect(code(res)).toBe("OWNER_AUTHORISATION_REQUIRED");
    expect(res.body.error.message).toMatch(/owner/i);
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it("empty header -> REQUIRED", async () => {
    const res = await post("   ");
    expect(res.status).toBe(403);
    expect(code(res)).toBe("OWNER_AUTHORISATION_REQUIRED");
  });

  it.each([
    ["garbage", "not-a-ticket"],
    ["three garbage segments", "aaa.bbb.ccc"],
  ])("%s -> 403 OWNER_AUTHORISATION_INVALID", async (_n, value) => {
    const res = await post(value);
    expect(res.status).toBe(403);
    expect(code(res)).toBe("OWNER_AUTHORISATION_INVALID");
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong operation", { payload: { op: "dms.tenant.delete" } }],
    ["no operation", { payload: { op: undefined } }],
    ["wrong audience", { payload: { aud: "gms" } }],
    ["wrong issuer", { payload: { iss: "http://evil.test" } }],
    ["expired", { payload: { iat: nowSec() - 400, exp: nowSec() - 100 } }],
    ["lifetime over 330 s", { payload: { iat: nowSec(), exp: nowSec() + 1000 } }],
    ["issued in the future", { payload: { iat: nowSec() + 3600, exp: nowSec() + 3700 } }],
    ["missing jti", { payload: { jti: undefined } }],
    ["missing sub", { payload: { sub: undefined } }],
    ["wrong typ", { header: { typ: "JWT" } }],
    ["wrong alg", { header: { alg: "none" } }],
    ["unknown kid", { header: { kid: "someone-else" } }],
    ["signed by a key SSO never published", { key: rogue.privateKey }],
  ])("%s -> 403 OWNER_AUTHORISATION_INVALID", async (_n, over) => {
    const res = await post(ticket(over as never));
    expect(res.status).toBe(403);
    expect(code(res)).toBe("OWNER_AUTHORISATION_INVALID");
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it("a ticket for another account's SSO subject -> INVALID", async () => {
    const res = await post(ticket({ payload: { sub: "someone-else" } }));
    expect(res.status).toBe(403);
    expect(code(res)).toBe("OWNER_AUTHORISATION_INVALID");
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it("a valid ticket -> 201 and the tenant is created", async () => {
    const res = await post(ticket());
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: "acme" });
    expect(mockCreateTenant).toHaveBeenCalledTimes(1);
  });

  it("a caller with no SSO link is not blocked by the subject comparison (the ticket is the proof)", async () => {
    mockFindByPk.mockResolvedValue({ id: CALLER_ID, externalSub: null });
    const res = await post(ticket());
    expect(res.status).toBe(201);
  });

  it("replaying the same ticket -> INVALID, and only one tenant was created", async () => {
    const t = ticket();
    expect((await post(t)).status).toBe(201);
    const again = await post(t);
    expect(again.status).toBe(403);
    expect(code(again)).toBe("OWNER_AUTHORISATION_INVALID");
    expect(mockCreateTenant).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous requests with one ticket: exactly one succeeds", async () => {
    const t = ticket();
    const [a, b] = await Promise.all([post(t), post(t)]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(mockCreateTenant).toHaveBeenCalledTimes(1);
  });

  it("a request that fails after verification (validation error) does not burn the ticket", async () => {
    const t = ticket();
    const { AppError } = await import("../src/core/AppError.js");
    mockCreateTenant.mockRejectedValueOnce(new AppError(400, "ERR-VALIDATION", "Validation failed"));
    const first = await post(t);
    expect(first.status).toBe(400);
    mockCreateTenant.mockResolvedValue({ id: "acme" });
    const retry = await post(t);
    expect(retry.status).toBe(201);
  });

  it("SSO keys unreachable -> 503 OWNER_AUTHORISATION_UNAVAILABLE (fails closed)", async () => {
    // Use a kid not yet cached by auth.service's JWKS cache, so the stubbed outage is actually reached.
    jwksReachable = false;
    const res = await post(ticket({ header: { kid: "rotated-key-not-cached" } }));
    expect(res.status).toBe(503);
    expect(code(res)).toBe("OWNER_AUTHORISATION_UNAVAILABLE");
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it("a denial is logged without the ticket's contents", async () => {
    const t = ticket({ payload: { op: "dms.tenant.delete" } });
    await post(t);
    const warn = logger.warn as jest.Mock;
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("OWNER_AUTHORISATION_INVALID");
    expect(logged).toContain(CALLER_ID);
    expect(logged).not.toContain(t);
    expect(logged).not.toContain(OWNER_SUB);
  });

  it("other tenant routes never ask for a ticket (PATCH is a tenant admin's own, not owner-only)", async () => {
    const res = await request(app).get("/tenants");
    expect(String(code(res))).not.toMatch(/^OWNER_AUTHORISATION/);
  });
});

describe("OWNER_VERIFICATION_REQUIRED = false (development): unchanged behaviour", () => {
  beforeEach(() => {
    cfg.OWNER_VERIFICATION_REQUIRED = false;
  });

  it("no ticket needed -> 201", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(mockCreateTenant).toHaveBeenCalledTimes(1);
  });

  it("a garbage ticket is ignored -> 201, no JWKS fetch", async () => {
    const res = await post("garbage");
    expect(res.status).toBe(201);
  });
});

describe("the setting's default", () => {
  it("is false in the test environment (what every other suite relies on)", () => {
    expect(original.OWNER_VERIFICATION_REQUIRED).toBe(false);
  });
});
