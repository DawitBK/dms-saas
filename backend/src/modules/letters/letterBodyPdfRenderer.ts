// Draws a structured letter body (letterBodyDoc.ts) into an in-progress
// pdf-lib document, replacing the old "flatten to plain text, word-wrap"
// loop in letterPdf.ts. Reuses letterPdf.ts's existing font routing
// (WinAnsi/Ethiopic), letterhead-aware page bounds, and pagination
// primitives via the PageCursor it's handed — this file draws content, it
// does not own page geometry or fonts.
//
// Scope note (documented rather than silently approximated): table rowspan
// is supported by drawing the spanning cell once at its starting row with a
// height equal to the sum of the rows it spans, and skipping that column
// position on the rows underneath — standard for a hand-rolled table
// layout, but a rowspan that would itself need to split across a PAGE break
// is not supported (the whole spanning cell is kept on one page, same as a
// single-row cell already is). Justify alignment distributes extra space
// between words only (not letter-spacing).

import { rgb, type PDFDocument as PDFDocumentType, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import sharp from 'sharp';
import type {
  LetterBodyBlockNode,
  LetterBodyDoc,
  LetterBodyImageAttrs,
  LetterBodyInlineNode,
  LetterBodyMark,
  LetterBodyTableCell,
} from './letterBodyDoc.js';

export type LetterFontFamily = 'Helvetica' | 'Times-Roman' | 'Courier';
export type LetterFontPrepare = (
  text: string,
  bold?: boolean,
  italic?: boolean,
  family?: LetterFontFamily,
) => { text: string; font: PDFFont };

/** The page/layout primitives letterPdf.ts already owns (letterhead bounds,
 *  font routing, pagination) — this renderer draws through this interface
 *  rather than owning any of it itself. */
export type PageCursor = {
  pdf: PDFDocumentType;
  /** Prepares text for drawing in the given style, picking WinAnsi vs the
   *  embedded Ethiopic font and sanitizing unencodable characters exactly
   *  like letterPdf.ts's own `fonts.prepare`. */
  prepare: LetterFontPrepare;
  marginX: number;
  contentWidth(): number;
  page(): PDFPage;
  y(): number;
  setY(y: number): void;
  /** Starts a new page (redrawing the letterhead background) and resets y
   *  to the top content bound. */
  newPage(): void;
  /** The y bound below which content must not be drawn without a page
   *  break (mirrors letterPdf.ts's `layout.lineBreakY`). */
  bottomBound(): number;
  /** 1-based number of the page currently being drawn to. Optional — only
   *  the signable-draft cursor (letterPdf.ts's generateLetterSignableDraft)
   *  implements it, for drawLetterBodyDoc's `onBlockPage` below; the final
   *  letter-of-record render has no caller that needs per-block page info. */
  pageNumber?(): number;
};

const DEFAULT_SIZE = 11;
const DEFAULT_LINE_H = 16;
const DEFAULT_COLOR = rgb(0.1, 0.1, 0.1);
const LINK_COLOR = rgb(0.11, 0.31, 0.85);
const MUTED_COLOR = rgb(0.4, 0.4, 0.4);
const BORDER_COLOR = rgb(0.6, 0.6, 0.6);

type StyledToken = {
  text: string;
  font: PDFFont;
  size: number;
  color: ReturnType<typeof rgb>;
  underline: boolean;
  strike: boolean;
  highlight?: ReturnType<typeof rgb>;
  sup: boolean;
  sub: boolean;
  linkHref?: string;
  width: number;
};

function parseColor(hex: string | null | undefined): ReturnType<typeof rgb> | null {
  if (!hex) return null;
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex);
  if (!m) return null;
  return rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255);
}

function marksOf(node: { marks?: LetterBodyMark[] }): LetterBodyMark[] {
  return node.marks ?? [];
}

/** Splits inline content into styled tokens (words + explicit breaks),
 *  measuring each with the font its own marks select — a single wrapLine()
 *  call can't handle a paragraph with mixed bold/italic/size runs, since
 *  pdf-lib measures width per-font. */
