'use client';

// The Letter Body rich-text editor — replaces the plain <textarea> that used
// to be the entirety of "compose the letter body." Produces a structured
// ProseMirror/TipTap JSON document (editor.getJSON()) that the caller
// JSON.stringifies into the `bodyHtml` form field — the backend
// (letterBodyDoc.ts) validates and renders that same JSON, not HTML.
//
// Extension list here is the frontend half of the shared document contract;
// the backend half is letterBodyDoc.ts's Zod schema. Every node/mark type
// enabled below must have a matching case there, or content created here
// will fail to save.
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import {
  Bold as BoldIcon, Italic as ItalicIcon, UnderlineIcon, Strikethrough, Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon, AlignLeft, AlignCenter, AlignRight, AlignJustify, List as ListIcon,
  ListOrdered, IndentIncrease, IndentDecrease, Table as TableIcon, ImagePlus, Link as LinkIcon,
  Link2Off, Minus, FileText, Quote, Highlighter, Eraser, Search, Undo2, Redo2, Trash2, Plus,
  Rows3, Columns3, Palette, Sigma,
} from 'lucide-react';
import { getLetterBodyExtensions, parseLetterBodyContent, sanitizeLetterBodyDoc } from '../../lib/letterBodyExtensions';
import { uploadLetterBodyImage } from '../../../features/letters/api';
import { FindReplacePanel } from './FindReplacePanel';
import { TableGridPicker } from './TableGridPicker';
import { SpecialCharPicker } from './SpecialCharPicker';

const FONT_FAMILIES = [
  { label: 'Default', value: null },
  { label: 'Helvetica', value: 'Helvetica' },
  { label: 'Times', value: 'Times-Roman' },
  { label: 'Courier', value: 'Courier' },
];
const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24];
const HIGHLIGHT_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff'];
const TEXT_COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#ca8a04', '#7c3aed'];

function ToolbarButton({ onClick, active, disabled, title, children }: { onClick: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex items-center justify-center h-7 w-7 rounded text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active ? 'bg-brand-100 text-brand-700' : 'text-text-secondary hover:bg-surface-hover'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-border mx-1 self-center" />;
}

// Returns a tuple, not an object — react-hooks' refs lint rule treats
// reading a property off an object that also carries a ref as "accessing a
// ref during render" even for unrelated properties (e.g. `.open`). Callers
// destructure immediately into independent plain variables instead, the
// same shape as useState/useRef themselves.
function useDropdown(): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void, React.RefObject<HTMLDivElement | null>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);
  return [open, setOpen, ref];
}

