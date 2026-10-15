// SPRINT-1/5: search UI stays coupled to the auth token and will later need ACL-aware result handling.
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { apiClient } from '../../../shared/lib/apiClient';
import { useMyDepartments } from '../../../shared/hooks/useMyDepartments';
import Link from 'next/link';
import {
  Search,
  Filter,
  Bookmark,
  X,
  RefreshCw,
  Shield,
  Archive,
  FileText,
  Tag,
  Clock,
  AlertCircle,
  Star,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import { TopBar } from '../../../shared/components/TopBar';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { useUIStore } from '../../../state/ui.store';
import { useDepartments, useDocumentTypes, useOrgUnits } from '../../../shared/hooks/useLookups';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';
import { CLASSIFICATIONS, CLASSIFICATION_BADGE, CLASSIFICATION_LABEL, type Classification } from '../../../shared/lib/classification';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-surface-raised text-text-muted',
  ACTIVE: 'bg-emerald-500/15 text-emerald-500',
  ARCHIVED: 'bg-blue-500/15 text-blue-500',
  DISPOSAL_PENDING: 'bg-orange-500/15 text-orange-500',
};

// Maps each facetable Meilisearch field (search.service.ts's facetDist) to the
// matching filter key + a display label for the "Refine results" panel.
const FACET_FIELDS: Array<{ field: string; filterKey: string; label: string }> = [
  { field: 'departmentId', filterKey: 'departmentId', label: 'Department' },
  { field: 'documentTypeCode', filterKey: 'documentTypeCode', label: 'Document Type' },
  { field: 'status', filterKey: 'status', label: 'Status' },
  { field: 'securityClassification', filterKey: 'securityClassification', label: 'Classification' },
  { field: 'retentionClass', filterKey: 'retentionClass', label: 'Retention Class' },
];

