// shared/components/PermissionGate.tsx
// Gate UI fragments by permission string(s).
// Backend /auth/me is the single source of truth — never use role strings here.
import type { ReactNode } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import type { Permission } from '../lib/permissions';

interface PermissionGateProps {
  /** Show children only if user has this single permission */
  permission?: Permission | string;
  /** Show children if user has ANY of these permissions */
  anyOf?: (Permission | string)[];
  /** Show children only if user has ALL of these permissions */
  allOf?: (Permission | string)[];
  /** Rendered when permission check fails (default: null) */
  fallback?: ReactNode;
  children: ReactNode;
}

export function PermissionGate({
  permission,
  anyOf,
  allOf,
  fallback = null,
  children,
}: PermissionGateProps) {
  const { can, canAny, canAll } = usePermissions();

  const allowed = permission
    ? can(permission)
    : anyOf
      ? canAny(anyOf)
      : allOf
        ? canAll(allOf)
        : true;

  if (!allowed) return <>{fallback}</>;
  return <>{children}</>;
}
