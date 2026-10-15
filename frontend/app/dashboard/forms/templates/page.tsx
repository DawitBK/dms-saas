'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileText, Plus, CheckCircle2, Clock, Archive, Eye, GitBranch, Pencil } from 'lucide-react';
import {
  createFormTemplate, createFormTemplateVersion, listFormTemplates, updateFormTemplateContent, updateFormTemplateStatus,
  type FormTemplate,
} from '../../../../features/forms/api';
import { TemplateBuilderModal } from '../../../../features/forms/components/TemplateBuilderModal';
import { ApprovalChainCard } from '../../../../features/approvals/ApprovalChainCard';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { PermissionGate } from '../../../../shared/components/PermissionGate';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { useUIStore } from '../../../../state/ui.store';
import { useAuthStore } from '../../../../state/auth.store';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { apiClient } from '../../../../shared/lib/apiClient';
import { approvalErrorMessage } from '../../../../features/approvals/errors';
import { useDepartments, useOrgUnits } from '../../../../shared/hooks/useLookups';
import { scopeBadgeText } from '../../../../features/forms/templateScope';

const PAGE_SIZE = 25;

const STATUS_COLORS: Record<string, string> = {
  draft: 'var(--color-slate-500)',
  pending_approval: 'var(--color-amber-500)',
  active: 'var(--color-green-500)',
  deprecated: 'var(--color-red-400)',
};
const STATUS_ICONS: Record<string, React.ComponentType<{ size?: number }>> = { draft: Clock, pending_approval: Clock, active: CheckCircle2, deprecated: Archive };

function StatusBadge({ status }: { status: string }) {
  const Icon = STATUS_ICONS[status] ?? Eye;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: `${STATUS_COLORS[status]}22`, color: STATUS_COLORS[status] }}><Icon size={11} />{status.replace('_', ' ')}</span>;
}

