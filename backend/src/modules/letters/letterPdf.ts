// CAMS: final-letter PDF generation (6.1.4 / 6.1.5).
//
// On final approval the system renders the letter to PDF with the allocated
// reference number, server-stamped date, signatory block, and a QR code that
// encodes the public verification URL (never the letter content). The PDF is
// then filed through the canonical document encryption pipeline.
//
// Fonts: pure-WinAnsi text renders in Helvetica (built-in, no embedding
// cost); anything beyond WinAnsi — Amharic/Ge'ez above all — renders in an
// embedded, subset Noto Sans Ethiopic (backend/assets/fonts, OFL-licensed),
// which also carries full Latin so mixed Amharic+English lines stay in one
// font. If the font assets are missing the renderer degrades to the old
// replace-with-'?' behavior rather than failing the letter's finalization.

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFDocument as PDFDocumentType, type PDFFont, type PDFEmbeddedPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { logger } from '../../core/logger.js';
import { parseLetterBody } from './letterBodyDoc.js';
import { drawLetterBodyDoc, type ImageResolver } from './letterBodyPdfRenderer.js';

export type LetterPdfInput = {
  referenceNumber: string;
  subject: string;
  bodyHtml: string | null;
  unitName: string;
  /** Per-unit masthead override (org_units.letterhead_title); the group name
   *  is the default so existing units keep rendering unchanged. */
  letterheadTitle?: string | null;
  departmentName: string | null;
  correspondent: string | null;
  correspondentOrganization: string | null;
  /** The recipient's city/country line (e.g. "Example City, Exampleland"),
   *  rendered under the "To:" addressee. Optional — absent on letters
   *  created before this field existed. */
  correspondentLocation?: string | null;
  signatoryName: string;
  signatoryTitle: string;
  /** The signature to draw above the signatory's name, as a PNG/JPEG data URL.
   *
   *  Sourced from the E-SIGNING CEREMONY that signed this letter — the mark the
   *  signatory actually drew or uploaded — falling back to their stored profile
   *  signature. Not from the profile alone: see finalizeLetterAfterSigning.
   *
   *  Null renders no signature block at all, which is correct for a letter that
   *  reaches ARCHIVED without a ceremony.
   *
   *  This is presentation, not proof. The authenticity guarantee is still the
   *  content hash plus the QR verification link, and the PAdES certificate of
   *  completion on the signed draft is still the cryptographic record. What this
   *  fixes is that the letter of RECORD — the numbered PDF that gets dispatched
   *  — used to show no signature at all even when one had been captured. */
  signatureImageDataUrl?: string | null;
  approvedAt: Date;
  confidentiality: string;
  qrUrl: string;
  /** Resolves an inline body image's stored `src` reference to its raw
   *  bytes — injected by the caller (letters.service.ts) rather than known
   *  here, since image storage is a DB/MinIO concern this module has no
   *  other reason to depend on. Omitted (or returning null for a given src)
   *  degrades that one image to "not drawn", never a failed letter. */
  resolveBodyImage?: ImageResolver;
};

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE_H = 16;

/** Strip tags + decode the handful of entities the draft editor produces.
 *
 *  Despite the name (and the field it reads, `bodyHtml`), every editor that
 *  writes this field — letters/new's compose textarea, letters/[id]'s "Edit
 *  draft" modal — is a plain `<textarea>`, never a rich-text editor. Blank
 *  lines are the only spacing/layout tool an author actually has, and used
 *  to be collapsed here (`\n{3,}` down to `\n\n`) on the theory that this was
 *  cleaning up messy real-HTML paragraph breaks. It wasn't: for THIS input,
 *  it silently threw away deliberate multi-line gaps an author typed to
 *  separate sections or push a closing block down — invisibly, since the
 *  same collapse ran in every render path (this preview, the real signable
 *  draft the signing modal shows, and the final approved letter), so there
 *  was no path where the extra spacing ever survived to be seen. Removed;
 *  the body field's own 200,000-char cap (letters.service.ts's
 *  createLetterSchema) is the existing bound on how much whitespace someone
 *  could paste in. */
export function htmlToPlainText(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ── Font handling ───────────────────────────────────────────────────────────

// WinAnsiEncoding (what pdf-lib's StandardFonts draw through) is Windows-1252,
// not plain Latin-1 -- its 0x80-0x9F byte range maps to a fixed set of
// typographic characters (curly quotes, en/em dash, ellipsis, bullet,
// trademark, etc.) at NON-contiguous Unicode code points outside 0x20-0xFF.
// Bug found live-testing this file's own output: this file's own footer
// ("... -- system-generated letter...") and header (" -- {departmentName}")
// lines both contain an em dash (U+2014) -- before this list, the plain
// 0x20-0xFF range check flagged it "outside WinAnsi", which routed the
// ENTIRE containing line through the embedded Ethiopic font instead of
// Helvetica. Ethiopic's own character set doesn't reliably cover plain
// Latin/ASCII glyphs (it's a script-specific font), so nearly the whole
// line silently degraded to a wall of '?' -- while Helvetica could already
// render the em dash correctly on its own. Values: cp1252's 0x80-0x9F range
// mapped to Unicode (the 0x81/0x8D/0x8F/0x90/0x9D gaps are genuinely
// unassigned in cp1252 and correctly excluded).
const WINANSI_EXTRA_CODEPOINTS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Whether a single character can be drawn directly via a WinAnsi
 *  (Windows-1252) standard font like Helvetica. */
function isWinAnsiChar(ch: string): boolean {
  if (ch === '\n') return true;
  const code = ch.codePointAt(0) as number;
  return (code >= 0x20 && code <= 0xff) || WINANSI_EXTRA_CODEPOINTS.has(code);
}

/** Whether ANY character in `text` needs the embedded Unicode (Ethiopic)
 *  font instead of a WinAnsi standard font. */
function hasNonWinAnsiChar(text: string): boolean {
  return Array.from(text).some((ch) => !isWinAnsiChar(ch));
}

/** Replace anything outside WinAnsi so pdf-lib's StandardFonts don't throw.
 *  Only the last-resort path when the Ethiopic font assets are missing. */
function sanitizeWinAnsi(text: string): string {
  return Array.from(text).map((ch) => (isWinAnsiChar(ch) ? ch : '?')).join('');
}


function fontsDirCandidates(): string[] {
  // cwd is backend/ for npm run dev, node dist/src/main.js, the worker, and
  // jest; the repo root when scripts run from there. (No import.meta here —
  // the jest transform can't parse it.)
  return [
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), 'backend/assets/fonts'),
  ];
}