function tokenizeInline(
  cursor: PageCursor,
  nodes: LetterBodyInlineNode[],
  baseSize: number,
): StyledToken[] {
  const tokens: StyledToken[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      tokens.push({ text: '\n', font: tokens.at(-1)?.font as PDFFont, size: baseSize, color: DEFAULT_COLOR, underline: false, strike: false, sup: false, sub: false, width: 0 });
      continue;
    }
    if (node.type === 'image') continue; // inline images not yet drawn mid-paragraph — see drawParagraph's image-node handling for block-level images.
    const marks = marksOf(node);
    const bold = marks.some((m) => m.type === 'bold');
    const italic = marks.some((m) => m.type === 'italic');
    const underline = marks.some((m) => m.type === 'underline');
    const strike = marks.some((m) => m.type === 'strike');
    const sup = marks.some((m) => m.type === 'superscript');
    const sub = marks.some((m) => m.type === 'subscript');
    const link = marks.find((m) => m.type === 'link');
    const textStyle = marks.find((m) => m.type === 'textStyle');
    const highlightMark = marks.find((m) => m.type === 'highlight');
    const size = (sup || sub) ? Math.round(baseSize * 0.7) : (textStyle?.type === 'textStyle' ? textStyle.attrs.fontSize ?? baseSize : baseSize);
    const color = link ? LINK_COLOR : (textStyle?.type === 'textStyle' ? parseColor(textStyle.attrs.color) ?? DEFAULT_COLOR : DEFAULT_COLOR);
    const highlight = highlightMark?.type === 'highlight' ? parseColor(highlightMark.attrs?.color) ?? rgb(1, 0.95, 0.4) : undefined;
    const family: LetterFontFamily = (textStyle?.type === 'textStyle' ? textStyle.attrs.fontFamily ?? undefined : undefined) ?? 'Helvetica';

    const prepared = cursor.prepare(node.text, bold, italic, family);
    // Split on whitespace runs, same tokenization strategy as letterPdf.ts's
    // own wrapLine — words kept whole, interior/leading whitespace kept as
    // its own token so nothing is silently collapsed.
    const parts = prepared.text.match(/\S+|[ \t]+/g) ?? [];
    for (const part of parts) {
      tokens.push({
        text: part,
        font: prepared.font,
        size,
        color,
        underline: underline || Boolean(link),
        strike,
        highlight,
        sup,
        sub,
        linkHref: link?.type === 'link' ? link.attrs.href : undefined,
        width: prepared.font.widthOfTextAtSize(part, size),
      });
    }
  }
  return tokens;
}

/** Greedy line-wrap over mixed-style tokens. */
function wrapTokens(tokens: StyledToken[], maxWidth: number): StyledToken[][] {
  const lines: StyledToken[][] = [];
  let current: StyledToken[] = [];
  let currentWidth = 0;
  for (const tok of tokens) {
    if (tok.text === '\n') {
      lines.push(current);
      current = [];
      currentWidth = 0;
      continue;
    }
    if (current.length && currentWidth + tok.width > maxWidth) {
      // Trim a trailing whitespace-only token before wrapping.
      if (current.at(-1) && /^[ \t]+$/.test(current.at(-1)!.text)) current.pop();
      lines.push(current);
      current = [];
      currentWidth = 0;
      if (/^[ \t]+$/.test(tok.text)) continue; // leading whitespace on a new line is dropped, matching wrapLine's own trim behavior
    }
    current.push(tok);
    currentWidth += tok.width;
  }
  if (current.length) {
    if (/^[ \t]+$/.test(current.at(-1)?.text ?? '')) current.pop();
    lines.push(current);
  }
  return lines.length ? lines : [[]];
}

/** Draws one wrapped line of styled tokens at the given y, honoring
 *  alignment. Returns nothing — advances no cursor itself, callers manage y. */
