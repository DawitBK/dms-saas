"use client";

import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Shield, Save, X } from 'lucide-react';
import { apiClient } from '@/shared/lib/apiClient';
import { PERMISSIONS } from '@/shared/lib/permissions';

interface Role {
  id: string;
  name: string;
  description: string | null;
}

interface RoleEditorProps {
  roleId?: string;
  onSave?: () => void;
  onCancel?: () => void;
}

// Sourced from shared/lib/permissions.ts's PERMISSIONS map (the same catalog
// backend/src/config/permissions.ts defines) so this can never drift from what
// the backend actually accepts again — it previously both invented ids that
// don't exist (acl:read, document:create/update/delete/approve, ...) AND, after
// that was fixed, only listed a hand-picked SUBSET of the real permissions (53 offered here; platform:admin is reserved)
// (missing signing:*, letter:*, approval:*, search:*, notification:read,
// retention:*, legalhold:*, orgunit:*, tenant:*, operations:*, doctype:manage,
// audit-stage:decide). That second bug was subtler: every checkbox worked and
// saved fine, so "Select All" on every visible group looked like it granted a
// role full access — but large parts of the sidebar (Letters, My Work,
// E-Signing, Notifications) stayed hidden for that role because the
// permissions gating them were never even offered here to grant in the first
// place. Every PERMISSIONS entry must have exactly one home below.
const PERMISSION_GROUPS = {
  'Documents': [
    { id: PERMISSIONS.DOCUMENT_READ, label: 'Read Documents' },
    { id: PERMISSIONS.DOCUMENT_READ_ALL, label: 'Read All Documents (oversight)' },
    { id: PERMISSIONS.DOCUMENT_UPLOAD, label: 'Upload Documents' },
    { id: PERMISSIONS.DOCUMENT_CHECKOUT, label: 'Check Out Documents' },
    { id: PERMISSIONS.VERSION_MANAGE, label: 'Manage Versions' },
    { id: PERMISSIONS.DOCUMENT_ARCHIVE, label: 'Archive Documents' },
    { id: PERMISSIONS.DOCUMENT_PURGE, label: 'Purge Documents' }
  ],
  'Folders': [
    { id: PERMISSIONS.FOLDER_READ, label: 'Read Folders' },
    { id: PERMISSIONS.FOLDER_CREATE, label: 'Create/Update Folders' },
    { id: PERMISSIONS.FOLDER_DELETE, label: 'Delete Folders' }
  ],
  'Document Types, Retention & Legal Hold': [
    { id: PERMISSIONS.DOCTYPE_READ, label: 'Read Document Types' },
    { id: PERMISSIONS.DOCTYPE_MANAGE, label: 'Manage Document Types' },
    { id: PERMISSIONS.RETENTION_READ, label: 'Read Retention Policies' },
    { id: PERMISSIONS.RETENTION_MANAGE, label: 'Manage Retention Policies' },
    { id: PERMISSIONS.LEGAL_HOLD_READ, label: 'Read Legal Holds' },
    { id: PERMISSIONS.LEGAL_HOLD_MANAGE, label: 'Manage Legal Holds' }
  ],
  'Forms': [
    { id: PERMISSIONS.FORM_TEMPLATE_MANAGE, label: 'Build/Edit/Approve Form Templates' }
  ],
  'Workflows & Approvals': [
    { id: PERMISSIONS.WORKFLOW_READ, label: 'Read Workflows' },
    { id: PERMISSIONS.WORKFLOW_APPROVE, label: 'Approve Workflows' },
    { id: PERMISSIONS.WORKFLOW_MANAGE, label: 'Manage Workflows' },
    { id: PERMISSIONS.APPROVAL_SUBMIT, label: 'Submit for Approval' },
    { id: PERMISSIONS.APPROVAL_DECIDE, label: 'Decide Approvals' },
    { id: PERMISSIONS.APPROVAL_ADMIN, label: 'Administer Approval Chains' },
    { id: PERMISSIONS.AUDIT_STAGE_DECIDE, label: 'Decide Audit-Stage Reviews' }
  ],
  'Users & Roles': [
    { id: PERMISSIONS.USER_MANAGE, label: 'Manage Users' },
    { id: PERMISSIONS.ROLE_READ, label: 'Read Roles' },
    { id: PERMISSIONS.ROLE_MANAGE, label: 'Manage Roles' }
  ],
  'Departments, Org Units & Tenants': [
    { id: PERMISSIONS.DEPT_READ, label: 'Read Departments' },
    { id: PERMISSIONS.DEPT_MANAGE, label: 'Manage Departments' },
    { id: PERMISSIONS.ORG_UNIT_READ, label: 'Read Org Units' },
    { id: PERMISSIONS.ORG_UNIT_MANAGE, label: 'Manage Org Units' },
    { id: PERMISSIONS.TENANT_READ, label: 'Read Tenants' },
    { id: PERMISSIONS.TENANT_MANAGE, label: 'Manage Tenants' }
  ],
  'ACL': [
    { id: PERMISSIONS.ACL_MANAGE, label: 'Manage ACL' },
    { id: PERMISSIONS.ACL_BYPASS_ADMIN, label: 'Bypass ACL (Super Admin)' }
  ],
  'Audit & Reports': [
    { id: PERMISSIONS.AUDIT_READ, label: 'Read Audit Logs' }
  ],
  'Search & Notifications': [
    { id: PERMISSIONS.SEARCH_READ, label: 'Search Documents' },
    { id: PERMISSIONS.SEARCH_SCOPE_ALL, label: 'Search Across All Departments' },
    { id: PERMISSIONS.NOTIFICATION_READ, label: 'Read Notifications' }
  ],
  'E-Signing': [
    { id: PERMISSIONS.SIGNING_READ, label: 'View Signing Requests' },
    { id: PERMISSIONS.SIGNING_MANAGE, label: 'Manage Signing Requests' }
  ],
  'Correspondence (CAMS Letters)': [
    { id: PERMISSIONS.LETTER_READ, label: 'Read Letters (own unit)' },
    { id: PERMISSIONS.LETTER_READ_ALL, label: 'Read Letters (Central Archive, all units)' },
    { id: PERMISSIONS.LETTER_CREATE, label: 'Draft Letters' },
    { id: PERMISSIONS.LETTER_REVIEW, label: 'Review Letters' },
    { id: PERMISSIONS.LETTER_APPROVE, label: 'Approve & Sign Letters' },
    { id: PERMISSIONS.LETTER_DISPATCH, label: 'Dispatch Letters' },
    { id: PERMISSIONS.LETTER_REGISTER, label: 'Register Incoming Letters' }
  ],
  'Operations Console': [
    { id: PERMISSIONS.OPERATIONS_READ, label: 'Read Operations Console' },
    { id: PERMISSIONS.OPERATIONS_MANAGE, label: 'Manage Operations Console' }
  ],
  // platform:admin is deliberately not offered: it is reserved and no custom role can hold it.
  'AI': [
    { id: PERMISSIONS.AI_USE, label: 'Use AI (summaries, suggestions, form help)' },
    { id: PERMISSIONS.AI_CHAT, label: 'Use the AI compliance chat' },
    { id: PERMISSIONS.AI_MANAGE, label: 'Manage AI Controls' }
  ]
};

