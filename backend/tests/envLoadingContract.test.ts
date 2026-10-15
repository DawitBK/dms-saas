/**
 * Regression test for the env-file loading contract in src/config/env.ts:
 *
 *   NODE_ENV=production   ->  .env.production ONLY. `.env` is NEVER read.
 *   anything else         ->  .env ONLY.
 *
 * WHY THIS TEST EXISTS
 *
 * On 2026-09-05 a production launch of DMS was measured resolving its
 * configuration from the DEVELOPMENT `.env`: the dev database, a personal
 * Gmail address in EMAIL_REDIRECT_TO (which silently diverts every
 * notification, approval request and dispatched letter away from its real
 * recipient), and no STORAGE_LOCAL_PATH. It did that without a single error,
 * because `.env` was layered UNDERNEATH `.env.production` and dotenv only
 * overrides the keys the layering file actually names — so every key
 * `.env.production` happened not to mention kept its developer value. `.env`'s
 * own first line, NODE_ENV=development, additionally clobbered the launcher's
 * NODE_ENV=production, which disabled the production layer entirely AND made
 * every check in assertProductionRuntimeRequirements() return early.
 *
 * None of that is visible from inside a normal unit test, because
 * tests/setup-env.cjs has already populated process.env by the time any test
 * module imports the config. The only way to test the loader is to run it in a
 * real child process, with a real cwd, against real files on disk — which is
 * what this does.
 *
 * The assertion that carries the weight is MINIO_ACCESS_KEY: the fixture
 * `.env` defines it and the fixture `.env.production` does not. If a
 * production run ever sees a value there again, `.env` is being read in
 * production and this contract has been broken.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Located by looking for a landmark file rather than from the test module's own
 * path: ts-jest compiles this suite to CommonJS, so `import.meta.url` is a
 * compile error, and `__dirname` would break if the preset is ever switched to
 * true ESM. Both supported invocations are covered — `cd backend && npm test`
 * and `npm test -w backend` from the DMS workspace root.
 */
const backendDir = (() => {
  const candidates = [process.cwd(), path.join(process.cwd(), "backend")];
  const hit = candidates.find((dir) => fs.existsSync(path.join(dir, "src", "config", "env.ts")));
  if (!hit) {
    throw new Error(
      `Could not locate the DMS backend directory from ${process.cwd()} — looked in: ${candidates.join(", ")}`,
    );
  }
  return hit;
})();

const envModuleUrl = pathToFileURL(path.join(backendDir, "src", "config", "env.js")).href;

/**
 * tsx is resolved to an ABSOLUTE file URL rather than passed as the bare
 * specifier `--import tsx`. Node resolves a bare specifier relative to the
 * child's cwd, and the child's cwd is a temp directory with no node_modules,
 * so the bare form fails with ERR_MODULE_NOT_FOUND.
 *
 * DMS is an npm workspaces repo, so tsx normally hoists to DMS/node_modules;
 * both locations are checked so a non-hoisted install still works.
 */
const tsxLoaderUrl = (() => {
  const relative = path.join("node_modules", "tsx", "dist", "loader.mjs");
  const candidates = [
    path.join(backendDir, "..", relative),
    path.join(backendDir, relative),
  ];
  const hit = candidates.find((file) => fs.existsSync(file));
  if (!hit) {
    throw new Error(`Could not locate tsx's loader — looked in: ${candidates.join(", ")}`);
  }
  return pathToFileURL(hit).href;
})();

const LONG_SECRET = "0123456789012345678901234567890123456789";

/** Keys the schema requires in production, so fixtures boot for the right reasons. */
const PRODUCTION_BASELINE = [
  "NODE_ENV=production",
  "DB_NAME=prod-database",
  "DB_USER=edams_app",
  "DB_PASSWORD=a-real-password",
  "AUTH_ISSUER=https://example.test/sso",
  "AUTH_AUDIENCE=edams-api",
  `AUDIT_HMAC_SECRET=${LONG_SECRET}`,
  `JWT_SECRET=${LONG_SECRET}`,
  `JWT_REFRESH_SECRET=${LONG_SECRET}`,
].join("\n");

/**
 * The development file. Every key here that is ABSENT from the production
 * fixture above is a tripwire: seeing any of them in a production run proves
 * `.env` was read when it should not have been.
 */
const DEVELOPMENT_ENV = [
  "NODE_ENV=development",
  "DB_NAME=dev-database",
  "DB_USER=postgres",
  "MINIO_ACCESS_KEY=dev-minio-access-key",
  "MINIO_SECRET_KEY=dev-minio-secret-key",
  "EMAIL_REDIRECT_TO=developer@example.test",
  "STORAGE_LOCAL_PATH=/tmp/dev-store",
  `AUDIT_HMAC_SECRET=${LONG_SECRET}`,
  `JWT_SECRET=${LONG_SECRET}`,
  `JWT_REFRESH_SECRET=${LONG_SECRET}`,
].join("\n");

