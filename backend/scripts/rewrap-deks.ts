#!/usr/bin/env tsx
// KEK rotation: re-wrap document_deks rows still wrapped under an old KEK
// version onto the CURRENT DEV_VAULT_MASTER_KEY_CURRENT_VERSION.
//
// Security audit finding #19 (single static encryption key for every
// document/tenant, no rotation path): DevVaultService now supports numbered
// master-key versions (DEV_VAULT_MASTER_KEY_V{n}). Rotating
// DEV_VAULT_MASTER_KEY_CURRENT_VERSION to a new version makes all *newly*
// generated DEKs use the new key immediately, but existing `document_deks`
// rows stay wrapped under whatever version they were created under until
// they're individually rewrapped — that's what this script does.
//
// Idempotent/resumable: each batch is selected by `kekId NOT LIKE
// 'dev:v{current}:%'`, so rows already on the current version are skipped,
// and a rewrapped row naturally drops out of the next batch's query — an
// interrupted run loses no progress and is safe to re-run.
//
// Usage:
//   npx tsx scripts/rewrap-deks.ts                       (dry run — report only)
//   npx tsx scripts/rewrap-deks.ts --execute              (rewrap all pending rows for real)
//   npx tsx scripts/rewrap-deks.ts --execute --only-id=<document_deks.id>
//                                                          (rewrap a single row — targeted
//                                                           repair, or safe verification
//                                                           against one throwaway row)

import { Op } from "sequelize";
import { sequelize, DocumentDek, initModels } from "../src/infrastructure/database/index.js";
import { getVaultService, EnvKeyVaultService } from "../src/infrastructure/vault/VaultService.js";
import { parseDevKekId, buildDevKekId } from "../src/infrastructure/vault/VaultService.js";
import { resolveVaultBackend } from "../src/config/env.js";
import { config } from "../src/config/env.js";
import { logger } from "../src/core/logger.js";

const BATCH_SIZE = 50;

// Which backend the rows should end up on. dev/env rewrap onto
// "{backend}:v{current}:" kekIds; hashicorp rewraps onto "hcv:{keyName}"
// Transit kekIds (version lives inside the Transit ciphertext, not the kekId).
const targetBackend = resolveVaultBackend();
if (!targetBackend) {
  console.error("No vault backend configured (set VAULT_BACKEND or DEV_VAULT_MOCK=true) — nothing to rewrap onto.");
  process.exit(1);
}

/** Prefix a current-version kekId always has, e.g. "env:v2:" — or "hcv:" for Transit. */
function currentVersionPrefix(currentVersion: number): string {
  if (targetBackend === "hashicorp") return "hcv:";
  return `${targetBackend}:v${currentVersion}:`;
}

/** SQL LIKE pattern matching any kekId already on the current version/backend. */
function currentVersionLikePattern(currentVersion: number): string {
  return `${currentVersionPrefix(currentVersion)}%`;
}

/** Compute the kekId a row should move to, preserving its master/dept scope. */
function nextKekId(oldKekId: string, currentVersion: number): string {
  if (oldKekId.startsWith("hcv:")) {
    // Already a Transit kekId: rewrap in place (Transit's /rewrap moves the
    // ciphertext to the key's latest version without changing the kekId).
    return oldKekId;
  }
  const parsed = parseDevKekId(oldKekId);
  if (targetBackend === "hashicorp") {
    const prefix = config.VAULT_TRANSIT_KEY_PREFIX;
    return parsed.scope === "master"
      ? `hcv:${prefix}-master`
      : `hcv:${prefix}-dept-${parsed.tenantId}-${parsed.departmentId}`;
  }
  const kekIdPrefix = targetBackend === "env" ? "env" : "dev";
  if (parsed.scope === "master") {
    return buildDevKekId(currentVersion, { type: "master" }, kekIdPrefix);
  }
  return buildDevKekId(
    currentVersion,
    { type: "dept", tenantId: parsed.tenantId, departmentId: parsed.departmentId },
    kekIdPrefix,
  );
}

/**
 * Rewrap one row's DEK. Same-backend moves use the vault's native rewrap.
 * The env→hashicorp migration is the special case: Transit can't unwrap a
 * dev:/env: ciphertext, so the env-key backend unwraps (its master keys must
 * still be configured during the migration window) and Transit wraps.
 */
async function rewrapRow(
  vault: ReturnType<typeof getVaultService>,
  encryptedDek: string,
  oldKekId: string,
  newKekId: string,
): Promise<string> {
  if (targetBackend === "hashicorp" && !oldKekId.startsWith("hcv:")) {
    const envVault = new EnvKeyVaultService("env");
    const plaintextDek = await envVault.unwrapDEK(encryptedDek, oldKekId);
    try {
      return await vault.wrapDEK(plaintextDek, newKekId);
    } finally {
      plaintextDek.fill(0);
    }
  }
  return vault.rewrapDEK(encryptedDek, oldKekId, newKekId);
}