export function RoleEditor({ roleId, onSave, onCancel }: RoleEditorProps) {
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  // Starts true when there is a role to fetch: the loader below no longer
  // raises this synchronously, so the initial value has to be right.
  const [loading, setLoading] = useState(Boolean(roleId));
  const [saving, setSaving] = useState(false);
  
  // Promise chain rather than async/await, and declared BEFORE the effect that
  // calls it. The old order read `loadRoleAndPermissions` above its own
  // declaration, which react-hooks/immutability reports as a staleness trap,
  // and its synchronous `setLoading(true)` tripped
  // react-hooks/set-state-in-effect — both errors under eslint-config-next 16.
  // `loading` is raised here rather than inside the fetch because the only
  // caller is the effect itself.
  const loadRoleAndPermissions = useCallback(() => {
    if (!roleId) return Promise.resolve();
    return apiClient<{ data: { roleId: string; roleName: string; permissions: string[] } }>(
      `/roles/${roleId}/permissions`,
    )
      .then((response) => {
        setRole({ id: response.data.roleId, name: response.data.roleName, description: null });
        setPermissions(new Set(response.data.permissions));
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Failed to load role permissions');
      })
      .finally(() => setLoading(false));
  }, [roleId]);

  useEffect(() => {
    if (roleId) void loadRoleAndPermissions();
  }, [roleId, loadRoleAndPermissions]);
  
  const togglePermission = (permissionId: string) => {
    setPermissions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(permissionId)) {
        newSet.delete(permissionId);
      } else {
        newSet.add(permissionId);
      }
      return newSet;
    });
  };
  
  const toggleGroup = (group: string) => {
    const groupPermissions = PERMISSION_GROUPS[group as keyof typeof PERMISSION_GROUPS].map(p => p.id);
    const allSelected = groupPermissions.every(p => permissions.has(p));

    setPermissions(prev => {
      const newSet = new Set(prev);
      if (allSelected) {
        // Deselect all
        groupPermissions.forEach(p => newSet.delete(p));
      } else {
        // Select all
        groupPermissions.forEach(p => newSet.add(p));
      }
      return newSet;
    });
  };

  // Every permission across every group, flat — the basis for the one
  // top-level Select All / Deselect All control (per-group toggles above
  // still exist for finer-grained edits).
  const allPermissionIds = Object.values(PERMISSION_GROUPS).flat().map(p => p.id);
  const allSelectedGlobally = allPermissionIds.length > 0 && allPermissionIds.every(p => permissions.has(p));
  const toggleAllPermissions = () => {
    setPermissions(allSelectedGlobally ? new Set() : new Set(allPermissionIds));
  };
  
  const handleSave = async () => {
    if (!roleId) return;
    
    setSaving(true);
    try {
      await apiClient(`/roles/${roleId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({
          permissions: Array.from(permissions)
        })
      });
      toast.success('Role permissions updated');
      onSave?.();
    } catch (error: any) {
      toast.error(`Failed to save permissions: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }
  
  if (!roleId) {
    return (
      <div className="text-center py-8 text-gray-500">
        Select a role to edit permissions
      </div>
    );
  }
  
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {role?.name || 'Role Permissions'}
            </h2>
            {role?.description && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {role.description}
              </p>
            )}
          </div>
          <Shield className="h-8 w-8 text-blue-500" />
        </div>
      </div>
      
      <div className="p-6 space-y-6">
        {Object.entries(PERMISSION_GROUPS).map(([groupName, groupPermissions]) => {
          const groupSelected = groupPermissions.every(p => permissions.has(p.id));
          const someSelected = groupPermissions.some(p => permissions.has(p.id));
          
          return (
            <div key={groupName} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                  {groupName}
                </h3>
                <button
                  onClick={() => toggleGroup(groupName)}
                  className={`text-sm px-3 py-1 rounded ${
                    groupSelected
                      ? 'bg-blue-600 text-white'
                      : someSelected
                      ? 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200'
                      : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {groupSelected ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                {groupPermissions.map(permission => (
                  <label
                    key={permission.id}
                    className="flex items-center space-x-2 cursor-pointer p-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={permissions.has(permission.id)}
                      onChange={() => togglePermission(permission.id)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {permission.label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end space-x-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center space-x-2"
        >
          <X className="h-4 w-4" />
          <span>Cancel</span>
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center space-x-2"
        >
          <Save className="h-4 w-4" />
          <span>{saving ? 'Saving...' : 'Save Permissions'}</span>
        </button>
      </div>
      
      <div className="px-6 py-4 bg-blue-50 dark:bg-blue-900/20 border-t border-gray-200 dark:border-gray-700">
        <p className="text-sm text-blue-800 dark:text-blue-300">
          <strong>Note:</strong> Changes to role permissions take effect immediately for all users with this role.
          Selected: {permissions.size} permissions
        </p>
      </div>
    </div>
  );
}

