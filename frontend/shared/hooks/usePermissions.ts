// shared/hooks/usePermissions.ts
// Reads the resolved permission set directly from the auth store.
// The store is populated from the /auth/me (or /auth/login) backend response,
// which is the single source of truth for what the current principal can do.
// role is exposed for display purposes only — never use it for authorization decisions.
import { useCallback, useMemo } from 'react';
import { useAuthStore } from '../../state/auth.store';

export interface PermissionsHook {
  can: (permission: string) => boolean;
  canAny: (permissions: string[]) => boolean;
  canAll: (permissions: string[]) => boolean;
  role: string | null;
  permissions: string[];
}

export function usePermissions(): PermissionsHook {
  const storePermissions = useAuthStore((s) => s.permissions);
  const role = useAuthStore((s) => s.role); // informational / display only

  // Every value returned here has a stable identity across renders. It used to
  // hand back a fresh `[]` whenever the store held no permissions, and three
  // brand-new closures on every single render — so anything downstream that
  // memoised on `can` or `permissions` (e.g. the document page's `visibleTabs`)
  // recomputed on every render, which is precisely the churn those useMemos
  // exist to prevent. It matters more than performance now: a value that
  // changes identity every render cannot be used as a change key, and
  // `useResetOnChange` adjusts state during render, where an always-changing
  // key is an infinite render loop rather than merely wasted work.
  const permissions = useMemo(() => storePermissions ?? [], [storePermissions]);
  const can = useCallback((permission: string) => permissions.includes(permission), [permissions]);
  const canAny = useCallback(
    (perms: string[]) => perms.some((p) => permissions.includes(p)),
    [permissions],
  );
  const canAll = useCallback(
    (perms: string[]) => perms.every((p) => permissions.includes(p)),
    [permissions],
  );

  return useMemo(
    () => ({ can, canAny, canAll, role, permissions }),
    [can, canAny, canAll, role, permissions],
  );
}
