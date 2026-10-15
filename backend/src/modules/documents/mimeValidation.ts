// S4-07: MIME byte-sniffing + blocked extension allowlist
// Uses file-type package to sniff actual MIME from file bytes
// Do not trust the Content-Type header — validate file contents

import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../../core/AppError.js";

// Blocked extensions — return HTTP 415 with MIME_NOT_ALLOWED
const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".ps1",
  ".sh",
  ".bash",
  ".vbs",
  ".js", // standalone upload
  ".msi",
  ".dll",
  ".so",
  ".dmg",
]);

// Per-cabinet allowlist (configurable — default allow list)
const DEFAULT_ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
]);

/**
 * Validate uploaded file using byte-sniffing and extension blocking.
 * Throws AppError on violation.
 */
export async function validateUploadedFile(
  buffer: Buffer,
  filename: string,
  cabinetId?: string
): Promise<void> {
  // Check blocked extensions first
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new AppError(
      415,
      "MIME_NOT_ALLOWED",
      `File extension ${ext} is not permitted for security reasons`
    );
  }

  // Sniff actual MIME from file bytes
  const detected = await fileTypeFromBuffer(buffer);
  
  // Get the allowlist for this cabinet (future: fetch from cabinet config)
  const allowedMimes = getCabinetAllowlist(cabinetId);
  
  if (!detected) {
    // Some text files may not have a detectable MIME signature
    // Allow plain text if the extension is .txt or .csv
    if (ext === ".txt" || ext === ".csv") {
      return;
    }
    throw new AppError(
      415,
      "MIME_NOT_ALLOWED",
      "Unable to detect file type. Supported formats: PDF, Word, Excel, images, text, CSV, ZIP"
    );
  }

  if (!allowedMimes.has(detected.mime)) {
    throw new AppError(
      415,
      "MIME_NOT_ALLOWED",
      `File type '${detected.mime}' is not permitted. Supported formats: PDF, Word, Excel, images, text, CSV, ZIP`
    );
  }
}

/**
 * Get the MIME allowlist for a specific cabinet.
 * In Phase 1, returns the default allowlist.
 * Phase 2/3 will fetch cabinet-specific configuration.
 */
function getCabinetAllowlist(_cabinetId?: string): Set<string> {
  // Future: fetch from cabinet config table
  // For now, return default allowlist
  return DEFAULT_ALLOWED_MIMES;
}
