"use client";

import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Shield, Users, FileText, Globe, Link2, RefreshCw, AlertCircle, ShieldAlert } from 'lucide-react';
import { apiClient } from '@/shared/lib/apiClient';
import { PERMISSIONS } from '@/shared/lib/permissions';
import { StatusRulesTab } from './StatusRulesTab';
import { useResetOnChange } from '../../shared/hooks/useResetOnChange';

// Resource types resolvable in resolveACL.ts's AclResourceType but with no
// dedicated picker/lookup endpoint anywhere in the codebase (workflow/
// workflow_task/retention/legal_hold — unlike document/folder/department,
// which all have list endpoints this panel already uses). Rather than build
// new lookup endpoints for these, every scope/resource-type picker below
// falls back to a plain "enter the raw ID" text input for them.
const RAW_ID_RESOURCE_TYPES = ['workflow', 'workflow_task', 'retention', 'legal_hold'] as const;
type RawIdResourceType = typeof RAW_ID_RESOURCE_TYPES[number];

function RawResourceIdInput({
  resourceType,
  value,
  onChange,
}: {
  resourceType: string;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="mt-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${resourceType} resource ID`}
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        required
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        No picker is available for this resource type yet — enter the raw {resourceType.replace('_', ' ')} record ID directly.
      </p>
    </div>
  );
}