function drawLine(
  page: PDFPage,
  line: StyledToken[],
  x: number,
  y: number,
  width: number,
  align: 'left' | 'center' | 'right' | 'justify',
  isLastLine: boolean,
): void {
  const lineWidth = line.reduce((sum, t) => sum + t.width, 0);
  let startX = x;
  let gapExtra = 0;
  if (align === 'center') startX = x + Math.max(0, (width - lineWidth) / 2);
  else if (align === 'right') startX = x + Math.max(0, width - lineWidth);
  else if (align === 'justify' && !isLastLine) {
    const gaps = line.filter((t) => /^[ \t]+$/.test(t.text)).length;
    if (gaps > 0) gapExtra = Math.max(0, (width - lineWidth) / gaps);
  }

  let cx = startX;
  for (const tok of line) {
    if (/^[ \t]+$/.test(tok.text)) {
      cx += tok.width + gapExtra;
      continue;
    }
    const dy = tok.sup ? 4 : tok.sub ? -3 : 0;
    if (tok.highlight) {
      page.drawRectangle({ x: cx - 1, y: y - 2, width: tok.width + 2, height: tok.size + 3, color: tok.highlight });
    }
    page.drawText(tok.text, { x: cx, y: y + dy, size: tok.size, font: tok.font, color: tok.color });
    if (tok.underline) {
      page.drawLine({ start: { x: cx, y: y - 2 }, end: { x: cx + tok.width, y: y - 2 }, thickness: 0.6, color: tok.color });
    }
    if (tok.strike) {
      const midY = y + tok.size * 0.32;
      page.drawLine({ start: { x: cx, y: midY }, end: { x: cx + tok.width, y: midY }, thickness: 0.6, color: tok.color });
    }
    if (tok.linkHref) {
      addLinkAnnotation(page, tok.linkHref, { x: cx, y: y - 2, width: tok.width, height: tok.size + 3 });
    }
    cx += tok.width;
  }
}

/** pdf-lib has no high-level Link-annotation API; this is the documented
 *  low-level recipe (a /Subtype /Link annotation dict with a /URI action)
 *  registered directly on the page's /Annots array. */
function addLinkAnnotation(page: PDFPage, uri: string, rect: { x: number; y: number; width: number; height: number }): void {
  const doc = page.doc;
  const linkAnnot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: doc.context.obj(uri) },
  });
  const ref = doc.context.register(linkAnnot);
  page.node.addAnnot(ref);
}

const LIST_BULLETS = ['•', '◦', '▪'];
function bulletFor(depth: number): string {
  return LIST_BULLETS[depth % LIST_BULLETS.length]!;
}
function numberFor(depth: number, index: number): string {
  const n = index + 1;
  if (depth % 3 === 0) return `${n}.`;
  if (depth % 3 === 1) return `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`;
  return toRoman(n).toLowerCase() + '.';
}
function toRoman(n: number): string {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let rem = n, out = '';
  for (const [v, s] of table) { while (rem >= v) { out += s; rem -= v; } }
  return out;
}

export type ImageResolver = (src: string) => Promise<Buffer | null>;

type RenderCtx = {
  cursor: PageCursor;
  baseSize: number;
  resolveImage: ImageResolver;
  imageCache: Map<string, PDFImage | null>;
};

async function embedImage(ctx: RenderCtx, src: string): Promise<PDFImage | null> {
  if (ctx.imageCache.has(src)) return ctx.imageCache.get(src) ?? null;
  try {
    const bytes = await ctx.resolveImage(src);
    if (!bytes) { ctx.imageCache.set(src, null); return null; }
    const png = await sharp(bytes).png().toBuffer();
    const embedded = await ctx.cursor.pdf.embedPng(png);
    ctx.imageCache.set(src, embedded);
    return embedded;
  } catch {
    ctx.imageCache.set(src, null);
    return null;
  }
}

