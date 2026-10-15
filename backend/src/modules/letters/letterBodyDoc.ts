// Structured letter-body document model.
//
// Letters' Body field used to be — despite the field's name, `bodyHtml` — a
// plain `<textarea>` with zero rich-text support anywhere in the stack: no
// paste handling, no formatting, no tables. A pasted Word/PDF table arrived
// as flattened pipe/tab-separated text and rendered that way in the final
// PDF (AUDIT: 2026-09-21 letters-table-rendering finding).
//
// This is the shared document schema BOTH the frontend editor
// (frontend/shared/lib/letterBodySchema.ts — kept in sync with this file by
// hand, since they run in different runtimes) and this backend agree on. It
// intentionally mirrors TipTap/ProseMirror's own JSON node shapes 1:1 (same
// `type`/`attrs`/`content``/`marks` field names) rather than inventing a
// parallel vocabulary — `editor.getJSON()` on the frontend produces
// something this schema can validate directly, with no translation layer to
// keep in sync on top of the schema itself.
//
// `letterBodyPdfRenderer.ts` walks this tree to draw the PDF body (replacing
// the old flatten-to-plain-text + word-wrap loop in letterPdf.ts).
// `letters.service.ts` validates every incoming `bodyHtml` against this
// schema when it looks like structured content, and `extractPlainText()`
// here is what search indexing / notification previews / audit snapshots
// use instead of the old `htmlToPlainText`.

import { z } from 'zod';

// ── Marks (inline formatting) ───────────────────────────────────────────────

const colorAttr = z.string().regex(/^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/).max(32);

const markSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }),
  z.object({ type: z.literal('italic') }),
  z.object({ type: z.literal('underline') }),
  z.object({ type: z.literal('strike') }),
  z.object({ type: z.literal('superscript') }),
  z.object({ type: z.literal('subscript') }),
  z.object({
    type: z.literal('textStyle'),
    attrs: z
      .object({
        color: colorAttr.optional().nullable(),
        fontFamily: z.enum(['Helvetica', 'Times-Roman', 'Courier']).optional().nullable(),
        fontSize: z.number().min(6).max(72).optional().nullable(),
      })
      .partial(),
  }),
  z.object({
    type: z.literal('highlight'),
    attrs: z.object({ color: colorAttr.optional().nullable() }).partial().optional(),
  }),
  z.object({
    type: z.literal('link'),
    attrs: z.object({
      // Not `.url()` — that requires an absolute URL with a scheme, which
      // rejects exactly the links a pasted Word document commonly carries:
      // in-document bookmarks (`#_Toc12345`), relative paths, and bare
      // `mailto:`/`tel:` shorthands some authors type by hand. Only block
      // schemes that could execute script if a rendered PDF or the read-only
      // viewer ever treated this as directly clickable.
      href: z
        .string()
        .max(2000)
        .refine((v) => !/^\s*(javascript|data|vbscript):/i.test(v), { message: 'Link uses an unsupported scheme' }),
      title: z.string().max(300).optional().nullable(),
    }),
  }),
]);
export type LetterBodyMark = z.infer<typeof markSchema>;

// ── Inline content ──────────────────────────────────────────────────────────

const textNodeSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(50_000),
  marks: z.array(markSchema).max(16).optional(),
});

const hardBreakNodeSchema = z.object({ type: z.literal('hardBreak') });

const inlineImageAttrs = z.object({
  src: z.string().min(1).max(2000),
  alt: z.string().max(500).optional().nullable(),
  width: z.number().min(1).max(4000).optional().nullable(),
  height: z.number().min(1).max(4000).optional().nullable(),
  align: z.enum(['left', 'center', 'right']).optional().nullable(),
  caption: z.string().max(500).optional().nullable(),
});

const inlineImageNodeSchema = z.object({ type: z.literal('image'), attrs: inlineImageAttrs });
export type LetterBodyImageAttrs = z.infer<typeof inlineImageAttrs>;

const inlineNodeSchema = z.union([textNodeSchema, hardBreakNodeSchema, inlineImageNodeSchema]);
export type LetterBodyInlineNode = z.infer<typeof inlineNodeSchema>;

// ── Block content (recursive — lists/tables/blockquotes nest blocks) ───────

const paragraphAttrs = z
  .object({
    // `textAlign`, not `align` — matches @tiptap/extension-text-align's own
    // attribute name exactly, since that's the stock extension producing
    // this value; every other paragraph attr here has no TipTap equivalent
    // and is this schema's own invention (see letterBodySchema.ts's Paragraph
    // node extension on the frontend).
    textAlign: z.enum(['left', 'center', 'right', 'justify']).optional().nullable(),
    lineSpacing: z.number().min(0.8).max(3).optional().nullable(),
    spacingBefore: z.number().min(0).max(60).optional().nullable(),
    spacingAfter: z.number().min(0).max(60).optional().nullable(),
    indent: z.number().min(0).max(10).optional().nullable(),
    firstLineIndent: z.number().min(0).max(200).optional().nullable(),
  })
  .partial();