export default function SearchPage() {
  const qc = useQueryClient();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const incomingParams = useSearchParams();

  // Seeded once from the URL, in the state initialisers below rather than in a
  // mount effect. useSearchParams() is available during render, so there was
  // nothing to wait for — and the effect version painted the empty "no search
  // yet" screen for one frame before replacing it with the filtered results.
  // react-hooks/set-state-in-effect, an error under eslint-config-next 16,
  // rejects the effect form as well.
  const urlStatus = incomingParams.get('status');
  const urlDepartmentId = incomingParams.get('departmentId');
  // Legacy param name — no internal link sends this anymore, but an old
  // bookmarked/shared URL might. Resolved to an id once departments load
  // (see the resetOnChange below), same treatment as a legacy saved search.
  const urlDepartmentCode = incomingParams.get('departmentCode');
  const urlDocumentTypeCode = incomingParams.get('documentTypeCode');
  const hasUrlFilter = Boolean(urlStatus || urlDepartmentId || urlDepartmentCode || urlDocumentTypeCode);
  // `browse=1` (e.g. a "Total Documents" stat card) means "show everything",
  // no filter required.
  const seededFromUrl = hasUrlFilter || Boolean(incomingParams.get('browse'));

  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  // True once the user has run a text search OR arrived with filters
  // pre-applied (e.g. a dashboard stat card link like ?status=ACTIVE) —
  // browsing by filter alone shouldn't require typing a query first.
  const [hasSearched, setHasSearched] = useState(seededFromUrl);
  const [filters, setFilters] = useState(() => ({
    departmentId: urlDepartmentId ?? '',
    documentTypeCode: urlDocumentTypeCode ?? '',
    status: urlStatus ?? '',
    securityClassification: '',
    dateFrom: '',
    dateTo: '',
    isOnLegalHold: '',
    retentionClass: '',
  }));
  const [showFilters, setShowFilters] = useState(hasUrlFilter);
  const [saveSearchName, setSaveSearchName] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);


  // §1 FIX: Use shared lookup hooks — returns bare arrays, no envelope mismatch
  const { data: departments } = useDepartments();
  const { data: orgUnits } = useOrgUnits();
  const { data: docTypes } = useDocumentTypes();

  // The Department filter's OPTIONS are restricted to the searcher's own
  // memberships, same "auto-fetch + scope by role/department" treatment as
  // Upload/Signing/letters — an oversight role (SEARCH_SCOPE_ALL, mirrors the
  // backend's own bypass in search.service.ts) still sees every department in
  // the tenant. This narrows the picker only; it is never a hard lock, since
  // unlike a data-entry field a filter has a meaningful "no value" state
  // (search everything the caller can already see) and the backend re-checks
  // access on every hit regardless of what's selected here.
  const { can } = usePermissions();
  const canSearchAll = can(PERMISSIONS.SEARCH_SCOPE_ALL);
  const { myDepartmentIds } = useMyDepartments(!canSearchAll);
  const scopedDepartments = canSearchAll
    ? (departments ?? [])
    : (departments ?? []).filter((d) => myDepartmentIds.has(d.id));

  // Filter/facet on departmentId, not department code — department codes are
  // only unique per (tenant, org unit) as of the 20260912000001 migration, so
  // two departments in different org units can legitimately share a code.
  // Filtering on the id is precise regardless of how many departments share a
  // code; grouping the options by org unit below is then purely a labeling
  // aid for the human picking one. Backend: search.service.ts's SearchFilters.
  const orgUnitName = (orgUnitId?: string | null) => (orgUnits ?? []).find((u) => u.id === orgUnitId)?.name;
  const departmentGroups = Object.entries(
    scopedDepartments.reduce<Record<string, typeof departments>>((acc, d) => {
      const label = orgUnitName(d.orgUnitId) ?? 'No org unit';
      (acc[label] ??= []).push(d);
      return acc;
    }, {}),
  );
  // Label-resolution for facet values and legacy-code recall deliberately
  // stays keyed off the FULL tenant department list, not scopedDepartments —
  // a facet hit can legitimately name a department outside the searcher's own
  // membership (e.g. an ACL grant on that department), and narrowing this map
  // would just make its label fall back to a raw id instead of a real name.
  const departmentById = new Map((departments ?? []).map((d) => [d.id, d]));

  // Legacy departmentCode -> departmentId resolution, shared by the
  // ?departmentCode= URL param above and by applying an old saved search
  // that still stores departmentCode. Best-effort: a code shared across org
  // units resolves to its first match rather than blocking the filter
  // entirely — the same recall the old code-based filter had, just aimed
  // through the new precise field.
  const resolveDepartmentCode = (code: string): string | undefined =>
    (departments ?? []).find((d) => d.code === code)?.id;

  // One-time legacy-URL resolution: once departments have loaded, if we
  // arrived with the old ?departmentCode= param and haven't already resolved
  // a departmentId for it, translate it.
  useResetOnChange([departments, urlDepartmentCode], () => {
    if (!urlDepartmentCode || urlDepartmentId) return;
    setFilters((f) => {
      if (f.departmentId) return f;
      const resolved = resolveDepartmentCode(urlDepartmentCode);
      return resolved ? { ...f, departmentId: resolved } : f;
    });
  });

  // Live search-as-you-type: debounce the typed query into `submitted` instead
  // of requiring the Search button/Enter. The explicit submit path (runSearch)
  // still fires immediately for anyone who prefers pressing Enter.
  useEffect(() => {
    const trimmed = q.trim();
    const timer = setTimeout(() => {
      setSubmitted(trimmed);
      setHasSearched(Boolean(trimmed) || Object.values(filters).some(Boolean));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, filters]);

  const searchParams = new URLSearchParams({ q: submitted });
  if (filters.departmentId)
    searchParams.set('departmentId', filters.departmentId);
  if (filters.documentTypeCode)
    searchParams.set('documentTypeCode', filters.documentTypeCode);
  if (filters.status) searchParams.set('status', filters.status);
  if (filters.securityClassification)
    searchParams.set('securityClassification', filters.securityClassification);
  if (filters.dateFrom) searchParams.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) searchParams.set('dateTo', filters.dateTo);
  if (filters.isOnLegalHold) searchParams.set('isOnLegalHold', filters.isOnLegalHold);
  if (filters.retentionClass) searchParams.set('retentionClass', filters.retentionClass);
  searchParams.set('facets', 'true');

  const {
    data: results,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ['search', submitted, filters],
    queryFn: () =>
      apiClient<{
        hits: any[];
        totalHits: number;
        processingTimeMs?: number;
        facetDistribution?: Record<string, Record<string, number>>;
      }>(`/search?${searchParams}`),
    enabled: hasSearched,
    staleTime: 30_000, // 30 seconds
  });

  const { data: savedSearches, refetch: refetchSaved } = useQuery({
    queryKey: ['saved-searches'],
    queryFn: () => apiClient<{ data: any[] }>('/search/saved'),
    staleTime: 60_000, // 60 seconds
  });

  const { mutate: saveSearch, isPending: isSaving } = useMutation({
    mutationFn: () =>
      apiClient('/search/saved', {
        method: 'POST',
        body: JSON.stringify({
          name: saveSearchName,
          query: submitted,
          filters,
        }),
      }),
    onSuccess: () => {
      refetchSaved();
      setSaveSearchName('');
      setShowSaveForm(false);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save search'),
  });

  const { mutate: deleteSaved } = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/search/saved/${id}`, { method: 'DELETE' }),
    onSuccess: () => refetchSaved(),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not delete saved search'),
  });

  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(q.trim());
    setHasSearched(true);
  };

  const applySaved = (s: any) => {
    setQ(s.query);
    setSubmitted(s.query);
    setHasSearched(true);
    if (s.filters) {
      try {
        const parsed = JSON.parse(s.filters);
        // A search saved before departmentId existed stores departmentCode
        // instead — translate it now that departments are loaded, same
        // best-effort first-match resolution as the legacy URL param.
        if (!parsed.departmentId && parsed.departmentCode) {
          const resolved = resolveDepartmentCode(parsed.departmentCode);
          if (resolved) parsed.departmentId = resolved;
          delete parsed.departmentCode;
        }
        setFilters((f) => ({ ...f, ...parsed }));
      } catch {}
    }
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hits = results?.hits ?? [];

  // Client-side pagination of the result set (15/page). Search post-filters by
  // ACL after fetching, so the returned set is already bounded; this pages the
  // display. (Raising the backend's 50-result cap to true server-side paging is
  // a separate, ACL-aware backend change — see the gap register.)
  const SEARCH_PAGE_SIZE = 15;
  const [searchPage, setSearchPage] = useState(1);
  useResetOnChange([submitted, filters], () => setSearchPage(1));
  const searchTotalPages = Math.max(1, Math.ceil(hits.length / SEARCH_PAGE_SIZE));
  const pagedHits = hits.slice((searchPage - 1) * SEARCH_PAGE_SIZE, searchPage * SEARCH_PAGE_SIZE);

  return (
    <PermissionGate permission={PERMISSIONS.SEARCH_READ}>
      <>
        <TopBar
          title="Search"
          breadcrumbs={[
            { label: 'Repository', href: '/dashboard' },
            { label: 'Search' },
          ]}
          onMobileMenuToggle={toggleSidebar}
        />
        <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-7xl mx-auto w-full">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-text-primary">
              Enterprise Search
            </h1>
            <p className="text-text-muted mt-1">
              Full-text search across all accessible records via Meilisearch.
            </p>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
            {/* Main Search Column */}
            <div className="xl:col-span-3 space-y-6">
              {/* Search Bar */}
              <form onSubmit={runSearch} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-text-muted" />
                  <input
                    type="text"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search titles, content, keywords, document numbers..."
                    className="ui-input pl-12 py-3.5 rounded-2xl"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                  className={`relative inline-flex items-center gap-2 px-4 py-3.5 text-sm font-semibold rounded-2xl border transition-all ${
                    showFilters || activeFilterCount > 0
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-surface-card text-text-secondary border-border hover:border-indigo-400'
                  }`}
                >
                  <Filter className="h-4 w-4" />
                  Filters
                  {activeFilterCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 h-5 w-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                <button
                  type="submit"
                  disabled={!q.trim() && activeFilterCount === 0}
                  className="inline-flex items-center gap-2 px-6 py-3.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-2xl shadow-lg shadow-indigo-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Search className="h-4 w-4" /> Search
                </button>
              </form>

              {/* Filters Panel */}
              {showFilters && (
                <div className="bg-surface-card rounded-2xl border border-border shadow-sm p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Department
                    </label>
                    <select
                      value={filters.departmentId}
                      onChange={(e) =>
                        setFilters({ ...filters, departmentId: e.target.value })
                      }
                      className="ui-input w-full text-sm"
                    >
                      <option value="">All</option>
                      {departmentGroups.map(([groupLabel, depts]) => (
                        <optgroup key={groupLabel} label={groupLabel}>
                          {depts!.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.code} — {d.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Document Type
                    </label>
                    <select
                      value={filters.documentTypeCode}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          documentTypeCode: e.target.value,
                        })
                      }
                      className="ui-input w-full text-sm"
                    >
                      <option value="">All</option>
                      {(docTypes ?? []).map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.code} — {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Status
                    </label>
                    <select
                      value={filters.status}
                      onChange={(e) =>
                        setFilters({ ...filters, status: e.target.value })
                      }
                      className="ui-input w-full text-sm"
                    >
                      <option value="">All</option>
                      {[
                        'DRAFT',
                        'ACTIVE',
                        'UNDER_REVIEW',
                        'ARCHIVED',
                        'DISPOSAL_PENDING',
                      ].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Classification
                    </label>
                    <select
                      value={filters.securityClassification}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          securityClassification: e.target.value,
                        })
                      }
                      className="ui-input w-full text-sm"
                    >
                      <option value="">All</option>
                      {CLASSIFICATIONS.map((c) => (
                        <option key={c} value={c}>
                          {CLASSIFICATION_LABEL[c]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      From Date
                    </label>
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                      className="ui-input w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      To Date
                    </label>
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                      className="ui-input w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Legal Hold
                    </label>
                    <select
                      value={filters.isOnLegalHold}
                      onChange={(e) => setFilters({ ...filters, isOnLegalHold: e.target.value })}
                      className="ui-input w-full text-sm"
                    >
                      <option value="">Any</option>
                      <option value="true">On legal hold</option>
                      <option value="false">Not on hold</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-text-muted uppercase mb-1.5">
                      Retention Class
                    </label>
                    <input
                      type="text"
                      value={filters.retentionClass}
                      onChange={(e) => setFilters({ ...filters, retentionClass: e.target.value })}
                      placeholder="e.g. PERMANENT"
                      className="ui-input w-full text-sm"
                    />
                  </div>
                  <div className="col-span-2 md:col-span-4 flex justify-end">
                    <button
                      onClick={() =>
                        setFilters({
                          departmentId: '',
                          documentTypeCode: '',
                          status: '',
                          securityClassification: '',
                          dateFrom: '',
                          dateTo: '',
                          isOnLegalHold: '',
                          retentionClass: '',
                        })
                      }
                      className="text-xs font-bold text-text-muted hover:text-red-500 flex items-center gap-1 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" /> Clear All Filters
                    </button>
                  </div>
                </div>
              )}

              {/* Results */}
              {hasSearched && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-text-muted font-medium">
                      {isLoading || isFetching ? (
                        <span className="flex items-center gap-2">
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />{' '}
                          Searching...
                        </span>
                      ) : (
                        <span>
                          <span className="font-bold text-text-primary">
                            {results?.totalHits ?? 0}
                          </span>{' '}
                          {submitted ? (
                            <>
                              results for{' '}
                              <span className="font-bold text-indigo-700">
                                &ldquo;{submitted}&rdquo;
                              </span>
                            </>
                          ) : (
                            'results matching your filters'
                          )}
                          {results?.processingTimeMs != null && (
                            <span className="ml-2 text-[11px] font-mono text-text-muted">
                              ({results.processingTimeMs}ms)
                            </span>
                          )}
                        </span>
                      )}
                    </p>
                    {submitted && !isSaving && (
                      <button
                        onClick={() => setShowSaveForm(!showSaveForm)}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
                      >
                        <Bookmark className="h-3.5 w-3.5" /> Save This Search
                      </button>
                    )}
                  </div>

                  {showSaveForm && (
                    <div className="flex gap-2 bg-indigo-50 rounded-xl p-3 border border-indigo-100">
                      <input
                        type="text"
                        placeholder="Name this search..."
                        value={saveSearchName}
                        onChange={(e) => setSaveSearchName(e.target.value)}
                        className="flex-1 text-sm border border-indigo-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      <button
                        disabled={!saveSearchName.trim() || isSaving}
                        onClick={() => saveSearch()}
                        className="px-4 py-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                      >
                        {isSaving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  )}

                  {(isLoading || isFetching) && hits.length === 0 ? (
                    <div className="space-y-3">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="ui-skeleton h-20 rounded-2xl" />
                      ))}
                    </div>
                  ) : hits.length === 0 && !isLoading ? (
                    <div className="bg-surface-card rounded-2xl border border-border p-12 text-center">
                      <AlertCircle className="h-10 w-10 text-text-muted/40 mx-auto mb-3" />
                      <p className="text-text-muted font-medium">
                        No documents found for your query.
                      </p>
                      <p className="text-sm text-text-muted mt-1">
                        Try different keywords or broaden your filters.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pagedHits.map((hit: any) => (
                        <Link
                          key={hit.id}
                          href={`/dashboard/documents/${hit.id}`}
                          className="group flex items-start gap-4 bg-surface-card rounded-2xl border border-border p-5 hover:border-indigo-400 hover:shadow-md transition-all"
                        >
                          <div className="p-2.5 bg-surface-raised rounded-xl group-hover:bg-indigo-500/10 transition-colors shrink-0">
                            <FileText className="h-5 w-5 text-text-muted group-hover:text-indigo-500 transition-colors" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <h3 className="text-base font-bold text-text-primary group-hover:text-indigo-500 transition-colors truncate">
                                {hit.title || hit.documentName}
                              </h3>
                              <StatusBadge status={hit.status} />
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${CLASSIFICATION_BADGE[hit.securityClassification as Classification] ?? 'bg-surface-raised text-text-muted'}`}
                              >
                                <Shield className="h-2.5 w-2.5" />{' '}
                                {hit.securityClassification}
                              </span>
                            </div>
                            <p className="text-xs font-mono text-text-muted mb-1.5">
                              {hit.documentName}
                            </p>
                            {hit.description && (
                              <p className="text-sm text-text-muted line-clamp-2 mb-2">
                                {hit.description}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                              {hit.departmentCode && (
                                <span className="flex items-center gap-1">
                                  <Archive className="h-3 w-3" />{' '}
                                  {hit.departmentCode}
                                </span>
                              )}
                              {hit.documentTypeCode && (
                                <span className="flex items-center gap-1">
                                  <Tag className="h-3 w-3" />{' '}
                                  {hit.documentTypeCode}
                                </span>
                              )}
                              {hit.createdAt && (
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />{' '}
                                  {new Date(hit.createdAt).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="h-5 w-5 text-border group-hover:text-indigo-500 shrink-0 transition-colors" />
                        </Link>
                      ))}
                      {hits.length > SEARCH_PAGE_SIZE && (
                        <PaginationControls
                          page={searchPage}
                          onPageChange={setSearchPage}
                          hasPrevious={searchPage > 1}
                          hasNext={searchPage * SEARCH_PAGE_SIZE < hits.length}
                          totalPages={searchTotalPages}
                          isLoading={isFetching}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}

              {!hasSearched && (
                <div className="bg-brand-600/5 rounded-2xl border border-brand-600/20 p-12 text-center">
                  <Search className="h-12 w-12 text-brand-600/40 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-text-secondary">
                    Search the Document Repository
                  </h3>
                  <p className="text-sm text-text-muted mt-2 max-w-md mx-auto">
                    Powered by Meilisearch — search by title, content extracted
                    via OCR, keywords, tags, and document identifiers. Access is
                    automatically scoped to your department.
                  </p>
                </div>
              )}
            </div>

            {/* Saved Searches Sidebar */}
            <div className="space-y-4">
              {hasSearched && results?.facetDistribution && Object.keys(results.facetDistribution).length > 0 && (
                <div className="bg-surface-card rounded-2xl border border-border shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                    <Filter className="h-4 w-4 text-indigo-500" />
                    <h2 className="text-sm font-bold text-text-secondary">
                      Refine Results
                    </h2>
                  </div>
                  <div className="p-4 space-y-4 max-h-80 overflow-y-auto">
                    {FACET_FIELDS.map(({ field, filterKey, label }) => {
                      const counts = results.facetDistribution?.[field];
                      if (!counts || Object.keys(counts).length === 0) return null;
                      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                      return (
                        <div key={field}>
                          <p className="text-[11px] font-bold text-text-muted uppercase mb-1.5">{label}</p>
                          <div className="space-y-1">
                            {entries.map(([value, count]) => {
                              const active = (filters as any)[filterKey] === value;
                              // The departmentId facet's keys are ids — show
                              // the department's code/name instead of the
                              // raw uuid, same lookup the picker above uses.
                              const displayLabel =
                                field === 'departmentId'
                                  ? (() => {
                                      const d = departmentById.get(value);
                                      return d ? `${d.code} — ${d.name}` : value;
                                    })()
                                  : value;
                              return (
                                <button
                                  key={value}
                                  onClick={() =>
                                    setFilters((f) => ({ ...f, [filterKey]: active ? '' : value }))
                                  }
                                  className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs text-left transition-colors ${
                                    active
                                      ? 'bg-indigo-600 text-white'
                                      : 'text-text-secondary hover:bg-surface-raised'
                                  }`}
                                >
                                  <span className="truncate">{displayLabel}</span>
                                  <span className={active ? 'text-white/80' : 'text-text-muted'}>{count}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="bg-surface-card rounded-2xl border border-border shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                  <Star className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-bold text-text-secondary">
                    Saved Searches
                  </h2>
                </div>
                <div className="p-3 space-y-1.5">
                  {(savedSearches?.data ?? []).length === 0 ? (
                    <p className="text-xs text-text-muted text-center py-4">
                      No saved searches yet.
                    </p>
                  ) : (
                    (savedSearches?.data ?? []).map((s: any) => (
                      <div key={s.id} className="flex items-center gap-2 group">
                        <button
                          onClick={() => applySaved(s)}
                          className="flex-1 text-left px-3 py-2 text-sm font-medium text-text-secondary hover:text-brand-600 hover:bg-brand-600/10 rounded-lg transition-colors truncate"
                        >
                          {s.name}
                        </button>
                        <button
                          onClick={() => deleteSaved(s.id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-text-muted hover:text-red-500 rounded-lg hover:bg-red-500/10 transition-all"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="bg-slate-900 rounded-2xl p-5 text-white">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">
                  Search Tips
                </h3>
                <ul className="space-y-2 text-xs text-slate-300 leading-relaxed">
                  <li className="flex items-start gap-2">
                    <span className="text-indigo-400 font-bold">→</span> Use exact
                    phrases in quotes
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-indigo-400 font-bold">→</span> Filter by
                    department to narrow scope
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-indigo-400 font-bold">→</span>{' '}
                    OCR-extracted text is fully indexed
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-indigo-400 font-bold">→</span> Results
                    are scoped to your access level
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </>
    </PermissionGate>
  );
}