async function drawImageBlock(ctx: RenderCtx, attrs: LetterBodyImageAttrs): Promise<void> {
  const image = await embedImage(ctx, attrs.src);
  if (!image) return;
  const contentW = ctx.cursor.contentWidth();
  const maxW = Math.min(attrs.width ?? contentW, contentW);
  const scale = maxW / image.width;
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  if (ctx.cursor.y() - drawH < ctx.cursor.bottomBound()) ctx.cursor.newPage();
  const align = attrs.align ?? 'left';
  const x = ctx.cursor.marginX + (align === 'center' ? (contentW - drawW) / 2 : align === 'right' ? contentW - drawW : 0);
  const y = ctx.cursor.y() - drawH;
  ctx.cursor.page().drawImage(image, { x, y, width: drawW, height: drawH });
  ctx.cursor.setY(y - 4);
  if (attrs.caption) {
    const prepared = ctx.cursor.prepare(attrs.caption, false, true);
    ctx.cursor.page().drawText(prepared.text, { x, y: ctx.cursor.y() - 10, size: 9, font: prepared.font, color: MUTED_COLOR });
    ctx.cursor.setY(ctx.cursor.y() - 16);
  }
  ctx.cursor.setY(ctx.cursor.y() - 6);
}

async function drawParagraphLike(
  ctx: RenderCtx,
  content: LetterBodyInlineNode[] | undefined,
  x: number,
  width: number,
  attrs: { textAlign?: string | null; lineSpacing?: number | null; spacingBefore?: number | null; spacingAfter?: number | null; indent?: number | null; firstLineIndent?: number | null } | undefined,
): Promise<void> {
  const { cursor, baseSize } = ctx;
  if (attrs?.spacingBefore) cursor.setY(cursor.y() - attrs.spacingBefore);
  const indentPt = (attrs?.indent ?? 0) * 18;
  const tokens = tokenizeInline(cursor, content ?? [], baseSize);
  const align = (attrs?.textAlign ?? 'left') as 'left' | 'center' | 'right' | 'justify';
  const lineH = Math.round(baseSize * (attrs?.lineSpacing ?? 1.3));

  if (!tokens.length) {
    cursor.setY(cursor.y() - lineH);
    return;
  }

  const firstLineIndent = (attrs?.firstLineIndent ?? 0);
  const lines = wrapTokens(tokens, width - indentPt);
  lines.forEach((line, i) => {
    if (cursor.y() < cursor.bottomBound()) cursor.newPage();
    const lineX = x + indentPt + (i === 0 ? firstLineIndent : 0);
    const lineWidth = width - indentPt - (i === 0 ? firstLineIndent : 0);
    drawLine(cursor.page(), line, lineX, cursor.y(), lineWidth, align, i === lines.length - 1);
    cursor.setY(cursor.y() - lineH);
  });
  if (attrs?.spacingAfter) cursor.setY(cursor.y() - attrs.spacingAfter);
}

async function drawList(ctx: RenderCtx, node: Extract<LetterBodyBlockNode, { type: 'bulletList' | 'orderedList' }>, depth: number): Promise<void> {
  const { cursor, baseSize } = ctx;
  const indentPt = 18 * (depth + 1);
  let index = 0;
  for (const item of node.content) {
    for (const block of item.content) {
      if (block.type === 'paragraph') {
        if (cursor.y() < cursor.bottomBound()) cursor.newPage();
        const marker = node.type === 'bulletList' ? bulletFor(depth) : numberFor(depth, index);
        const markerPrepared = cursor.prepare(marker, false);
        cursor.page().drawText(markerPrepared.text, { x: cursor.marginX + indentPt - 14, y: cursor.y(), size: baseSize, font: markerPrepared.font, color: DEFAULT_COLOR });
        await drawParagraphLike(ctx, block.content, cursor.marginX + indentPt, cursor.contentWidth() - indentPt, block.attrs);
      } else if (block.type === 'bulletList' || block.type === 'orderedList') {
        await drawList(ctx, block, depth + 1);
      } else {
        await drawBlock(ctx, block, depth);
      }
    }
    index += 1;
  }
}

/** Column widths for a table: honors explicit colwidth on the first row's
 *  cells when present, else splits the table's target width evenly. */
