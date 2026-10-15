// S4-04: VaultService — key management interface and implementations.
// Backend selection (config VAULT_BACKEND, see resolveVaultBackend):
//   dev       — EnvKeyVaultService emitting dev: kekIds (dev/test only)
//   env       — EnvKeyVaultService emitting env: kekIds; prod-legal, master
//               keys injected via VAULT_MASTER_KEY[_V{n}] secrets
//   hashicorp — HashiCorpVaultService (Transit engine, see its module)

import crypto from "node:crypto";
import { AppError } from "../../core/AppError.js";
import { config, resolveVaultBackend } from "../../config/env.js";
import { fanOut } from "../../modules/notifications/notifications.service.js";
import { writeAuditLog } from "../../modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../../modules/audit/auditEvents.js";
import { createHashiCorpVaultService } from "./HashiCorpVaultService.js";

// ── Interface ──────────────────────────────────────────────────────────────

export interface VaultService {
  /**
   * Generate a fresh data-encryption key (DEK) and return both the plaintext
   * (for immediate use) and the wrapped form (for storage in DocumentDek).
   * tenantId is used for audit/notification scoping on failure. Always wraps
   * under the CURRENT KEK version.
   */
  generateDEK(tenantId?: string): Promise<{ plaintextDek: Buffer; encryptedDek: string; kekId: string }>;

  /**
   * Wrap (encrypt) a plaintext DEK with the KEK identified by kekId.
   * Returns base64-encoded wrapped key.
   */
  wrapDEK(plaintextDek: Buffer, kekId: string): Promise<string>;

  /**
   * Unwrap (decrypt) an encrypted DEK using the KEK identified by kekId.
   * kekId embeds the KEK version it was wrapped under, so historical
   * (pre-rotation) DEKs remain decryptable after the current version moves
   * on. Returns plaintext DEK buffer.
   */
  unwrapDEK(encryptedDek: string, kekId: string): Promise<Buffer>;

  /**
   * Re-wrap an already-wrapped DEK under a different kekId (typically moving
   * it from an old KEK version to the current one) without the caller ever
   * touching the plaintext DEK directly. On a real Vault this maps to the
   * transit backend's native `rewrap` operation; the dev mock unwraps then
   * re-wraps in-process. Used by the KEK-rotation script.
   */
  rewrapDEK(encryptedDek: string, fromKekId: string, toKekId: string): Promise<string>;

  /**
   * Get (or derive) the KEK reference for a department, under the CURRENT
   * KEK version. Returns the kekId to pass to wrapDEK/unwrapDEK, plus that
   * version number as a first-class value for callers that want it without
   * re-parsing the kekId string.
   */
  getDeptKEK(departmentId: string, tenantId: string): Promise<{ kekId: string; version: number }>;
}

// ── Env-key implementation ─────────────────────────────────────────────────
//
// kekId formats (version is always embedded so unwrapDEK can find the exact
// historical master key a given DEK was wrapped under). The prefix records
// which backend label wrapped it — "dev" and "env" are cryptographically
// identical (same derivation, same master-key map), so both parse the same
// and a dev-seeded database keeps decrypting after the cutover to env:
//   "dev:v{n}:master" / "env:v{n}:master"    — tenant/department-agnostic master KEK
//   "dev:v{n}:{tenantId}:{departmentId}" (or env:) — per-department KEK
//
// Legacy formats (pre-dating the version dimension) are still accepted by
// getKekById/parseDevKekId so DEKs generated before this change keep
// decrypting without a migration; they are treated as version 1:
//   "dev-master-kek"                   — legacy fixed master label
//   "dev:{tenantId}:{departmentId}"    — legacy unversioned dept format

const LEGACY_DEV_MASTER_KEY_LABEL = "dev-master-kek";
const AES_KW_ALGORITHM = "id-aes256-wrap"; // AES-256 Key Wrap (RFC 3394 via Node.js)

export type EnvKekIdPrefix = "dev" | "env";

export type ParsedDevKekId =
  | { version: number; scope: "master" }
  | { version: number; scope: "dept"; tenantId: string; departmentId: string };

/** Build a kekId string for a given version + scope (current-format only). */
export function buildDevKekId(
  version: number,
  scope: { type: "master" } | { type: "dept"; tenantId: string; departmentId: string },
  prefix: EnvKekIdPrefix = "dev",
): string {
  if (scope.type === "master") return `${prefix}:v${version}:master`;
  return `${prefix}:v${version}:${scope.tenantId}:${scope.departmentId}`;
}

