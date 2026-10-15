// S4-06: index.json sidecar per document version
// Every document version gets a metadata sidecar at {storageKey}.index.json

import { getStorageAdapter } from "../../infrastructure/storage/StorageAdapter.js";
import { logger } from "../../core/logger.js";

export interface IndexSidecar {
  documentId: string;
  versionId: string;
  filename: string;
  mimeType: string;
  sensitivityLabel: string;
  sha256: string; // of encrypted bytes
  kekId: string;
  createdAt: string; // ISO8601
  createdBy: string; // userId
}

/**
 * Write index.json sidecar for a document version.
 * Stored at {storageKey}.index.json in the same storage adapter.
 */
export async function writeIndexSidecar(
  storageKey: string,
  sidecar: IndexSidecar
): Promise<void> {
  const storage = getStorageAdapter();
  const json = JSON.stringify(sidecar, null, 2);
  const buffer = Buffer.from(json, "utf-8");
  
  await storage.put(
    `${storageKey}.index.json`,
    buffer,
    "application/json"
  );
  
  logger.debug(
    { storageKey, documentId: sidecar.documentId, versionId: sidecar.versionId },
    "Wrote index.json sidecar"
  );
}

/**
 * Read index.json sidecar for a document version.
 * Returns null if not found.
 */
export async function readIndexSidecar(
  storageKey: string
): Promise<IndexSidecar | null> {
  const storage = getStorageAdapter();
  const sidecarKey = `${storageKey}.index.json`;
  
  const exists = await storage.exists(sidecarKey);
  if (!exists) {
    return null;
  }
  
  const buffer = await storage.get(sidecarKey);
  const json = buffer.toString("utf-8");
  return JSON.parse(json) as IndexSidecar;
}