let ethiopicBytesCache: { regular: Buffer; bold: Buffer } | null | undefined;

function loadEthiopicFontBytes(): { regular: Buffer; bold: Buffer } | null {
  if (ethiopicBytesCache !== undefined) return ethiopicBytesCache;
  for (const dir of fontsDirCandidates()) {
    const regularPath = path.join(dir, 'NotoSansEthiopic-Regular.ttf');
    const boldPath = path.join(dir, 'NotoSansEthiopic-Bold.ttf');
    if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
      ethiopicBytesCache = {
        regular: fs.readFileSync(regularPath),
        bold: fs.readFileSync(boldPath),
      };
      return ethiopicBytesCache;
    }
  }
  logger.warn(
    { candidates: fontsDirCandidates() },
    '[letterPdf] Noto Sans Ethiopic font assets not found — non-Latin text in letters will degrade to "?"'
  );
  ethiopicBytesCache = null;
  return null;
}

export type LetterFontFamily = 'Helvetica' | 'Times-Roman' | 'Courier';

type LetterFonts = {
  /** Pick the font for a piece of text and sanitize it for that font.
   *  `italic`/`family` are additive — every pre-existing call site in this
   *  file passes only `(text, bold)` and keeps working unchanged; the
   *  structured-body renderer (letterBodyPdfRenderer.ts) is the only caller
   *  that uses the 3rd/4th params, for the editor's font-family/italic
   *  formatting. Non-Latin (Ethiopic) text always renders in the Ethiopic
   *  face regardless of the requested family/italic — that embedded font
   *  has no italic variant and is the only one with Ethiopic coverage, so a
   *  family/italic request on Amharic text degrades to regular/bold rather
   *  than losing the script entirely. */
  prepare(text: string, bold?: boolean, italic?: boolean, family?: LetterFontFamily): { text: string; font: PDFFont };
};

async function embedLetterFonts(pdf: PDFDocumentType): Promise<LetterFonts> {
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const latinBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const latinItalic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const latinBoldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
  const times = await pdf.embedFont(StandardFonts.TimesRoman);
  const timesBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const timesItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const timesBoldItalic = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic);
  const courier = await pdf.embedFont(StandardFonts.Courier);
  const courierBold = await pdf.embedFont(StandardFonts.CourierBold);
  const courierItalic = await pdf.embedFont(StandardFonts.CourierOblique);
  const courierBoldItalic = await pdf.embedFont(StandardFonts.CourierBoldOblique);
  const familyVariants: Record<LetterFontFamily, [PDFFont, PDFFont, PDFFont, PDFFont]> = {
    Helvetica: [latin, latinBold, latinItalic, latinBoldItalic],
    'Times-Roman': [times, timesBold, timesItalic, timesBoldItalic],
    Courier: [courier, courierBold, courierItalic, courierBoldItalic],
  };
  const pickLatinFont = (bold: boolean, italic: boolean, family: LetterFontFamily): PDFFont => {
    const [reg, b, i, bi] = familyVariants[family];
    return bold && italic ? bi : bold ? b : italic ? i : reg;
  };

  const bytes = loadEthiopicFontBytes();
  let ethiopic: PDFFont | null = null;
  let ethiopicBold: PDFFont | null = null;
  let ethiopicCharset: Set<number> | null = null;
  if (bytes) {
    pdf.registerFontkit(fontkit);
    // subset:true keeps the letter PDF small — only glyphs actually drawn are
    // embedded, so Latin-only letters pay nothing for Ethiopic coverage.
    ethiopic = await pdf.embedFont(bytes.regular, { subset: true });
    ethiopicBold = await pdf.embedFont(bytes.bold, { subset: true });
    ethiopicCharset = new Set(ethiopic.getCharacterSet());
  }

  return {
    prepare(text: string, bold = false, italic = false, family: LetterFontFamily = 'Helvetica') {
      // FIX (live 500, 2026-09-22): a literal tab character has no glyph in
      // EITHER font pdf-lib embeds here — Helvetica/WinAnsi rejects it
      // outright (`Encoding.encodeUnicodeCodePoint` throws "WinAnsi cannot
      // encode \"\t\"", uncaught, crashing the whole preview/finalize
      // request with a 500), and the embedded Ethiopic font has no tab glyph
      // either despite the old code assuming it did (same class of bug, just
      // never hit because the crash upstream always fired first). Tabs reach
      // here routinely: pasting a Word/Excel table into the Body field's
      // plain textarea is the single most common way an author ends up with
      // literal tab-separated cells in the stored text. Normalizing to
      // spaces BEFORE either font-routing branch below means neither one
      // ever has to know tabs existed.
      const normalized = text.replace(/\t/g, '    ');
      if (!hasNonWinAnsiChar(normalized) || !ethiopic || !ethiopicBold || !ethiopicCharset) {
        return { text: sanitizeWinAnsi(normalized), font: pickLatinFont(bold, italic, family) };
      }
      // Route the whole string through the Unicode font (it carries Latin
      // too, so mixed lines keep a single consistent face); replace only the
      // rare characters even it can't encode.
      const sanitized = Array.from(normalized)
        .map((ch) => (ethiopicCharset.has(ch.codePointAt(0) as number) || ch === '\n' ? ch : '?'))
        .join('');
      return { text: sanitized, font: bold ? ethiopicBold : ethiopic };
    },
  };
}

