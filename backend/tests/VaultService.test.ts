// KEK-versioning / rotation tests for DevVaultService (security audit finding
// #19: "one static encryption key for every document in every tenant, with no
// rotation path"). Covers: kekId now embeds a version, unwrapDEK can still
// find the correct historical master key after the "current version" moves
// on, generateDEK always uses the current version, legacy (pre-versioning)
// kekId formats keep decrypting, and the rewrapDEK primitive that the
// rotation script (scripts/rewrap-deks.ts) relies on.

const mockFanOut = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/notifications/notifications.service.js", () => ({
  fanOut: (...args: unknown[]) => mockFanOut(...args),
}));

const mockWriteAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock("../src/modules/audit/audit.service.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

const mockConfig: {
  DEV_VAULT_MOCK: boolean;
  DEV_VAULT_MASTER_KEY_CURRENT_VERSION: number;
  DEV_VAULT_MASTER_KEYS: Record<number, string>;
  VAULT_BACKEND?: "dev" | "env" | "hashicorp";
  VAULT_ADDR?: string;
  VAULT_TOKEN?: string;
  VAULT_NAMESPACE?: string;
  VAULT_TRANSIT_MOUNT: string;
  VAULT_TRANSIT_KEY_PREFIX: string;
} = {
  DEV_VAULT_MOCK: true,
  DEV_VAULT_MASTER_KEY_CURRENT_VERSION: 1,
  DEV_VAULT_MASTER_KEYS: {
    1: "test-master-key-v1-not-a-real-secret!!",
    2: "test-master-key-v2-not-a-real-secret!!",
  },
  VAULT_BACKEND: undefined,
  VAULT_ADDR: undefined,
  VAULT_TOKEN: undefined,
  VAULT_NAMESPACE: undefined,
  VAULT_TRANSIT_MOUNT: "transit",
  VAULT_TRANSIT_KEY_PREFIX: "dms",
};

jest.mock("../src/config/env.js", () => ({
  config: mockConfig,
  resolveVaultBackend: () => mockConfig.VAULT_BACKEND ?? (mockConfig.DEV_VAULT_MOCK ? "dev" : undefined),
}));

import {
  DevVaultService,
  EnvKeyVaultService,
  buildDevKekId,
  parseDevKekId,
  getVaultService,
  resetVaultService,
} from "../src/infrastructure/vault/VaultService.js";
import { HashiCorpVaultService } from "../src/infrastructure/vault/HashiCorpVaultService.js";
import { AppError } from "../src/core/AppError.js";

describe("VaultService — KEK versioning & rotation", () => {
  beforeEach(() => {
    mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;
    mockFanOut.mockClear();
    mockWriteAuditLog.mockClear();
  });

  describe("kekId format", () => {
    it("builds a version-embedded master kekId", () => {
      expect(buildDevKekId(1, { type: "master" })).toBe("dev:v1:master");
      expect(buildDevKekId(2, { type: "master" })).toBe("dev:v2:master");
    });

    it("builds a version-embedded dept kekId", () => {
      expect(buildDevKekId(3, { type: "dept", tenantId: "tenant-a", departmentId: "dept-b" })).toBe(
        "dev:v3:tenant-a:dept-b",
      );
    });

    it("parses current-format kekIds back to version + scope", () => {
      expect(parseDevKekId("dev:v2:master")).toEqual({ version: 2, scope: "master" });
      expect(parseDevKekId("dev:v5:tenant-a:dept-b")).toEqual({
        version: 5,
        scope: "dept",
        tenantId: "tenant-a",
        departmentId: "dept-b",
      });
    });

    it("parses legacy pre-versioning kekIds as implicit version 1", () => {
      expect(parseDevKekId("dev-master-kek")).toEqual({ version: 1, scope: "master" });
      expect(parseDevKekId("dev:tenant-a:dept-b")).toEqual({
        version: 1,
        scope: "dept",
        tenantId: "tenant-a",
        departmentId: "dept-b",
      });
    });

    it("throws on an unrecognized kekId", () => {
      expect(() => parseDevKekId("garbage")).toThrow(AppError);
    });
  });

  describe("generateDEK", () => {
    it("wraps under the current version's master kekId", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;

      const result = await vault.generateDEK("tenant-1");
      expect(result.kekId).toBe("dev:v1:master");
      expect(result.plaintextDek).toHaveLength(32);
    });

    it("wraps newly generated DEKs under v2 after current version is switched", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;

      const result = await vault.generateDEK("tenant-1");
      expect(result.kekId).toBe("dev:v2:master");
    });
  });

  describe("backward-compatible decryption across rotation", () => {
    it("still unwraps a v1-wrapped DEK after current version changes to v2", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;

      const { plaintextDek, encryptedDek, kekId } = await vault.generateDEK("tenant-1");
      expect(kekId).toBe("dev:v1:master");

      // Rotate: current version moves to 2, but this DEK's kekId still says v1.
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;

      const unwrapped = await vault.unwrapDEK(encryptedDek, kekId);
      expect(unwrapped.equals(plaintextDek)).toBe(true);
    });

    it("still unwraps legacy fixed-label ('dev-master-kek') DEKs generated before versioning existed", async () => {
      const vault = new DevVaultService();
      const plaintextDek = Buffer.from("0".repeat(64), "hex"); // 32 bytes of zeros — deterministic fixture

      const wrapped = await vault.wrapDEK(plaintextDek, "dev-master-kek");
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2; // rotate after the fact

      const unwrapped = await vault.unwrapDEK(wrapped, "dev-master-kek");
      expect(unwrapped.equals(plaintextDek)).toBe(true);
    });

    it("still unwraps legacy unversioned dept-format ('dev:{tenant}:{dept}') DEKs", async () => {
      const vault = new DevVaultService();
      const plaintextDek = Buffer.from("1".repeat(64), "hex");
      const legacyKekId = "dev:tenant-a:dept-b";

      const wrapped = await vault.wrapDEK(plaintextDek, legacyKekId);
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;

      const unwrapped = await vault.unwrapDEK(wrapped, legacyKekId);
      expect(unwrapped.equals(plaintextDek)).toBe(true);
    });

    it("throws a clear error when a kekId references a version with no configured master key", async () => {
      const vault = new DevVaultService();
      const plaintextDek = Buffer.from("2".repeat(64), "hex");
      const wrapped = await vault.wrapDEK(plaintextDek, "dev:v1:master");

      await expect(vault.unwrapDEK(wrapped, "dev:v99:master")).rejects.toThrow(AppError);
    });
  });

  describe("getDeptKEK", () => {
    it("returns a version-embedded kekId and the version as a first-class value", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;

      const result = await vault.getDeptKEK("dept-b", "tenant-a");
      expect(result).toEqual({ kekId: "dev:v1:tenant-a:dept-b", version: 1 });
    });

    it("reflects the current version after rotation", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;

      const result = await vault.getDeptKEK("dept-b", "tenant-a");
      expect(result).toEqual({ kekId: "dev:v2:tenant-a:dept-b", version: 2 });
    });
  });

  describe("rewrapDEK (the rotation-script primitive)", () => {
    it("transforms a v1-wrapped DEK into a v2-wrapped one that unwraps to the identical plaintext", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;

      const { plaintextDek, encryptedDek, kekId } = await vault.generateDEK("tenant-1");
      expect(kekId).toBe("dev:v1:master");

      // Simulate rotation: current version is now 2.
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;
      const newKekId = buildDevKekId(2, { type: "master" });

      const rewrapped = await vault.rewrapDEK(encryptedDek, kekId, newKekId);
      expect(rewrapped).not.toBe(encryptedDek); // different ciphertext (different KEK)

      const unwrapped = await vault.unwrapDEK(rewrapped, newKekId);
      expect(unwrapped.equals(plaintextDek)).toBe(true);

      // The old kekId + old ciphertext must be gone from use, but the OLD
      // wrapped value should still separately decrypt under the OLD kekId
      // (proving rewrap didn't mutate/destroy the original — the caller,
      // not rewrapDEK, is responsible for deleting the old row).
      const stillDecryptsOld = await vault.unwrapDEK(encryptedDek, kekId);
      expect(stillDecryptsOld.equals(plaintextDek)).toBe(true);
    });

    it("round-trips correctly for department-scoped kekIds too", async () => {
      const vault = new DevVaultService();
      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;

      const plaintextDek = Buffer.from("3".repeat(64), "hex");
      const oldKekId = buildDevKekId(1, { type: "dept", tenantId: "tenant-a", departmentId: "dept-b" });
      const oldEncrypted = await vault.wrapDEK(plaintextDek, oldKekId);

      mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;
      const newKekId = buildDevKekId(2, { type: "dept", tenantId: "tenant-a", departmentId: "dept-b" });

      const rewrapped = await vault.rewrapDEK(oldEncrypted, oldKekId, newKekId);
      const unwrapped = await vault.unwrapDEK(rewrapped, newKekId);
      expect(unwrapped.equals(plaintextDek)).toBe(true);
    });
  });
});

