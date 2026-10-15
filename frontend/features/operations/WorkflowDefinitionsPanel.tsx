'use client';

// Backend has always supported full CRUD on workflow definitions
// (GET/POST/PATCH/DELETE /workflow/definitions — workflow.routes.ts), but the
// only frontend surface for the workflow module was the task queue
// (WorkflowPanels.tsx's WorkflowTasksPanel) — approving/rejecting tasks that
// already exist. There was no way to actually configure which stages, SLA
// hours, and approver roles a workflow runs through; that only happened via
// seed data / direct DB rows. This panel closes that gap: list, create, edit,
// and delete workflow definitions, including a stage builder for the
// `definition` JSON blob (`{ stages: WorkflowStage[] }`) each definition
// carries.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  X,
  Workflow,
} from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { EmptyState } from '../../shared/components/EmptyState';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { useDocumentTypes } from '../../shared/hooks/useLookups';
import { useAssignableRoles } from '../../shared/lib/assignmentAdvisory';
import { getErrorMessage as parseApiError } from '../../shared/lib/errorMessage';

type WorkflowStage = {
  stageNumber: number;
  name: string;
  assignedRole: string;
  slaDurationHours: number;
  slaBusinessHoursOnly: boolean;
  escalationRole?: string;
  parallelApproval?: boolean;
};

type WorkflowDefinitionRecord = {
  id: string;
  name: string;
  documentTypeId: string | null;
  version: string;
  definition: string; // JSON.stringify({ stages: WorkflowStage[] })
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
};

function parseStages(definition: string): WorkflowStage[] {
  try {
    const parsed = JSON.parse(definition);
    if (Array.isArray(parsed?.stages)) return parsed.stages as WorkflowStage[];
  } catch {
    // fall through — treat unparseable/legacy definitions as empty
  }
  return [];
}

const emptyStage = (stageNumber: number): WorkflowStage => ({
  stageNumber,
  name: '',
  assignedRole: '',
  slaDurationHours: 24,
  slaBusinessHoursOnly: true,
  escalationRole: '',
  parallelApproval: false,
});

type FormState = {
  name: string;
  version: string;
  documentTypeId: string;
  isDefault: boolean;
  isActive: boolean;
  stages: WorkflowStage[];
};

const emptyForm = (): FormState => ({
  name: '',
  version: '1.0',
  documentTypeId: '',
  isDefault: false,
  isActive: true,
  stages: [emptyStage(1)],
});

