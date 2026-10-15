// PAdES flattened-copy generation for completed e-sign ceremonies.
//
// When every recipient has signed, the ceremony's document gets a new,
// third-party-verifiable version: the original PDF with each signed field
// flattened onto its page, a certificate-of-completion page appended, and a
// PAdES byte-range digital signature embedded using the organization's
// PKCS#12 certificate (config ESIGN_P12_B64 / ESIGN_P12_PASSPHRASE — generate
// a self-signed one with scripts/generate-esign-cert.js, or provision a real
// org cert). Adobe/other viewers then show the standard signature panel.
//
// DMS's own detached PKI record (signing.service.ts) remains the internal
// authenticity source; this copy exists for the world outside DMS.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { config } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';

export type PadesField = {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: 'signature' | 'initial' | 'date' | 'text' | 'seal';
  value: string | null;
};

export type PadesSigner = {
  name: string;
  email: string;
  signedAt: Date | null;
  ipAddress: string | null;
};

export function padesConfigured(): boolean {
  return Boolean(config.ESIGN_P12_B64);
}

// ── Non-Latin text (Amharic/Ge'ez signer names, typed fields) ───────────────
//
// The standard Helvetica font only encodes WinAnsi, so an Amharic name used to be
// degraded to "????" in the signed legal copy (and, before that, made pdf-lib throw and
// abort the flatten). The Noto Sans Ethiopic font the letters module already ships is
// embedded (subset, lazily: Latin-only documents pay nothing) and text is drawn in runs:
// every character Helvetica can encode stays in Helvetica, the rest in Ethiopic, and only
// a character neither font has falls back to '?'.

let ethiopicBytesCache: Buffer | null | undefined;
function loadEthiopicRegularBytes(): Buffer | null {
  if (ethiopicBytesCache !== undefined) return ethiopicBytesCache;
  for (const dir of [path.resolve(process.cwd(), 'assets/fonts'), path.resolve(process.cwd(), 'backend/assets/fonts')]) {
    const file = path.join(dir, 'NotoSansEthiopic-Regular.ttf');
    if (fs.existsSync(file)) {
      ethiopicBytesCache = fs.readFileSync(file);
      return ethiopicBytesCache;
    }
  }
  logger.warn('[pades] Noto Sans Ethiopic font not found - non-Latin text in signed copies will degrade to "?"');
  ethiopicBytesCache = null;
  return null;
}

function canEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Draws mixed-script text starting at x, advancing run by run. Never throws on an unencodable character. */
class MixedTextDrawer {
  private unicode: Promise<PDFFont | null> | undefined;
  constructor(private readonly pdf: PDFDocument, private readonly latin: PDFFont) {}

  private loadUnicode(): Promise<PDFFont | null> {
    this.unicode ??= (async () => {
      const bytes = loadEthiopicRegularBytes();
      if (!bytes) return null;
      try {
        this.pdf.registerFontkit(fontkit);
        return await this.pdf.embedFont(bytes, { subset: true });
      } catch (err) {
        logger.warn({ err }, '[pades] could not embed the Ethiopic font');
        return null;
      }
    })();
    return this.unicode;
  }

  async draw(page: PDFPage, text: string, opts: { x: number; y: number; size: number; color?: ReturnType<typeof rgb>; font?: PDFFont }): Promise<void> {
    const latin = opts.font ?? this.latin;
    // Fast path: everything the Latin font encodes.
    if (canEncode(latin, text)) {
      page.drawText(text, { x: opts.x, y: opts.y, size: opts.size, font: latin, color: opts.color });
      return;
    }
    const unicode = await this.loadUnicode();
    let x = opts.x;
    let run = '';
    let runFont: PDFFont | null = null;
    const flush = () => {
      if (!run || !runFont) return;
      page.drawText(run, { x, y: opts.y, size: opts.size, font: runFont, color: opts.color });
      x += runFont.widthOfTextAtSize(run, opts.size);
      run = '';
    };
    for (const ch of Array.from(text)) {
      let font: PDFFont;
      let piece = ch;
      if (canEncode(latin, ch)) font = latin;
      else if (unicode && canEncode(unicode, ch)) font = unicode;
      else { font = latin; piece = '?'; }
      if (font !== runFont) { flush(); runFont = font; }
      run += piece;
    }
    flush();
  }
}

/** DocumentVersion.changeSummary marker for a filed PAdES-signed copy — lives
 *  here (a leaf module both esigning.service.ts and documents.service.ts
 *  already import) rather than in esigning.service.ts itself, so
 *  documents.service.ts's download route can recognize/strip the
 *  certificate-of-completion page without a circular import (esigning.service.ts
 *  already imports from documents.service.ts). */