function computeColumnWidths(node: Extract<LetterBodyBlockNode, { type: 'table' }>, contentWidth: number): number[] {
  const tableWidth = ((node.attrs?.width ?? 100) / 100) * contentWidth;
  const firstRow = node.content[0];
  const colCount = firstRow?.content.reduce((n, c) => n + (c.attrs?.colspan ?? 1), 0) ?? 1;
  const explicit = firstRow?.content.flatMap((c) => c.attrs?.colwidth ?? []);
  // A colwidth entry is `null` for any column TipTap hasn't explicitly
  // measured yet (e.g. one column of a colspan-2 cell) — treated the same as
  // "no explicit width for this table" rather than crashing on arithmetic
  // with null, since a partial width set is not useful for proportioning.
  if (explicit && explicit.length === colCount && explicit.every((w): w is number => typeof w === 'number' && w > 0)) {
    const sum = explicit.reduce((a, b) => a + b, 0);
    return explicit.map((w) => (w / sum) * tableWidth);
  }
  return Array.from({ length: colCount }, () => tableWidth / colCount);
}

/** Measures the height a cell's content needs at a given width, without
 *  drawing — used to compute each row's height (the max over its cells)
 *  before any drawing happens, so a page-break decision can be made for the
 *  WHOLE row up front rather than mid-draw. */
async function measureCellHeight(ctx: RenderCtx, cell: LetterBodyTableCell, width: number): Promise<number> {
  const padding = cell.attrs?.padding ?? 6;
  let height = padding * 2;
  for (const block of cell.content) {
    if (block.type === 'paragraph') {
      const tokens = tokenizeInline(ctx.cursor, block.content ?? [], ctx.baseSize);
      const lines = wrapTokens(tokens, width - padding * 2);
      const lineH = Math.round(ctx.baseSize * (block.attrs?.lineSpacing ?? 1.3));
      height += Math.max(lines.length, 1) * lineH;
    } else {
      // Non-paragraph cell content (a nested list/image) — approximate with
      // a fixed per-block allowance rather than a full recursive measure;
      // keeps table pagination correct for the overwhelmingly common case
      // (text-only cells) without a second full layout pass.
      height += 40;
    }
  }
  return height;
}

async function drawCellContent(
  ctx: RenderCtx,
  cell: LetterBodyTableCell,
  x: number,
  topY: number,
  width: number,
  cellHeight: number,
  naturalHeight: number,
): Promise<void> {
  const { cursor } = ctx;
  const padding = cell.attrs?.padding ?? 6;
  const savedY = cursor.y();
  // A cell's own row can be taller than its content needs — either because a
  // sibling cell in the same row is taller, or a rowspan cell stretches over
  // several rows — and `valign` (parsed on the frontend, see
  // letterBodyExtensions.ts) says where the content should sit in that extra
  // space. Not accounting for this used to mean the PDF always drew from the
  // top regardless of `valign`, silently diverging from what the editor's
  // own <td> already renders natively via CSS `vertical-align` — the "live
  // preview and the compose editor are out of sync" report this fixes.
  const extra = Math.max(0, cellHeight - naturalHeight);
  const valign = cell.attrs?.valign ?? 'top';
  const offset = valign === 'bottom' ? extra : valign === 'middle' ? extra / 2 : 0;
  cursor.setY(topY - padding - offset);
  for (const block of cell.content) {
    if (block.type === 'paragraph') {
      const textAlign = (block.attrs?.textAlign ?? cell.attrs?.align ?? 'left') as 'left' | 'center' | 'right' | 'justify';
      await drawParagraphLike(ctx, block.content, x + padding, width - padding * 2, { ...block.attrs, textAlign });
    } else {
      await drawBlock(ctx, block, 0);
    }
  }
  cursor.setY(savedY);
}

