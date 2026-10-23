/**
 * Incident containment in DMS (modules/license/incidentLock.ts, incidentGate.ts). A bare Express app with the real gate and the real error handler, and a
 * real temporary lock file. No database.
 *
 * Proves: no lock = nothing changes; with a lock every non-allowlisted POST/PUT/PATCH/DELETE answers 403 INCIDENT_READ_ONLY; reads keep working; every
 * licence read-only allowlist entry and entitlement exemption keeps working (sign-in, health, licence routes); the lock is cached about three seconds;
 * junk content still locks; an unreadable path fails open; the gate never throws; and it is wired ahead of the licence gate on the v1 router and the TUS upload.
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

import { errorHandler } from "../src/shared/middleware.js";
import { createIncidentGate } from "../src/modules/license/incidentGate.js";
import { readIncidentLock, resetIncidentLockCache } from "../src/modules/license/incidentLock.js";
import { ENTITLEMENT_EXEMPT, READ_ONLY_ALLOWLIST } from "../src/modules/license/licenseGate.js";

let dir = "";
let lockFile = "";
let app: express.Express;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-incident-"));
  lockFile = path.join(dir, "incident.lock");
  const a: any = express();
  const v1: any = express.Router();
  v1.use(createIncidentGate(() => readIncidentLock(lockFile)));
  v1.use((req: any, res: any) => res.json({ reached: true, path: req.path }));
  a.use("/api/v1", v1);
  a.use(errorHandler);
  app = a;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(lockFile, { force: true });
  resetIncidentLockCache();
});

const lock = (body = JSON.stringify({ at: new Date().toISOString(), reason: "audit_chain_broken", kind: "audit_chain_broken" })) => {
  fs.writeFileSync(lockFile, body);
  resetIncidentLockCache();
};
type M = "get" | "post" | "put" | "patch" | "delete";
const send = (m: M, p: string) => (request(app) as any)[m](`/api/v1${p}`).send(m === "get" ? undefined : {});
const code = (res: request.Response): string | undefined => res.body?.error?.code ?? res.body?.code;

describe("with no lock", () => {
  it("lets every method through", async () => {
    for (const m of ["get", "post", "put", "patch", "delete"] as M[]) expect((await send(m, "/documents")).status).toBe(200);
  });
});

describe("with a lock file", () => {
  it.each([
    ["post", "/documents"],
    ["put", "/users/abc"],
    ["patch", "/folders/1"],
    ["delete", "/documents/1"],
    ["post", "/tenants"],
    ["put", "/internal/roles/tenants/t1/role-mappings/x"],
  ] as Array<[M, string]>)("refuses %s %s with 403 INCIDENT_READ_ONLY", async (m, p) => {
    lock();
    const res = await send(m, p);
    expect(res.status).toBe(403);
    expect(code(res)).toBe("INCIDENT_READ_ONLY");
  });

  it("keeps reads working", async () => {
    lock();
    for (const p of ["/documents", "/users", "/license/status", "/operations/ready"]) expect((await send("get", p)).status).toBe(200);
  });

  // A concrete path for every licence allowlist / exemption entry, written out; the count check fails when an entry is added without a line here.
  const PATHS: Array<[M, string]> = [
    ["post", "/auth/login"], ["post", "/auth/refresh"], ["post", "/auth/logout"], ["put", "/auth/select-tenant"],
    ["post", "/license/install"], ["post", "/license/status"],
    ["post", "/operations/health"], ["post", "/operations/ready"], ["post", "/operations/client-error"],
    ["post", "/internal/roles/tenants/t1/role-mappings/resolve"],
    ["post", "/letters/preview-pdf"], ["post", "/forms/templates/preview"], ["post", "/ai/chat"], ["post", "/health"],
  ];
  it("covers every read-only allowlist entry and every entitlement exemption with a concrete path", () => {
    for (const e of [...READ_ONLY_ALLOWLIST, ...ENTITLEMENT_EXEMPT]) {
      expect(PATHS.some(([m, p]) => e.pattern.test(p) && (e.method === "*" || e.method === m.toUpperCase()))).toBe(true);
    }
  });
  it.each(PATHS)("keeps %s %s working (sign-in, health and licence routes must survive containment)", async (m, p) => {
    lock();
    expect((await send(m, p)).status).toBe(200);
  });

  it("lifts when the file is removed", async () => {
    lock();
    expect((await send("post", "/documents")).status).toBe(403);
    fs.rmSync(lockFile);
    resetIncidentLockCache();
    expect((await send("post", "/documents")).status).toBe(200);
  });

  it("caches the answer for about three seconds", () => {
    lock();
    const t0 = Date.now();
    expect(readIncidentLock(lockFile, t0)).not.toBeNull();
    fs.rmSync(lockFile);
    expect(readIncidentLock(lockFile, t0 + 2000)).not.toBeNull();
    expect(readIncidentLock(lockFile, t0 + 3500)).toBeNull();
  });

  it("still locks when the file holds junk, and fails open when the path cannot be inspected", () => {
    lock("not json");
    expect(readIncidentLock(lockFile)).toEqual({ at: null, reason: null, kind: null });
    expect(readIncidentLock(path.join(lockFile, "nested", "incident.lock"))).toBeNull();
    expect(readIncidentLock("")).toBeNull();
    expect(readIncidentLock(undefined)).toBeNull();
  });

  it("never throws: a failing lookup lets the request through", async () => {
    const bare: any = express();
    bare.use(createIncidentGate(() => { throw new Error("boom"); }));
    bare.use((_req: any, res: any) => res.json({ reached: true }));
    expect((await request(bare).post("/documents").send({})).status).toBe(200);
  });
});

describe("wiring", () => {
  it("is mounted ahead of the licence gate on the v1 router and in front of the TUS upload", () => {
    const v1 = fs.readFileSync(path.join(__dirname, "..", "src", "api", "v1", "index.ts"), "utf8");
    expect(v1.indexOf("v1Routes.use(incidentGate)")).toBeGreaterThan(-1);
    expect(v1.indexOf("v1Routes.use(incidentGate)")).toBeLessThan(v1.indexOf("v1Routes.use(licenseGate)"));
    const appTs = fs.readFileSync(path.join(__dirname, "..", "src", "app.ts"), "utf8");
    expect(appTs).toMatch(/app\.all\(TUS_PATH, incidentGate as any, licenseGate as any/);
  });
});
