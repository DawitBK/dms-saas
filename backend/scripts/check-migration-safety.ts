/**
 * Migration safety lint (Documentations/rollout.md §3.3).
 *
 * Scans every migration added since `.safety-baseline` was captured (i.e.
 * everything NOT listed in that file — history is grandfathered, not
 * relitigated) for patterns that break the "old app code must survive the
 * new schema" rule:
 *   - ALTER COLUMN ... SET NOT NULL
 *   - DROP COLUMN / DROP TABLE
 *   - RENAME COLUMN / RENAME TO
 *
 * A migration containing one of these fails the build UNLESS it also
 * contains a `-- SAFE:` comment explaining why (e.g. the column was already
 * backfilled by a prior migration, or it's a brand new table nothing depends
 * on yet). This doesn't replace judgment — it just stops a destructive
 * migration from slipping into a PR unreviewed.
 *
 * Separately (non-fatal, just a warning): flags any new migration that has
 * no matching `.down.sql` companion, since scripts/migrate.ts can only
 * actually roll back migrations that ship one.
 *
 * Run: npx tsx scripts/check-migration-safety.ts
 */
import fs from "node:fs/promises";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");
const BASELINE_FILE = path.join(MIGRATIONS_DIR, ".safety-baseline");

const RISKY_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "ALTER COLUMN ... SET NOT NULL", pattern: /ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i },
  { label: "DROP COLUMN", pattern: /DROP\s+COLUMN/i },
  { label: "DROP TABLE", pattern: /DROP\s+TABLE/i },
  { label: "RENAME COLUMN", pattern: /RENAME\s+COLUMN/i },
  { label: "RENAME TO (table rename)", pattern: /RENAME\s+TO\s+\S+/i },
];

const SAFE_COMMENT = /--\s*SAFE:/i;

async function loadBaseline(): Promise<Set<string>> {
  const raw = await fs.readFile(BASELINE_FILE, "utf8").catch(() => "");
  return new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

async function main() {
  const baseline = await loadBaseline();
  const allFiles = await fs.readdir(MIGRATIONS_DIR);
  const migrationFiles = allFiles
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
  const newFiles = migrationFiles.filter((f) => !baseline.has(f));

  if (newFiles.length === 0) {
    console.log("[migration-safety] No migrations added since the baseline — nothing to check.");
    return;
  }

  console.log(`[migration-safety] Checking ${newFiles.length} migration(s) added since baseline:`);

  let failed = false;
  const warnings: string[] = [];

  for (const file of newFiles) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = await fs.readFile(filePath, "utf8");
    const isSafe = SAFE_COMMENT.test(sql);

    const hits = RISKY_PATTERNS.filter(({ pattern }) => pattern.test(sql));
    if (hits.length > 0 && !isSafe) {
      failed = true;
      console.error(`\n  FAIL  ${file}`);
      for (const hit of hits) {
        console.error(`        contains: ${hit.label}`);
      }
      console.error(
        `        This looks like a "contract" step (Documentations/rollout.md §3) — old app code might not survive it.\n` +
          `        If you're sure it's safe (e.g. already backfilled, brand new table nobody depends on\n` +
          `        yet), add a comment explaining why, starting with "-- SAFE:", anywhere in the file.`,
      );
    } else if (hits.length > 0 && isSafe) {
      console.log(`  ok    ${file} (risky pattern present, justified with -- SAFE:)`);
    } else {
      console.log(`  ok    ${file}`);
    }

    const downPath = filePath.replace(/\.sql$/, ".down.sql");
    const hasDown = await fs
      .access(downPath)
      .then(() => true)
      .catch(() => false);
    if (!hasDown) {
      warnings.push(file);
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `\n[migration-safety] WARNING: ${warnings.length} new migration(s) have no matching .down.sql, ` +
        `so \`migrate down\` can't actually roll them back:`,
    );
    for (const file of warnings) console.warn(`  - ${file}`);
    console.warn("  (Not a hard failure — some migrations genuinely can't be undone. Just make sure that's a deliberate choice.)");
  }

  if (failed) {
    console.error("\n[migration-safety] FAILED — see above.");
    process.exit(1);
  }

  console.log("\n[migration-safety] All new migrations passed.");
}

main().catch((err) => {
  console.error("[migration-safety] Unexpected error:", err);
  process.exit(1);
});
