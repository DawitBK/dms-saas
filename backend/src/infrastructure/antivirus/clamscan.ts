import NodeClam from "clamscan";
import { Readable } from "node:stream";
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { AppError } from "../../core/AppError.js";

let clamscan: NodeClam | null = null;

// Perf: when clamd isn't reachable, init()/scanStream() used to be retried
// from scratch on EVERY upload — the clamscan lib's own connect timeout
// defaults to 60s, so a hung (not just refused) daemon turned every upload
// into a up-to-60s stall. Once a connection attempt actually fails, skip
// straight to "unscanned" for COOLDOWN_MS instead of reattempting on the
// very next request; retry after the cooldown in case the daemon recovers.
const COOLDOWN_MS = 60_000;
// Defense in depth: cap the clamscan lib's own connect timeout well below
// its 60s default, so even a genuinely hung (not refused) daemon fails fast
// the one time per cooldown window we do attempt it.
const CONNECT_TIMEOUT_MS = 3_000;
let lastFailureAt: number | null = null;

async function getClamScan() {
  if (clamscan) return clamscan;
  if (!config.CLAMAV_ENABLED) return null;
  if (lastFailureAt !== null && Date.now() - lastFailureAt < COOLDOWN_MS) return null;

  try {
    const scanner = await new NodeClam().init({
      clamdscan: {
        host: config.CLAMAV_HOST,
        port: config.CLAMAV_PORT,
        timeout: CONNECT_TIMEOUT_MS,
      },
    });
    clamscan = scanner;
    lastFailureAt = null;
    return clamscan;
  } catch (error) {
    logger.error({ error }, "failed to initialize clamav scanner — backing off for " + COOLDOWN_MS + "ms");
    lastFailureAt = Date.now();
    return null;
  }
}

// 'clean': scan ran and found nothing. 'unscanned': the file was never
// actually verified — AV enabled but the scanner didn't initialize, or the
// scan attempt itself errored (timeout, daemon crash, protocol error). A
// genuine detected virus is NOT one of these — it throws AppError below and
// the caller blocks the upload, unchanged. Policy decision: fail open on a
// scan error (let the upload through) but every caller must persist/audit
// "unscanned" rather than silently treating it as "clean" — availability
// over strict blocking for this deployment, with visibility instead of
// silence into how often scans aren't actually completing.
export type ScanResult = "clean" | "unscanned";

/**
 * Boot-time reachability check for the AV daemon.
 *
 * "Enabled but not running" is the worst of the three states and the only one
 * with no symptom: uploads keep working (fail-open, by policy), every version
 * is stamped `unscanned`, every uploader gets a WARNING notification, and
 * nothing anywhere says the daemon was never there. Somebody notices weeks
 * later, in an audit log, if at all.
 *
 * Deliberately LOGS rather than throws, even in production. Refusing to boot
 * over an unreachable virus scanner would trade a documented fail-open policy
 * for a hard outage of the whole document system, which is the wrong direction
 * — the point here is that the operator finds out at start-up instead of in a
 * quarterly review.
 *
 * Resets the cooldown on success so the first real upload does not pay for a
 * connection this already proved works.
 */
export async function reportAntivirusReadiness(): Promise<void> {
  if (!config.CLAMAV_ENABLED) {
    logger.warn(
      "[antivirus] CLAMAV_ENABLED is false — uploads are NOT scanned and are recorded as 'clean'. " +
        "For a document system taking user uploads this should be a deliberate decision, not a default.",
    );
    return;
  }

  const scanner = await getClamScan();
  if (!scanner) {
    logger.error(
      { host: config.CLAMAV_HOST, port: config.CLAMAV_PORT },
      "[antivirus] CLAMAV_ENABLED is true but clamd is UNREACHABLE. Uploads will be allowed through and " +
        "recorded as 'unscanned' (fail-open policy), and every uploader will get a warning notification. " +
        "Start clamd, or set CLAMAV_ENABLED=false and own that decision.",
    );
    // Do not leave the failure window armed on the strength of a boot probe
    // that ran before the daemon had finished starting.
    lastFailureAt = null;
    return;
  }

  logger.info({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }, "[antivirus] clamd reachable — uploads will be scanned");
}

