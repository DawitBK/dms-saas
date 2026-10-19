/**
 * The entitlement guard (modules/license/licenseGate.ts, contract section 9): LICENSE_REQUIRED on and no entitling
 * licence means 403 LICENSE_REQUIRED for every request except health/readiness, the licence status and install
 * routes and the sign-in endpoints. Two layers, like license.gate.test.ts: a bare Express app with only the gate
 * and the licence routes (every exempt entry, the body, every mode) and the REAL app from createApp() (proves the
 * guard is wired in front of authentication, that /license/install is reachable without a login, and that
 * installing a token restores service within one request).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));

// The install route is IP-rate-limited (proved in license.install.rateLimit.test.ts); here every limiter passes through so
// the many install calls below do not count against one another.
jest.mock("express-rate-limit", () => ({ __esModule: true, default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

import { config } from "../src/config/env.js";
import { logger } from "../src/core/logger.js";
import { errorHandler } from "../src/shared/middleware.js";
import * as service from "../src/modules/license/license.service.js";
import { licensePublicRoutes, licenseRoutes } from "../src/modules/license/license.routes.js";
import { ENTITLEMENT_EXEMPT, isEntitlementExempt, licenseGate } from "../src/modules/license/licenseGate.js";
import { claims, makeKey, signLicense } from "./licenseTestKit.js";

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };

const DAY = 86_400_000;
const future = new Date(Date.now() + 200 * DAY);
const past = new Date(Date.now() - 30 * DAY);

const pinned = makeKey("licence-key-1");
const stranger = makeKey("licence-key-1");

const BODY = {
  error: { code: "LICENSE_REQUIRED", message: "This system is not licensed. Contact your administrator.", details: { reason: "NO_LICENSE" } },
};

function miniApp() {
  const app: any = express();
  app.use(express.json());
  const v1: any = express.Router();
  v1.use(licenseGate);
  v1.use(licensePublicRoutes);
  v1.use("/license", licenseRoutes);
  v1.use((req: any, res: any) => res.json({ reached: true, method: req.method, path: req.path }));
  app.use("/api/v1", v1);
  app.use(errorHandler);
  return app;
}
const app = miniApp();
const call = (method: string, url: string) => (request(app) as any)[method.toLowerCase()](`/api/v1${url}`).send();

let tmpDir: string;
let mockLogger: { warn: jest.SpyInstance; error: jest.SpyInstance };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-license-gate-"));
  cfg.LICENSE_CACHE_PATH = path.join(tmpDir, "dms-license.json");
  cfg.LICENSE_REQUIRED = true;
  cfg.LICENSE_ENFORCEMENT = "enforce";
  cfg.LICENSE_TRUST_PUBLIC_KEYS = JSON.stringify([pinned.jwk]);
  cfg.OIDC_CLIENT_ID = "edams";
  cfg.OIDC_CLIENT_SECRET = "secret";
  cfg.OIDC_REDIRECT_URI = "http://localhost:7101/auth/callback";
  cfg.AUTH_ISSUER = "http://localhost:7301";
  service.__resetLicenseForTesting();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([{ n: 3 }]);
  mockLogger = {
    warn: jest.spyOn(logger, "warn").mockImplementation(() => undefined),
    error: jest.spyOn(logger, "error").mockImplementation(() => undefined),
  };
});
afterEach(() => {
  Object.assign(cfg, original);
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const unlicensed = {
  "nothing held (unknown)": () => service.__setLicenseForTesting({ claims: null }),
  "SSO has no record (unconfigured)": () => service.__setLicenseForTesting({ claims: null, noRecord: true }),
};

// ── the guard ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("required and unlicensed: 403 LICENSE_REQUIRED for everything not exempt", () => {
  it.each(Object.entries(unlicensed))("%s: every method on an ordinary route answers the contract's body", async (_n, setup) => {
    setup();
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call(method, "/documents/123");
      expect({ method, status: res.status }).toEqual({ method, status: 403 });
      if (method !== "HEAD") expect(res.body).toEqual(BODY);
    }
  });

  it("covers reads of core routes and of module routes alike, and the public ones (letter verification, e-signing)", async () => {
    service.__setLicenseForTesting({ claims: null });
    for (const [method, url] of [
      ["GET", "/documents"], ["GET", "/folders"], ["GET", "/users"], ["GET", "/audit"], ["GET", "/letters"],
      ["GET", "/letters/verify"], ["POST", "/signing/1/recipients/2/sign/external"], ["GET", "/search"], ["GET", "/operations/outbox"],
      ["POST", "/internal/roles/tenants/t/role-mappings"], ["PUT", "/internal/roles/tenants/t/role-mappings/g"],
    ]) {
      const res = await call(method, url);
      expect({ method, url, code: res.body?.error?.code }).toEqual({ method, url, code: "LICENSE_REQUIRED" });
    }
  });

  it("a token whose modes lack this deployment's mode answers reason MODE_NOT_LICENSED", async () => {
    service.__setLicenseForTesting({ claims: claims({ expiresAt: future, modes: ["standalone"] }) });
    const res = await call("GET", "/documents");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "LICENSE_REQUIRED", details: { reason: "MODE_NOT_LICENSED" } });
  });

  it("the entitlement refusal wins over the expiry rules (an expired token of the wrong mode is LICENSE_REQUIRED, not LICENSE_EXPIRED)", async () => {
    service.__setLicenseForTesting({ claims: claims({ expiresAt: past, modes: ["standalone"] }) });
    expect((await call("POST", "/documents")).body.error.code).toBe("LICENSE_REQUIRED");
  });

  it("a licensed system (right mode) is untouched: every method passes, expiry rules unchanged", async () => {
    service.__setLicenseForTesting({ claims: claims({ expiresAt: future, modes: ["sso"] }) });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) expect((await call(method, "/documents/1")).status).toBe(200);
    service.__setLicenseForTesting({ claims: claims({ expiresAt: past, modes: ["sso"] }) });
    expect((await call("GET", "/documents/1")).status).toBe(200);
    expect((await call("POST", "/documents/1")).body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("a standalone deployment is licensed by a standalone token and refused by an sso-only one", async () => {
    cfg.OIDC_CLIENT_ID = undefined;
    service.__setLicenseForTesting({ claims: claims({ expiresAt: future, modes: ["standalone"] }) });
    expect((await call("GET", "/documents")).status).toBe(200);
    service.__setLicenseForTesting({ claims: claims({ expiresAt: future, modes: ["sso"] }) });
    expect((await call("GET", "/documents")).body.error.details.reason).toBe("MODE_NOT_LICENSED");
  });

  it("not required: nothing changes, unconfigured / unknown still refuse nothing", async () => {
    cfg.LICENSE_REQUIRED = false;
    for (const setup of Object.values(unlicensed)) {
      setup();
      expect((await call("GET", "/documents")).status).toBe(200);
      expect((await call("POST", "/documents")).status).toBe(200);
    }
  });
});

describe("the exempt list keeps working while unlicensed", () => {
  const AUTH = [
    ["POST", "/auth/login"], ["POST", "/auth/refresh"], ["POST", "/auth/logout"], ["GET", "/auth/me"], ["POST", "/auth/callback"],
    ["GET", "/auth/oidc/authorize"], ["POST", "/auth/backchannel-logout"], ["POST", "/auth/select-tenant"], ["POST", "/auth/totp/validate"],
  ];
  const CASES: Array<[string, string]> = [
    ...(AUTH as Array<[string, string]>),
    ["GET", "/operations/health"],
    ["GET", "/operations/ready"],
    ["GET", "/license/status"],
    ["POST", "/internal/roles/tenants/examplecorp/role-mappings/resolve"],
  ];

  it.each(CASES)("%s %s passes", async (method, url) => {
    service.__setLicenseForTesting({ claims: null });
    const res = await call(method, url);
    expect({ method, url, status: res.status }).toEqual({ method, url, status: 200 });
  });

  it("POST /license/install is exempt and reachable (it answers on its own terms, never LICENSE_REQUIRED)", async () => {
    service.__setLicenseForTesting({ claims: null });
    const res = await call("POST", "/license/install");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ERR-LICENSE-INVALID");
  });

  it("every exempt entry is exercised by at least one case above", () => {
    const all: Array<[string, string]> = [...CASES, ["POST", "/license/install"], ["GET", "/health"]];
    for (const entry of ENTITLEMENT_EXEMPT) {
      const hit = all.some(([m, p]) => (entry.method === "*" || entry.method === m) && entry.pattern.test(p));
      expect({ entry: `${entry.method} ${entry.pattern}`, hit }).toEqual({ entry: `${entry.method} ${entry.pattern}`, hit: true });
    }
  });

  it.each([
    ["GET", "/operations/health-check"],
    ["GET", "/operations/health/deep"],
    ["POST", "/operations/client-error"],
    ["GET", "/license/anything"],
    ["GET", "/licensex/status"],
    ["GET", "/authx/login"],
    ["PUT", "/internal/roles/tenants/t/role-mappings/g"],
    ["POST", "/internal/roles/tenants/t/role-mappings/resolve/extra"],
    ["GET", "/internal/roles/tenants/t/role-mappings/resolve"],
  ])("%s %s is NOT exempt", (method, url) => {
    expect(isEntitlementExempt(method, url)).toBe(false);
  });

  it("isEntitlementExempt is method-aware only where an entry is", () => {
    expect(isEntitlementExempt("GET", "/auth/login")).toBe(true);
    expect(isEntitlementExempt("POST", "/internal/roles/tenants/t/role-mappings/resolve")).toBe(true);
    expect(isEntitlementExempt("post", "/internal/roles/tenants/t/role-mappings/resolve")).toBe(true);
    expect(isEntitlementExempt("GET", "/health")).toBe(true);
  });
});

describe("the emergency brake", () => {
  it("LICENSE_ENFORCEMENT=warn: nothing is refused, the would-be refusal is logged", async () => {
    cfg.LICENSE_ENFORCEMENT = "warn";
    service.__setLicenseForTesting({ claims: null });
    expect((await call("GET", "/documents")).status).toBe(200);
    expect((await call("POST", "/documents")).status).toBe(200);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ path: "/documents", reason: "NO_LICENSE" }), expect.stringContaining("would have been refused"));
  });

  it("LICENSE_ENFORCEMENT=off: the gate does nothing at all", async () => {
    cfg.LICENSE_ENFORCEMENT = "off";
    service.__setLicenseForTesting({ claims: null });
    expect((await call("DELETE", "/documents/1")).status).toBe(200);
  });
});

describe("a fault inside the guard lets the request through and is logged at error level", () => {
  it("getLicenseSnapshot throws -> the request is allowed", async () => {
    jest.spyOn(service, "getLicenseSnapshot").mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await call("DELETE", "/documents/1");
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining("gate failed internally"));
  });
});

// ── GET /license/status ────────────────────────────────────────────────────────────────────────────────────────

describe("GET /license/status while unlicensed", () => {
  it("answers (exempt) with required, licensed, reason and deployment", async () => {
    service.__setLicenseForTesting({ claims: null });
    const res = await call("GET", "/license/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ system: "dms", required: true, licensed: false, reason: "NO_LICENSE", deployment: "sso" });
  });
  it("reports MODE_NOT_LICENSED and the standalone deployment", async () => {
    cfg.OIDC_CLIENT_ID = undefined;
    service.__setLicenseForTesting({ claims: claims({ expiresAt: future, modes: ["sso"] }) });
    const res = await call("GET", "/license/status");
    expect(res.body).toMatchObject({ required: true, licensed: false, reason: "MODE_NOT_LICENSED", deployment: "standalone" });
  });
});

// ── POST /license/install over HTTP (ten per minute per IP: this file stays well under it) ──────────────────────

describe("POST /license/install", () => {
  const tokenFor = (key: ReturnType<typeof makeKey>, payload: Record<string, unknown> = {}) => signLicense(key, { payload });
  const install = (body: unknown) => (request(app) as any).post("/api/v1/license/install").send(body);

  it("a valid token is held, licenses the system and the very next request is served", async () => {
    expect((await call("GET", "/documents")).status).toBe(403);
    const res = await install({ token: tokenFor(pinned, { ver: 3, customer: "Acme", expiresAt: future.toISOString() }) });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ outcome: "updated", installed: true, status: { licensed: true, reason: null, customer: "Acme", version: 3 } });
    expect((await call("GET", "/documents")).status).toBe(200);
  });

  it("a bad signature answers 400 and the system stays unlicensed", async () => {
    const res = await install({ token: tokenFor(stranger) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ERR-LICENSE-INVALID");
    expect((await call("GET", "/documents")).status).toBe(403);
  });

  it("a token for another system answers 400", async () => {
    const res = await install({ token: tokenFor(pinned, { aud: "license:gms", sys: "gms" }) });
    expect(res.status).toBe(400);
  });

  it("an older ver is ignored: 200 with outcome ignored-older, the held licence untouched", async () => {
    await install({ token: tokenFor(pinned, { ver: 5, maxUsers: 10 }) });
    const res = await install({ token: tokenFor(pinned, { ver: 4, maxUsers: 999 }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "ignored-older", installed: false, status: { version: 5, maxUsers: 10 } });
  });

  it.each([{}, { token: 5 }, { token: "" }, { token: "x".repeat(20_000) }, undefined])("a missing or malformed body (%#) answers 400", async (body) => {
    const res = await install(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ERR-LICENSE-INVALID");
  });
});

// ── the real application ───────────────────────────────────────────────────────────────────────────────────────

describe("wired into the real app (createApp)", () => {
  let real: any;
  beforeAll(async () => {
    const { createApp } = await import("../src/app.js");
    real = createApp();
  });

  it("required and unlicensed: a protected route is refused before authentication (403, not 401), with the contract body", async () => {
    service.__setLicenseForTesting({ claims: null });
    for (const [method, url] of [["post", "/api/v1/documents"], ["get", "/api/v1/letters"], ["get", "/api/v1/folders"], ["delete", "/api/v1/folders/1"]] as const) {
      const res = await (request(real) as any)[method](url).send();
      expect({ url, status: res.status, code: res.body?.error?.code }).toEqual({ url, status: 403, code: "LICENSE_REQUIRED" });
    }
  });

  it("the public e-signing and QR verification routes are covered too", async () => {
    service.__setLicenseForTesting({ claims: null });
    expect((await request(real).post("/api/v1/signing/1/recipients/2/sign/external").send({})).body.error.code).toBe("LICENSE_REQUIRED");
    expect((await request(real).get("/api/v1/letters/verify")).body.error.code).toBe("LICENSE_REQUIRED");
  });

  it("the TUS upload endpoint is refused as well", async () => {
    service.__setLicenseForTesting({ claims: null });
    const res = await request(real).post("/api/v1/documents/upload/tus").send();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LICENSE_REQUIRED");
  });

  it("sign-in and health stay reachable (whatever they then answer, not LICENSE_REQUIRED)", async () => {
    service.__setLicenseForTesting({ claims: null });
    const login = await request(real).post("/api/v1/auth/login").send({});
    expect(login.body?.error?.code).not.toBe("LICENSE_REQUIRED");
    const authorize = await request(real).get("/api/v1/auth/oidc/authorize");
    expect(authorize.body?.error?.code).not.toBe("LICENSE_REQUIRED");
    const callback = await request(real).post("/api/v1/auth/callback").send({});
    expect(callback.body?.error?.code).not.toBe("LICENSE_REQUIRED");
    const me = await request(real).get("/api/v1/auth/me");
    expect(me.status).toBe(401); // reached authenticate
    expect((await request(real).get("/health")).status).toBe(200);
    expect((await request(real).get("/api/v1/health")).status).toBe(200);
  });

  it("GET /license/status is reached (authenticate answers 401: it needs a login, the guard does not stand in the way)", async () => {
    service.__setLicenseForTesting({ claims: null });
    expect((await request(real).get("/api/v1/license/status")).status).toBe(401);
  });

  it("POST /license/install needs NO login: a valid token restores service within one request", async () => {
    expect((await request(real).post("/api/v1/documents").send({})).body.error.code).toBe("LICENSE_REQUIRED");
    const res = await request(real).post("/api/v1/license/install").send({ token: signLicense(pinned, { payload: { ver: 2 } }) });
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({ licensed: true, required: true });
    // past the guard: now it is authentication that answers
    expect((await request(real).post("/api/v1/documents").send({})).status).toBe(401);
  });

  it("with the licence not required, nothing is changed: protected routes still answer 401", async () => {
    cfg.LICENSE_REQUIRED = false;
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    expect((await request(real).get("/api/v1/letters")).status).toBe(401);
    expect((await request(real).post("/api/v1/documents").send({})).status).toBe(401);
  });
});
