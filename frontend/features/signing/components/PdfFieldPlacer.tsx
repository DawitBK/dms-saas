'use client';

// Freeform field placement (esigning.service.ts "Surface 1"): the sender picks
// a recipient + field type, then clicks the rendered page to drop a marker.
// Click coordinates are normalized to PDF point-space (72pt/inch) immediately,
// matching what the backend already expects — replacing the previous
// hardcoded single fixed-position signature field per recipient.

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { downloadDocumentUrl } from '../../documents/api';
import { apiClientBlob } from '../../../shared/lib/apiClient';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';

// Dynamically imported (react-pdf pulls in pdfjs, a large parser this page
// doesn't need until a document is actually being field-placed).
const PdfDocument = dynamic(() => import('react-pdf').then((m) => m.Document), { ssr: false });
const PdfPage = dynamic(() => import('react-pdf').then((m) => m.Page), { ssr: false });

export type FieldType = 'signature' | 'initial' | 'date' | 'text' | 'seal';

export type FieldMarker = {
  id: string;
  // FIX (platform audit finding 2026-08-14): this used to be a raw
  // recipientIndex into the `recipients` array as it existed AT PLACEMENT
  // TIME. Removing a signer (or an incomplete row getting silently filtered
  // out at submit — see signing/page.tsx's createRequest) shifts every
  // later recipient's array position without ever touching already-placed
  // fields, so a field placed for signer #3 would silently end up assigned
  // to whoever now sits at position 2 once submitted — the wrong person,
  // with no error. recipientKey is a stable identifier (recipient.key, set
  // once when the signer is added and never recomputed), so a field keeps
  // pointing at the right person regardless of what happens to the array
  // around it. The numeric index the backend actually expects is derived
  // fresh from the final, submitted recipient order right before sending
  // (see page.tsx's createRequest).
  recipientKey: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: FieldType;
};

const FIELD_DEFAULT_SIZE: Record<FieldType, { width: number; height: number }> = {
  signature: { width: 130, height: 32 },
  initial: { width: 50, height: 32 },
  date: { width: 90, height: 22 },
  text: { width: 110, height: 22 },
  seal: { width: 60, height: 60 },
};

const RENDER_WIDTH = 620;

// One stable color per signer, cycled by their position in `recipients` —
// UX fix (2026-09-19): with every marker drawn in the same violet regardless
// of who it belonged to, and the active signer buried in a plain <select>
// easy to forget to change before the next click, a 3-signer request was
// live-observed landing with fields placed for only 1 of the 3 (nobody
// noticed the other 2 silently had none until the recipients complained
// they had nothing to sign). Red is deliberately excluded — this component
// already uses red exclusively for "field points at a removed signer" (see
// the marker below), and reusing it here for an ordinary signer would make
// a normal, valid field look like an error.
const SIGNER_COLORS = [
  { border: '#6366f1', bg: 'rgba(99,102,241,0.20)', text: '#4338ca' }, // indigo
  { border: '#10b981', bg: 'rgba(16,185,129,0.20)', text: '#047857' }, // emerald
  { border: '#f59e0b', bg: 'rgba(245,158,11,0.20)', text: '#b45309' }, // amber
  { border: '#ec4899', bg: 'rgba(236,72,153,0.20)', text: '#be185d' }, // pink
  { border: '#3b82f6', bg: 'rgba(59,130,246,0.20)', text: '#1d4ed8' }, // blue
  { border: '#a855f7', bg: 'rgba(168,85,247,0.20)', text: '#7e22ce' }, // purple
  { border: '#14b8a6', bg: 'rgba(20,184,166,0.20)', text: '#0f766e' }, // teal
  { border: '#84cc16', bg: 'rgba(132,204,22,0.20)', text: '#4d7c0f' }, // lime
];
function colorForRecipient(index: number) {
  return SIGNER_COLORS[index % SIGNER_COLORS.length];
}

