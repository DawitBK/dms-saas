// Custom TipTap node/mark extensions for the Letter Body editor.
//
// This file, together with LetterBodyEditor.tsx's extension list, is one
// half of the shared document contract — the backend half is
// backend/src/modules/letters/letterBodyDoc.ts's Zod schema. The two are
// kept in sync BY HAND (different runtimes, no shared package) — every attr
// name here must match a field that schema actually accepts, or content an
// author creates here will fail letters.service.ts's bodyHtml validation the
// moment they try to save. Cross-reference that file before adding an attr.
'use client';

import { Extension, Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import ColorExtension from '@tiptap/extension-color';
import UnderlineExtension from '@tiptap/extension-underline';
import SubscriptExtension from '@tiptap/extension-subscript';
import SuperscriptExtension from '@tiptap/extension-superscript';
import HighlightExtension from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import LinkExtension from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import Image from '@tiptap/extension-image';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Paragraph from '@tiptap/extension-paragraph';
import { LetterImageNodeView } from '../components/letterBody/LetterImageNodeView';

// ── Font size (textStyle mark attribute) ────────────────────────────────────
// TipTap ships no font-size extension; this is the standard ~15-line pattern
// for adding one more attribute to the existing `textStyle` mark
// (@tiptap/extension-text-style, already required by Color/FontFamily),
// matching letterBodyDoc.ts's markSchema's `textStyle.attrs.fontSize`. The
// stored number is always POINTS (matching the toolbar's Word-style sizes —
// 9/10/11/12/14/... — and the backend renderer, which feeds it straight into
// pdf-lib's `size` in points) — never CSS pixels. `renderHTML` used to emit
// `${fontSize}px`, which drew the SAME number as a ~33% SMALLER physical size
// in the browser than the PDF renders it at (18pt ≈ 24px; the editor was
// showing 18px). Found 2026-09-22 tracing "compose and preview don't match."
const PT_PER_PX = 0.75; // 1px (CSS, 96dpi) = 0.75pt; inverse of the standard 1pt = 1.3333px
function parseFontSizeToPoints(raw: string): number | null {
  const trimmed = raw.trim();
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Word/WPS's exported HTML commonly gives font sizes in px, not pt, when
  // saved for the web — converting keeps a pasted document's original
  // physical size intact instead of reading its px number as if it were
  // already a point size (which would render notably larger than the source).
  const points = trimmed.endsWith('px') ? value * PT_PER_PX : value;
  return Math.round(points);
}
export const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => (element.style.fontSize ? parseFontSizeToPoints(element.style.fontSize) : null),
            renderHTML: (attributes: { fontSize?: number | null }) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}pt` } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (size: number) =>
        ({ chain }: { chain: () => { setMark: (name: string, attrs: Record<string, unknown>) => { run: () => boolean } } }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
    } as Record<string, (...args: never[]) => (props: never) => boolean>;
  },
});

// ── Paragraph formatting (letterBodyDoc.ts's paragraphAttrs) ───────────────
// `textAlign` itself comes from @tiptap/extension-text-align (applied to
// this same node type in the editor's extension list) — the attrs added
// here are the ones with no stock TipTap equivalent: line/paragraph spacing
// and indentation.
export const LetterParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      lineSpacing: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.dataset.lineSpacing ? Number(el.dataset.lineSpacing) : null),
        renderHTML: (attrs: { lineSpacing?: number | null }) => (attrs.lineSpacing ? { 'data-line-spacing': attrs.lineSpacing, style: `line-height: ${attrs.lineSpacing}` } : {}),
      },
      spacingBefore: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.dataset.spacingBefore ? Number(el.dataset.spacingBefore) : null),
        renderHTML: (attrs: { spacingBefore?: number | null }) => (attrs.spacingBefore ? { 'data-spacing-before': attrs.spacingBefore, style: `margin-top: ${attrs.spacingBefore}px` } : {}),
      },
      spacingAfter: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.dataset.spacingAfter ? Number(el.dataset.spacingAfter) : null),
        renderHTML: (attrs: { spacingAfter?: number | null }) => (attrs.spacingAfter ? { 'data-spacing-after': attrs.spacingAfter, style: `margin-bottom: ${attrs.spacingAfter}px` } : {}),
      },
      indent: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.dataset.indent ? Number(el.dataset.indent) : null),
        renderHTML: (attrs: { indent?: number | null }) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * 24}px` } : {}),
      },
      firstLineIndent: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.dataset.firstLineIndent ? Number(el.dataset.firstLineIndent) : null),
        renderHTML: (attrs: { firstLineIndent?: number | null }) => (attrs.firstLineIndent ? { 'data-first-line-indent': attrs.firstLineIndent, style: `text-indent: ${attrs.firstLineIndent}px` } : {}),
      },
    };
  },
});