describe("EnvKeyVaultService — the prod-legal env backend", () => {
  beforeEach(() => {
    mockConfig.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 1;
  });

  it("emits env-prefixed kekIds for new DEKs and dept KEKs", async () => {
    const vault = new EnvKeyVaultService("env");
    const dek = await vault.generateDEK("tenant-1");
    expect(dek.kekId).toBe("env:v1:master");
    const dept = await vault.getDeptKEK("dept-b", "tenant-a");
    expect(dept.kekId).toBe("env:v1:tenant-a:dept-b");
  });

  it("parses env-prefixed kekIds identically to dev-prefixed ones", () => {
    expect(parseDevKekId("env:v2:master")).toEqual({ version: 2, scope: "master" });
    expect(parseDevKekId("env:v3:tenant-a:dept-b")).toEqual({
      version: 3,
      scope: "dept",
      tenantId: "tenant-a",
      departmentId: "dept-b",
    });
  });

  it("unwraps DEKs wrapped by the dev backend (same master-key map), and vice versa", async () => {
    // The dev→env cutover scenario: rows in DocumentDek carry dev: kekIds.
    const devVault = new DevVaultService();
    const envVault = new EnvKeyVaultService("env");

    const { plaintextDek, encryptedDek, kekId } = await devVault.generateDEK("tenant-1");
    expect(kekId).toBe("dev:v1:master");
    const unwrappedByEnv = await envVault.unwrapDEK(encryptedDek, kekId);
    expect(unwrappedByEnv.equals(plaintextDek)).toBe(true);

    const envWrapped = await envVault.generateDEK("tenant-1");
    const unwrappedByDev = await devVault.unwrapDEK(envWrapped.encryptedDek, envWrapped.kekId);
    expect(unwrappedByDev.equals(envWrapped.plaintextDek)).toBe(true);
  });

  it("rewraps a dev:-wrapped DEK onto an env: kekId (the cutover rewrap path)", async () => {
    const envVault = new EnvKeyVaultService("env");
    const plaintextDek = Buffer.from("4".repeat(64), "hex");
    const wrapped = await envVault.wrapDEK(plaintextDek, "dev:v1:master");

    const rewrapped = await envVault.rewrapDEK(wrapped, "dev:v1:master", "env:v2:master");
    const unwrapped = await envVault.unwrapDEK(rewrapped, "env:v2:master");
    expect(unwrapped.equals(plaintextDek)).toBe(true);
  });
});

