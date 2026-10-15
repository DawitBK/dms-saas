'use client';

// Full-PAGE permission gate — distinct from PermissionGate (which silently
// renders nothing by default and is meant for in-page fragments/buttons).
//
// A user with no permission for a whole page only ever reaches it via a
// stale bookmark, browser back button, or a typed/pasted URL — Sidebar.tsx's
// `filteredGroups` already hides the nav link for anyone lacking the
// permission, so normal navigation never lands here. Rendering an inline
// "you don't have access" card in that situation still rendered the page
// shell (TopBar, layout) around an error message; this instead redirects
// away, which is closer to "this page doesn't exist for you at all" than
// either that message or a blank screen inside the shell would be.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePermissions } from '../hooks/usePermissions';
import type { Permission } from '../lib/permissions';

interface RequirePermissionProps {
  /** Require this single permission */
  permission?: Permission | string;
  /** Require ANY of these permissions */
  anyOf?: (Permission | string)[];
  /** Require ALL of these permissions */
  allOf?: (Permission | string)[];
  /** Where to send a user who fails the check (default: the dashboard home) */
  redirectTo?: string;
  children: React.ReactNode;
}

export function RequirePermission({
  permission,
  anyOf,
  allOf,
  redirectTo = '/dashboard',
  children,
}: RequirePermissionProps) {
  const router = useRouter();
  const { can, canAny, canAll } = usePermissions();
  const allowed = permission ? can(permission) : anyOf ? canAny(anyOf) : allOf ? canAll(allOf) : true;

  // Navigation, not state — react-hooks/set-state-in-effect (an
  // eslint-config-next 16 error) doesn't apply to a router call.
  useEffect(() => {
    if (!allowed) router.replace(redirectTo);
  }, [allowed, redirectTo, router]);

  if (!allowed) return null;
  return <>{children}</>;
}