export function WorkflowDefinitionsPanel() {
  const qc = useQueryClient();
  const { data: documentTypes = [] } = useDocumentTypes();
  // The picker endpoint (needs workflow:manage-style rights), not GET /roles (role:read): a records officer manages
  // workflow definitions without being able to list roles, and the old call answered 403 on this tab.
  const { data: roles = [] } = useAssignableRoles();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['workflow-definitions'],
    queryFn: () => apiClient<{ data: WorkflowDefinitionRecord[] }>('/workflow/definitions'),
    staleTime: 30_000,
  });
  const definitions = data?.data ?? [];

  const docTypeName = useMemo(
    () => Object.fromEntries(documentTypes.map((d) => [d.id, d.name])),
    [documentTypes],
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [fieldError, setFieldError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['workflow-definitions'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        version: form.version.trim(),
        documentTypeId: form.documentTypeId || null,
        isDefault: form.isDefault,
        isActive: form.isActive,
        definition: JSON.stringify({
          stages: form.stages.map((s, idx) => ({
            ...s,
            stageNumber: idx + 1,
            escalationRole: s.escalationRole ? s.escalationRole : undefined,
          })),
        }),
      };
      if (editingId) {
        return apiClient(`/workflow/definitions/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      }
      return apiClient('/workflow/definitions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      invalidate();
      toast.success(editingId ? 'Workflow definition updated' : 'Workflow definition created');
      setModalOpen(false);
    },
    onError: (err) => {
      setFieldError(parseApiError(err));
      toast.error(parseApiError(err));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiClient(`/workflow/definitions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast.success('Workflow definition deleted');
    },
    onError: (err) => toast.error(parseApiError(err)),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldError(null);
    setModalOpen(true);
  };

  const openEdit = (def: WorkflowDefinitionRecord) => {
    setEditingId(def.id);
    const stages = parseStages(def.definition);
    setForm({
      name: def.name,
      version: def.version,
      documentTypeId: def.documentTypeId ?? '',
      isDefault: def.isDefault,
      isActive: def.isActive,
      stages: stages.length > 0 ? stages : [emptyStage(1)],
    });
    setFieldError(null);
    setModalOpen(true);
  };

  const updateStage = (index: number, patch: Partial<WorkflowStage>) => {
    setForm((f) => ({
      ...f,
      stages: f.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  };

  const addStage = () =>
    setForm((f) => ({ ...f, stages: [...f.stages, emptyStage(f.stages.length + 1)] }));

  const removeStage = (index: number) =>
    setForm((f) => ({ ...f, stages: f.stages.filter((_, i) => i !== index) }));

  const moveStage = (index: number, dir: -1 | 1) =>
    setForm((f) => {
      const target = index + dir;
      if (target < 0 || target >= f.stages.length) return f;
      const stages = [...f.stages];
      [stages[index], stages[target]] = [stages[target], stages[index]];
      return { ...f, stages };
    });

  const canSubmit =
    form.name.trim().length > 0 &&
    form.version.trim().length > 0 &&
    form.stages.length > 0 &&
    form.stages.every((s) => s.name.trim().length > 0 && s.assignedRole.trim().length > 0 && s.slaDurationHours > 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">
          Configure the approval stages, SLA hours, and approver roles a document&apos;s workflow runs through.
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => refetch()} className="ui-btn ui-btn-secondary text-sm p-2" title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
          <PermissionGate permission={PERMISSIONS.WORKFLOW_MANAGE}>
            <button onClick={openCreate} className="ui-btn ui-btn-primary text-sm">
              <Plus className="h-4 w-4" /> New Definition
            </button>
          </PermissionGate>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Document Type</th>
              <th className="px-4 py-3 text-left">Version</th>
              <th className="px-4 py-3 text-left">Stages</th>
              <th className="px-4 py-3 text-left">Flags</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center">
                  <RefreshCw className="h-6 w-6 animate-spin text-brand-600 mx-auto" />
                </td>
              </tr>
            )}
            {!isLoading &&
              definitions.map((def) => {
                const stages = parseStages(def.definition);
                return (
                  <tr key={def.id} className="hover:bg-surface-raised/60">
                    <td className="px-4 py-3 font-medium text-text-primary">{def.name}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {def.documentTypeId ? (docTypeName[def.documentTypeId] ?? '—') : 'Any'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted">{def.version}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {stages.map((s, i) => (
                          <span
                            key={i}
                            className="text-xs px-1.5 py-0.5 bg-surface-raised border border-border rounded font-mono text-text-secondary"
                            title={`${s.slaDurationHours}h · ${s.assignedRole}`}
                          >
                            {i + 1}. {s.name || '(unnamed)'}
                          </span>
                        ))}
                        {stages.length === 0 && <span className="text-xs text-text-muted italic">No stages</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        {def.isDefault && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">
                            Default
                          </span>
                        )}
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded-full ${def.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                        >
                          {def.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PermissionGate permission={PERMISSIONS.WORKFLOW_MANAGE}>
                        <div className="inline-flex gap-2">
                          <button
                            onClick={() => openEdit(def)}
                            className="p-1.5 text-text-muted hover:text-brand-600 rounded-lg hover:bg-surface-raised"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Delete workflow definition "${def.name}"? Documents mid-workflow are unaffected, but new documents can no longer start it.`)) {
                                deleteMutation.mutate(def.id);
                              }
                            }}
                            className="p-1.5 text-text-muted hover:text-red-600 rounded-lg hover:bg-red-50"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </PermissionGate>
                    </td>
                  </tr>
                );
              })}
            {!isLoading && definitions.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={Workflow}
                    title="No workflow definitions"
                    description="Create a definition to control which approval stages a document type routes through."
                    action={{ label: 'New definition', onClick: openCreate }}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto ui-scrollbar p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-brand-600" />
                {editingId ? 'Edit Workflow Definition' : 'New Workflow Definition'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="text-text-muted hover:text-text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                    Name *
                  </label>
                  <input
                    className="ui-input"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Standard Document Approval"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                    Version *
                  </label>
                  <input
                    className="ui-input"
                    value={form.version}
                    onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                    placeholder="1.0"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                  Document Type
                </label>
                <select
                  className="ui-input text-sm"
                  value={form.documentTypeId}
                  onChange={(e) => setForm((f) => ({ ...f, documentTypeId: e.target.value }))}
                >
                  <option value="">Any document type</option>
                  {documentTypes.map((dt) => (
                    <option key={dt.id} value={dt.id}>
                      {dt.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={form.isDefault}
                    onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
                  />
                  Default for this document type
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                  />
                  Active
                </label>
              </div>

              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Approval stages ({form.stages.length})
                  </p>
                  <button onClick={addStage} className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium">
                    <Plus className="h-3.5 w-3.5" /> Add stage
                  </button>
                </div>

                <div className="space-y-3">
                  {form.stages.map((stage, idx) => (
                    <div key={idx} className="rounded-xl border border-border p-3 bg-surface-raised space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-text-muted uppercase tracking-wider">
                          Stage {idx + 1}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => moveStage(idx, -1)}
                            disabled={idx === 0}
                            className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 rounded"
                            title="Move up"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => moveStage(idx, 1)}
                            disabled={idx === form.stages.length - 1}
                            className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 rounded"
                            title="Move down"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => removeStage(idx)}
                            disabled={form.stages.length === 1}
                            className="p-1 text-text-muted hover:text-red-600 disabled:opacity-30 rounded"
                            title="Remove stage"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <input
                          className="ui-input text-sm"
                          placeholder="Stage name (e.g. Manager Approval)"
                          value={stage.name}
                          onChange={(e) => updateStage(idx, { name: e.target.value })}
                        />
                        <select
                          className="ui-input text-sm"
                          value={stage.assignedRole}
                          onChange={(e) => updateStage(idx, { assignedRole: e.target.value })}
                        >
                          <option value="">Select approver role…</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.name}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            className="ui-input text-sm w-24"
                            value={stage.slaDurationHours}
                            onChange={(e) => updateStage(idx, { slaDurationHours: Number(e.target.value) || 0 })}
                          />
                          <span className="text-xs text-text-muted whitespace-nowrap">SLA hours</span>
                        </div>
                        <select
                          className="ui-input text-sm"
                          value={stage.escalationRole ?? ''}
                          onChange={(e) => updateStage(idx, { escalationRole: e.target.value })}
                        >
                          <option value="">No escalation role</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.name}>
                              Escalate to {r.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex gap-5">
                        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={stage.slaBusinessHoursOnly}
                            onChange={(e) => updateStage(idx, { slaBusinessHoursOnly: e.target.checked })}
                          />
                          Business hours only
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <input
                            type="checkbox"
                            checked={!!stage.parallelApproval}
                            onChange={(e) => updateStage(idx, { parallelApproval: e.target.checked })}
                          />
                          Parallel approval
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {fieldError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{fieldError}</p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-border">
              <button onClick={() => setModalOpen(false)} className="ui-btn ui-btn-secondary">
                Cancel
              </button>
              <button
                disabled={!canSubmit || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
                className="ui-btn ui-btn-primary"
              >
                {saveMutation.isPending ? 'Saving…' : editingId ? 'Save changes' : 'Create definition'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