describe("getVaultService — backend selection", () => {
  afterEach(() => {
    resetVaultService();
    mockConfig.VAULT_BACKEND = undefined;
    mockConfig.DEV_VAULT_MOCK = true;
    mockConfig.VAULT_ADDR = undefined;
    mockConfig.VAULT_TOKEN = undefined;
  });

  it("legacy fallback: DEV_VAULT_MOCK=true with no VAULT_BACKEND yields the dev flavor", async () => {
    resetVaultService();
    const vault = getVaultService();
    const dek = await vault.generateDEK("tenant-1");
    expect(dek.kekId).toBe("dev:v1:master");
  });

  it("VAULT_BACKEND=env yields env-prefixed kekIds", async () => {
    resetVaultService();
    mockConfig.VAULT_BACKEND = "env";
    const vault = getVaultService();
    const dek = await vault.generateDEK("tenant-1");
    expect(dek.kekId).toBe("env:v1:master");
  });

  it("VAULT_BACKEND=hashicorp constructs the Transit-backed service", () => {
    resetVaultService();
    mockConfig.VAULT_BACKEND = "hashicorp";
    mockConfig.VAULT_ADDR = "http://127.0.0.1:8200";
    mockConfig.VAULT_TOKEN = "test-token";
    expect(getVaultService()).toBeInstanceOf(HashiCorpVaultService);
  });

  it("throws ERR-CONFIG-VAULT-NOT-CONFIGURED when nothing selects a backend", () => {
    resetVaultService();
    mockConfig.DEV_VAULT_MOCK = false;
    expect(() => getVaultService()).toThrow(AppError);
  });
});

