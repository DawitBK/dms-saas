// VAULT_BACKEND=hashicorp — DEK wrapping via HashiCorp Vault's Transit
// secrets engine over its HTTP API (no SDK dependency; Node 22 global fetch).
//
// kekId format: "hcv:{transitKeyName}". Unlike the env backend, the KEK
// version is NOT part of the kekId — Transit ciphertext already embeds the
// key version it was encrypted under ("vault:vN:..."), and Vault keeps every
// historical version decryptable (bounded by the key's min_decryption_version).
// KEK rotation is therefore: rotate the Transit key in Vault, then run
// scripts/rewrap-deks.ts, whose rewrap call maps to Transit's native /rewrap.
//
// Required config: VAULT_ADDR, VAULT_TOKEN. Optional: VAULT_NAMESPACE
// (Vault Enterprise), VAULT_TRANSIT_MOUNT (default "transit"),
// VAULT_TRANSIT_KEY_PREFIX (default "edams").

import { AppError } from "../../core/AppError.js";
import { config } from "../../config/env.js";
import { fanOut } from "../../modules/notifications/notifications.service.js";
import { writeAuditLog } from "../../modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../../modules/audit/auditEvents.js";
import type { VaultService } from "./VaultService.js";

const KEK_ID_PREFIX = "hcv:";

function keyNameFromKekId(kekId: string): string {
  if (!kekId.startsWith(KEK_ID_PREFIX) || kekId.length <= KEK_ID_PREFIX.length) {
    throw new AppError(500, "ERR-VAULT-KEK-NOT-FOUND", `Unrecognized HashiCorp kekId format: ${kekId}`);
  }
  return kekId.slice(KEK_ID_PREFIX.length);
}

export class HashiCorpVaultService implements VaultService {
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly keyPrefix: string;
  private readonly namespace?: string;
  /** Transit keys already confirmed to exist this process lifetime. */
  private readonly ensuredKeys = new Set<string>();

  constructor() {
    if (!config.VAULT_ADDR || !config.VAULT_TOKEN) {
      throw new AppError(
        500,
        "ERR-CONFIG-VAULT-NOT-CONFIGURED",
        "VAULT_BACKEND=hashicorp requires VAULT_ADDR and VAULT_TOKEN"
      );
    }
    this.addr = config.VAULT_ADDR.replace(/\/+$/, "");
    this.token = config.VAULT_TOKEN;
    this.mount = config.VAULT_TRANSIT_MOUNT;
    this.keyPrefix = config.VAULT_TRANSIT_KEY_PREFIX;
    this.namespace = config.VAULT_NAMESPACE;
  }

  private get masterKeyName(): string {
    return `${this.keyPrefix}-master`;
  }

