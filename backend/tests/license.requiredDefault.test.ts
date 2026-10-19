/**
 * LICENSE_REQUIRED's default (contract section 9): true when NODE_ENV is production or mirror (the live server and
 * the prod-parity mirror), false otherwise, and an explicit value always wins. The default depends on the NODE_ENV the
 * env loader pins, so, like tests/envLoadingContract.test.ts, it is proved in a real child process with a real cwd and
 * real env files; the Jest worker's own process.env is already populated by tests/setup-env.cjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const backendDir = (() => {
  const candidates = [process.cwd(), path.join(process.cwd(), "backend")];
  const hit = candidates.find((dir) => fs.existsSync(path.join(dir, "src", "config", "env.ts")));
  if (!hit) throw new Error(`Could not locate the DMS backend directory from ${process.cwd()}`);
  return hit;
})();
const envModuleUrl = pathToFileURL(path.join(backendDir, "src", "config", "env.js")).href;
const tsxLoaderUrl = (() => {
  const relative = path.join("node_modules", "tsx", "dist", "loader.mjs");
  const hit = [path.join(backendDir, "..", relative), path.join(backendDir, relative)].find((f) => fs.existsSync(f));
  if (!hit) throw new Error("Could not locate tsx's loader");
  return pathToFileURL(hit).href;
})();

const LONG_SECRET = "0123456789012345678901234567890123456789";
const BASELINE = [
  "DB_NAME=some-database",
  "DB_USER=edams_app",
  "DB_PASSWORD=a-real-password",
  "AUTH_ISSUER=https://example.test/sso",
  "AUTH_AUDIENCE=edams-api",
  `AUDIT_HMAC_SECRET=${LONG_SECRET}`,
  `JWT_SECRET=${LONG_SECRET}`,
  `JWT_REFRESH_SECRET=${LONG_SECRET}`,
];

const PROBE = `
import { config } from ${JSON.stringify(envModuleUrl)};
console.log("__PROBE__" + JSON.stringify({ NODE_ENV: config.NODE_ENV, LICENSE_REQUIRED: config.LICENSE_REQUIRED, TRUST: config.LICENSE_TRUST_PUBLIC_KEYS ?? null }));
`;

let workdir: string;
const PASSTHROUGH_ENV = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "APPDATA"];

function probe(nodeEnv: string, extra: string[] = []): { NODE_ENV: string; LICENSE_REQUIRED: boolean; TRUST: string | null } {
  const file = nodeEnv === "production" ? ".env.production" : nodeEnv === "mirror" ? ".env.mirror" : ".env";
  fs.writeFileSync(path.join(workdir, file), [...BASELINE, `NODE_ENV=${nodeEnv}`, ...extra].join("\n"));
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
  for (const key of PASSTHROUGH_ENV) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  const stdout = execFileSync(process.execPath, ["--import", tsxLoaderUrl, "probe.ts"], { cwd: workdir, encoding: "utf8", env: childEnv });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("__PROBE__"));
  if (!line) throw new Error(`probe produced no result. stdout was:\n${stdout}`);
  return JSON.parse(line.slice("__PROBE__".length));
}

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-license-required-"));
  fs.writeFileSync(path.join(workdir, "probe.ts"), PROBE);
});
afterAll(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of [".env", ".env.production", ".env.mirror"]) fs.rmSync(path.join(workdir, f), { force: true });
});

jest.setTimeout(120_000);

describe("LICENSE_REQUIRED default", () => {
  it("production: true", () => {
    expect(probe("production")).toMatchObject({ NODE_ENV: "production", LICENSE_REQUIRED: true });
  });
  it("mirror: true (the prod-parity mirror is licensed like the live server)", () => {
    expect(probe("mirror")).toMatchObject({ NODE_ENV: "mirror", LICENSE_REQUIRED: true });
  });
  it("development: false (development and tests behave exactly as before)", () => {
    expect(probe("development")).toMatchObject({ NODE_ENV: "development", LICENSE_REQUIRED: false });
  });
  it("test: false", () => {
    expect(probe("test")).toMatchObject({ NODE_ENV: "test", LICENSE_REQUIRED: false });
  });
  it("an explicit false wins in production (and is then logged at error level at every start)", () => {
    expect(probe("production", ["LICENSE_REQUIRED=false"]).LICENSE_REQUIRED).toBe(false);
  });
  it("an empty value (compose interpolation of an unset variable) means the default, not false", () => {
    expect(probe("production", ["LICENSE_REQUIRED="]).LICENSE_REQUIRED).toBe(true);
    expect(probe("development", ["LICENSE_REQUIRED="]).LICENSE_REQUIRED).toBe(false);
  });
  it("an explicit true wins in development; LICENSE_TRUST_PUBLIC_KEYS comes through as the raw string", () => {
    const keys = JSON.stringify([{ kty: "RSA", n: "AQAB", e: "AQAB" }]);
    expect(probe("development", ["LICENSE_REQUIRED=true", `LICENSE_TRUST_PUBLIC_KEYS=${keys}`])).toMatchObject({ LICENSE_REQUIRED: true, TRUST: keys });
  });
});