async function drawTable(ctx: RenderCtx, node: Extract<LetterBodyBlockNode, { type: 'table' }>): Promise<void> {
  const { cursor } = ctx;
  const colWidths = computeColumnWidths(node, cursor.contentWidth());
  const colX: number[] = [];
  colWidths.reduce((acc, w, i) => { colX[i] = acc; return acc + w; }, cursor.marginX);

  // Rowspan bookkeeping: which (row, col) slots are already occupied by an
  // earlier row's spanning cell, and how much height remains.
  const occupied = new Map<string, number>(); // key `${row}:${col}` -> rows remaining

  const headerRow = node.content[0]?.content.some((c) => c.type === 'tableHeader') ? node.content[0] : null;

  const drawHeaderIfAny = async (): Promise<void> => {
    if (!headerRow) return;
    await drawRow(headerRow, -1, true);
  };

  const drawRow = async (row: typeof node.content[number], rowIndex: number, isHeaderRepeat: boolean): Promise<void> => {
    let col = 0;
    const cellsAtCol: Array<{ cell: LetterBodyTableCell; col: number; span: number } | null> = [];
    for (const cell of row.content) {
      while (occupied.has(`${rowIndex}:${col}`)) col += 1;
      const span = cell.attrs?.colspan ?? 1;
      cellsAtCol.push({ cell, col, span });
      col += span;
    }

    const heights = await Promise.all(
      cellsAtCol.map(async (entry) => {
        if (!entry) return 0;
        const w = colWidths.slice(entry.col, entry.col + entry.span).reduce((a, b) => a + b, 0);
        return measureCellHeight(ctx, entry.cell, w);
      }),
    );
    const rowHeight = Math.max(...heights, 20);

    if (!isHeaderRepeat && cursor.y() - rowHeight < cursor.bottomBound()) {
      cursor.newPage();
      await drawHeaderIfAny();
    }

    const topY = cursor.y();
    for (let idx = 0; idx < cellsAtCol.length; idx += 1) {
      const entry = cellsAtCol[idx];
      if (!entry) continue;
      const { cell, col: c, span } = entry;
      const w = colWidths.slice(c, c + span).reduce((a, b) => a + b, 0);
      const x = colX[c]!;
      const rowspan = cell.attrs?.rowspan ?? 1;
      const cellHeight = rowspan > 1 ? rowHeight * rowspan : rowHeight; // approximation for spanning cells (see file header note)
      if (cell.attrs?.background) {
        const bg = parseColor(cell.attrs.background);
        if (bg) cursor.page().drawRectangle({ x, y: topY - cellHeight, width: w, height: cellHeight, color: bg });
      } else if (cell.type === 'tableHeader') {
        cursor.page().drawRectangle({ x, y: topY - cellHeight, width: w, height: cellHeight, color: rgb(0.93, 0.94, 0.96) });
      }
      drawCellBorders(cursor.page(), x, topY, w, cellHeight, cell.attrs);
      await drawCellContent(ctx, cell, x, topY, w, cellHeight, heights[idx]!);
      if (rowspan > 1) {
        for (let r = 1; r < rowspan; r += 1) occupied.set(`${rowIndex + r}:${c}`, rowspan - r);
      }
    }
    cursor.setY(topY - rowHeight);
  };

  for (let i = 0; i < node.content.length; i += 1) {
    await drawRow(node.content[i]!, i, false);
  }
  cursor.setY(cursor.y() - 8);
}

function drawCellBorders(
  page: PDFPage,
  x: number,
  topY: number,
  w: number,
  h: number,
  attrs: LetterBodyTableCell['attrs'],
): void {
  const sides: Array<['top' | 'right' | 'bottom' | 'left', { start: { x: number; y: number }; end: { x: number; y: number } }]> = [
    ['top', { start: { x, y: topY }, end: { x: x + w, y: topY } }],
    ['right', { start: { x: x + w, y: topY }, end: { x: x + w, y: topY - h } }],
    ['bottom', { start: { x, y: topY - h }, end: { x: x + w, y: topY - h } }],
    ['left', { start: { x, y: topY }, end: { x, y: topY - h } }],
  ];
  for (const [side, line] of sides) {
    const key = (`border${side[0].toUpperCase()}${side.slice(1)}`) as 'borderTop' | 'borderRight' | 'borderBottom' | 'borderLeft';
    const border = attrs?.[key];
    if (border?.style === 'none') continue;
    const width = border?.width ?? 0.75;
    const color = parseColor(border?.color) ?? BORDER_COLOR;
    if (width <= 0) continue;
    page.drawLine({ ...line, thickness: width, color, dashArray: border?.style === 'dashed' ? [3, 2] : undefined });
  }
}

