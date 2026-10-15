import { DocumentDek } from "../database/index.js";
import { getVaultService } from "./VaultService.js";
import { logger } from "../../core/logger.js";
import { config } from "../../config/env.js";

/**
 * Prove at boot that the configured KEK can still unwrap an existing DEK.
 *
 * THE FAILURE THIS CATCHES
 *
 * Every document is encrypted with its own DEK, and each DEK is stored wrapped
 * by the KEK — `VAULT_MASTER_KEY` in the env file, or Vault Transit. Nothing
 * else in the system reads that key at start-up. So a wrong, truncated, or
 * absent KEK produces a backend that boots cleanly, serves every page, lists
 * every document, and fails only at the moment somebody tries to open one.
 *
 * The realistic ways to get there are all mundane: restoring a database onto a
 * server whose env file was rebuilt from `.env.example`, copying
 * `.env.production` between machines and losing a character, a half-finished
 * KEK rotation, or pointing at the wrong Vault mount. In each case the
 * documents are intact and unreadable, and the first person to find out is a
 * user clicking Download — possibly weeks later, by which time the backup that
 * still had the right key has rotated out.
 *
 * This is one indexed row read and one unwrap. It turns "unreadable corpus"
 * from a silent state into a line in the start-up log.
 *
 * DELIBERATELY LOGS RATHER THAN THROWS, including in production. Refusing to
 * boot would take down document *metadata*, search, approvals, letters and
 * every workflow over a key problem that may affect one legacy KEK version —
 * trading a partial outage for a total one. The whole point is that an
 * operator learns about it at start-up instead of from a user.
 */
export async function reportKekReadiness(): Promise<void> {
  try {
    // The OLDEST row, not the newest. A rotation re-wraps forward, so the
    // earliest DEK is the one most likely to be stranded on a retired KEK
    // version — testing the newest would pass on exactly the deployment where
    // half the corpus has become unreadable.
    const dek = await DocumentDek.findOne({
      order: [["createdAt", "ASC"]],
      attributes: ["id", "versionId", "encryptedDek", "kekId"],
    });

    if (!dek) {
      logger.info("[vault] no wrapped DEKs stored yet — KEK self-test skipped (nothing to decrypt)");
      return;
    }

    await getVaultService().unwrapDEK(dek.encryptedDek, dek.kekId);
    logger.info(
      { kekId: dek.kekId, backend: config.VAULT_BACKEND },
      "[vault] KEK self-test passed — stored documents can be decrypted with the configured key",
    );
  } catch (error) {
    logger.error(
      { error, backend: config.VAULT_BACKEND },
      "[vault] KEK SELF-TEST FAILED — the configured key cannot unwrap an existing document key. " +
        "Every stored document is currently UNREADABLE, though the app will otherwise run normally. " +
        "Check VAULT_MASTER_KEY / VAULT_MASTER_KEY_V<n> against the value this data was encrypted with " +
        "before letting anyone upload more; scripts/dr-decrypt-version.ts is the recovery path and " +
        "scripts/rewrap-deks.ts handles a rotation that did not finish.",
    );
  }
}
