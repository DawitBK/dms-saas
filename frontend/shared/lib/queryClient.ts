import { QueryClient } from '@tanstack/react-query';

// Module-scope singleton (not created inside Providers.tsx's useState) so
// auth.store.ts's clearSession() can reach it directly, the same way it
// reaches shared/lib/hierarchyTreeCache.ts's resetHierarchyTreeCache() — see
// that file's comment for why a plain module export, not React context, is
// what a non-component caller (clearSession, apiClient.ts's 401 auto-logout)
// needs. providers/Providers.tsx wires this exact instance into
// QueryClientProvider, so every existing useQueryClient() call site is
// unaffected.
//
// FIX (platform audit finding 2026-08-14, follow-up): sign-out reset the
// hierarchy tree cache but never this one — every other TanStack Query
// cache entry (document lists, notification counts, department/doc-type
// lookups, etc., all with multi-second-to-minutes staleTime/gcTime) survived
// a client-side sign-out (a router.push, not a reload) untouched. A second
// user logging in on the same tab within that window could see the first
// user's cached data rendered with zero refetch (fresh) or a stale flash
// before revalidating (stale-but-not-collected) — the same cross-tenant/
// cross-user leak the tree-cache fix closed, just across far more data.
// TenantSwitcher.tsx already calls queryClient.invalidateQueries() on tenant
// switch, proving the team already knew this class of reset was needed —
// it just never reached the sign-out path. Cleared via queryClient.clear()
// in auth.store.ts's clearSession(), the same single choke point every
// sign-out call site (TopBar, Sidebar, select-tenant, apiClient's 401
// auto-logout) already runs through.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 15_000, // 15 s default — immediate reactivity with background freshness
      gcTime: 5 * 60_000, // 5 min: keep cached data alive during navigation
    },
    mutations: {
      retry: 0,
    },
  },
});