export const PADES_CHANGE_SUMMARY = 'E-sign: PAdES-signed flattened copy (certificate of completion appended)';

// FIX 2026-09-14: filePadesSignedCopy (esigning.service.ts) used to skip
// filing ANY new version whenever ESIGN_P12_B64 wasn't configured — meaning
// the ceremony's own recipient/request rows said "signed"/"completed" while
// the actual document a viewer opens never changed at all: no version bump,
// no visible signature anywhere, ever (reproduced live — a fully-signed
// document still showed only its original, unsigned pages). This marker
// lets that same function file the plain flattened copy
// (generateFlattenedUnsignedPdf below — visible signature marks, no
// certificate-of-completion page, no PAdES envelope) as the new version
// instead of filing nothing, so "signed" always means something changed in
// the file itself, with or without a certificate configured.
export const FLATTENED_CHANGE_SUMMARY = 'E-sign: flattened signed copy (no digital signing certificate configured)';

/**
 * Step 1 shared by generatePadesSignedPdf and generateFlattenedUnsignedPdf:
 * draw every signed field's value onto its page of an already-loaded
 * PDFDocument, in place. Split out so a caller that wants the flattened
 * signature marks WITHOUT the certificate-of-completion page or the PAdES
 * signature (see generateFlattenedUnsignedPdf below) can run this step
 * alone instead of duplicating it.
 */
