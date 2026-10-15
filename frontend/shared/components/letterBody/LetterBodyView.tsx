'use client';

// Read-only display of a letter's body — the letter detail page's own read
// view and the revision-history body viewer. Uses the SAME extension set as
// the editable LetterBodyEditor (getLetterBodyExtensions) so a structured
// body (rich text, tables, images, ...) renders with its actual formatting
// instead of the old `bodyHtml.replace(/<[^>]+>/g, '')` treatment, which
// assumed bodyHtml was always either plain text or literal HTML — never
// true for a structured letter's JSON-stringified doc, which that regex
// would have shown as a raw, unreadable JSON blob (no `<...>` tags for it to
// strip).
import { useEditor, EditorContent } from '@tiptap/react';
import { getLetterBodyExtensions, parseLetterBodyContent } from '../../lib/letterBodyExtensions';

export function LetterBodyView({ content, className = '' }: { content: string; className?: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: getLetterBodyExtensions(),
    content: parseLetterBodyContent(content),
  });

  if (!editor) return null;
  return (
    <div className={`letter-body-readonly ${className}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
