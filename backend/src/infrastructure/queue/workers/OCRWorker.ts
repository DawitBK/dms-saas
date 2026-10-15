import { isAiConfigured } from "../../../modules/ai/llmClient.js";
import { Worker, Job, Queue } from "bullmq";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { franc } from "franc";
import { getRedis } from "../../cache/redis.js";
import { Document, DocumentVersion, initModels, connectDB } from "../../database/index.js";
import { logger } from "../../../core/logger.js";
import { fetchAndDecrypt } from "../../../modules/documents/documentCrypto.js";
import { fileTypeFromBuffer } from "file-type";
import { enqueueWebsocketEvent } from "../outbox.js";
import { withWorkerTenantContext } from "../../../shared/workerTenantContext.js";
import { ocrProcessingDuration, recordOcrOutcome } from "../../metrics.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

// documents has RLS with no unset-GUC escape valve (unlike document_versions,
// which has none at all) — a bare read/write here would silently touch 0 rows
// the day the DB role is switched to the restricted edams_app role. tenantId
// comes from the job payload (set by whoever enqueued it); older queued jobs
// from before this field existed fall back to running with no context,
// matching this worker's pre-fix behavior rather than crashing them.
async function emitOcrCompleted(documentId: string, ocrStatus: string, tenantId?: string): Promise<void> {
  try {
    const doc = tenantId
      ? await withWorkerTenantContext(tenantId, () => Document.findByPk(documentId, { attributes: ["departmentId", "tenantId"] }))
      : await Document.findByPk(documentId, { attributes: ["departmentId", "tenantId"] });
    await enqueueWebsocketEvent("DOCUMENT.OCR_COMPLETED", {
      documentId,
      ocrStatus,
      departmentId: (doc as any)?.departmentId ?? null,
      tenantId: (doc as any)?.tenantId ?? tenantId ?? "unknown",
    });
  } catch (err) {
    logger.error({ err, documentId }, "failed to enqueue OCR_COMPLETED websocket event");
  }
}

// Map ISO 639-3 (franc output) to tesseract language codes
const FRANC_TO_TESSERACT: Record<string, string> = {
  eng: "eng",
  amh: "amh",
  fra: "fra",
  deu: "deu",
  spa: "spa",
  por: "por",
  ara: "ara",
  zho: "chi_sim",
  jpn: "jpn",
  kor: "kor",
};

function detectLanguage(text: string): string {
  if (!text || text.length < 20) return "eng";
  const lang = franc(text, { minLength: 10 });
  return FRANC_TO_TESSERACT[lang] ?? "eng";
}

/** Sharp preproc+ two-pass tesseract (eng sample → detected language). */
async function ocrImageBuffer(buffer: Buffer): Promise<{ text: string; confidence: number }> {
  const processedBuffer = await sharp(buffer).grayscale().normalize().sharpen().toBuffer();

  // First pass: quick scan with 'eng' to get enough text for language detection
  const detectionWorker = await createWorker("eng");
  const { data: sampleData } = await detectionWorker.recognize(processedBuffer);
  await detectionWorker.terminate();

  const tessLang = detectLanguage(sampleData.text);
  let text = sampleData.text;
  let confidence = sampleData.confidence;

  // Second pass: only if a non-English language was detected
  if (tessLang !== "eng") {
    try {
      const fullWorker = await createWorker(tessLang);
      const { data } = await fullWorker.recognize(processedBuffer);
      await fullWorker.terminate();
      text = data.text;
      confidence = data.confidence;
    } catch {
      // Language model unavailable — keep first-pass result
      logger.warn({ tessLang }, "language model unavailable, using eng result");
    }
  }
  return { text, confidence };
}

// PDF handling: digital PDFs carry a text layer pdfjs extracts directly (no
// OCR, no rasterizing); image-only scans are rendered page-by-page through
// `canvas` (node-canvas/Cairo) into the tesseract pipeline.
//
// FIX (root-caused 2026-08-28): this used to render through @napi-rs/canvas,
// whose native (Rust/Skia) renderer segfaults — a true OS-level crash, not a
// catchable JS exception — on PDFs using a CMYK axial-gradient shading (the
// `sh` operator against a ShadingType 2 /DeviceCMYK resource), which is
// exactly what real letterhead artwork commonly contains. Reproduced
// directly: the same PDF, same pdfjs-dist version, rendered cleanly once the
// canvas binding was swapped to `canvas` (node-canvas) instead. Since a
// segfault kills the process below the V8/libuv layer, no try/catch here or
// uncaughtException/unhandledRejection handler in main.ts/bin/worker.ts could
// ever have caught it — do not swap this back to @napi-rs/canvas.
const PDF_TEXT_LAYER_MIN_CHARS = 100; // below this, treat as a scan
const PDF_MAX_TEXT_PAGES = 200;
const PDF_MAX_OCR_PAGES = 10; // rasterized OCR is expensive — cap it
// Guard against pathological page dimensions blowing up the rasterized
// canvas allocation (width*height*4 bytes) regardless of which native canvas
// library is in use.
const PDF_MAX_OCR_PIXELS = 30_000_000; // ~30MP, well above any print-quality A4/A3 page at scale 2