const PROBE = `
import { config } from ${JSON.stringify(envModuleUrl)};
console.log("__PROBE__" + JSON.stringify({
  NODE_ENV: config.NODE_ENV,
  DB_NAME: config.DB_NAME,
  DB_USER: config.DB_USER,
  MINIO_ACCESS_KEY: config.MINIO_ACCESS_KEY,
  EMAIL_REDIRECT_TO: config.EMAIL_REDIRECT_TO ?? null,
  STORAGE_LOCAL_PATH: config.STORAGE_LOCAL_PATH ?? null,
}));
`;

interface ProbeResult {
  NODE_ENV: string;
  DB_NAME: string;
  DB_USER: string;
  MINIO_ACCESS_KEY: string;
  EMAIL_REDIRECT_TO: string | null;
  STORAGE_LOCAL_PATH: string | null;
}

let workdir: string;

/**
 * The child gets a SCRUBBED environment — only what Node itself needs to run,
 * plus NODE_ENV — rather than an inherited copy of Jest's.
 *
 * This is not tidiness. tests/setup-env.cjs populates the Jest worker's
 * process.env with non-production stand-ins (MINIO_ACCESS_KEY among them), and
 * dotenv's override only replaces keys the loaded FILE names — so an inherited
 * variable that the file does not mention survives into the resolved config
 * and would mask exactly the leak this suite exists to detect. Scrubbing also
 * makes the child a faithful stand-in for a real service launch, where the
 * only configuration present is what the env file supplies.
 */
const PASSTHROUGH_ENV = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "APPDATA"];

function runProbe(nodeEnv: string): ProbeResult {
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }

  const stdout = execFileSync(process.execPath, ["--import", tsxLoaderUrl, "probe.ts"], {
    cwd: workdir,
    encoding: "utf8",
    env: childEnv,
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("__PROBE__"));
  if (!line) throw new Error(`probe produced no result. stdout was:\n${stdout}`);
  return JSON.parse(line.slice("__PROBE__".length)) as ProbeResult;
}

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dms-env-contract-"));
  fs.writeFileSync(path.join(workdir, "probe.ts"), PROBE);
  fs.writeFileSync(path.join(workdir, ".env"), DEVELOPMENT_ENV);
  fs.writeFileSync(path.join(workdir, ".env.production"), PRODUCTION_BASELINE);
});

afterAll(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
});

// Spawning node + tsx per case is a few seconds each on Windows.
jest.setTimeout(120_000);

describe("env file loading contract", () => {
  describe("NODE_ENV=production", () => {
    it("reads .env.production and does NOT read .env", () => {
      const result = runProbe("production");

      // The tripwire. `.env` defines MINIO_ACCESS_KEY; `.env.production` does
      // not. A value here means the development file was read in production.
      expect(result.MINIO_ACCESS_KEY).toBe("");

      // The specific values that were actually wrong in the real incident.
      expect(result.EMAIL_REDIRECT_TO).toBeNull();
      expect(result.STORAGE_LOCAL_PATH).toBeNull();
      expect(result.DB_NAME).toBe("prod-database");
      expect(result.DB_USER).toBe("edams_app");
    });

    it("keeps NODE_ENV=production even though .env's first line says development", () => {
      // The clobber that disabled every production guard. `.env` is not read
      // in production at all now, so this can only regress if the loading
      // order is changed back.
      expect(runProbe("production").NODE_ENV).toBe("production");
    });

    it("refuses to boot when .env.production is missing, naming the real cause", () => {
      const productionFile = path.join(workdir, ".env.production");
      const saved = fs.readFileSync(productionFile, "utf8");
      fs.rmSync(productionFile);
      try {
        expect(() => runProbe("production")).toThrow(/\.env\.production does not exist/);
      } finally {
        fs.writeFileSync(productionFile, saved);
      }
    });
  });

  describe("non-production", () => {
    it("reads .env in development", () => {
      const result = runProbe("development");
      expect(result.DB_NAME).toBe("dev-database");
      expect(result.MINIO_ACCESS_KEY).toBe("dev-minio-access-key");
    });

    it("does not let .env's NODE_ENV=development override an explicit NODE_ENV=test", () => {
      // Otherwise the Jest suite silently points at the development database.
      expect(runProbe("test").NODE_ENV).toBe("test");
    });
  });
});
