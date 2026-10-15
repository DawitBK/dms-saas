'use client';

// Backend has supported word-level version diffing since Phase 5
// (GET /documents/:id/versions/diff?v1=&v2= — documents.routes.ts, LCS-based),
// but no page ever called it: the Versions tab only ever listed version rows,
// with no way to see what actually changed between two of them. This modal
// closes that gap with a minimal compare UI, reusing the version list the
// document detail page already has loaded.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitCompare, RefreshCw, X } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';

type DiffSegment = { type: 'eq' | 'add' | 'del'; value: string };

export type VersionDiffOption = { id: string; versionNumber: string };

type DiffResponse = {
  v1: { id: string; versionNumber: string; createdAt: string };
  v2: { id: string; versionNumber: string; createdAt: string };
  diff: DiffSegment[];
  stats: { additions: number; deletions: number; unchanged: number };
};

export function VersionDiffModal({
  documentId,
  versions,
  onClose,
}: {
  documentId: string;
  versions: VersionDiffOption[];
  onClose: () => void;
}) {
  const [v1, setV1] = useState(versions[1]?.id ?? versions[0]?.id ?? '');
  const [v2, setV2] = useState(versions[0]?.id ?? '');

  const canCompare = !!v1 && !!v2 && v1 !== v2;

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['version-diff', documentId, v1, v2],
    queryFn: () =>
      apiClient<{ data: DiffResponse }>(
        `/documents/${documentId}/versions/diff?v1=${v1}&v2=${v2}`,
      ).then((r) => r.data),
    enabled: canCompare,
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-brand-600" /> Compare Versions
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-border shrink-0">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            From
            <select className="ui-input text-sm" value={v1} onChange={(e) => setV1(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            To
            <select className="ui-input text-sm" value={v2} onChange={(e) => setV2(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
                </option>
              ))}
            </select>
          </label>
          {data && (
            <span className="ml-auto text-xs font-mono">
              <span className="text-green-600 font-bold">+{data.stats.additions}</span>{' '}
              <span className="text-red-600 font-bold">-{data.stats.deletions}</span>{' '}
              <span className="text-text-muted">{data.stats.unchanged} unchanged</span>
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar p-5">
          {!canCompare ? (
            <p className="text-sm text-text-muted text-center py-10">
              Select two different versions to compare.
            </p>
          ) : isFetching ? (
            <div className="py-10 flex justify-center">
              <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
            </div>
          ) : isError ? (
            <p className="text-sm text-red-600 text-center py-10">
              {(error as Error)?.message ?? 'Failed to compute diff.'}
            </p>
          ) : data && data.diff.length > 0 ? (
            <p className="text-sm leading-loose whitespace-pre-wrap font-mono">
              {data.diff.map((seg, i) => (
                <span
                  key={i}
                  className={
                    seg.type === 'add'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                      : seg.type === 'del'
                        ? 'bg-red-100 text-red-800 line-through dark:bg-red-900/40 dark:text-red-300'
                        : 'text-text-secondary'
                  }
                >
                  {seg.value}{' '}
                </span>
              ))}
            </p>
          ) : (
            <p className="text-sm text-text-muted italic text-center py-10">
              No extracted text available for one or both versions — OCR/text extraction may not have run yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