async function extractPdf(buffer: Buffer): Promise<{ text: string; confidence: number }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  try {
    let layerText = "";
    const textPages = Math.min(doc.numPages, PDF_MAX_TEXT_PAGES);
    for (let i = 1; i <= textPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      layerText += tc.items.map((it: any) => it.str ?? "").join(" ") + "\n";
      page.cleanup();
    }
    if (layerText.replace(/\s+/g, "").length >= PDF_TEXT_LAYER_MIN_CHARS) {
      // Digital text layer — exact extraction, not recognition.
      return { text: layerText.trim(), confidence: 99 };
    }

    // Image-only scan: rasterize and OCR the first PDF_MAX_OCR_PAGES pages.
    const { createCanvas } = await import("canvas");
    const parts: string[] = [];
    let confidenceSum = 0;
    const ocrPages = Math.min(doc.numPages, PDF_MAX_OCR_PAGES);
    for (let i = 1; i <= ocrPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (width * height > PDF_MAX_OCR_PIXELS) {
        logger.warn({ page: i, width, height }, "pdf page exceeds OCR raster pixel cap — skipping page");
        page.cleanup();
        continue;
      }
      const canvas = createCanvas(width, height);
      const canvasContext = canvas.getContext("2d");
      await page.render({ canvasContext, viewport, canvas } as any).promise;
      const pageResult = await ocrImageBuffer(canvas.toBuffer("image/png"));
      parts.push(pageResult.text);
      confidenceSum += pageResult.confidence;
      page.cleanup();
    }
    return {
      text: parts.join("\n\n").trim(),
      confidence: ocrPages > 0 ? confidenceSum / ocrPages : 0,
    };
  } finally {
    await doc.destroy();
  }
}