function Toolbar({ editor }: { editor: Editor }) {
  const [showFind, setShowFind] = useState(false);
  const [fontOpen, setFontOpen, fontRef] = useDropdown();
  const [sizeOpen, setSizeOpen, sizeRef] = useDropdown();
  const [colorOpen, setColorOpen, colorRef] = useDropdown();
  const [highlightOpen, setHighlightOpen, highlightRef] = useDropdown();
  const [tableOpen, setTableOpen, tableRef] = useDropdown();
  const [symbolOpen, setSymbolOpen, symbolRef] = useDropdown();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const insertImageFile = useCallback(async (file: File | Blob) => {
    try {
      const { data } = await uploadLetterBodyImage(file);
      editor.chain().focus().setImage({ src: data.url, width: Math.min(data.width, 400) } as never).run();
    } catch {
      // Upload failure degrades to "nothing inserted" — the toolbar action
      // simply appears to do nothing rather than corrupting the document
      // with a broken image reference.
    }
  }, [editor]);

  const setLink = useCallback(() => {
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previousUrl ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const inTable = editor.isActive('table');

  return (
    <div className="flex flex-wrap items-center gap-0.5 p-1.5 border-b border-border bg-surface-raised rounded-t-xl">
      <ToolbarButton title="Undo" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}><Undo2 className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Redo" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}><Redo2 className="h-4 w-4" /></ToolbarButton>
      <Divider />

      <div className="relative" ref={fontRef}>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setFontOpen((o) => !o)} className="h-7 px-2 text-xs rounded hover:bg-surface-hover flex items-center gap-1">
          Font
        </button>
        {fontOpen && (
          <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
            {FONT_FAMILIES.map((f) => (
              <button key={f.label} type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { f.value ? editor.chain().focus().setMark('textStyle', { fontFamily: f.value }).run() : editor.chain().focus().unsetMark('textStyle').run(); setFontOpen(false); }}
                className="block w-full text-left px-3 py-1 text-xs hover:bg-surface-hover">{f.label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="relative" ref={sizeRef}>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setSizeOpen((o) => !o)} className="h-7 px-2 text-xs rounded hover:bg-surface-hover">Size</button>
        {sizeOpen && (
          <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg py-1 min-w-[60px]">
            {FONT_SIZES.map((s) => (
              <button key={s} type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { (editor.commands as unknown as { setFontSize: (n: number) => boolean }).setFontSize(s); setSizeOpen(false); }}
                className="block w-full text-left px-3 py-1 text-xs hover:bg-surface-hover">{s}</button>
            ))}
          </div>
        )}
      </div>
      <Divider />

      <ToolbarButton title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><BoldIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><ItalicIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Superscript" active={editor.isActive('superscript')} onClick={() => editor.chain().focus().toggleSuperscript().run()}><SuperscriptIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Subscript" active={editor.isActive('subscript')} onClick={() => editor.chain().focus().toggleSubscript().run()}><SubscriptIcon className="h-4 w-4" /></ToolbarButton>

      <div className="relative" ref={colorRef}>
        <ToolbarButton title="Text color" onClick={() => setColorOpen((o) => !o)}><Palette className="h-4 w-4" /></ToolbarButton>
        {colorOpen && (
          <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg p-2 flex gap-1">
            {TEXT_COLORS.map((c) => (
              <button key={c} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { editor.chain().focus().setColor(c).run(); setColorOpen(false); }}
                style={{ background: c }} className="h-5 w-5 rounded-full border border-border" />
            ))}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { editor.chain().focus().unsetColor().run(); setColorOpen(false); }} className="h-5 w-5 rounded-full border border-border flex items-center justify-center text-[9px]">×</button>
          </div>
        )}
      </div>
      <div className="relative" ref={highlightRef}>
        <ToolbarButton title="Highlight" active={editor.isActive('highlight')} onClick={() => setHighlightOpen((o) => !o)}><Highlighter className="h-4 w-4" /></ToolbarButton>
        {highlightOpen && (
          <div className="absolute z-20 top-8 left-0 bg-surface-raised border border-border rounded-lg shadow-lg p-2 flex gap-1">
            {HIGHLIGHT_COLORS.map((c) => (
              <button key={c} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { editor.chain().focus().toggleHighlight({ color: c }).run(); setHighlightOpen(false); }}
                style={{ background: c }} className="h-5 w-5 rounded-full border border-border" />
            ))}
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { editor.chain().focus().unsetHighlight().run(); setHighlightOpen(false); }} className="h-5 w-5 rounded-full border border-border flex items-center justify-center text-[9px]">×</button>
          </div>
        )}
      </div>
      <ToolbarButton title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><Eraser className="h-4 w-4" /></ToolbarButton>
      <Divider />

      <ToolbarButton title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Justify" active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}><AlignJustify className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton
        title="Decrease indent"
        onClick={() => editor.chain().focus().updateAttributes('paragraph', { indent: Math.max(0, (Number(editor.getAttributes('paragraph').indent) || 0) - 1) }).run()}
      ><IndentDecrease className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton
        title="Increase indent"
        onClick={() => editor.chain().focus().updateAttributes('paragraph', { indent: Math.min(10, (Number(editor.getAttributes('paragraph').indent) || 0) + 1) }).run()}
      ><IndentIncrease className="h-4 w-4" /></ToolbarButton>
      <Divider />

      <ToolbarButton title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><ListIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Block quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></ToolbarButton>
      <Divider />

      <div className="relative" ref={tableRef}>
        <ToolbarButton title="Insert table" onClick={() => setTableOpen((o) => !o)}><TableIcon className="h-4 w-4" /></ToolbarButton>
        {tableOpen && (
          <TableGridPicker
            onPick={(rows, cols) => {
              editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
              setTableOpen(false);
            }}
          />
        )}
      </div>
      {inTable && (
        <>
          <ToolbarButton title="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}><Rows3 className="h-4 w-4" /></ToolbarButton>
          <ToolbarButton title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}><Rows3 className="h-4 w-4 opacity-50" /></ToolbarButton>
          <ToolbarButton title="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}><Columns3 className="h-4 w-4" /></ToolbarButton>
          <ToolbarButton title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}><Columns3 className="h-4 w-4 opacity-50" /></ToolbarButton>
          <ToolbarButton title="Merge cells" onClick={() => editor.chain().focus().mergeCells().run()}><Plus className="h-4 w-4 rotate-45" /></ToolbarButton>
          <ToolbarButton title="Split cell" onClick={() => editor.chain().focus().splitCell().run()}><Plus className="h-4 w-4" /></ToolbarButton>
          <ToolbarButton title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 className="h-4 w-4" /></ToolbarButton>
        </>
      )}
      <Divider />

      <ToolbarButton title="Insert image" onClick={() => fileInputRef.current?.click()}><ImagePlus className="h-4 w-4" /></ToolbarButton>
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertImageFile(f); e.target.value = ''; }} />
      <ToolbarButton title="Insert link" active={editor.isActive('link')} onClick={setLink}><LinkIcon className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Remove link" disabled={!editor.isActive('link')} onClick={() => editor.chain().focus().unsetLink().run()}><Link2Off className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus className="h-4 w-4" /></ToolbarButton>
      <ToolbarButton title="Page break" onClick={() => editor.chain().focus().insertContent({ type: 'pageBreak' }).run()}><FileText className="h-4 w-4" /></ToolbarButton>
      <div className="relative" ref={symbolRef}>
        <ToolbarButton title="Insert symbol" onClick={() => setSymbolOpen((o) => !o)}><Sigma className="h-4 w-4" /></ToolbarButton>
        {symbolOpen && (
          <SpecialCharPicker onPick={(ch) => { editor.chain().focus().insertContent(ch).run(); setSymbolOpen(false); }} />
        )}
      </div>
      <Divider />
      <ToolbarButton title="Find and replace" active={showFind} onClick={() => setShowFind((v) => !v)}><Search className="h-4 w-4" /></ToolbarButton>

      {showFind && <FindReplacePanel editor={editor} onClose={() => setShowFind(false)} />}
    </div>
  );
}

