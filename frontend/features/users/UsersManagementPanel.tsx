'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Activity,
  Building2,
  ChevronDown,
  ChevronRight,
  File,
  FolderOpen,
  Key,
  Lock,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  UserX,
  X,
} from 'lucide-react';
import { Avatar } from '../../shared/components/Avatar';
import { EmptyState } from '../../shared/components/EmptyState';
import { Modal } from '../../shared/components/Modal';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { useDepartments, useOrgUnits } from '../../shared/hooks/useLookups';
import { cn } from '../../shared/lib/cn';
import { apiClient } from '../../shared/lib/apiClient';
import {
  type AclGrant,
  type UserRecord,
  useRolesList,
  useRolePermissions,
  useUserActivity,
  useUserAclGrants,
  useUserDetail,
  useFoldersList,
  useUserMutations,
  useUsersList,
} from './hooks';
import { useResetOnChange } from '../../shared/hooks/useResetOnChange';
import { getErrorMessage as parseApiError } from '../../shared/lib/errorMessage';

function formatDate(value?: string | null) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function formatDateShort(value?: string | null) {
  if (!value) return '—';
  try { return new Date(value).toLocaleDateString(); } catch { return value; }
}

function RoleBadge({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-700 border border-brand-200 px-2 py-0.5 text-xs font-medium">
      {name}
      {onRemove && (
        <button onClick={onRemove} className="hover:text-brand-900 ml-0.5" title="Remove">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function DeptBadge({ code, name, onRemove }: { code: string; name: string; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-surface-raised text-text-secondary border border-border px-2 py-0.5 text-xs font-medium"
      title={name}
    >
      {code}
      {onRemove && (
        <button onClick={onRemove} className="hover:text-red-600 ml-0.5" title="Remove">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={cn(
      'text-xs font-bold px-2 py-0.5 rounded-full',
      active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
    )}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  document: 'Document',
  folder: 'Folder',
  department: 'Department',
  tenant: 'Tenant-wide',
};

const RESOURCE_TYPE_ICONS: Record<string, React.ReactNode> = {
  document: <File className="h-3.5 w-3.5 text-blue-500" />,
  folder: <FolderOpen className="h-3.5 w-3.5 text-yellow-500" />,
  department: <Building2 className="h-3.5 w-3.5 text-purple-500" />,
  tenant: <Shield className="h-3.5 w-3.5 text-green-500" />,
};

// FIX 2026-09-23: this list used to be hand-typed strings instead of the
// shared PERMISSIONS constant, and had drifted badly from what the backend
// actually checks — confirmed live: granting 'document:manage' to a real
// user created a real acl_entries row that no route anywhere checks (it
// isn't in config/permissions.ts at all), so the grant silently did
// nothing. 'document:write', 'document:delete', 'document:share',
// 'document:approve', 'document:sign' and 'folder:write' were the same —
// none of them are real permission strings this backend enforces. Every
// entry below is now PERMISSIONS.<X>, so it can't drift from the backend's
// catalog again; 'Full document management' and the other fictitious
// options are gone rather than relabeled, since there's no real permission
// that means "manage everything about a document" as a single grant here
// (see AccessControlCenter's fuller, always-in-sync permissionGroups for
// the complete catalog — this list is deliberately just the common subset
// for a quick per-user grant).
const COMMON_PERMISSIONS = [
  { value: PERMISSIONS.DOCUMENT_READ, label: 'Read documents' },
  { value: PERMISSIONS.DOCUMENT_READ_ALL, label: 'Read all documents (oversight)' },
  { value: PERMISSIONS.DOCUMENT_UPLOAD, label: 'Upload / create documents' },
  { value: PERMISSIONS.DOCUMENT_CHECKOUT, label: 'Check out documents for editing' },
  { value: PERMISSIONS.DOCUMENT_ARCHIVE, label: 'Archive documents' },
  { value: PERMISSIONS.DOCUMENT_PURGE, label: 'Purge documents' },
  { value: PERMISSIONS.FOLDER_READ, label: 'View folder' },
  { value: PERMISSIONS.FOLDER_CREATE, label: 'Create folders' },
  { value: PERMISSIONS.DEPT_READ, label: 'View department' },
  { value: PERMISSIONS.DEPT_MANAGE, label: 'Manage department' },
];

// ─── Document typeahead ───────────────────────────────────────────────────────
function DocTypeahead({ value, onChange }: { value: string; onChange: (id: string, label: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  // Fix: tracks the query as of the most recent keystroke so an in-flight
  // request can detect it's been superseded before applying its response —
  // otherwise a slower, older request can resolve after a faster, newer one
  // and clobber the newer (correct) results with stale ones.
  const latestQueryRef = useRef('');

  // Clearing the dropdown for a too-short query is derived from `q`, so it is a
  // render-time adjustment; only the debounced fetch below is a real effect.
  useResetOnChange([q, label], () => {
    if (!q || q.length < 2 || q === label) setResults([]);
  });

  useEffect(() => {
    latestQueryRef.current = q;
    if (!q || q.length < 2 || q === label) return;
    const t = setTimeout(async () => {
      const requestQuery = q;
      try {
        const r = await apiClient<{ data: any[] }>(`/documents?q=${encodeURIComponent(q)}&take=10`);
        if (latestQueryRef.current !== requestQuery) return; // stale response, discard
        setResults(r.data ?? []);
        setOpen(true);
      } catch {
        if (latestQueryRef.current === requestQuery) setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, label]);

  return (
    <div ref={ref} className="relative">
      <input
        className="ui-input text-sm"
        placeholder="Search document by title..."
        value={q}
        onChange={e => { setQ(e.target.value); if (!e.target.value) { onChange('', ''); setLabel(''); } }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full bg-surface-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto text-sm">
          {results.map(d => (
            <li key={d.id} onMouseDown={() => { const l = d.title || d.documentName; setQ(l); setLabel(l); setOpen(false); onChange(d.id, l); }}
              className="px-3 py-2 cursor-pointer hover:bg-surface-raised">
              <span className="font-medium">{d.title || d.documentName}</span>
              {d.documentNumber && <span className="ml-2 text-text-muted text-xs">#{d.documentNumber}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Add Grant Form ───────────────────────────────────────────────────────────
function AddGrantForm({
  userId,
  onSuccess,
  onCancel,
}: {
  userId: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { data: departments = [] } = useDepartments();
  const { data: folders = [] } = useFoldersList();
  const mutations = useUserMutations();

  const [resourceType, setResourceType] = useState<string>('document');
  const [resourceId, setResourceId] = useState('');
  const [resourceLabel, setResourceLabel] = useState('');
  const [permission, setPermission] = useState('document:read');
  const [effect, setEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [expiresAt, setExpiresAt] = useState('');

  const canSubmit = resourceId && permission;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await mutations.grantAccess.mutateAsync({
        resourceType,
        resourceId,
        principalId: userId,
        permission,
        effect,
        expiresAt: expiresAt || undefined,
      });
      toast.success('Access granted');
      onSuccess();
    } catch (err) {
      toast.error(parseApiError(err));
    }
  };

  return (
    <div className="border border-border rounded-xl p-4 bg-surface-raised space-y-3 mt-3">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">New Access Grant</p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-text-secondary mb-1">Resource type</label>
          <select
            className="ui-input text-sm"
            value={resourceType}
            onChange={e => { setResourceType(e.target.value); setResourceId(''); setResourceLabel(''); }}
          >
            <option value="document">Document</option>
            <option value="folder">Folder</option>
            <option value="department">Department</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-secondary mb-1">Effect</label>
          <select className="ui-input text-sm" value={effect} onChange={e => setEffect(e.target.value as 'ALLOW' | 'DENY')}>
            <option value="ALLOW">Allow</option>
            <option value="DENY">Deny</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs text-text-secondary mb-1">Resource</label>
        {resourceType === 'document' && (
          <DocTypeahead value={resourceId} onChange={(id, label) => { setResourceId(id); setResourceLabel(label); }} />
        )}
        {resourceType === 'folder' && (
          <select className="ui-input text-sm" value={resourceId} onChange={e => setResourceId(e.target.value)}>
            <option value="">Select folder…</option>
            {folders.map(f => <option key={f.id} value={f.id}>{f.name} ({f.path})</option>)}
          </select>
        )}
        {resourceType === 'department' && (
          <select className="ui-input text-sm" value={resourceId} onChange={e => setResourceId(e.target.value)}>
            <option value="">Select department…</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}
          </select>
        )}
      </div>

      <div>
        <label className="block text-xs text-text-secondary mb-1">Permission</label>
        <select className="ui-input text-sm" value={permission} onChange={e => setPermission(e.target.value)}>
          {COMMON_PERMISSIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs text-text-secondary mb-1">Expires (optional)</label>
        <input type="date" className="ui-input text-sm" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
        <button
          onClick={submit}
          disabled={!canSubmit || mutations.grantAccess.isPending}
          className={cn('ui-btn text-xs', effect === 'DENY' ? 'bg-red-600 hover:bg-red-700 text-white' : 'ui-btn-primary')}
        >
          {mutations.grantAccess.isPending ? 'Granting…' : `Grant ${effect}`}
        </button>
      </div>
    </div>
  );
}

// ─── User Drawer Tabs ──────────────────────────────────────────────────────────
type DrawerTab = 'profile' | 'roles' | 'departments' | 'access' | 'activity';

function ProfileTab({ user, mutations }: { user: UserRecord; mutations: ReturnType<typeof useUserMutations> }) {
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); } catch (err) { toast.error(parseApiError(err)); }
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><p className="text-xs text-text-muted mb-0.5">Email</p><p className="font-medium text-text-primary break-all">{user.email}</p></div>
        <div><p className="text-xs text-text-muted mb-0.5">Status</p><StatusBadge active={user.isActive} /></div>
        <div><p className="text-xs text-text-muted mb-0.5">Last login</p><p className="text-text-primary">{formatDate(user.lastLoginAt)}</p></div>
        <div><p className="text-xs text-text-muted mb-0.5">Created</p><p className="text-text-primary">{formatDateShort(user.createdAt)}</p></div>
        <div><p className="text-xs text-text-muted mb-0.5">MFA</p><p className="text-text-primary">{user.isMfaEnabled ? '✅ Enabled' : '○ Disabled'}</p></div>
        {user.lockedUntil && (
          <div><p className="text-xs text-text-muted mb-0.5">Locked until</p>
            <p className="text-red-600 font-medium">{formatDate(user.lockedUntil)}</p></div>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Quick actions</p>
        <div className="flex flex-wrap gap-2">
          {user.isActive ? (
            <button
              onClick={() => run(() => mutations.deactivateUser.mutateAsync(user.id), 'User deactivated')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors"
            >
              <UserX className="h-3.5 w-3.5" /> Deactivate
            </button>
          ) : (
            <button
              onClick={() => run(() => mutations.activateUser.mutateAsync(user.id), 'User activated')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
            >
              <UserCheck className="h-3.5 w-3.5" /> Activate
            </button>
          )}
          <button
            onClick={() => run(() => mutations.forceLogout.mutateAsync(user.id), 'Sessions revoked')}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-secondary hover:bg-surface-raised transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" /> Force logout
          </button>
          <button
            onClick={() => {
              if (confirm(`Soft-delete ${user.firstName} ${user.lastName}? They must have no active documents.`)) {
                run(() => mutations.softDeleteUser.mutateAsync(user.id), 'User deleted');
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function RolesTab({ user, mutations }: { user: UserRecord; mutations: ReturnType<typeof useUserMutations> }) {
  const { data: allRoles = [] } = useRolesList();
  const [addingRole, setAddingRole] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [expandPerms, setExpandPerms] = useState(false);

  const assignedRoleIds = new Set((user.roles ?? []).map(r => r.id));
  const availableRoles = allRoles.filter(r => !assignedRoleIds.has(r.id));

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); } catch (err) { toast.error(parseApiError(err)); }
  };

  const handleAdd = async () => {
    if (!selectedRoleId) return;
    await run(() => mutations.assignRole.mutateAsync({ userId: user.id, roleId: selectedRoleId }), 'Role assigned');
    setAddingRole(false);
    setSelectedRoleId('');
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Assigned roles</p>
          <button
            onClick={() => setAddingRole(!addingRole)}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
          >
            <Plus className="h-3.5 w-3.5" /> Add role
          </button>
        </div>

        {(user.roles ?? []).length === 0 ? (
          <p className="text-sm text-text-muted italic">No roles assigned.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(user.roles ?? []).map(r => (
              <RoleBadge
                key={r.id}
                name={r.name}
                onRemove={() => run(
                  () => mutations.removeRole.mutateAsync({ userId: user.id, roleId: r.id }),
                  `Role "${r.name}" removed`
                )}
              />
            ))}
          </div>
        )}

        {addingRole && (
          <div className="flex gap-2 mt-2">
            <select
              className="ui-input text-sm flex-1"
              value={selectedRoleId}
              onChange={e => setSelectedRoleId(e.target.value)}
            >
              <option value="">Select role to add…</option>
              {availableRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button onClick={handleAdd} disabled={!selectedRoleId} className="ui-btn ui-btn-primary text-xs">Add</button>
            <button onClick={() => setAddingRole(false)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
          </div>
        )}
      </div>

      {(user.roles ?? []).length > 0 && (
        <div className="border-t border-border pt-4">
          <button
            onClick={() => setExpandPerms(!expandPerms)}
            className="flex items-center gap-1.5 text-xs font-semibold text-text-muted uppercase tracking-wider hover:text-text-primary"
          >
            {expandPerms ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Effective permissions from roles
          </button>
          {expandPerms && (
            <div className="mt-2 space-y-3">
              {(user.roles ?? []).map(role => (
                <RolePermissionBlock key={role.id} roleId={role.id} roleName={role.name} />
              ))}
            </div>
          )}
        </div>
      )}

      <PermissionOverridesSection userId={user.id} />
    </div>
  );
}

// Per-user permission overrides: grant/revoke individual permissions on top of a
// user's roles. Backs GET/PUT /users/:id/permission-overrides, which previously
// had no UI at all (overrides could only be set via the IdP internal API).
function PermissionOverridesSection({ userId }: { userId: string }) {
  const [grants, setGrants] = useState<string[]>([]);
  const [revokes, setRevokes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  const allPerms = useMemo(() => Object.values(PERMISSIONS).sort(), []);
  const filteredPerms = useMemo(
    () => allPerms.filter((p) => p.toLowerCase().includes(pickerSearch.trim().toLowerCase())),
    [allPerms, pickerSearch],
  );
  const allFilteredSelected = filteredPerms.length > 0 && filteredPerms.every((p) => pickerSelected.has(p));

  // Raised during the render that first sees a new userId rather than
  // synchronously inside the effect (react-hooks/set-state-in-effect). On
  // mount `loading` already starts true, so this only fires for a genuine
  // change — which is also when the previous user's overrides would otherwise
  // have stayed on screen for a frame.
  useResetOnChange([userId], () => setLoading(true));

  useEffect(() => {
    let active = true;
    apiClient<{ data: { grants: string[]; revokes: string[] } }>(`/users/${userId}/permission-overrides`)
      .then((res) => { if (active) { setGrants(res.data?.grants ?? []); setRevokes(res.data?.revokes ?? []); } })
      .catch((err) => { if (active) toast.error(parseApiError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  const togglePicked = (perm: string) => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm); else next.add(perm);
      return next;
    });
  };

  // Toggles only the currently-filtered rows, leaving any selection made under
  // a different search term untouched — matches how the row checkboxes behave.
  const toggleSelectAllFiltered = () => {
    setPickerSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredPerms.forEach((p) => next.delete(p));
      else filteredPerms.forEach((p) => next.add(p));
      return next;
    });
  };

  const applyBulk = (effect: 'grant' | 'revoke') => {
    if (pickerSelected.size === 0) return;
    const picked = [...pickerSelected];
    if (effect === 'grant') {
      setGrants((g) => [...new Set([...g, ...picked])]);
      setRevokes((r) => r.filter((p) => !pickerSelected.has(p)));
    } else {
      setRevokes((r) => [...new Set([...r, ...picked])]);
      setGrants((g) => g.filter((p) => !pickerSelected.has(p)));
    }
    setPickerSelected(new Set());
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiClient(`/users/${userId}/permission-overrides`, { method: 'PUT', body: JSON.stringify({ grants, revokes }) });
      toast.success('Permission overrides saved');
      setDirty(false);
    } catch (err) { toast.error(parseApiError(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className="border-t border-border pt-4">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Permission overrides</p>
      <p className="text-xs text-text-muted mb-3">Grant or revoke individual permissions on top of this user&apos;s roles. A revoke always wins over a role grant.</p>
      {loading ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : (
        <>
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-semibold text-green-600 mb-1">Granted (in addition to roles)</p>
              {grants.length === 0 ? <p className="text-xs text-text-muted italic">None</p> : (
                <div className="flex flex-wrap gap-1">{grants.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded font-mono dark:bg-green-500/15 dark:border-green-500/30">
                    {p}<button onClick={() => { setGrants((g) => g.filter((x) => x !== p)); setDirty(true); }} className="hover:text-green-900" aria-label={`Remove grant ${p}`}>×</button>
                  </span>
                ))}</div>
              )}
            </div>
            <div>
              <p className="text-[11px] font-semibold text-red-600 mb-1">Revoked</p>
              {revokes.length === 0 ? <p className="text-xs text-text-muted italic">None</p> : (
                <div className="flex flex-wrap gap-1">{revokes.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded font-mono dark:bg-red-500/15 dark:border-red-500/30">
                    {p}<button onClick={() => { setRevokes((r) => r.filter((x) => x !== p)); setDirty(true); }} className="hover:text-red-900" aria-label={`Remove revoke ${p}`}>×</button>
                  </span>
                ))}</div>
              )}
            </div>
          </div>
          <div className="mt-3 border border-border rounded-md overflow-hidden">
            <div className="relative border-b border-border">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
              <input
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search permissions…"
                className="w-full text-xs pl-7 pr-2 py-1.5 bg-transparent focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 px-2 py-1.5 border-b border-border text-xs font-medium cursor-pointer hover:bg-surface-hover">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAllFiltered}
                className="accent-blue-600"
              />
              Select all {pickerSearch ? `(${filteredPerms.length} shown)` : `(${filteredPerms.length})`}
              {pickerSelected.size > 0 && (
                <span className="ml-auto text-text-muted font-normal">{pickerSelected.size} selected</span>
              )}
            </label>
            <div className="max-h-48 overflow-y-auto">
              {filteredPerms.length === 0 ? (
                <p className="text-xs text-text-muted italic px-2 py-3 text-center">No permissions match &quot;{pickerSearch}&quot;</p>
              ) : (
                filteredPerms.map((p) => (
                  <label key={p} className="flex items-center gap-2 px-2 py-1 text-xs font-mono cursor-pointer hover:bg-surface-hover">
                    <input
                      type="checkbox"
                      checked={pickerSelected.has(p)}
                      onChange={() => togglePicked(p)}
                      className="accent-blue-600"
                    />
                    <span className={cn(grants.includes(p) && 'text-green-600', revokes.includes(p) && 'text-red-600')}>{p}</span>
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 px-2 py-1.5 border-t border-border bg-surface">
              <button
                onClick={() => applyBulk('revoke')}
                disabled={pickerSelected.size === 0}
                className="ui-btn ui-btn-secondary text-xs text-red-600 border-red-200 dark:border-red-500/30"
              >
                Revoke Selected{pickerSelected.size > 0 ? ` (${pickerSelected.size})` : ''}
              </button>
              <button
                onClick={() => applyBulk('grant')}
                disabled={pickerSelected.size === 0}
                className="ui-btn ui-btn-secondary text-xs text-green-600 border-green-200 dark:border-green-500/30"
              >
                Grant Selected{pickerSelected.size > 0 ? ` (${pickerSelected.size})` : ''}
              </button>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <button onClick={save} disabled={saving || !dirty} className="ui-btn ui-btn-primary text-xs">{saving ? 'Saving…' : 'Save overrides'}</button>
          </div>
        </>
      )}
    </div>
  );
}

function RolePermissionBlock({ roleId, roleName }: { roleId: string; roleName: string }) {
  const { data: permissions = [], isLoading } = useRolePermissions(roleId);

  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1">{roleName}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : permissions.length === 0 ? (
        <p className="text-xs text-text-muted italic">No permissions configured</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {permissions.map((p: string) => (
            <span key={p} className="text-xs px-1.5 py-0.5 bg-surface-raised border border-border rounded font-mono text-text-secondary">{p}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function DepartmentsTab({ user, mutations }: { user: UserRecord; mutations: ReturnType<typeof useUserMutations> }) {
  const { data: allDepts = [] } = useDepartments();
  const { data: orgUnits = [] } = useOrgUnits();
  const [addingDept, setAddingDept] = useState(false);
  const [selectedDeptId, setSelectedDeptId] = useState('');
  // Same org-unit gate as the Create/Edit user modal's Departments picker
  // (and every other department picker in the app) -- a department belongs
  // to exactly one org unit, so listing every department in the tenant flat
  // makes same-named departments in different org units indistinguishable.
  // A user's department memberships aren't restricted to one org unit (a
  // user CAN belong to departments across several), so this narrows the
  // "Add" list rather than hard-filtering what can be assigned.
  const [addOrgUnitFilter, setAddOrgUnitFilter] = useState('');

  const assignedIds = new Set((user.departments ?? []).map(d => d.id));
  const available = allDepts
    .filter(d => !assignedIds.has(d.id))
    .filter(d => !addOrgUnitFilter || d.orgUnitId === addOrgUnitFilter);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast.success(msg); } catch (err) { toast.error(parseApiError(err)); }
  };

  const handleAdd = async () => {
    if (!selectedDeptId) return;
    await run(
      () => mutations.assignDepartment.mutateAsync({ userId: user.id, departmentId: selectedDeptId }),
      'Department assigned'
    );
    setAddingDept(false);
    setSelectedDeptId('');
    setAddOrgUnitFilter('');
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Department membership</p>
          <button
            onClick={() => setAddingDept(!addingDept)}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>

        {(user.departments ?? []).length === 0 ? (
          <p className="text-sm text-text-muted italic">No department membership.</p>
        ) : (
          <div className="space-y-1.5">
            {(user.departments ?? []).map(d => (
              <div key={d.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-surface-card hover:bg-surface-raised">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-text-muted shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{d.name}</p>
                    <p className="text-xs text-text-muted font-mono">
                      {d.code}
                      {d.orgUnitId && (
                        <span className="ml-1.5 text-text-muted/70">· {orgUnits.find(u => u.id === d.orgUnitId)?.name ?? 'unknown org unit'}</span>
                      )}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => run(
                    () => mutations.removeDepartment.mutateAsync({ userId: user.id, departmentId: d.id }),
                    `Removed from ${d.name}`
                  )}
                  className="p-1 text-text-muted hover:text-red-600 rounded transition-colors"
                  title="Remove from department"
                >
                  <UserMinus className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {addingDept && (
          <div className="mt-2 space-y-2">
            <select
              className="ui-input text-sm w-full"
              value={addOrgUnitFilter}
              onChange={e => { setAddOrgUnitFilter(e.target.value); setSelectedDeptId(''); }}
            >
              <option value="">Filter by org unit: all</option>
              {orgUnits.map(u => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}
            </select>
            <div className="flex gap-2">
              <select
                className="ui-input text-sm flex-1"
                value={selectedDeptId}
                onChange={e => setSelectedDeptId(e.target.value)}
              >
                <option value="">Select department…</option>
                {available.map(d => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}
              </select>
              <button onClick={handleAdd} disabled={!selectedDeptId} className="ui-btn ui-btn-primary text-xs">Add</button>
              <button onClick={() => { setAddingDept(false); setAddOrgUnitFilter(''); }} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4 text-xs text-text-muted">
        <p>Membership gives this person read access to that department&apos;s documents — including the ones filed before they joined — and takes it away again when they leave. It covers that department only, not its sub-departments or its parent: join each one they need. Use the Access tab for a grant outside the department.</p>
      </div>
    </div>
  );
}

function AccessTab({ user }: { user: UserRecord }) {
  const mutations = useUserMutations();
  const { data: grants = [], isLoading, refetch } = useUserAclGrants(user.id);
  const { data: departments = [] } = useDepartments();
  const { data: folders = [] } = useFoldersList();
  const [showAddForm, setShowAddForm] = useState(false);

  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);
  const folderMap = useMemo(() => Object.fromEntries(folders.map(f => [f.id, f.name])), [folders]);

  function resolveResourceName(grant: AclGrant): string {
    if (grant.resourceType === 'department') return deptMap[grant.resourceId] ?? `dept:${grant.resourceId.slice(0, 8)}…`;
    if (grant.resourceType === 'folder') return folderMap[grant.resourceId] ?? `folder:${grant.resourceId.slice(0, 8)}…`;
    return `${grant.resourceId.slice(0, 8)}…`;
  }

  const revoke = async (grant: AclGrant) => {
    if (!confirm(`Revoke "${grant.permission}" on ${RESOURCE_TYPE_LABELS[grant.resourceType] ?? grant.resourceType}?`)) return;
    try {
      await mutations.revokeAccess.mutateAsync({ aclId: grant.id, userId: user.id });
      toast.success('Access revoked');
    } catch (err) {
      toast.error(parseApiError(err));
    }
  };

  const allowGrants = grants.filter(g => g.effect === 'ALLOW');
  const denyGrants = grants.filter(g => g.effect === 'DENY');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          Direct ACL grants ({grants.length})
        </p>
        <PermissionGate permission={PERMISSIONS.ACL_MANAGE}>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
        >
          <Plus className="h-3.5 w-3.5" /> Grant access
        </button>
        </PermissionGate>
      </div>

      {showAddForm && (
        <AddGrantForm
          userId={user.id}
          onSuccess={() => { setShowAddForm(false); refetch(); }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {isLoading ? (
        <div className="py-6 flex justify-center"><RefreshCw className="h-5 w-5 animate-spin text-brand-600" /></div>
      ) : grants.length === 0 ? (
        <div className="text-center py-8 text-text-muted text-sm">
          <ShieldOff className="h-8 w-8 mx-auto mb-2 opacity-30" />
          No direct access grants. Access is derived from roles and department membership.
        </div>
      ) : (
        <div className="space-y-1">
          {grants.map(grant => (
            <div key={grant.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface-card hover:bg-surface-raised group text-sm">
              <span className="shrink-0">{RESOURCE_TYPE_ICONS[grant.resourceType] ?? <Shield className="h-3.5 w-3.5" />}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-text-primary truncate">{resolveResourceName(grant)}</span>
                  <span className="text-xs text-text-muted">{RESOURCE_TYPE_LABELS[grant.resourceType] ?? grant.resourceType}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="font-mono text-xs text-text-secondary">{grant.permission}</span>
                  <span className={cn(
                    'text-xs px-1.5 py-0 rounded font-bold',
                    grant.effect === 'ALLOW' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  )}>{grant.effect}</span>
                  {grant.expiresAt && (
                    <span className="text-xs text-amber-600">Expires {formatDateShort(grant.expiresAt)}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => revoke(grant)}
                className="shrink-0 p-1 text-text-muted hover:text-red-600 rounded opacity-0 group-hover:opacity-100 transition-all"
                title="Revoke"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {grants.length > 0 && (
        <div className="border-t border-border pt-3 text-xs text-text-muted space-y-0.5">
          <p>✅ ALLOW grants ({allowGrants.length}) · 🚫 DENY grants ({denyGrants.length})</p>
          <p>DENY always overrides ALLOW at the same or lower scope.</p>
        </div>
      )}
    </div>
  );
}

function ActivityTab({ userId }: { userId: string }) {
  const { data: activity = [], isLoading } = useUserActivity(userId);

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Recent activity</p>
      {isLoading ? (
        <div className="py-6 flex justify-center"><RefreshCw className="h-5 w-5 animate-spin text-brand-600" /></div>
      ) : activity.length === 0 ? (
        <p className="text-sm text-text-muted italic text-center py-6">No recent activity recorded.</p>
      ) : (
        <ul className="space-y-1.5 max-h-96 overflow-y-auto ui-scrollbar">
          {activity.map(e => (
            <li key={e.id} className="px-3 py-2 text-xs border border-border-subtle rounded-lg bg-surface-raised">
              <span className="font-semibold text-text-primary">{e.eventType}</span>
              <span className="text-text-muted ml-2">{formatDate(e.timestamp)}</span>
              {e.actionDetails && Object.keys(e.actionDetails).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-text-muted hover:text-text-secondary">Details</summary>
                  <pre className="mt-1 text-text-muted overflow-x-auto">
                    {JSON.stringify(e.actionDetails, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── User Drawer ──────────────────────────────────────────────────────────────
function UserDrawer({
  userId,
  onClose,
  onEdit,
}: {
  userId: string;
  onClose: () => void;
  onEdit: (user: UserRecord) => void;
}) {
  const { data: user, isLoading, refetch } = useUserDetail(userId);
  const mutations = useUserMutations();
  const [tab, setTab] = useState<DrawerTab>('profile');

  const tabs: { key: DrawerTab; label: string; icon: React.ReactNode }[] = [
    { key: 'profile', label: 'Profile', icon: <Users className="h-3.5 w-3.5" /> },
    { key: 'roles', label: 'Roles', icon: <Key className="h-3.5 w-3.5" /> },
    { key: 'departments', label: 'Departments', icon: <Building2 className="h-3.5 w-3.5" /> },
    { key: 'access', label: 'Access Grants', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    { key: 'activity', label: 'Activity', icon: <Activity className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="flex flex-col h-full w-full border-l border-border bg-surface-card overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-border shrink-0">
        {isLoading || !user ? (
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-surface-raised animate-pulse" />
            <div className="space-y-1.5">
              <div className="h-4 w-32 bg-surface-raised rounded animate-pulse" />
              <div className="h-3 w-44 bg-surface-raised rounded animate-pulse" />
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <Avatar firstName={user.firstName} lastName={user.lastName} email={user.email} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-text-primary">{user.firstName} {user.lastName}</h3>
                <StatusBadge active={user.isActive} />
              </div>
              <p className="text-xs text-text-muted font-mono mt-0.5 break-all">{user.email}</p>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <button
                  onClick={() => onEdit(user)}
                  className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
                >
                  <Pencil className="h-3 w-3" /> Edit profile
                </button>
                <span className="text-border">·</span>
                <button onClick={() => refetch()} className="text-xs text-text-muted hover:text-text-primary">
                  <RefreshCw className="h-3 w-3 inline mr-0.5" />Refresh
                </button>
              </div>
            </div>
            <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary rounded shrink-0">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Tab nav */}
      <div className="flex border-b border-border shrink-0 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === t.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-text-muted hover:text-text-primary'
            )}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {!user && isLoading && (
          <div className="py-12 flex justify-center"><RefreshCw className="h-6 w-6 animate-spin text-brand-600" /></div>
        )}
        {user && (
          <>
            {tab === 'profile' && <ProfileTab user={user} mutations={mutations} />}
            {tab === 'roles' && <RolesTab user={user} mutations={mutations} />}
            {tab === 'departments' && <DepartmentsTab user={user} mutations={mutations} />}
            {tab === 'access' && <AccessTab user={user} />}
            {tab === 'activity' && <ActivityTab userId={user.id} />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Create/Edit form ─────────────────────────────────────────────────────────
type FormState = {
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  roleIds: string[];
  departmentIds: string[];
};

const emptyForm = (): FormState => ({ email: '', firstName: '', lastName: '', isActive: true, roleIds: [], departmentIds: [] });

function MultiCheckbox({
  items, selected, onChange, labelKey = 'name', idKey = 'id', secondaryKey,
}: {
  items: Array<Record<string, string>>;
  selected: string[];
  onChange: (ids: string[]) => void;
  labelKey?: string;
  idKey?: string;
  secondaryKey?: string;
}) {
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="space-y-0.5 max-h-36 overflow-y-auto ui-scrollbar border border-border rounded-lg p-2">
      {items.map(item => (
        <label key={item[idKey]} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-raised cursor-pointer text-sm">
          <input type="checkbox" checked={selected.includes(item[idKey])} onChange={() => toggle(item[idKey])} className="rounded border-border" />
          <span className="text-text-primary">{item[labelKey]}</span>
          {secondaryKey && item[secondaryKey] && <span className="text-xs text-text-muted font-mono">{item[secondaryKey]}</span>}
        </label>
      ))}
      {items.length === 0 && <p className="text-sm text-text-muted px-2 py-1">None available</p>}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
const PAGE_SIZE = 15;

export function UsersManagementPanel() {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [orgUnitFilter, setOrgUnitFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);

  const { data: roles = [] } = useRolesList();
  const { data: departments = [] } = useDepartments();
  const { data: orgUnits = [] } = useOrgUnits();
  const departmentsForOrgUnitFilter = orgUnitFilter
    ? departments.filter((d) => d.orgUnitId === orgUnitFilter)
    : departments;

  const { data: usersPage, isLoading, refetch } = useUsersList({
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    q: search.trim() || undefined,
    roleId: roleFilter || undefined,
    departmentId: deptFilter || undefined,
    orgUnitId: orgUnitFilter || undefined,
    isActive: statusFilter === 'all' ? undefined : statusFilter,
  });
  const users = usersPage?.data ?? [];
  const total = usersPage?.total ?? users.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilters = Boolean(search.trim() || roleFilter || orgUnitFilter || deptFilter || statusFilter !== 'all');

  const mutations = useUserMutations();

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Filters are now applied server-side (see useUsersList) so they compose
  // with pagination — the current page IS the filtered result, no further
  // client-side filtering needed. Reset to page 1 whenever a filter changes
  // so the user isn't left on a page number that no longer exists.
  const updateSearch = (v: string) => { setSearch(v); setPage(1); };
  const updateRoleFilter = (v: string) => { setRoleFilter(v); setPage(1); };
  const updateOrgUnitFilter = (v: string) => {
    setOrgUnitFilter(v);
    // Drop a department filter that doesn't belong to the newly selected org
    // unit -- otherwise the two filters silently AND together into an
    // impossible combination (a department from a different org unit) and
    // the list just goes empty with no visible explanation.
    if (deptFilter && v && departments.find(d => d.id === deptFilter)?.orgUnitId !== v) {
      setDeptFilter('');
    }
    setPage(1);
  };
  const updateDeptFilter = (v: string) => { setDeptFilter(v); setPage(1); };
  const updateStatusFilter = (v: 'all' | 'active' | 'inactive') => { setStatusFilter(v); setPage(1); };

  // Filters which departments the Create/Edit modal's Departments checklist
  // shows -- narrowing only, never discards an existing selection outside the
  // chosen org unit, since a user can legitimately belong to departments
  // across multiple org units at once (unlike the single-select org-unit
  // pickers elsewhere in the app).
  const [deptPickerOrgUnit, setDeptPickerOrgUnit] = useState('');

  const openCreate = () => { setForm(emptyForm()); setFieldError(null); setDeptPickerOrgUnit(''); setCreateOpen(true); };

  const openEdit = (user: UserRecord) => {
    setEditUser(user);
    setForm({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
      roleIds: (user.roles ?? []).map(r => r.id),
      departmentIds: (user.departments ?? []).map(d => d.id),
    });
    setFieldError(null);
    setDeptPickerOrgUnit('');
  };

  // Take "current" from the record the edit form was opened against (editUser)
  // rather than re-finding it in `users` — `users` is now only the current
  // page (15 rows), so the edited row may not be in it once pagination/filters
  // are in play, even though it's still the one being edited.
  const syncRoles = async (userId: string, current: string[], desired: string[]) => {
    for (const id of desired.filter(id => !current.includes(id))) await mutations.assignRole.mutateAsync({ userId, roleId: id });
    for (const id of current.filter(id => !desired.includes(id))) await mutations.removeRole.mutateAsync({ userId, roleId: id });
  };

  const syncDepts = async (userId: string, current: string[], desired: string[]) => {
    for (const id of desired.filter(id => !current.includes(id))) await mutations.assignDepartment.mutateAsync({ userId, departmentId: id });
    for (const id of current.filter(id => !desired.includes(id))) await mutations.removeDepartment.mutateAsync({ userId, departmentId: id });
  };

  const handleCreate = async () => {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) { setFieldError('Name and email are required.'); return; }
    if (form.roleIds.length === 0) { setFieldError('At least one role is required.'); return; }
    try {
      await mutations.createUser.mutateAsync({
        email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        isActive: form.isActive, roleIds: form.roleIds, departmentIds: form.departmentIds.length > 0 ? form.departmentIds : undefined,
      });
      toast.success('User created');
      setCreateOpen(false);
    } catch (err) { setFieldError(parseApiError(err)); toast.error(parseApiError(err)); }
  };

  const handleEdit = async () => {
    if (!editUser) return;
    if (!form.firstName.trim() || !form.lastName.trim() || !form.email.trim()) { setFieldError('Name and email are required.'); return; }
    if (form.roleIds.length === 0) { setFieldError('At least one role is required.'); return; }
    try {
      await mutations.updateUser.mutateAsync({ id: editUser.id, data: { email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim(), isActive: form.isActive } });
      await syncRoles(editUser.id, (editUser.roles ?? []).map(r => r.id), form.roleIds);
      await syncDepts(editUser.id, (editUser.departments ?? []).map(d => d.id), form.departmentIds);
      toast.success('User updated');
      setEditUser(null);
    } catch (err) { setFieldError(parseApiError(err)); toast.error(parseApiError(err)); }
  };

  const isSaving = mutations.createUser.isPending || mutations.updateUser.isPending ||
    mutations.assignRole.isPending || mutations.removeRole.isPending ||
    mutations.assignDepartment.isPending || mutations.removeDepartment.isPending;

  const drawerOpen = !!selectedUserId;

  return (
    <div className={cn('flex gap-0 h-full min-h-[600px]', drawerOpen ? 'overflow-hidden' : '')}>

      {/* ── LEFT: Users table ── */}
      <div className={cn('flex flex-col min-w-0 transition-all', drawerOpen ? 'w-[55%] shrink-0' : 'w-full')}>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-36">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <input className="ui-input pl-8 text-sm w-full" placeholder="Search users…" value={search} onChange={e => updateSearch(e.target.value)} />
          </div>
          <select className="ui-input text-sm w-32" value={roleFilter} onChange={e => updateRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select className="ui-input text-sm w-36" value={orgUnitFilter} onChange={e => updateOrgUnitFilter(e.target.value)}>
            <option value="">All org units</option>
            {orgUnits.map(u => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}
          </select>
          <select className="ui-input text-sm w-36" value={deptFilter} onChange={e => updateDeptFilter(e.target.value)}>
            <option value="">All depts</option>
            {departmentsForOrgUnitFilter.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="ui-input text-sm w-28" value={statusFilter} onChange={e => updateStatusFilter(e.target.value as any)}>
            <option value="all">All status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <button onClick={() => refetch()} className="ui-btn ui-btn-secondary text-sm p-2" title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
          <PermissionGate permission={PERMISSIONS.USER_MANAGE}>
            <button onClick={openCreate} className="ui-btn ui-btn-primary text-sm">
              <Plus className="h-4 w-4" /> New User
            </button>
          </PermissionGate>
        </div>

        {/* Table */}
        <div className="overflow-x-auto flex-1">
          <table className="min-w-full text-sm divide-y divide-border-subtle">
            <thead>
              <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
                <th className="px-3 py-2.5 text-left">User</th>
                {!drawerOpen && <th className="px-3 py-2.5 text-left">Roles</th>}
                {!drawerOpen && <th className="px-3 py-2.5 text-left">Departments</th>}
                <th className="px-3 py-2.5 text-left">Status</th>
                {!drawerOpen && <th className="px-3 py-2.5 text-left">Last login</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {isLoading && (
                <tr><td colSpan={5} className="px-3 py-8 text-center">
                  <RefreshCw className="h-6 w-6 animate-spin text-brand-600 mx-auto" />
                </td></tr>
              )}
              {!isLoading && users.map(u => (
                <tr
                  key={u.id}
                  onClick={() => setSelectedUserId(u.id === selectedUserId ? null : u.id)}
                  className={cn(
                    'cursor-pointer transition-colors',
                    u.id === selectedUserId ? 'bg-brand-50 dark:bg-brand-950' : 'hover:bg-surface-raised/60'
                  )}
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <Avatar firstName={u.firstName} lastName={u.lastName} email={u.email} size="sm" />
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary truncate">{u.firstName} {u.lastName}</p>
                        {!drawerOpen && <p className="text-xs text-text-muted font-mono truncate">{u.email}</p>}
                      </div>
                    </div>
                  </td>
                  {!drawerOpen && (
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1 max-w-48">
                        {(u.roles ?? []).length > 0
                          ? u.roles!.map(r => <RoleBadge key={r.id} name={r.name} />)
                          : <span className="text-text-muted text-xs">—</span>}
                      </div>
                    </td>
                  )}
                  {!drawerOpen && (
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1 max-w-36">
                        {(u.departments ?? []).length > 0
                          ? u.departments!.map(d => <DeptBadge key={d.id} code={d.code} name={d.name} />)
                          : <span className="text-text-muted text-xs">—</span>}
                      </div>
                    </td>
                  )}
                  <td className="px-3 py-3">
                    <StatusBadge active={u.isActive} />
                  </td>
                  {!drawerOpen && (
                    <td className="px-3 py-3 text-xs text-text-muted whitespace-nowrap">{formatDate(u.lastLoginAt)}</td>
                  )}
                </tr>
              ))}
              {!isLoading && users.length === 0 && (
                <tr><td colSpan={5}>
                  <EmptyState icon={Users} title="No users found"
                    description={hasActiveFilters ? 'No users match your filters.' : 'Create the first user to get started.'}
                    action={!hasActiveFilters ? { label: 'New user', onClick: openCreate } : undefined}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {total > 0 && (
          <p className="text-xs text-text-muted mt-2 px-1">
            Showing {users.length} of {total} user{total === 1 ? '' : 's'} · Click a row to open user panel
          </p>
        )}

        {total > PAGE_SIZE && (
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page * PAGE_SIZE < total}
            totalPages={totalPages}
            isLoading={isLoading}
          />
        )}
      </div>

      {/* ── RIGHT: User Drawer ── */}
      {drawerOpen && selectedUserId && (
        <div className="flex-1 min-w-0 border-l border-border overflow-hidden">
          <UserDrawer
            userId={selectedUserId}
            onClose={() => setSelectedUserId(null)}
            onEdit={openEdit}
          />
        </div>
      )}

      {/* ── Modals: Create / Edit user ── */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create user" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">First name *</label>
              <input className="ui-input" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Last name *</label>
              <input className="ui-input" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Email *</label>
            <input className="ui-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active account
          </label>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Roles *</label>
            <MultiCheckbox items={roles} selected={form.roleIds} onChange={roleIds => setForm({ ...form, roleIds })} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Departments</label>
            <select
              className="ui-input text-sm mb-1.5"
              value={deptPickerOrgUnit}
              onChange={e => setDeptPickerOrgUnit(e.target.value)}
            >
              <option value="">Filter by org unit: all</option>
              {orgUnits.map(u => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}
            </select>
            <MultiCheckbox
              items={departments
                .filter(d => !deptPickerOrgUnit || d.orgUnitId === deptPickerOrgUnit)
                .map(d => ({ id: d.id, name: d.name, code: d.code }))}
              selected={form.departmentIds}
              onChange={departmentIds => setForm({ ...form, departmentIds })}
              secondaryKey="code"
            />
            <p className="text-xs text-text-muted mt-1">
              A department belongs to exactly one org unit, so same-named departments in different org units (e.g. two &quot;Finance&quot;) are only distinguishable by filtering here — a checked department outside the current filter stays selected, just hidden.
            </p>
          </div>
          {fieldError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{fieldError}</p>}
        </div>
        <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-border">
          <button onClick={() => setCreateOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button>
          <button disabled={isSaving} onClick={handleCreate} className="ui-btn ui-btn-primary">{isSaving ? 'Creating…' : 'Create user'}</button>
        </div>
      </Modal>

      <Modal open={!!editUser} onClose={() => setEditUser(null)} title={`Edit: ${editUser?.firstName} ${editUser?.lastName}`} size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">First name *</label>
              <input className="ui-input" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Last name *</label>
              <input className="ui-input" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Email *</label>
            <input className="ui-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active account
          </label>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Roles *</label>
            <MultiCheckbox items={roles} selected={form.roleIds} onChange={roleIds => setForm({ ...form, roleIds })} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Departments</label>
            <select
              className="ui-input text-sm mb-1.5"
              value={deptPickerOrgUnit}
              onChange={e => setDeptPickerOrgUnit(e.target.value)}
            >
              <option value="">Filter by org unit: all</option>
              {orgUnits.map(u => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}
            </select>
            <MultiCheckbox
              items={departments
                .filter(d => !deptPickerOrgUnit || d.orgUnitId === deptPickerOrgUnit)
                .map(d => ({ id: d.id, name: d.name, code: d.code }))}
              selected={form.departmentIds}
              onChange={departmentIds => setForm({ ...form, departmentIds })}
              secondaryKey="code"
            />
            <p className="text-xs text-text-muted mt-1">
              A department belongs to exactly one org unit, so same-named departments in different org units (e.g. two &quot;Finance&quot;) are only distinguishable by filtering here — a checked department outside the current filter stays selected, just hidden.
            </p>
          </div>
          {fieldError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{fieldError}</p>}
        </div>
        <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-border">
          <button onClick={() => setEditUser(null)} className="ui-btn ui-btn-secondary">Cancel</button>
          <button disabled={isSaving} onClick={handleEdit} className="ui-btn ui-btn-primary">{isSaving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </Modal>
    </div>
  );
}