export async function createOCRWorker() {
  const connection = getRedis();
  if (!connection) return;

  const worker = new Worker(
    "OCR_PROCESSING",
    async (job: Job) => {
      const { documentId, versionId, tenantId, correlationId } = job.data;
      const logCtx = { documentId, versionId, correlationId };
      logger.info(logCtx, "starting ocr processing");
      const stopTimer = ocrProcessingDuration.startTimer();
      // Same fallback as emitOcrCompleted above: wrap DB writes in tenant
      // context when the job carries one, run unwrapped otherwise.
      const inTenantCtx = <T>(fn: () => Promise<T>): Promise<T> =>
        tenantId ? withWorkerTenantContext(tenantId, fn) : fn();

      try {
        const version = await DocumentVersion.findByPk(versionId);
        if (!version) throw new Error("Document version not found");
        await inTenantCtx(() => Document.update({ ocrStatus: "PROCESSING" }, { where: { id: documentId } }));

        // Decrypt the document from storage (handles both local and MinIO backends)
        const plaintextBuffer = await fetchAndDecrypt(version.storageKey, versionId);

        // Detect actual MIME type from content (not from version.mimeType which could be spoofed)
        const detected = await fileTypeFromBuffer(plaintextBuffer);
        const mime = detected?.mime ?? version.mimeType ?? "application/octet-stream";

        let text: string;
        let confidence: number;

        if (mime === "application/pdf") {
          // Digital PDFs: exact text-layer extraction. Image-only scans:
          // rasterize (capped page count) into the tesseract pipeline.
          ({ text, confidence } = await extractPdf(plaintextBuffer));
        } else if (mime.startsWith("image/")) {
          ({ text, confidence } = await ocrImageBuffer(plaintextBuffer));
        } else {
          logger.warn({ ...logCtx, mime }, "unsupported MIME type for OCR — skipping");
          await recordOcrOutcome("unsupported");
          stopTimer({ outcome: "unsupported" });
          await inTenantCtx(() => Document.update({ ocrStatus: "OCR_UNSUPPORTED" }, { where: { id: documentId } }));
          await emitOcrCompleted(documentId, "OCR_UNSUPPORTED", tenantId);
          return;
        }

        const finalOcrStatus = confidence < 70 ? "LOW_CONFIDENCE" : "COMPLETED";
        await recordOcrOutcome(finalOcrStatus === "LOW_CONFIDENCE" ? "low_confidence" : "completed");
        stopTimer({ outcome: finalOcrStatus === "LOW_CONFIDENCE" ? "low_confidence" : "completed" });
        await inTenantCtx(async () => {
          // document_versions carries no RLS (unlike documents), so this write
          // doesn't strictly need tenant context — grouped here anyway since
          // it's a fast, adjacent write with nothing slow in between.
          await version.update({ extractedText: text });
          await Document.update(
            {
              ocrStatus: finalOcrStatus,
              ocrConfidenceScore: confidence,
            },
            { where: { id: documentId } }
          );
        });
        await emitOcrCompleted(documentId, finalOcrStatus, tenantId);

        // Enqueue AI jobs if API key is configured and text is sufficient
        // Same provider test the on-demand routes use (llmClient.resolveProvider): any of the four
        // supported providers, not only the Anthropic keys.
        if (isAiConfigured() && text && text.trim().length >= 50) {
          const redis = getRedis();
          if (redis) {
            const aiQueue = new Queue("AI_PROCESSING", { connection: redis });
            attachErrorLogger(aiQueue, "AI_PROCESSING");
            // FIX: no jobId meant a retried OCR job that had already reached
            // this point on a prior attempt would enqueue duplicate AI jobs
            // — double AI-provider spend and duplicate DOCUMENT_UPDATED
            // audit rows. jobId is deterministic per (document, version,
            // operation), matching the dedupe pattern OCR/SEARCH_INDEX
            // already use in outbox.ts.
            await Promise.all([
              aiQueue.add(
                "summarize",
                { documentId, versionId, tenantId, correlationId, operation: "AI_SUMMARIZE" },
                { jobId: `${versionId}:summarize` },
              ),
              aiQueue.add(
                "extract",
                { documentId, versionId, tenantId, correlationId, operation: "AI_EXTRACT_METADATA" },
                { jobId: `${versionId}:extract` },
              ),
            ]);
            await aiQueue.close();
          }
        }

        logger.info({ ...logCtx, confidence, mime }, "ocr processing completed");
      } catch (error) {
        await recordOcrOutcome("failed");
        stopTimer({ outcome: "failed" });
        logger.error({ error, ...logCtx }, "ocr processing failed");
        await inTenantCtx(() => Document.update({ ocrStatus: "FAILED" }, { where: { id: documentId } }));
        await emitOcrCompleted(documentId, "FAILED", tenantId);
        throw error;
      }
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err, correlationId: job?.data?.correlationId }, "ocr worker job failed");
    reportJobFailure("OCR_PROCESSING", err, job?.id);
  });
  // The actual crash fix — see queues.ts's attachErrorLogger for why this is
  // not optional. This exact gap took the whole API process down mid-OCR-job.
  attachErrorLogger(worker, "OCR_PROCESSING");

  // Drain the backlog that accumulated while PDF OCR was unimplemented:
  // every PDF hit the old "mark PDF_PENDING and return" branch, and those
  // rows have no outbox/queue entry left to retry them. Re-enqueue once at
  // worker boot (deterministic jobIds make repeat boots idempotent).
  void (async () => {
    try {
      // startWorkers() runs BEFORE initModels()/connectDB() in bootstrap()
      // (main.ts), so without this the very first thing this sweep touches is
      // an uninitialized model and Sequelize throws "Cannot convert undefined
      // or null to object" out of Model.findAll. It was caught and logged as
      // "will retry next worker boot" — but every boot has the same ordering,
      // so the backlog was never actually drained on any of them. Both calls
      // are idempotent (socket.ts does the same for the same reason).
      initModels();
      await connectDB();
      const pending = await Document.findAll({
        where: { ocrStatus: "PDF_PENDING" },
        attributes: ["id", "latestVersionId"],
        limit: 500,
      });
      if (pending.length === 0) return;
      const queue = new Queue("OCR_PROCESSING", { connection });
      attachErrorLogger(queue, "OCR_PROCESSING");
      for (const doc of pending) {
        if (!doc.latestVersionId) continue;
        await queue.add(
          "ocr",
          { documentId: doc.id, versionId: doc.latestVersionId },
          { jobId: `${doc.latestVersionId}:pdf-pending-requeue` },
        );
      }
      await queue.close();
      logger.info({ count: pending.length }, "requeued PDF_PENDING documents for OCR");
    } catch (err) {
      logger.warn({ err }, "PDF_PENDING requeue sweep failed (will retry next worker boot)");
    }
  })();

  return worker;
}