export type CaretPosition = {
  // 0..1 fraction of the editor's own rendered height the caret sits at —
  // 0 is the very top of the letter body, 1 the very bottom. Only a rough
  // fallback for a caller with no exact page to go on yet (see below).
  ratio: number;
  // Index into the document's TOP-LEVEL content array (doc.content) that the
  // caret is currently inside — ProseMirror's $pos.index(0). The backend's
  // structured-body renderer walks that same array in the same order
  // (letterBodyPdfRenderer.ts's drawLetterBodyDoc), so this index is exactly
  // what its per-block page map (letters.routes.ts's X-Letter-Block-Pages) is
  // keyed by — a caller with that map can resolve this to an EXACT page
  // instead of the ratio guess.
  blockIndex: number;
};

// `coordsAtPos`/`getBoundingClientRect` are both viewport-relative at the
// moment they're called, so `ratio` comes out correct regardless of how far
// the page has been scrolled; no scroll-container bookkeeping needed.
function caretPosition(editor: Editor): CaretPosition | null {
  try {
    const rect = editor.view.dom.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const { $from } = editor.state.selection;
    const coords = editor.view.coordsAtPos($from.pos);
    const ratio = Math.min(1, Math.max(0, (coords.top - rect.top) / rect.height));
    return { ratio, blockIndex: $from.index(0) };
  } catch {
    // coordsAtPos can throw for a position that's momentarily out of sync
    // with the view mid-transaction — skip this update rather than crash the
    // editor over what is, at worst, one stale preview page.
    return null;
  }
}

export function LetterBodyEditor({
  content,
  onChange,
  placeholder = 'Write the letter body…',
  onCaretPositionChange,
}: {
  content: string; // JSON-stringified doc, or legacy plain text
  onChange: (json: string) => void;
  placeholder?: string;
  // Reports caretPosition() on every caret move/edit, so a caller (the live
  // preview pane) can jump to the corresponding page. Optional — most
  // embeddings of this editor (e.g. read-only review) have no preview to sync.
  onCaretPositionChange?: (pos: CaretPosition) => void;
}) {
  const reportCaretPosition = (e: Editor) => {
    if (!onCaretPositionChange) return;
    const pos = caretPosition(e);
    if (pos !== null) onCaretPositionChange(pos);
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: getLetterBodyExtensions({ placeholder }),
    content: parseLetterBodyContent(content),
    onUpdate: ({ editor: e }) => {
      onChange(JSON.stringify(sanitizeLetterBodyDoc(e.getJSON())));
      reportCaretPosition(e);
    },
    onSelectionUpdate: ({ editor: e }) => reportCaretPosition(e),
    editorProps: {
      attributes: { class: 'letter-body-prosemirror' },
      handlePaste: (view, event) => {
        // Word's HTML clipboard (incl. real <table> markup) arrives as
        // text/html and ProseMirror's own clipboard parser already turns it
        // into real table/list/paragraph nodes via the schema above — no
        // custom handling needed for the common case. This override exists
        // for image paste only: a screenshot/copied image lands as a
        // clipboard FILE (text/html has nothing to offer), which ProseMirror
        // does not upload anywhere on its own.
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              uploadLetterBodyImage(file).then(({ data }) => {
                const { schema } = view.state;
                const node = schema.nodes.image!.create({ src: data.url, width: Math.min(data.width, 400) });
                view.dispatch(view.state.tr.replaceSelectionWith(node));
              }).catch(() => { /* paste silently drops the image on upload failure */ });
              return true;
            }
          }
        }
        return false;
      },
    },
  });

  if (!editor) return null;

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-surface-base">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      <div className="px-3 py-1 text-[11px] text-text-muted border-t border-border">
        {editor.storage.characterCount.characters()} characters
      </div>
    </div>
  );
}