// ── Letterhead artwork ──────────────────────────────────────────────────────
//
// forms.service.ts's generateFormPdf gained the real branded Example Corp
// Group letterhead PDF (backend/assets/letterheads) as an optional base
// file for forms; letters previously only ever drew a plain text "EXAMPLE CORP
// GROUP" masthead here. Embedding the same artwork as every letter page's
// background makes a downloaded/filed letter and a downloaded/filed form
// look like they came off the same branded letterhead paper, not two
// different systems.
//
// Bands measured directly off the asset (overlaid a 10mm ruler): the header
// banner ends at 60mm from the top, the footer band (QR icon + contact
// block) starts at ~258mm — kept in exact sync with forms/schema.ts's
// Y_START_LETTERHEAD/Y_MAX_LETTERHEAD (same asset, same measurement), with
// 5mm clearance kept on each side so drawn content never touches the artwork.
const MM_TO_PT = 2.834645669291339;
const LETTERHEAD_TOP_MM = 65;
const LETTERHEAD_BOTTOM_MM = 253;
/** y (from the page bottom, pdf-lib's coordinate origin) where drawn content may start. */
const LETTERHEAD_START_Y = PAGE_H - LETTERHEAD_TOP_MM * MM_TO_PT;
/** y (from the page bottom) below which drawn content must never go. */
const LETTERHEAD_BOTTOM_LIMIT_Y = PAGE_H - LETTERHEAD_BOTTOM_MM * MM_TO_PT;

function letterheadAssetCandidates(): string[] {
  // Mirrors fontsDirCandidates() above and forms.service.ts's own
  // near-identical helper — cwd is backend/ for npm run dev, node
  // dist/src/main.js, the worker, and jest; the repo root when scripts run
  // from there.
  return [
    path.resolve(process.cwd(), 'assets/letterheads/examplecorp-group-letterhead.pdf'),
    path.resolve(process.cwd(), 'backend/assets/letterheads/examplecorp-group-letterhead.pdf'),
  ];
}

let letterheadBytesCache: Buffer | null | undefined;

function loadLetterheadBytes(): Buffer | null {
  if (letterheadBytesCache !== undefined) return letterheadBytesCache;
  const assetPath = letterheadAssetCandidates().find((p) => fs.existsSync(p));
  if (!assetPath) {
    logger.warn(
      { candidates: letterheadAssetCandidates() },
      '[letterPdf] Example Corp letterhead asset not found — letters will render with a plain text masthead instead',
    );
    letterheadBytesCache = null;
    return null;
  }
  letterheadBytesCache = fs.readFileSync(assetPath);
  return letterheadBytesCache;
}

/** Embeds the real letterhead artwork for THIS pdf-lib document (an embedded
 *  page is only valid within the document it was embedded into, so this
 *  can't be cached across calls the way the raw bytes are). Returns null —
 *  meaning "draw the plain text masthead instead" — for a unit that has its
 *  OWN masthead override (org_units.letterhead_title, e.g. a sister
 *  company): branding a subsidiary's official correspondence with the
 *  parent group's letterhead would misrepresent whose letterhead it is, so
 *  only units using the default Example Corp identity get the artwork.
 *  Also degrades to null (never throws) if the asset is missing or corrupt —
 *  a missing image must never block a letter's finalization. */
async function embedLetterheadArtwork(
  pdf: PDFDocumentType,
  letterheadTitle: string | null | undefined,
): Promise<PDFEmbeddedPage | null> {
  if (letterheadTitle?.trim()) return null;
  const bytes = loadLetterheadBytes();
  if (!bytes) return null;
  try {
    const [embedded] = await pdf.embedPdf(bytes);
    return embedded;
  } catch (err) {
    logger.warn({ err }, '[letterPdf] Failed to embed Example Corp letterhead artwork — falling back to plain text masthead');
    return null;
  }
}

/** Layout numbers for the page's top masthead / bottom QR-footer, chosen per
 *  page depending on whether it's carrying the real branded artwork
 *  background or the plain text masthead. Non-artwork values are exactly
 *  the original hardcoded numbers this file always used (zero behavior
 *  change for a sister-company/override letter, or if the asset is ever
 *  missing); artwork values keep every drawn element inside the safe zone
 *  measured above so nothing overlaps the artwork's own header/footer bands. */
function resolveLetterLayout(hasArtwork: boolean) {
  const qrSize = hasArtwork ? 84 : 90;
  if (!hasArtwork) {
    return {
      startY: PAGE_H - MARGIN,
      lineBreakY: MARGIN + 120,
      sigBreakY: MARGIN + 170,
      qrSize,
      qrY: MARGIN,
      captionY: MARGIN - 12,
    };
  }
  // Caption line (scan hint + reference footnote) sits directly ABOVE the QR
  // — unlike the non-artwork layout, which tucks it below into the outer
  // margin strip, that space is occupied by the artwork's own footer band here.
  const captionY = LETTERHEAD_BOTTOM_LIMIT_Y + qrSize + 6;
  return {
    startY: LETTERHEAD_START_Y,
    lineBreakY: captionY + 24,
    sigBreakY: captionY + 70,
    qrSize,
    qrY: LETTERHEAD_BOTTOM_LIMIT_Y,
    captionY,
  };
}