export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
  // AV turned off entirely is a deployment configuration choice, not a
  // failure — unrelated to the fail-open-but-flag policy above, so it's not
  // reported as "unscanned".
  if (!config.CLAMAV_ENABLED) return "clean";

  const scanner = await getClamScan();
  if (!scanner) {
    if (config.CLAMAV_FAIL_CLOSED) {
      logger.error("clamav is enabled but scanner not initialized — refusing the upload (CLAMAV_FAIL_CLOSED)");
      throw new AppError(503, "ERR-AV-UNAVAILABLE", "Virus scanning is unavailable right now, so uploads are paused. Try again shortly.");
    }
    logger.error("clamav is enabled but scanner not initialized — treating upload as unscanned (fail-open, flagged)");
    return "unscanned";
  }

  try {
    const result = await scanner.scanStream(Readable.from(buffer));
    const { isInfected, viruses } = result;
    if (isInfected) {
      logger.warn({ viruses }, "antivirus threat detected");
      throw new AppError(422, "ERR-AV-THREAT-DETECTED", "File contains a security threat");
    }
    return "clean";
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error }, "clamav scan failed — treating upload as unscanned (fail-open, flagged)");
    // The cached client's connection may itself be the failure (daemon died
    // after init succeeded) — drop it and start the cooldown so the next
    // call doesn't immediately reattempt against a connection already known
    // to be bad, same as an init failure above.
    clamscan = null;
    lastFailureAt = Date.now();
    if (config.CLAMAV_FAIL_CLOSED) {
      throw new AppError(503, "ERR-AV-UNAVAILABLE", "Virus scanning is unavailable right now, so uploads are paused. Try again shortly.");
    }
    return "unscanned";
  }
}

/**
 * Operator-facing view of the scanner, for GET /operations/antivirus.
 *
 * WHY THIS EXISTS. Whether uploads are actually being scanned was visible
 * only in the boot log. "Enabled but not running" is the dangerous state and
 * it has no symptom by design: uploads keep succeeding (fail-open policy),
 * each version is quietly stamped `unscanned`, and nothing on any screen
 * says so. reportAntivirusReadiness() says it once, at start-up, into a
 * console window. This makes the same answer available at any moment,
 * including the signature age -- an out-of-date signature database scans
 * every file and catches nothing new, which looks identical to working.
 *
 * `reachable` is reported from the SAME path uploads take, cooldown
 * included. During the 60s back-off after a failure this reports false, and
 * that is correct rather than pessimistic: an upload in that window really
 * would be recorded `unscanned`. `cooldownActive` distinguishes "we backed
 * off" from "we tried just now and it refused".
 */
export type AntivirusStatus = {
  enabled: boolean;
  reachable: boolean;
  host: string;
  port: number;
  cooldownActive: boolean;
  /** Raw clamd VERSION line, e.g. "ClamAV 1.5.4/27891/Mon Sep 09 03:30:00 2026". */
  version: string | null;
  engineVersion: string | null;
  signatureVersion: string | null;
  /** Signature database build date, as clamd reports it. */
  signatureDate: string | null;
  checkedAt: string;
};

export async function getAntivirusStatus(): Promise<AntivirusStatus> {
  const base = {
    enabled: config.CLAMAV_ENABLED,
    host: config.CLAMAV_HOST,
    port: config.CLAMAV_PORT,
    cooldownActive: lastFailureAt !== null && Date.now() - lastFailureAt < COOLDOWN_MS,
    checkedAt: new Date().toISOString(),
  };

  if (!config.CLAMAV_ENABLED) {
    return { ...base, reachable: false, version: null, engineVersion: null, signatureVersion: null, signatureDate: null };
  }

  const scanner = await getClamScan();
  if (!scanner) {
    return { ...base, reachable: false, version: null, engineVersion: null, signatureVersion: null, signatureDate: null };
  }

  let version: string | null = null;
  try {
    // Not in the shipped typings; present since clamscan 2.x (lib/index.js).
    const raw = await (scanner as unknown as { getVersion(): Promise<string> }).getVersion();
    version = typeof raw === "string" ? raw.trim() : null;
  } catch (error) {
    // A live scanner that will not answer VERSION is still a live scanner --
    // report reachable and leave the signature fields null rather than
    // downgrading the whole status over a cosmetic call.
    logger.warn({ error }, "[antivirus] clamd reachable but VERSION query failed");
  }

  // "ClamAV 1.5.4/27891/Mon Sep 09 03:30:00 2026" -> engine / sig db / date
  const parts = version ? version.split("/") : [];
  return {
    ...base,
    reachable: true,
    version,
    engineVersion: parts[0]?.trim() ?? null,
    signatureVersion: parts[1]?.trim() ?? null,
    signatureDate: parts[2]?.trim() ?? null,
  };
}