  private async request(
    method: "GET" | "POST",
    apiPath: string,
    body?: Record<string, unknown>
  ): Promise<any> {
    const headers: Record<string, string> = { "X-Vault-Token": this.token };
    if (this.namespace) headers["X-Vault-Namespace"] = this.namespace;
    if (body) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.addr}/v1/${apiPath}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error: any) {
      throw new AppError(500, "ERR-VAULT-UNAVAILABLE", `Vault request failed: ${error.message}`);
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const parsed = await res.json();
        if (Array.isArray(parsed?.errors) && parsed.errors.length) detail += ` ${parsed.errors.join("; ")}`;
      } catch {
        /* non-JSON error body */
      }
      throw new AppError(500, "ERR-VAULT-REQUEST-FAILED", `Vault ${method} ${apiPath} failed: ${detail}`);
    }
    // 204 (e.g. key upsert) has no body.
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Create the named Transit key if it doesn't exist. Transit's key-create
   * endpoint is an upsert: POSTing an existing name succeeds without
   * modifying the key, so this is safe to call unconditionally.
   */
  private async ensureKey(keyName: string): Promise<void> {
    if (this.ensuredKeys.has(keyName)) return;
    await this.request("POST", `${this.mount}/keys/${encodeURIComponent(keyName)}`, {
      type: "aes256-gcm96",
    });
    this.ensuredKeys.add(keyName);
  }

  private async alertHsmUnavailable(operation: string, error: any, tenantId: string, kekId?: string) {
    try {
      await fanOut({
        type: "HSM_UNAVAILABLE",
        tenantId,
        severity: "CRITICAL",
        payload: { error: error.message, operation, ...(kekId ? { kekId } : {}) },
      });
      await writeAuditLog({
        eventType: AUDIT_EVENTS.HSM_UNAVAILABLE,
        userId: null,
        userRole: "SYSTEM",
        actionDetails: { error: error.message, operation, tenantId, ...(kekId ? { kekId } : {}) },
      });
    } catch {
      // Alerting is best-effort; the original vault error is what propagates.
    }
  }

  async generateDEK(tenantId = "unknown"): Promise<{ plaintextDek: Buffer; encryptedDek: string; kekId: string }> {
    try {
      await this.ensureKey(this.masterKeyName);
      // Transit mints the DEK server-side and returns both forms in one call.
      const res = await this.request(
        "POST",
        `${this.mount}/datakey/plaintext/${encodeURIComponent(this.masterKeyName)}`,
        { bits: 256 }
      );
      return {
        plaintextDek: Buffer.from(res.data.plaintext, "base64"),
        encryptedDek: res.data.ciphertext,
        kekId: `${KEK_ID_PREFIX}${this.masterKeyName}`,
      };
    } catch (error: any) {
      await this.alertHsmUnavailable("generateDEK", error, tenantId);
      throw error;
    }
  }

  async wrapDEK(plaintextDek: Buffer, kekId: string): Promise<string> {
    const keyName = keyNameFromKekId(kekId);
    try {
      await this.ensureKey(keyName);
      const res = await this.request("POST", `${this.mount}/encrypt/${encodeURIComponent(keyName)}`, {
        plaintext: plaintextDek.toString("base64"),
      });
      return res.data.ciphertext;
    } catch (error: any) {
      await this.alertHsmUnavailable("wrapDEK", error, "unknown", kekId);
      throw error;
    }
  }

  async unwrapDEK(encryptedDek: string, kekId: string): Promise<Buffer> {
    const keyName = keyNameFromKekId(kekId);
    try {
      const res = await this.request("POST", `${this.mount}/decrypt/${encodeURIComponent(keyName)}`, {
        ciphertext: encryptedDek,
      });
      return Buffer.from(res.data.plaintext, "base64");
    } catch (error: any) {
      await this.alertHsmUnavailable("unwrapDEK", error, "unknown", kekId);
      throw error;
    }
  }

  async rewrapDEK(encryptedDek: string, fromKekId: string, toKekId: string): Promise<string> {
    const fromKey = keyNameFromKekId(fromKekId);
    const toKey = keyNameFromKekId(toKekId);
    if (fromKey === toKey) {
      // Same Transit key, newer version: native rewrap never exposes the
      // plaintext DEK outside Vault.
      const res = await this.request("POST", `${this.mount}/rewrap/${encodeURIComponent(toKey)}`, {
        ciphertext: encryptedDek,
      });
      return res.data.ciphertext;
    }
    // Cross-key move: decrypt then encrypt (plaintext transits this process
    // only, mirroring the env backend's rewrap path).
    const plaintextDek = await this.unwrapDEK(encryptedDek, fromKekId);
    try {
      return await this.wrapDEK(plaintextDek, toKekId);
    } finally {
      plaintextDek.fill(0);
    }
  }

  async getDeptKEK(departmentId: string, tenantId: string): Promise<{ kekId: string; version: number }> {
    const keyName = `${this.keyPrefix}-dept-${tenantId}-${departmentId}`;
    await this.ensureKey(keyName);
    const res = await this.request("GET", `${this.mount}/keys/${encodeURIComponent(keyName)}`);
    return { kekId: `${KEK_ID_PREFIX}${keyName}`, version: res.data.latest_version ?? 1 };
  }
}

export function createHashiCorpVaultService(): VaultService {
  return new HashiCorpVaultService();
}