/** Parse any kekId (current-format or legacy) into its version + scope. */
export function parseDevKekId(kekId: string): ParsedDevKekId {
  if (kekId === LEGACY_DEV_MASTER_KEY_LABEL) {
    // Pre-versioning fixed label: implicitly version 1.
    return { version: 1, scope: "master" };
  }

  const parts = kekId.split(":");
  if (parts[0] === "dev" || parts[0] === "env") {
    const versionMatch = /^v(\d+)$/.exec(parts[1] ?? "");
    if (versionMatch) {
      const version = Number(versionMatch[1]);
      if (parts.length === 3 && parts[2] === "master") {
        return { version, scope: "master" };
      }
      if (parts.length === 4 && parts[2] && parts[3]) {
        return { version, scope: "dept", tenantId: parts[2], departmentId: parts[3] };
      }
    } else if (parts.length === 3 && parts[1] && parts[2]) {
      // Legacy unversioned dept format: "dev:{tenantId}:{departmentId}".
      return { version: 1, scope: "dept", tenantId: parts[1], departmentId: parts[2] };
    }
  }

  throw new AppError(500, "ERR-VAULT-KEK-NOT-FOUND", `Unrecognized kekId format: ${kekId}`);
}

/** Extract tenantId from a kekId when possible, for audit/notification scoping. */
function tenantFromKekId(kekId: string): string {
  try {
    const parsed = parseDevKekId(kekId);
    return parsed.scope === "dept" ? parsed.tenantId : "unknown";
  } catch {
    return "unknown";
  }
}

function deriveMasterKeyForVersion(version: number): Buffer {
  const raw = config.DEV_VAULT_MASTER_KEYS[version];
  if (!raw) {
    throw new AppError(
      500,
      "ERR-VAULT-KEK-NOT-FOUND",
      `No master key configured for KEK version ${version} (set DEV_VAULT_MASTER_KEY_V${version})`,
    );
  }
  // Pad/trim to exactly 32 bytes using SHA-256
  return crypto.createHash("sha256").update(raw).digest();
}

function deriveKEK(departmentId: string, tenantId: string, version: number): Buffer {
  // Deterministic KEK derivation for dev: HMAC-SHA256(master, tenant:dept)
  const master = deriveMasterKeyForVersion(version);
  return crypto.createHmac("sha256", master).update(`${tenantId}:${departmentId}`).digest();
}

function getKekById(kekId: string): Buffer {
  const parsed = parseDevKekId(kekId);
  if (parsed.scope === "master") {
    return deriveMasterKeyForVersion(parsed.version);
  }
  return deriveKEK(parsed.departmentId, parsed.tenantId, parsed.version);
}

/** The KEK version new DEKs and dept KEKs should be wrapped under right now. */
function currentKekVersion(): number {
  return config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION;
}

function aes256kwWrap(plaintext: Buffer, kek: Buffer): Buffer {
  // Node.js supports AES key wrap via createCipheriv with 'id-aes256-wrap'
  // The IV for AES-KW is the RFC 3394 default IV: 0xA6A6A6A6A6A6A6A6
  const defaultIV = Buffer.from("A6A6A6A6A6A6A6A6", "hex");
  const cipher = crypto.createCipheriv(AES_KW_ALGORITHM, kek, defaultIV);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aes256kwUnwrap(wrapped: Buffer, kek: Buffer): Buffer {
  const defaultIV = Buffer.from("A6A6A6A6A6A6A6A6", "hex");
  const decipher = crypto.createDecipheriv(AES_KW_ALGORITHM, kek, defaultIV);
  return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}

/**
 * Best-effort "tell someone the vault is broken" for the three catch blocks
 * below. Must never itself throw: it runs from inside a catch that is about
 * to re-throw the REAL error, and both fanOut and writeAuditLog run their own
 * DB queries. Found 2026-09-14: a real unwrapDEK failure (wrong/rotated
 * VAULT_MASTER_KEY) triggered fanOut's "broadcast to all admins" fallback,
 * which failed notifications' RLS check for any admin with no tenant
 * membership — fanOut now swallows that itself, but the failed INSERT had
 * already poisoned the surrounding Postgres transaction, so the very next
 * query (writeAuditLog's advisory lock) failed too with "current transaction
 * is aborted", masking the original vault error behind an unrelated one.
 * Catching here, around BOTH calls together, is what actually guarantees the
 * caller's `throw error` (the one that matters) is what the client sees.
 */
async function reportKekFailure(
  tenantId: string,
  operation: string,
  error: Error,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await fanOut({
      type: "HSM_UNAVAILABLE",
      tenantId,
      severity: "CRITICAL",
      payload: { error: error.message, operation, ...extra },
    });
    await writeAuditLog({
      eventType: AUDIT_EVENTS.HSM_UNAVAILABLE,
      userId: null,
      userRole: "SYSTEM",
      actionDetails: { error: error.message, operation, tenantId, ...extra },
    });
  } catch (reportError) {
    // logger isn't imported here and
    // this path only fires when the alerting/audit path itself is broken.
    console.error("[vault] failed to report KEK failure (swallowed)", reportError);
  }
}