async function flattenSignedFields(
  pdf: import('pdf-lib').PDFDocument,
  font: import('pdf-lib').PDFFont,
  fields: PadesField[],
  requestId: string,
  drawer: MixedTextDrawer = new MixedTextDrawer(pdf, font),
): Promise<void> {
  // ── 1. Flatten each signed field onto its page ──
  // FIX: field.x/y are NOT raw top-left browser click coordinates — the
  // field-placer (PdfFieldPlacer.tsx onPageClick) already converts the click
  // into pdf-lib's bottom-up space itself:
  //   y = nativeSize.height - clickYpx/scale - fieldHeight
  // i.e. field.y IS the field box's bottom-left y in bottom-up points,
  // ready to pass straight to drawImage/drawText. This function used to flip
  // it AGAIN ("yTop = page.getHeight() - field.y", then "yTop - field.height"),
  // a double transform that mirrors the stamp to the wrong vertical position
  // (verified: it algebraically collapses to the ORIGINAL top-down click
  // distance being reused as a bottom-up coordinate — the two are only equal
  // at the vertical center of the page, so anywhere else the stamp lands far
  // from where the field was actually placed). No transform needed here —
  // the frontend already did it.
  for (const field of fields) {
    if (!field.value) continue;
    const pageIndex = Math.max(0, (field.pageNumber || 1) - 1);
    if (pageIndex >= pdf.getPageCount()) continue;
    const page = pdf.getPage(pageIndex);

    if (field.value.startsWith('data:image')) {
      try {
        const [meta, b64] = field.value.split(',', 2);
        const bytes = Buffer.from(b64 ?? '', 'base64');

        // FIX: this is a base64 payload decoded straight to bytes and
        // embedded into a filed legal document — every other binary that
        // ends up in a document (uploads, form attachments, letters) goes
        // through scanBuffer first; this one didn't. A real detected virus
        // throws (caught below, falls back to the text placeholder instead
        // of embedding it); "unscanned" is fail-open like everywhere else,
        // just logged so it's visible rather than silent.
        const avResult = await scanBuffer(bytes);
        if (avResult === 'unscanned') {
          logger.warn({ requestId }, '[pades] signature-field image could not be scanned — embedding unscanned (fail-open, flagged)');
        }

        const img = meta?.includes('image/png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
        const scale = Math.min(field.width / img.width, field.height / img.height, 1);
        page.drawImage(img, {
          x: field.x,
          y: field.y,
          width: img.width * scale,
          height: img.height * scale,
        });
      } catch (err) {
        logger.warn({ err, requestId }, '[pades] field image unreadable — flattening as text');
        page.drawText('[signed]', { x: field.x, y: field.y, size: 10, font });
      }
    } else {
      const size = Math.min(12, Math.max(8, field.height - 4));
      // A typed name or text field in a non-WinAnsi script (Amharic/Ge'ez, ...) made pdf-lib THROW
      // on the standard font, which used to abort the whole flatten (the ceremony was "completed"
      // but its signed copy was never filed) and, once guarded, printed "????". The drawer renders
      // Ethiopic with the embedded Noto font and never throws.
      await drawer.draw(page, field.value.slice(0, 200), {
        x: field.x, y: field.y + (field.height - size) / 2, size, color: rgb(0.1, 0.1, 0.35),
      });
    }
  }
}

/**
 * Flatten signed fields onto the original PDF — no certificate-of-completion
 * page, no PAdES signature. This is what a viewer sees on the pages that
 * were actually signed (the drawn signature/date/text marks) without the
 * appended proof-of-ceremony page generatePadesSignedPdf always adds.
 *
 * Deliberately generated on demand rather than stored as its own document
 * version: the PAdES-signed copy (generatePadesSignedPdf's output) is the
 * one and only version filed after a ceremony completes (filePadesSignedCopy),
 * and its bytes can never be edited afterward without invalidating the
 * embedded signature — so there is nowhere to durably persist a
 * cert-free-but-flattened variant without either breaking that invariant or
 * filing a second, confusingly redundant version. The inputs it needs
 * (the pre-ceremony original + the SignatureField rows) are already
 * permanently on file, so re-flattening at download time is cheap and
 * exactly reproducible.
 */
export async function generateFlattenedUnsignedPdf(input: {
  originalPdf: Buffer;
  fields: PadesField[];
  requestId: string;
}): Promise<Buffer> {
  const pdf = await PDFDocument.load(input.originalPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  await flattenSignedFields(pdf, font, input.fields, input.requestId);
  return Buffer.from(await pdf.save());
}

/**
 * Flatten signed fields + append a certificate page + embed a PAdES
 * byte-range signature. Returns the signed PDF bytes.
 */
export async function generatePadesSignedPdf(input: {
  originalPdf: Buffer;
  fields: PadesField[];
  signers: PadesSigner[];
  requestId: string;
  requestTitle: string;
}): Promise<Buffer> {
  if (!config.ESIGN_P12_B64) {
    throw new Error('ESIGN_P12_B64 is not configured');
  }

  const pdf = await PDFDocument.load(input.originalPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const drawer = new MixedTextDrawer(pdf, font);
  await flattenSignedFields(pdf, font, input.fields, input.requestId, drawer);

  // ── 2. Certificate-of-completion page ──
  const cert = pdf.addPage();
  const W = cert.getWidth();
  let y = cert.getHeight() - 64;
  const certLines: Array<() => Promise<void>> = [];
  const line = (text: string, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const atY = y;
    certLines.push(() => drawer.draw(cert, text, {
      x: 56, y: atY, size: opts.size ?? 10, font: opts.bold ? bold : font, color: opts.color ?? rgb(0.15, 0.15, 0.15),
    }));
    y -= (opts.size ?? 10) + 8;
  };
  line('CERTIFICATE OF COMPLETION', { bold: true, size: 16, color: rgb(0.12, 0.29, 0.17) });
  y -= 6;
  cert.drawLine({ start: { x: 56, y: y + 10 }, end: { x: W - 56, y: y + 10 }, thickness: 1, color: rgb(0.12, 0.29, 0.17) });
  y -= 8;
  line(`Signature request: ${input.requestTitle}`);
  line(`Request ID: ${input.requestId}`);
  line(`Original document SHA-256: ${crypto.createHash('sha256').update(input.originalPdf).digest('hex')}`);
  y -= 10;
  line('Signed by:', { bold: true, size: 11 });
  for (const signer of input.signers) {
    line(
      `• ${signer.name} <${signer.email}> — signed ${signer.signedAt ? signer.signedAt.toISOString() : 'n/a'}${
        signer.ipAddress ? ` from ${signer.ipAddress}` : ''
      }`,
    );
  }
  y -= 10;
  line('This document carries an embedded PAdES digital signature. Open the', { size: 8, color: rgb(0.4, 0.4, 0.4) });
  line('signature panel in a PDF viewer to verify integrity and signing identity.', { size: 8, color: rgb(0.4, 0.4, 0.4) });
  for (const draw of certLines) await draw();

  // ── 3. PAdES byte-range signature ──
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    reason: `DMS e-sign ceremony ${input.requestId} completed by all recipients`,
    contactInfo: input.signers[0]?.email ?? 'edams',
    name: 'DMS',
    location: 'Example Corp DMS',
  });
  const withPlaceholder = Buffer.from(await pdf.save({ useObjectStreams: false }));

  const signer = new P12Signer(Buffer.from(config.ESIGN_P12_B64, 'base64'), {
    passphrase: config.ESIGN_P12_PASSPHRASE ?? '',
  });
  return new SignPdf().sign(withPlaceholder, signer);
}
