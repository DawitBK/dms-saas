'use client';

import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Building2,
  FolderTree,
  FileStack,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  ChevronRight,
  ChevronDown,
  Users,
  UserPlus,
  UserMinus,
  Mail,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiClient } from '../../shared/lib/apiClient';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { EmptyState } from '../../shared/components/EmptyState';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useAuthStore } from '../../state/auth.store';
import { getErrorMessage as parseApiError } from '../../shared/lib/errorMessage';
import { ownerTicketHeaders } from '../../shared/lib/ownerTicket';

type FolderNode = {
  id: string;
  name: string;
  path: string;
  level: number;
  parentId: string | null;
  departmentId: string | null;
  orgUnitId: string | null;
};

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      {/* flex-col + a scrollable body below a non-shrinking header, rather
          than overflow-y-auto on the whole card: with everything scrolling
          together, a form tall enough to need scrolling (or the browser
          auto-scrolling a newly focused field into view) carries the title
          and Close button out of view along with the fields, with no way
          back to them short of scrolling back up blind. */}
      <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
          <h2 className="text-lg font-bold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-sm"
          >
            Close
          </button>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function LoadingRows({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-8 text-center">
        <RefreshCw className="h-6 w-6 animate-spin text-brand-600 mx-auto" />
      </td>
    </tr>
  );
}