export class EnvKeyVaultService implements VaultService {
  constructor(private readonly kekIdPrefix: EnvKekIdPrefix = "dev") {}

  async generateDEK(tenantId = "unknown"): Promise<{ plaintextDek: Buffer; encryptedDek: string; kekId: string }> {
    try {
      const plaintextDek = crypto.randomBytes(32); // 256-bit AES key
      const kekId = buildDevKekId(currentKekVersion(), { type: "master" }, this.kekIdPrefix);
      const encryptedDek = await this.wrapDEK(plaintextDek, kekId);
      return { plaintextDek, encryptedDek, kekId };
    } catch (error: any) {
      await reportKekFailure(tenantId, "generateDEK", error);
      throw error;
    }
  }

  async wrapDEK(plaintextDek: Buffer, kekId: string): Promise<string> {
    try {
      const kek = getKekById(kekId);
      const wrapped = aes256kwWrap(plaintextDek, kek);
      return wrapped.toString("base64");
    } catch (error: any) {
      const tenantId = tenantFromKekId(kekId);
      await reportKekFailure(tenantId, "wrapDEK", error, { kekId });
      throw error;
    }
  }

  async unwrapDEK(encryptedDek: string, kekId: string): Promise<Buffer> {
    try {
      const kek = getKekById(kekId);
      const wrapped = Buffer.from(encryptedDek, "base64");
      return aes256kwUnwrap(wrapped, kek);
    } catch (error: any) {
      const tenantId = tenantFromKekId(kekId);
      await reportKekFailure(tenantId, "unwrapDEK", error, { kekId });
      throw error;
    }
  }

  async rewrapDEK(encryptedDek: string, fromKekId: string, toKekId: string): Promise<string> {
    const plaintextDek = await this.unwrapDEK(encryptedDek, fromKekId);
    try {
      return await this.wrapDEK(plaintextDek, toKekId);
    } finally {
      plaintextDek.fill(0);
    }
  }

  async getDeptKEK(departmentId: string, tenantId: string): Promise<{ kekId: string; version: number }> {
    // Deterministic kekId under the current version; actual key material is
    // derived on demand in getKekById.
    const version = currentKekVersion();
    return { kekId: buildDevKekId(version, { type: "dept", tenantId, departmentId }, this.kekIdPrefix), version };
  }
}

/** Legacy name — the dev-flavored env-key vault. Kept for tests/scripts. */
export class DevVaultService extends EnvKeyVaultService {
  constructor() {
    super("dev");
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let _vaultService: VaultService | null = null;

export function getVaultService(): VaultService {
  if (_vaultService) return _vaultService;

  switch (resolveVaultBackend()) {
    case "dev":
      _vaultService = new EnvKeyVaultService("dev");
      return _vaultService;
    case "env":
      _vaultService = new EnvKeyVaultService("env");
      return _vaultService;
    case "hashicorp":
      _vaultService = createHashiCorpVaultService();
      return _vaultService;
    default:
      throw new AppError(
        500,
        "ERR-CONFIG-VAULT-NOT-CONFIGURED",
        "Vault service is not configured. Set VAULT_BACKEND=env or VAULT_BACKEND=hashicorp (or DEV_VAULT_MOCK=true for development)."
      );
  }
}

/** Reset the singleton (for testing only) */
export function resetVaultService(): void {
  _vaultService = null;
}
