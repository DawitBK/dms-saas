'use client';

import { Building2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../../../state/auth.store';
import { API_BASE_URL } from '../../../shared/lib/apiConfig';

export default function SelectTenantPage() {
  const router = useRouter();
  const { availableTenants, preTenantToken, userId, setSession, clearSession } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Redirect if not in tenant selection state
    if (!preTenantToken || !availableTenants || availableTenants.length === 0) {
      router.push('/login');
    }
  }, [preTenantToken, availableTenants, router]);

  const formatTenantName = (id: string) => {
    return id
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  async function selectTenant(tenantId: string) {
    if (busy) return;
    
    setError(null);
    setBusy(true);
    
    try {
      const res = await fetch(
        `${API_BASE_URL}/auth/select-tenant`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${preTenantToken}`,
          },
          credentials: 'include',
          body: JSON.stringify({ tenantId }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Tenant selection failed');
      }

      const data = await res.json();

      // Multi-role user: tenant is now resolved, but which role to act as
      // isn't — mirrors the same branch in the login page.
      if (data.roleSelectionRequired) {
        setSession({
          userId: data.user.id,
          email: data.user.email,
          firstName: data.user.firstName,
          lastName: data.user.lastName,
          roles: data.user.roles,
          tenantId: data.user.tenantId,
          availableTenants: availableTenants,
          tenantSelectionRequired: false,
          preTenantToken: null,
          availableRoles: data.availableRoles ?? [],
          roleSelectionRequired: true,
          preRoleToken: data.preRoleToken,
          mfaStatus: 'verified',
        });
        router.push('/select-role');
        return;
      }

      const { accessToken, user } = data;

      setSession({
        accessToken,
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        roles: user.roles ?? [user.role],
        tenantId: user.tenantId,
        availableTenants: availableTenants,
        tenantSelectionRequired: false,
        preTenantToken: null,
        availableRoles: user.availableRoles ?? user.roles ?? [user.role],
        roleSelectionRequired: false,
        preRoleToken: null,
        permissions: user.permissions ?? [],
        mfaStatus: 'verified',
      });

      router.push('/dashboard');
    } catch (err: any) {
      setError(err?.message ?? 'Tenant selection failed');
      setBusy(false);
    }
  }

  const handleCancel = () => {
    clearSession();
    router.push('/login');
  };

  if (!availableTenants || availableTenants.length === 0) {
    return null;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <section className="w-full max-w-md bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 bg-indigo-600 rounded-xl">
            <ShieldCheck className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Select Workspace</h1>
            <p className="text-xs text-slate-500">
              Choose which workspace to access
            </p>
          </div>
        </div>

        {/* Info */}
        <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl mb-6">
          <p className="text-xs text-blue-800 leading-relaxed">
            You have access to multiple workspaces. Select one to continue. You can switch
            workspaces anytime from the sidebar.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
            {error}
          </div>
        )}

        {/* Tenant list */}
        <div className="space-y-2 mb-6">
          {availableTenants.map((tenant) => (
            <button
              key={tenant}
              onClick={() => selectTenant(tenant)}
              disabled={busy}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-left"
            >
              <div className="p-2 bg-slate-100 rounded-lg">
                <Building2 className="h-5 w-5 text-slate-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {formatTenantName(tenant)}
                </p>
                <p className="text-xs text-slate-500">{tenant}</p>
              </div>
            </button>
          ))}
        </div>

        {/* Cancel */}
        <button
          onClick={handleCancel}
          disabled={busy}
          className="w-full text-sm text-slate-600 hover:text-slate-900 font-medium disabled:opacity-50"
        >
          Cancel and sign out
        </button>
      </section>
    </div>
  );
}
