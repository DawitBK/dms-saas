import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../../core/logger.js";

export function getStorageBaseDir() {
  return path.join(process.cwd(), "storage");
}

async function ensureDirectory(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    logger.error({ error, dirPath }, "Failed to create storage directory");
  }
}

export async function ensureLocalStorageDirectories() {
  const dirs = [
    path.join(getStorageBaseDir(), "documents"),
    path.join(getStorageBaseDir(), "archive"),
    path.join(getStorageBaseDir(), "previews"),
    path.join(getStorageBaseDir(), "versions")
  ];
  for (const dir of dirs) {
    await ensureDirectory(dir);
  }
  logger.info("Local storage directories ready");
}

export async function putLocalFile(key: string, buffer: Buffer, bucket: string = "documents") {
  const bucketDir = path.join(getStorageBaseDir(), bucket);
  await ensureDirectory(bucketDir);
  const filePath = path.join(bucketDir, key);
  const dir = path.dirname(filePath);
  await ensureDirectory(dir);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function getLocalFileBuffer(key: string, bucket: string = "documents"): Promise<Buffer> {
  const filePath = path.join(getStorageBaseDir(), bucket, key);
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    logger.error({ error, filePath, bucket, key }, "Failed to read local file");
    throw error;
  }
}

export async function localFileExists(key: string, bucket: string = "documents"): Promise<boolean> {
  try {
    const filePath = path.join(getStorageBaseDir(), bucket, key);
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function deleteLocalFile(key: string, bucket: string = "documents"): Promise<void> {
  const filePath = path.join(getStorageBaseDir(), bucket, key);
  await fs.unlink(filePath);
}
