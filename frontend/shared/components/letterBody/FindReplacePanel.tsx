'use client';

import { useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { X, ChevronUp, ChevronDown } from 'lucide-react';

type Match = { from: number; to: number };

/** TipTap ships no find/replace extension — this walks the document's text
 *  nodes directly (ProseMirror's own `doc.descendants`) rather than
 *  operating on the serialized string, so match positions are real document
 *  positions `setTextSelection`/`insertContentAt` can act on directly. */
function findMatches(editor: Editor, query: string): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  const needle = query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = node.text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      matches.push({ from: pos + index, to: pos + index + needle.length });
      index = haystack.indexOf(needle, index + 1);
    }
  });
  return matches;
}

export function FindReplacePanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Recomputed on every render (editor content changes trigger a re-render
  // via onUpdate in the parent) rather than cached — a find/replace panel
  // over a letter body is never large enough for this to matter. doc is
  // deliberately excluded from the dep array: it's a new object identity on
  // every transaction, which would make this useMemo recompute unconditionally
  // anyway (no memoization benefit) — kept as a plain call so that's explicit
  // rather than implied by an exhaustive-deps-satisfying but pointless entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => findMatches(editor, query), [editor, query, editor.state.doc]);

  const goTo = (index: number) => {
    if (!matches.length) return;
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setActiveIndex(wrapped);
    const m = matches[wrapped]!;
    editor.chain().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
  };

  const replaceCurrent = () => {
    if (!matches.length) return;
    const m = matches[activeIndex]!;
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, replacement).run();
  };

  const replaceAll = () => {
    if (!matches.length) return;
    // Reverse order so earlier replacements never shift the positions of
    // matches not yet processed.
    let chain = editor.chain().focus();
    for (const m of [...matches].reverse()) {
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replacement);
    }
    chain.run();
  };

  return (
    <div className="w-full flex items-center gap-2 px-2 py-1.5 border-t border-border bg-surface-raised text-xs">
      <input
        autoFocus
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
        placeholder="Find…"
        className="w-32 px-2 py-1 border border-border rounded bg-surface-base"
      />
      <span className="text-text-muted whitespace-nowrap">{matches.length ? `${activeIndex + 1}/${matches.length}` : '0/0'}</span>
      <button type="button" onClick={() => goTo(activeIndex - 1)} className="p-1 rounded hover:bg-surface-hover" title="Previous"><ChevronUp className="h-3.5 w-3.5" /></button>
      <button type="button" onClick={() => goTo(activeIndex + 1)} className="p-1 rounded hover:bg-surface-hover" title="Next"><ChevronDown className="h-3.5 w-3.5" /></button>
      <input
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        placeholder="Replace with…"
        className="w-32 px-2 py-1 border border-border rounded bg-surface-base"
      />
      <button type="button" onClick={replaceCurrent} disabled={!matches.length} className="ui-btn ui-btn-secondary py-1 px-2 text-xs disabled:opacity-40">Replace</button>
      <button type="button" onClick={replaceAll} disabled={!matches.length} className="ui-btn ui-btn-secondary py-1 px-2 text-xs disabled:opacity-40">Replace all</button>
      <button type="button" onClick={onClose} className="ml-auto p-1 rounded hover:bg-surface-hover" title="Close"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
