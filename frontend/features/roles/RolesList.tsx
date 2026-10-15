'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Shield, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiClient } from '@/shared/lib/apiClient';

interface Role {
  id: string;
  name: string;
  description: string | null;
  /** Built-in roles are seeded and referenced by name all over the system: they cannot be edited or deleted here. */
  isBuiltIn?: boolean;
}

// Matches the backend's createRoleSchema (roles.routes.ts) exactly, so the
// field turns red before a round-trip ever confirms the same rule server-side.
const NAME_PATTERN = /^[A-Z0-9_]+$/;

function NewRoleForm({ onDone, onCreated }: { onDone: () => void; onCreated: (roleId: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const createRole = useMutation({
    mutationFn: () =>
      apiClient<{ data: { roleId: string; roleName: string } }>('/roles', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      }),
    onSuccess: (res) => {
      toast.success(`Role ${res.data.roleName} created`);
      // Invalidate this list's own key AND the shared ['roles'] key other
      // screens' useRolesList() reads (e.g. the Users & Access role filter/
      // assignment dropdowns), so a newly created role shows up everywhere.
      queryClient.invalidateQueries({ queryKey: ['roles-admin-list'] });
      queryClient.invalidateQueries({ queryKey: ['roles'] });
      onCreated(res.data.roleId);
      onDone();
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Failed to create role');
    },
  });

  const nameValid = NAME_PATTERN.test(name);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (nameValid) createRole.mutate();
      }}
      className="p-4 space-y-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50"
    >
      <div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          maxLength={50}
          placeholder="ROLE_NAME"
          className="w-full text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-gray-900 dark:text-white"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Uppercase letters, digits, and underscores only (e.g. REGIONAL_AUDITOR)
        </p>
      </div>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="w-full text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-gray-900 dark:text-white"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!nameValid || createRole.isPending}
          className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {createRole.isPending ? 'Creating…' : 'Create Role'}
        </button>
      </div>
    </form>
  );
}

export function RolesList({
  selectedRoleId,
  onSelect,
}: {
  selectedRoleId?: string;
  onSelect: (roleId: string) => void;
}) {
  const [showNewRole, setShowNewRole] = useState(false);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Role | null>(null);
  const [descDraft, setDescDraft] = useState('');
  // Distinct key from the shared ['roles'] key used by features/users/hooks.ts's
  // useRolesList() — that hook's queryFn unwraps to a bare array, this one
  // caches the raw { data: [...] } envelope. Both sharing ['roles'] meant
  // whichever query populated the cache last dictated the shape every
  // consumer saw, so a Users & Access page render after this list's fetch
  // crashed on `roles.map is not a function` (roles was the envelope object).
  const { data, isLoading } = useQuery({
    queryKey: ['roles-admin-list'],
    queryFn: () => apiClient<{ data: Role[] }>('/roles'),
  });
  const roles = data?.data ?? [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['roles-admin-list'] });
    queryClient.invalidateQueries({ queryKey: ['roles'] });
  };
  // The NAME is fixed on purpose (recipes, pending steps and SSO group mappings refer to a role by name); only the description changes.
  const saveDescription = useMutation({
    mutationFn: () =>
      apiClient(`/roles/${editing!.id}`, { method: 'PATCH', body: JSON.stringify({ description: descDraft.trim() || null }) }),
    onSuccess: () => { toast.success('Description saved'); setEditing(null); refresh(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save the description'),
  });
  // Refused by the server, with the reason and the count, while anyone or anything still uses the role.
  const removeRole = useMutation({
    mutationFn: (role: Role) => apiClient(`/roles/${role.id}`, { method: 'DELETE' }).then(() => role),
    onSuccess: (role) => {
      toast.success(`Role ${role.name} deleted`);
      if (selectedRoleId === role.id) onSelect('');
      refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not delete the role'),
  });

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Roles</span>
        <button
          onClick={() => setShowNewRole((v) => !v)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
        >
          {showNewRole ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showNewRole ? 'Cancel' : 'New Role'}
        </button>
      </div>

      {showNewRole && (
        <NewRoleForm onDone={() => setShowNewRole(false)} onCreated={onSelect} />
      )}

      {editing && (
        <div className="p-4 space-y-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50" data-testid="role-description-editor">
          <p className="text-xs text-gray-600 dark:text-gray-300">
            Description of <strong>{editing.name}</strong>. The name cannot be changed: approval recipes, pending steps and SSO group mappings refer to it.
          </p>
          <input
            autoFocus
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            maxLength={255}
            aria-label="Role description"
            className="w-full text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-gray-900 dark:text-white"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="px-3 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
            <button type="button" onClick={() => saveDescription.mutate()} disabled={saveDescription.isPending} className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saveDescription.isPending ? 'Saving…' : 'Save description'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
        </div>
      ) : roles.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-500">No roles found</div>
      ) : (
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {roles.map((role) => (
            <div
              key={role.id}
              className={`flex items-center hover:bg-gray-50 dark:hover:bg-gray-800 ${
                selectedRoleId === role.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <button
                onClick={() => onSelect(role.id)}
                className="flex-1 min-w-0 text-left px-4 py-3 flex items-center gap-3"
              >
                <Shield className={`h-4 w-4 shrink-0 ${selectedRoleId === role.id ? 'text-blue-600' : 'text-gray-400'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{role.name}</p>
                  {role.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{role.description}</p>
                  )}
                </div>
              </button>
              {role.isBuiltIn === false && (
                <span className="flex shrink-0 gap-1 pr-3">
                  <button
                    type="button"
                    onClick={() => { setEditing(role); setDescDraft(role.description ?? ''); }}
                    className="p-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    aria-label={`Edit description of ${role.name}`}
                    title="Edit the description (the name is fixed)"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (window.confirm(`Delete the role ${role.name}? This cannot be undone. It is refused while anyone holds it or a recipe, a pending step or an SSO group mapping uses it.`)) removeRole.mutate(role); }}
                    disabled={removeRole.isPending}
                    className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    aria-label={`Delete role ${role.name}`}
                    title="Delete this custom role (refused while it is in use)"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
