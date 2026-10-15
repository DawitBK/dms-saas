import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { franc } from 'franc';
import { logger } from '../core/logger.js';

// Mirrors infrastructure/queue/workers/OCRWorker.ts's FRANC_TO_TESSERACT —
// kept as a separate copy (not imported) since that file is a queue worker
// module with its own DB/BullMQ wiring, not a shared utility; this map is
// the only piece of it this file needs. Keep both in sync if a language is
// ever added there.
const FRANC_TO_TESSERACT: Record<string, string> = {
  eng: 'eng',
  amh: 'amh',
  fra: 'fra',
  deu: 'deu',
  spa: 'spa',
  por: 'por',
  ara: 'ara',
  zho: 'chi_sim',
  jpn: 'jpn',
  kor: 'kor',
};

function detectTesseractLanguage(text: string): string {
  if (!text || text.length < 20) return 'eng';
  const lang = franc(text, { minLength: 10 });
  return FRANC_TO_TESSERACT[lang] ?? 'eng';
}

/**
 * Perform optical character recognition on an image buffer. Returns the
 * extracted text string.
 *
 * Two-pass, same strategy as OCRWorker.ts's document-indexing OCR: a form
 * this function reads (the "Build from a photo or PDF" fallback, used when
 * vision extraction is unavailable/fails) is just as likely to be printed in
 * Amharic as English — Tesseract's 'eng' model reads Amharic (Ge'ez script)
 * as near-total garbage, which silently produced empty/useless OCR text for
 * every Amharic form. A quick 'eng' pass gets enough Latin-script sample
 * text to run franc's language detection; if that comes back non-English,
 * a second pass re-recognizes the whole image with the detected language's
 * own Tesseract model instead.
 */
export async function ocrImage(buffer: Buffer): Promise<string> {
  try {
    const processedBuffer = await sharp(buffer)
      .grayscale()
      .normalize()
      .sharpen()
      .toBuffer();

    const detectionWorker = await createWorker('eng');
    const { data: sampleData } = await detectionWorker.recognize(processedBuffer);
    await detectionWorker.terminate();

    const tessLang = detectTesseractLanguage(sampleData?.text ?? '');
    if (tessLang === 'eng') {
      return sampleData?.text ?? '';
    }

    try {
      const fullWorker = await createWorker(tessLang);
      const { data } = await fullWorker.recognize(processedBuffer);
      await fullWorker.terminate();
      return data?.text ?? '';
    } catch (err) {
      // Language model unavailable (e.g. not downloaded/cached yet) — the
      // 'eng' sample is a poor but non-empty fallback rather than nothing.
      logger.warn({ err: err instanceof Error ? err.message : err, tessLang }, '[ocr] detected-language model unavailable, using eng pass result');
      return sampleData?.text ?? '';
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[ocr] OCR processing failed');
    return '';
  }
}
