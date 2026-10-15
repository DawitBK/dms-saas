// S4-20: StorageAdapter parity tests
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { putLocalFile, getLocalFileBuffer, localFileExists, deleteLocalFile } from "../src/infrastructure/storage/local.js";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as crypto from "crypto";

describe("StorageAdapter Parity Tests", () => {
  let tempDir: string;
  let originalCwd: string;
  const testBucket = "test-bucket";

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = path.join(os.tmpdir(), `edms-test-${Date.now()}`);
    await fs.mkdir(path.join(tempDir, testBucket), { recursive: true });
    // Override STORAGE_BASE_DIR for tests by using a relative path
    process.chdir(tempDir);
  });

  afterAll(async () => {
    // process.cwd() belongs to the shared Jest worker, not this test file.
    // Restore it before cleanup so later suites continue to resolve project
    // files and dotenv configuration from the backend directory.
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("put(key, buffer) then get(key) returns identical bytes", async () => {
    const key = "test-file.txt";
    const originalBuffer = Buffer.from("Hello, World!");

    await putLocalFile(key, originalBuffer, testBucket);
    const retrievedBuffer = await getLocalFileBuffer(key, testBucket);

    expect(retrievedBuffer.equals(originalBuffer)).toBe(true);
  });

  it("exists(key) returns false before put, true after", async () => {
    const key = "exists-test.txt";

    const existsBefore = await localFileExists(key, testBucket);
    expect(existsBefore).toBe(false);

    await putLocalFile(key, Buffer.from("data"), testBucket);

    const existsAfter = await localFileExists(key, testBucket);
    expect(existsAfter).toBe(true);
  });

  it("delete(key) removes the key; subsequent exists returns false", async () => {
    const key = "delete-test.txt";

    await putLocalFile(key, Buffer.from("data"), testBucket);
    expect(await localFileExists(key, testBucket)).toBe(true);

    await deleteLocalFile(key, testBucket);
    expect(await localFileExists(key, testBucket)).toBe(false);
  });

  it("Encrypted roundtrip: encrypt then decrypt returns the original plaintext", async () => {
    const plaintext = Buffer.from("Sensitive data");
    const key = crypto.randomBytes(32); // AES-256 key
    const iv = crypto.randomBytes(12); // GCM IV

    // Encrypt
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, authTag, ciphertext]);

    // Store encrypted
    const storageKey = "encrypted-test.enc";
    await putLocalFile(storageKey, encrypted, testBucket);

    // Retrieve encrypted
    const retrieved = await getLocalFileBuffer(storageKey, testBucket);

    // Decrypt
    const retrievedIv = retrieved.subarray(0, 12);
    const retrievedAuthTag = retrieved.subarray(12, 28);
    const retrievedCiphertext = retrieved.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, retrievedIv);
    decipher.setAuthTag(retrievedAuthTag);
    const decrypted = Buffer.concat([decipher.update(retrievedCiphertext), decipher.final()]);

    expect(decrypted.equals(plaintext)).toBe(true);
  });
});
