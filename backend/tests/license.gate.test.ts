/**
 * The licence request guard (modules/license/licenseGate.ts): read-only on expiry, the allowlist, the module gate.
 *
 * Two layers: a bare Express app with only the gate (fast, exhaustive: every allowlist entry, one route per module,
 * every state and mode) and the REAL app from createApp() (proves it is actually wired in front of the v1 router,
 * the public routes and the TUS endpoint, and that a request with no licence is untouched).
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";

const mockQuery = jest.fn();
jest.mock("../src/infrastructure/database/sequelize.js", () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));

import { config } from "../src/config/env.js";
import { errorHandler } from "../src/shared/middleware.js";
import { DMS_LICENSE_MODULES } from "../src/modules/license/license.constants.js";
import * as service from "../src/modules/license/license.service.js";
import { licenseRoutes } from "../src/modules/license/license.routes.js";
import {
  MODULE_ROUTES,
  READ_ONLY_ALLOWLIST,
  apiRelativePath,
  isAllowlisted,
  licenseGate,
  moduleForPath,
} from "../src/modules/license/licenseGate.js";
import { claims } from "./licenseTestKit.js";

const cfg = config as unknown as Record<string, unknown>;
const original = { ...cfg };

const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetDays: number) => new Date(now + offsetDays * DAY);

type Held = Parameters<typeof service.__setLicenseForTesting>[0];
const held = (over: Partial<ReturnType<typeof claims>>): Held => ({ claims: claims(over) });
const STATES: Record<string, Held> = {
  active: held({ expiresAt: iso(200) }),
  perpetual: held({ expiresAt: null }),
  expiring: held({ expiresAt: iso(10) }),
  grace: held({ expiresAt: iso(-3) }),
  expired: held({ expiresAt: iso(-30) }), // grace 14 days, so well past it
};
const expired = (over: Partial<ReturnType<typeof claims>> = {}): Held => held({ expiresAt: iso(-30), ...over });

function miniApp() {
  const app: any = express();
  app.use(express.json());
  const v1: any = express.Router();
  v1.use(licenseGate);
  v1.use("/license", licenseRoutes);
  v1.use((req: any, res: any) => res.json({ reached: true, method: req.method, path: req.path }));
  app.use("/api/v1", v1);
  app.use(errorHandler);
  return app;
}

const app = miniApp();
const call = (method: string, url: string) => (request(app) as any)[method.toLowerCase()](`/api/v1${url}`).send();

beforeEach(() => {
  service.__resetLicenseForTesting();
  mockQuery.mockReset();
  cfg.LICENSE_ENFORCEMENT = "enforce";
});
afterEach(() => {
  Object.assign(cfg, original);
  jest.restoreAllMocks();
});

// ── read-only guard ──────────────────────────────────────────────────────────────────────────────────────────

describe("read-only guard: state `expired` refuses writes with the system's own error shape", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s on an ordinary route -> 403 LICENSE_EXPIRED", async (method) => {
    service.__setLicenseForTesting(STATES.expired);
    const res = await call(method, "/documents/123");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: "LICENSE_EXPIRED", message: "The licence has expired; the system is read-only. Contact your administrator." },
    });
  });

  it.each(["GET", "HEAD", "OPTIONS"])("safe method %s always passes", async (method) => {
    service.__setLicenseForTesting(STATES.expired);
    const res = await call(method, "/documents/123");
    expect(res.status).toBe(200);
  });

  it.each(["active", "perpetual", "expiring", "grace"])("in state %s writes are NOT refused (banner only, full function)", async (name) => {
    service.__setLicenseForTesting(STATES[name]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call(method, "/documents/123")).status).toBe(200);
    }
  });

  it("principle 1: unconfigured (SSO has no record) and unknown (never fetched) never refuse anything", async () => {
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    expect((await call("POST", "/documents")).status).toBe(200);
    service.__setLicenseForTesting({ claims: null, noRecord: false });
    expect((await call("DELETE", "/documents/1")).status).toBe(200);
    expect((await call("POST", "/letters")).status).toBe(200);
  });

  it("LICENSE_ENFORCEMENT=warn and =off never refuse, even when expired with every module off", async () => {
    for (const mode of ["warn", "off"]) {
      cfg.LICENSE_ENFORCEMENT = mode;
      service.__setLicenseForTesting(expired({ modules: [] }));
      expect((await call("POST", "/documents")).status).toBe(200);
      expect((await call("GET", "/letters")).status).toBe(200);
    }
  });

  it("fails OPEN if the guard itself faults", async () => {
    jest.spyOn(service, "getLicenseSnapshot").mockImplementation(() => {
      throw new Error("boom");
    });
    expect((await call("POST", "/documents")).status).toBe(200);
  });
});

describe("the read-only allowlist: every entry keeps working while expired", () => {
  // One or more concrete requests per allowlist entry. The coverage test below fails if an entry has none.
  const AUTH_POSTS = [
    "/auth/login", "/auth/dev/token", "/auth/verify", "/auth/select-tenant", "/auth/switch-tenant", "/auth/select-role",
    "/auth/switch-role", "/auth/refresh", "/auth/logout", "/auth/totp/setup", "/auth/totp/confirm", "/auth/totp/validate",
    "/auth/totp/disable", "/auth/callback", "/auth/oidc/jwks/refresh", "/auth/backchannel-logout",
  ];
  const CASES: Array<[string, string]> = [
    ...AUTH_POSTS.map((p): [string, string] => ["POST", p]),
    ["PUT", "/auth/anything-else-under-auth"],
    ["GET", "/license/status"],
    ["POST", "/license/anything"],
    ["GET", "/operations/health"],
    ["GET", "/operations/ready"],
    ["POST", "/operations/client-error"],
    ["POST", "/internal/roles/tenants/examplecorp/role-mappings/resolve"],
    ["POST", "/letters/preview-pdf"],
    ["POST", "/forms/templates/preview"],
    ["POST", "/ai/chat"],
  ];

  it.each(CASES)("%s %s passes", async (method, url) => {
    service.__setLicenseForTesting(expired({ modules: null }));
    const res = await call(method, url);
    expect(res.status).toBe(200);
    expect(res.body.reached ?? true).toBe(true);
  });

  it("every allowlist entry is exercised by at least one case above", () => {
    for (const entry of READ_ONLY_ALLOWLIST) {
      const hit = CASES.some(([m, p]) => (entry.method === "*" || entry.method === m) && entry.pattern.test(p));
      expect({ entry: `${entry.method} ${entry.pattern}`, hit }).toEqual({ entry: `${entry.method} ${entry.pattern}`, hit: true });
    }
  });

  it("every auth POST route that exists in auth.routes.ts is in the list above (a new one must be added here, deliberately)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "auth", "auth.routes.ts"), "utf-8");
    const found = [...src.matchAll(/authRoutes\.post\(\s*['"]([^'"]+)['"]/g)].map((m) => `/auth${m[1]}`);
    expect(found.length).toBeGreaterThan(10);
    for (const p of found) expect(AUTH_POSTS).toContain(p);
  });

  it.each([
    ["POST", "/documents"],
    ["POST", "/documents/bulk"],
    ["PATCH", "/documents/1/status"],
    ["PUT", "/users/me/signature-image"],
    ["POST", "/users"],
    ["DELETE", "/folders/1"],
    ["POST", "/folders"],
    ["POST", "/operations/outbox/1/retry"],
    ["POST", "/operations/health-check"],
    ["POST", "/operations/system-errors/clear"],
    ["PUT", "/internal/roles/tenants/t/role-mappings/g"],
    ["PUT", "/internal/roles/tenants/t/roles/r/permissions"],
    ["POST", "/internal/roles/tenants/t/role-mappings/resolve/extra"],
    ["POST", "/letters"],
    ["POST", "/letters/1/submit"],
    ["POST", "/forms/templates"],
    ["POST", "/forms/instances"],
    ["POST", "/ai/documents/1/summarize"],
    ["POST", "/ai/chat/extra"],
    ["POST", "/authx/login"], // prefix must be a path segment, not a string prefix
    ["POST", "/licensex"],
    ["PATCH", "/notifications/read-all"],
    ["POST", "/search/saved"],
  ])("%s %s is refused", async (method, url) => {
    service.__setLicenseForTesting(expired({ modules: null }));
    const res = await call(method, url);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("isAllowlisted is method-aware: a GET-only entry does not open the other verbs", () => {
    expect(isAllowlisted("POST", "/operations/health")).toBe(true); // wildcard entry
    expect(isAllowlisted("PUT", "/operations/client-error")).toBe(false);
    expect(isAllowlisted("post", "/operations/client-error")).toBe(true);
  });
});

// ── module gate ──────────────────────────────────────────────────────────────────────────────────────────────

describe("module gate", () => {
  /** One real route per gateable module (see MODULE_ROUTES for the mapping and its notes). */
  const ONE_ROUTE_PER_MODULE: Record<string, [string, string]> = {
    letters: ["GET", "/letters"],
    workflow: ["GET", "/workflow/definitions"],
    esigning: ["POST", "/signing/uploads"],
    legal_hold: ["GET", "/legal-hold"],
    retention: ["GET", "/retention"],
    ai: ["POST", "/ai/chat"],
    search: ["GET", "/search"],
    archive: ["POST", "/documents/abc/archive"],
    reports: ["GET", "/reports/dashboard"],
    bundles: ["GET", "/bundles"],
    webhooks: ["GET", "/webhooks"],
    forms: ["GET", "/forms/templates"],
  };

  it.each(Object.entries(ONE_ROUTE_PER_MODULE))("module %s: off -> 403 LICENSE_MODULE_DISABLED, on -> reaches the route", async (mod, [method, url]) => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: DMS_LICENSE_MODULES.filter((m) => m !== mod) }));
    const off = await call(method, url);
    expect(off.status).toBe(403);
    expect(off.body.error).toMatchObject({ code: "LICENSE_MODULE_DISABLED", details: { module: mod } });

    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [mod] }));
    expect((await call(method, url)).status).toBe(200);
  });

  it("a disabled module answers EVERY method, reads included (the UI must tell 'not licensed' from 'read-only')", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call(method, "/webhooks/1")).body.error.code).toBe("LICENSE_MODULE_DISABLED");
    }
  });

  it("core routes are never gated, even with an empty module list", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    for (const [method, url] of [
      ["GET", "/documents"], ["POST", "/documents"], ["GET", "/documents/1/versions"], ["GET", "/documents/1/comments"],
      ["GET", "/folders"], ["GET", "/users"], ["GET", "/roles"], ["GET", "/departments"], ["GET", "/org-units"],
      ["GET", "/tenants"], ["GET", "/audit"], ["GET", "/notifications"], ["GET", "/document-types"], ["GET", "/acl/document/1"],
      ["GET", "/access-rules"], ["GET", "/status-permissions"], ["GET", "/tenants/t/feature-flags"],
      ["GET", "/operations/health"], ["POST", "/auth/login"], ["GET", "/license/status"],
      ["GET", "/documents/stats"], ["GET", "/documents/1/download"],
    ]) {
      const res = await call(method, url);
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 200 });
    }
  });

  it("public QR verification of an issued letter stays available even with `letters` off", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    expect((await call("GET", "/letters/verify")).status).toBe(200);
    expect((await call("GET", "/letters/1")).status).toBe(403);
  });

  it("`modules: null` means everything is on", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: null }));
    for (const [method, url] of Object.values(ONE_ROUTE_PER_MODULE)) expect((await call(method, url)).status).toBe(200);
  });

  it("applies in every state except unconfigured/unknown (here: grace and expired)", async () => {
    for (const st of ["expiring", "grace", "expired"]) {
      const base = STATES[st];
      service.__setLicenseForTesting({ claims: { ...base.claims!, modules: ["search"] } });
      expect((await call("GET", "/letters")).body.error?.code).toBe("LICENSE_MODULE_DISABLED");
      expect((await call("GET", "/search")).status).toBe(200);
    }
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    expect((await call("GET", "/letters")).status).toBe(200);
    service.__setLicenseForTesting({ claims: null });
    expect((await call("GET", "/letters")).status).toBe(200);
  });

  it("module-disabled takes precedence over read-only when both apply", async () => {
    service.__setLicenseForTesting(expired({ modules: [] }));
    expect((await call("POST", "/letters")).body.error.code).toBe("LICENSE_MODULE_DISABLED");
  });

  it("esigning covers the document-level and legacy signing routes, not just /signing", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    for (const url of ["/documents/1/signing", "/documents/1/sign/request", "/documents/1/sign/verify", "/signing/requests", "/signing/9/recipients/2/sign/external"]) {
      expect({ url, code: (await call("GET", url)).body.error?.code }).toEqual({ url, code: "LICENSE_MODULE_DISABLED" });
    }
  });

  it("workflow covers approvals too", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    for (const url of ["/approvals/my/work", "/approvals/templates", "/workflow/tasks/1/decide"]) {
      expect((await call("GET", url)).body.error?.code).toBe("LICENSE_MODULE_DISABLED");
    }
  });

  it("ai covers assignment-advisory", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: [] }));
    expect((await call("GET", "/assignment-advisory/x")).body.error?.code).toBe("LICENSE_MODULE_DISABLED");
  });
});

