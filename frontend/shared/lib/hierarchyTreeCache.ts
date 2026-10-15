// Module-scope cache backing HierarchyTreeBrowser.tsx's 60s "nothing changed,
// I just navigated away and back" short-circuit. Lives in its own leaf file
// (no React, no other app imports) so it can be reset from auth.store.ts's
// clearSession() without a circular import back through HierarchyTreeBrowser
// (which itself imports apiClient, which imports auth.store).
//
// FIX (platform audit finding 2026-08-14): this cache used to live as a
// plain module-scope object inside HierarchyTreeBrowser.tsx, and nothing
// ever reset it on sign-out — sign-out is a client-side SPA navigation
// (clearSession() + router.push), not a full page reload, so the cache
// (org units, departments, folders — one tenant's whole document hierarchy)
// survived untouched. If a second user logs in on the same tab within 60
// seconds of the first user's sign-out, they'd briefly see the previous
// user's cached tree — a real cross-tenant/cross-user data-leak window on a
// shared workstation. Cleared now via resetHierarchyTreeCache(), called from
// clearSession() so every sign-out path (TopBar, Sidebar, tenant switch,
// apiClient's 401 auto-logout) is covered by fixing the one shared choke
// point instead of every call site individually.
export const TREE_CACHE_TTL_MS = 60_000;

export const moduleTreeCache: {
  orgUnits: unknown[];
  departmentsByUnit: Map<string, unknown[]>;
  folders: Map<string, unknown[]>;
  fetchedAt: number;
  // Which of the two HierarchyTreeBrowser usages populated this cache —
  // the tenant-wide Operations "Hierarchy Browser" (false) or the
  // membership/ACL-scoped Browse-page sidebar (true, `scopeToViewer`). Both
  // usages share this one module-scope object, so without this flag a
  // DEPT_MANAGER (the one role with legitimate access to both) who opens
  // Operations right after Browse — or the reverse — would have the SECOND
  // page silently seed itself from the FIRST page's differently-scoped
  // fetch: an admin briefly seeing only their own department in the
  // full-CRUD panel, or (the more surprising direction) the scoped sidebar
  // briefly showing the tenant-wide tree it was built to hide. Treated as
  // part of freshness: a cache fetched under the other scope is stale
  // regardless of how recently it was fetched.
  scopedFetch: boolean;
} = { orgUnits: [], departmentsByUnit: new Map(), folders: new Map(), fetchedAt: 0, scopedFetch: false };

export function isTreeCacheFresh(scopeToViewer: boolean): boolean {
  return moduleTreeCache.scopedFetch === scopeToViewer && Date.now() - moduleTreeCache.fetchedAt < TREE_CACHE_TTL_MS;
}

export function resetHierarchyTreeCache(): void {
  moduleTreeCache.orgUnits = [];
  moduleTreeCache.departmentsByUnit = new Map();
  moduleTreeCache.folders = new Map();
  moduleTreeCache.fetchedAt = 0;
  moduleTreeCache.scopedFetch = false;
}
