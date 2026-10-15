// SPRINT-4/5: browse/list UI will need ACL-aware data access once permission and search work are complete.
'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { apiClient, apiClientBlob } from '../../../shared/lib/apiClient';
import { listDocuments, downloadDocumentUrl } from '../../../features/documents/api';
import { useAuthStore } from '../../../state/auth.store';
import { formatTenantName } from '../../../shared/lib/tenant';
import { HierarchyTreeBrowser, TENANT_ROOT_ID, type TreeNode } from '../../../features/hierarchy/HierarchyTreeBrowser';
import { TopBar } from '../../../shared/components/TopBar';
import { useUIStore } from '../../../state/ui.store';
import {
  useBrowseLayoutStore,
  clampBrowseTreeWidth,
  BROWSE_TREE_DEFAULT_WIDTH,
  BROWSE_TREE_MIN_WIDTH,
  BROWSE_TREE_MAX_WIDTH,
} from '../../../state/browseLayout.store';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { FileTypeIcon } from '../../../shared/components/FileTypeIcon';
import { DocumentPreviewModal } from '../../../shared/components/DocumentPreviewModal';
import { format, startOfHour, startOfDay, startOfWeek, startOfMonth, startOfYear } from 'date-fns';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  Home,
  FileText,
  RefreshCw,
  Search,
  Building2,
  Layers,
  Download,
  Eye,
  ArrowUp,
  ArrowDown,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

type DocPeriod = 'all' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'custom';
type DocSortField = 'updatedAt' | 'createdAt' | 'title';
type DocSortDir = 'ASC' | 'DESC';

// Folder-browse only ever has documents from the tenant this user is already
// scoped to, so "hourly/daily/weekly/monthly/yearly" is offered as a
// date-range filter on top of the existing folder tree — not a separate
// auto-created folder layer (no such thing exists in the folder hierarchy;
// see FolderNode) — plus an open-ended custom range for anything the presets
// don't cover.
const PERIOD_OPTIONS: { value: DocPeriod; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'hour', label: 'Past hour' },
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range…' },
];

