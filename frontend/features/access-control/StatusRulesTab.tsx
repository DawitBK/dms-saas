'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ShieldAlert, Plus } from 'lucide-react';
import { apiClient } from '@/shared/lib/apiClient';
import { useRolesList } from '@/features/users/hooks';

interface StatusPermissionRule {
  status: string;
  action: string;
  roles: string[];
}

// Mirrors backend statusPermissions.service.ts's STATUS_GATED_ACTIONS —
// human labels only; the actual list of valid actions comes from the
// /status-permissions/metadata endpoint so it can never drift out of sync
// with what's actually enforced server-side.
const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  download: 'Download',
  preview: 'Preview',
  checkout: 'Checkout',
  checkin: 'Check in / cancel checkout',
  upload_version: 'Upload new version',
  rollback: 'Rollback to a prior version',
  archive: 'Archive',
  publish: 'Publish',
  status_change: 'Manual status change',
  lock: 'Lock',
  unlock: 'Unlock',
  force_unlock: 'Force unlock',
  trash: 'Move to trash',
  restore: 'Restore from trash',
  delete_permanent: 'Delete permanently (draft)',
  purge_stage: 'Stage permanent destruction',
  purge_approve: 'Approve permanent destruction',
  purge_cancel: 'Cancel permanent destruction',
};

export function StatusRulesTab() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [rules, setRules] = useState<StatusPermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: roles = [] } = useRolesList();

  const [status, setStatus] = useState('');
  const [action, setAction] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Split so the mount effect can call the fetch without raising the spinner
  // or clearing the error synchronously — see the matching note in
  // LegalHoldConsole. `loading` starts true and `error` starts null, so the
  // mount path needs neither set.
  const fetchRules = useCallback(
    () =>
      Promise.all([
        apiClient<{ data: { statuses: string[]; actions: string[] } }>('/status-permissions/metadata'),
        apiClient<{ data: StatusPermissionRule[] }>('/status-permissions'),
      ])
        .then(([metaRes, rulesRes]) => {
          setStatuses(metaRes.data.statuses);
          setActions(metaRes.data.actions);
          setRules(rulesRes.data);
        })
        .catch((err: any) => setError(err?.message || 'Failed to load status permission rules'))
        .finally(() => setLoading(false)),
    [],
  );

  // What the retry button and the post-save refresh call.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    await fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const editRule = (rule: StatusPermissionRule) => {
    setStatus(rule.status);
    setAction(rule.action);
    setSelectedRoles(rule.roles);
  };

  const toggleRole = (roleName: string) => {
    setSelectedRoles((prev) => (prev.includes(roleName) ? prev.filter((r) => r !== roleName) : [...prev, roleName]));
  };

  const saveRule = async (roleNames: string[], targetStatus = status, targetAction = action) => {
    if (!targetStatus || !targetAction) {
      toast.error('Choose a status and an action first');
      return;
    }
    setSaving(true);
    try {
      await apiClient('/status-permissions', {
        method: 'PUT',
        body: JSON.stringify({ status: targetStatus, action: targetAction, roleNames }),
      });
      toast.success(roleNames.length > 0 ? 'Rule saved' : 'Rule cleared — unrestricted again');
      setStatus('');
      setAction('');
      setSelectedRoles([]);
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const removeRule = (rule: StatusPermissionRule) => {
    const label = ACTION_LABELS[rule.action] ?? rule.action;
    if (
      !confirm(
        `Remove the restriction on "${label}" for ${rule.status} documents? This makes the action unrestricted again (normal role/ACL permissions apply).`,
      )
    ) {
      return;
    }
    void saveRule([], rule.status, rule.action);
  };

  if (loading) {
    return <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  }

  if (error) {
    return (
      <div>
        <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>
        <button onClick={() => void load()} className="text-sm text-blue-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> Status-conditioned action rules
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Restrict who may perform an action on a document while it&apos;s in a given status — e.g. only
          SYSTEM_ADMIN and DEPT_MANAGER may checkout an ARCHIVED document. This only ever narrows what
          normal role and ACL permissions already allow; it can never grant access RBAC/ACL would
          otherwise deny. A status/action combination with no rule below is fully unrestricted.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Status</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Action</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Allowed roles</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {rules.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-500 dark:text-gray-400">
                  No rules configured — every action is unrestricted (normal role/ACL permissions apply).
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr key={`${rule.status}::${rule.action}`}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-white">{rule.status}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{ACTION_LABELS[rule.action] ?? rule.action}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {rule.roles.map((r) => (
                        <span
                          key={r}
                          className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button onClick={() => editRule(rule)} className="text-xs font-medium text-blue-600 hover:underline mr-3">
                      Edit
                    </button>
                    <button onClick={() => removeRule(rule)} className="text-xs font-medium text-red-600 hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Plus className="h-4 w-4" /> Add / edit a rule
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Document status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">Select a status</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">Select an action</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a] ?? a}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Allowed roles</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedRoles.includes(r.name)}
                  onChange={() => toggleRole(r.name)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">{r.name}</span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Leave every role unchecked and save to clear an existing rule (back to unrestricted).
          </p>
        </div>

        <button
          type="button"
          disabled={saving || !status || !action}
          onClick={() => void saveRule(selectedRoles)}
          className="w-full sm:w-auto bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : selectedRoles.length > 0 ? 'Save rule' : 'Clear rule'}
        </button>
      </div>
    </div>
  );
}