// z.lazy ties the recursive knot: a table cell / list item / blockquote
// contains block nodes, and block nodes include tables/lists/blockquotes.
const blockNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('paragraph'),
      attrs: paragraphAttrs.optional(),
      content: z.array(inlineNodeSchema).max(2000).optional(),
    }),
    // TipTap's StarterKit keeps headings and code blocks when authors paste
    // from Word/WPS. They are ordinary block nodes, so accepting them here
    // preserves the author's content instead of rejecting the whole preview.
    z.object({
      type: z.literal('heading'),
      attrs: paragraphAttrs.extend({ level: z.number().int().min(1).max(6).optional().nullable() }).optional(),
      content: z.array(inlineNodeSchema).max(2000).optional(),
    }),
    z.object({
      type: z.literal('codeBlock'),
      attrs: z.object({ language: z.string().max(100).optional().nullable() }).partial().optional(),
      content: z.array(z.union([textNodeSchema, hardBreakNodeSchema])).max(10_000).optional(),
    }),
    z.object({
      type: z.literal('bulletList'),
      content: z.array(listItemSchema).min(1).max(500),
    }),
    z.object({
      type: z.literal('orderedList'),
      attrs: z.object({ start: z.number().min(1).max(9999).optional().nullable() }).partial().optional(),
      content: z.array(listItemSchema).min(1).max(500),
    }),
    z.object({
      type: z.literal('table'),
      attrs: z.object({ width: z.number().min(10).max(100).optional().nullable() }).partial().optional(),
      content: z.array(tableRowSchema).min(1).max(500),
    }),
    z.object({ type: z.literal('image'), attrs: inlineImageAttrs }),
    z.object({ type: z.literal('horizontalRule') }),
    z.object({ type: z.literal('pageBreak') }),
    z.object({
      type: z.literal('blockquote'),
      content: z.array(blockNodeSchema).min(1).max(200),
    }),
  ]),
);

const listItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal('listItem'),
    content: z.array(blockNodeSchema).min(1).max(200),
  }),
);

const borderSideSchema = z
  .object({
    width: z.number().min(0).max(8).optional().nullable(),
    color: colorAttr.optional().nullable(),
    style: z.enum(['solid', 'dashed', 'none']).optional().nullable(),
  })
  .partial();

const cellAttrsSchema = z
  .object({
    colspan: z.number().min(1).max(100).optional().nullable(),
    rowspan: z.number().min(1).max(100).optional().nullable(),
    // TipTap's own table plugin stores one width per spanned column, and
    // leaves the entries it hasn't measured yet as `null` (e.g. a colspan-2
    // cell where only one of the two columns has been explicitly resized) —
    // rejecting that shape entirely used to fail validation for any pasted
    // table with a merged cell. The PDF renderer's computeColumnWidths()
    // already tolerates `null` entries by falling back to an even split.
    colwidth: z.array(z.number().min(1).max(4000).nullable()).max(100).optional().nullable(),
    // 'justify' included even though the stock TipTap table-cell alignment
    // attribute itself only ever normalizes to left/center/right (see
    // letterBodyExtensions.ts's cellAttributes() comment) — the renderer
    // (letterBodyPdfRenderer.ts) already treats a cell's `align` as a
    // fallback for its paragraphs' own `textAlign`, which DOES support
    // 'justify', so accepting it here keeps the two schemas' value sets
    // consistent rather than arbitrarily narrower at the cell level.
    align: z.enum(['left', 'center', 'right', 'justify']).optional().nullable(),
    valign: z.enum(['top', 'middle', 'bottom']).optional().nullable(),
    background: colorAttr.optional().nullable(),
    padding: z.number().min(0).max(40).optional().nullable(),
    borderTop: borderSideSchema.optional().nullable(),
    borderRight: borderSideSchema.optional().nullable(),
    borderBottom: borderSideSchema.optional().nullable(),
    borderLeft: borderSideSchema.optional().nullable(),
  })
  .partial();

const tableCellSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.enum(['tableCell', 'tableHeader']),
    attrs: cellAttrsSchema.optional(),
    content: z.array(blockNodeSchema).min(1).max(200),
  }),
);

const tableRowSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal('tableRow'),
    content: z.array(tableCellSchema).min(1).max(200),
  }),
);

export const letterBodyDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(blockNodeSchema).max(5000),
});

