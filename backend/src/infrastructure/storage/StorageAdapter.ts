// S4-02: StorageAdapter interface and factory
// LocalStorageAdapter stores files at storage/dms-documents/{key}
// MinioStorageAdapter wraps the existing MinIO client
// Factory selects based on STORAGE_DRIVER env var

import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../../core/logger.js";
import { config } from "../../config/env.js";
import { minioClient } from "./minio.js";

export interface StorageAdapter {
  put(key: string, buffer: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Streaming write for large payloads that shouldn't be buffered fully in
   * memory (see documentCrypto.ts's encryptStreamAndStore). `makeStream` is a
   * FACTORY, not a stream instance — ResilientStorageAdapter calls it again
   * to retry on the fallback backend if the primary write fails, and a
   * once-consumed Readable can't be rewound for that retry.
   */
  putStream(key: string, makeStream: () => Readable, mimeType: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

// ── Local Storage Adapter ──────────────────────────────────────────────────

const LOCAL_BASE = config.STORAGE_LOCAL_PATH
  ? path.resolve(config.STORAGE_LOCAL_PATH)
  : path.resolve(process.cwd(), "storage", "dms-documents");
// Trailing separator so a startsWith() check can't be fooled by a sibling
// directory that merely shares LOCAL_BASE as a string prefix (e.g.
// "storage/dms-documents-evil" would otherwise pass a bare startsWith(LOCAL_BASE)).
const LOCAL_BASE_WITH_SEP = LOCAL_BASE + path.sep;

/**
 * Defense-in-depth containment check: resolves `key` against LOCAL_BASE and
 * throws if the result would land outside LOCAL_BASE. The storage key is
 * expected to already be built from a sanitized filename (see
 * shared/sanitizeFilename.ts) by every caller, but this backstops any future
 * or as-yet-unaudited call site that forgets to sanitize before the key
 * reaches the filesystem layer.
 */
function resolveContainedPath(key: string): string {
  const filePath = path.resolve(LOCAL_BASE, key);
  if (filePath !== LOCAL_BASE && !filePath.startsWith(LOCAL_BASE_WITH_SEP)) {
    throw new Error(`LocalStorageAdapter: refusing to access path outside storage root (key="${key}")`);
  }
  return filePath;
}

export class LocalStorageAdapter implements StorageAdapter {
  async put(key: string, buffer: Buffer, _mimeType: string): Promise<void> {
    const filePath = resolveContainedPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    logger.debug({ key, bytes: buffer.length }, "LocalStorage: stored file");
  }

  async get(key: string): Promise<Buffer> {
    const filePath = resolveContainedPath(key);
    return fs.readFile(filePath);
  }

  async putStream(key: string, makeStream: () => Readable, _mimeType: string): Promise<void> {
    const filePath = resolveContainedPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(makeStream(), createWriteStream(filePath));
    logger.debug({ key }, "LocalStorage: streamed file");
  }

  async getStream(key: string): Promise<Readable> {
    const filePath = resolveContainedPath(key);
    // Confirm the file exists before handing back a stream, so a missing
    // file surfaces as a clean rejection here rather than a mid-stream
    // 'error' event after a caller has already started piping the response.
    await fs.access(filePath);
    return createReadStream(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = resolveContainedPath(key);
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = resolveContainedPath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(_key: string, _expiresInSeconds: number): Promise<string> {
    // TEN-3: this used to return `/api/v1/documents/storage/download?path=...`
    // — a URL with no signature and no real expiry, pointing at a route that
    // was already removed elsewhere for letting any caller enumerate other
    // tenants' storage keys. Zero real callers exist anywhere in the
    // codebase today (checked directly), but a silently "working" broken
    // pointer is exactly the kind of dead code that gets wired into a future
    // "share this document" feature without anyone noticing it was never
    // actually safe. Local disk storage has no equivalent of a real signed
    // URL (no signature, no built-in expiry the way MinioStorageAdapter's
    // presignedGetObject has) — fail loudly instead, so any future caller is
    // forced to handle this backend explicitly rather than trust a string
    // that looks like a real presigned URL but never was one.
    throw new Error(
      "getSignedUrl is not supported for local disk storage — route downloads through the authenticated /documents/:id/download endpoint instead",
    );
  }
}

// ── MinIO Storage Adapter ──────────────────────────────────────────────────

export class MinioStorageAdapter implements StorageAdapter {
  private readonly bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
  }

  async put(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    await minioClient.putObject(this.bucket, key, buffer, buffer.length, { "Content-Type": mimeType });
    logger.debug({ key, bytes: buffer.length, bucket: this.bucket }, "MinIO: stored file");
  }

  async get(key: string): Promise<Buffer> {
    const stream = await minioClient.getObject(this.bucket, key);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  async putStream(key: string, makeStream: () => Readable, mimeType: string): Promise<void> {
    // size omitted (undefined): the minio client streams the upload as
    // multipart parts of unknown total length rather than requiring one
    // fully-buffered, length-known payload.
    await minioClient.putObject(this.bucket, key, makeStream(), undefined, { "Content-Type": mimeType });
    logger.debug({ key, bucket: this.bucket }, "MinIO: streamed file");
  }

  async getStream(key: string): Promise<Readable> {
    return minioClient.getObject(this.bucket, key);
  }

  async delete(key: string): Promise<void> {
    await minioClient.removeObject(this.bucket, key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await minioClient.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return minioClient.presignedGetObject(this.bucket, key, expiresInSeconds);
  }
}

// ── Resilient Adapter ──────────────────────────────────────────────────────
//
// FIX: the factory used to hand out a single adapter chosen once, statically,
// from STORAGE_DRIVER — with no runtime fallback at all for this (the
// canonical) storage path. If MinIO was down when a document was written,
// there was nowhere for those bytes to go; if MinIO recovered later (or the
// driver setting simply differed across a restart), a document written
// while the "wrong" backend was live would 404 forever, because nothing
// records which backend actually received a given object's bytes.
//
// This wraps a primary/secondary pair: writes go to the primary and fall
// back to the secondary if the primary is unreachable right now (logged as
// a warning, not silent); reads try the primary first and, on a
// not-found/unreachable error, retry the secondary before giving up. That
// makes correctness independent of *when* a file was written relative to an
// outage — a read always checks both real locations rather than inferring
// one from a static, possibly-stale choice.
class ResilientStorageAdapter implements StorageAdapter {
  constructor(
    private readonly primary: StorageAdapter,
    private readonly secondary: StorageAdapter,
    private readonly primaryName: string,
    private readonly secondaryName: string,
  ) {}

  async put(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    try {
      await this.primary.put(key, buffer, mimeType);
    } catch (error) {
      logger.warn(
        { key, error, primary: this.primaryName, fallback: this.secondaryName },
        "StorageAdapter: primary backend unreachable on write, falling back",
      );
      await this.secondary.put(key, buffer, mimeType);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await this.primary.get(key);
    } catch (primaryError) {
      try {
        const buffer = await this.secondary.get(key);
        logger.warn(
          { key, primary: this.primaryName, fallback: this.secondaryName },
          "StorageAdapter: object not found on primary backend, served from fallback",
        );
        return buffer;
      } catch {
        throw primaryError;
      }
    }
  }

  async putStream(key: string, makeStream: () => Readable, mimeType: string): Promise<void> {
    try {
      await this.primary.putStream(key, makeStream, mimeType);
    } catch (error) {
      logger.warn(
        { key, error, primary: this.primaryName, fallback: this.secondaryName },
        "StorageAdapter: primary backend unreachable on stream write, falling back",
      );
      // Safe to call makeStream() again here: it's a factory (see the
      // interface doc comment), so this gets a fresh, unconsumed stream
      // rather than reusing one the failed primary attempt already drained.
      await this.secondary.putStream(key, makeStream, mimeType);
    }
  }

  async getStream(key: string): Promise<Readable> {
    // Unlike get()'s try/catch-after-the-fact fallback, this checks existence
    // BEFORE opening a stream: once a caller starts piping a stream to an
    // HTTP response, there's no way to swap sources mid-flight if it errors
    // partway through without corrupting or duplicating already-sent bytes.
    if (await this.primary.exists(key)) {
      return this.primary.getStream(key);
    }
    logger.warn(
      { key, primary: this.primaryName, fallback: this.secondaryName },
      "StorageAdapter: object not found on primary backend, streaming from fallback",
    );
    return this.secondary.getStream(key);
  }

  async delete(key: string): Promise<void> {
    const results = await Promise.allSettled([
      this.primary.delete(key),
      this.secondary.delete(key),
    ]);
    // Only surface a failure if BOTH backends failed to delete — a file that
    // only ever lived on one of them should still be fully removed by a
    // single successful delete call.
    if (results.every((r) => r.status === "rejected")) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (await this.primary.exists(key)) return true;
    return this.secondary.exists(key);
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (await this.primary.exists(key)) {
      return this.primary.getSignedUrl(key, expiresInSeconds);
    }
    return this.secondary.getSignedUrl(key, expiresInSeconds);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let _adapter: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (_adapter) return _adapter;

  const driver = config.STORAGE_DRIVER ?? "local";
  const bucket = config.MINIO_BUCKET_DOCUMENTS;
  const minio = new MinioStorageAdapter(bucket);
  const local = new LocalStorageAdapter();

  if (driver === "minio") {
    _adapter = new ResilientStorageAdapter(minio, local, "minio", "local");
    logger.info({ driver, bucket }, "StorageAdapter: using MinIO (local fallback on read/write failure)");
  } else {
    _adapter = new ResilientStorageAdapter(local, minio, "local", "minio");
    logger.info({ driver, base: LOCAL_BASE }, "StorageAdapter: using local filesystem (MinIO fallback on read/write failure)");
  }

  return _adapter;
}

/** Reset the singleton (for testing only) */
export function resetStorageAdapter(): void {
  _adapter = null;
}