// ── Image (letterBodyDoc.ts's inlineImageAttrs) ─────────────────────────────
// Extends the stock node with width/height/align/caption — none of which
// the base extension exposes.
export const LetterImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null },
      height: { default: null },
      align: { default: 'left' },
      caption: { default: null },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const { align, width, height, caption, ...rest } = HTMLAttributes as Record<string, unknown>;
    const style = [
      width ? `width:${width}px` : '',
      height ? `height:${height}px` : '',
      align === 'center' ? 'display:block;margin-left:auto;margin-right:auto' : align === 'right' ? 'display:block;margin-left:auto' : '',
    ].filter(Boolean).join(';');
    return ['img', mergeAttributes(rest as Record<string, string>, { style, title: caption as string | undefined })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LetterImageNodeView);
  },
});

// ── Page break — no stock TipTap node for this at all. An atom block node
// rendered as a plain visual divider in the editor; the backend renderer
// (letterBodyPdfRenderer.ts) interprets it as a forced new-page directive. ──
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },
  renderHTML() {
    return ['div', { 'data-page-break': 'true', class: 'letter-body-page-break' }, ['span', {}, 'Page break']];
  },
});

// ── Table cell/header (letterBodyDoc.ts's cellAttrsSchema) ──────────────────
// colspan/rowspan/colwidth/align already come from the stock extensions
// (@tiptap/extension-table-cell/-header — align via createAlignAttribute(),
// which normalizes to exactly 'left'/'center'/'right'/null); valign/
// background/padding/per-side borders do not. `align` must NOT be
// redeclared here: this object is spread AFTER `...this.parent?.()` in
// addAttributes() below, so redefining it with a bare `{default: null}`
// (no parseHTML/renderHTML) silently overrides the parent's real
// implementation with TipTap's generic fallback parser — which reads the
// raw, unvalidated `align` DOM attribute instead of the normalized value,
// letting a stray Word-exported value straight through to the backend
// schema's strict `z.enum(['left','center','right'])` and failing
// validation on save/preview. Found 2026-09-22 tracing a "Validation
// failed" report on a pasted Word table.
/** WPS Office (and some Word versions) write `vertical-align: center` on
 *  table cells — not a value the CSS/HTML vertical-align property actually
 *  defines (the vertical equivalent of 'center' is 'middle'), but a real
 *  value real pasted documents carry. Normalizes it the same way `align`
 *  already is by the stock extension, instead of passing it through raw and
 *  failing the backend's `z.enum(['top','middle','bottom'])`. */
function normalizeValign(raw: string | null | undefined): 'top' | 'middle' | 'bottom' | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'center' || v === 'centre' || v === 'middle') return 'middle';
  if (v === 'top' || v === 'bottom') return v;
  return null;
}

function cellAttributes() {
  return {
    valign: {
      default: null,
      parseHTML: (el: HTMLElement) => normalizeValign(el.style.verticalAlign || el.getAttribute('valign')),
      renderHTML: (a: { valign?: string | null }) => (a.valign ? { style: `vertical-align:${a.valign}` } : {}),
    },
    background: { default: null, parseHTML: (el: HTMLElement) => el.style.backgroundColor || null, renderHTML: (a: { background?: string | null }) => (a.background ? { style: `background-color:${a.background}` } : {}) },
    padding: { default: null },
    borderTop: { default: null },
    borderRight: { default: null },
    borderBottom: { default: null },
    borderLeft: { default: null },
  };
}
export const LetterTableCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttributes() }; } });
export const LetterTableHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...cellAttributes() }; } });

