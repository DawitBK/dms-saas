'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Building2, Plus, Pencil, RefreshCw, Power } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState, InlineError } from '../../shared/components/ErrorState';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { getErrorMessage as parseApiError } from '../../shared/lib/errorMessage';

// CAMS organizational units — HQ / branches / outlets / sister companies.
// These are the archive spaces inside the tenant ("distributed creation,
// centralized visibility"). This panel is the admin surface for them; before
// it, org units could only be created via the API.

type OrgUnit = {
  id: string;
  code: string;
  name: string;
  unitType: 'HQ' | 'BRANCH' | 'OUTLET' | 'SISTER_COMPANY';
  letterheadTitle?: string | null;
  isActive: boolean;
};

const UNIT_TYPES = [
  { value: 'HQ', label: 'Head Office' },
  { value: 'BRANCH', label: 'Branch' },
  { value: 'OUTLET', label: 'Outlet' },
  { value: 'SISTER_COMPANY', label: 'Sister Company' },
] as const;

const TYPE_TINT: Record<OrgUnit['unitType'], string> = {
  HQ: 'var(--brand-600)',
  BRANCH: '#0891b2',
  OUTLET: '#7c3aed',
  SISTER_COMPANY: '#d97706',
};

export function OrgUnitsPanel() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', name: '', unitType: 'BRANCH', letterheadTitle: '' });
  const [fieldError, setFieldError] = useState<unknown>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    // FIX: this panel used to fetch every org unit in the tenant regardless
    // of the caller's own department memberships — an IT/DAWORG user saw HQ,
    // every branch, every sister company, with no restriction, unlike the
    // Folders panel (listReadableFolders) which scopes by default. `?scope=mine`
    // is the same opt-in narrowing org-units.routes.ts already built for
    // HierarchyTreeBrowser (getVisibleOrgUnitIds: membership ∪ ACL grant ∪
    // ancestors) — ACL_BYPASS_ADMIN holders still get the unfiltered list.
    queryKey: ['org-units', 'all', 'mine'],
    queryFn: () => apiClient<{ data: OrgUnit[] }>('/org-units?includeInactive=true&scope=mine'),
    staleTime: 60_000,
  });
  // Org units are flat by design — siblings directly under the tenant, never
  // nested (migration 20260707000001-flatten-org-units.sql); the API never
  // accepts a parentUnitId, so this is a plain list, not a tree.
  const units = data?.data ?? [];

  const save = useMutation({
    mutationFn: async () => {
      if (modal === 'create') {
        return apiClient('/org-units', {
          method: 'POST',
          body: JSON.stringify({
            code: form.code.trim().toUpperCase(),
            name: form.name.trim(),
            unitType: form.unitType,
            letterheadTitle: form.letterheadTitle.trim() || null,
          }),
        });
      }
      return apiClient(`/org-units/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.name.trim(),
          letterheadTitle: form.letterheadTitle.trim() || null,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-units'] });
      toast.success(modal === 'create' ? 'Unit created' : 'Unit updated');
      setModal(null);
      setEditId(null);
    },
    onError: (err) => {
      setFieldError(err);
      toast.error(parseApiError(err));
    },
  });

  const toggleActive = useMutation({
    mutationFn: (u: OrgUnit) =>
      apiClient(`/org-units/${u.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !u.isActive }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-units'] });
      toast.success('Unit updated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const openCreate = () => {
    setForm({ code: '', name: '', unitType: 'BRANCH', letterheadTitle: '' });
    setFieldError(null);
    setModal('create');
  };
  const openEdit = (u: OrgUnit) => {
    setEditId(u.id);
    setForm({ code: u.code, name: u.name, unitType: u.unitType, letterheadTitle: u.letterheadTitle ?? '' });
    setFieldError(null);
    setModal('edit');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Head office, branches, outlets, and sister companies — the CAMS archive spaces.
        </p>
        <PermissionGate permission={PERMISSIONS.ORG_UNIT_MANAGE}>
          <button onClick={openCreate} className="ui-btn ui-btn-primary">
            <Plus className="h-4 w-4" /> New unit
          </button>
        </PermissionGate>
      </div>

      {isError && (
        <div className="ui-card mb-3 p-0">
          <ErrorState error={error} title="Couldn't load organizational units" onRetry={() => refetch()} />
        </div>
      )}

      <div className="ui-card overflow-hidden p-0">
        <table className="ui-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center"><RefreshCw className="h-6 w-6 animate-spin mx-auto" style={{ color: 'var(--brand-600)' }} /></td></tr>
            ) : units.length === 0 ? (
              <tr><td colSpan={5}><EmptyState icon={Building2} title="No organizational units" description="Create your head office, then add branches and sister companies." /></td></tr>
            ) : (
              units.map((u) => (
                <tr key={u.id} className="ui-tr">
                  <td className="ui-td font-mono text-[12px]">{u.code}</td>
                  <td className="ui-td font-medium">{u.name}</td>
                  <td className="ui-td">
                    <span className="text-[11px] px-2 py-0.5 rounded-full text-white" style={{ background: TYPE_TINT[u.unitType] }}>
                      {UNIT_TYPES.find((t) => t.value === u.unitType)?.label ?? u.unitType}
                    </span>
                  </td>
                  <td className="ui-td">
                    <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: u.isActive ? 'var(--success-bg,#dcfce7)' : 'var(--surface-raised)', color: u.isActive ? '#15803d' : 'var(--text-muted)' }}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="ui-td text-right">
                    <PermissionGate permission={PERMISSIONS.ORG_UNIT_MANAGE}>
                      <button onClick={() => openEdit(u)} className="ui-btn-icon" title="Edit"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => toggleActive.mutate(u)} className="ui-btn-icon" title={u.isActive ? 'Deactivate' : 'Activate'}><Power className="h-4 w-4" /></button>
                    </PermissionGate>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {modal === 'create' ? 'New organizational unit' : 'Edit unit'}
              </h2>
              <button onClick={() => setModal(null)} className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Close</button>
            </div>
            {Boolean(fieldError) && <InlineError error={fieldError} className="mb-3" />}
            <div className="space-y-3">
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Code *</span>
                <input value={form.code} disabled={modal === 'edit'} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="ui-input mt-1 w-full font-mono" placeholder="e.g. GELANA" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Name *</span>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="ui-input mt-1 w-full" placeholder="e.g. Gelana Branch" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Letterhead title (optional)</span>
                <input
                  value={form.letterheadTitle}
                  onChange={(e) => setForm((f) => ({ ...f, letterheadTitle: e.target.value }))}
                  className="ui-input mt-1 w-full"
                  maxLength={120}
                  placeholder="Masthead on this unit's letters — blank uses EXAMPLE CORP"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Type</span>
                <select value={form.unitType} disabled={modal === 'edit'} onChange={(e) => setForm((f) => ({ ...f, unitType: e.target.value }))} className="ui-input mt-1 w-full">
                  {UNIT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setModal(null)} className="ui-btn ui-btn-secondary">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending} className="ui-btn ui-btn-primary">
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
