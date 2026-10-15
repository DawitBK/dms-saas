'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Building2, Check, ChevronDown } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../state/auth.store';
import { usePermissions } from '../hooks/usePermissions';
import { PERMISSIONS } from '../lib/permissions';
import { apiClient } from '../lib/apiClient';

export function TenantSwitcher() {
  const { tenantId, availableTenants, switchTenant } = useAuthStore();
  const { can } = usePermissions();
  const [switching, setSwitching] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const isPlatformAdmin = can(PERMISSIONS.PLATFORM_ADMIN);

  // A platform:admin holder isn't scoped to their own user_tenants
  // membership — GET /tenants already returns every tenant on the platform
  // for them (tenants.service.ts's listTenants). Everyone else keeps using
  // their own availableTenants from login/select-tenant, unchanged.
  const { data: allTenantsData } = useQuery({
    queryKey: ['tenant-switcher-all-tenants'],
    queryFn: () => apiClient<{ data: { id: string }[] }>('/tenants'),
    enabled: isPlatformAdmin,
    staleTime: 60_000,
  });

  const tenantIds = isPlatformAdmin
    ? (allTenantsData?.data ?? []).map((t) => t.id)
    : (availableTenants ?? []);

  if (!isPlatformAdmin && (!availableTenants || availableTenants.length <= 1)) return null;
  if (isPlatformAdmin && tenantIds.length === 0) return null;

  const handleSwitch = async (newTenantId: string) => {
    if (newTenantId === tenantId || switching) return;
    setSwitching(true);
    try {
      await switchTenant(newTenantId);
      // Invalidate all cached data and refetch with new tenant scope
      await queryClient.invalidateQueries();
      router.refresh();
    } catch (err: unknown) {
      // FIX: this comment was stale — switchTenant() only throws, it never
      // logs — so a failed switch used to vanish completely (dropdown just
      // closes as if nothing happened).
      toast.error(err instanceof Error ? err.message : 'Could not switch workspace');
    } finally {
      setSwitching(false);
    }
  };

  const formatName = (id: string) =>
    id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-[12px] font-medium transition-colors disabled:opacity-50"
          disabled={switching}
          style={{
            color: 'var(--sidebar-text)',
            background: 'var(--sidebar-hover-bg)',
            border: '1px solid var(--sidebar-border)',
          }}
        >
          <Building2 className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--brand-400)' }} />
          <span className="flex-1 min-w-0 truncate text-left">
            {tenantId ? formatName(tenantId) : 'Select Workspace'}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          align="start"
          className="z-50 min-w-[210px] p-1.5 animate-scale-in"
          style={{
            background: 'var(--surface-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <p
            className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            Switch Workspace
          </p>
          <DropdownMenu.Separator style={{ height: 1, background: 'var(--border)', marginBottom: 4 }} />

          {tenantIds.map((tenant) => {
            const isActive = tenant === tenantId;
            return (
              <DropdownMenu.Item
                key={tenant}
                onSelect={() => handleSwitch(tenant)}
                className="tenant-switcher-item flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-md text-[13px] font-medium cursor-pointer outline-none transition-colors"
                data-active={isActive}
                style={{
                  color: isActive ? 'var(--brand-600)' : 'var(--text-primary)',
                  background: isActive ? 'rgba(99,102,241,0.08)' : 'transparent',
                }}
              >
                <div className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{formatName(tenant)}</span>
                </div>
                {isActive && <Check className="h-3.5 w-3.5 shrink-0" />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
