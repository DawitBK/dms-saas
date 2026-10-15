// Renders one page of a PDF to a PNG buffer — for any feature that needs a
// PDF turned into an image rather than text (today: the form-builder's
// "build from a photo or PDF", which hands the page to a vision model).
//
// Deliberately a small, standalone helper rather than an export pulled out of
// OCRWorker.ts's extractPdf(): that function is a proven, working pipeline
// with its own OCR-specific concerns (text-layer-first shortcut, multi-page
// looping, tesseract handoff); this only ever needs one page rendered to
// bytes. Reuses the exact same safe rendering path OCRWorker.ts uses (same
// pdfjs-dist + `canvas` combination, same pixel-cap guard) rather than
// inventing a different one.
import { AppError } from "../core/AppError.js";
import { logger } from "../core/logger.js";

// Mirrors OCRWorker.ts's PDF_MAX_OCR_PIXELS guard — protects against a
// pathological page size blowing up the rasterized canvas allocation
// (width*height*4 bytes), regardless of which native canvas library is in use.
const MAX_RASTER_PIXELS = 30_000_000; // ~30MP, well above any print-quality A4/A3 page

/**
 * Rasterizes page `pageNumber` (1-based, default the first page) of a PDF to
 * a PNG buffer.
 *
 * FIX-CLASS NOTE: renders via `canvas` (node-canvas/Cairo), never
 * `@napi-rs/canvas` — see OCRWorker.ts's own comment on this exact point.
 * That native (Rust/Skia) renderer segfaults — a true OS-level crash, not a
 * catchable JS exception — on PDFs using a CMYK axial-gradient shading, which
 * real letterhead/pre-printed form artwork commonly contains. Do not swap
 * this to @napi-rs/canvas.
 */
export async function rasterizeFirstPdfPage(buffer: Buffer, pageNumber = 1, scale = 2.5): Promise<Buffer> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  try {
    if (pageNumber > doc.numPages) {
      throw new AppError(422, "ERR-PDF-PAGE-OUT-OF-RANGE", `This PDF only has ${doc.numPages} page(s)`);
    }
    const page = await doc.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width * height > MAX_RASTER_PIXELS) {
        logger.warn({ pageNumber, width, height }, "[pdfRasterize] page exceeds raster pixel cap");
        throw new AppError(422, "ERR-PDF-PAGE-TOO-LARGE", "This PDF page is too large to process");
      }
      const { createCanvas } = await import("canvas");
      const canvas = createCanvas(width, height);
      const canvasContext = canvas.getContext("2d");
      await page.render({ canvasContext, viewport, canvas } as any).promise;
      return canvas.toBuffer("image/png");
    } finally {
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
}
