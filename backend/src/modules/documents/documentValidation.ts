import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { AppError } from "../../core/AppError.js";

export const permittedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/tiff",
  "image/png",
  "image/jpeg",
  "message/rfc822",
  "text/plain",
  "application/xml",
  "text/xml",
  "text/csv"
]);

export const mandatoryMetadataFields = [
  "title",
  "departmentCode",
  "documentTypeCode",
  "organisationUnit",
  "securityClassification",
  "retentionClass",
  "source",
] as const;

export async function validateUploadInput(input: Record<string, unknown>, file: { buffer: Buffer; mimetype: string; size: number; originalname: string }) {
  if (!permittedMimeTypes.has(file.mimetype)) throw new AppError(422, "ERR-FORMAT-UNSUPPORTED", "Unsupported file format");
  if (file.size > 500 * 1024 * 1024) throw new AppError(422, "ERR-FILESIZE-EXCEEDED", "File exceeds 500 MB");
  if (file.originalname.length > 255) throw new AppError(422, "ERR-FILENAME-TOO-LONG", "Filename exceeds 255 characters");

  // VAL-003: Check if PDF is encrypted/password-protected
  if (file.mimetype === "application/pdf") {
    try {
      const pdfDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: false });
      if (pdfDoc.isEncrypted) {
        throw new AppError(422, "ERR-FILE-ENCRYPTED", "PDF file is password-protected");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // If pdf-lib throws, it might be because it's encrypted and we didn't provide a password
      if (error instanceof Error && error.message.includes("encrypted")) {
        throw new AppError(422, "ERR-FILE-ENCRYPTED", "PDF file is password-protected");
      }
      // Other parsing errors
      throw new AppError(422, "ERR-FORMAT-INVALID", "Invalid PDF file structure");
    }
  }

  // "departmentCode" is satisfied by either field: departmentId is the
  // precise, collision-free identifier newer callers send (department codes
  // are only unique per org unit as of migration
  // 20260912000001-department-code-scope-org-unit.sql), departmentCode is
  // kept for callers that haven't been updated. createDocumentSchema's own
  // refine() is the actual "at least one" enforcement; this just has to not
  // reject a departmentId-only submission before that schema ever runs.
  const missing = mandatoryMetadataFields.filter((field) => {
    if (field === "departmentCode") return !input.departmentCode && !input.departmentId;
    return input[field] === undefined || input[field] === "";
  });
  if (missing.length > 0) throw new AppError(422, "ERR-METADATA-MISSING", "Mandatory metadata is missing", { missing });
  if (!input.securityClassification) throw new AppError(422, "ERR-CLASSIFICATION-MISSING", "Security classification is required");
}

export function sha256(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
