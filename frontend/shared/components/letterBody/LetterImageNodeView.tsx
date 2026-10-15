'use client';

// A body image's `src` is `/letters/body-images/:id` — an AUTHENTICATED
// endpoint (requirePermission(LETTER_READ)), not a public URL. A plain
// `<img src="...">` can't attach the Bearer token axios adds for every other
// request in this app, so this NodeView fetches the bytes through
// apiClientBlob (same as PdfBlobPreview.tsx's PDF preview) and renders a
// blob: URL instead — the same reason that component exists, applied to the
// editor's own image display.
import { useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { apiClientBlob } from '../../lib/apiClient';

export function LetterImageNodeView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const { src, width, align, caption } = node.attrs as { src: string; width?: number | null; align?: string | null; caption?: string | null };
  // Keyed to `src` rather than reset with a synchronous setState at the top
  // of the effect: a plain `setError(false)` there would fire on every
  // render the effect re-runs, before the async fetch below has a chance to
  // resolve, causing a cascading render. Trusting `result` only when it
  // matches the CURRENT src achieves the same "clear stale error when the
  // image changes" behavior without ever setting state outside the async
  // callbacks themselves.
  const [result, setResult] = useState<{ src: string; blobUrl: string | null; error: boolean }>({ src: '', blobUrl: null, error: false });
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    apiClientBlob(src)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ src, blobUrl: objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ src, blobUrl: null, error: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  const blobUrl = result.src === src ? result.blobUrl : null;
  const error = result.src === src && result.error;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = { startX: e.clientX, startWidth: width ?? 300 };
    const onMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = moveEvent.clientX - resizingRef.current.startX;
      updateAttributes({ width: Math.max(40, Math.round(resizingRef.current.startWidth + delta)) });
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <NodeViewWrapper
      className="letter-body-image"
      style={{
        display: 'flex',
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        margin: '8px 0',
      }}
    >
      <div style={{ position: 'relative', display: 'inline-block', outline: selected ? '2px solid var(--brand-500, #6366f1)' : 'none' }}>
        {error ? (
          <div className="flex items-center gap-2 p-4 text-sm text-rose-600 border border-rose-200 rounded">
            <AlertCircle className="h-4 w-4" /> Image failed to load
          </div>
        ) : blobUrl ? (
          // next/image requires a static/remote URL it can optimize at
          // request time; a blob: URL from an authenticated fetch (see file
          // header) is neither, and is revoked/replaced per src change
          // regardless.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={blobUrl} alt={caption ?? ''} style={{ width: width ? `${width}px` : '300px', height: 'auto', display: 'block' }} />
        ) : (
          <div className="flex items-center justify-center h-24 w-48 border border-dashed border-border rounded">
            <RefreshCw className="h-4 w-4 animate-spin text-text-muted" />
          </div>
        )}
        {selected && !error && (
          <button
            type="button"
            aria-label="Resize image"
            onMouseDown={startResize}
            style={{
              position: 'absolute', right: -4, bottom: -4, width: 12, height: 12, padding: 0, border: 'none',
              background: 'var(--brand-500, #6366f1)', borderRadius: 2, cursor: 'nwse-resize',
            }}
          />
        )}
        {caption && <div className="text-xs text-text-muted text-center mt-1">{caption}</div>}
      </div>
    </NodeViewWrapper>
  );
}
