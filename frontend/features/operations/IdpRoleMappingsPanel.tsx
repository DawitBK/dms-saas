'use client';

// Read-only view of DMS's own idp_role_mappings table (roles/internal.routes.ts
// on the backend, only ever written to by the separate SSO/IdP admin console).
// Had zero DMS-side UI until now. Platform-admin-only.
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';

type Mapping = { adGroupDn: string; roleName: string };

export function IdpRoleMappingsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['idp-role-mappings'],
    queryFn: () => apiClient<{ data: Mapping[] }>('/roles/idp-mappings'),
    staleTime: 60_000,
  });

  const mappings = data?.data ?? [];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> AD Group → Role Mappings
        </h2>
        <p className="text-text-muted mt-1 text-sm">
          The ad_group_dn → role fallback SSO login consults when a login&rsquo;s roles
          claim is empty. Read-only here — managed from the SSO admin console.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">AD Group DN</th>
              <th className="px-4 py-3 text-left">DMS Role</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-text-muted">Loading…</td>
              </tr>
            )}
            {!isLoading && mappings.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-text-muted">No mappings configured.</td>
              </tr>
            )}
            {!isLoading &&
              mappings.map((m) => (
                <tr key={`${m.adGroupDn}:${m.roleName}`} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{m.adGroupDn}</td>
                  <td className="px-4 py-3 text-text-secondary font-medium">{m.roleName}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
