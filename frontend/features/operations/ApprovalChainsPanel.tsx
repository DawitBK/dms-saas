'use client';

// Operations → Approval Chains (SYSTEM-DECISIONS.md D1, D5–D7):
//  * chain TEMPLATES per document type — the recipe the author sees pre-filled
//    at submit; steps can be LOCKED (mandatory, author cannot change them);
//  * the audit-stage register — who audited what, pass/flag, findings, aging.

import { useState } from 'react';
import { format } from 'date-fns';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CheckCircle2, ClipboardList, Lock, Pencil, Plus, Power, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { useAssignableRoles } from '../../shared/lib/assignmentAdvisory';
import { EmptyState } from '../../shared/components/EmptyState';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import { listFormTemplates } from '../forms/api';
import type { ApprovalChainTemplateView } from '../approvals/api';
import { approvalErrorMessage } from '../approvals/errors';
import { ScopeSelect } from '../forms/components/ScopeSelect';
import { hasOrgLevelAuthority, initialScope, scopeBadgeText, scopePayload, scopeProblem, type ScopeSelection } from '../forms/templateScope';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useDepartments, useOrgUnits } from '../../shared/hooks/useLookups';

// 15/page, matching the project-wide pagination convention (see
// documents.routes.ts skip/take + shared/components/ui/PaginationControls.tsx).
const AUDIT_REGISTER_PAGE_SIZE = 15;

type TemplateStep = {
  stepOrder?: number;
  stepType: 'REVIEW' | 'APPROVE';
  assignedRole?: string | null;
  assignedUserId?: string | null;
  locked?: boolean;
  slaHours?: number | null;
};

type ChainTemplate = ApprovalChainTemplateView;

// What a recipe targets. 'formtemplates' = the approval of form TEMPLATES themselves (forFormTemplates); exactly one
// of the three is sent.
type TargetKind = 'doctype' | 'form' | 'formtemplates' | 'default';
const TARGET_LABEL: Record<TargetKind, string> = {
  doctype: 'Document Type',
  form: 'Form Template',
  formtemplates: 'Approval of form templates',
  default: 'Default for everything else',
};

// The roles every tenant has; the picker adds whatever else the roles list returns (EMPLOYEE, EXECUTIVE, custom roles).
const BASE_ROLE_OPTIONS = ['DEPT_MANAGER', 'APPROVER', 'RECORDS_OFFICER', 'SYSTEM_ADMIN', 'EMPLOYEE', 'EXECUTIVE'];

function safeDate(v: unknown): string {
  if (!v) return '--';
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy HH:mm');
}