function FormTemplatesPageInner() {
  const qc = useQueryClient();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const searchParams = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const userId = useAuthStore((s) => s.userId);
  const { can } = usePermissions();
  // Backend rule (assertCanModifyTemplate): only a template's author or an approval:admin holder may edit,
  // version, deprecate or submit it; everyone else with formtemplate:manage would get a 403.
  const canModifyTemplate = (t: FormTemplate) => can(PERMISSIONS.APPROVAL_ADMIN) || (!!userId && t.createdBy === userId);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<FormTemplate | null>(null);
  // A "My Work" deep link for a pending template chain always points at a
  // pending_approval item — force that filter so the highlighted row is
  // guaranteed to be on page 1 rather than lost behind whatever filter/page
  // the user last had selected.
  const [statusFilter, setStatusFilter] = useState(highlightId ? 'pending_approval' : '');
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(highlightId);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['forms', 'templates', statusFilter, page],
    queryFn: () => listFormTemplates(statusFilter || undefined, (page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  // Names for the scope badge on each template ("who can use this form").
  const { data: departmentList } = useDepartments();
  const { data: orgUnitList } = useOrgUnits();

  const createMutation = useMutation({
    mutationFn: createFormTemplate,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['forms'] }); setShowCreate(false); toast.success('Form template created'); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Create failed')),
  });
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateFormTemplateStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['forms'] }),
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Status change failed')),
  });
  // Rec §7.1: template activation goes through the unified approval engine —
  // submitting creates a chain (default: Approve by Dept Manager); the final
  // APPROVE flips the template to active and stamps approvedBy.
  const submitTemplateMutation = useMutation({
    mutationFn: (id: string) => apiClient(`/approvals/FORM_TEMPLATE/${id}/submit`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['forms'] }); toast.success('Template submitted — it activates when its approval chain completes'); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Submit failed')),
  });
  const newVersionMutation = useMutation({
    mutationFn: (id: string) => createFormTemplateVersion(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['forms'] });
      toast.success('New draft revision created — opening it to edit');
      // Immediately open the new clone for editing instead of leaving the
      // author to find it in the list and click Edit themselves — the
      // whole point of "new version" is to change something before
      // resubmitting, so land them exactly where they can do that.
      setEditingTemplate(res.data);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'New version failed')),
  });
  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof updateFormTemplateContent>[1] }) => updateFormTemplateContent(id, payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['forms'] }); setEditingTemplate(null); toast.success('Draft saved'); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Save failed')),
  });

  const templates = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!highlightId || isLoading) return;
    document.getElementById(`template-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Only run once the highlighted row has actually rendered.
  }, [highlightId, isLoading, templates.length]);

  return (
    <>
      <TopBar
        title="Forms"
        breadcrumbs={[{ label: 'Forms', href: '/dashboard/forms/templates' }, { label: 'Templates' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <div className="flex items-center justify-between mb-6">
          <PageHeader title="Form Templates" subtitle="Build fields visually, approve templates, and generate document-backed form instances." />
          <PermissionGate permission={PERMISSIONS.FORM_TEMPLATE_MANAGE}><button onClick={() => setShowCreate(true)} className="ui-btn ui-btn-primary shrink-0"><Plus size={16} /> New template</button></PermissionGate>
        </div>

        <div className="flex gap-2 mb-4 flex-wrap">{['', 'draft', 'pending_approval', 'active', 'deprecated'].map((s) => <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }} className="px-3 py-1 rounded-full text-xs font-medium" style={{ background: statusFilter === s ? 'var(--color-primary-600)' : 'var(--surface-raised)', color: statusFilter === s ? '#fff' : 'var(--text-secondary)' }}>{s === '' ? 'All' : s.replace('_', ' ')}</button>)}</div>

        {showCreate && (
          <TemplateBuilderModal
            onClose={() => setShowCreate(false)}
            isCreating={createMutation.isPending}
            onCreate={(payload) => createMutation.mutate({ ...payload, layoutMode: 'dynamic' })}
          />
        )}

        {editingTemplate && (
          <TemplateBuilderModal
            onClose={() => setEditingTemplate(null)}
            editingTemplate={editingTemplate}
            isCreating={false}
            onCreate={() => {}}
            isSaving={saveMutation.isPending}
            onSave={(id, payload) => saveMutation.mutate({ id, payload })}
          />
        )}

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading templates...</div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16"><FileText size={40} className="mx-auto mb-3 opacity-30" style={{ color: 'var(--text-secondary)' }} /><p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No templates yet. Create one to get started.</p></div>
        ) : (
          <div className="space-y-2">
            {templates.map((t: FormTemplate) => (
              <div
                key={t.id}
                id={`template-${t.id}`}
                className="rounded-xl p-4"
                style={{
                  background: 'var(--surface-raised)',
                  outline: t.id === highlightId ? '2px solid var(--brand-600)' : undefined,
                }}
              >
                <div className="flex items-center gap-4">
                  <FileText size={20} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
                      <StatusBadge status={t.status} />
                      {t.category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--surface-base)', color: 'var(--text-tertiary)' }}>{t.category}</span>}
                      <span
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{ background: 'var(--surface-base)', color: 'var(--text-tertiary)' }}
                        title="Who can use this form"
                        data-testid="template-scope-badge"
                      >
                        {scopeBadgeText(t, departmentList ?? [], orgUnitList ?? [])}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                      v{t.version} - updated {new Date(t.updatedAt).toLocaleDateString()}
                      {t.approver && ` - approved by ${t.approver.firstName} ${t.approver.lastName}`}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <PermissionGate permission={PERMISSIONS.FORM_TEMPLATE_MANAGE}>
                      {canModifyTemplate(t) && t.status === 'draft' && (
                        <>
                          <button onClick={() => setEditingTemplate(t)} className="ui-btn ui-btn-secondary !py-1.5 text-xs" title="Edit this draft's fields, base file, and policies before submitting it">
                            <Pencil size={13} /> Edit
                          </button>
                          <button onClick={() => submitTemplateMutation.mutate(t.id)} disabled={submitTemplateMutation.isPending} className="px-3 py-1 text-xs rounded-lg" style={{ background: 'var(--color-amber-500)22', color: 'var(--color-amber-500)' }} title="Submits through the approval engine — activates when the chain completes">
                            Submit for approval
                          </button>
                        </>
                      )}
                      {canModifyTemplate(t) && (t.status === 'active' || t.status === 'deprecated') && (
                        <button onClick={() => newVersionMutation.mutate(t.id)} disabled={newVersionMutation.isPending} className="ui-btn ui-btn-secondary !py-1.5 text-xs" title="Clone into a new draft revision — the published version stays as-is">
                          <GitBranch size={13} /> New version
                        </button>
                      )}
                      {canModifyTemplate(t) && t.status === 'active' && (
                        <button onClick={() => statusMutation.mutate({ id: t.id, status: 'deprecated' })} className="px-3 py-1 text-xs rounded-lg" style={{ background: 'var(--color-red-400)22', color: 'var(--color-red-400)' }}>
                          Deprecate
                        </button>
                      )}
                    </PermissionGate>
                    {t.status === 'pending_approval' && (
                      <button
                        onClick={() => setExpandedApprovalId((cur) => (cur === t.id ? null : t.id))}
                        className="ui-btn ui-btn-secondary !py-1.5 text-xs"
                        title="Its own approval chain must complete before this template activates"
                      >
                        {expandedApprovalId === t.id ? 'Hide approval' : 'Approval status'}
                      </button>
                    )}
                  </div>
                </div>
                {t.status === 'pending_approval' && expandedApprovalId === t.id && (
                  <ApprovalChainCard
                    documentId={t.id}
                    documentStatus={t.status}
                    ownerId={null}
                    itemType="FORM_TEMPLATE"
                    itemId={t.id}
                    departmentId={t.departmentId ?? null}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {total > PAGE_SIZE && (
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page < totalPages}
            totalPages={totalPages}
            isLoading={isLoading}
          />
        )}
      </div>
    </>
  );
}

export default function FormTemplatesPage() {
  return (
    <Suspense fallback={null}>
      <FormTemplatesPageInner />
    </Suspense>
  );
}
