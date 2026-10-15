/**
 * DMS document-store backup — the other half of db-backup.ts.
 *
 * WHY THIS EXISTS
 *
 * scripts/db-backup.ts dumps `dmsprod` and stops there, and
 * register-backup-task.ps1 schedules only that. But with STORAGE_DRIVER=local
 * — which is what the production server runs, no MinIO, by decision — the
 * database holds metadata, ACLs, audit chain and wrapped keys, while every
 * actual document, letter PDF, form PDF and signed artefact is a file on disk
 * that nothing was copying anywhere.
 *
 * Those two halves fail differently and neither substitutes for the other. Lose
 * the database and you have an opaque pile of encrypted blobs with no titles,
 * no permissions and no DEK wrappers to open them. Lose the storage tree and
 * you have a perfectly consistent catalogue of documents that no longer exist —
 * which is worse, because the UI keeps listing them and only says so when
 * someone tries to open one.
 *
 * RESTORE ORDER MATTERS: database first, then storage. A storage tree newer
 * than the database contains objects no row references (harmless, findable with
 * sweep-orphaned-storage.ts); a database newer than the storage tree references
 * objects that do not exist (a 404 per document, and no way to tell which).
 * Always restore a storage snapshot at least as new as the dump.
 *
 * WHAT IT DOES
 *
 * Mirrors the document store to a backup root with robocopy /MIR, then verifies
 * by comparing file counts and total bytes on both sides rather than trusting
 * the exit code. Refuses to mirror an empty or missing source over a populated
 * destination — /MIR is a delete-to-match, so a source that vanished (a wrong
 * cwd, an unmounted drive) would otherwise propagate the loss into the backup.
 *
 *   npx tsx scripts/storage-backup.ts               # dev
 *   npx tsx scripts/storage-backup.ts production
 *
 * Destination: BACKUP_STORAGE_PATH, else <repo>/backups/storage. Point it at a
 * different physical disk — a mirror on the same drive survives a deleted
 * folder but not the failure that takes the drive.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config as loadDotenv } from 'dotenv';

import { fileURLToPath } from 'node:url';

// tsx runs these scripts as ES modules (package.json has "type": "module"), and
// __dirname does not exist there. Without this the script threw
// `ReferenceError: __dirname is not defined in ES module scope` on its first
// line of real work — which is how `npm run db:backup` came to be a command
// that had never once produced a backup, and how the scheduled task registered
// by register-backup-task.ps1 came to fail silently every night.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mode = process.argv[2] === 'production' ? 'production' : 'development';

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
  '..',
  mode === 'production' ? '.env.production' : '.env',
);
if (!fs.existsSync(envPath)) {
  console.error(
    `[ERROR] ${envPath} does not exist. ${mode} configuration is read from ` +
      'that file only — there is deliberately no fallback to the other one.',
  );
  process.exit(1);
}
loadDotenv({ path: envPath, override: true });

// Must match StorageAdapter's LOCAL_BASE exactly. Deliberately re-derived from
// env rather than imported: importing src/config/env.ts would run the full
// production boot assertions, and a backup must still work on a box whose
// runtime config is incomplete — that is precisely when it is needed.
const source = process.env.STORAGE_LOCAL_PATH
  ? path.resolve(process.env.STORAGE_LOCAL_PATH)
  : path.resolve(__dirname, '..', 'storage', 'dms-documents');

// BACKUP_STORAGE_DEST is an explicit per-run override set by deploy/backup-all.ps1.
// It exists because BACKUP_STORAGE_PATH cannot be overridden from outside: the
// loadDotenv(override:true) above makes .env.production win over the caller's
// environment, which sent the scheduled backup's files to the env file's folder
// instead of the backup root it reported (found 2026-10-01). No env file defines
// this name, so the override:true protection against stray machine-wide
// variables stays intact for everything else.
const destRoot = process.env.BACKUP_STORAGE_DEST
  ? path.resolve(process.env.BACKUP_STORAGE_DEST)
  : process.env.BACKUP_STORAGE_PATH
  ? path.resolve(process.env.BACKUP_STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'backups', 'storage');

/** Recursive file count and total size, so the mirror is checked, not assumed. */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* raced with a concurrent write; the count still records it */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

function main() {
  console.log(`\n[STORAGE-BACKUP] ${mode}`);
  console.log(`  source ${source}`);
  console.log(`  dest   ${destRoot}\n`);

  if (!fs.existsSync(source)) {
    console.error(
      `[FAILED] Source does not exist.\n` +
        `  Either STORAGE_LOCAL_PATH is wrong, or the app is running with a different cwd than this\n` +
        `  script and is writing documents somewhere else entirely. Do not "fix" this by creating the\n` +
        `  directory — find where the live documents actually are first.\n`,
    );
    process.exit(1);
  }

  const before = measure(source);
  const existing = fs.existsSync(destRoot) ? measure(destRoot) : { files: 0, bytes: 0 };

  console.log(`  source holds ${before.files} files (${gb(before.bytes)} GB)`);
  console.log(`  backup holds ${existing.files} files (${gb(existing.bytes)} GB)\n`);

  // /MIR deletes whatever the source no longer has. If the source has somehow
  // become empty while the backup is populated, that is a mount or a path
  // problem, not a real deletion of every document — and mirroring it would
  // destroy the only remaining copy.
  if (before.files === 0 && existing.files > 0) {
    console.error(
      `[REFUSED] Source is empty but the backup holds ${existing.files} files.\n` +
        `  /MIR would delete all of them to match. This is what an unmounted drive or a wrong\n` +
        `  STORAGE_LOCAL_PATH looks like. Investigate before running this again.\n`,
    );
    process.exit(1);
  }

  fs.mkdirSync(destRoot, { recursive: true });

  if (process.platform !== 'win32') {
    console.error('[FAILED] This script uses robocopy and is Windows-only, matching the deployment.');
    process.exit(1);
  }

  // /MIR mirror, /R:1 /W:1 so a locked file costs a second rather than 30
  // retries, /NFL /NDL to keep the log to a summary, /NP to drop progress
  // percentages that render as thousands of lines when piped to a file.
  const result = spawnSync(
    'robocopy',
    [source, destRoot, '/MIR', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH'],
    { stdio: 'inherit' },
  );

  // Robocopy's exit code is a bit field, not a status: 0-7 are success
  // (0 = nothing to do, 1 = files copied, 2 = extras removed, 4 = mismatches),
  // 8 and above are real failures. Treating any non-zero as an error is the
  // classic way to make a working backup look broken and get it ignored.
  const code = result.status ?? 16;
  if (code >= 8) {
    console.error(`\n[FAILED] robocopy exit ${code} — at least one file could not be copied.\n`);
    process.exit(1);
  }

  const after = measure(destRoot);
  console.log(`\n  mirrored ${after.files} files (${gb(after.bytes)} GB)`);

  // Verify rather than trust. A mirror that silently skipped locked files still
  // exits 1, and a backup nobody checks is a backup nobody has.
  if (after.files !== before.files) {
    console.error(
      `\n[FAILED] Count mismatch: source ${before.files}, backup ${after.files}.\n` +
        `  Files were locked by the running backend, or the destination is out of space.\n`,
    );
    process.exit(1);
  }

  console.log(`\n[SUCCESS] Document store mirrored and verified.`);
  console.log(
    `  Restore order is database first, then this tree — and the storage snapshot must be at\n` +
      `  least as new as the dump, or the catalogue will reference documents that are not there.\n`,
  );
}

main();