// ── Shared extension list ───────────────────────────────────────────────────
// The single source of truth for "which nodes/marks does a letter body
// support" on the frontend — used by both the editable LetterBodyEditor and
// the read-only LetterBodyView, so a letter renders identically whichever
// component displays it. `editable` only gates whether Placeholder shows
// empty-state text; it does not affect ProseMirror's own editable flag
// (each caller's useEditor({editable}) controls that separately).
export function getLetterBodyExtensions(opts: { placeholder?: string } = {}): AnyExtension[] {
  return [
    StarterKit.configure({ paragraph: false }),
    LetterParagraph,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    TextStyle,
    ColorExtension,
    FontSize,
    UnderlineExtension,
    SubscriptExtension,
    SuperscriptExtension,
    HighlightExtension.configure({ multicolor: true }),
    Placeholder.configure({ placeholder: opts.placeholder ?? '' }),
    CharacterCount,
    LinkExtension.configure({ openOnClick: false, autolink: true }),
    LetterImage,
    PageBreak,
    Table.configure({ resizable: true }),
    TableRow,
    LetterTableCell,
    LetterTableHeader,
  ];
}

// ── Color sanitization ───────────────────────────────────────────────────────
// Same pattern letterBodyDoc.ts's `colorAttr` validates against on the
// backend — kept identical so a value this function accepts is guaranteed to
// pass the backend's schema too.
const HEX_OR_RGB_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/;

// @tiptap/extension-text-style's Color mark (and Highlight, which follows
// the same pattern) reads a mark's `color` straight from the raw inline
// `style` attribute text (core's `getStyleProperty`, added in TipTap v3 to
// preserve the author's original hex format) rather than through the
// browser's CSSOM — which means it never gets the normalization a computed
// style would apply. Word and, especially, WPS Office routinely write
// `color:windowtext` / `background:window` for "the default/automatic
// color" instead of an actual hex value (legacy CSS2 system-color
// keywords) — neither is a hex or rgb() value, so it used to reach the
// backend's strict schema unchanged and fail the whole save/preview over
// what is, visually, just "default black text." Mapped to their real
// rendered color instead of merely being dropped, so pasted formatting
// isn't lost along with the fix.
const LEGACY_COLOR_KEYWORDS: Record<string, string> = {
  windowtext: '#000000',
  window: '#ffffff',
  buttonface: '#f0f0f0',
  infotext: '#000000',
  infobackground: '#ffffe1',
  captiontext: '#000000',
  graytext: '#808080',
  threedface: '#c0c0c0',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  transparent: '',
};

/** Returns a color the backend schema will accept, or `null` to drop the
 *  color entirely (falls back to the document's default text color) rather
 *  than blocking the save on a value nothing downstream can render anyway. */
function sanitizeColorValue(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (HEX_OR_RGB_COLOR.test(trimmed)) return trimmed;
  const mapped = LEGACY_COLOR_KEYWORDS[trimmed.toLowerCase()];
  return mapped || null;
}

type JsonNode = { type?: string; attrs?: Record<string, unknown>; marks?: JsonNode[]; content?: JsonNode[] };

/** Walks an `editor.getJSON()` tree fixing up values a stock TipTap
 *  extension can produce (from pasted Word/WPS content) that the backend's
 *  stricter schema doesn't accept — `textStyle`/`highlight` mark colors and
 *  table-cell `valign`. Run on every save (LetterBodyEditor's onUpdate), not
 *  only at paste time, so it also cleans up content that was already pasted
 *  into the editor before this normalization existed — no re-paste required.
 *  Mutates and returns the same tree; safe because `getJSON()` returns a
 *  fresh object graph on every call. */
export function sanitizeLetterBodyDoc<T extends JsonNode>(node: T): T {
  if (node.marks) {
    for (const mark of node.marks) {
      if ((mark.type === 'textStyle' || mark.type === 'highlight') && mark.attrs && 'color' in mark.attrs) {
        mark.attrs.color = sanitizeColorValue(mark.attrs.color);
      }
    }
  }
  if (node.attrs && 'valign' in node.attrs) {
    node.attrs.valign = normalizeValign(node.attrs.valign as string | null);
  }
  if (node.content) {
    for (const child of node.content) sanitizeLetterBodyDoc(child);
  }
  return node;
}

/** `content` is either a JSON-stringified doc (new letters) or a legacy
 *  plain-text string (every letter saved before this feature). TipTap's
 *  `content` option accepts a plain string as literal text OR a JSON doc
 *  object — passing a bare string here would insert the literal `{"type":
 *  "doc"...}` text into the editor for a structured letter, so this checks
 *  first. Shared by LetterBodyEditor and LetterBodyView. */
export function parseLetterBodyContent(raw: string): string | object {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"type"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}
