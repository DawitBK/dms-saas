// S4-05 / FIX-§0: Canonical envelope-encryption pipeline.
//
// This is the SINGLE write path and SINGLE read path for document bytes in the
// whole system. Uploads, version restores, and seeders all call `encryptAndStore`;
// downloads, previews, and any reader all call `fetchAndDecrypt`. Nothing else
// may write document ciphertext to disk or read it back directly.
//
// Layout on disk (LocalStorageAdapter, rooted at storage/dms-documents/):
//   {storageKey}.enc   ->  IV(12) || AuthTag(16) || ciphertext   (AES-256-GCM)
// A matching `DocumentDek` row, keyed by versionId (one row per
// DocumentVersion, NOT per Document), stores the KEK-wrapped DEK + kekId so
// the bytes can only be decrypted through the Vault. `storageKey` is
// persisted on DocumentVersion WITHOUT the `.enc` suffix; the suffix is
// appended here.

import crypto from "node:crypto";
import { Readable } from "node:stream";
import { AppError } from "../../core/AppError.js";
import { DocumentDek } from "../../infrastructure/database/index.js";
import { getStorageAdapter } from "../../infrastructure/storage/StorageAdapter.js";
import { getVaultService } from "../../infrastructure/vault/VaultService.js";

export type EncryptResult = {
  encryptedKey: string;
  sha256Hash: string;
  kekId: string;
};

/**
 * Encrypt a plaintext document buffer and persist the ciphertext at
 * `{key}.enc`. Generates a fresh per-VERSION DEK via the Vault on every call
 * (never reuse a DEK across versions — see DocumentDek), AES-256-GCM
 * encrypts (IV || authTag || ciphertext), and returns the wrapped DEK +
 * kekId + SHA-256 of the *encrypted* bytes. The caller is responsible for
 * persisting the `DocumentDek` row (keyed by versionId) and the
 * `DocumentVersion.storageKey` (the bare key, without `.enc`).
 */
export async function encryptAndStore(
  key: string,
  plaintextBuffer: Buffer,
  mimeType: string,
  _departmentId: string,
  tenantId: string,
): Promise<EncryptResult> {
  const vault = getVaultService();
  const storage = getStorageAdapter();
  const { plaintextDek, encryptedDek, kekId } = await vault.generateDEK(tenantId);

  // AES-256-GCM encrypt: output = IV(12) + AuthTag(16) + ciphertext
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", plaintextDek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBuffer),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const encryptedBuffer = Buffer.concat([iv, authTag, ciphertext]);

  // SHA-256 over the encrypted bytes (integrity of ciphertext at rest)
  const sha256Hash = crypto
    .createHash("sha256")
    .update(encryptedBuffer)
    .digest("hex");

  await storage.put(key + ".enc", encryptedBuffer, mimeType);
  // Best-effort wipe of the plaintext DEK from memory
  plaintextDek.fill(0);
  return { encryptedKey: encryptedDek, sha256Hash, kekId };
}

/**
 * Read `{storageKey}.enc` back from storage, look up the matching `DocumentDek`
 * row for THIS SPECIFIC VERSION, unwrap the DEK via the Vault, and AES-256-GCM
 * decrypt. Throws `ERR-DEK-MISSING` when no key row exists and surfaces
 * storage read errors as-is so callers can distinguish missing-file from
 * missing-key.
 *
 * FIX: keyed by versionId, not documentId. Each DocumentVersion is encrypted
 * under its own DEK — a document with N versions has N DocumentDek rows, one
 * per version, so an older version stays decryptable after newer versions
 * are uploaded.
 */
export async function fetchAndDecrypt(
  storageKey: string,
  versionId: string,
): Promise<Buffer> {
  const storage = getStorageAdapter();
  const vault = getVaultService();

  let encryptedBuffer: Buffer;
  try {
    encryptedBuffer = await storage.get(storageKey + ".enc");
  } catch (err) {
    throw new AppError(
      503,
      "ERR-STORAGE-UNAVAILABLE",
      "Document storage is unavailable or the file is missing",
      { storageKey, cause: err instanceof Error ? err.message : String(err) },
    );
  }
  const dek = await DocumentDek.findOne({
    where: { versionId },
    attributes: ["encryptedDek", "kekId"],
  });
  if (!dek) {
    throw new AppError(
      500,
      "ERR-DEK-MISSING",
      "Encryption key not found for this document version",
    );
  }

  const plaintextDek = await vault.unwrapDEK(dek.encryptedDek, dek.kekId);
  const iv = encryptedBuffer.subarray(0, 12);
  const authTag = encryptedBuffer.subarray(12, 28);
  const ciphertext = encryptedBuffer.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", plaintextDek, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  plaintextDek.fill(0);
  return plaintext;
}

