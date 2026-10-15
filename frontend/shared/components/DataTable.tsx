"use client";

import React from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

interface Column<T> {
  key: string;
  header?: string;
  label?: string;
  render?: (value: unknown, item: T) => React.ReactNode;
  sortable?: boolean;
  className?: string;
  /** If true, this column is hidden on the mobile card view. Defaults to false. */
  mobileHidden?: boolean;
  /** If set, this label is used as the card field label instead of header/label. */
  mobileLabel?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor?: (item: T) => string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  emptyState?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
  selectedId?: string;
  /**
   * Column key whose rendered value becomes the card title on mobile.
   * Falls back to the first non-hidden, non-empty-header column.
   */
  mobileTitleKey?: string;
  /**
   * Column key whose rendered value becomes the card subtitle/secondary line.
   */
  mobileSubtitleKey?: string;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = 'No data',
  emptyState,
  isLoading = false,
  className = '',
  selectedId,
  mobileTitleKey,
  mobileSubtitleKey,
}: DataTableProps<T>) {
  const defaultKey = (item: T) => String((item as any).id ?? JSON.stringify(item));

  // Client-side sorting for columns marked `sortable`. Previously the prop was
  // declared and passed but did nothing.
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const toggleSort = (key: string) =>
    setSort((prev) =>
      prev?.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null,
    );
  const sortedData = React.useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return data;
    const val = (item: T) => (item as any)[sort.key];
    return [...data].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [data, sort, columns]);

  if (isLoading) {
    return (
      <div className="py-10 flex justify-center">
        <span
          className="h-6 w-6 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--brand-500)' }}
        />
      </div>
    );
  }

  if (data.length === 0) {
    return emptyState ? (
      <>{emptyState}</>
    ) : (
      <div className="py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {emptyMessage}
      </div>
    );
  }

  // Columns shown as labelled fields in the card body (exclude title, subtitle, action/icon columns)
  const cardBodyCols = columns.filter(
    (c) =>
      !c.mobileHidden &&
      c.key !== mobileTitleKey &&
      c.key !== mobileSubtitleKey &&
      (c.header ?? c.label), // skip icon/action columns that have no label
  );

  const titleCol = mobileTitleKey
    ? columns.find((c) => c.key === mobileTitleKey)
    : columns.find((c) => !c.mobileHidden && (c.header ?? c.label));

  const subtitleCol = mobileSubtitleKey
    ? columns.find((c) => c.key === mobileSubtitleKey)
    : undefined;

  return (
    <>
      {/* ── Desktop: standard table (hidden on mobile) ─────────────────────── */}
      <div
        className={`hidden md:block overflow-hidden ${className}`}
        style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}
      >
        <div className="overflow-x-auto ui-scrollbar">
          <table className="ui-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`ui-th ${col.className ?? ''} ${col.sortable ? 'cursor-pointer select-none' : ''}`}
                    onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header ?? col.label}
                      {col.sortable && (
                        sort?.key === col.key
                          ? (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
                          : <ChevronsUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedData.map((item) => {
                const key = (keyExtractor ?? defaultKey)(item);
                const isSelected = selectedId === key;
                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick?.(item)}
                    className={`ui-tr ${isSelected ? 'ui-tr-selected' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
                  >
                    {columns.map((col) => (
                      <td key={col.key} className={`ui-td ${col.className ?? ''}`}>
                        {col.render
                          ? col.render((item as any)[col.key], item)
                          : String((item as any)[col.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Mobile: card list (hidden on md+) ──────────────────────────────── */}
      <div className="md:hidden space-y-2">
        {sortedData.map((item) => {
          const key = (keyExtractor ?? defaultKey)(item);
          const isSelected = selectedId === key;

          // Columns that have no label and no header are "icon/action" columns — render them in a row
          const leadCols = columns.filter(
            (c) => !c.mobileHidden && !(c.header ?? c.label),
          );

          // Interactive props only when the card is actually clickable. A
          // <button> is not available here: cards can contain nested
          // interactive elements (the row checkbox some callers render into a
          // lead column), and nesting those inside a button is invalid HTML.
          // role="button" + tabIndex + a keyboard handler is the supported
          // fallback, and it gives these cards the keyboard path they had no
          // form of before — the desktop <tr> above is exempt because a table
          // row already carries an implicit non-interactive role.
          const rowInteraction = onRowClick
            ? {
                onClick: () => onRowClick(item),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(item);
                  }
                },
                role: 'button',
                tabIndex: 0,
              }
            : {};

          return (
            <div
              key={key}
              {...rowInteraction}
              className={`rounded-xl border p-4 transition-colors ${
                isSelected
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                  : 'border-[var(--border)] bg-[var(--surface-card)]'
              } ${onRowClick ? 'cursor-pointer active:bg-surface-raised' : ''}`}
            >
              {/* Card header row: lead icon/action cols + title */}
              <div className="flex items-start gap-3 mb-2">
                {leadCols.map((c) => (
                  <div key={c.key} className="shrink-0 mt-0.5">
                    {c.render
                      ? c.render((item as any)[c.key], item)
                      : null}
                  </div>
                ))}
                <div className="flex-1 min-w-0">
                  {titleCol && (
                    <div className="text-sm font-semibold text-[var(--text-primary)] leading-snug truncate">
                      {titleCol.render
                        ? titleCol.render((item as any)[titleCol.key], item)
                        : String((item as any)[titleCol.key] ?? '')}
                    </div>
                  )}
                  {subtitleCol && (
                    <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                      {subtitleCol.render
                        ? subtitleCol.render((item as any)[subtitleCol.key], item)
                        : String((item as any)[subtitleCol.key] ?? '')}
                    </div>
                  )}
                </div>
              </div>

              {/* Card body: labelled field pills */}
              {cardBodyCols.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 pt-2 border-t border-[var(--border)]">
                  {cardBodyCols.map((c) => {
                    const rendered = c.render
                      ? c.render((item as any)[c.key], item)
                      : String((item as any)[c.key] ?? '');
                    if (!rendered && rendered !== 0) return null;
                    return (
                      <div key={c.key} className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                          {c.mobileLabel ?? c.header ?? c.label}
                        </span>
                        <span className="text-xs text-[var(--text-secondary)]">
                          {rendered}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