/**
 * Embed a captured signature-field image, or return null if it is not one.
 *
 * A signature field's captured value is NOT guaranteed to be an image: a
 * ceremony can record a typed name, and the verifiers record plain marker text.
 * Anything that is not a real raster image is skipped rather than drawn, so a
 * typed signature simply falls through to the name/title lines instead of
 * corrupting the PDF.
 *
 * FIX 2026-09-15: was png|jpe?g-only, decoded straight into pdf-lib's
 * embedPng/embedJpg — the same narrow-format bug already fixed for the
 * profile signature-image upload (users.service.ts) and the forms/bundle
 * image-embed paths. pdf-lib has no native WEBP/GIF decoder, so this widens
 * the accepted regex to match and re-encodes through sharp (already a project
 * dependency) to a canonical PNG buffer before ever calling embedPng — the
 * capture route (esigning.routes.ts's signDocument, including the
 * unauthenticated access-token signer) has no format validation of its own,
 * so a WEBP/GIF capture used to reach here, fail the old regex, and file the
 * finalized, reference-numbered letter with NO signature block at all —
 * silently, per the "never throws" contract below.
 *
 * Never throws. A malformed capture must not be able to stop a letter being
 * finalized — the reference number has already been allocated by then, and it is
 * gap-free and irreversible, so failing here would burn a number.
 */
async function embedSignatureImage(pdf: PDFDocument, dataUrl: string) {
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
    const pngBytes = await sharp(bytes).png().toBuffer();
    return await pdf.embedPng(pngBytes);
  } catch {
    return null;
  }
}

/** Word-wraps `text` to `maxWidth`, preserving whitespace exactly as typed —
 *  most importantly, LEADING spaces (an indent) and any interior run of more
 *  than one space (used to space words apart on a line). The previous
 *  version (`text.split(/\s+/).filter(Boolean)`, words rejoined with a
 *  single space) collapsed every run of whitespace to one space and dropped
 *  leading whitespace outright (`.filter(Boolean)` drops the empty string a
 *  leading space produces) — invisibly, since every caller in this file
 *  (drawWrapped, drawInlineLabel) routes body/subject/recipient text through
 *  this function. The plain `<textarea>` the Body field actually is (despite
 *  being named bodyHtml — see htmlToPlainText's own comment) gives an author
 *  no other way to indent or space out a line, so this was silently
 *  discarding the only formatting tool they had, in every rendered letter.
 *
 *  Tokenizes into words and whitespace runs rather than splitting on
 *  whitespace, so nothing is collapsed while accumulating a line; only a
 *  run of spaces that is itself the reason a line doesn't fit gets trimmed
 *  (a wrapped line has no visible reason to end mid-space, and dropping it
 *  keeps this content-preserving change from ever making a line WIDER than
 *  the old behavior would have). */
function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const tokens = text.match(/\S+|[ \t]+/g) ?? [];
  if (!tokens.length) return [''];
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current + token;
    // Always accept into an empty `current` — otherwise a leading indent
    // wider than maxWidth on its own (pathological, but possible) would
    // vanish rather than just overflow, and a single word wider than
    // maxWidth needs somewhere to go, same as the original algorithm.
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current.replace(/[ \t]+$/, ''));
    current = /^[ \t]+$/.test(token) ? '' : token;
  }
  if (current) lines.push(current.replace(/[ \t]+$/, ''));
  return lines.length ? lines : [''];
}