describe("HashiCorpVaultService — Transit API mapping (mocked HTTP)", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const jsonResponse = (data: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    }) as unknown as Response;

  beforeEach(() => {
    mockConfig.VAULT_ADDR = "http://127.0.0.1:8200";
    mockConfig.VAULT_TOKEN = "test-token";
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mockConfig.VAULT_ADDR = undefined;
    mockConfig.VAULT_TOKEN = undefined;
  });

  it("generateDEK ensures the master key then calls transit/datakey", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, 204)) // keys/dms-master upsert
      .mockResolvedValueOnce(
        jsonResponse({ data: { plaintext: Buffer.alloc(32, 7).toString("base64"), ciphertext: "vault:v1:abc" } })
      );

    const vault = new HashiCorpVaultService();
    const dek = await vault.generateDEK("tenant-1");

    expect(dek.kekId).toBe("hcv:dms-master");
    expect(dek.encryptedDek).toBe("vault:v1:abc");
    expect(dek.plaintextDek.equals(Buffer.alloc(32, 7))).toBe(true);

    const [ensureUrl, ensureInit] = fetchMock.mock.calls[0];
    expect(ensureUrl).toBe("http://127.0.0.1:8200/v1/transit/keys/dms-master");
    expect((ensureInit.headers as Record<string, string>)["X-Vault-Token"]).toBe("test-token");
    const [datakeyUrl] = fetchMock.mock.calls[1];
    expect(datakeyUrl).toBe("http://127.0.0.1:8200/v1/transit/datakey/plaintext/dms-master");
  });

  it("unwrapDEK maps to transit/decrypt and returns the base64-decoded plaintext", async () => {
    const plaintext = Buffer.alloc(32, 9);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { plaintext: plaintext.toString("base64") } }));

    const vault = new HashiCorpVaultService();
    const out = await vault.unwrapDEK("vault:v1:abc", "hcv:dms-master");

    expect(out.equals(plaintext)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8200/v1/transit/decrypt/dms-master");
    expect(JSON.parse(init.body as string)).toEqual({ ciphertext: "vault:v1:abc" });
  });

  it("rewrapDEK on the same key uses transit's native /rewrap (plaintext never leaves Vault)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ciphertext: "vault:v2:def" } }));

    const vault = new HashiCorpVaultService();
    const out = await vault.rewrapDEK("vault:v1:abc", "hcv:dms-master", "hcv:dms-master");

    expect(out).toBe("vault:v2:def");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8200/v1/transit/rewrap/dms-master");
  });

  it("surfaces Vault API errors as AppError and raises the HSM_UNAVAILABLE alert", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: ["permission denied"] }, 403));

    const vault = new HashiCorpVaultService();
    await expect(vault.unwrapDEK("vault:v1:abc", "hcv:dms-master")).rejects.toThrow(AppError);
    expect(mockFanOut).toHaveBeenCalledWith(expect.objectContaining({ type: "HSM_UNAVAILABLE" }));
  });

  it("rejects non-hcv kekIds", async () => {
    const vault = new HashiCorpVaultService();
    await expect(vault.unwrapDEK("vault:v1:abc", "dev:v1:master")).rejects.toThrow(AppError);
  });
});