// ─── Streaming path (large files — see migration 20260813000002) ───────────
//
// encryptAndStore/fetchAndDecrypt above stay untouched and remain the path
// for every existing caller (letters, e-signing, forms, previews, version
// restores, seeders, and the ≤25MB multer upload route) — all of those
// operate on buffers that were never a real memory/CPU problem. This
// streaming path exists ONLY for genuinely large files (currently: tus
// uploads over 100MB — see tusUpload.ts), where reading the whole plaintext
// into memory before encrypting it is the actual problem being solved.
//
// On-disk layout: IV(12) || ciphertext || AuthTag(16) — tag at the END,
// unlike the legacy IV||AuthTag||ciphertext layout, because a streaming
// writer can't know the GCM auth tag until the entire plaintext has passed
// through the cipher. DocumentDek.formatVersion (2 here, vs 1 for legacy)
// tells fetchDecryptStream which layout a given version used.

/** Reads a fixed number of bytes at a time from an async byte stream,
 *  buffering across however the underlying chunks actually arrive (a single
 *  fs/network chunk is never guaranteed to align with IV/tag boundaries). */
class ChunkReader {
  private buffer = Buffer.alloc(0);
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.iterator.next();
    if (done) {
      this.done = true;
      return false;
    }
    this.buffer = Buffer.concat([this.buffer, value]);
    return true;
  }

  /** Read exactly n bytes, throwing if the stream ends first. */
  async readExactly(n: number): Promise<Buffer> {
    while (this.buffer.length < n) {
      if (!(await this.fill())) {
        throw new AppError(
          500,
          "ERR-CIPHERTEXT-TRUNCATED",
          `Stored document is truncated or corrupted (needed ${n} bytes, got ${this.buffer.length})`,
        );
      }
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Async-iterate whatever bytes remain — whatever's already buffered first, then the rest of the source. */
  async *remaining(): AsyncGenerator<Buffer> {
    if (this.buffer.length > 0) {
      yield this.buffer;
      this.buffer = Buffer.alloc(0);
    }
    while (await this.fill()) {
      yield this.buffer;
      this.buffer = Buffer.alloc(0);
    }
  }
}

/**
 * Streaming counterpart to encryptAndStore: encrypts and uploads without
 * ever holding the full plaintext (or full ciphertext) in memory at once.
 * `makePlaintextSource` is a FACTORY — called once per attempt, so a storage
 * retry (see ResilientStorageAdapter) re-reads from the start rather than
 * reusing an already-consumed stream, and a fresh Cipher is created per
 * attempt since a Cipher instance is one-shot and can't be rewound either.
 */
export async function encryptStreamAndStore(
  key: string,
  makePlaintextSource: () => Readable,
  mimeType: string,
  tenantId: string,
): Promise<EncryptResult & { formatVersion: number }> {
  const vault = getVaultService();
  const storage = getStorageAdapter();
  const { plaintextDek, encryptedDek, kekId } = await vault.generateDEK(tenantId);
  const iv = crypto.randomBytes(12);

  let sha256Hash = "";

  const makeEncryptedSource = (): Readable => {
    const cipher = crypto.createCipheriv("aes-256-gcm", plaintextDek, iv);
    const hash = crypto.createHash("sha256");

    async function* generate(): AsyncGenerator<Buffer> {
      hash.update(iv);
      yield iv;
      for await (const chunk of makePlaintextSource()) {
        const encChunk = cipher.update(chunk as Buffer);
        if (encChunk.length) {
          hash.update(encChunk);
          yield encChunk;
        }
      }
      const final = cipher.final();
      if (final.length) {
        hash.update(final);
        yield final;
      }
      const tag = cipher.getAuthTag();
      hash.update(tag);
      yield tag;
      // Only trustworthy once the generator has fully drained — see the
      // await storage.putStream(...) below, which doesn't resolve until
      // every chunk here has actually been written out.
      sha256Hash = hash.digest("hex");
    }

    return Readable.from(generate());
  };

  try {
    await storage.putStream(key + ".enc", makeEncryptedSource, mimeType);
  } finally {
    plaintextDek.fill(0);
  }

  return { encryptedKey: encryptedDek, sha256Hash, kekId, formatVersion: 2 };
}

/**
 * Streaming counterpart to fetchAndDecrypt: returns a Readable of plaintext
 * instead of a Buffer, so a caller (e.g. the download route) can pipe it
 * straight to the HTTP response without buffering the whole file. Handles
 * BOTH DocumentDek.formatVersion layouts, since old (format 1) and new
 * (format 2) versions coexist in the same system indefinitely.
 *
 * Trade-off vs fetchAndDecrypt: the plaintext-hash integrity check
 * (DocumentVersion.plaintextSha256) can't happen before sending bytes to the
 * client here — the whole point is not buffering the full plaintext to
 * check it first. Callers that need pre-send verification should stay on
 * fetchAndDecrypt; this is only wired up for format-2 (streaming-written,
 * i.e. large) documents, where buffering the same amount for verification
 * would defeat the purpose. GCM's own auth-tag check still runs (see
 * decipher.final() below) and still throws on tampering/corruption — it
 * just does so as a stream error, potentially after some plaintext has
 * already been flushed to the response, rather than before any of it has.
 */
export async function fetchDecryptStream(
  storageKey: string,
  versionId: string,
): Promise<Readable> {
  const storage = getStorageAdapter();
  const vault = getVaultService();

  const dek = await DocumentDek.findOne({
    where: { versionId },
    attributes: ["encryptedDek", "kekId", "formatVersion"],
  });
  if (!dek) {
    throw new AppError(
      500,
      "ERR-DEK-MISSING",
      "Encryption key not found for this document version",
    );
  }

  let encryptedStream: Readable;
  try {
    encryptedStream = await storage.getStream(storageKey + ".enc");
  } catch (err) {
    throw new AppError(
      503,
      "ERR-STORAGE-UNAVAILABLE",
      "Document storage is unavailable or the file is missing",
      { storageKey, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  const plaintextDek = await vault.unwrapDEK(dek.encryptedDek, dek.kekId);
  const formatVersion = dek.formatVersion ?? 1;

  async function* decryptGenerator(): AsyncGenerator<Buffer> {
    try {
      const reader = new ChunkReader(encryptedStream[Symbol.asyncIterator]());
      const iv = await reader.readExactly(12);
      const decipher = crypto.createDecipheriv("aes-256-gcm", plaintextDek, iv);

      if (formatVersion === 1) {
        // Legacy layout: the tag sits immediately after the IV, so it's
        // available up front — everything after it is ciphertext.
        const tag = await reader.readExactly(16);
        decipher.setAuthTag(tag);
        for await (const chunk of reader.remaining()) {
          const out = decipher.update(chunk);
          if (out.length) yield out;
        }
      } else {
        // Streaming layout: the tag is the LAST 16 bytes, which we can't
        // identify until the source ends. Keep a 16-byte trailing window at
        // all times and only feed the decipher bytes we're sure precede it.
        let pending = Buffer.alloc(0);
        for await (const chunk of reader.remaining()) {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > 16) {
            const toDecrypt = pending.subarray(0, pending.length - 16);
            pending = pending.subarray(pending.length - 16);
            const out = decipher.update(toDecrypt);
            if (out.length) yield out;
          }
        }
        if (pending.length !== 16) {
          throw new AppError(
            500,
            "ERR-CIPHERTEXT-TRUNCATED",
            "Stored document is truncated or corrupted",
          );
        }
        decipher.setAuthTag(pending);
      }

      // Throws on auth-tag mismatch (tampering/corruption) for either
      // layout — this is GCM's actual integrity check, distinct from (and
      // in addition to) the at-rest SHA-256 hash.
      const final = decipher.final();
      if (final.length) yield final;
    } finally {
      plaintextDek.fill(0);
    }
  }

  return Readable.from(decryptGenerator());
}