export async function generateLetterPdf(input: LetterPdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const fonts = await embedLetterFonts(pdf);
  const artwork = await embedLetterheadArtwork(pdf, input.letterheadTitle);
  const layout = resolveLetterLayout(Boolean(artwork));

  const qrPng = await QRCode.toBuffer(input.qrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  const qrImage = await pdf.embedPng(qrPng);

  const contentW = PAGE_W - MARGIN * 2;
  const drawBackground = (p: import('pdf-lib').PDFPage): void => {
    if (artwork) p.drawPage(artwork, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  };
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  drawBackground(page);
  let y = layout.startY;

  const newPage = (): void => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    drawBackground(page);
    y = layout.startY;
  };
  const drawText = (
    text: string,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    if (y < layout.lineBreakY) newPage();
    const prepared = fonts.prepare(text, opts.bold);
    page.drawText(prepared.text, {
      x: MARGIN,
      y,
      size: opts.size ?? BODY_SIZE,
      font: prepared.font,
      color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
    y -= LINE_H;
  };
  /** Bold "Label: value" on one line, wrapping continuation lines to the left
   *  margin. Label and value stay separate drawText calls (not a concatenated
   *  string) for the same reason as elsewhere in this file — fonts.prepare()
   *  picks one font per string, and the embedded Ethiopic font doesn't carry
   *  Latin glyphs, so an ASCII label concatenated onto an Amharic value would
   *  render the label as "?" characters.
   *
   *  `underlineValue`: draws a rule under the VALUE only (never the label
   *  itself) — a real Example Corp outgoing letter underlines the actual
   *  subject text, not the word "Subject". Drawn per wrapped line so a
   *  subject that wraps to two lines gets two correctly-sized rules instead
   *  of one running under the label's column on continuation lines. */
  const drawInlineLabel = (
    label: string,
    value: string,
    opts: { size?: number; underlineValue?: boolean; boldValue?: boolean } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const labelPrepared = fonts.prepare(`${label} `, true);
    const valuePrepared = fonts.prepare(value, opts.boldValue ?? true);
    const labelWidth = labelPrepared.font.widthOfTextAtSize(labelPrepared.text, size);
    page.drawText(labelPrepared.text, { x: MARGIN, y, size, font: labelPrepared.font, color: rgb(0.1, 0.1, 0.1) });
    const lines = wrapLine(valuePrepared.text, valuePrepared.font, size, Math.max(contentW - labelWidth, contentW / 3));
    lines.forEach((line, i) => {
      const x = i === 0 ? MARGIN + labelWidth : MARGIN;
      page.drawText(line, { x, y, size, font: valuePrepared.font, color: rgb(0.1, 0.1, 0.1) });
      if (opts.underlineValue && line) {
        const lineWidth = valuePrepared.font.widthOfTextAtSize(line, size);
        page.drawLine({ start: { x, y: y - 2 }, end: { x: x + lineWidth, y: y - 2 }, thickness: 0.6, color: rgb(0.1, 0.1, 0.1) });
      }
      y -= LINE_H;
    });
  };
  /** Right-aligned to the page's content margin — used for the Ref/Date
   *  block, which sits top-right on a real Example Corp outgoing letter (see
   *  generateLetterPdf's letterhead comment). Draws at a caller-given y
   *  without touching the shared cursor, since it runs alongside the
   *  left-aligned flow rather than as part of it. */
  const drawRightAligned = (
    text: string,
    yPos: number,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const prepared = fonts.prepare(text, opts.bold);
    const width = prepared.font.widthOfTextAtSize(prepared.text, size);
    page.drawText(prepared.text, {
      x: PAGE_W - MARGIN - width, y: yPos, size, font: prepared.font, color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
  };

  // ── Letterhead ── the real branded artwork is the background (drawBackground,
  // drawn beneath everything below), so nothing else is drawn here when
  // present — no unit/department line. That line used to print "unit —
  // department" (e.g. "Head Office — Information Technology") under the
  // banner, but that's internal routing metadata (which org unit/department
  // filed this letter), never part of a real outgoing Example Corp letter —
  // confirmed against a physical sample letter, which has nothing there.
  // Falls back to the original plain-text masthead (title + rule) for a
  // unit with its own letterhead override, or if the asset is missing.
  if (!artwork) {
    const heading = fonts.prepare(input.letterheadTitle?.trim() || 'EXAMPLE CORP', true);
    page.drawText(heading.text, { x: MARGIN, y, size: 18, font: heading.font, color: rgb(0.12, 0.29, 0.17) });
    y -= 22;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.2, color: rgb(0.12, 0.29, 0.17) });
    y -= 20;
  }

  // ── Reference + date (server time, stamped at approval) ── top-right,
  // matching the physical sample letter (Ref/Date sit at the top right,
  // below a blank banner — not stacked under a unit/department line).
  // Classification is deliberately not printed here — it's an internal
  // handling marker (confidentiality routing/access, not a legal statement
  // about the letter's content) and stays in `letters.confidentiality` for
  // internal use only; a recipient outside the org has no use for it and it
  // shouldn't be visible on correspondence that leaves the building.
  drawRightAligned(`Ref: ${input.referenceNumber}`, y, { bold: true });
  drawRightAligned(`Date: ${input.approvedAt.toISOString().slice(0, 10)}`, y - LINE_H);
  y -= LINE_H * 2 + 16;

  // ── Recipient ── "To: <person>" inline (matching a real Example Corp
  // outgoing letter's addressee line — not "To:" alone on its own line),
  // with the organization/location stacked underneath it.
  if (input.correspondent || input.correspondentOrganization || input.correspondentLocation) {
    if (input.correspondent) {
      drawInlineLabel('To:', input.correspondent, { boldValue: false });
    } else {
      drawText('To:', { bold: true });
    }
    if (input.correspondentOrganization) drawText(input.correspondentOrganization);
    if (input.correspondentLocation) drawText(input.correspondentLocation);
    y -= 8;
  }

  // ── Subject ── the actual subject text is underlined (matching a real
  // Example Corp outgoing letter), never the word "Subject:" itself.
  drawInlineLabel('Subject:', input.subject, { size: 12, underlineValue: true });
  y -= 8;

  // ── Body ── walks the structured document (letterBodyDoc.ts) — rich
  // text, lists, tables, images, links, page breaks, block quotes. A legacy
  // plain-text bodyHtml (every letter written before this feature) is
  // wrapped as an equivalent one-paragraph-per-line doc by parseLetterBody,
  // so this is the only body-rendering path now; there is no separate
  // plain-text fallback loop to keep in sync.
  await drawLetterBodyDoc(
    {
      pdf,
      prepare: fonts.prepare,
      marginX: MARGIN,
      contentWidth: () => contentW,
      page: () => page,
      y: () => y,
      setY: (newY) => { y = newY; },
      newPage,
      bottomBound: () => layout.lineBreakY,
    },
    parseLetterBody(input.bodyHtml),
    { resolveImage: input.resolveBodyImage },
  );

  // ── Signature block ───────────────────────────────────────────────────────
  //
  // This used to draw nothing, deliberately: a typeset "Approved and digitally
  // signed by" line is not a signature claim, and the reasoning was that an
  // outgoing letter's real signature lives on the e-signing ceremony's PAdES
  // copy.
  //
  // That reasoning stopped holding when submit-for-approval and initiate-signing
  // were split. The ceremony now stamps its signature into the unnumbered
  // SIGNABLE DRAFT, and this function then renders the numbered letter of record
  // FROM SCRATCH afterwards — so the signature stayed behind on the draft and
  // the document actually dispatched showed none. Reported as "view final letter
  // shows the letter without the signature even though it was signed", and true
  // of every signed letter in the system.
  //
  // Drawn only when a signature was genuinely captured. A letter finalized
  // without a ceremony renders exactly as before.
  if (input.signatureImageDataUrl) {
    const signatureImage = await embedSignatureImage(pdf, input.signatureImageDataUrl);
    if (signatureImage) {
      // Keep the whole block on one page — a signature split across a page
      // break is worse than one pushed to the next page.
      if (y < layout.sigBreakY) newPage();
      y -= LINE_H;
      drawText('With Regards,');
      y -= 6;

      // Scale to a fixed height, preserving aspect ratio, and cap the width so
      // a wide capture cannot run into the margin.
      const maxH = 44;
      const maxW = 200;
      const scale = Math.min(maxH / signatureImage.height, maxW / signatureImage.width);
      const drawW = signatureImage.width * scale;
      const drawH = signatureImage.height * scale;
      y -= drawH;
      page.drawImage(signatureImage, { x: MARGIN, y, width: drawW, height: drawH });
      y -= 4;

      // Signature line — the drawn mark sits above this rule, the printed
      // name below it, matching a standard Example Corp signature block
      // (checked against a physical sample letter).
      const sigLineWidth = 180;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + sigLineWidth, y }, thickness: 0.75, color: rgb(0.3, 0.3, 0.3) });
      y -= 14;

      // Name and title beneath the line, so the reader knows who signed
      // without having to open the verification link.
      if (input.signatoryName) drawText(input.signatoryName, { bold: true });
      if (input.signatoryTitle) drawText(input.signatoryTitle, { size: 9, color: rgb(0.35, 0.35, 0.35) });
    }
  }

  // ── QR + verification footer (bottom of the last page) ── positioned by
  // layout (resolveLetterLayout) so it never overlaps the artwork's own
  // footer band when one is present. The reference/verify sentence sits
  // right-aligned directly under the QR image (not off at the left margin,
  // level with "Scan to verify authenticity") so the two read as one caption
  // block under the code, matching a real Example Corp outgoing letter.
  page.drawImage(qrImage, { x: PAGE_W - MARGIN - layout.qrSize, y: layout.qrY, width: layout.qrSize, height: layout.qrSize });
  const scanHint = fonts.prepare('Scan to verify authenticity');
  page.drawText(scanHint.text, {
    x: PAGE_W - MARGIN - layout.qrSize - 4, y: layout.captionY, size: 8, font: scanHint.font, color: rgb(0.4, 0.4, 0.4),
  });
  drawRightAligned(
    `${input.referenceNumber} — system-generated letter. Verify at the QR link above.`,
    layout.qrY - 8,
    { size: 8, color: rgb(0.5, 0.5, 0.5) },
  );

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export type LetterSignableDraftInput = {
  subject: string;
  bodyHtml: string | null;
  unitName: string;
  letterheadTitle?: string | null;
  departmentName: string | null;
  correspondent: string | null;
  correspondentOrganization: string | null;
  correspondentLocation?: string | null;
  /** See LetterPdfInput.resolveBodyImage. */
  resolveBodyImage?: ImageResolver;
};

export type LetterSignatureFieldPlacement = {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Renders the letter's content with NO reference number, approval date, or
 *  QR — those don't exist yet at signing time (letters.service.ts's
 *  enterPendingSignatureInTx runs this BEFORE the reference number is
 *  allocated). This is what the approver actually signs. The numbered
 *  letter of record is a separate, later render (generateLetterPdf),
 *  produced only after the signature ceremony completes — a real signature
 *  can't have content added to its pages afterward without invalidating it,
 *  so the two can never be the same PDF. */
export async function generateLetterSignableDraft(
  input: LetterSignableDraftInput,
): Promise<{ pdf: Buffer; signatureField: LetterSignatureFieldPlacement; blockPages: number[] }> {
  const pdf = await PDFDocument.create();
  const fonts = await embedLetterFonts(pdf);
  const artwork = await embedLetterheadArtwork(pdf, input.letterheadTitle);
  const layout = resolveLetterLayout(Boolean(artwork));

  const contentW = PAGE_W - MARGIN * 2;
  const drawBackground = (p: import('pdf-lib').PDFPage): void => {
    if (artwork) p.drawPage(artwork, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  };
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  drawBackground(page);
  let y = layout.startY;
  let pageNumber = 1;

  const newPage = (): void => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    drawBackground(page);
    y = layout.startY;
    pageNumber += 1;
  };
  const drawText = (
    text: string,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    if (y < layout.lineBreakY) newPage();
    const prepared = fonts.prepare(text, opts.bold);
    page.drawText(prepared.text, {
      x: MARGIN,
      y,
      size: opts.size ?? BODY_SIZE,
      font: prepared.font,
      color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
    y -= LINE_H;
  };
  /** See generateLetterPdf's drawInlineLabel for why label/value stay separate
   *  drawText calls instead of one concatenated string, and for what
   *  underlineValue draws. */
  const drawInlineLabel = (
    label: string,
    value: string,
    opts: { size?: number; underlineValue?: boolean; boldValue?: boolean } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const labelPrepared = fonts.prepare(`${label} `, true);
    const valuePrepared = fonts.prepare(value, opts.boldValue ?? true);
    const labelWidth = labelPrepared.font.widthOfTextAtSize(labelPrepared.text, size);
    page.drawText(labelPrepared.text, { x: MARGIN, y, size, font: labelPrepared.font, color: rgb(0.1, 0.1, 0.1) });
    const lines = wrapLine(valuePrepared.text, valuePrepared.font, size, Math.max(contentW - labelWidth, contentW / 3));
    lines.forEach((line, i) => {
      const x = i === 0 ? MARGIN + labelWidth : MARGIN;
      page.drawText(line, { x, y, size, font: valuePrepared.font, color: rgb(0.1, 0.1, 0.1) });
      if (opts.underlineValue && line) {
        const lineWidth = valuePrepared.font.widthOfTextAtSize(line, size);
        page.drawLine({ start: { x, y: y - 2 }, end: { x: x + lineWidth, y: y - 2 }, thickness: 0.6, color: rgb(0.1, 0.1, 0.1) });
      }
      y -= LINE_H;
    });
  };
  /** See generateLetterPdf's drawRightAligned for why this exists. */
  const drawRightAligned = (
    text: string,
    yPos: number,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const prepared = fonts.prepare(text, opts.bold);
    const width = prepared.font.widthOfTextAtSize(prepared.text, size);
    page.drawText(prepared.text, {
      x: PAGE_W - MARGIN - width, y: yPos, size, font: prepared.font, color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
  };

  // Same artwork-vs-plain-text-masthead split as generateLetterPdf, and same
  // removal of the internal unit/department line — see that function's
  // letterhead comment for why.
  if (!artwork) {
    const heading = fonts.prepare(input.letterheadTitle?.trim() || 'EXAMPLE CORP', true);
    page.drawText(heading.text, { x: MARGIN, y, size: 18, font: heading.font, color: rgb(0.12, 0.29, 0.17) });
    y -= 22;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.2, color: rgb(0.12, 0.29, 0.17) });
    y -= 20;
  }

  // A visible "DRAFT — pending signature" marker, top-right — the same slot
  // generateLetterPdf's real Ref/Date block occupies once this letter is
  // signed and finalized. There's nothing real to print there yet: this
  // render has no reference number (enterPendingSignatureInTx runs it
  // BEFORE allocating one), so anyone who sees this draft outside the
  // signing flow shouldn't mistake it for the letter of record.
  drawRightAligned('DRAFT — PENDING SIGNATURE', y, { bold: true, size: 9, color: rgb(0.6, 0.4, 0.1) });
  // Reserves the SAME two-line vertical space generateLetterPdf's real
  // Ref+Date block occupies once this draft is signed and finalized (that
  // function draws two stacked lines and drops `y` by `LINE_H * 2 + 16`;
  // this one line and `LINE_H + 16` used to be one line short). Everything
  // below — recipient, subject, and critically the entire body — used to
  // start one line higher on the draft than it does on the letter of
  // record, silently reflowing the body's pagination between what the
  // signatory actually reviewed/signed and what ships, including which page
  // `signatureField` (below) says the signature landed on. Found 2026-09-22
  // tracing a "page numbers out of sync between draft and final" report.
  y -= LINE_H * 2 + 16;

  // ── Recipient ── same inline "To: <person>" treatment as generateLetterPdf,
  // so the draft the signatory reviews already looks like the letter of
  // record it is about to become.
  if (input.correspondent || input.correspondentOrganization || input.correspondentLocation) {
    if (input.correspondent) {
      drawInlineLabel('To:', input.correspondent, { boldValue: false });
    } else {
      drawText('To:', { bold: true });
    }
    if (input.correspondentOrganization) drawText(input.correspondentOrganization);
    if (input.correspondentLocation) drawText(input.correspondentLocation);
    y -= 8;
  }

  // ── Subject ── the actual subject text is underlined, not the label —
  // same as generateLetterPdf, so the draft the signatory reviews already
  // looks like the letter of record it is about to become.
  drawInlineLabel('Subject:', input.subject, { size: 12, underlineValue: true });
  y -= 8;

  // ── Body ── see generateLetterPdf's own Body comment — same renderer,
  // same legacy-plain-text compatibility.
  const blockPages: number[] = [];
  await drawLetterBodyDoc(
    {
      pdf,
      prepare: fonts.prepare,
      marginX: MARGIN,
      contentWidth: () => contentW,
      page: () => page,
      y: () => y,
      setY: (newY) => { y = newY; },
      newPage,
      bottomBound: () => layout.lineBreakY,
      pageNumber: () => pageNumber,
    },
    parseLetterBody(input.bodyHtml),
    { resolveImage: input.resolveBodyImage, onBlockPage: (i, p) => { blockPages[i] = p; } },
  );

  // ── Signature ── mirrors a real Example Corp outgoing letter: "With
  // Regards," followed by blank space the signature actually lands in — no
  // "Signature:" form-field label, no visible box border. A bordered field
  // with a label read as a form placeholder, not a real letter (checked
  // against a physical sample: just the closing line and the signature
  // stroke itself, nothing else). Pagination guard mirrors the old
  // block's — the field must never split across a page break. The
  // placement is still tracked (signatureField, below) for the signing
  // ceremony/PAdES flattening (esignPades.ts) to stamp the actual signature
  // image into; that positioning never depended on anything being drawn
  // here.
  if (y < layout.sigBreakY) newPage();
  drawText('With Regards,');
  const fieldWidth = 200;
  const fieldHeight = 46;
  y -= 8;
  const fieldY = y - fieldHeight;
  // Signature line at the bottom of the blank signing area — the ceremony
  // stamps the captured mark with its bottom edge at fieldY (esignPades.ts),
  // so this sits right under the mark once signed, same as the rule
  // generateLetterPdf draws under the flattened signature on the letter of
  // record. Gives the signatory a visible line to sign above, matching a
  // real Example Corp signature block instead of unbounded blank space.
  page.drawLine({
    start: { x: MARGIN, y: fieldY - 3 },
    end: { x: MARGIN + 180, y: fieldY - 3 },
    thickness: 0.75,
    color: rgb(0.3, 0.3, 0.3),
  });
  const signatureField: LetterSignatureFieldPlacement = {
    pageNumber, x: MARGIN, y: fieldY, width: fieldWidth, height: fieldHeight,
  };

  const bytes = await pdf.save();
  return { pdf: Buffer.from(bytes), signatureField, blockPages };
}

export type LetterCoverSheetInput = {
  referenceNumber: string;
  direction: 'OUTGOING' | 'INCOMING';
  subject: string;
  unitName: string;
  letterheadTitle?: string | null;
  departmentName: string | null;
  correspondent: string | null;
  correspondentOrganization: string | null;
  correspondentLocation?: string | null;
  attachmentFilename: string;
  confidentiality: string;
  stampedAt: Date;
  qrUrl: string;
};

/** A one-page cover sheet for SCANNED-origin letters (incoming or outgoing).
 *  A QR can't be baked into an externally-produced scan/Word file the way it
 *  is stamped onto a system-rendered PDF, so this stands in for that: it
 *  carries the reference number and verification QR, and is filed as a
 *  separate document (letters.cover_sheet_document_id) alongside the
 *  original attachment rather than merged into it (merging would require
 *  format conversion the letter's actual content shouldn't be put through). */
export async function generateLetterCoverSheet(input: LetterCoverSheetInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const fonts = await embedLetterFonts(pdf);
  const artwork = await embedLetterheadArtwork(pdf, input.letterheadTitle);
  const layout = resolveLetterLayout(Boolean(artwork));
  const qrPng = await QRCode.toBuffer(input.qrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  const qrImage = await pdf.embedPng(qrPng);

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  if (artwork) page.drawPage(artwork, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  const contentW = PAGE_W - MARGIN * 2;
  let y = layout.startY;
  const drawText = (
    text: string,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const prepared = fonts.prepare(text, opts.bold);
    page.drawText(prepared.text, {
      x: MARGIN, y, size: opts.size ?? BODY_SIZE, font: prepared.font, color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
    y -= LINE_H;
  };
  const drawWrapped = (
    text: string,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const prepared = fonts.prepare(text, opts.bold);
    for (const line of wrapLine(prepared.text, prepared.font, opts.size ?? BODY_SIZE, contentW)) {
      drawText(line, opts);
    }
  };
  /** See generateLetterPdf's drawInlineLabel for why label/value stay separate
   *  drawText calls instead of one concatenated string, and for what
   *  underlineValue draws. */
  const drawInlineLabel = (
    label: string,
    value: string,
    opts: { size?: number; underlineValue?: boolean; boldValue?: boolean } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const labelPrepared = fonts.prepare(`${label} `, true);
    const valuePrepared = fonts.prepare(value, opts.boldValue ?? true);
    const labelWidth = labelPrepared.font.widthOfTextAtSize(labelPrepared.text, size);
    page.drawText(labelPrepared.text, { x: MARGIN, y, size, font: labelPrepared.font, color: rgb(0.1, 0.1, 0.1) });
    const lines = wrapLine(valuePrepared.text, valuePrepared.font, size, Math.max(contentW - labelWidth, contentW / 3));
    lines.forEach((line, i) => {
      const x = i === 0 ? MARGIN + labelWidth : MARGIN;
      page.drawText(line, { x, y, size, font: valuePrepared.font, color: rgb(0.1, 0.1, 0.1) });
      if (opts.underlineValue && line) {
        const lineWidth = valuePrepared.font.widthOfTextAtSize(line, size);
        page.drawLine({ start: { x, y: y - 2 }, end: { x: x + lineWidth, y: y - 2 }, thickness: 0.6, color: rgb(0.1, 0.1, 0.1) });
      }
      y -= LINE_H;
    });
  };
  /** See generateLetterPdf's drawRightAligned for why this exists. */
  const drawRightAligned = (
    text: string,
    yPos: number,
    opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
  ): void => {
    const size = opts.size ?? BODY_SIZE;
    const prepared = fonts.prepare(text, opts.bold);
    const width = prepared.font.widthOfTextAtSize(prepared.text, size);
    page.drawText(prepared.text, {
      x: PAGE_W - MARGIN - width, y: yPos, size, font: prepared.font, color: opts.color ?? rgb(0.1, 0.1, 0.1),
    });
  };

  // Same artwork-background-vs-plain-text-masthead split as generateLetterPdf.
  if (artwork) {
    const unit = fonts.prepare(input.unitName);
    page.drawText(unit.text, { x: MARGIN, y, size: 11, font: unit.font, color: rgb(0.3, 0.3, 0.3) });
    y -= 12;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: rgb(0.75, 0.75, 0.75) });
    y -= 26;
  } else {
    const heading = fonts.prepare(input.letterheadTitle?.trim() || 'EXAMPLE CORP', true);
    page.drawText(heading.text, { x: MARGIN, y, size: 18, font: heading.font, color: rgb(0.12, 0.29, 0.17) });
    y -= 20;
    const unit = fonts.prepare(input.unitName);
    page.drawText(unit.text, { x: MARGIN, y, size: 11, font: unit.font, color: rgb(0.3, 0.3, 0.3) });
    y -= 12;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.2, color: rgb(0.12, 0.29, 0.17) });
    y -= 30;
  }

  drawText('SCANNED CORRESPONDENCE — COVER SHEET', { bold: true, size: 13 });
  y -= 8;
  drawText(`Direction: ${input.direction === 'OUTGOING' ? 'Outgoing' : 'Incoming'}`);
  drawText(`Ref. No.: ${input.referenceNumber}`, { bold: true });
  drawText(`Date filed: ${input.stampedAt.toISOString().slice(0, 10)}`);
  if (input.departmentName) drawText(`Department: ${input.departmentName}`);
  // Classification stays internal-only (letters.confidentiality) — not
  // printed, same as generateLetterPdf.
  y -= 8;

  if (input.correspondent || input.correspondentOrganization || input.correspondentLocation) {
    const label = input.direction === 'OUTGOING' ? 'To:' : 'From:';
    if (input.correspondent) {
      drawInlineLabel(label, input.correspondent, { boldValue: false });
    } else {
      drawText(label, { bold: true });
    }
    if (input.correspondentOrganization) drawText(input.correspondentOrganization);
    if (input.correspondentLocation) drawText(input.correspondentLocation);
    y -= 8;
  }

  drawInlineLabel('Subject:', input.subject, { size: 12, underlineValue: true });
  y -= 8;
  drawWrapped(`Attached original: ${input.attachmentFilename}`, { color: rgb(0.35, 0.35, 0.35) });
  y -= 8;
  drawText('This is a system-filed cover sheet — the original scanned or', { size: 9, color: rgb(0.4, 0.4, 0.4) });
  drawText('uploaded document is attached to this letter record separately.', { size: 9, color: rgb(0.4, 0.4, 0.4) });

  // Same right-aligned-under-the-QR footer treatment as generateLetterPdf.
  page.drawImage(qrImage, { x: PAGE_W - MARGIN - layout.qrSize, y: layout.qrY, width: layout.qrSize, height: layout.qrSize });
  const scanHint = fonts.prepare('Scan to verify authenticity');
  page.drawText(scanHint.text, {
    x: PAGE_W - MARGIN - layout.qrSize - 4, y: layout.captionY, size: 8, font: scanHint.font, color: rgb(0.4, 0.4, 0.4),
  });
  drawRightAligned(`${input.referenceNumber} — verify at the QR link above.`, layout.qrY - 8, { size: 8, color: rgb(0.5, 0.5, 0.5) });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
