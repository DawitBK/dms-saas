// Boot-time storage initialisation only.
//
// Reads and writes go through StorageAdapter.ts (`getStorageAdapter()`), which
// every module uses. This file used to export its own putFile/getFileBuffer
// pair with a parallel MinIO-or-local fallback; nothing called them once the
// adapter landed, so they are gone. Do not add I/O helpers back here — one
// storage entry point is the point.
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { minioClient, ensureBucket } from "./minio.js";
import { ensureLocalStorageDirectories } from "./local.js";

/**
 * Decide, once at boot, whether MinIO is usable, and make sure the place we
 * are going to write to actually exists.
 *
 * DMS is designed to degrade rather than refuse: with MinIO unreachable it runs
 * on local disk (`STORAGE_DRIVER=local` is also how the Example Corp server runs
 * it permanently). That fallback is convenient and is also why a misconfigured
 * MINIO_ENDPOINT can go unnoticed for a long time — see backend/.env.example on
 * why the host there is 127.0.0.1 and not "localhost".
 */
export async function initializeStorage() {
  try {
    await minioClient.listBuckets();
  } catch {
    logger.warn("MinIO unavailable, falling back to local storage");
    await ensureLocalStorageDirectories();
    return;
  }

  try {
    await ensureBucket(config.MINIO_BUCKET_DOCUMENTS);
    await ensureBucket(config.MINIO_BUCKET_ARCHIVE);
    logger.info("Using MinIO for file storage");
  } catch (error) {
    logger.warn({ error }, "MinIO bucket creation failed, falling back to local storage");
    await ensureLocalStorageDirectories();
  }
}