describe("route table", () => {
  it("every gateable key except `ocr` owns at least one route group; `ocr` owns none (OCR runs through the outbox/worker)", () => {
    const owned = new Set(MODULE_ROUTES.map((r) => r.module));
    for (const key of DMS_LICENSE_MODULES) {
      expect({ key, owned: owned.has(key) }).toEqual({ key, owned: key !== "ocr" });
    }
  });
  it("moduleForPath matches whole path segments only", () => {
    expect(moduleForPath("/letters")).toBe("letters");
    expect(moduleForPath("/letters/1")).toBe("letters");
    expect(moduleForPath("/lettersx")).toBeNull();
    expect(moduleForPath("/searching")).toBeNull();
    expect(moduleForPath("/documents/1/archive")).toBe("archive");
    expect(moduleForPath("/documents/1/archived")).toBeNull();
    expect(moduleForPath("/documents/1")).toBeNull();
  });
  it("apiRelativePath strips the API base and trailing slashes, from the router or from the app", () => {
    expect(apiRelativePath({ baseUrl: "/api/v1", path: "/auth/login" })).toBe("/auth/login");
    expect(apiRelativePath({ baseUrl: "/api/v1", path: "/auth/login/" })).toBe("/auth/login");
    expect(apiRelativePath({ baseUrl: "", path: "/api/v1/documents/upload/tus" })).toBe("/documents/upload/tus");
    expect(apiRelativePath({ baseUrl: "", path: "/health" })).toBe("/health");
  });
});