const SORT_FIELD_OPTIONS: { value: DocSortField; label: string }[] = [
  { value: 'updatedAt', label: 'Modified' },
  { value: 'createdAt', label: 'Uploaded' },
  { value: 'title', label: 'Name' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_REVIEW', label: 'Pending Review' },
  { value: 'IN_REVIEW', label: 'In Review' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
  { value: 'DISPOSAL_PENDING', label: 'Disposal Pending' },
];

function periodToDateFrom(period: DocPeriod): string | undefined {
  const now = new Date();
  if (period === 'hour') return startOfHour(now).toISOString();
  if (period === 'day') return startOfDay(now).toISOString();
  if (period === 'week') return startOfWeek(now).toISOString();
  if (period === 'month') return startOfMonth(now).toISOString();
  if (period === 'year') return startOfYear(now).toISOString();
  return undefined;
}

type DocFilterState = {
  q: string;
  status: string;
  period: DocPeriod;
  // Only read when period === 'custom'; plain "YYYY-MM-DD" from <input type="date">,
  // same convention as the global search page's From/To Date fields.
  customFrom: string;
  customTo: string;
  sortField: DocSortField;
  sortDir: DocSortDir;
};

const DEFAULT_DOC_FILTERS: DocFilterState = {
  q: '',
  status: '',
  period: 'all',
  customFrom: '',
  customTo: '',
  sortField: 'updatedAt',
  sortDir: 'DESC',
};

function docFiltersToApi(f: DocFilterState) {
  const dateFrom = f.period === 'custom' ? f.customFrom || undefined : periodToDateFrom(f.period);
  const dateTo = f.period === 'custom' ? f.customTo || undefined : undefined;
  return {
    q: f.q.trim() || undefined,
    status: f.status || undefined,
    dateFrom,
    dateTo,
    sortBy: f.sortField,
    sortDir: f.sortDir,
  };
}

// A filter is anything that narrows the result set; sort is a view
// preference, not a filter, so it's excluded from "is anything active" /
// the chip list on purpose — clearing filters shouldn't silently also
// reorder the list out from under someone who just picked a sort.
function hasActiveDocFilters(f: DocFilterState): boolean {
  return Boolean(f.q.trim() || f.status || f.period !== 'all');
}

function docFilterChips(f: DocFilterState): { id: string; label: string; clear: Partial<DocFilterState> }[] {
  const chips: { id: string; label: string; clear: Partial<DocFilterState> }[] = [];
  if (f.q.trim()) chips.push({ id: 'q', label: `"${f.q.trim()}"`, clear: { q: '' } });
  if (f.status) {
    chips.push({
      id: 'status',
      label: STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? f.status,
      clear: { status: '' },
    });
  }
  if (f.period !== 'all') {
    const label =
      f.period === 'custom'
        ? `${f.customFrom || '…'} → ${f.customTo || 'now'}`
        : PERIOD_OPTIONS.find((o) => o.value === f.period)?.label ?? f.period;
    chips.push({ id: 'period', label, clear: { period: 'all', customFrom: '', customTo: '' } });
  }
  return chips;
}

function DocFilterBar({
  filters,
  onChange,
  isFetching,
}: {
  filters: DocFilterState;
  onChange: (next: DocFilterState) => void;
  isFetching?: boolean;
}) {
  const [qInput, setQInput] = useState(filters.q);
  // Debounce the free-text box only — status/period/sort apply immediately,
  // same pattern as the global search page's live-search debounce.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (qInput !== filters.q) onChange({ ...filters, q: qInput });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);
  // Keep the box in sync when a filter chip or "Clear all" resets q externally.
  useResetOnChange([filters.q], () => {
    if (filters.q !== qInput && filters.q === '') setQInput('');
  });

  const chips = docFilterChips(filters);
  const isDefault = !hasActiveDocFilters(filters) && filters.sortField === DEFAULT_DOC_FILTERS.sortField && filters.sortDir === DEFAULT_DOC_FILTERS.sortDir;

  return (
    <div className="border-b border-border bg-surface-raised/40">
      <div className="flex flex-wrap items-end gap-3 px-6 py-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
            Search
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Filter by title or filename..."
              className="ui-input pl-8 pr-8 py-1.5 text-xs w-full"
            />
            {isFetching && (
              <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-3 w-3 text-text-muted animate-spin" />
            )}
          </div>
        </div>

        <div className="w-40">
          <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
            Status
          </label>
          <select
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value })}
            className="ui-input py-1.5 text-xs w-full"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="w-40">
          <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
            Period
          </label>
          <select
            value={filters.period}
            onChange={(e) => onChange({ ...filters, period: e.target.value as DocPeriod })}
            className="ui-input py-1.5 text-xs w-full"
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {filters.period === 'custom' && (
          <>
            <div className="w-36">
              <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
                From
              </label>
              <input
                type="date"
                value={filters.customFrom}
                onChange={(e) => onChange({ ...filters, customFrom: e.target.value })}
                className="ui-input py-1.5 text-xs w-full"
              />
            </div>
            <div className="w-36">
              <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
                To
              </label>
              <input
                type="date"
                value={filters.customTo}
                onChange={(e) => onChange({ ...filters, customTo: e.target.value })}
                className="ui-input py-1.5 text-xs w-full"
              />
            </div>
          </>
        )}

        <div className="flex items-end gap-1.5">
          <div className="w-32">
            <label className="block text-[10px] font-bold uppercase tracking-wide text-text-muted mb-1">
              Sort by
            </label>
            <select
              value={filters.sortField}
              onChange={(e) => onChange({ ...filters, sortField: e.target.value as DocSortField })}
              className="ui-input py-1.5 text-xs w-full"
            >
              {SORT_FIELD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => onChange({ ...filters, sortDir: filters.sortDir === 'ASC' ? 'DESC' : 'ASC' })}
            title={filters.sortDir === 'ASC' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            className="ui-btn ui-btn-secondary ui-btn-icon h-[30px] w-[30px]"
          >
            {filters.sortDir === 'ASC' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {!isDefault && (
          <button
            onClick={() => { setQInput(''); onChange(DEFAULT_DOC_FILTERS); }}
            className="text-xs font-bold text-text-muted hover:text-brand-600 pb-1.5"
          >
            Reset
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-3">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-indigo-500/10 text-indigo-600 text-[11px] font-semibold"
            >
              {chip.label}
              <button
                onClick={() => onChange({ ...filters, ...chip.clear })}
                className="p-0.5 hover:bg-indigo-500/20 rounded-full transition-colors"
                aria-label={`Remove filter ${chip.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type FolderNode = {
  id: string;
  name: string;
  path: string;
  level: number;
  parentId: string | null;
  departmentId: string | null;
  isSystemManaged: boolean;
};

const LEVEL_LABELS: Record<number, string> = {
  0: 'Repository',
  1: 'Organisation',
  2: 'Department',
  3: 'Category',
};

const LEVEL_COLORS: Record<number, string> = {
  0: 'bg-surface-raised text-text-muted border-border',
  1: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/30',
  2: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
  3: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
};

// FIX 2026-09-14: folder creation has no depth limit (an admin can nest a
// folder under any existing folder, e.g. Category -> sub-folder -> ...), but
// these two maps only ever covered the four FIXED levels every tenant starts
// with. A folder deeper than level 3 rendered a blank badge (a lookup miss
// isn't a crash, just `undefined`) — this fallback treats any such folder as
// a plain, uncategorized "Folder" rather than leaving the badge empty.
function levelLabel(level: number): string {
  return LEVEL_LABELS[level] ?? 'Folder';
}
function levelColor(level: number): string {
  return LEVEL_COLORS[level] ?? LEVEL_COLORS[3];
}

// 15/page, matching the project-wide pagination convention.
const DOCS_PAGE_SIZE = 15;

export default function BrowsePage() {
  const { userId, role, tenantId } = useAuthStore();
  const enabled = Boolean(userId && role);
  const tenantName = formatTenantName(tenantId);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; title: string; mimeType: string; documentName: string } | null>(null);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  // Folder-hierarchy panel: collapsible and drag-resizable, remembered per
  // browser. `dragWidth` is the uncommitted width while the handle is held, so
  // the panel tracks the pointer without writing storage on every move.
  const treeCollapsed = useBrowseLayoutStore((s) => s.treeCollapsed);
  const toggleTreeCollapsed = useBrowseLayoutStore((s) => s.toggleTreeCollapsed);
  const storedTreeWidth = useBrowseLayoutStore((s) => s.treeWidth);
  const setTreeWidth = useBrowseLayoutStore((s) => s.setTreeWidth);
  const [dragTreeWidth, setDragTreeWidth] = useState<number | null>(null);
  const treeWidth = dragTreeWidth ?? storedTreeWidth;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: treeWidth };
    setDragTreeWidth(treeWidth);
  };
  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDragTreeWidth(clampBrowseTreeWidth(d.startWidth + (e.clientX - d.startX)));
  };
  const endResize = () => {
    if (dragRef.current && dragTreeWidth !== null) setTreeWidth(dragTreeWidth);
    dragRef.current = null;
    setDragTreeWidth(null);
  };
  const onResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setTreeWidth(treeWidth - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setTreeWidth(treeWidth + step); }
    else if (e.key === 'Home') { e.preventDefault(); setTreeWidth(BROWSE_TREE_DEFAULT_WIDTH); }
  };

  const { data: treeData } = useQuery({
    queryKey: ['folder-tree'],
    queryFn: () => apiClient<{ data: FolderNode[] }>('/folders/tree'),
    enabled,
    staleTime: 60_000,
  });

  const allFolders: FolderNode[] = treeData?.data ?? [];
  const root = allFolders.find((f) => f.level === 0);

  const { data: currentData, isLoading } = useQuery({
    queryKey: ['folder', currentId],
    queryFn: () =>
      apiClient<{
        data: {
          folder: FolderNode;
          ancestors: FolderNode[];
          children: FolderNode[];
        };
      }>(`/folders/${currentId}`),
    enabled: enabled && currentId !== null,
    staleTime: 30_000,
  });

  // §6: At root, derive state from tree data — GET /folders?parentId=null returns a flat array, not the detail shape
  const current =
    currentId === null && root
      ? {
          folder: root,
          ancestors: [] as FolderNode[],
          children: allFolders
            .filter((f) => f.parentId === root.id)
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : currentData?.data;

  // FIX 2026-09-14: was `level === 3` — treated only the fixed "Category"
  // depth as document-bearing. Folders can be nested arbitrarily deep under
  // a category (createFolder has no depth limit), and every one of them
  // shares the department's scope just like the category folder itself, so
  // any folder at or past that depth should show the same documents+upload
  // card instead of a dead end.
  const folderIdForDocs = current?.folder && current.folder.level >= 3 ? currentId : null;

  const [folderDocsPage, setFolderDocsPage] = useState(1);
  const [docFilters, setDocFilters] = useState<DocFilterState>(DEFAULT_DOC_FILTERS);
  // Keyset (cursor) pagination — see app/dashboard/documents/page.tsx's own
  // copy of this comment for the full rationale. cursorForPage[p] is the
  // cursor that fetches page p+1, learned from page p's own response.
  const [folderDocsCursorForPage, setFolderDocsCursorForPage] = useState<Record<number, string>>({});
  useResetOnChange([folderIdForDocs], () => {
    setFolderDocsPage(1);
    setFolderDocsCursorForPage({});
  });
  // A filter change should also reset to page 1, same as switching folders —
  // otherwise a narrower result set can land on a page past its own end.
  useResetOnChange([docFilters], () => {
    setFolderDocsPage(1);
    setFolderDocsCursorForPage({});
  });
  const folderDocsCursor = folderDocsPage > 1 ? folderDocsCursorForPage[folderDocsPage - 1] : undefined;

  const { data: folderDocsPageData, isFetching: folderDocsFetching } = useQuery({
    queryKey: ['folder-documents', folderIdForDocs, folderDocsPage, docFilters, folderDocsCursor],
    queryFn: () =>
      listDocuments((folderDocsPage - 1) * DOCS_PAGE_SIZE, DOCS_PAGE_SIZE, {
        folderId: folderIdForDocs!,
        ...docFiltersToApi(docFilters),
        cursor: folderDocsCursor,
      }),
    enabled: enabled && Boolean(folderIdForDocs),
    staleTime: 30_000,
  });
  useResetOnChange([folderDocsPageData?.nextCursor, folderDocsPage], () => {
    const next = folderDocsPageData?.nextCursor;
    if (next) {
      setFolderDocsCursorForPage((prev) => (prev[folderDocsPage] === next ? prev : { ...prev, [folderDocsPage]: next }));
    }
  });
  const folderDocs = folderDocsPageData?.data;
  const folderDocsTotal = folderDocsPageData?.total ?? folderDocs?.length ?? 0;
  const folderDocsTotalPages = Math.max(1, Math.ceil(folderDocsTotal / DOCS_PAGE_SIZE));
  const folderDocsHasNext = Boolean(folderDocsPageData?.nextCursor);
  const ancestors = current?.ancestors ?? [];
  const children = current?.children ?? [];
  const rootLoading = currentId === null && !treeData;
  const detailLoading = currentId !== null && isLoading;

  const stats = {
    departments: allFolders.filter((f) => f.level === 2).length,
    categories: allFolders.filter((f) => f.level === 3).length,
    total: allFolders.length,
  };

  // Bridge the real org hierarchy tree (tenant → org unit → dept → folder) to the
  // FolderNode-driven main pane. Folder nodes carry a real FolderNode id, so they
  // drive it directly; a department maps to its materialized level-2 folder so the
  // pane shows that department's category folders + documents; org unit / tenant
  // reset to the repository root.
  const handleTreeSelect = (node: TreeNode) => {
    if (node.type === 'folder') {
      setCurrentId(node.id);
    } else if (node.type === 'department') {
      const deptFolder = allFolders.find((f) => f.level === 2 && f.departmentId === node.id);
      setCurrentId(deptFolder?.id ?? null);
    } else {
      // tenant or org unit → repository root overview
      setCurrentId(null);
    }
  };

  return (
    <>
      <TopBar
        title="Browse Repository"
        breadcrumbs={[
          { label: 'Repository', href: '/dashboard' },
          { label: 'Browse' },
        ]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-[1920px] mx-auto w-full">
        <div className="mb-8 flex flex-col md:flex-row justify-between items-start gap-4">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">
              Document Repository
            </h1>
            <p className="text-text-muted mt-1">
              Browse the canonical folder hierarchy and navigate to department
              repositories.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-surface-raised text-text-secondary rounded-full text-xs font-bold border border-border">
            <Layers className="h-3.5 w-3.5" /> {stats.total} folders ·{' '}
            {stats.departments} depts · {stats.categories} categories
          </div>
        </div>

        <div className="flex flex-col xl:flex-row gap-6 xl:items-start">
          {/* Organization hierarchy sidebar: tenant → org unit → department → folder.
              Collapsible (button) and resizable (drag the right edge, or focus it
              and use the arrow keys); both are remembered. */}
          {treeCollapsed ? (
            <aside className="ui-card bg-surface-card border border-border rounded-2xl p-2 xl:shrink-0 self-start">
              <button
                type="button"
                onClick={toggleTreeCollapsed}
                className="ui-btn ui-btn-secondary ui-btn-icon h-9 w-9"
                aria-label="Show folder hierarchy"
                title="Show folder hierarchy"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </aside>
          ) : (
            <aside
              className="ui-card bg-surface-card border border-border rounded-2xl overflow-hidden relative xl:shrink-0 w-full xl:w-[var(--browse-tree-width)] xl:sticky xl:top-0"
              style={{ ['--browse-tree-width' as string]: `${treeWidth}px` }}
            >
              <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                <Layers className="h-4 w-4 text-indigo-500" />
                <h2 className="text-sm font-bold text-text-secondary flex-1">Hierarchy</h2>
                <button
                  type="button"
                  onClick={toggleTreeCollapsed}
                  className="ui-btn ui-btn-secondary ui-btn-icon h-8 w-8"
                  aria-label="Hide folder hierarchy"
                  title="Hide folder hierarchy"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
              <div className="p-3 max-h-[calc(100vh-14rem)] min-h-[16rem] overflow-y-auto ui-scrollbar">
                <HierarchyTreeBrowser
                  mode="select"
                  compact
                  tenantName={tenantName}
                  onNodeSelect={handleTreeSelect}
                  selectedId={currentId ?? TENANT_ROOT_ID}
                  scopeToViewer
                />
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize folder hierarchy"
                aria-valuemin={BROWSE_TREE_MIN_WIDTH}
                aria-valuemax={BROWSE_TREE_MAX_WIDTH}
                aria-valuenow={treeWidth}
                tabIndex={0}
                onPointerDown={onResizePointerDown}
                onPointerMove={onResizePointerMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onKeyDown={onResizeKeyDown}
                onDoubleClick={() => setTreeWidth(BROWSE_TREE_DEFAULT_WIDTH)}
                title="Drag to resize, double-click to reset"
                className="hidden xl:block absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-indigo-500/40 focus-visible:bg-indigo-500/60 outline-none"
              />
            </aside>
          )}

          {/* Main pane */}
          <div className="flex-1 min-w-0 space-y-6">
            {/* Breadcrumb */}
            <nav className="flex flex-wrap items-center gap-1.5 text-sm bg-surface-card rounded-2xl border border-border px-4 py-3">
              <button
                onClick={() => setCurrentId(null)}
                className="inline-flex items-center gap-1.5 text-text-muted hover:text-brand-600 transition-colors font-semibold"
              >
                <Home className="h-3.5 w-3.5" /> Root
              </button>
              {ancestors.map((a) => (
                <span key={a.id} className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 text-border" />
                  <button
                    onClick={() => setCurrentId(a.id)}
                    className="text-text-muted hover:text-brand-600 transition-colors font-semibold"
                  >
                    {a.name}
                  </button>
                </span>
              ))}
              {current?.folder && (
                <span className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 text-border" />
                  <span className="text-text-primary font-bold">
                    {current.folder.name}
                  </span>
                </span>
              )}
            </nav>

            {/* Current folder header */}
            <div className="ui-card bg-surface-card border border-border rounded-2xl p-6">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-indigo-500/10 rounded-xl">
                  {current?.folder ? (
                    <FolderOpen className="h-7 w-7 text-indigo-500" />
                  ) : (
                    <Building2 className="h-7 w-7 text-indigo-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <h2 className="text-xl font-bold text-text-primary">
                      {current?.folder?.name ?? 'Repository Root'}
                    </h2>
                    {current?.folder && (
                      <span
                        className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${levelColor(current.folder.level)}`}
                      >
                        {levelLabel(current.folder.level)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-text-muted font-mono">
                    {current?.folder?.path ?? root?.path ?? '/'}
                  </p>
                  {current?.folder?.departmentId && (
                    <p className="text-xs text-text-muted mt-2">
                      Bound to a department · documents in this folder inherit
                      the department scope
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Children */}
            <div className="ui-card bg-surface-card border border-border rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-bold text-text-secondary flex items-center gap-2">
                  <Folder className="h-4 w-4 text-indigo-500" />
                  Subfolders ({children.length})
                </h3>
                <Link
                  href="/dashboard/search"
                  className="text-xs font-bold text-indigo-500 hover:text-indigo-400 inline-flex items-center gap-1"
                >
                  <Search className="h-3.5 w-3.5" /> Search inside
                </Link>
              </div>
              {rootLoading || detailLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="ui-skeleton h-8 rounded-lg"
                      style={{ width: 70 + (i % 3) * 10 + '%' }}
                    />
                  ))}
                </div>
              ) : children.length === 0 ? (
                <div className="p-12 text-center">
                  <FileText className="h-10 w-10 text-text-muted/40 mx-auto mb-3" />
                  <p className="text-sm text-text-muted">
                    No subfolders in this location.
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Documents uploaded to this department will be stored under
                    the category folders.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {children.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => setCurrentId(c.id)}
                        className="w-full flex items-center gap-4 px-6 py-4 hover:bg-surface-raised transition-colors text-left group"
                      >
                        <div className="p-2.5 bg-surface-raised group-hover:bg-indigo-500/10 rounded-xl transition-colors shrink-0">
                          <Folder className="h-5 w-5 text-text-muted group-hover:text-indigo-500 transition-colors" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-bold text-text-primary group-hover:text-indigo-500 transition-colors truncate">
                              {c.name}
                            </p>
                            <span
                              className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border ${levelColor(c.level)}`}
                            >
                              {levelLabel(c.level)}
                            </span>
                          </div>
                          <p className="text-xs text-text-muted font-mono truncate">
                            {c.path}
                          </p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-border group-hover:text-indigo-500 group-hover:translate-x-1 transition-all" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {folderIdForDocs && (
              <div className="ui-card bg-surface-card border border-border rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                  <h3 className="text-sm font-bold text-text-secondary flex items-center gap-2">
                    <FileText className="h-4 w-4 text-indigo-500" />
                    Documents in this folder ({folderDocsTotal})
                  </h3>
                  <PermissionGate permission={PERMISSIONS.DOCUMENT_UPLOAD}>
                    <Link
                      href={`/dashboard/upload?departmentId=${current?.folder?.departmentId ?? ''}&folderPath=${encodeURIComponent(current?.folder?.path ?? '')}`}
                      className="text-xs font-bold text-indigo-500 hover:text-indigo-400 inline-flex items-center gap-1"
                    >
                      Upload Here
                    </Link>
                  </PermissionGate>
                </div>
                <DocFilterBar filters={docFilters} onChange={setDocFilters} isFetching={folderDocsFetching} />
                {!folderDocs?.length ? (
                  <p className="p-8 text-center text-sm text-text-muted">
                    {hasActiveDocFilters(docFilters)
                      ? 'No documents match these filters.'
                      : 'No documents in this category yet.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {folderDocs.map((doc: any) => (
                      <li key={doc.id} className="flex items-center gap-3 px-6 py-4 hover:bg-surface-raised group">
                        <FileTypeIcon mimeType={doc.versions?.[0]?.mimeType || ''} size={18} />
                        <Link
                          href={`/dashboard/documents/${doc.id}`}
                          className="flex-1 min-w-0"
                        >
                          <p className="text-sm font-semibold text-text-primary">
                            {doc.title}
                          </p>
                          <p className="text-xs text-text-muted font-mono truncate">
                            {doc.documentName}
                          </p>
                        </Link>
                        <StatusBadge status={doc.status} />
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => setPreviewDoc({ id: doc.id, title: doc.title, mimeType: doc.versions?.[0]?.mimeType || '', documentName: doc.documentName })}
                            className="p-1.5 text-text-muted hover:text-indigo-500 hover:bg-indigo-500/10 rounded-lg transition-colors"
                            title="Preview"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                const blob = await apiClientBlob(downloadDocumentUrl(doc.id));
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a'); a.href = url; a.download = doc.documentName || doc.title; a.click();
                                URL.revokeObjectURL(url);
                              } catch (err: unknown) {
                                toast.error(err instanceof Error ? err.message : 'Download failed');
                              }
                            }}
                            className="p-1.5 text-text-muted hover:text-brand-600 hover:bg-brand-600/10 rounded-lg transition-colors"
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {folderDocsTotal > DOCS_PAGE_SIZE && (
                  <div className="border-t border-border px-4">
                    <PaginationControls
                      page={folderDocsPage}
                      onPageChange={setFolderDocsPage}
                      hasPrevious={folderDocsPage > 1}
                      hasNext={folderDocsHasNext}
                      totalPages={folderDocsTotalPages}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Show all documents when not in a category folder */}
            {!folderIdForDocs && current?.folder?.level === 2 && (
              <div className="ui-card bg-surface-card border border-border rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                  <h3 className="text-sm font-bold text-text-secondary flex items-center gap-2">
                    <FileText className="h-4 w-4 text-indigo-500" />
                    All Documents in {current?.folder?.name}
                  </h3>
                </div>
                <DepartmentDocuments
                  departmentId={current?.folder?.departmentId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <DocumentPreviewModal
        documentId={previewDoc?.id ?? null}
        title={previewDoc?.title ?? ''}
        mimeType={previewDoc?.mimeType ?? ''}
        documentName={previewDoc?.documentName ?? ''}
        onClose={() => setPreviewDoc(null)}
      />
    </>
  );
}

function DepartmentDocuments({
  departmentId,
}: {
  departmentId: string | null;
}) {
  const [page, setPage] = useState(1);
  const [docFilters, setDocFilters] = useState<DocFilterState>(DEFAULT_DOC_FILTERS);
  // Keyset (cursor) pagination — see app/dashboard/documents/page.tsx's own
  // copy of this comment for the full rationale.
  const [cursorForPage, setCursorForPage] = useState<Record<number, string>>({});
  useResetOnChange([departmentId], () => {
    setPage(1);
    setCursorForPage({});
  });
  useResetOnChange([docFilters], () => {
    setPage(1);
    setCursorForPage({});
  });
  const cursor = page > 1 ? cursorForPage[page - 1] : undefined;

  const { data: deptDocsPage, isLoading, isFetching } = useQuery({
    queryKey: ['department-documents', departmentId, page, docFilters, cursor],
    // FIX: this used to call listDocuments(0, 50) with NO filter at all,
    // showing every document in the tenant regardless of department instead
    // of scoping to the department being browsed.
    queryFn: () =>
      listDocuments((page - 1) * DOCS_PAGE_SIZE, DOCS_PAGE_SIZE, {
        departmentId: departmentId!,
        ...docFiltersToApi(docFilters),
        cursor,
      }),
    enabled: Boolean(departmentId),
    staleTime: 30_000,
  });
  useResetOnChange([deptDocsPage?.nextCursor, page], () => {
    const next = deptDocsPage?.nextCursor;
    if (next) {
      setCursorForPage((prev) => (prev[page] === next ? prev : { ...prev, [page]: next }));
    }
  });
  const deptDocs = deptDocsPage?.data;
  const deptDocsTotal = deptDocsPage?.total ?? deptDocs?.length ?? 0;
  const deptDocsTotalPages = Math.max(1, Math.ceil(deptDocsTotal / DOCS_PAGE_SIZE));
  const deptDocsHasNext = Boolean(deptDocsPage?.nextCursor);

  if (isLoading) {
    return (
      <>
        <DocFilterBar filters={docFilters} onChange={setDocFilters} isFetching={isFetching} />
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="ui-skeleton h-8 rounded-lg"
              style={{ width: 70 + (i % 3) * 10 + '%' }}
            />
          ))}
        </div>
      </>
    );
  }

  if (!deptDocs?.length) {
    return (
      <>
        <DocFilterBar filters={docFilters} onChange={setDocFilters} isFetching={isFetching} />
        <p className="p-8 text-center text-sm text-text-muted">
          {hasActiveDocFilters(docFilters) ? 'No documents match these filters.' : 'No documents in this department yet.'}
        </p>
      </>
    );
  }

  return (
    <>
      <DocFilterBar filters={docFilters} onChange={setDocFilters} isFetching={isFetching} />
      <ul className="divide-y divide-border">
        {deptDocs.map((doc: any) => (
          <li key={doc.id} className="flex items-center gap-3 px-6 py-4 hover:bg-surface-raised group">
            <FileTypeIcon mimeType={doc.versions?.[0]?.mimeType || ''} size={18} />
            <Link
              href={`/dashboard/documents/${doc.id}`}
              className="flex-1 min-w-0"
            >
              <p className="text-sm font-semibold text-text-primary">
                {doc.title}
              </p>
              <p className="text-xs text-text-muted font-mono">
                {doc.documentName}
              </p>
            </Link>
            <StatusBadge status={doc.status} />
          </li>
        ))}
      </ul>
      {deptDocsTotal > DOCS_PAGE_SIZE && (
        <div className="border-t border-border px-4">
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={deptDocsHasNext}
            totalPages={deptDocsTotalPages}
          />
        </div>
      )}
    </>
  );
}