export function PdfFieldPlacer({
  documentId,
  mimeType,
  recipients,
  value,
  onChange,
}: {
  documentId: string;
  mimeType?: string;
  recipients: Array<{ key: string; name: string; email: string }>;
  value: FieldMarker[];
  onChange: (fields: FieldMarker[]) => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nativeSize, setNativeSize] = useState<{ width: number; height: number } | null>(null);
  const [activeRecipient, setActiveRecipient] = useState(0);
  const [activeFieldType, setActiveFieldType] = useState<FieldType>('signature');
  const [numPages, setNumPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    import('react-pdf').then(({ pdfjs }) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    });
  }, []);

  // Everything here that is a pure function of documentId/mimeType — the
  // unsupported-type message and resetting the previous document's preview
  // state — is adjusted during render. Only the blob fetch below is a real
  // effect. Besides satisfying react-hooks/set-state-in-effect, this stops the
  // placer rendering the PREVIOUS document's page for a frame after the
  // document changes.
  useResetOnChange([documentId, mimeType], () => {
    if (!documentId) return;
    if (mimeType && mimeType !== 'application/pdf') {
      setError(`This file type (${mimeType}) can't be field-placed — only PDF documents support signature field placement.`);
      setBlobUrl(null);
      return;
    }
    setError(null);
    setBlobUrl(null);
    setNumPages(1);
    setCurrentPage(1);
  });

  useEffect(() => {
    if (!documentId) return;
    if (mimeType && mimeType !== 'application/pdf') return;
    let objectUrl: string | null = null;
    apiClientBlob(downloadDocumentUrl(documentId))
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setBlobUrl(objectUrl);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load document preview'));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [documentId, mimeType]);

  // Clamp the selected recipient when one is removed. Adjusted during render,
  // not in an effect: the effect version rendered one frame pointing at a
  // recipient that no longer exists.
  if (activeRecipient >= recipients.length && activeRecipient !== 0) setActiveRecipient(0);

  // Page size (e.g. a landscape page mixed into a mostly-portrait doc) can
  // differ per page, so re-measure on every page change rather than reusing
  // page 1's dimensions for the click-to-PDF-point scale math.
  useResetOnChange([currentPage], () => {
    setNativeSize(null);
  });

  const scale = nativeSize ? RENDER_WIDTH / nativeSize.width : 1;
  const renderHeight = nativeSize ? nativeSize.height * scale : 0;

  const onPageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!nativeSize || recipients.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickXpx = e.clientX - rect.left;
    const clickYpx = e.clientY - rect.top;
    const size = FIELD_DEFAULT_SIZE[activeFieldType];
    // PDF origin is bottom-left; browser click origin is top-left.
    const x = clickXpx / scale;
    const y = nativeSize.height - clickYpx / scale - size.height;
    onChange([
      ...value,
      {
        id: crypto.randomUUID(),
        recipientKey: recipients[activeRecipient].key,
        pageNumber: currentPage,
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: size.width,
        height: size.height,
        fieldType: activeFieldType,
      },
    ]);
  };

  const removeMarker = (id: string) => onChange(value.filter((f) => f.id !== id));

  return (
    <div>
      {recipients.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] font-semibold uppercase mb-1.5" style={{ color: 'var(--text-muted)' }}>
            1. Pick who you&apos;re placing a field for
          </p>
          <div className="flex flex-wrap gap-1.5">
            {recipients.map((r, i) => {
              const color = colorForRecipient(i);
              const count = value.filter((f) => f.recipientKey === r.key).length;
              const active = i === activeRecipient;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setActiveRecipient(i)}
                  className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-[box-shadow]"
                  style={{
                    background: color.bg,
                    color: color.text,
                    border: `1.5px solid ${color.border}`,
                    boxShadow: active ? `0 0 0 2px ${color.border}55` : 'none',
                    opacity: active ? 1 : 0.72,
                  }}
                  title={count === 0 ? `${r.name || `Signer ${i + 1}`} has no fields placed yet` : undefined}
                >
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ background: color.border, color: '#fff' }}
                  >
                    {i + 1}
                  </span>
                  {r.name || `Signer ${i + 1}`}
                  <span
                    className="inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
                    style={count === 0 ? { background: 'var(--danger, #dc2626)', color: '#fff' } : { background: 'rgba(255,255,255,0.6)', color: color.text }}
                  >
                    {count === 0 ? '! 0' : count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[11px] font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>2. Field type</span>
        <select
          value={activeFieldType}
          onChange={(e) => setActiveFieldType(e.target.value as FieldType)}
          className="ui-input !w-auto text-xs"
        >
          <option value="signature">Signature</option>
          <option value="initial">Initials</option>
          <option value="date">Date</option>
          <option value="text">Text</option>
          <option value="seal">Seal</option>
        </select>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          then click the page — it&apos;ll be placed for{' '}
          <strong style={{ color: recipients[activeRecipient] ? colorForRecipient(activeRecipient).text : undefined }}>
            {recipients[activeRecipient]?.name || (recipients.length === 0 ? 'no one yet' : `Signer ${activeRecipient + 1}`)}
          </strong>{' '}
          (highlighted above)
        </span>
      </div>
      {recipients.length > 0 && value.length > 0 && recipients.some((r) => value.filter((f) => f.recipientKey === r.key).length === 0) && (
        <p className="mb-2 text-xs flex items-center gap-1" style={{ color: 'var(--danger, #dc2626)' }}>
          ⚠ {recipients.filter((r) => value.filter((f) => f.recipientKey === r.key).length === 0).map((r, idx, arr) => `${r.name || 'a signer'}${idx < arr.length - 1 ? ', ' : ''}`).join('')} still {recipients.filter((r) => value.filter((f) => f.recipientKey === r.key).length === 0).length === 1 ? 'has' : 'have'} no field placed — pick them above and click the document.
        </p>
      )}

      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}

      {blobUrl && numPages > 1 && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="ui-btn ui-btn-secondary !py-1 !px-2 disabled:opacity-40"
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Page {currentPage} of {numPages}</span>
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="ui-btn ui-btn-secondary !py-1 !px-2 disabled:opacity-40"
            title="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          {value.length > 0 && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {value.filter((f) => f.pageNumber === currentPage).length} field{value.filter((f) => f.pageNumber === currentPage).length === 1 ? '' : 's'} on this page
            </span>
          )}
        </div>
      )}

      {blobUrl && recipients.length === 0 && (
        <p className="mb-2 text-xs" style={{ color: 'var(--danger)' }}>
          Add a signer above first — clicking the document won&apos;t place a field until there&apos;s someone to assign it to.
        </p>
      )}

      {blobUrl && (
        // The one place in this frontend where the jsx-a11y click rules are
        // suppressed rather than satisfied, and deliberately so. This handler
        // places a signature field at the exact page coordinate that was
        // clicked; there is no keyboard analogue for "point at x,y" short of
        // building a coordinate-entry or crosshair-navigation UI, and giving
        // the surface role="button" with an Enter handler would be a fake —
        // it would have to invent a position the user never chose. The
        // markers it creates ARE keyboard operable (role="button", tabIndex,
        // Enter/Space to remove, just below), so nothing placed here is
        // trapped. Remove this suppression if a keyboard placement affordance
        // is ever added.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          className="relative inline-block rounded-md border overflow-hidden"
          style={{ borderColor: 'var(--border)', cursor: recipients.length === 0 ? 'not-allowed' : 'crosshair' }}
          onClick={onPageClick}
        >
          <PdfDocument file={blobUrl} loading={<div className="h-48 w-[620px]" />} onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}>
            <PdfPage
              key={currentPage}
              pageNumber={currentPage}
              width={RENDER_WIDTH}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              onLoadSuccess={(page) => setNativeSize({ width: page.originalWidth, height: page.originalHeight })}
            />
          </PdfDocument>
          {nativeSize &&
            value
              .filter((f) => f.pageNumber === currentPage)
              .map((f) => {
                const recipientIdx = recipients.findIndex((r) => r.key === f.recipientKey);
                const recipient = recipientIdx >= 0 ? recipients[recipientIdx] : undefined;
                const color = recipientIdx >= 0 ? colorForRecipient(recipientIdx) : null;
                return (
                  <div
                    key={f.id}
                    onClick={(e) => { e.stopPropagation(); removeMarker(f.id); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removeMarker(f.id); } }}
                    title="Click to remove"
                    className="absolute flex items-center justify-center gap-1 text-[10px] font-semibold rounded"
                    style={{
                      left: f.x * scale,
                      top: renderHeight - (f.y + f.height) * scale,
                      width: f.width * scale,
                      height: f.height * scale,
                      background: color ? color.bg : 'rgba(220,38,38,0.25)',
                      border: `1.5px solid ${color ? color.border : 'var(--danger)'}`,
                      color: color ? color.text : 'var(--danger)',
                      cursor: 'pointer',
                    }}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                    {recipient ? `${recipientIdx + 1}. ${recipient.name?.slice(0, 8) || `Signer ${recipientIdx + 1}`}` : 'removed signer'} · {f.fieldType}
                  </div>
                );
              })}
        </div>
      )}

      {value.length > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {value.length} field{value.length === 1 ? '' : 's'} placed — click a marker to remove it.
        </p>
      )}
    </div>
  );
}