async function drawBlockquote(ctx: RenderCtx, node: Extract<LetterBodyBlockNode, { type: 'blockquote' }>): Promise<void> {
  const { cursor } = ctx;
  const barX = cursor.marginX;
  const startY = cursor.y();
  const indent = 16;
  for (const block of node.content) {
    if (block.type === 'paragraph') {
      await drawParagraphLike(ctx, block.content, barX + indent, cursor.contentWidth() - indent, { ...block.attrs });
    } else {
      await drawBlock(ctx, block, 0);
    }
  }
  const endY = cursor.y();
  cursor.page().drawLine({ start: { x: barX + 4, y: startY + 4 }, end: { x: barX + 4, y: endY }, thickness: 2, color: rgb(0.75, 0.75, 0.8) });
}

async function drawBlock(ctx: RenderCtx, block: LetterBodyBlockNode, depth: number): Promise<void> {
  const { cursor } = ctx;
  switch (block.type) {
    case 'paragraph':
      await drawParagraphLike(ctx, block.content, cursor.marginX, cursor.contentWidth(), block.attrs);
      return;
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.attrs?.level ?? 2));
      const size = [0, 20, 17, 15, 13, 12, 11][level] ?? 13;
      await drawParagraphLike({ ...ctx, baseSize: size }, block.content, cursor.marginX, cursor.contentWidth(), block.attrs);
      return;
    }
    case 'codeBlock':
      await drawParagraphLike({ ...ctx, baseSize: 10 }, block.content, cursor.marginX, cursor.contentWidth(), undefined);
      return;
    case 'bulletList':
    case 'orderedList':
      await drawList(ctx, block, depth);
      return;
    case 'table':
      if (cursor.y() < cursor.bottomBound() + 20) cursor.newPage();
      await drawTable(ctx, block);
      return;
    case 'image':
      await drawImageBlock(ctx, block.attrs);
      return;
    case 'horizontalRule':
      if (cursor.y() < cursor.bottomBound()) cursor.newPage();
      cursor.page().drawLine({ start: { x: cursor.marginX, y: cursor.y() }, end: { x: cursor.marginX + cursor.contentWidth(), y: cursor.y() }, thickness: 1, color: BORDER_COLOR });
      cursor.setY(cursor.y() - 12);
      return;
    case 'pageBreak':
      cursor.newPage();
      return;
    case 'blockquote':
      await drawBlockquote(ctx, block);
      return;
  }
}

export async function drawLetterBodyDoc(
  cursor: PageCursor,
  doc: LetterBodyDoc,
  opts: {
    baseSize?: number;
    resolveImage?: ImageResolver;
    /** Called with each TOP-LEVEL block's index and the page it STARTS on
     *  (1-based), before that block is drawn — lets a caller (the compose
     *  page's live preview) map "the caret is in block N" to "show page P"
     *  without reimplementing this renderer's own line-wrapping/pagination.
     *  No-op unless `cursor.pageNumber` is implemented. */
    onBlockPage?: (blockIndex: number, pageNumber: number) => void;
  } = {},
): Promise<void> {
  const ctx: RenderCtx = {
    cursor,
    baseSize: opts.baseSize ?? DEFAULT_SIZE,
    resolveImage: opts.resolveImage ?? (async () => null),
    imageCache: new Map(),
  };
  for (const [i, block] of doc.content.entries()) {
    opts.onBlockPage?.(i, cursor.pageNumber?.() ?? 1);
    await drawBlock(ctx, block, 0);
  }
}

export const LETTER_BODY_DEFAULT_LINE_H = DEFAULT_LINE_H;