// ── GET /license/status through the route ───────────────────────────────────────────────────────────────────

describe("GET /license/status", () => {
  it("answers with the contract shape and never from cache; works while expired and with modules off", async () => {
    mockQuery.mockResolvedValue([{ n: 12 }]);
    service.__setLicenseForTesting(expired({ modules: [], maxUsers: 20, ver: 9 }));
    const res = await call("GET", "/license/status");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(
      ["system", "state", "customer", "expiresAt", "graceEndsAt", "daysRemaining", "warnDays", "graceDays", "readOnly", "maxUsers", "seatsUsed", "modules", "source", "fetchedAt", "version", "enforcement", "required", "licensed", "reason", "deployment", "limitedBy"].sort(),
    );
    expect(res.body).toMatchObject({ system: "dms", state: "expired", readOnly: true, maxUsers: 20, seatsUsed: 12, modules: [], version: 9 });
  });
});

// ── the real application ─────────────────────────────────────────────────────────────────────────────────────

describe("wired into the real app (createApp)", () => {
  let real: any;
  beforeAll(async () => {
    const { createApp } = await import("../src/app.js");
    real = createApp();
  });

  it("with no licence at all, nothing changes: protected routes still answer 401, not 403", async () => {
    service.__setLicenseForTesting({ claims: null, noRecord: true });
    for (const [method, url] of [["post", "/api/v1/documents"], ["delete", "/api/v1/folders/1"], ["get", "/api/v1/letters"], ["get", "/api/v1/license/status"]] as const) {
      const res = await (request(real) as any)[method](url).send();
      expect({ url, status: res.status }).toEqual({ url, status: 401 });
    }
  });

  it("expired: a write to a protected route is refused before it reaches authentication", async () => {
    service.__setLicenseForTesting(STATES.expired);
    const res = await request(real).post("/api/v1/documents").send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("expired: the public e-signing routes are covered too (an external signer is a write)", async () => {
    service.__setLicenseForTesting(STATES.expired);
    const res = await request(real).post("/api/v1/signing/1/recipients/2/sign/external").send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("expired: the TUS resumable-upload endpoint is a write and is refused; HEAD and OPTIONS are not", async () => {
    service.__setLicenseForTesting(STATES.expired);
    const post = await request(real).post("/api/v1/documents/upload/tus").send();
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe("LICENSE_EXPIRED");
    const patch = await request(real).patch("/api/v1/documents/upload/tus/abc").send();
    expect(patch.status).toBe(403);
    const head = await request(real).head("/api/v1/documents/upload/tus/abc");
    expect(head.status).not.toBe(403);
  });

  it("expired: sign-in still works (the auth route is reached, whatever it then answers)", async () => {
    service.__setLicenseForTesting(STATES.expired);
    const res = await request(real).post("/api/v1/auth/login").send({});
    expect(res.body?.error?.code).not.toBe("LICENSE_EXPIRED");
    expect(res.status).not.toBe(403);
  });

  it("expired: health stays reachable", async () => {
    service.__setLicenseForTesting(STATES.expired);
    expect((await request(real).get("/health")).status).toBe(200);
    expect((await request(real).get("/api/v1/health")).status).toBe(200);
  });

  it("a disabled module answers 403 LICENSE_MODULE_DISABLED from the real router", async () => {
    service.__setLicenseForTesting(held({ expiresAt: iso(200), modules: ["letters"] }));
    const res = await request(real).get("/api/v1/webhooks");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "LICENSE_MODULE_DISABLED", details: { module: "webhooks" } });
    // an enabled module is not intercepted by the gate (it then answers 401: no token)
    expect((await request(real).get("/api/v1/letters")).status).toBe(401);
  });
});