function DocumentSearch({ onChange }: { onChange: (id: string) => void }) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<any[]>([]);
  const [displayName, setDisplayName] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Fix: track the query the most recent keystroke represents so a response
  // can be checked for staleness before it's applied (see effect below).
  const latestQueryRef = React.useRef('');

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Emptying the dropdown when the query is too short is derived purely from
  // `query` — a render-time adjustment, not a side effect. In an effect it
  // painted one frame with the previous results still showing under a query
  // that no longer matched them, and react-hooks/set-state-in-effect rejects
  // it under eslint-config-next 16.
  useResetOnChange([query, displayName], () => {
    if (!query.trim() || query.length < 2 || query === displayName) {
      setResults([]);
      setOpen(false);
    }
  });

  React.useEffect(() => {
    // Updated synchronously on every keystroke (not just when a fetch fires),
    // so an in-flight request can always tell whether it's still the latest
    // by the time it resolves.
    latestQueryRef.current = query;

    if (!query.trim() || query.length < 2 || query === displayName) return;
    const timer = setTimeout(async () => {
      const requestQuery = query;
      setSearching(true);
      try {
        const res = await apiClient<{ data: any[] }>(`/documents?q=${encodeURIComponent(query)}&take=10`);
        // Discard: the user has typed more since this request was fired, so
        // a newer request either is in flight or has already resolved — this
        // response is stale and would otherwise clobber more current results.
        if (latestQueryRef.current !== requestQuery) return;
        setResults(res.data || []);
        setOpen(true);
      } catch {
        if (latestQueryRef.current === requestQuery) setResults([]);
      } finally {
        if (latestQueryRef.current === requestQuery) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, displayName]);

  const select = (doc: any) => {
    const name = `${doc.documentName || doc.title}${doc.documentNumber ? ` (#${doc.documentNumber})` : ''}`;
    setDisplayName(name);
    setQuery(name);
    setOpen(false);
    onChange(doc.id);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    if (e.target.value !== displayName) {
      setDisplayName('');
      onChange('');
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Search documents by title or document number..."
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
      />
      {searching && (
        <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching...</span>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-52 overflow-y-auto">
          {results.map(doc => (
            <button
              key={doc.id}
              type="button"
              onClick={() => select(doc)}
              className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm border-b border-gray-100 dark:border-gray-700 last:border-0"
            >
              <span className="font-medium text-gray-900 dark:text-white">{doc.documentName || doc.title}</span>
              {doc.documentNumber && (
                <span className="ml-2 text-gray-500 text-xs">#{doc.documentNumber}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && results.length === 0 && !searching && query.length >= 2 && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-3 py-2 text-sm text-gray-500">
          No documents found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}

// Fetches a lookup list (users/roles/departments/folders/document-types) used
// to populate a dropdown. Failures used to be swallowed with a bare
// `.catch(() => {})`, leaving an admin looking at an empty dropdown with no
// way to tell "genuinely no records" apart from "the request failed" (expired
// session, missing permission, backend hiccup). This exposes the error
// instead and offers a `retry()` that re-runs the same fetch — intentionally
// no caching/backoff/dedup, matching the lightweight, one-shot nature of the
// call sites it replaces.
function useLookup<T = any>(path: string): { data: T[]; error: string | null; loading: boolean; retry: () => void } {
  const [data, setData] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Raised during the render that first sees a new path or retry attempt,
  // rather than synchronously inside the effect below (react-hooks/
  // set-state-in-effect). On mount both are already at these values, so this
  // only fires for a genuine change — which is also when the stale previous
  // result would otherwise have stayed on screen for a frame.
  useResetOnChange([path, attempt], () => {
    setLoading(true);
    setError(null);
  });

  useEffect(() => {
    let active = true;
    apiClient<{ data: T[] }>(path)
      .then((res) => { if (active) setData(res.data || []); })
      .catch((err: any) => { if (active) setError(err?.message || 'Failed to load'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, attempt]);

  return { data, error, loading, retry: () => setAttempt((a) => a + 1) };
}

// Small inline "failed to load" message + retry action, placed directly under
// the dropdown it corresponds to so a failure reads as a failure rather than
// as an empty list of options.
function LookupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
      <AlertCircle className="h-3 w-3 shrink-0" />
      <span>{message}.</span>
      <button type="button" onClick={onRetry} className="underline hover:text-red-800 dark:hover:text-red-300">
        Retry
      </button>
    </p>
  );
}

// Rows created by the same bulk grant action share principal + target + the
// exact same `createdAt` instant (see backend createBulkAclEntries's single
// `now` reused across the whole batch), and are already returned adjacent to
// each other by the list endpoints' ordering. That makes a single forward
// pass enough to detect batch membership — no extra request or backend batch
// id needed for this data specifically.
function annotateBatchGroups<T>(
  rows: T[],
  keyFn: (row: T) => string
): Array<{ row: T; batchSize: number; isFirstInBatch: boolean; batchKey: string }> {
  const runs: Array<{ key: string; size: number }> = [];
  for (const row of rows) {
    const key = keyFn(row);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.size += 1;
    else runs.push({ key, size: 1 });
  }
  const result: Array<{ row: T; batchSize: number; isFirstInBatch: boolean; batchKey: string }> = [];
  let idx = 0;
  for (const run of runs) {
    for (let i = 0; i < run.size; i++) {
      result.push({ row: rows[idx], batchSize: run.size, isFirstInBatch: i === 0, batchKey: run.key });
      idx++;
    }
  }
  return result;
}

// Generic N-item batch revoke: fires one DELETE per id via Promise.allSettled
// and reports how many actually succeeded, since a partial failure (one grant
// already revoked by someone else, a transient error) must not be reported as
// a clean success. Still the right tool for /access-rules (Tab 4), which has
// no single-call bulk-revoke endpoint. For ACL entries (Tabs 2 and 3) prefer
// revokeAclForPrincipalOnResource below — the backend DOES have a real
// bulk-revoke endpoint for "every permission one principal holds on one
// resource," which is exactly what a batch group is on those two tabs.
async function batchRevoke(
  ids: string[],
  revokeOne: (id: string) => Promise<void>,
): Promise<{ succeeded: number; failed: number }> {
  const results = await Promise.allSettled(ids.map((id) => revokeOne(id)));
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  return { succeeded, failed: results.length - succeeded };
}

// DELETE /acl/:resourceType/:resourceId/:principalType/:principalId — deletes
// every ACL entry for one principal on one resource in a single call. A
// "batch" in Tabs 2/3 (rows granted together by the same bulk-grant action)
// is always exactly this: the same principal + the same resource, differing
// only in `permission`. Use this instead of N individual `DELETE /acl/:id`
// calls whenever a batch's principal and resource are both already fixed.
async function revokeAclForPrincipalOnResource(
  resourceType: string,
  resourceId: string,
  principalType: string,
  principalId: string,
): Promise<void> {
  await apiClient(`/acl/${resourceType}/${resourceId}/${principalType}/${principalId}`, { method: 'DELETE' });
}

function BatchRevokeButton({ count, onConfirm, busy }: { count: number; onConfirm: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onConfirm}
      disabled={busy}
      className="ml-2 text-xs font-medium text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 underline disabled:opacity-50"
      title="Revoke every permission granted in this same batch"
    >
      {busy ? 'Revoking…' : `Revoke all ${count}`}
    </button>
  );
}

// Badge marking rows that were granted together in one bulk action (Fix 2).
function GrantedTogetherBadge({ count }: { count: number }) {
  return (
    <span
      className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300"
      title="These permissions were granted together in the same action"
    >
      <Link2 className="h-2.5 w-2.5" /> {count} granted together
    </span>
  );
}

type TabType = 'grant' | 'resource-access' | 'user-access' | 'access-rules' | 'status-rules';

interface AccessControlCenterProps {
  initialTab?: TabType;
  preselectedResource?: {
    type: string;
    id: string;
  };
}

export function AccessControlCenter({ initialTab = 'grant', preselectedResource }: AccessControlCenterProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex space-x-8 px-6" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('grant')}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'grant'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }
            `}
          >
            <div className="flex items-center space-x-2">
              <Shield className="h-4 w-4" />
              <span>Grant Access</span>
            </div>
          </button>
          
          <button
            onClick={() => setActiveTab('resource-access')}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'resource-access'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }
            `}
          >
            <div className="flex items-center space-x-2">
              <FileText className="h-4 w-4" />
              <span>Who Has Access</span>
            </div>
          </button>
          
          <button
            onClick={() => setActiveTab('user-access')}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'user-access'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }
            `}
          >
            <div className="flex items-center space-x-2">
              <Users className="h-4 w-4" />
              <span>User Access</span>
            </div>
          </button>

          <button
            onClick={() => setActiveTab('access-rules')}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'access-rules'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }
            `}
          >
            <div className="flex items-center space-x-2">
              <Globe className="h-4 w-4" />
              <span>Access Rules</span>
            </div>
          </button>

          <button
            onClick={() => setActiveTab('status-rules')}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${activeTab === 'status-rules'
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }
            `}
          >
            <div className="flex items-center space-x-2">
              <ShieldAlert className="h-4 w-4" />
              <span>Status Rules</span>
            </div>
          </button>
        </nav>
      </div>

      <div className="p-6">
        {activeTab === 'grant' && <GrantAccessForm preselectedResource={preselectedResource} />}
        {activeTab === 'resource-access' && <ResourceAccessView />}
        {activeTab === 'user-access' && <UserAccessView />}
        {activeTab === 'access-rules' && <AccessRulesView />}
        {activeTab === 'status-rules' && <StatusRulesTab />}
      </div>
    </div>
  );
}

function GrantAccessForm({ preselectedResource }: { preselectedResource?: { type: string; id: string } }) {
  const [principalType, setPrincipalType] = useState<'user' | 'role'>('user');
  const [principalId, setPrincipalId] = useState('');
  // Opened from the Hierarchy Browser's "Manage Access": start on that item's own scope, with it chosen.
  const [scopeType, setScopeType] = useState<'tenant-wide' | 'department' | 'folder' | 'document-type' | 'document' | RawIdResourceType>(
    preselectedResource?.type === 'department' || preselectedResource?.type === 'document' ? preselectedResource.type : 'folder',
  );
  const [resourceId, setResourceId] = useState(
    preselectedResource && ['department', 'folder', 'document'].includes(preselectedResource.type) ? preselectedResource.id : '',
  );
  const [permissions, setPermissions] = useState<string[]>([]);
  const [effect, setEffect] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(false);
  // Narrows the Department picker below -- a department belongs to exactly
  // one org unit, so same/similarly-named departments in different org
  // units are otherwise indistinguishable in one flat list.
  const [deptOrgUnitFilter, setDeptOrgUnitFilter] = useState('');

  // Phase 3: Task 3.9 - Fetch data for pickers
  // Fix 4: each lookup now surfaces its own failure (via useLookup) instead of
  // a bare `.catch(() => {})`, so a failed fetch reads as an error, not as an
  // empty dropdown.
  const { data: users, error: usersError, retry: retryUsers } = useLookup<any>('/users');
  const { data: roles, error: rolesError, retry: retryRoles } = useLookup<any>('/roles');
  const { data: departments, error: departmentsError, retry: retryDepartments } = useLookup<any>('/departments');
  const { data: orgUnits, error: orgUnitsError, retry: retryOrgUnits } = useLookup<any>('/org-units');
  const { data: folders, error: foldersError, retry: retryFolders } = useLookup<any>('/folders/tree');
  const { data: documentTypes, error: documentTypesError, retry: retryDocumentTypes } = useLookup<any>('/document-types');
  const departmentsForOrgUnitFilter = deptOrgUnitFilter
    ? departments.filter((d) => d.orgUnitId === deptOrgUnitFilter)
    : departments;

  // Fix 1: full, real permission catalog from shared/lib/permissions.ts's
  // PERMISSIONS const, grouped by domain (mirrors the original 4 groups —
  // Documents/Folders/ACL/Admin — plus one new group per remaining domain).
  // 'acl:read' from the old hardcoded list was removed entirely: it isn't a
  // real permission (checked by zero routes), so granting it just created a
  // dead ACL row. Every PERMISSIONS entry that an ACL row can actually grant on a resource
  // appears exactly once below. ai:use, ai:chat, ai:manage and platform:admin are deliberately NOT
  // here: they are role-level capabilities checked from the user's roles, never against a folder or
  // document, so an ACL row for them would be dead too (grant the AI ones in the Role Editor).
  const permissionGroups: Record<string, string[]> = {
    'Documents': [
      PERMISSIONS.DOCUMENT_READ,
      PERMISSIONS.DOCUMENT_READ_ALL,
      PERMISSIONS.DOCUMENT_UPLOAD,
      PERMISSIONS.DOCUMENT_ARCHIVE,
      PERMISSIONS.DOCUMENT_PURGE,
      PERMISSIONS.DOCUMENT_CHECKOUT,
      PERMISSIONS.VERSION_MANAGE,
    ],
    'Folders': [
      PERMISSIONS.FOLDER_CREATE,
      PERMISSIONS.FOLDER_READ,
      PERMISSIONS.FOLDER_DELETE,
    ],
    'ACL': [
      PERMISSIONS.ACL_MANAGE,
      PERMISSIONS.ACL_BYPASS_ADMIN,
    ],
    'Admin': [
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.DEPT_READ,
      PERMISSIONS.DEPT_MANAGE,
      PERMISSIONS.TENANT_READ,
      PERMISSIONS.TENANT_MANAGE,
    ],
    'Document Types': [
      PERMISSIONS.DOCTYPE_READ,
      PERMISSIONS.DOCTYPE_MANAGE,
    ],
    'Forms': [
      PERMISSIONS.FORM_TEMPLATE_MANAGE,
    ],
    'Workflow': [
      PERMISSIONS.WORKFLOW_READ,
      PERMISSIONS.WORKFLOW_MANAGE,
      PERMISSIONS.WORKFLOW_APPROVE,
    ],
    'Retention & Legal Hold': [
      PERMISSIONS.RETENTION_READ,
      PERMISSIONS.RETENTION_MANAGE,
      PERMISSIONS.LEGAL_HOLD_READ,
      PERMISSIONS.LEGAL_HOLD_MANAGE,
    ],
    'Audit': [
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.AUDIT_STAGE_DECIDE,
    ],
    'Search & Notifications': [
      PERMISSIONS.SEARCH_READ,
      PERMISSIONS.SEARCH_SCOPE_ALL,
      PERMISSIONS.NOTIFICATION_READ,
    ],
    'Signing': [
      PERMISSIONS.SIGNING_READ,
      PERMISSIONS.SIGNING_MANAGE,
    ],
    'Operations': [
      PERMISSIONS.OPERATIONS_READ,
      PERMISSIONS.OPERATIONS_MANAGE,
    ],
    'Correspondence (Letters)': [
      PERMISSIONS.LETTER_READ,
      PERMISSIONS.LETTER_READ_ALL,
      PERMISSIONS.LETTER_CREATE,
      PERMISSIONS.LETTER_REVIEW,
      PERMISSIONS.LETTER_APPROVE,
      PERMISSIONS.LETTER_DISPATCH,
      PERMISSIONS.LETTER_REGISTER,
    ],
    'Org Units': [
      PERMISSIONS.ORG_UNIT_READ,
      PERMISSIONS.ORG_UNIT_MANAGE,
    ],
    'Approvals': [
      PERMISSIONS.APPROVAL_SUBMIT,
      PERMISSIONS.APPROVAL_DECIDE,
      PERMISSIONS.APPROVAL_ADMIN,
    ],
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      if (scopeType === 'tenant-wide' || scopeType === 'document-type') {
        // Use access-rules endpoint
        await apiClient('/access-rules', {
          method: 'POST',
          body: JSON.stringify({
            principalType,
            principalId,
            permissions,
            effect,
            documentTypeId: scopeType === 'document-type' ? resourceId : null,
            expiresAt: expiresAt || null
          })
        });
      } else {
        // Use ACL bulk endpoint
        const resourceType = scopeType === 'document' ? 'document' : scopeType;
        await apiClient(`/acl/${resourceType}/${resourceId}/bulk`, {
          method: 'POST',
          body: JSON.stringify({
            principalType,
            principalId,
            permissions,
            effect,
            expiresAt: expiresAt || null
          })
        });
      }
      
      toast.success('Access granted');
      // Reset form
      setPermissions([]);
      setExpiresAt('');
    } catch (error: any) {
      toast.error(`Failed to grant access: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };
  
  const togglePermission = (permission: string) => {
    setPermissions(prev =>
      prev.includes(permission)
        ? prev.filter(p => p !== permission)
        : [...prev, permission]
    );
  };

  // Every permission across every group, in one flat list — the basis for
  // the top-level Select All / Clear All controls.
  const allPermissions = Object.values(permissionGroups).flat();
  const allSelected = allPermissions.length > 0 && allPermissions.every(p => permissions.includes(p));
  const selectAllPermissions = () => setPermissions(allPermissions);
  const clearAllPermissions = () => setPermissions([]);

  // Per-group select-all: only that group's permissions toggle, so picking
  // "all of Documents" doesn't touch anything already chosen elsewhere.
  const isGroupSelected = (perms: string[]) => perms.every(p => permissions.includes(p));
  const toggleGroup = (perms: string[]) => {
    setPermissions(prev => {
      const groupFullySelected = perms.every(p => prev.includes(p));
      return groupFullySelected
        ? prev.filter(p => !perms.includes(p))
        : [...new Set([...prev, ...perms])];
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Principal Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Grant to
        </label>
        <div className="flex space-x-4 mb-3">
          <button
            type="button"
            onClick={() => {
              setPrincipalType('user');
              setPrincipalId(''); // Reset selection when switching type
            }}
            className={`px-4 py-2 rounded ${
              principalType === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
          >
            User
          </button>
          <button
            type="button"
            onClick={() => {
              setPrincipalType('role');
              setPrincipalId(''); // Reset selection when switching type
            }}
            className={`px-4 py-2 rounded ${
              principalType === 'role'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
          >
            Role
          </button>
        </div>
        {/* Phase 3: Task 3.9 - Replace raw UUID input with picker dropdown */}
        {principalType === 'user' ? (
          <select
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            required
          >
            <option value="">Select a user</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.firstName} {user.lastName} ({user.email})
              </option>
            ))}
          </select>
        ) : (
          <select
            value={principalId}
            onChange={(e) => setPrincipalId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            required
          >
            <option value="">Select a role</option>
            {roles.map((role) => (
              // FIX: value used to be role.id (the Role table's UUID) — every
              // ACL check in the app (resolveACL.ts's role matching,
              // requirePermission, etc.) compares principalId against the
              // user's JWT role NAME strings ('DEPT_MANAGER', not a UUID),
              // since role identity throughout auth is the name, not this
              // table's row id. A grant created with the UUID silently never
              // matched anything — it "succeeded," showed up in the grants
              // list, and did nothing. See resolvePrincipalName below for the
              // matching read-side fix.
              <option key={role.id} value={role.name}>
                {role.name}
              </option>
            ))}
          </select>
        )}
        {principalType === 'user' && usersError && <LookupError message={`Failed to load users (${usersError})`} onRetry={retryUsers} />}
        {principalType === 'role' && rolesError && <LookupError message={`Failed to load roles (${rolesError})`} onRetry={retryRoles} />}
      </div>

      {/* Scope Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Scope
        </label>
        <select
          value={scopeType}
          onChange={(e) => {
            setScopeType(e.target.value as any);
            setResourceId(''); // Reset resource selection when scope changes
          }}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        >
          <option value="tenant-wide">Tenant-wide</option>
          <option value="department">Department</option>
          <option value="folder">Folder</option>
          <option value="document-type">Document Type</option>
          <option value="document">Specific Document</option>
          <option value="workflow">Workflow</option>
          <option value="workflow_task">Workflow Task</option>
          <option value="retention">Retention</option>
          <option value="legal_hold">Legal Hold</option>
        </select>

        {/* Phase 3: Task 3.9 - Replace raw UUID input with resource-specific picker */}
        {scopeType === 'department' && (
          <>
            <select
              value={deptOrgUnitFilter}
              onChange={(e) => { setDeptOrgUnitFilter(e.target.value); setResourceId(''); }}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white mt-2"
            >
              <option value="">Filter by org unit: all</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>{u.code} - {u.name}</option>
              ))}
            </select>
            <select
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white mt-2"
              required
            >
              <option value="">Select a department</option>
              {departmentsForOrgUnitFilter.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.code} - {dept.name}
                </option>
              ))}
            </select>
          </>
        )}
        {scopeType === 'department' && departmentsError && (
          <LookupError message={`Failed to load departments (${departmentsError})`} onRetry={retryDepartments} />
        )}
        {scopeType === 'department' && orgUnitsError && (
          <LookupError message={`Failed to load org units (${orgUnitsError})`} onRetry={retryOrgUnits} />
        )}

        {scopeType === 'folder' && (
          <select
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white mt-2"
            required
          >
            <option value="">Select a folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {'  '.repeat(folder.level)}{folder.name} ({folder.path})
              </option>
            ))}
          </select>
        )}
        {scopeType === 'folder' && foldersError && (
          <LookupError message={`Failed to load folders (${foldersError})`} onRetry={retryFolders} />
        )}

        {scopeType === 'document-type' && (
          <select
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white mt-2"
            required
          >
            <option value="">Select a document type</option>
            {documentTypes.map((docType) => (
              <option key={docType.id} value={docType.id}>
                {docType.code} - {docType.name}
              </option>
            ))}
          </select>
        )}
        {scopeType === 'document-type' && documentTypesError && (
          <LookupError message={`Failed to load document types (${documentTypesError})`} onRetry={retryDocumentTypes} />
        )}

        {scopeType === 'document' && (
          <div className="mt-2">
            <DocumentSearch onChange={(id) => setResourceId(id)} />
          </div>
        )}

        {/* Fix 2: workflow/workflow_task/retention/legal_hold are valid
            AclResourceType values (resolveACL.ts) with no dedicated
            picker/lookup endpoint anywhere in the codebase — fall back to a
            raw resource-ID input, wired through the same bulk endpoint as
            folder/department/document below. */}
        {(RAW_ID_RESOURCE_TYPES as readonly string[]).includes(scopeType) && (
          <RawResourceIdInput resourceType={scopeType} value={resourceId} onChange={setResourceId} />
        )}
      </div>

      {/* Permission Selection */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Permissions ({permissions.length}/{allPermissions.length} selected)
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={allSelected ? clearAllPermissions : selectAllPermissions}
              className="text-xs font-medium px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
            >
              {allSelected ? 'Clear All' : 'Select All'}
            </button>
          </div>
        </div>
        {Object.entries(permissionGroups).map(([group, perms]) => (
          <div key={group} className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-gray-600 dark:text-gray-400">{group}</h4>
              <button
                type="button"
                onClick={() => toggleGroup(perms)}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                {isGroupSelected(perms) ? 'Clear group' : 'Select group'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {perms.map(permission => (
                <label key={permission} className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permissions.includes(permission)}
                    onChange={() => togglePermission(permission)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">{permission}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      
      {/* Effect */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Effect
        </label>
        <div className="flex space-x-4">
          <button
            type="button"
            onClick={() => setEffect('ALLOW')}
            className={`px-4 py-2 rounded ${
              effect === 'ALLOW'
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => setEffect('DENY')}
            className={`px-4 py-2 rounded ${
              effect === 'DENY'
                ? 'bg-red-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
          >
            Deny
          </button>
        </div>
      </div>
      
      {/* Expiry */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Expires At (optional)
        </label>
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
        />
      </div>
      
      <button
        type="submit"
        disabled={loading || permissions.length === 0 || !principalId}
        className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Granting...' : 'Grant Access'}
      </button>
    </form>
  );
}

function ResourceAccessView() {
  const [resourceType, setResourceType] = useState('folder');
  const [resourceId, setResourceId] = useState('');
  const [grants, setGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Phase 6: Task 6.1 - Fetch data for resource pickers
  // Fix 4: surface fetch failures instead of swallowing them (see useLookup).
  const { data: departments, error: departmentsError, retry: retryDepartments } = useLookup<any>('/departments');
  const { data: orgUnits, error: orgUnitsError, retry: retryOrgUnits } = useLookup<any>('/org-units');
  const { data: folders, error: foldersError, retry: retryFolders } = useLookup<any>('/folders/tree');
  const { data: documentTypes, error: documentTypesError, retry: retryDocumentTypes } = useLookup<any>('/document-types');
  const { data: users, error: usersError, retry: retryUsers } = useLookup<any>('/users');
  const { data: roles, error: rolesError, retry: retryRoles } = useLookup<any>('/roles');
  // Narrows the Department resource picker below -- same reasoning as
  // GrantAccessForm's deptOrgUnitFilter above.
  const [deptOrgUnitFilter, setDeptOrgUnitFilter] = useState('');
  const departmentsForOrgUnitFilter = deptOrgUnitFilter
    ? departments.filter((d) => d.orgUnitId === deptOrgUnitFilter)
    : departments;

  const resolvePrincipalName = (principalType: string, principalId: string) => {
    if (principalType === 'user') {
      const user = users.find(u => u.id === principalId);
      return user ? `${user.firstName} ${user.lastName} (${user.email})` : `${principalId.substring(0, 8)}…`;
    }
    // principalId for a role grant IS the role name now (see the grant
    // form's option value fix) — resolve by name, not by this table's id.
    const role = roles.find(r => r.name === principalId);
    return role ? role.name : principalId;
  };

  const loadGrants = async () => {
    if (!resourceId) return;
    
    setLoading(true);
    try {
      const response = await apiClient<{ data: any[] }>(`/acl/${resourceType}/${resourceId}`);
      setGrants(response.data || []);
    } catch (error: any) {
      toast.error(`Failed to load access grants: ${error.message || 'Unknown error'}`);
      setGrants([]);
    } finally {
      setLoading(false);
    }
  };
  
  const handleRevoke = async (grantId: string) => {
    if (!confirm('Are you sure you want to revoke this access grant?')) return;

    try {
      await apiClient(`/acl/${grantId}`, { method: 'DELETE' });
      toast.success('Access revoked');
      loadGrants(); // Reload
    } catch (error: any) {
      toast.error(`Failed to revoke access: ${error.message}`);
    }
  };

  // Fix 5: this tab is already scoped to one resource, and a "batch group"
  // here is always multiple permissions granted to the SAME principal at the
  // same time — exactly what DELETE /acl/:resourceType/:resourceId/:principalType/:principalId
  // deletes in one call. Previously this fired one DELETE /acl/:id per
  // permission via batchRevoke/Promise.allSettled based on a frontend
  // comment claiming no bulk-revoke endpoint existed; it does.
  const [revokingBatchKey, setRevokingBatchKey] = useState<string | null>(null);
  const handleBatchRevoke = async (batchKey: string, principalType: string, principalId: string, count: number) => {
    if (!confirm(`Revoke all ${count} permissions granted together in this batch?`)) return;
    setRevokingBatchKey(batchKey);
    try {
      await revokeAclForPrincipalOnResource(resourceType, resourceId, principalType, principalId);
      toast.success(`Revoked all ${count} permissions`);
      loadGrants();
    } catch (error: any) {
      toast.error(`Failed to revoke access: ${error.message}`);
    } finally {
      setRevokingBatchKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Resource Type
          </label>
          <select
            value={resourceType}
            onChange={(e) => {
              setResourceType(e.target.value);
              setResourceId(''); // Reset selection when type changes
              setGrants([]); // Clear grants
            }}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
          >
            <option value="folder">Folder</option>
            <option value="document">Document</option>
            <option value="department">Department</option>
            <option value="document-type">Document Type</option>
            <option value="workflow">Workflow</option>
            <option value="workflow_task">Workflow Task</option>
            <option value="retention">Retention</option>
            <option value="legal_hold">Legal Hold</option>
          </select>
        </div>

        {/* Phase 6: Task 6.1 - Replace raw ID input with resource-specific pickers */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Select Resource
          </label>
          {resourceType === 'department' && (
            <>
              <select
                value={deptOrgUnitFilter}
                onChange={(e) => { setDeptOrgUnitFilter(e.target.value); setResourceId(''); setGrants([]); }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white mb-2"
              >
                <option value="">Filter by org unit: all</option>
                {orgUnits.map((u) => (
                  <option key={u.id} value={u.id}>{u.code} - {u.name}</option>
                ))}
              </select>
              <select
                value={resourceId}
                onChange={(e) => {
                  setResourceId(e.target.value);
                  setGrants([]); // Clear grants on change
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              >
                <option value="">Select a department</option>
                {departmentsForOrgUnitFilter.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.code} - {dept.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {resourceType === 'department' && departmentsError && (
            <LookupError message={`Failed to load departments (${departmentsError})`} onRetry={retryDepartments} />
          )}
          {resourceType === 'department' && orgUnitsError && (
            <LookupError message={`Failed to load org units (${orgUnitsError})`} onRetry={retryOrgUnits} />
          )}

          {resourceType === 'folder' && (
            <select
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                setGrants([]);
              }}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">Select a folder</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {'  '.repeat(folder.level || 0)}{folder.name} ({folder.path})
                </option>
              ))}
            </select>
          )}
          {resourceType === 'folder' && foldersError && (
            <LookupError message={`Failed to load folders (${foldersError})`} onRetry={retryFolders} />
          )}

          {resourceType === 'document-type' && (
            <select
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                setGrants([]);
              }}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">Select a document type</option>
              {documentTypes.map((docType) => (
                <option key={docType.id} value={docType.id}>
                  {docType.code} - {docType.name}
                </option>
              ))}
            </select>
          )}
          {resourceType === 'document-type' && documentTypesError && (
            <LookupError message={`Failed to load document types (${documentTypesError})`} onRetry={retryDocumentTypes} />
          )}

          {resourceType === 'document' && (
            <DocumentSearch
              onChange={(id) => {
                setResourceId(id);
                setGrants([]);
              }}
            />
          )}

          {/* Fix 4: no dedicated picker/lookup for these 4 AclResourceType
              values — fall back to a raw resource-ID input, same as Tab 1. */}
          {(RAW_ID_RESOURCE_TYPES as readonly string[]).includes(resourceType) && (
            <RawResourceIdInput
              resourceType={resourceType}
              value={resourceId}
              onChange={(id) => {
                setResourceId(id);
                setGrants([]);
              }}
            />
          )}
        </div>

        <button
          onClick={loadGrants}
          disabled={loading || !resourceId}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Loading...' : 'Show Access Grants'}
        </button>

        {(usersError || rolesError) && (
          <LookupError
            message={`Principal names may show as raw IDs — failed to load ${[usersError && 'users', rolesError && 'roles'].filter(Boolean).join(' and ')}`}
            onRetry={() => { retryUsers(); retryRoles(); }}
          />
        )}
      </div>

      {/* Phase 6: Task 6.3 - Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      )}
      
      {/* Phase 6: Task 6.4 - Empty state */}
      {!loading && grants.length === 0 && resourceId && (
        <div className="text-center py-12">
          <Shield className="h-12 w-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 dark:text-gray-400 font-medium">No access grants found</p>
          <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">
            This resource has no explicit access grants configured.
          </p>
        </div>
      )}
      
      {!loading && grants.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Principal</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Permission</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Effect</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Granted by</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Granted</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {/* Fix 2: rows granted together in the same bulk action (same
                  principal + exact createdAt instant) get a left accent bar
                  plus a badge on the first row, so a multi-permission grant
                  no longer looks like N unrelated rows. */}
              {annotateBatchGroups(grants, (g: any) => `${g.principalType}:${g.principalId}:${g.createdAt}`).map(({ row: grant, batchSize, isFirstInBatch, batchKey }) => (
                <tr key={grant.id} className={batchSize > 1 ? 'border-l-2 border-l-blue-400 dark:border-l-blue-500' : ''}>
                  <td className="px-4 py-2 text-sm">
                    <span className="text-xs font-medium uppercase text-gray-500 mr-1">{grant.principalType}</span>
                    {resolvePrincipalName(grant.principalType, grant.principalId)}
                  </td>
                  <td className="px-4 py-2 text-sm">
                    {grant.permission}
                    {batchSize > 1 && isFirstInBatch && (
                      <>
                        <GrantedTogetherBadge count={batchSize} />
                        <BatchRevokeButton
                          count={batchSize}
                          busy={revokingBatchKey === batchKey}
                          onConfirm={() => handleBatchRevoke(batchKey, grant.principalType, grant.principalId, batchSize)}
                        />
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-1 text-xs rounded ${
                      grant.effect === 'ALLOW' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                    }`}>
                      {grant.effect}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.granter ? `${grant.granter.firstName} ${grant.granter.lastName}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.createdAt ? new Date(grant.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleRevoke(grant.id)}
                      className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserAccessView() {
  const [principalType, setPrincipalType] = useState<'user' | 'role'>('user');
  const [principalId, setPrincipalId] = useState('');
  const [grants, setGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Fix 9: a quick search box for the user picker — GET /users already
  // supports `q` server-side (users.routes.ts), and useLookup already
  // re-fetches whenever its `path` argument changes, so a debounced search
  // term just needs to be folded into the path; no new debounce component
  // needed (same 300ms debounce shape as DocumentSearch above). Left off the
  // role picker — roles are few enough per tenant that a search box adds
  // little.
  const [userSearch, setUserSearch] = useState('');
  const [debouncedUserSearch, setDebouncedUserSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedUserSearch(userSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [userSearch]);
  const usersPath = debouncedUserSearch ? `/users?q=${encodeURIComponent(debouncedUserSearch)}` : '/users';

  // Phase 6: Task 6.2 - Fetch data for principal pickers
  // Fix 4: surface fetch failures instead of swallowing them (see useLookup).
  const { data: users, error: usersError, retry: retryUsers } = useLookup<any>(usersPath);
  const { data: roles, error: rolesError, retry: retryRoles } = useLookup<any>('/roles');

  // Fix 6: resolve resourceId to a real name. Folders/departments/document
  // types are already fully loaded lists (small, tenant-scoped), so a local
  // find() is enough — same pattern as ResourceAccessView.resolvePrincipalName
  // and AccessRulesView.resolveDocTypeName. Documents have no such bulk
  // lookup endpoint, so those are resolved individually below (documentNames).
  const { data: folders, error: foldersError, retry: retryFolders } = useLookup<any>('/folders/tree');
  const { data: departments, error: departmentsError, retry: retryDepartments } = useLookup<any>('/departments');
  const { data: documentTypes, error: documentTypesError, retry: retryDocumentTypes } = useLookup<any>('/document-types');
  // Department codes are only unique per (tenant, org unit) — two departments
  // in different org units can share both code AND name (the "IT -
  // Information Technology" / "FIN - Finance" duplicates seen in practice),
  // so resolveResourceName below needs the org unit to actually disambiguate
  // a department-scoped grant, not just repeat the same string twice.
  const { data: orgUnits } = useLookup<any>('/org-units');

  const [documentNames, setDocumentNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = Array.from(new Set(
      grants.filter((g) => g.resourceType === 'document').map((g) => g.resourceId as string)
    ));
    if (ids.length === 0) return;
    let active = true;
    (async () => {
      const resolved = await Promise.all(ids.map(async (id) => {
        try {
          const doc = await apiClient<any>(`/documents/${id}`);
          const name = `${doc.documentName || doc.title}${doc.documentNumber ? ` (#${doc.documentNumber})` : ''}`;
          return [id, name] as const;
        } catch {
          return [id, null] as const;
        }
      }));
      if (!active) return;
      setDocumentNames((prev) => {
        const next = { ...prev };
        for (const [id, name] of resolved) if (name) next[id] = name;
        return next;
      });
    })();
    return () => { active = false; };
  }, [grants]);

  const resolveResourceName = (resourceType: string, resourceId: string) => {
    if (resourceType === 'folder') {
      const folder = folders.find((f: any) => f.id === resourceId);
      return folder ? `${folder.name} (${folder.path})` : `${resourceId.substring(0, 8)}…`;
    }
    if (resourceType === 'department') {
      const dept = departments.find((d: any) => d.id === resourceId);
      if (!dept) return `${resourceId.substring(0, 8)}…`;
      const unit = (orgUnits ?? []).find((u: any) => u.id === dept.orgUnitId);
      return unit ? `${dept.code} - ${dept.name} (${unit.name})` : `${dept.code} - ${dept.name}`;
    }
    if (resourceType === 'document-type') {
      const docType = documentTypes.find((d: any) => d.id === resourceId);
      return docType ? `${docType.code} - ${docType.name}` : `${resourceId.substring(0, 8)}…`;
    }
    if (resourceType === 'document') {
      return documentNames[resourceId] ?? `${resourceId.substring(0, 8)}…`;
    }
    // workflow / workflow_task / retention / legal_hold — no name lookup
    // available for these (see Tabs 1/2's RawResourceIdInput); show the type
    // label plus the raw id instead of pretending there's a name.
    return `${resourceType} ${resourceId.substring(0, 8)}…`;
  };

  const loadUserAccess = async () => {
    if (!principalId) return;

    setLoading(true);
    try {
      const response = await apiClient<{ data: any[] }>(`/acl?principalType=${principalType}&principalId=${principalId}`);
      setGrants(response.data || []);
    } catch (error: any) {
      toast.error(`Failed to load user access: ${error.message || 'Unknown error'}`);
      setGrants([]);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (grantId: string) => {
    if (!confirm('Are you sure you want to revoke this access grant?')) return;

    try {
      await apiClient(`/acl/${grantId}`, { method: 'DELETE' });
      toast.success('Access revoked');
      loadUserAccess(); // Reload
    } catch (error: any) {
      toast.error(`Failed to revoke access: ${error.message}`);
    }
  };

  // Fix 7: this tab fixes the principal and varies the resource, so a batch
  // group (same resource + same createdAt instant) is exactly "every
  // permission this principal holds on this one resource" — the same shape
  // DELETE /acl/:resourceType/:resourceId/:principalType/:principalId
  // deletes in one call (see Fix 5 in ResourceAccessView above).
  const [revokingBatchKey, setRevokingBatchKey] = useState<string | null>(null);
  const handleBatchRevoke = async (batchKey: string, resourceType: string, resourceId: string, count: number) => {
    if (!confirm(`Revoke all ${count} permissions granted together in this batch?`)) return;
    setRevokingBatchKey(batchKey);
    try {
      await revokeAclForPrincipalOnResource(resourceType, resourceId, principalType, principalId);
      toast.success(`Revoked all ${count} permissions`);
      loadUserAccess();
    } catch (error: any) {
      toast.error(`Failed to revoke access: ${error.message}`);
    } finally {
      setRevokingBatchKey(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Principal Type
          </label>
          <div className="flex space-x-4">
            <button
              type="button"
              onClick={() => {
                setPrincipalType('user');
                setPrincipalId(''); // Reset on type change
                setGrants([]);
              }}
              className={`px-4 py-2 rounded ${
                principalType === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              User
            </button>
            <button
              type="button"
              onClick={() => {
                setPrincipalType('role');
                setPrincipalId('');
                setGrants([]);
              }}
              className={`px-4 py-2 rounded ${
                principalType === 'role'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Role
            </button>
          </div>
        </div>
        
        {/* Phase 6: Task 6.2 - Replace raw ID input with principal picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Select {principalType === 'user' ? 'User' : 'Role'}
          </label>
          {principalType === 'user' ? (
            <>
              {/* Fix 9: quick search box — passes `q` through to GET /users. */}
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search users by name or email..."
                className="w-full mb-2 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              />
              <select
                value={principalId}
                onChange={(e) => {
                  setPrincipalId(e.target.value);
                  setGrants([]);
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              >
                <option value="">Select a user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.firstName} {user.lastName} ({user.email})
                  </option>
                ))}
              </select>
            </>
          ) : (
            <select
              value={principalId}
              onChange={(e) => {
                setPrincipalId(e.target.value);
                setGrants([]);
              }}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
            >
              <option value="">Select a role</option>
              {roles.map((role) => (
                // See GrantAccessForm's identical fix: principalId for a role
                // must be the role NAME (what resolveACL actually matches
                // against), not this table's UUID.
                <option key={role.id} value={role.name}>
                  {role.name}
                </option>
              ))}
            </select>
          )}
          {principalType === 'user' && usersError && <LookupError message={`Failed to load users (${usersError})`} onRetry={retryUsers} />}
          {principalType === 'role' && rolesError && <LookupError message={`Failed to load roles (${rolesError})`} onRetry={retryRoles} />}
        </div>

        <button
          onClick={loadUserAccess}
          disabled={loading || !principalId}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Loading...' : 'Show Access Grants'}
        </button>

        {(foldersError || departmentsError || documentTypesError) && (
          <LookupError
            message={`Resource names may show as raw IDs — failed to load ${[foldersError && 'folders', departmentsError && 'departments', documentTypesError && 'document types'].filter(Boolean).join(', ')}`}
            onRetry={() => { retryFolders(); retryDepartments(); retryDocumentTypes(); }}
          />
        )}
      </div>
      
      {/* Phase 6: Task 6.3 - Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      )}
      
      {/* Phase 6: Task 6.4 - Empty state */}
      {!loading && grants.length === 0 && principalId && (
        <div className="text-center py-12">
          <Users className="h-12 w-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 dark:text-gray-400 font-medium">No access grants found</p>
          <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">
            This {principalType} has no explicit access grants configured.
          </p>
        </div>
      )}
      
      {!loading && grants.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Resource Type</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Resource</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Permission</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Effect</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Granted by</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Granted</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {/* Fix 2: rows granted together in the same bulk action (same
                  resource + exact createdAt instant) get a left accent bar
                  plus a badge on the first row — see ResourceAccessView's
                  table for the mirror case (grouped by principal instead,
                  since this view fixes the principal and varies resource). */}
              {annotateBatchGroups(grants, (g: any) => `${g.resourceType}:${g.resourceId}:${g.createdAt}`).map(({ row: grant, batchSize, isFirstInBatch, batchKey }) => (
                <tr key={grant.id} className={batchSize > 1 ? 'border-l-2 border-l-blue-400 dark:border-l-blue-500' : ''}>
                  <td className="px-4 py-2 text-sm">{grant.resourceType}</td>
                  {/* Fix 6: resolved to a real name instead of a raw truncated UUID. */}
                  <td className="px-4 py-2 text-sm">{resolveResourceName(grant.resourceType, grant.resourceId)}</td>
                  <td className="px-4 py-2 text-sm">
                    {grant.permission}
                    {batchSize > 1 && isFirstInBatch && (
                      <>
                        <GrantedTogetherBadge count={batchSize} />
                        <BatchRevokeButton
                          count={batchSize}
                          busy={revokingBatchKey === batchKey}
                          onConfirm={() => handleBatchRevoke(batchKey, grant.resourceType, grant.resourceId, batchSize)}
                        />
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-1 text-xs rounded ${
                      grant.effect === 'ALLOW' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                    }`}>
                      {grant.effect}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.granter ? `${grant.granter.firstName} ${grant.granter.lastName}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {grant.createdAt ? new Date(grant.createdAt).toLocaleString() : '—'}
                  </td>
                  {/* Fix 7: this tab previously had no Actions column at all —
                      a grant shown here could not be revoked without switching
                      to Tab 2. */}
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleRevoke(grant.id)}
                      className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Fix 1: tenant-wide and document-type-scoped rules are created here (Grant
// Access, scope = "Tenant-wide" or "Document Type") via POST /access-rules,
// but until now nothing ever called GET/DELETE /access-rules — such a rule
// could be created but never seen or revoked again short of a raw DB
// operation. This tab lists every /access-rules row for the tenant and lets
// an admin revoke one, mirroring how ResourceAccessView/UserAccessView list
// and revoke /acl entries.
function AccessRulesView() {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Used only to resolve principal/document-type ids to display names, the
  // same way ResourceAccessView/UserAccessView do — not user-facing pickers,
  // so a failure here surfaces as one small note rather than a per-dropdown one.
  const { data: users, error: usersError, retry: retryUsers } = useLookup<any>('/users');
  const { data: roles, error: rolesError, retry: retryRoles } = useLookup<any>('/roles');
  const { data: documentTypes, error: documentTypesError, retry: retryDocumentTypes } = useLookup<any>('/document-types');

  const resolvePrincipalName = (principalType: string, principalId: string) => {
    if (principalType === 'user') {
      const user = users.find((u: any) => u.id === principalId);
      return user ? `${user.firstName} ${user.lastName} (${user.email})` : `${principalId.substring(0, 8)}…`;
    }
    // Same principalId-is-a-role-NAME fix as GrantAccessForm/resolvePrincipalName above.
    const role = roles.find((r: any) => r.name === principalId);
    return role ? role.name : principalId;
  };

  const resolveDocTypeName = (documentTypeId: string) => {
    const docType = documentTypes.find((d: any) => d.id === documentTypeId);
    return docType ? `${docType.code} - ${docType.name}` : `${documentTypeId.substring(0, 8)}…`;
  };

  // Fix 10: GET /access-rules already supports principalType/principalId/
  // documentTypeId query filters (access-rules.routes.ts) — these controls
  // pass them through instead of always calling the bare unfiltered endpoint.
  const [filterPrincipalType, setFilterPrincipalType] = useState<'' | 'user' | 'role'>('');
  const [filterPrincipalId, setFilterPrincipalId] = useState('');
  const [filterDocumentTypeId, setFilterDocumentTypeId] = useState('');

  // Split so the mount effect can call the fetch without raising the spinner
  // or clearing the error synchronously — see the matching note in
  // LegalHoldConsole. `loading` starts true and `loadError` starts null, so
  // the mount path needs neither set.
  const fetchRules = React.useCallback(() => {
    const params = new URLSearchParams();
    if (filterPrincipalType) params.set('principalType', filterPrincipalType);
    if (filterPrincipalType && filterPrincipalId) params.set('principalId', filterPrincipalId);
    if (filterDocumentTypeId) params.set('documentTypeId', filterDocumentTypeId);
    const qs = params.toString();
    return apiClient<{ data: any[] }>(`/access-rules${qs ? `?${qs}` : ''}`)
      .then((response) => setRules(response.data || []))
      .catch((error: any) => {
        setLoadError(error?.message || 'Unknown error');
        setRules([]);
      })
      .finally(() => setLoading(false));
  }, [filterPrincipalType, filterPrincipalId, filterDocumentTypeId]);

  // What the Refresh/Retry buttons and the post-mutation reloads call.
  const loadRules = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    await fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  const handleDelete = async (rule: any) => {
    const scope = rule.documentTypeId ? resolveDocTypeName(rule.documentTypeId) : 'tenant-wide';
    if (!confirm(`Revoke this ${rule.effect} rule for "${rule.permission}" (${scope})?`)) return;

    try {
      await apiClient(`/access-rules/${rule.id}`, { method: 'DELETE' });
      toast.success('Access rule revoked');
      loadRules(); // Reload, same pattern as ResourceAccessView.handleRevoke
    } catch (error: any) {
      toast.error(`Failed to revoke access rule: ${error.message}`);
    }
  };

  // Fix 2: group rules granted together in the same POST /access-rules call.
  // Caveat (unlike the ACL-bulk endpoint's tables above): createAccessRules
  // calls `new Date()` separately for each permission in its loop, with an
  // awaited audit-log write between iterations, so createdAt is NOT
  // guaranteed identical across a batch here the way it is for
  // createBulkAclEntries. This grouping is still cheap and correct whenever
  // timestamps do line up, but it's not a reliable signal for this endpoint —
  // see the final report for the suggested backend follow-up (a shared
  // timestamp or a real batch id).
  const rulesBatchKeyFn = (r: any) => `${r.principalType}:${r.principalId}:${r.documentTypeId ?? 'tenant'}:${r.createdAt}`;
  const annotatedRules = annotateBatchGroups(rules, rulesBatchKeyFn);
  const ruleIdsByBatch = new Map<string, string[]>();
  for (const r of rules) {
    const key = rulesBatchKeyFn(r);
    ruleIdsByBatch.set(key, [...(ruleIdsByBatch.get(key) ?? []), r.id]);
  }

  const [revokingRuleBatchKey, setRevokingRuleBatchKey] = useState<string | null>(null);
  const handleBatchDelete = async (batchKey: string, ids: string[]) => {
    if (!confirm(`Revoke all ${ids.length} rules granted together in this batch?`)) return;
    setRevokingRuleBatchKey(batchKey);
    try {
      const { succeeded, failed } = await batchRevoke(ids, (id) => apiClient(`/access-rules/${id}`, { method: 'DELETE' }));
      if (failed > 0) toast.error(`Revoked ${succeeded} of ${ids.length} — ${failed} failed (already revoked, or a transient error)`);
      else toast.success(`Revoked all ${succeeded} rules`);
      loadRules();
    } finally {
      setRevokingRuleBatchKey(null);
    }
  };

  const lookupErrors = [
    usersError && 'users',
    rolesError && 'roles',
    documentTypesError && 'document types',
  ].filter(Boolean).join(', ');

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Tenant-wide and document-type-scoped rules created from the Grant Access tab. These
          aren&apos;t tied to a specific folder, department, or document, so they don&apos;t show up
          under Who Has Access or User Access — manage them here instead.
        </p>
        <button
          onClick={loadRules}
          disabled={loading}
          title="Refresh"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Fix 10: filter controls, wired to GET /access-rules's principalType/
          principalId/documentTypeId query filters. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Principal Type</label>
          <select
            value={filterPrincipalType}
            onChange={(e) => {
              setFilterPrincipalType(e.target.value as '' | 'user' | 'role');
              setFilterPrincipalId('');
            }}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
          >
            <option value="">All principals</option>
            <option value="user">User</option>
            <option value="role">Role</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Principal</label>
          <select
            value={filterPrincipalId}
            onChange={(e) => setFilterPrincipalId(e.target.value)}
            disabled={!filterPrincipalType}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm disabled:opacity-50"
          >
            <option value="">Any {filterPrincipalType || 'principal'}</option>
            {filterPrincipalType === 'user' && users.map((user: any) => (
              <option key={user.id} value={user.id}>{user.firstName} {user.lastName} ({user.email})</option>
            ))}
            {filterPrincipalType === 'role' && roles.map((role: any) => (
              // Same principalId-is-a-role-NAME fix as the grant forms — access
              // rule rows store the role name too, not this table's UUID.
              <option key={role.id} value={role.name}>{role.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase mb-1">Document Type</label>
          <select
            value={filterDocumentTypeId}
            onChange={(e) => setFilterDocumentTypeId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
          >
            <option value="">All document types (incl. tenant-wide)</option>
            {documentTypes.map((docType: any) => (
              <option key={docType.id} value={docType.id}>{docType.code} - {docType.name}</option>
            ))}
          </select>
        </div>
      </div>

      {lookupErrors && (
        <LookupError
          message={`Principal/document-type names may show as raw IDs — failed to load ${lookupErrors}`}
          onRetry={() => { retryUsers(); retryRoles(); retryDocumentTypes(); }}
        />
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      )}

      {!loading && loadError && (
        <div className="text-center py-12">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-3" />
          <p className="text-gray-600 dark:text-gray-400 font-medium">Failed to load access rules</p>
          <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">{loadError}</p>
          <button onClick={loadRules} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && rules.length === 0 && (
        <div className="text-center py-12">
          <Globe className="h-12 w-12 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-600 dark:text-gray-400 font-medium">No tenant-wide or document-type rules</p>
          <p className="text-gray-500 dark:text-gray-500 text-sm mt-1">
            Rules created with a &ldquo;Tenant-wide&rdquo; or &ldquo;Document Type&rdquo; scope in Grant Access will appear here.
          </p>
        </div>
      )}

      {!loading && !loadError && rules.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Principal</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scope</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Permission</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Effect</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Granted by</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {annotatedRules.map(({ row: rule, batchSize, isFirstInBatch, batchKey }) => (
                <tr key={rule.id} className={batchSize > 1 ? 'border-l-2 border-l-blue-400 dark:border-l-blue-500' : ''}>
                  <td className="px-4 py-2 text-sm">
                    <span className="text-xs font-medium uppercase text-gray-500 mr-1">{rule.principalType}</span>
                    {resolvePrincipalName(rule.principalType, rule.principalId)}
                  </td>
                  <td className="px-4 py-2 text-sm">
                    {rule.documentTypeId ? (
                      <span className="text-gray-700 dark:text-gray-300">{resolveDocTypeName(rule.documentTypeId)}</span>
                    ) : (
                      <span className="px-2 py-1 text-xs rounded bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                        Tenant-wide
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-sm">
                    {rule.permission}
                    {batchSize > 1 && isFirstInBatch && (
                      <>
                        <GrantedTogetherBadge count={batchSize} />
                        <BatchRevokeButton
                          count={batchSize}
                          busy={revokingRuleBatchKey === batchKey}
                          onConfirm={() => handleBatchDelete(batchKey, ruleIdsByBatch.get(batchKey) ?? [])}
                        />
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-1 text-xs rounded ${
                      rule.effect === 'ALLOW' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                    }`}>
                      {rule.effect}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {rule.granter ? `${rule.granter.firstName} ${rule.granter.lastName}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {rule.expiresAt ? new Date(rule.expiresAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleDelete(rule)}
                      className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