export type LetterBodyDoc = z.infer<typeof letterBodyDocSchema>;
export type LetterBodyBlockNode =
  | { type: 'paragraph'; attrs?: z.infer<typeof paragraphAttrs>; content?: LetterBodyInlineNode[] }
  | { type: 'heading'; attrs?: z.infer<typeof paragraphAttrs> & { level?: number | null }; content?: LetterBodyInlineNode[] }
  | { type: 'codeBlock'; attrs?: { language?: string | null }; content?: Array<Extract<LetterBodyInlineNode, { type: 'text' | 'hardBreak' }>> }
  | { type: 'bulletList'; content: LetterBodyListItem[] }
  | { type: 'orderedList'; attrs?: { start?: number | null }; content: LetterBodyListItem[] }
  | { type: 'table'; attrs?: { width?: number | null }; content: LetterBodyTableRow[] }
  | { type: 'image'; attrs: z.infer<typeof inlineImageAttrs> }
  | { type: 'horizontalRule' }
  | { type: 'pageBreak' }
  | { type: 'blockquote'; content: LetterBodyBlockNode[] };
export type LetterBodyListItem = { type: 'listItem'; content: LetterBodyBlockNode[] };
export type LetterBodyTableRow = { type: 'tableRow'; content: LetterBodyTableCell[] };
export type LetterBodyTableCell = {
  type: 'tableCell' | 'tableHeader';
  attrs?: z.infer<typeof cellAttrsSchema>;
  content: LetterBodyBlockNode[];
};

// ── Legacy / structured detection ───────────────────────────────────────────

/** Every letter created before this feature landed (and every letter created
 *  by the compose form's fallback path) stores `bodyHtml` as a plain string —
 *  never valid `{"type":"doc",...}` JSON, since a plain-text author has no
 *  way to type a literal JSON document that happens to parse as one and also
 *  round-trips through the schema below. False positives are not a
 *  practical concern; a false negative (treating real structured content as
 *  legacy) only degrades formatting, it never crashes rendering, because
 *  `parseLetterBody` always falls back safely either direction. */
export function isStructuredLetterBody(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"type"')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return letterBodyDocSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

/** Wraps legacy plain text as an equivalent doc — one paragraph per line,
 *  blank lines preserved as empty paragraphs — so the new renderer has a
 *  single input shape to handle regardless of which era a letter is from.
 *  Matches the old `htmlToPlainText` + `bodyText.split('\n')` behavior this
 *  replaces: blank lines are the only spacing tool a plain-textarea author
 *  ever had, so they're kept, not collapsed. */
export function plainTextToDoc(text: string): LetterBodyDoc {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : undefined,
    })),
  };
}

/** Single entry point every consumer (PDF renderer, plain-text extractor)
 *  should use to go from a letter's stored `bodyHtml` string to a doc —
 *  handles both eras transparently. Never throws: a stored value that is
 *  neither valid structured JSON nor usable as plain text (should not be
 *  possible given create/update validation, but this is also reached for
 *  historical rows written before that validation existed) degrades to an
 *  empty document rather than failing PDF generation. */
export function parseLetterBody(raw: string | null | undefined): LetterBodyDoc {
  if (!raw) return { type: 'doc', content: [] };
  if (isStructuredLetterBody(raw)) {
    try {
      return letterBodyDocSchema.parse(JSON.parse(raw));
    } catch {
      // Fell through despite isStructuredLetterBody's own safeParse check —
      // not reachable in practice (same schema, same input), kept as a
      // last-resort guard rather than letting a raw exception reach the PDF
      // generator.
      return plainTextToDoc(raw);
    }
  }
  return plainTextToDoc(raw);
}

/** Flattens a doc back to plain text — search indexing, notification
 *  previews, audit-log snapshots, and anywhere else that only ever wanted
 *  "what does this letter say" rather than its formatting. Table cells are
 *  joined with a tab per cell (never silently concatenated word-to-word) and
 *  rows with newlines, so a search index still finds text that lives inside
 *  a table. */
export function extractPlainText(doc: LetterBodyDoc): string {
  const lines: string[] = [];
  const inlineText = (nodes: LetterBodyInlineNode[] | undefined): string =>
    (nodes ?? [])
      .map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : n.type === 'image' ? `[image${n.attrs.alt ? `: ${n.attrs.alt}` : ''}]` : ''))
      .join('');

  const walkBlocks = (blocks: LetterBodyBlockNode[], depth: number): void => {
    for (const block of blocks) {
      switch (block.type) {
        case 'paragraph':
          lines.push(inlineText(block.content));
          break;
        case 'heading':
          lines.push(inlineText(block.content));
          break;
        case 'codeBlock':
          lines.push(inlineText(block.content));
          break;
        case 'bulletList':
        case 'orderedList':
          for (const item of block.content) {
            walkBlocks(item.content, depth + 1);
          }
          break;
        case 'blockquote':
          walkBlocks(block.content, depth);
          break;
        case 'table':
          for (const row of block.content) {
            lines.push(
              row.content
                .map((cell) => cell.content.map((b) => (b.type === 'paragraph' ? inlineText(b.content) : '')).join(' '))
                .join('\t'),
            );
          }
          break;
        case 'image':
          lines.push(`[image${block.attrs.alt ? `: ${block.attrs.alt}` : ''}]`);
          break;
        case 'horizontalRule':
        case 'pageBreak':
          break;
      }
    }
  };
  walkBlocks(doc.content, 0);
  return lines.join('\n').trim();
}