export function TenantsCrudPanel() {
  const qc = useQueryClient();
  const router = useRouter();
  const { can } = usePermissions();
  const { tenantId: activeTenantId, switchTenant } = useAuthStore();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const isPlatformAdmin = can(PERMISSIONS.PLATFORM_ADMIN);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [membersTenant, setMembersTenant] = useState<{ id: string; name: string } | null>(null);
  // D10: executive-notice policy editor
  const [noticeTenant, setNoticeTenant] = useState<{ id: string; name: string } | null>(null);
  const [noticeTypes, setNoticeTypes] = useState<string[]>(['OUT', 'MEMO', 'CIRC', 'CONT']);
  const [noticeMax, setNoticeMax] = useState('INTERNAL');
  const [form, setForm] = useState({
    id: '',
    name: '',
    storageQuotaBytes: '10737418240',
    maxUsers: '50',
    maxDocuments: '100000',
  });
  // Owner-only: a single-use ticket issued by SSO (Owner verification), sent as X-Owner-Authorisation.
  const [ownerTicket, setOwnerTicket] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-tenants'],
    queryFn: () => apiClient<{ data: any[] }>('/tenants'),
    staleTime: 60_000,
  });

  const tenants = data?.data ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        storageQuotaBytes: Number(form.storageQuotaBytes),
        maxUsers: Number(form.maxUsers),
        maxDocuments: Number(form.maxDocuments),
      };
      if (modal === 'create') {
        return apiClient('/tenants', {
          method: 'POST',
          headers: ownerTicketHeaders(ownerTicket),
          body: JSON.stringify({ id: form.id.trim().toLowerCase(), ...payload }),
        });
      }
      return apiClient(`/tenants/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success(modal === 'create' ? 'Tenant created' : 'Tenant updated');
      setOwnerTicket(''); // single use: never keep a spent ticket
      setModal(null);
      setEditId(null);
    },
    onError: (err) => {
      setFieldError(parseApiError(err));
      toast.error(parseApiError(err));
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/tenants/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-tenants'] });
      toast.success('Tenant deactivated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  // D10: which letter types auto-email executives, up to which confidentiality.
  const noticeMutation = useMutation({
    mutationFn: () =>
      apiClient(`/tenants/${noticeTenant!.id}/exec-notice-config`, {
        method: 'PUT',
        body: JSON.stringify({ letterTypes: noticeTypes, maxConfidentiality: noticeMax }),
      }),
    onSuccess: () => {
      toast.success('Executive-notice policy saved');
      setNoticeTenant(null);
      qc.invalidateQueries({ queryKey: ['admin-tenants'] });
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const openCreate = () => {
    setForm({
      id: '',
      name: '',
      storageQuotaBytes: '10737418240',
      maxUsers: '50',
      maxDocuments: '100000',
    });
    setFieldError(null);
    setOwnerTicket('');
    setModal('create');
  };

  const openEdit = (t: any) => {
    setEditId(t.id);
    setForm({
      id: t.id,
      name: t.name,
      storageQuotaBytes: String(t.storageQuotaBytes ?? 10737418240),
      maxUsers: String(t.maxUsers ?? 50),
      maxDocuments: String(t.maxDocuments ?? 100000),
    });
    setFieldError(null);
    setModal('edit');
  };

  // Platform admins aren't scoped to their own tenant membership (see
  // tenants.routes.ts's assertOwnTenant / auth.service.ts's switchTenant —
  // both exempt platform:admin holders), so clicking a tenant here can
  // actually switch into ANY of them, not just ones they already belong to.
  // Lands on the dashboard, same as a normal post-login landing, now scoped
  // to the tenant just entered.
  const handleEnterTenant = async (tenantId: string) => {
    if (tenantId === activeTenantId || switchingTo) return;
    setSwitchingTo(tenantId);
    try {
      await switchTenant(tenantId);
      await qc.invalidateQueries();
      router.push('/dashboard');
    } catch (err) {
      toast.error(parseApiError(err));
    } finally {
      setSwitchingTo(null);
    }
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        {/* Creating a tenant is a platform operation, not a "manage my own
            tenant" one — see backend tenants.routes.ts's POST / gate. */}
        <PermissionGate permission={PERMISSIONS.PLATFORM_ADMIN}>
          <button onClick={openCreate} className="ui-btn ui-btn-primary text-sm">
            <Plus className="h-4 w-4" /> New Tenant
          </button>
        </PermissionGate>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">ID</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && <LoadingRows cols={4} />}
            {!isLoading &&
              tenants.map((t: any) => (
                <tr key={t.id} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-3 font-mono text-xs text-brand-600">
                    {isPlatformAdmin ? (
                      <button
                        onClick={() => handleEnterTenant(t.id)}
                        disabled={switchingTo !== null}
                        title={t.id === activeTenantId ? 'Currently active' : `Enter ${t.name}`}
                        className="hover:underline disabled:opacity-50 disabled:cursor-wait"
                      >
                        {switchingTo === t.id ? 'Entering…' : t.id}
                        {t.id === activeTenantId && <span className="ml-1.5 text-[10px] font-bold text-text-muted uppercase">(active)</span>}
                      </button>
                    ) : (
                      t.id
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary">
                    {t.name}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-full ${t.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                    >
                      {t.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PermissionGate permission={PERMISSIONS.TENANT_MANAGE}>
                      <div className="inline-flex gap-2">
                        <button
                          onClick={() => setMembersTenant({ id: t.id, name: t.name })}
                          className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                          title="Manage members"
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {
                            const cfg = (t.execNoticeConfig ?? {}) as { letterTypes?: string[]; maxConfidentiality?: string };
                            setNoticeTypes(cfg.letterTypes?.length ? cfg.letterTypes : ['OUT', 'MEMO', 'CIRC', 'CONT']);
                            setNoticeMax(cfg.maxConfidentiality ?? 'INTERNAL');
                            setNoticeTenant({ id: t.id, name: t.name });
                          }}
                          className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                          title="Executive letter notices"
                        >
                          <Mail className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => openEdit(t)}
                          className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {t.isActive && (
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  `Deactivate tenant "${t.name}"? Users will lose access.`,
                                )
                              ) {
                                deactivateMutation.mutate(t.id);
                              }
                            }}
                            className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                            title="Deactivate"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            {!isLoading && tenants.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    icon={Globe}
                    title="No tenants"
                    description="Create a tenant to enable multi-tenant isolation."
                    action={{
                      label: 'Create tenant',
                      onClick: openCreate,
                    }}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'Create Tenant' : 'Edit Tenant'}
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            {modal === 'create' && (
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Tenant ID *</label>
                <input
                  className="ui-input"
                  value={form.id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, id: e.target.value }))
                  }
                  placeholder="acme-corp"
                />
                <p className="text-xs text-text-muted mt-1">
                  Lowercase alphanumeric with hyphens only.
                </p>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Name *</label>
              <input
                className="ui-input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Storage (bytes)</label>
                <input
                  className="ui-input"
                  type="number"
                  value={form.storageQuotaBytes}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      storageQuotaBytes: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Max users</label>
                <input
                  className="ui-input"
                  type="number"
                  value={form.maxUsers}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, maxUsers: e.target.value }))
                  }
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Max documents</label>
                <input
                  className="ui-input"
                  type="number"
                  value={form.maxDocuments}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, maxDocuments: e.target.value }))
                  }
                />
              </div>
            </div>
            {modal === 'create' && (
              <div>
                <label
                  htmlFor="tenant-owner-ticket"
                  className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5"
                >
                  Owner authorisation ticket
                </label>
                <textarea
                  id="tenant-owner-ticket"
                  className="ui-input font-mono text-xs"
                  rows={3}
                  value={ownerTicket}
                  onChange={(e) => setOwnerTicket(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="tenant-owner-ticket-help"
                />
                <p id="tenant-owner-ticket-help" className="text-xs text-text-muted mt-1">
                  Get one in SSO &gt; Owner verification (valid for 5 minutes, works once). Required on the live server; leave
                  empty in development.
                </p>
              </div>
            )}
            {fieldError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {fieldError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setModal(null)}
                className="ui-btn ui-btn-secondary"
              >
                Cancel
              </button>
              <button
                disabled={
                  saveMutation.isPending ||
                  !form.name.trim() ||
                  (modal === 'create' && !form.id.trim())
                }
                onClick={() => saveMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {membersTenant && (
        <TenantMembersModal
          tenant={membersTenant}
          onClose={() => setMembersTenant(null)}
        />
      )}

      {noticeTenant && (
        <Modal
          title={`Executive letter notices — ${noticeTenant.name}`}
          onClose={() => setNoticeTenant(null)}
        >
          <div className="space-y-4">
            <p className="text-xs text-text-muted">
              When a letter is finally approved, executives are emailed a copy — governed
              by this policy. CONFIDENTIAL/RESTRICTED letters are never auto-emailed unless
              you raise the threshold here. Individual executives can additionally opt out
              in their own Settings → Profile.
            </p>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Letter types that notify</label>
              <div className="flex flex-wrap gap-3">
                {['OUT', 'MEMO', 'CIRC', 'CONT'].map((lt) => (
                  <label key={lt} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={noticeTypes.includes(lt)}
                      onChange={(e) =>
                        setNoticeTypes((p) => (e.target.checked ? [...p, lt] : p.filter((x) => x !== lt)))
                      }
                    />
                    {lt}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Notify up to confidentiality</label>
              <select className="ui-input" value={noticeMax} onChange={(e) => setNoticeMax(e.target.value)}>
                <option value="PUBLIC">PUBLIC only</option>
                <option value="INTERNAL">PUBLIC + INTERNAL (default)</option>
                <option value="CONFIDENTIAL">up to CONFIDENTIAL</option>
                <option value="RESTRICTED">everything (incl. RESTRICTED)</option>
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setNoticeTenant(null)} className="ui-btn ui-btn-secondary">Cancel</button>
              <button
                disabled={noticeMutation.isPending || noticeTypes.length === 0}
                onClick={() => noticeMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                Save policy
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

type TenantMemberRow = {
  id: string;
  userId: string;
  tenantId: string;
  assignedAt?: string;
  user?: { id: string; email: string; firstName: string; lastName: string; isActive: boolean };
};

// Tenant <-> user membership management (GET/POST/DELETE /tenants/:id/members).
// Users are global entities (no tenant_id column — scoped only via the
// user_tenants join row), so the "add member" picker draws from the full,
// unscoped /users list, matching how the backend route itself looks the
// candidate user up (no tenant filter, just isActive).
function TenantMembersModal({
  tenant,
  onClose,
}: {
  tenant: { id: string; name: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [addUserId, setAddUserId] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-members', tenant.id],
    queryFn: () => apiClient<{ data: TenantMemberRow[] }>(`/tenants/${tenant.id}/members`),
    staleTime: 10_000,
  });
  const members = data?.data ?? [];

  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['admin-users-for-tenant-picker'],
    queryFn: () => apiClient<{ data: Array<{ id: string; email: string; firstName: string; lastName: string; isActive: boolean }> }>('/users'),
    staleTime: 60_000,
  });
  const memberUserIds = new Set(members.map((m) => m.userId));
  const availableUsers = (usersData?.data ?? []).filter((u) => u.isActive && !memberUserIds.has(u.id));

  const addMutation = useMutation({
    mutationFn: (userId: string) =>
      apiClient(`/tenants/${tenant.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-members', tenant.id] });
      toast.success('Member added');
      setAddUserId('');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      apiClient(`/tenants/${tenant.id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-members', tenant.id] });
      toast.success('Member removed');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  return (
    <Modal title={`Members — ${tenant.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
            Add a user
          </label>
          <div className="flex gap-2">
            <select
              className="ui-input text-sm flex-1"
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value)}
              disabled={usersLoading}
            >
              <option value="">
                {usersLoading ? 'Loading users…' : 'Select a user to add…'}
              </option>
              {availableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} ({u.email})
                </option>
              ))}
            </select>
            <button
              onClick={() => addUserId && addMutation.mutate(addUserId)}
              disabled={!addUserId || addMutation.isPending}
              className="ui-btn ui-btn-primary text-sm shrink-0"
            >
              <UserPlus className="h-4 w-4" /> Add
            </button>
          </div>
          {availableUsers.length === 0 && !usersLoading && (
            <p className="text-xs text-text-muted mt-1.5">
              Every active user is already a member of this tenant.
            </p>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Current members ({members.length})
          </p>
          {isLoading ? (
            <div className="py-6 flex justify-center">
              <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
            </div>
          ) : members.length === 0 ? (
            <p className="text-sm text-text-muted italic py-4 text-center">
              No members yet. Add a user above to grant them access to this tenant.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto ui-scrollbar">
              {members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-surface-card"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {m.user ? `${m.user.firstName} ${m.user.lastName}` : m.userId}
                    </p>
                    <p className="text-xs text-text-muted font-mono truncate">{m.user?.email ?? '—'}</p>
                  </div>
                  <button
                    onClick={() => {
                      const label = m.user ? `${m.user.firstName} ${m.user.lastName}` : 'this user';
                      if (confirm(`Remove ${label} from "${tenant.name}"?`)) {
                        removeMutation.mutate(m.userId);
                      }
                    }}
                    className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50 shrink-0"
                    title="Remove from tenant"
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function DepartmentsCrudPanel() {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    orgUnitId: '',
    code: '',
    name: '',
    description: '',
    parentId: '' // Phase 3: Task 3.6 - parent department picker
  });
  const [fieldError, setFieldError] = useState<string | null>(null);

  // FIX: this panel used to fetch every department/org unit in the tenant
  // regardless of the caller's own membership — unlike FoldersCrudPanel
  // (server-side scoped via listReadableFolders), it showed the whole
  // hierarchy to anyone with department:read. `?scope=mine` reuses the same
  // opt-in narrowing departments.routes.ts/org-units.routes.ts already build
  // (membership ∪ ACL grant ∪ ancestors) — ACL_BYPASS_ADMIN holders still
  // get the unfiltered list.
  const { data, isLoading } = useQuery({
    queryKey: ['admin-departments', 'mine', showInactive],
    queryFn: () => apiClient<{ data: any[] }>(`/departments?scope=mine${showInactive ? '&includeInactive=true' : ''}`),
    staleTime: 60_000,
  });
  const { data: orgUnitsData } = useQuery({
    queryKey: ['org-units', 'mine'],
    queryFn: () => apiClient<{ data: any[] }>('/org-units?scope=mine'),
    staleTime: 60_000,
  });

  // Memoised, not `?? []` inline. A bare `?? []` builds a NEW empty array on
  // every render, so it changed identity every time and defeated the two
  // lookup-map useMemos below — the exact per-render rebuild those were added
  // to stop (see the FIX note under them). react-hooks/exhaustive-deps says so
  // in as many words.
  const departments = useMemo(() => data?.data ?? [], [data]);
  const orgUnits = useMemo(() => orgUnitsData?.data ?? [], [orgUnitsData]);

  // FIX (Finding 16): the table body used to call departments.find(...) per
  // row inside departments.map(...) — self-referential (O(D^2) on department
  // count) and re-run on every render. Build an id -> name lookup once per
  // data change instead.
  const departmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of departments as any[]) map.set(d.id, d.name);
    return map;
  }, [departments]);

  // Departments belong to exactly one org unit, so the list is grouped
  // tenant -> org unit -> department instead of shown as a flat table with
  // an org unit column — mirrors the real hierarchy instead of just naming it.
  const departmentsByOrgUnit = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const d of departments as any[]) {
      const key = d.orgUnitId ?? '__unassigned__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [departments]);
  const sortedOrgUnits = useMemo(
    () => (orgUnits as any[]).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [orgUnits],
  );
  const unassignedDepartments = departmentsByOrgUnit.get('__unassigned__') ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        orgUnitId: form.orgUnitId,
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        parentId: form.parentId.trim() || null, // Phase 3: Task 3.6
      };
      if (modal === 'create') {
        return apiClient('/departments', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      // Edit sends only what the person changed: a department head may rename or re-describe a
      // department but not re-home it, and the server refuses any orgUnitId from them. The parent
      // is not an ordinary field: it is changed through the move endpoint.
      const current = (departments as any[]).find((d) => d.id === editId);
      const changed: Record<string, unknown> = {};
      if (!current || payload.code !== current.code) changed.code = payload.code;
      if (!current || payload.name !== current.name) changed.name = payload.name;
      if (!current || (payload.description ?? '') !== (current.description ?? '')) changed.description = payload.description ?? '';
      if (!current || payload.orgUnitId !== current.orgUnitId) changed.orgUnitId = payload.orgUnitId;
      if (current && (payload.parentId ?? null) !== (current.parentId ?? null)) {
        await apiClient(`/departments/${editId}/move`, {
          method: 'PATCH',
          body: JSON.stringify({ parentId: payload.parentId }),
        });
      }
      if (Object.keys(changed).length === 0) return null;
      return apiClient(`/departments/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify(changed),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-departments'] });
      toast.success(
        modal === 'create' ? 'Department created' : 'Department updated',
      );
      setModal(null);
    },
    onError: (err) => {
      setFieldError(parseApiError(err));
      toast.error(parseApiError(err));
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/departments/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-departments'] });
      toast.success('Department re-activated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/departments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-departments'] });
      toast.success('Department deactivated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  return (
    <div>
      <div className="flex justify-end mb-4">
        <label className="mr-auto flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show deactivated
        </label>
        {/* A top-level department is an organisation-level act (the API refuses it for a
            department head, who adds sub-departments from the row action below). */}
        <PermissionGate anyOf={[PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.ORG_UNIT_MANAGE]}>
          <button
            onClick={() => {
              setForm({ orgUnitId: orgUnits[0]?.id ?? '', code: '', name: '', description: '', parentId: '' });
              setFieldError(null);
              setModal('create');
            }}
            className="ui-btn ui-btn-primary text-sm"
          >
            <Plus className="h-4 w-4" /> New Department
          </button>
        </PermissionGate>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Parent</th>
              <th className="px-4 py-3 text-left">Description</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && <LoadingRows cols={5} />}
            {!isLoading &&
              sortedOrgUnits.map((u: any) => {
                const deptsForUnit = departmentsByOrgUnit.get(u.id) ?? [];
                return (
                  <Fragment key={u.id}>
                    <tr className="bg-surface-raised/80">
                      <td colSpan={5} className="px-4 py-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
                        <div className="flex items-center gap-1.5">
                          <Globe className="h-3.5 w-3.5 text-indigo-400" />
                          {u.code} - {u.name}
                        </div>
                      </td>
                    </tr>
                    {deptsForUnit.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-2 pl-9 text-xs text-text-muted italic">
                          No departments in this org unit yet.
                        </td>
                      </tr>
                    )}
                    {deptsForUnit.map((d: any) => (
                      <tr key={d.id} className={`hover:bg-surface-raised/60 ${d.isActive === false ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-3 pl-9 font-mono font-bold text-brand-600 text-xs">
                          {d.code}
                        </td>
                        <td className="px-4 py-3 font-medium text-text-primary">
                          {d.name}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {d.parentId ? (
                            <span className="text-brand-600">
                              {departmentNameById.get(d.parentId) || 'Parent'}
                            </span>
                          ) : (
                            <span className="text-text-muted">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-text-muted text-xs">
                          {d.description || '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PermissionGate permission={PERMISSIONS.DEPT_MANAGE}>
                            <div className="inline-flex gap-2">
{d.isActive === false ? (
                            <button
                              onClick={() => reactivateMutation.mutate(d.id)}
                              className="px-2.5 py-1 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 rounded-lg"
                            >
                              Re-activate
                            </button>
                          ) : (<>

                              <button
                                title="Add sub-department"
                                onClick={() => {
                                  setForm({ orgUnitId: d.orgUnitId ?? '', code: '', name: '', description: '', parentId: d.id });
                                  setFieldError(null);
                                  setModal('create');
                                }}
                                className="p-1.5 text-text-muted hover:text-green-600 rounded-lg hover:bg-green-50"
                              >
                                <Plus className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => {
                                  setEditId(d.id);
                                  setForm({
                                    orgUnitId: d.orgUnitId ?? '',
                                    code: d.code,
                                    name: d.name,
                                    description: d.description ?? '',
                                    parentId: d.parentId ?? '', // Phase 3: Task 3.6
                                  });
                                  setFieldError(null);
                                  setModal('edit');
                                }}
                                className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Deactivate department "${d.name}"? Active documents will block this.`,
                                    )
                                  ) {
                                    deactivateMutation.mutate(d.id);
                                  }
                                }}
                                className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
</>)}</div>
                          </PermissionGate>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            {!isLoading && unassignedDepartments.length > 0 && (
              <Fragment>
                <tr className="bg-surface-raised/80">
                  <td colSpan={5} className="px-4 py-2 text-xs font-bold text-text-secondary uppercase tracking-wider">
                    Unassigned
                  </td>
                </tr>
                {unassignedDepartments.map((d: any) => (
                  <tr key={d.id} className={`hover:bg-surface-raised/60 ${d.isActive === false ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 pl-9 font-mono font-bold text-brand-600 text-xs">
                      {d.code}
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary">
                      {d.name}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {d.parentId ? (
                        <span className="text-brand-600">
                          {departmentNameById.get(d.parentId) || 'Parent'}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">
                      {d.description || '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PermissionGate permission={PERMISSIONS.DEPT_MANAGE}>
                        <div className="inline-flex gap-2">
{d.isActive === false ? (
                            <button
                              onClick={() => reactivateMutation.mutate(d.id)}
                              className="px-2.5 py-1 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 rounded-lg"
                            >
                              Re-activate
                            </button>
                          ) : (<>

                          <button
                            onClick={() => {
                              setEditId(d.id);
                              setForm({
                                orgUnitId: d.orgUnitId ?? '',
                                code: d.code,
                                name: d.name,
                                description: d.description ?? '',
                                parentId: d.parentId ?? '',
                              });
                              setFieldError(null);
                              setModal('edit');
                            }}
                            className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  `Deactivate department "${d.name}"? Active documents will block this.`,
                                )
                              ) {
                                deactivateMutation.mutate(d.id);
                              }
                            }}
                            className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
</>)}</div>
                      </PermissionGate>
                    </td>
                  </tr>
                ))}
              </Fragment>
            )}
            {!isLoading && departments.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    icon={Building2}
                    title="No departments"
                    description="Departments organize documents and user access scopes."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'create' ? 'Create Department' : 'Edit Department'}
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Org Unit *</label>
              <select
                className="ui-input"
                value={form.orgUnitId}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => {
                    // The backend rejects a parent department whose orgUnitId
                    // doesn't match (departments.service.ts's create/update —
                    // "a department's parent must be in the same org unit"),
                    // so a parent picked under the old org unit is guaranteed
                    // invalid the moment this changes.
                    const parent = departments.find((d: any) => d.id === f.parentId);
                    const parentStillValid = !f.parentId || parent?.orgUnitId === value;
                    return { ...f, orgUnitId: value, parentId: parentStillValid ? f.parentId : '' };
                  });
                }}
              >
                <option value="">Select an organizational unit…</option>
                {orgUnits.map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.code} - {u.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted mt-1">
                Which organizational unit (HQ, branch, etc.) this department belongs to.
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Code *</label>
              <input
                className="ui-input font-mono uppercase"
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))
                }
                minLength={2}
                maxLength={10}
                placeholder="e.g. HR, FINANCE"
              />
              <p className="text-xs text-text-muted mt-1">2–10 characters, uppercase letters/digits only.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Name *</label>
              <input
                className="ui-input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Parent Department
              </label>
              <select
                className="ui-input"
                value={form.parentId}
                disabled={!form.orgUnitId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, parentId: e.target.value }))
                }
              >
                <option value="">None (Top-level department)</option>
                {departments
                  // The backend rejects a parent in a different org unit
                  // (departments.service.ts) — same-named departments across
                  // org units were otherwise indistinguishable AND half of
                  // the shown options were guaranteed to fail on submit.
                  .filter((d: any) => d.id !== editId && d.orgUnitId === form.orgUnitId)
                  .map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {'  '.repeat(d.level || 0)}{d.code} - {d.name}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-text-muted mt-1">
                {form.orgUnitId
                  ? 'Optional. Creates a hierarchical department structure — only departments in the same org unit are eligible.'
                  : 'Select an org unit above first.'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Description</label>
              <textarea
                className="ui-input resize-none"
                rows={2}
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
              />
            </div>
            {fieldError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {fieldError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setModal(null)}
                className="ui-btn ui-btn-secondary"
              >
                Cancel
              </button>
              <button
                disabled={
                  saveMutation.isPending ||
                  !form.orgUnitId ||
                  !form.code.trim() ||
                  !form.name.trim()
                }
                onClick={() => saveMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function FoldersCrudPanel() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'create' | 'create-subfolder' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    parentId: '',
    orgUnitId: '',
    departmentId: '',
  });
  const [fieldError, setFieldError] = useState<string | null>(null);

  const { data: treeData, isLoading } = useQuery({
    queryKey: ['admin-folder-tree'],
    queryFn: () => apiClient<{ data: FolderNode[] }>('/folders/tree'),
    staleTime: 60_000,
  });

  // Phase 3: Task 3.7 - Fetch departments for cascading picker
  const { data: deptData } = useQuery({
    queryKey: ['admin-departments'],
    queryFn: () => apiClient<{ data: any[] }>('/departments'),
    staleTime: 60_000,
  });

  // Org units gate the department picker: a department belongs to exactly
  // one org unit, so the department list must be filtered by whichever org
  // unit is selected rather than showing every department in the tenant.
  const { data: orgUnitsData } = useQuery({
    queryKey: ['org-units'],
    queryFn: () => apiClient<{ data: any[] }>('/org-units'),
    staleTime: 60_000,
  });

  const folders = treeData?.data ?? [];
  const departments = deptData?.data ?? [];
  const orgUnits = orgUnitsData?.data ?? [];
  const departmentsForOrgUnit = form.orgUnitId
    ? departments.filter((d: any) => d.orgUnitId === form.orgUnitId)
    : [];

  // Foldable tree: order rows parent-before-child and only show a node's
  // descendants when it's expanded (default: all expanded so the full
  // tenant → org → department → category hierarchy is visible at a glance).
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  const childrenByParent = folders.reduce((acc, f) => {
    const key = f.parentId ?? '__root__';
    (acc[key] ??= []).push(f);
    return acc;
  }, {} as Record<string, FolderNode[]>);
  const sortByName = (a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name);
  const visibleFolderRows: Array<{ folder: FolderNode; depth: number; hasChildren: boolean }> = [];
  const walkFolders = (parentKey: string, depth: number) => {
    (childrenByParent[parentKey] ?? []).slice().sort(sortByName).forEach((folder) => {
      const hasChildren = (childrenByParent[folder.id] ?? []).length > 0;
      visibleFolderRows.push({ folder, depth, hasChildren });
      if (hasChildren && !collapsedRows.has(folder.id)) walkFolders(folder.id, depth + 1);
    });
  };
  walkFolders('__root__', 0);
  const toggleFolderRow = (id: string) =>
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Phase 3: Task 3.7 - Filter parent folders by selected department.
  // Split into "this department's own folders" and "global (no department)
  // umbrella folders" rather than one merged list — they were being offered
  // side by side with no indication of why a folder from a different
  // department context (departmentId === null) was showing up at all.
  const sortByPath = (a: FolderNode, b: FolderNode) => a.path.localeCompare(b.path);
  const ownDepartmentParentFolders = form.departmentId
    ? folders.filter((f) => f.departmentId === form.departmentId).slice().sort(sortByPath)
    : [];
  const globalParentFolders = folders.filter((f) => f.departmentId === null).slice().sort(sortByPath);
  const availableParentFolders = form.departmentId
    ? [...ownDepartmentParentFolders, ...globalParentFolders]
    : folders.slice().sort(sortByPath);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Validate form
      if (!form.name.trim()) {
        throw new Error('Folder name is required');
      }
      
      const payload: Record<string, string | null> = {
        name: form.name.trim(),
        parentId: form.parentId || null,
        departmentId: form.departmentId || null,
      };
      
      if (modal === 'create' || modal === 'create-subfolder') {
        return apiClient('/folders', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      
      if (modal === 'edit' && editId) {
        return apiClient(`/folders/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      }
      
      throw new Error('Invalid modal state');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-folder-tree'] });
      qc.invalidateQueries({ queryKey: ['folder-tree'] });
      toast.success((modal === 'create' || modal === 'create-subfolder') ? 'Folder created' : 'Folder updated');

      // Reset form state
      setForm({ name: '', parentId: '', orgUnitId: '', departmentId: '' });
      setEditId(null);
      setFieldError(null);
      setModal(null);
    },
    onError: (err) => {
      setFieldError(parseApiError(err));
      toast.error(parseApiError(err));
    },
  });

  // Deactivated folders (FOLDER_DELETE holders): list them and bring one back.
  const [showInactiveFolders, setShowInactiveFolders] = useState(false);
  const { data: inactiveData } = useQuery({
    queryKey: ['admin-folders-inactive'],
    queryFn: () => apiClient<{ data: FolderNode[] }>('/folders/inactive'),
    enabled: showInactiveFolders,
    staleTime: 15_000,
  });
  const reactivateFolderMutation = useMutation({
    mutationFn: (id: string) => apiClient(`/folders/${id}/activate`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-folders-inactive'] });
      qc.invalidateQueries({ queryKey: ['admin-folder-tree'] });
      qc.invalidateQueries({ queryKey: ['folder-tree'] });
      toast.success('Folder re-activated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/folders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-folder-tree'] });
      qc.invalidateQueries({ queryKey: ['folder-tree'] });
      toast.success('Folder deactivated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const openCreateSubfolder = (parentFolder: FolderNode) => {
    setEditId(null);
    setForm({
      name: '',
      parentId: parentFolder.id,
      orgUnitId: departments.find((d: any) => d.id === parentFolder.departmentId)?.orgUnitId ?? '',
      departmentId: parentFolder.departmentId ?? '',
    });
    setFieldError(null);
    setModal('create-subfolder');
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <PermissionGate permission={PERMISSIONS.FOLDER_CREATE}>
          <button
            onClick={() => {
              setForm({ name: '', parentId: '', orgUnitId: '', departmentId: '' });
              setFieldError(null);
              setModal('create');
            }}
            className="ui-btn ui-btn-primary text-sm"
          >
            <Plus className="h-4 w-4" /> New Folder
          </button>
        </PermissionGate>
      </div>
      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto ui-scrollbar">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead className="sticky top-0 bg-surface-card z-10">
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Path</th>
              <th className="px-4 py-3 text-left">Level</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && <LoadingRows cols={4} />}
            {!isLoading &&
              visibleFolderRows.map(({ folder: f, depth, hasChildren }) => (
                <tr key={f.id} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-3 font-medium text-text-primary">
                    <div className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                      {hasChildren ? (
                        <button
                          onClick={() => toggleFolderRow(f.id)}
                          className="p-0.5 -ml-1 text-text-muted hover:text-text-primary rounded"
                          title={collapsedRows.has(f.id) ? 'Expand' : 'Collapse'}
                        >
                          {collapsedRows.has(f.id) ? (
                            <ChevronRight className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </button>
                      ) : (
                        <span className="inline-block w-3.5" />
                      )}
                      <FolderTree className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                      <span>{f.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {f.path}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {f.level}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PermissionGate
                      anyOf={[
                        PERMISSIONS.FOLDER_CREATE,
                        PERMISSIONS.FOLDER_DELETE,
                      ]}
                    >
                      <div className="inline-flex gap-2">
                        <PermissionGate permission={PERMISSIONS.FOLDER_CREATE}>
                          <button
                            onClick={() => openCreateSubfolder(f)}
                            className="p-1.5 text-text-muted hover:text-green-600 rounded-lg hover:bg-green-50"
                            title="Add subfolder"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </PermissionGate>
                        <PermissionGate permission={PERMISSIONS.FOLDER_CREATE}>
                          <button
                            onClick={() => {
                              setEditId(f.id);
                              setForm({
                                name: f.name,
                                parentId: f.parentId ?? '',
                                orgUnitId: departments.find((d: any) => d.id === f.departmentId)?.orgUnitId ?? '',
                                departmentId: f.departmentId ?? '',
                              });
                              setFieldError(null);
                              setModal('edit');
                            }}
                            className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        </PermissionGate>
                        <PermissionGate permission={PERMISSIONS.FOLDER_DELETE}>
                          {f.level > 0 && (
                            <button
                              onClick={() => {
                                if (
                                  confirm(
                                    `Deactivate folder "${f.name}"? It must have no children or documents.`,
                                  )
                                ) {
                                  deactivateMutation.mutate(f.id);
                                }
                              }}
                              className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </PermissionGate>
                      </div>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            {!isLoading && folders.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState
                    icon={FolderTree}
                    title="No folders"
                    description="Create folders to build the repository hierarchy."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={
            modal === 'create' 
              ? 'Create Folder' 
              : modal === 'create-subfolder'
              ? 'Create Subfolder'
              : 'Edit Folder'
          }
          onClose={() => {
            setModal(null);
            setForm({ name: '', parentId: '', orgUnitId: '', departmentId: '' });
            setEditId(null);
            setFieldError(null);
          }}
        >
          <div className="space-y-4">
            {modal === 'create-subfolder' && form.parentId && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                <p className="text-sm text-blue-900 font-medium">
                  Creating subfolder under: <span className="font-bold">{folders.find(f => f.id === form.parentId)?.name || 'Unknown'}</span>
                </p>
                <p className="text-xs text-blue-700 mt-1">
                  Path: {folders.find(f => f.id === form.parentId)?.path || ''}
                </p>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Name *</label>
              <input
                className="ui-input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Enter folder name"
                autoFocus
                maxLength={255}
              />
              {form.name.trim() && (
                <p className="text-xs text-text-muted mt-1">
                  Preview: {form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}
                </p>
              )}
            </div>
            {modal !== 'create-subfolder' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                    Org Unit
                  </label>
                  <select
                    className="ui-input"
                    value={form.orgUnitId}
                    onChange={(e) => {
                      // Org unit gates which departments are selectable, so
                      // changing it invalidates whatever department/parent
                      // was previously chosen.
                      setForm((f) => ({ ...f, orgUnitId: e.target.value, departmentId: '', parentId: '' }));
                    }}
                  >
                    <option value="">— Select an org unit —</option>
                    {orgUnits.map((u: any) => (
                      <option key={u.id} value={u.id}>
                        {u.code} - {u.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-text-muted mt-1">
                    Which organizational unit this folder&apos;s department belongs to.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                    Department
                  </label>
                  <select
                    className="ui-input"
                    value={form.departmentId}
                    disabled={!form.orgUnitId}
                    onChange={(e) => {
                      // Phase 3: Task 3.7 - Reset parentId when department changes (cascading)
                      setForm((f) => ({ ...f, departmentId: e.target.value, parentId: '' }));
                    }}
                  >
                    <option value="">
                      {form.orgUnitId ? '— No department —' : '— Select an org unit first —'}
                    </option>
                    {departmentsForOrgUnit.map((d: any) => (
                      <option key={d.id} value={d.id}>
                        {d.code} - {d.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-text-muted mt-1">
                    Associate folder with a department. This filters available parent folders.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Parent folder</label>
                  <select
                    className="ui-input"
                    value={form.parentId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, parentId: e.target.value }))
                    }
                  >
                    <option value="">— Root level (no parent) —</option>
                    {form.departmentId ? (
                      <>
                        {ownDepartmentParentFolders.length > 0 && (
                          <optgroup label={`${departments.find((d: any) => d.id === form.departmentId)?.name ?? 'Department'} folders`}>
                            {ownDepartmentParentFolders.map((f) => (
                              <option key={f.id} value={f.id}>
                                {'  '.repeat(f.level)}
                                {f.name} ({f.path})
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {globalParentFolders.length > 0 && (
                          <optgroup label="Global folders (no department)">
                            {globalParentFolders.map((f) => (
                              <option key={f.id} value={f.id}>
                                {'  '.repeat(f.level)}
                                {f.name} ({f.path})
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    ) : (
                      availableParentFolders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {'  '.repeat(f.level)}
                          {f.name} ({f.path})
                        </option>
                      ))
                    )}
                  </select>
                  <p className="text-xs text-text-muted mt-1">
                    {form.departmentId
                      ? `${ownDepartmentParentFolders.length} folder(s) in this department, ${globalParentFolders.length} global folder(s) available as a parent.`
                      : 'Select a parent to create nested subfolders. ACL inherits from parent.'
                    }
                  </p>
                </div>
              </>
            )}
            {modal === 'create-subfolder' && (
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Department
                </label>
                <input 
                  className="ui-input" 
                  value={departments.find((d: any) => d.id === form.departmentId)?.name || 'None'} 
                  disabled 
                />
                <p className="text-xs text-text-muted mt-1">
                  Inherited from parent folder.
                </p>
              </div>
            )}
            {fieldError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {fieldError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setModal(null)}
                className="ui-btn ui-btn-secondary"
              >
                Cancel
              </button>
              <button
                disabled={saveMutation.isPending || !form.name.trim()}
                onClick={() => saveMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      <PermissionGate permission={PERMISSIONS.FOLDER_DELETE}>
        <div className="mt-6">
          <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
            <input type="checkbox" checked={showInactiveFolders} onChange={(e) => setShowInactiveFolders(e.target.checked)} />
            Show deactivated folders
          </label>
          {showInactiveFolders && (
            <div className="mt-3" data-testid="inactive-folders">
              {(inactiveData?.data ?? []).length === 0 ? (
                <p className="text-sm text-text-muted">No deactivated folders.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-text-muted"><th className="py-1">Path</th><th /></tr></thead>
                  <tbody>
                    {(inactiveData?.data ?? []).map((f) => (
                      <tr key={f.id} className="opacity-70 border-t border-border">
                        <td className="py-1.5">{f.path}</td>
                        <td className="text-right">
                          <button className="ui-btn ui-btn-secondary text-xs" disabled={reactivateFolderMutation.isPending} onClick={() => reactivateFolderMutation.mutate(f.id)}>
                            Re-activate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </PermissionGate>
    </div>
  );
}

export function DocumentTypesCrudPanel() {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // Tri-level scope, most specific first: DEPARTMENT (this one department
  // only) < ORG_UNIT (every department under one org unit) < TENANT (global,
  // the default) — mirrors DocumentType.departmentId/orgUnitId on the
  // backend (documentTypes.service.ts). `scopeType` is form-only UI state;
  // only departmentId/orgUnitId are ever sent to the API.
  const [form, setForm] = useState({
    scopeType: 'TENANT' as 'TENANT' | 'ORG_UNIT' | 'DEPARTMENT',
    orgUnitId: '',
    code: '',
    name: '',
    departmentId: '',
    defaultRetentionClass: '',
    requiresSignature: false,
    signatoryRole: '',
    // Governance policies (SYSTEM-DECISIONS.md D2/D5/D8). No separate
    // `signingPolicy` field here — see documentTypes.service.ts's 2026-09-14
    // fix: it's now always derived from `requiresSignature` server-side
    // (they used to be independently settable and drifted out of sync live),
    // so the form only needs to collect the one real input.
    auditPolicy: 'never',
    reapprovalPolicy: 'none',
    requiresApproval: true,
  });
  const [fieldError, setFieldError] = useState<string | null>(null);

  // FIX 2026-09-14: this field used to be free text, seeded with a
  // hardcoded default ("STANDARD") that isn't a real retention class —
  // retention_policies is a global, admin-curated catalog (Operations >
  // Retention Policies), and a document type whose class doesn't match one
  // of those rows saved fine here but then 500'd the first time anyone
  // actually uploaded/e-signed a document of that type. Sourcing the picker
  // from the real catalog makes a mismatch impossible instead of merely
  // rejected later.
  const { can } = usePermissions();
  const { data: retentionPoliciesData } = useQuery({
    queryKey: ['admin-doc-types-retention-policies'],
    queryFn: () => apiClient<{ data: any[] }>('/retention'),
    enabled: can(PERMISSIONS.RETENTION_READ),
    staleTime: 60_000,
  });
  const retentionPolicies = (retentionPoliciesData?.data ?? []).filter((p: any) => p.isActive !== false);

  // FIX: this panel used to fetch every document type in the tenant and only
  // narrow the *display* with the client-side org-unit/department filter bar
  // below — any user with document-type:read (broadly granted, same as
  // folder:read) saw types scoped to departments they have no relationship
  // to, and (separately, fixed server-side in documents.service.ts) could
  // even submit one on Upload. `?scope=mine` reuses the same opt-in
  // narrowing org-units/departments already build (membership ∪ ACL grant ∪
  // ancestors) — ACL_BYPASS_ADMIN holders still get the unfiltered list.
  const { data, isLoading } = useQuery({
    queryKey: ['admin-doc-types', 'mine', showInactive],
    queryFn: () => apiClient<{ data: any[] }>(`/document-types?scope=mine${showInactive ? '&includeInactive=true' : ''}`),
    staleTime: 5 * 60_000,
  });

  // Phase 3: Fetch departments for picker
  const { data: deptData } = useQuery({
    queryKey: ['admin-departments', 'mine'],
    queryFn: () => apiClient<{ data: any[] }>('/departments?scope=mine'),
    staleTime: 60_000,
  });

  // Org units gate the Scope picker the same way they gate the Folders
  // "Department" picker: a department belongs to exactly one org unit, so
  // listing every department in the tenant flat (with no org-unit context)
  // makes same/similarly-named departments in different org units
  // indistinguishable (e.g. two "Finance" departments). Scoped the same way
  // as the doc-types/departments queries above; a distinct query key
  // (`'mine'`, matching DepartmentsCrudPanel's own scoped org-units query)
  // from FoldersCrudPanel's plain `['org-units']` deliberately avoids sharing
  // a cache entry keyed the same way but backed by a differently-filtered
  // queryFn.
  const { data: orgUnitsData } = useQuery({
    queryKey: ['org-units', 'mine'],
    queryFn: () => apiClient<{ data: any[] }>('/org-units?scope=mine'),
    staleTime: 60_000,
  });

  const types = data?.data ?? [];
  const departments = deptData?.data ?? [];
  const orgUnits = orgUnitsData?.data ?? [];
  const departmentsForOrgUnit = form.orgUnitId
    ? departments.filter((d: any) => d.orgUnitId === form.orgUnitId)
    : [];

  // Filter bar (separate from the create/edit form's org-unit/department
  // state above): lets an admin narrow the table itself, same cascade as the
  // picker -- pick an org unit to filter its department list down.
  const [filterOrgUnitId, setFilterOrgUnitId] = useState('');
  const [filterDepartmentId, setFilterDepartmentId] = useState('');
  const departmentsForFilterOrgUnit = filterOrgUnitId
    ? departments.filter((d: any) => d.orgUnitId === filterOrgUnitId)
    : departments;
  const departmentById = new Map(departments.map((d: any) => [d.id, d]));
  const orgUnitNameById = new Map(orgUnits.map((u: any) => [u.id, u.name]));
  // Grouped by org unit so two same-code/same-name departments in different
  // org units (the reported "IT - Information Technology" / "FIN - Finance"
  // duplicates) are still distinguishable when "All org units" is selected —
  // filtering by org unit alone collapsed to one org unit's departments and
  // hid the ambiguity, but the flat, unfiltered default state didn't.
  const departmentFilterGroups = Object.entries(
    departmentsForFilterOrgUnit.reduce((acc: Record<string, any[]>, d: any) => {
      const label = (d.orgUnitId && orgUnitNameById.get(d.orgUnitId)) || 'No org unit';
      (acc[label] ??= []).push(d);
      return acc;
    }, {}),
  );
  const filteredTypes = types.filter((t: any) => {
    if (filterDepartmentId === '__global__') return !t.departmentId && !t.orgUnitId;
    if (filterDepartmentId === '__orgunit__') return !t.departmentId && t.orgUnitId === filterOrgUnitId;
    if (filterDepartmentId) return t.departmentId === filterDepartmentId;
    if (filterOrgUnitId) {
      // Org unit alone must be a fully working filter on its own -- strictly
      // "types scoped to this org unit or a department under it," not
      // "everything plus Global." Tenant-wide types were previously let
      // through unconditionally here, which made picking only an org unit
      // look like a no-op whenever every existing type happened to be
      // tenant-wide. Use the explicit "Global (tenant-wide)" option in the
      // Department filter to see those.
      if (t.orgUnitId === filterOrgUnitId) return true;
      if (!t.departmentId) return false;
      return departmentById.get(t.departmentId)?.orgUnitId === filterOrgUnitId;
    }
    return true;
  });
  const filtersActive = Boolean(filterOrgUnitId || filterDepartmentId);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Only one of departmentId/orgUnitId is ever sent, matching whichever
      // scope tier is selected — the backend's DB CHECK
      // (document_types_not_both_dept_and_org_unit) rejects both being set.
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        departmentId: form.scopeType === 'DEPARTMENT' ? form.departmentId.trim() || null : null,
        orgUnitId: form.scopeType === 'ORG_UNIT' ? form.orgUnitId.trim() || null : null,
        defaultRetentionClass: form.defaultRetentionClass.trim(),
        requiresSignature: form.requiresSignature,
        signatoryRole: form.signatoryRole.trim() || null,
        auditPolicy: form.auditPolicy,
        reapprovalPolicy: form.reapprovalPolicy,
        requiresApproval: form.requiresApproval,
      };
      if (modal === 'create') {
        return apiClient('/document-types', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      return apiClient(`/document-types/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-doc-types'] });
      toast.success(
        modal === 'create' ? 'Document type created' : 'Document type updated',
      );
      setModal(null);
    },
    onError: (err) => {
      setFieldError(parseApiError(err));
      toast.error(parseApiError(err));
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/document-types/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-doc-types'] });
      toast.success('Document type re-activated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/document-types/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-doc-types'] });
      toast.success('Document type deactivated');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Filter: Org Unit
            </label>
            <select
              className="ui-input"
              value={filterOrgUnitId}
              onChange={(e) => {
                const value = e.target.value;
                setFilterOrgUnitId(value);
                // Drop a department filter that no longer belongs to the
                // newly selected org unit (or clear it entirely when org
                // unit filtering is cleared). `__global__` (tenant-wide) and
                // `__orgunit__` (this org unit itself) aren't real department
                // ids — they stay valid regardless of which org unit is
                // selected, so they're exempt from this reconciliation.
                if (filterDepartmentId && filterDepartmentId !== '__global__' && filterDepartmentId !== '__orgunit__') {
                  const stillValid = value
                    ? departments.find((d: any) => d.id === filterDepartmentId)?.orgUnitId === value
                    : true;
                  if (!stillValid) setFilterDepartmentId('');
                }
                if (!value && filterDepartmentId === '__orgunit__') setFilterDepartmentId('');
              }}
            >
              <option value="">All org units</option>
              {orgUnits.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.code} - {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Filter: Department
            </label>
            <select
              className="ui-input"
              value={filterDepartmentId}
              onChange={(e) => setFilterDepartmentId(e.target.value)}
            >
              <option value="">All departments</option>
              <option value="__global__">Global (tenant-wide)</option>
              {filterOrgUnitId && <option value="__orgunit__">This org unit (all departments)</option>}
              {departmentFilterGroups.length > 1
                ? departmentFilterGroups.map(([groupLabel, depts]) => (
                    <optgroup key={groupLabel} label={groupLabel}>
                      {depts.map((d: any) => (
                        <option key={d.id} value={d.id}>
                          {d.code} - {d.name}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : departmentsForFilterOrgUnit.map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {d.code} - {d.name}
                    </option>
                  ))}
            </select>
          </div>
          {filtersActive && (
            <button
              onClick={() => {
                setFilterOrgUnitId('');
                setFilterDepartmentId('');
              }}
              className="ui-btn ui-btn-secondary text-sm"
            >
              Clear filters
            </button>
          )}
        </div>
        <label className="mr-auto flex items-center gap-2 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show deactivated
        </label>
        <PermissionGate permission={PERMISSIONS.DOCTYPE_MANAGE}>
          <button
            onClick={() => {
              setForm({
                scopeType: 'TENANT',
                orgUnitId: '',
                code: '',
                name: '',
                departmentId: '',
                defaultRetentionClass: '',
                requiresSignature: false,
                signatoryRole: '',
                auditPolicy: 'never',
                reapprovalPolicy: 'none',
                requiresApproval: true,
              });
              setFieldError(null);
              setModal('create');
            }}
            className="ui-btn ui-btn-primary text-sm"
          >
            <Plus className="h-4 w-4" /> New Document Type
          </button>
        </PermissionGate>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Scope</th>
              <th className="px-4 py-3 text-left">Retention</th>
              <th className="px-4 py-3 text-left">Signature</th>
              <th className="px-4 py-3 text-left">Governance</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && <LoadingRows cols={6} />}
            {!isLoading &&
              filteredTypes.map((t: any) => (
                <tr key={t.id} className={`hover:bg-surface-raised/60 ${t.isActive === false ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-mono font-bold text-brand-600 text-xs">
                    {t.code}
                  </td>
                  <td className="px-4 py-3 font-medium text-text-primary">
                    {t.name}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {t.departmentId ? (
                      <span className="text-brand-600 font-medium">
                        {(() => {
                          const dept = departmentById.get(t.departmentId);
                          if (!dept) return 'Department-specific';
                          // Department codes/names are only unique per org
                          // unit — name alone doesn't disambiguate two
                          // same-named departments in different org units
                          // (the reported "IT - Information Technology"
                          // duplicate), so the org unit is shown alongside it.
                          const unitName = dept.orgUnitId && orgUnitNameById.get(dept.orgUnitId);
                          return unitName ? `${dept.code} - ${dept.name} (${unitName})` : `${dept.code} - ${dept.name}`;
                        })()}
                      </span>
                    ) : t.orgUnitId ? (
                      <span className="text-amber-700 font-medium">
                        {orgUnitNameById.get(t.orgUnitId) ?? 'Org unit'} (all departments)
                      </span>
                    ) : (
                      <span className="text-text-muted">Global (tenant-wide)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-muted text-xs">
                    {t.defaultRetentionClass}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-full ${t.requiresSignature ? 'bg-blue-100 text-blue-700' : 'bg-surface-raised text-text-muted'}`}
                    >
                      {t.requiresSignature ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[11px] text-text-muted whitespace-nowrap">
                    {(t.requiresApproval ?? true) === false && (
                      <span className="mr-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">no approval needed</span>
                    )}
                    {(t.auditPolicy ?? 'never') !== 'never' && (
                      <span className="mr-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">audit: {t.auditPolicy}</span>
                    )}
                    {/* No separate "sign: ceremony" badge — signingPolicy is now always
                        derived from requiresSignature (documentTypes.service.ts), so it
                        would just duplicate the adjacent Signature column. */}
                    {(t.reapprovalPolicy ?? 'none') !== 'none' && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold">re-approve: {String(t.reapprovalPolicy).replace(/_/g, ' ')}</span>
                    )}
                    {(t.requiresApproval ?? true) === true && (t.auditPolicy ?? 'never') === 'never' && (t.reapprovalPolicy ?? 'none') === 'none' && '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PermissionGate permission={PERMISSIONS.DOCTYPE_MANAGE}>
                      <div className="inline-flex gap-2">
{t.isActive === false ? (
                            <button
                              onClick={() => reactivateMutation.mutate(t.id)}
                              className="px-2.5 py-1 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 rounded-lg"
                            >
                              Re-activate
                            </button>
                          ) : (<>
                        <button
                          onClick={() => {
                            setEditId(t.id);
                            setForm({
                              scopeType: t.departmentId ? 'DEPARTMENT' : t.orgUnitId ? 'ORG_UNIT' : 'TENANT',
                              orgUnitId:
                                t.orgUnitId ??
                                departments.find((d: any) => d.id === t.departmentId)?.orgUnitId ??
                                '',
                              code: t.code,
                              name: t.name,
                              departmentId: t.departmentId ?? '',
                              defaultRetentionClass: t.defaultRetentionClass,
                              requiresSignature: t.requiresSignature ?? false,
                              signatoryRole: t.signatoryRole ?? '',
                              auditPolicy: t.auditPolicy ?? 'never',
                              reapprovalPolicy: t.reapprovalPolicy ?? 'none',
                              requiresApproval: t.requiresApproval ?? true,
                            });
                            setFieldError(null);
                            setModal('edit');
                          }}
                          className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {
                            if (
                              confirm(
                                `Deactivate document type "${t.name}"? Active documents will block this.`,
                              )
                            ) {
                              deactivateMutation.mutate(t.id);
                            }
                          }}
                          className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
</>)}</div>
                    </PermissionGate>
                  </td>
                </tr>
              ))}
            {!isLoading && filteredTypes.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    icon={FileStack}
                    title={filtersActive ? 'No matching document types' : 'No document types'}
                    description={
                      filtersActive
                        ? 'No document types match the selected org unit / department filter.'
                        : 'Document types classify uploads and drive retention rules.'
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={
            modal === 'create' ? 'Create Document Type' : 'Edit Document Type'
          }
          onClose={() => setModal(null)}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Code *</label>
              <input
                className="ui-input font-mono uppercase"
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value }))
                }
                maxLength={10}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Name *</label>
              <input
                className="ui-input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                Scope
              </label>
              <select
                className="ui-input"
                value={form.scopeType}
                onChange={(e) => {
                  const scopeType = e.target.value as 'TENANT' | 'ORG_UNIT' | 'DEPARTMENT';
                  setForm((f) => ({ ...f, scopeType, ...(scopeType === 'TENANT' ? { orgUnitId: '', departmentId: '' } : {}) }));
                }}
              >
                <option value="TENANT">Tenant — every org unit (global)</option>
                <option value="ORG_UNIT">One org unit — all its departments</option>
                <option value="DEPARTMENT">One department only</option>
              </select>
              <p className="text-xs text-text-muted mt-1">
                {form.scopeType === 'TENANT'
                  ? 'Available to every department in every org unit.'
                  : form.scopeType === 'ORG_UNIT'
                    ? 'Available to every department under the org unit picked below, and no other org unit.'
                    : 'Available only within the single department picked below.'}
              </p>
            </div>
            {(form.scopeType === 'ORG_UNIT' || form.scopeType === 'DEPARTMENT') && (
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Org Unit *
                </label>
                <select
                  className="ui-input"
                  value={form.orgUnitId}
                  onChange={(e) => {
                    // Org unit gates which departments the Department picker
                    // can offer; changing it invalidates a department chosen
                    // under a different org unit.
                    setForm((f) => ({ ...f, orgUnitId: e.target.value, departmentId: '' }));
                  }}
                >
                  <option value="">— Select an org unit —</option>
                  {orgUnits.map((u: any) => (
                    <option key={u.id} value={u.id}>
                      {u.code} - {u.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {form.scopeType === 'DEPARTMENT' && (
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Department *
                </label>
                <select
                  className="ui-input"
                  value={form.departmentId}
                  disabled={!form.orgUnitId}
                  onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                >
                  <option value="">{form.orgUnitId ? '— Select a department —' : 'Pick an org unit first'}</option>
                  {departmentsForOrgUnit.map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {d.code} - {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Default retention class *</label>
              <select
                className="ui-input"
                value={form.defaultRetentionClass}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    defaultRetentionClass: e.target.value,
                  }))
                }
              >
                <option value="">— Select a retention class —</option>
                {retentionPolicies.map((p: any) => (
                  <option key={p.id} value={p.code}>
                    {p.code} — {p.name}
                  </option>
                ))}
                {/* Keeps an existing type's class selectable/visible even if that
                    policy was since deactivated, instead of silently blanking the
                    field out from under an edit. */}
                {form.defaultRetentionClass && !retentionPolicies.some((p: any) => p.code === form.defaultRetentionClass) && (
                  <option value={form.defaultRetentionClass}>{form.defaultRetentionClass} (inactive/unregistered)</option>
                )}
              </select>
              <p className="text-[11px] text-text-muted mt-1">
                Managed under Operations &gt; Retention Policies. A document type&apos;s class must match a
                registered policy — uploads/e-signing of this type fail if it doesn&apos;t.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={form.requiresSignature}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    requiresSignature: e.target.checked,
                  }))
                }
              />
              Requires signature
            </label>
            <p className="text-[11px] text-text-muted -mt-1.5 ml-6">
              The single switch for everything signature-related on this type: it&apos;s what makes this type
              selectable in E-Signing&apos;s upload picker, and what sends a document of this type into a signing
              ceremony (Pending Signature) once its approval chain completes, instead of going straight to Approved.
            </p>
            {form.requiresSignature && (
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Signatory role</label>
                <input
                  className="ui-input"
                  value={form.signatoryRole}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, signatoryRole: e.target.value }))
                  }
                />
              </div>
            )}
            {/* Governance policies (SYSTEM-DECISIONS.md D2/D5/D8) */}
            <div className="pt-1 border-t border-border-subtle">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!form.requiresApproval}
                  onChange={(e) => setForm((f) => ({ ...f, requiresApproval: !e.target.checked }))}
                />
                <span className="font-semibold text-text-secondary">No approval needed for this type</span>
              </label>
              <p className="text-[11px] text-text-muted mt-1 ml-6">
                When checked, documents of this type skip the approval chain entirely — the owner can Publish or
                Discard straight from Draft instead of submitting for approval.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-border-subtle">
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Audit stage</label>
                <select className="ui-input" value={form.auditPolicy}
                  onChange={(e) => setForm((f) => ({ ...f, auditPolicy: e.target.value }))}>
                  <option value="never">Never audited</option>
                  <option value="optional">Approver decides</option>
                  <option value="required">Always audited</option>
                </select>
                <p className="text-[11px] text-text-muted mt-1">Whether approved items must pass an auditor before archive.</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Re-approval</label>
                <select className="ui-input" value={form.reapprovalPolicy}
                  onChange={(e) => setForm((f) => ({ ...f, reapprovalPolicy: e.target.value }))}>
                  <option value="none">Edits never re-approve</option>
                  <option value="major_versions">Major versions only</option>
                  <option value="all_changes">Every change</option>
                </select>
                <p className="text-[11px] text-text-muted mt-1">When editing an approved document re-runs its chain.</p>
              </div>
            </div>
            {fieldError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {fieldError}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setModal(null)}
                className="ui-btn ui-btn-secondary"
              >
                Cancel
              </button>
              <button
                disabled={
                  saveMutation.isPending ||
                  !form.code.trim() ||
                  !form.name.trim() ||
                  !form.defaultRetentionClass.trim() ||
                  (form.scopeType === 'ORG_UNIT' && !form.orgUnitId) ||
                  (form.scopeType === 'DEPARTMENT' && !form.departmentId)
                }
                onClick={() => saveMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
