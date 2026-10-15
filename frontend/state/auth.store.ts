'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_API_BASE_URL } from '../shared/lib/apiConfig';
import { resetHierarchyTreeCache } from '../shared/lib/hierarchyTreeCache';
import { queryClient } from '../shared/lib/queryClient';

const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE_URL) ||
  DEFAULT_API_BASE_URL;

// role is informational only — use permissions[] for all authorization decisions
type AuthState = {
  accessToken: string | null;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  roles: string[]; // All assigned roles (v3 §1)
  tenantId: string | null;
  availableTenants: string[]; // Tenants user has access to (v3 §2)
  tenantSelectionRequired: boolean; // Whether user needs to select tenant
  preTenantToken: string | null; // Short-lived token before tenant selection
  // Multi-role selection, mirroring the tenant fields above one step later
  // in the sequence: tenant is already resolved by the time role selection
  // is offered. `roles`/`role` on the live session always reflect just the
  // ACTIVE role (see auth.service.ts's selectRole/switchRole) — availableRoles
  // is every role this user actually holds, used to render the switcher.
  availableRoles: string[];
  roleSelectionRequired: boolean;
  preRoleToken: string | null;
  permissions: string[];
  mfaStatus: 'required' | 'verified' | 'enrolment_required';
  hydrated: boolean;
  setSession: (
    session: Partial<
      Omit<AuthState, 'setSession' | 'clearSession' | 'setHydrated' | 'switchTenant' | 'switchRole'>
    >,
  ) => void;
  clearSession: () => void;
  setHydrated: (hydrated: boolean) => void;
  switchTenant: (tenantId: string) => Promise<void>;
  switchRole: (roleName: string) => Promise<void>;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      userId: null,
      email: null,
      firstName: null,
      lastName: null,
      role: null,
      roles: [],
      tenantId: null,
      availableTenants: [],
      tenantSelectionRequired: false,
      preTenantToken: null,
      availableRoles: [],
      roleSelectionRequired: false,
      preRoleToken: null,
      permissions: [],
      mfaStatus: 'required',
      hydrated: false,
      // FIX 2026-09-23: switchRole()/switchTenant() below already clear the
      // hierarchy-tree cache and the query cache when they mint a
      // differently-scoped token in an ALREADY-OPEN session — but the very
      // first time a session is established (login's completeSession,
      // select-tenant's and select-role's completeSession) called this bare
      // `set(session)` with no such clearing. In the same browser tab that
      // had a prior session's queries cached (re-authenticating after a
      // token expiry, MFA step, or picking a role after "Cancel and sign
      // out" without a hard navigation), that stale cache could keep
      // rendering the OLD session's department/document lists until
      // something happened to trigger a refetch — the exact "switching role
      // should switch everything, not just the token" gap. Clear both
      // whenever a real access token is being installed (every completed-
      // login path sets one; the interim tenant/role-selection-required
      // partial updates never do, so they're unaffected).
      setSession: (session) => {
        set(session);
        if (session.accessToken) {
          resetHierarchyTreeCache();
          queryClient.clear();
        }
      },
      clearSession: () => {
        set({
          accessToken: null,
          userId: null,
          email: null,
          firstName: null,
          lastName: null,
          role: null,
          roles: [],
          tenantId: null,
          availableTenants: [],
          tenantSelectionRequired: false,
          preTenantToken: null,
          availableRoles: [],
          roleSelectionRequired: false,
          preRoleToken: null,
          permissions: [],
          mfaStatus: 'required',
        });
        // Platform audit finding (2026-08-14): HierarchyTreeBrowser's 60s
        // module-scope tree cache used to survive sign-out (a client-side SPA
        // navigation, not a full reload) — a second user logging in on the
        // same tab within that window would briefly see the previous user's
        // cached org-unit/department/folder tree. Reset here, the single
        // choke point every sign-out path (TopBar, Sidebar, tenant switch,
        // apiClient's 401 auto-logout) already runs through.
        resetHierarchyTreeCache();
        // FIX (platform audit finding 2026-08-14, follow-up): the tree cache
        // was only ONE of the caches that survived sign-out — every TanStack
        // Query entry (document lists, notification counts, department/
        // doc-type lookups, etc.) lived in the same module-scope QueryClient
        // (see shared/lib/queryClient.ts) and was left completely untouched.
        // A second user signing in on the same tab within a query's
        // staleTime/gcTime window could see the first user's cached data
        // rendered with no refetch, or briefly flashed before revalidating —
        // same leak class as the tree cache, just across far more data.
        // TenantSwitcher.tsx already calls queryClient.invalidateQueries()
        // on tenant switch; sign-out needs the equivalent, and clear() (not
        // just invalidate) since there's no new session yet to refetch under.
        queryClient.clear();
      },
      setHydrated: (hydrated) => set({ hydrated }),
      switchTenant: async (tenantId: string) => {
        const state = get();
        if (!state.accessToken) {
          throw new Error('Not authenticated');
        }
        
        // Call switch-tenant endpoint
        const response = await fetch(`${API_BASE}/auth/switch-tenant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.accessToken}`,
          },
          body: JSON.stringify({ tenantId }),
        });
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: 'Failed to switch tenant' }));
          throw new Error(error.message || 'Failed to switch tenant');
        }
        
        const data = await response.json();

        // Update session with new tenant-scoped token
        set({
          accessToken: data.accessToken,
          tenantId: data.user.tenantId,
          permissions: data.user.permissions,
        });
        // FIX (platform audit finding 2026-08-14, follow-up): clearSession()'s
        // own comment already claimed "tenant switch" was one of the paths
        // that resets HierarchyTreeBrowser's 60s module-scope tree cache, but
        // switchTenant() never actually called clearSession() (or the reset
        // directly) — it sets accessToken/tenantId/permissions in place, and
        // TenantSwitcher.tsx follows up with queryClient.invalidateQueries()
        // + router.refresh(), neither of which touches a plain module-scope
        // JS object. Without this, switching tenants (no full page reload)
        // left the PREVIOUS tenant's cached org-unit/department/folder tree
        // showing under the new tenant's context for up to 60s — same
        // cross-tenant leak the sign-out fix closed, through the one path
        // its own comment already (incorrectly) claimed was covered.
        resetHierarchyTreeCache();
      },
      switchRole: async (roleName: string) => {
        const state = get();
        if (!state.accessToken) {
          throw new Error('Not authenticated');
        }

        const response = await fetch(`${API_BASE}/auth/switch-role`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.accessToken}`,
          },
          body: JSON.stringify({ roleName }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: 'Failed to switch role' }));
          throw new Error(error.message || 'Failed to switch role');
        }

        const data = await response.json();

        // Same reasoning as switchTenant above: a role switch mints a
        // differently-scoped token (permissions now reflect only the newly
        // active role), so every cached list/lookup that was filtered by the
        // PREVIOUS role's permissions must not keep showing under the new one.
        set({
          accessToken: data.accessToken,
          role: data.user.role,
          roles: data.user.roles,
          availableRoles: data.user.availableRoles ?? state.availableRoles,
          permissions: data.user.permissions,
        });
        resetHierarchyTreeCache();
        queryClient.clear();
      },
    }),
    {
      // DO NOT RENAME: this is the localStorage key holding the persisted session.
      // Renaming it silently logs every existing user out (their session stays in
      // the browser under the old key). Kept as `edams-auth` through the EDAMS->DMS
      // rebrand for exactly that reason — it's an invisible storage key, not brand.
      name: 'edams-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        userId: state.userId,
        email: state.email,
        firstName: state.firstName,
        lastName: state.lastName,
        role: state.role,
        roles: state.roles,
        tenantId: state.tenantId,
        availableTenants: state.availableTenants,
        tenantSelectionRequired: state.tenantSelectionRequired,
        preTenantToken: state.preTenantToken,
        availableRoles: state.availableRoles,
        roleSelectionRequired: state.roleSelectionRequired,
        preRoleToken: state.preRoleToken,
        permissions: state.permissions,
        mfaStatus: state.mfaStatus,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (state) {
          state.setHydrated(true);
        } else {
          useAuthStore.getState().setHydrated(true);
        }
      },
    },
  ),
);

// FIX: zustand's `persist` middleware writes every session change to
// localStorage, but nothing previously re-read that in OTHER open tabs. Tab
// A switching tenants (or logging out/in as someone else) rotates the
// shared refresh cookie immediately, but Tab B kept running on its own
// stale in-memory state until its next 401 forced a silent refresh — which
// then handed Tab B tab A's new tenant/session with zero on-screen
// indication anything had changed. Listening for the browser `storage`
// event (fired in every OTHER tab, never the one that made the write) and
// re-hydrating from whatever is now in localStorage keeps every open tab's
// in-memory state consistent with the single shared session immediately,
// instead of only on the next request that happens to 401.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === 'edams-auth') {
      useAuthStore.persist.rehydrate();
    }
  });
}
