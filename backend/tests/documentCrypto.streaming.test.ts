// Perf audit 2026-08-13: correctness tests for the new streaming
// encrypt/decrypt path (encryptStreamAndStore/fetchDecryptStream) added
// alongside the existing buffer-based encryptAndStore/fetchAndDecrypt.
// These exercise REAL crypto (dev-backend VaultService, no mocking of key
// material) and REAL local-disk storage — only DocumentDek.findOne is
// stubbed, since a real row requires a full Document/DocumentVersion FK
// chain that isn't the point of this test. A bug here means either data
// corruption or a broken tamper-detection guarantee, so this checks the
// actual bytes on disk, not just that the functions don't throw.
import { describe, it, expect, afterEach } from "@jest/globals";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  encryptAndStore,
  fetchAndDecrypt,
  encryptStreamAndStore,
  fetchDecryptStream,
} from "../src/modules/documents/documentCrypto.js";
import { DocumentDek } from "../src/infrastructure/database/index.js";
import { getStorageAdapter } from "../src/infrastructure/storage/StorageAdapter.js";

const TEST_TENANT = "test-tenant-streaming-crypto";

function chunkedReadableFrom(buffer: Buffer, chunkSize: number): Readable {
  async function* generate() {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
    }
  }
  return Readable.from(generate());
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function mockDek(overrides: { encryptedDek: string; kekId: string; formatVersion: number }) {
  return jest.spyOn(DocumentDek, "findOne").mockResolvedValue(overrides as any);
}

// storage/dms-documents/{key}.enc, matching LocalStorageAdapter's own layout.
function localFilePath(key: string): string {
  return path.resolve(process.cwd(), "storage", "dms-documents", `${key}.enc`);
}

describe("documentCrypto streaming path", () => {
  const createdKeys: string[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    const storage = getStorageAdapter();
    while (createdKeys.length) {
      const key = createdKeys.pop()!;
      await storage.delete(key + ".enc").catch(() => {});
    }
  });

  it("round-trips a multi-chunk plaintext through encryptStreamAndStore -> fetchDecryptStream", async () => {
    const plaintext = crypto.randomBytes(2 * 1024 * 1024 + 137); // deliberately not a round chunk multiple
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptStreamAndStore(
      key,
      () => chunkedReadableFrom(plaintext, 64 * 1024),
      "application/octet-stream",
      TEST_TENANT,
    );
    expect(result.formatVersion).toBe(2);

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 2 });
    const versionId = crypto.randomUUID();
    const decryptedStream = await fetchDecryptStream(key, versionId);
    const decrypted = await collectStream(decryptedStream);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("handles a plaintext smaller than the trailing 16-byte tag window", async () => {
    const plaintext = Buffer.from("tiny");
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptStreamAndStore(
      key,
      () => chunkedReadableFrom(plaintext, 64 * 1024),
      "text/plain",
      TEST_TENANT,
    );

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 2 });
    const decrypted = await collectStream(await fetchDecryptStream(key, crypto.randomUUID()));

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("fetchDecryptStream reads a document written by the legacy buffer-based encryptAndStore (formatVersion 1)", async () => {
    const plaintext = crypto.randomBytes(500_000);
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptAndStore(key, plaintext, "application/octet-stream", "dept-id", TEST_TENANT);

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 1 });
    const decrypted = await collectStream(await fetchDecryptStream(key, crypto.randomUUID()));

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("encryptStreamAndStore output remains readable by the legacy fetchAndDecrypt logic's byte layout expectations only when read via fetchDecryptStream (format 2 is NOT HEAD-compatible)", async () => {
    // Documents the format split explicitly: format-2 bytes are IV||ciphertext||tag,
    // so blindly reading them with the OLD fixed HEAD-tag offsets (fetchAndDecrypt)
    // would slice the wrong bytes as the tag and fail closed rather than
    // silently misdecrypting — verifying that failure mode, not a success case.
    const plaintext = crypto.randomBytes(10_000);
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptStreamAndStore(
      key,
      () => chunkedReadableFrom(plaintext, 4096),
      "application/octet-stream",
      TEST_TENANT,
    );

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 2 });
    await expect(fetchAndDecrypt(key, crypto.randomUUID())).rejects.toThrow();
  });

  it("detects tampering (flipped ciphertext byte) in the streaming (format 2) layout", async () => {
    const plaintext = crypto.randomBytes(300_000);
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptStreamAndStore(
      key,
      () => chunkedReadableFrom(plaintext, 32 * 1024),
      "application/octet-stream",
      TEST_TENANT,
    );

    const filePath = localFilePath(key);
    const bytes = await fs.readFile(filePath);
    // Flip a bit well inside the ciphertext (after the 12-byte IV, safely
    // before the final 16-byte tag).
    bytes[5000] ^= 0xff;
    await fs.writeFile(filePath, bytes);

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 2 });
    const stream = await fetchDecryptStream(key, crypto.randomUUID());
    await expect(collectStream(stream)).rejects.toThrow();
  });

  it("detects tampering (flipped ciphertext byte) in the legacy (format 1) layout", async () => {
    const plaintext = crypto.randomBytes(300_000);
    const key = `__test__/streaming-crypto/${crypto.randomUUID()}`;
    createdKeys.push(key);

    const result = await encryptAndStore(key, plaintext, "application/octet-stream", "dept-id", TEST_TENANT);

    const filePath = localFilePath(key);
    const bytes = await fs.readFile(filePath);
    // Byte 40 is inside the ciphertext region (IV[0:12] || tag[12:28] || ciphertext[28:]).
    bytes[40] ^= 0xff;
    await fs.writeFile(filePath, bytes);

    mockDek({ encryptedDek: result.encryptedKey, kekId: result.kekId, formatVersion: 1 });
    const stream = await fetchDecryptStream(key, crypto.randomUUID());
    await expect(collectStream(stream)).rejects.toThrow();
  });
});