export function ApprovalChainsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'templates' | 'register'>('templates');
  const [registerPage, setRegisterPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [targetKind, setTargetKind] = useState<TargetKind>('doctype');
  const [targetTypeId, setTargetTypeId] = useState('');
  const [targetFormTemplateId, setTargetFormTemplateId] = useState('');
  // Scope: whole organisation (both ids null), one organisation unit, or one department. The most specific scope that
  // matches wins when something is submitted.
  const { can } = usePermissions();
  const orgLevel = hasOrgLevelAuthority(can);
  const [scope, setScope] = useState<ScopeSelection>(() => initialScope(undefined, orgLevel));
  const { data: departmentList } = useDepartments();
  const { data: orgUnitList } = useOrgUnits();
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<TemplateStep[]>([
    { stepType: 'REVIEW', assignedRole: 'APPROVER', locked: false, slaHours: 48 },
    { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', locked: true },
  ]);

  const { data: tplData, isLoading } = useQuery({
    queryKey: ['approval-templates'],
    queryFn: () => apiClient<{ data: ChainTemplate[] }>('/approvals/templates'),
  });
  const { data: typesData } = useQuery({
    queryKey: ['admin-doc-types'],
    queryFn: () => apiClient<{ data: Array<{ id: string; code: string; name: string }> }>('/document-types'),
    staleTime: 60_000,
  });
  const { data: formTemplatesData } = useQuery({
    queryKey: ['forms', 'templates', 'all'],
    // Dropdown picker, not a paged list — ask for the full set rather than
    // the default page size so newer/older templates aren't excluded.
    queryFn: () => listFormTemplates(undefined, 0, 500),
    staleTime: 60_000,
  });
  const { data: usersData } = useQuery({
    queryKey: ['users', 'approval-pickers'],
    // The assignee picker endpoint, not GET /users: a records officer manages chains (workflow:manage) but holds
    // neither user:manage nor role:read, so the old calls answered 403 on this very tab.
    queryFn: () => apiClient<{ data: Array<{ id: string; firstName: string; lastName: string; email: string }> }>('/approvals/assignable-users'),
    staleTime: 60_000,
  });
  const { data: assignableRoles } = useAssignableRoles();
  const rolesData = { data: (assignableRoles ?? []).map((r: { name: string }) => ({ name: r.name })) };
  const { data: registerData, isLoading: registerLoading } = useQuery({
    queryKey: ['audit-register', registerPage],
    queryFn: () =>
      apiClient<{ data: Array<Record<string, any>>; total: number }>(
        `/approvals/audit-reviews?skip=${(registerPage - 1) * AUDIT_REGISTER_PAGE_SIZE}&take=${AUDIT_REGISTER_PAGE_SIZE}`,
      ),
    enabled: tab === 'register',
  });
  const registerTotal = registerData?.total ?? registerData?.data?.length ?? 0;
  const registerTotalPages = Math.max(1, Math.ceil(registerTotal / AUDIT_REGISTER_PAGE_SIZE));

  // Recovery lever for a stuck PENDING audit review (e.g. the assigned
  // auditor left or is unavailable) — mirrors ApprovalChainCard's step
  // reassignment, which uses the same prompt-based UX for the same class of
  // admin action. Backend: POST /approvals/audit-reviews/:reviewId/reassign
  // (only the original assigner or an approval:admin holder may call it).
  const reassignAudit = useMutation({
    mutationFn: (vars: { reviewId: string; auditorUserId: string }) =>
      apiClient(`/approvals/audit-reviews/${vars.reviewId}/reassign`, {
        method: 'POST',
        body: JSON.stringify({ auditorUserId: vars.auditorUserId }),
      }),
    onSuccess: () => { toast.success('Audit review reassigned'); qc.invalidateQueries({ queryKey: ['audit-register'] }); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Reassign failed')),
  });

  const onReassignAudit = (reviewId: string) => {
    const email = window.prompt('Reassign this audit review to which user? (email of an active user)');
    if (!email) return;
    const target = users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!target) { toast.error('No user with that email in the picker list'); return; }
    reassignAudit.mutate({ reviewId, auditorUserId: target.id });
  };

  const templates = tplData?.data ?? [];
  const types = typesData?.data ?? [];
  const formTemplates = formTemplatesData?.data ?? [];
  const users = usersData?.data ?? [];
  const ROLE_OPTIONS = Array.from(new Set([...BASE_ROLE_OPTIONS, ...(rolesData?.data ?? []).map((r) => r.name)])).filter((r) => r !== 'PLATFORM_ADMIN');
  const typeName = (id: string | null) => types.find((t) => t.id === id)?.code ?? '—';
  const formTemplateName = (id: string | null) => formTemplates.find((t) => t.id === id)?.name ?? '—';
  // What the recipe targets (document type / form template / approval of form templates).
  const isDefaultRecipe = (t: ChainTemplate) => !t.forFormTemplates && !t.formTemplateId && !t.documentTypeId;
  const targetLabel = (t: ChainTemplate) =>
    t.forFormTemplates ? 'Approval of form templates'
      : isDefaultRecipe(t) ? 'Default (everything else)'
      : t.formTemplateId ? `Form: ${formTemplateName(t.formTemplateId)}` : typeName(t.documentTypeId);
  const defaultName =
    targetKind === 'formtemplates' ? 'Form template approval chain'
      : targetKind === 'default' ? 'Default approval chain'
      : `${targetKind === 'form' ? formTemplateName(targetFormTemplateId) : typeName(targetTypeId)} chain`;

  // Opens the editor empty (new / replace) or loaded from an existing recipe (edit it in place: saving replaces it).
  const openEditor = (t?: ChainTemplate) => {
    if (t) {
      setTargetKind(t.forFormTemplates ? 'formtemplates' : isDefaultRecipe(t) ? 'default' : t.formTemplateId ? 'form' : 'doctype');
      setTargetTypeId(t.documentTypeId ?? '');
      setTargetFormTemplateId(t.formTemplateId ?? '');
      setName(t.name);
      setScope(initialScope(t, orgLevel));
      setSteps((t.steps ?? []).map((s) => ({ stepType: s.stepType, assignedRole: s.assignedRole ?? undefined, assignedUserId: s.assignedUserId ?? undefined, locked: s.locked ?? false, slaHours: s.slaHours ?? null })));
    } else {
      setTargetKind('doctype'); setTargetTypeId(types[0]?.id ?? ''); setTargetFormTemplateId(''); setName(''); setScope(initialScope(undefined, orgLevel));
      setSteps([{ stepType: 'REVIEW', assignedRole: 'APPROVER', locked: false, slaHours: 48 }, { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', locked: true }]);
    }
    setEditorOpen(true);
  };
  const deactivate = useMutation({
    mutationFn: (id: string) => apiClient(`/approvals/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Recipe switched off — new submissions use the next less specific recipe, or the built-in default'); qc.invalidateQueries({ queryKey: ['approval-templates'] }); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Could not switch the recipe off')),
  });
  const targetMissing =
    targetKind === 'doctype' ? !targetTypeId : targetKind === 'form' ? !targetFormTemplateId : false;
  const scopeIssue = scopeProblem(scope);

  const save = useMutation({
    mutationFn: () =>
      apiClient('/approvals/templates', {
        method: 'POST',
        body: JSON.stringify({
          documentTypeId: targetKind === 'doctype' ? targetTypeId : undefined,
          formTemplateId: targetKind === 'form' ? targetFormTemplateId : undefined,
          forFormTemplates: targetKind === 'formtemplates' ? true : undefined,
          isDefault: targetKind === 'default' ? true : undefined,
          ...scopePayload(scope),
          name: name.trim() || defaultName,
          steps: steps.map((s) => ({
            stepType: s.stepType,
            assignedRole: s.assignedUserId ? undefined : (s.assignedRole || undefined),
            assignedUserId: s.assignedUserId || undefined,
            locked: s.locked ?? false,
            slaHours: s.slaHours || undefined,
          })),
        }),
      }),
    onSuccess: () => {
      toast.success('Template saved — it now pre-fills every submit for this target and scope');
      setEditorOpen(false);
      qc.invalidateQueries({ queryKey: ['approval-templates'] });
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Save failed')),
  });

  return (
    <div>
      <div className="flex gap-1 p-1 bg-surface-raised rounded-xl mb-6 w-fit">
        {(['templates', 'register'] as const).map((key) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab === key ? 'bg-surface-card shadow-sm text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}>
            {key === 'templates' ? 'Chain Templates' : 'Audit-Stage Register'}
          </button>
        ))}
      </div>

      {tab === 'templates' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <p className="text-sm text-text-muted max-w-2xl">
              The recipe an author sees pre-filled when submitting a document of each type.
              Locked steps are mandatory — the author cannot remove, change, or reorder them.
              Saving a template replaces the previous one for the same target and scope. A recipe can apply to the whole
              organisation, one organisation unit or one department; the most specific one wins when something is submitted.
            </p>
            <button onClick={() => openEditor()} className="ui-btn ui-btn-primary text-sm shrink-0">
              <Plus className="h-4 w-4" /> New / Replace Template
            </button>
          </div>
          <div className="space-y-3">
            {isLoading && <p className="text-sm text-text-muted">Loading…</p>}
            {!isLoading && templates.filter((t) => t.isActive).length === 0 && (
              <EmptyState icon={ClipboardList} title="No chain templates"
                description="Without a template, submits pre-fill with the default single Approve step to the Dept Manager." />
            )}
            {templates.filter((t) => t.isActive).map((t) => (
              <div key={t.id} className="ui-card">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-xs font-bold text-brand-600">{targetLabel(t)}</span>
                  <span className="text-sm font-semibold">{t.name}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }} title="Who this recipe applies to" data-testid="recipe-scope-badge">
                    {scopeBadgeText(t, departmentList ?? [], orgUnitList ?? [])}
                  </span>
                  <span className="ml-auto text-[11px] text-text-muted">created {safeDate(t.createdAt)}</span>
                  <button onClick={() => openEditor(t)} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]" title="Load this recipe into the editor; saving replaces it (chains already in flight keep their steps)">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    onClick={() => { if (window.confirm('Switch this recipe off? Chains already in flight keep their steps; new submissions fall back to the next less specific recipe.')) deactivate.mutate(t.id); }}
                    disabled={deactivate.isPending}
                    className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"
                    title="Stop using this recipe for new submissions"
                  >
                    <Power className="h-3.5 w-3.5" /> Switch off
                  </button>
                </div>
                <ol className="flex flex-wrap gap-2">
                  {(t.steps ?? []).map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-xs rounded-md px-2.5 py-1.5" style={{ background: 'var(--surface-raised)' }}>
                      <span className="font-mono text-text-muted">#{i + 1}</span>
                      <span className="font-semibold">{s.stepType === 'APPROVE' ? 'Approve' : 'Review'}</span>
                      <span className="text-text-muted">
                        → {s.assignedUserId
                          ? (users.find((u) => u.id === s.assignedUserId)?.email ?? 'named user')
                          : (s.assignedRole ?? '').replace(/_/g, ' ')}
                      </span>
                      {s.locked && <Lock className="h-3 w-3 text-slate-500" aria-label="Locked (mandatory)" />}
                      {s.slaHours ? <span className="text-text-muted">· {s.slaHours}h SLA</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'register' && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm divide-y divide-border-subtle">
            <thead>
              <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
                <th className="px-4 py-3 text-left">Item</th>
                <th className="px-4 py-3 text-left">Auditor</th>
                <th className="px-4 py-3 text-left">Assigned by</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Findings</th>
                <th className="px-4 py-3 text-left">Assigned</th>
                <th className="px-4 py-3 text-left">Decided</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {(registerData?.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-3">
                    <a href={`/dashboard/documents/${r.itemId}?tab=workflow`} className="text-brand-600 hover:underline font-mono text-xs">
                      {String(r.itemId).slice(0, 8)}…
                    </a>
                  </td>
                  <td className="px-4 py-3 text-xs">{r.auditor ? `${r.auditor.firstName} ${r.auditor.lastName}` : '—'}</td>
                  <td className="px-4 py-3 text-xs">{r.assigner ? `${r.assigner.firstName} ${r.assigner.lastName}` : '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${
                      r.status === 'PASSED' ? 'bg-emerald-100 text-emerald-700'
                      : r.status === 'FLAGGED' ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'}`}>
                      {r.status === 'PASSED' ? <CheckCircle2 className="h-3 w-3" /> : r.status === 'FLAGGED' ? <XCircle className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs max-w-[280px] truncate" title={r.findings ?? ''}>{r.findings ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-text-muted">{safeDate(r.createdAt)}</td>
                  <td className="px-4 py-3 text-xs text-text-muted">{safeDate(r.decidedAt)}</td>
                  <td className="px-4 py-3">
                    {r.status === 'PENDING' && (
                      <button
                        onClick={() => onReassignAudit(r.id)}
                        disabled={reassignAudit.isPending}
                        className="text-xs font-semibold text-brand-600 hover:underline"
                        title="Stuck-review recovery: hand this audit to a different auditor"
                      >
                        Reassign
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(registerData?.data ?? []).length === 0 && (
                <tr><td colSpan={8}><EmptyState icon={ShieldCheck} title="No audit reviews yet"
                  description="Reviews appear here when a final approver routes an approved item to an auditor." /></td></tr>
              )}
            </tbody>
          </table>
          {registerTotal > AUDIT_REGISTER_PAGE_SIZE && (
            <PaginationControls
              page={registerPage}
              onPageChange={setRegisterPage}
              hasPrevious={registerPage > 1}
              hasNext={registerPage * AUDIT_REGISTER_PAGE_SIZE < registerTotal}
              totalPages={registerTotalPages}
              isLoading={registerLoading}
            />
          )}
        </div>
      )}

      {editorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setEditorOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <h3 className="text-sm font-bold mb-1">Chain template</h3>
            <p className="text-xs text-text-muted mb-4">One active template per target and scope — saving replaces the previous one. The final step must be an Approve.</p>
            <div className="flex flex-wrap gap-1 p-1 bg-surface-raised rounded-lg mb-3 w-fit">
              {(['doctype', 'form', 'formtemplates', 'default'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setTargetKind(k)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${targetKind === k ? 'bg-surface-card shadow-sm text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
                >
                  {TARGET_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5">{targetKind === 'doctype' ? 'Document type' : targetKind === 'form' ? 'Form template' : 'Applies to'}</label>
                {targetKind === 'doctype' ? (
                  <select className="ui-input" value={targetTypeId} onChange={(e) => setTargetTypeId(e.target.value)}>
                    {types.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
                  </select>
                ) : targetKind === 'form' ? (
                  <select className="ui-input" value={targetFormTemplateId} onChange={(e) => setTargetFormTemplateId(e.target.value)}>
                    <option value="">Select a form template…</option>
                    {formTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.category ? ` (${t.category})` : ''}</option>)}
                  </select>
                ) : targetKind === 'default' ? (
                  <p className="text-xs text-text-muted" data-testid="recipe-default-help">
                    The catch-all: used for every document or form at this scope that has no recipe of its own. Set it on an
                    organisation unit to name that unit&apos;s default approvers instead of the department manager alone.
                  </p>
                ) : (
                  <p className="text-xs text-text-muted" data-testid="recipe-form-templates-help">
                    Approves form <strong>templates</strong> themselves before they become usable. Without a recipe, an
                    organisation-wide or organisation-unit template is approved by the System Admin role, and a
                    department template by that department&apos;s manager.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5">Template name</label>
                <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Contract approval chain" />
              </div>
            </div>
            <div className="mb-4">
              <ScopeSelect
                idPrefix="recipe"
                label="Who this recipe applies to"
                value={scope}
                onChange={setScope}
                orgLevel={orgLevel}
                hint={scope.kind === 'organisation'
                  ? 'Applies everywhere unless a more specific recipe (organisation unit, then department) exists.'
                  : undefined}
              />
            </div>
            <ul className="space-y-2 mb-4">
              {steps.map((s, idx) => (
                <li key={idx} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                  <span className="text-[12px] font-mono w-6">#{idx + 1}</span>
                  <select value={s.stepType} onChange={(e) => setSteps((p) => p.map((x, i) => i === idx ? { ...x, stepType: e.target.value as 'REVIEW' | 'APPROVE' } : x))} className="ui-input !w-auto text-xs">
                    <option value="REVIEW">Review</option>
                    <option value="APPROVE">Approve</option>
                  </select>
                  <select value={s.assignedRole ?? ''} onChange={(e) => setSteps((p) => p.map((x, i) => i === idx ? { ...x, assignedRole: e.target.value || undefined, assignedUserId: undefined } : x))} className="ui-input !w-auto text-xs">
                    <option value="">— role —</option>
                    {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                  </select>
                  <select value={s.assignedUserId ?? ''} onChange={(e) => setSteps((p) => p.map((x, i) => i === idx ? { ...x, assignedUserId: e.target.value || undefined, assignedRole: e.target.value ? undefined : x.assignedRole } : x))} className="ui-input !w-auto text-xs">
                    <option value="">— or named person —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
                  </select>
                  <input type="number" min={1} placeholder="SLA h" value={s.slaHours ?? ''} onChange={(e) => setSteps((p) => p.map((x, i) => i === idx ? { ...x, slaHours: e.target.value ? Number(e.target.value) : null } : x))} className="ui-input !w-20 text-xs" />
                  <label className="flex items-center gap-1 text-xs text-text-muted cursor-pointer" title="Locked steps are mandatory — the author cannot remove or change them">
                    <input type="checkbox" checked={s.locked ?? false} onChange={(e) => setSteps((p) => p.map((x, i) => i === idx ? { ...x, locked: e.target.checked } : x))} />
                    <Lock className="h-3 w-3" /> locked
                  </label>
                  <button onClick={() => setSteps((p) => p.filter((_x, i) => i !== idx))} className="ml-auto p-1 text-slate-400 hover:text-red-600" aria-label="Remove step">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between">
              <button onClick={() => setSteps((p) => [...p, { stepType: 'REVIEW', assignedRole: 'APPROVER', locked: false }])} className="ui-btn ui-btn-secondary text-xs">
                <Plus className="h-3.5 w-3.5" /> Add step
              </button>
              <div className="flex gap-2">
                <button onClick={() => setEditorOpen(false)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
                <button
                  disabled={save.isPending || targetMissing || Boolean(scopeIssue) || steps.length === 0 || steps[steps.length - 1]?.stepType !== 'APPROVE'}
                  onClick={() => save.mutate()}
                  className="ui-btn ui-btn-primary text-xs"
                  title={steps[steps.length - 1]?.stepType !== 'APPROVE' ? 'The final step must be an Approve' : undefined}
                >
                  Save template
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
