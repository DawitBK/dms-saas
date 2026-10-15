'use client';

// Renders a PDF already fetched into a blob: URL, via react-pdf's canvas
// rendering — NOT a bare <iframe src={blobUrl}>. Confirmed live (2026-09-16):
// a plain iframe pointed at a blob: PDF renders completely blank in this
// app's actual browser/CSP environment (no console error, no network error —
// it just never paints), while this exact react-pdf pattern (already used by
// documents/[id]/page.tsx's own "File" tab, the one preview in this app that
// reliably worked) renders correctly. Any new "preview this PDF inline"
// surface should use this component, not an iframe.
import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { PaginationControls } from './ui/PaginationControls';
import { useResetOnChange } from '../hooks/useResetOnChange';
import { pdfDocumentImport, pdfPageImport } from '../lib/pdfWorker';

const PdfDocument = dynamic(pdfDocumentImport, { ssr: false });
const PdfPage = dynamic(pdfPageImport, { ssr: false });

export function PdfBlobPreview({
  blobUrl,
  maxWidth = 680,
  className = '',
  keepPageOnReload = false,
  exactPage = null,
  caretRatio = null,
}: {
  blobUrl: string;
  maxWidth?: number;
  className?: string;
  // A caller re-rendering the SAME conceptual document after every edit (the
  // letter composer's debounced live preview generates a brand-new blob: URL
  // per keystroke pause) wants the reader's current page left alone, not
  // jumped back to page 1 — that read as "editing resets the preview" even
  // though nothing about the letter's content actually changed pages. Callers
  // that show a genuinely different document per blobUrl (viewing one file,
  // then another) leave this false and keep the page-1 reset.
  keepPageOnReload?: boolean;
  // The exact 1-based page the caller already knows the caret is on (e.g. the
  // letter composer resolving LetterBodyEditor's caretPosition().blockIndex
  // against the preview response's per-block page map) — takes priority over
  // everything else below when given. This is what makes the preview "the
  // page I'm on," not just "not reset to page 1" or a rough guess.
  exactPage?: number | null;
  // 0..1 fraction of the way down the SOURCE document the caret sits, used
  // ONLY when exactPage isn't available yet (e.g. the map hasn't loaded for
  // this render) — a coarser fallback, since the editor's own line-wrapping
  // rarely matches the PDF's exactly.
  caretRatio?: number | null;
}) {
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  // Tracks numPages across reloads independently of the `numPages` state
  // (which keepPageOnReload deliberately leaves untouched between reloads —
  // see below) so onLoadSuccess can tell "grew" from "shrank" from "same".
  const prevNumPagesRef = useRef(0);
  const tracked = exactPage !== null || caretRatio !== null;

  // A new document (different blobUrl) restarts at page 1 — unless the
  // caller opted into keepPageOnReload.
  useResetOnChange([blobUrl], () => {
    if (keepPageOnReload) return;
    setPageNum(1);
    setNumPages(0);
    prevNumPagesRef.current = 0;
  });

  // Caret-driven sync: whenever the caret moves (or the page count changes
  // under it) and we know how many pages there are, jump straight to the
  // page it falls on — exactly, if the caller resolved one, else by rough
  // proportion. Takes priority over the page-preserving/follow-the-tail
  // logic in onLoadSuccess below — that logic exists for callers with no
  // caret to track at all.
  useResetOnChange([exactPage, caretRatio, numPages], () => {
    if (numPages <= 0) return;
    if (exactPage !== null) {
      setPageNum(Math.min(Math.max(exactPage, 1), numPages));
    } else if (caretRatio !== null) {
      setPageNum(Math.min(numPages, Math.floor(caretRatio * numPages) + 1));
    }
  });

  return (
    <div className={className}>
      <div className="flex justify-center">
        <PdfDocument
          key={blobUrl}
          file={blobUrl}
          onLoadSuccess={({ numPages: n }) => {
            const prev = prevNumPagesRef.current;
            // When a caret is being tracked, the [exactPage, caretRatio,
            // numPages] useResetOnChange above owns pageNum entirely once
            // `numPages` updates below — setting it here too would just race it.
            if (!tracked) {
              setPageNum((p) => {
                // Composing a letter is written top-to-bottom, so a reader who
                // was already on the LAST page before this edit was watching
                // the tail of the document as it grows — when a new page
                // appears (n > prev), follow it there instead of leaving them
                // stranded on what is now a stale, no-longer-final page while
                // the compose pane has long since scrolled past it. A reader
                // who deliberately paged back to review something earlier
                // (p < prev) is left alone. `prev > 0` excludes the very first
                // load, which must always land on page 1, not jump ahead.
                if (keepPageOnReload && prev > 0 && n > prev && p >= prev) return n;
                // The refreshed document may otherwise have fewer pages than
                // the one being viewed (content trimmed mid-edit) — clamp
                // rather than let react-pdf be asked to render a page that no
                // longer exists.
                return Math.min(Math.max(p, 1), n) || 1;
              });
            }
            prevNumPagesRef.current = n;
            setNumPages(n);
          }}
          loading={
            <div className="h-48 flex items-center justify-center">
              <RefreshCw className="h-5 w-5 animate-spin" style={{ color: 'var(--brand-600)' }} />
            </div>
          }
          error={
            <div className="h-32 flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--danger, #dc2626)' }}>
              <AlertCircle className="h-4 w-4" /> Failed to render PDF
            </div>
          }
        >
          <PdfPage pageNumber={pageNum} width={maxWidth} renderTextLayer renderAnnotationLayer />
        </PdfDocument>
      </div>
      {numPages > 1 && (
        <PaginationControls
          page={pageNum}
          onPageChange={setPageNum}
          hasPrevious={pageNum > 1}
          hasNext={pageNum < numPages}
          totalPages={numPages}
        />
      )}
    </div>
  );
}
