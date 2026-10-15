// S4-18: Preview endpoint - generates thumbnails/previews (not full files)
// Images: sharp resize to 400x400 JPEG
// PDFs: SVG-based cover thumbnail rendered via sharp (no native rasterizer needed)
// Other: 415 PREVIEW_NOT_SUPPORTED

import sharp from "sharp";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { Document, DocumentVersion } from "../../infrastructure/database/index.js";
import { requireDocumentAccess, assertScanCleared } from "../../shared/documentGuards.js";
import { fetchAndDecrypt } from "./documentCrypto.js";
import { assertStatusPermission } from "./statusPermissions.service.js";

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
  roles?: readonly string[];
};

const IMAGE_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff"
];

const PDF_MIME = "application/pdf";

const MAX_PREVIEW_WIDTH = 400;
const MAX_PREVIEW_HEIGHT = 400;

/**
 * S4-18: Generate preview for document
 * - Images: thumbnail max 400x400 JPEG
 * - PDFs: SVG cover card rendered to JPEG via sharp
 * - Other: 415 PREVIEW_NOT_SUPPORTED
 */
export async function generateDocumentPreview(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentVersion,
        as: "versions",
        separate: true,
        order: [["createdAt", "DESC"]]
      }
    ]
  });

  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  requireDocumentAccess(document, user);
  assertScanCleared(document);
  await assertStatusPermission(document, "preview", user);

  const latestVersion = (document as any).versions?.[0];
  if (!latestVersion) {
    throw new AppError(404, "ERR-VERSION-NOT-FOUND", "No version available");
  }

  const mimeType = latestVersion.mimeType;

  if (mimeType === PDF_MIME) {
    // Generate a cover-card thumbnail using SVG + sharp (no native rasterizer needed).
    // This provides a branded placeholder showing document metadata until a full
    // rasterizer (pdfjs-dist + canvas) is wired in.
    return generatePdfCoverThumbnail(
      (document as any).title ?? "Document",
      latestVersion.originalFilename ?? ""
    );
  }

  if (IMAGE_MIMES.includes(mimeType)) {
    const decryptedBuffer = await fetchAndDecrypt(latestVersion.storageKey, latestVersion.id);
    return generateImageThumbnail(decryptedBuffer);
  }

  throw new AppError(415, "PREVIEW_NOT_SUPPORTED", `Preview not supported for ${mimeType}`);
}

/**
 * Generate thumbnail for image files (max 400x400 JPEG)
 */
async function generateImageThumbnail(buffer: Buffer) {
  try {
    const thumbnail = await sharp(buffer)
      .resize(MAX_PREVIEW_WIDTH, MAX_PREVIEW_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    return {
      buffer: thumbnail,
      mimeType: "image/jpeg"
    };
  } catch (error) {
    logger.error({ error }, "Failed to generate image thumbnail");
    throw new AppError(500, "ERR-PREVIEW-GENERATION-FAILED", "Failed to generate image preview");
  }
}

/**
 * Generate a branded SVG cover card for PDF documents and render it to JPEG via sharp.
 * Avoids native binaries (pdf-poppler) or canvas deps (pdfjs-dist + node-canvas).
 * Upgrade path: replace this with real first-page rasterization when node-canvas is available.
 */
async function generatePdfCoverThumbnail(title: string, filename: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // Truncate long titles to fit in the card
  const safeTitle = escapeXml(title.length > 40 ? title.slice(0, 40) + "…" : title);
  const safeFilename = escapeXml(filename.length > 36 ? filename.slice(0, 36) + "…" : filename);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_PREVIEW_WIDTH}" height="${MAX_PREVIEW_HEIGHT}" viewBox="0 0 400 400">
  <!-- Background -->
  <rect width="400" height="400" fill="#f8fafc" rx="8"/>
  <!-- Header band -->
  <rect width="400" height="80" fill="#1e40af" rx="8"/>
  <rect y="72" width="400" height="8" fill="#1e40af"/>
  <!-- PDF icon area -->
  <rect x="155" y="110" width="90" height="120" fill="#ffffff" rx="4" stroke="#e2e8f0" stroke-width="1"/>
  <!-- Page fold corner -->
  <polygon points="215,110 245,140 215,140" fill="#e2e8f0"/>
  <polygon points="215,110 245,110 245,140" fill="#cbd5e1"/>
  <!-- PDF text on icon -->
  <text x="200" y="195" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#dc2626" text-anchor="middle">PDF</text>
  <!-- Red underline on icon -->
  <rect x="175" y="202" width="50" height="3" fill="#dc2626" rx="1"/>
  <!-- Document title -->
  <text x="200" y="268" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="#1e293b" text-anchor="middle">${safeTitle}</text>
  <!-- Filename (smaller) -->
  <text x="200" y="292" font-family="Arial,sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${safeFilename}</text>
  <!-- DMS branding footer -->
  <text x="200" y="368" font-family="Arial,sans-serif" font-size="10" fill="#94a3b8" text-anchor="middle">DMS Document Management</text>
  <!-- Header text -->
  <text x="200" y="46" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">Document Preview</text>
</svg>`.trim();

  try {
    const buffer = await sharp(Buffer.from(svg))
      .jpeg({ quality: 90 })
      .toBuffer();
    return { buffer, mimeType: "image/jpeg" };
  } catch (error) {
    logger.error({ error }, "Failed to render PDF cover thumbnail");
    throw new AppError(500, "ERR-PREVIEW-GENERATION-FAILED", "Failed to generate PDF preview");
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
