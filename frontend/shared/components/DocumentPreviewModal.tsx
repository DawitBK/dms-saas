'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { X, Download, FileText, Loader2, AlertCircle } from 'lucide-react';
import { downloadDocumentUrl } from '../../features/documents/api';
import { apiClientBlob } from '../lib/apiClient';
import { FileTypeIcon } from './FileTypeIcon';
import { useResetOnChange } from '../hooks/useResetOnChange';

interface DocumentPreviewModalProps {
  documentId: string | null;
  title: string;
  mimeType?: string;
  documentName?: string;
  onClose: () => void;
}

export function DocumentPreviewModal({
  documentId,
  title,
  mimeType = '',
  documentName = '',
  onClose,
}: DocumentPreviewModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);

  // Clearing the previous document's preview is a pure function of documentId,
  // so it is adjusted during render rather than in the effect
  // (react-hooks/set-state-in-effect). On mount these already hold exactly
  // these values, so it only fires for a genuine document change — which is
  // also when the previous file would otherwise have stayed visible for a frame.
  useResetOnChange([documentId], () => {
    if (!documentId) return;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setTextContent(null);
  });

  useEffect(() => {
    if (!documentId) return;

    // apiClientBlob (axios) rejects on non-2xx and gets the same
    // silent-refresh-on-401 retry every other request gets, instead of a
    // bare fetch() that would blob-ify and silently "preview" a JSON error
    // body if the access token expired while this modal was open.
    apiClientBlob(downloadDocumentUrl(documentId))
      .then(async (blob) => {
        const isDirectlyReadable =
          mimeType.startsWith('text/') ||
          mimeType === 'application/json' ||
          mimeType === 'application/xml' ||
          mimeType === 'text/xml' ||
          mimeType === 'text/csv';

        if (isDirectlyReadable) {
          const text = await blob.text();
          setTextContent(text);
        } else {
          const objUrl = URL.createObjectURL(blob);
          setBlobUrl(objUrl);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (!documentId) return null;

  const isPdf = mimeType.includes('pdf');
  const isImage = mimeType.startsWith('image/');
  const isText =
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'text/xml' ||
    mimeType === 'text/csv';
  const isPreviewable = isPdf || isImage || isText;

  const handleDownload = async () => {
    try {
      const blob = await apiClientBlob(downloadDocumentUrl(documentId));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = documentName || title;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      {/* Click-outside scrim. A sibling of the panel rather than its parent,
          so the panel needs no stopPropagation() and carries no click handler
          of its own. role="presentation" is accurate: this layer is a mouse
          convenience, and the dialog's own Close button is the keyboard path
          out. */}
      <div className="absolute inset-0" onClick={onClose} role="presentation" />
      <div
        className="relative bg-surface-card rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Document preview"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <FileTypeIcon mimeType={mimeType} size={20} />
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-text-primary truncate">{title}</h3>
              {documentName && (
                <p className="text-xs text-text-muted font-mono truncate">{documentName}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-raised rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto min-h-0 bg-surface-raised">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 text-brand-500 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 text-center px-6">
              <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
              <p className="text-sm font-semibold text-text-secondary">Failed to load preview</p>
              <p className="text-xs text-text-muted mt-1">{error}</p>
              <button
                onClick={handleDownload}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
              >
                <Download className="h-3.5 w-3.5" /> Download Instead
              </button>
            </div>
          ) : isPdf && blobUrl ? (
            <iframe src={blobUrl} className="w-full h-[70vh] border-0" title={title} />
          ) : isImage && blobUrl ? (
            <div className="flex items-center justify-center p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={blobUrl} alt={title} className="max-w-full max-h-[70vh] rounded-lg shadow-md" />
            </div>
          ) : isText && textContent !== null ? (
            <pre className="p-6 text-sm font-mono text-text-secondary whitespace-pre-wrap break-words overflow-auto max-h-[70vh]">
              {textContent}
            </pre>
          ) : !isPreviewable ? (
            <div className="flex flex-col items-center justify-center h-64 text-center px-6">
              <FileText className="h-10 w-10 text-text-muted/40 mb-3" />
              <p className="text-sm font-semibold text-text-secondary">
                Preview not available for this file type
              </p>
              <p className="text-xs text-text-muted mt-1">
                {mimeType || 'Unknown type'} — Download to view the full document.
              </p>
              <button
                onClick={handleDownload}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