function pendingWhere(currentVersion: number, onlyId?: string) {
  const kekCondition = { kekId: { [Op.notLike]: currentVersionLikePattern(currentVersion) } };
  return onlyId ? { ...kekCondition, id: onlyId } : kekCondition;
}

async function countPending(currentVersion: number, onlyId?: string): Promise<number> {
  return DocumentDek.count({ where: pendingWhere(currentVersion, onlyId) });
}

async function rewrapBatch(
  currentVersion: number,
  onlyId?: string,
): Promise<{ processed: number; failed: number }> {
  const vault = getVaultService();
  let processed = 0;
  let failed = 0;

  await sequelize.transaction(async (t) => {
    const rows = await DocumentDek.findAll({
      where: pendingWhere(currentVersion, onlyId),
      order: [["createdAt", "ASC"]],
      limit: BATCH_SIZE,
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    for (const row of rows) {
      try {
        const oldKekId = row.kekId;
        const newKekId = nextKekId(oldKekId, currentVersion);
        const newEncryptedDek = await rewrapRow(vault, row.encryptedDek, oldKekId, newKekId);
        await row.update({ encryptedDek: newEncryptedDek, kekId: newKekId }, { transaction: t });
        processed++;
      } catch (error) {
        failed++;
        logger.error(
          { dekId: row.id, documentId: row.documentId, versionId: row.versionId, kekId: row.kekId, error },
          "Failed to rewrap document_deks row",
        );
        console.log(`  x Failed DEK ${row.id} (kekId=${row.kekId}): ${error instanceof Error ? error.message : String(error)}`);
        // Re-throw so this row's failure doesn't get silently committed
        // alongside successfully-rewrapped rows in the same batch — abort
        // the whole batch's transaction and let the next run retry it.
        throw error;
      }
    }
  });

  return { processed, failed };
}

async function rewrapDeks(execute: boolean, onlyId?: string): Promise<void> {
  const currentVersion = config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION;
  console.log("\n=== DEK KEK-Version Rewrap ===\n");
  console.log(`Mode: ${execute ? "LIVE (will rewrap + update database)" : "DRY RUN (report only)"}`);
  console.log(`Current KEK version: ${currentVersion} (target prefix "${currentVersionPrefix(currentVersion)}")`);
  if (onlyId) console.log(`Scope: single row id=${onlyId}`);
  console.log("");

  const totalPending = await countPending(currentVersion, onlyId);
  console.log(`Found ${totalPending} document_deks rows not yet on version ${currentVersion}\n`);

  if (totalPending === 0) {
    console.log("✓ All targeted document_deks rows are already on the current KEK version");
    return;
  }

  if (!execute) {
    console.log("To perform the rewrap, run with --execute flag:");
    console.log("  npm run rewrap-deks -- --execute");
    return;
  }

  let totalProcessed = 0;
  let totalFailed = 0;
  let remaining = totalPending;

  while (remaining > 0) {
    const { processed, failed } = await rewrapBatch(currentVersion, onlyId);
    if (processed === 0 && failed === 0) break; // nothing left matched the query
    totalProcessed += processed;
    totalFailed += failed;
    if (failed > 0) {
      // A failing row aborts its whole batch (see rewrapBatch) — stop here
      // rather than looping forever against the same stuck row.
      break;
    }
    remaining = await countPending(currentVersion, onlyId);
    console.log(`  ✓ Rewrapped ${totalProcessed}/${totalPending} so far (${remaining} remaining)...`);
  }

  console.log("\n=== Rewrap Complete ===");
  console.log(`Total rewrapped: ${totalProcessed}`);
  console.log(`Failed: ${totalFailed}`);

  if (totalFailed > 0) {
    console.log("\n⚠ Some rows failed to rewrap. Check logs, fix the underlying issue, then re-run — already-rewrapped rows are skipped automatically.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const onlyIdArg = args.find((a) => a.startsWith("--only-id="));
  const onlyId = onlyIdArg ? onlyIdArg.slice("--only-id=".length) : undefined;

  try {
    await sequelize.authenticate();
    // initModels() is normally called once at server/worker boot. Standalone
    // scripts run outside that lifecycle, so call it here too (same pattern
    // as scripts/sweep-orphaned-storage.ts).
    initModels();
    logger.info("Database connection established");

    await rewrapDeks(execute, onlyId);

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Rewrap failed");
    await sequelize.close();
    process.exit(1);
  }
}

main();
