/**
 * DMS database backup utility — Windows-native (no Docker required).
 *
 * The docker-compose.prod.yml `db-backup` sidecar only protects `dmsprod`
 * when DMS is actually deployed via Docker Compose. The live production
 * server runs DMS as a bare `node`
 * process with no Docker at all — so that sidecar is not backing up
 * anything there today. This script is the Windows-native equivalent,
 * mirroring GMS's proven `backend/scripts/db-backup.js`.
 *
 * Usage: npx tsx scripts/db-backup.ts [development|production]
 */
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config as loadDotenv } from "dotenv";

import { fileURLToPath } from 'node:url';

// tsx runs these scripts as ES modules (package.json has "type": "module"), and
// __dirname does not exist there. Without this the script threw
// `ReferenceError: __dirname is not defined in ES module scope` on its first
// line of real work — which is how `npm run db:backup` came to be a command
// that had never once produced a backup, and how the scheduled task registered
// by register-backup-task.ps1 came to fail silently every night.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mode = process.argv[2] === "production" ? "production" : "development";

// ENV FILE LOADING CONTRACT — the same one src/config/env.ts enforces:
// production reads .env.production ONLY, anything else reads .env ONLY.
//
// This used to load .env first and layer .env.production on top, with a
// comment claiming it matched src/config/env.ts. It no longer does: layering
// was removed platform-wide on 2026-09-05 precisely because dotenv only
// overrides the keys the second file NAMES, so anything .env.production omits
// keeps its DEVELOPMENT value. A backup script is the worst possible place for
// that — the job reports success and the thing you need back is not what was
// saved. Fixed 2026-09-06.
const envPath = path.resolve(
  __dirname,
  "..",
  mode === "production" ? ".env.production" : ".env",
);
if (!fs.existsSync(envPath)) {
  console.error(
    `[ERROR] ${envPath} does not exist. ${mode} configuration is read from ` +
      "that file only — there is deliberately no fallback to the other one.",
  );
  process.exit(1);
}
loadDotenv({ path: envPath, override: true });

let pgDumpCmd = "pg_dump";
const commonPgPaths = [
  "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe",
  "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe",
  "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe",
  "C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe",
];
if (process.platform === "win32") {
  const found = commonPgPaths.find((p) => fs.existsSync(p));
  if (found) pgDumpCmd = `"${found}"`;
}

const dbName = process.env.DB_NAME;

// BACKUP_DB_USER / BACKUP_DB_PASSWORD override DB_USER / DB_PASSWORD for the
// dump ONLY. They exist because of row-level security, and without them this
// script cannot back up dmsprod at all.
//
// Discovered 2026-09-09 on the live server, running this script by hand:
//
//   pg_dump: error: query would be affected by row-level security policy
//                   for table "access_rules"
//
// DMS enforces multi-tenant isolation with RLS, and migration
// 20260822000004-rls-force.sql applies ALTER TABLE ... FORCE ROW LEVEL
// SECURITY — which deliberately subjects the table OWNER to the policies too,
// so that a compromised app role cannot read across tenants by virtue of
// owning the tables. `edams_app` owns every table in dmsprod, so pg_dump
// running as `edams_app` is filtered by those policies.
//
// Postgres refuses the dump outright rather than writing the subset it can
// see, which is the only safe behaviour: a backup silently missing every
// tenant-scoped row would restore cleanly and be empty where it mattered.
//
// The fix is to dump as a role that bypasses RLS (a superuser, or any role
// with BYPASSRLS). Do NOT instead grant BYPASSRLS to `edams_app` — that is
// the live application's own role, and it would disable tenant isolation for
// every request DMS serves, to fix a nightly batch job.
//
// If these are unset the script behaves exactly as before, so development
// (where RLS is not forced) needs no configuration.
const dbUser = process.env.BACKUP_DB_USER || process.env.DB_USER;
const dbPass = process.env.BACKUP_DB_PASSWORD || process.env.DB_PASSWORD;
const dbHost = process.env.DB_HOST || "localhost";
const dbPort = process.env.DB_PORT || "5432";

if (!dbName || !dbUser) {
  console.error(`[ERROR] Missing DB_NAME/DB_USER after loading ${envPath}`);
  process.exit(1);
}

// Mirrors GMS's script: backups live at the repo root, not backend/backups —
// an equivalent path claim for GMS was once wrong for the same
// reason, so this is written to match the actual resolved path up front.
const backupDir = path.resolve(__dirname, "..", "..", "backups");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split(".")[0];
const filename = `${dbName}_${mode}_${timestamp}.dump`;
const filepath = path.join(backupDir, filename);
const partPath = `${filepath}.part`;

console.log(`[BACKUP] dmsprod-style backup for ${dbName} at ${dbHost}:${dbPort}...`);

try {
  if (dbPass) process.env.PGPASSWORD = dbPass;

  // Custom format + compression (matches the Docker sidecar's format so
  // either backup can be restored the same way via pg_restore), written to
  // a .part file first and renamed atomically so a crash mid-dump never
  // leaves a truncated file masquerading as a real backup.
  const command = `${pgDumpCmd} -h ${dbHost} -p ${dbPort} -U ${dbUser} --format=custom --compress=6 -f "${partPath}" ${dbName}`;
  execSync(command, { stdio: "inherit" });
  fs.renameSync(partPath, filepath);

  console.log(`[SUCCESS] ${filepath}`);

  // 30-day retention, same as GMS's script.
  const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const file of fs.readdirSync(backupDir)) {
    const fPath = path.join(backupDir, file);
    if (now - fs.statSync(fPath).mtimeMs > RETENTION_MS) {
      fs.unlinkSync(fPath);
      console.log(`[PRUNE] ${file}`);
    }
  }
} catch (error: any) {
  if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  console.error(`[FAILED] ${error.message}`);
  process.exit(1);
} finally {
  delete process.env.PGPASSWORD;
}
