'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileText, Play } from 'lucide-react';
import { createFormInstance, listFormTemplates, type FormTemplate } from '../../../../features/forms/api';
import type { SubmitStepInput } from '../../../../features/approvals/api';
import { approvalErrorMessage } from '../../../../features/approvals/errors';
import { FillFormModal } from '../../../../features/forms/components/FillFormModal';
import { listDepartments } from '../../../../features/documents/api';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { useMyDepartments } from '../../../../shared/hooks/useMyDepartments';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { EmptyState } from '../../../../shared/components/EmptyState';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { useUIStore } from '../../../../state/ui.store';

const PAGE_SIZE = 24;

export default function FillFormPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [fillTemplate, setFillTemplate] = useState<FormTemplate | null>(null);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['forms', 'templates', 'active', page],
    queryFn: () => listFormTemplates('active', (page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  // 30s, not 5 minutes — a department created moments ago must be pickable
  // the next time this page loads, not invisible for minutes (same fix as
  // useLookups.ts's useDepartments()).
  const { data: deptsData } = useQuery({ queryKey: ['departments'], queryFn: listDepartments, staleTime: 30_000 });
  // FIX: FillFormModal's department picker used to list every department in
  // the tenant — createFormInstance's departmentId is client-supplied and
  // now (forms.service.ts) rejects one the caller isn't a member of, but the
  // picker itself shouldn't offer departments that submit would always be
  // rejected on. /users/me already carries the caller's own memberships.
  // ACL_BYPASS_ADMIN mirrors ensureCanCreate's own override on the backend
  // (forms.service.ts calls the same ensureCanCreate as uploads) — without
  // this, a records/admin-type user who legitimately can file into any
  // department would see an over-restricted picker here.
  const { can } = usePermissions();
  const canFillAnywhere = can(PERMISSIONS.ACL_BYPASS_ADMIN);
  const { myDepartmentIds: myDeptIds } = useMyDepartments(!canFillAnywhere);
  const myDepartments = canFillAnywhere
    ? (deptsData ?? [])
    : (deptsData ?? []).filter((d: any) => myDeptIds.has(d.id));

  const instanceMutation = useMutation({
    mutationFn: (payload: { dataJson: Record<string, string>; departmentId?: string; files: Record<string, File>; approvalSteps?: SubmitStepInput[] }) =>
      createFormInstance(fillTemplate!.id, payload.dataJson, payload.departmentId, payload.files, payload.approvalSteps),
    onSuccess: (res) => {
      toast.success('Form instance generated');
      if (res.approvalWarning) toast.error(res.approvalWarning, { duration: 8000 });
      setFillTemplate(null);
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['forms', 'instances'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
      // Jump straight to the generated document's detail page (PDF preview
      // lives there already) instead of leaving the user on this page.
      const documentId = res.data.documentId;
      if (documentId) router.push(`/dashboard/documents/${documentId}`);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Instance creation failed')),
  });

  // Chain templates: file the form as a DRAFT (not submitted). It is submitted later from My submissions, where the
  // filer can still edit it first.
  const draftMutation = useMutation({
    mutationFn: (payload: { dataJson: Record<string, string>; departmentId?: string; files: Record<string, File> }) =>
      createFormInstance(fillTemplate!.id, payload.dataJson, payload.departmentId, payload.files, undefined, { saveAsDraft: true }),
    onSuccess: () => {
      toast.success('Saved as a draft - submit it from My submissions');
      setFillTemplate(null);
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['forms', 'instances'] });
      router.push('/dashboard/forms/submissions');
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Could not save the draft')),
  });

  const templates = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="Forms"
        breadcrumbs={[{ label: 'Forms', href: '/dashboard/forms/templates' }, { label: 'Fill a Form' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="Fill a Form" subtitle="Pick an active template — filling it out generates a document-backed PDF." />

        {fillTemplate && (
          <FillFormModal
            template={fillTemplate}
            departments={myDepartments}
            onClose={() => setFillTemplate(null)}
            isSubmitting={instanceMutation.isPending || draftMutation.isPending}
            onSubmit={(payload) => instanceMutation.mutate(payload)}
            onSaveDraft={(payload) => draftMutation.mutate(payload)}
          />
        )}

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading templates...</div>
        ) : templates.length === 0 ? (
          <EmptyState icon={FileText} title="No active templates" description="Ask an administrator to publish a form template before you can fill one." />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setFillTemplate(t)}
                className="rounded-xl p-4 flex items-center gap-3 text-left transition-colors hover:opacity-90"
                style={{ background: 'var(--surface-raised)' }}
              >
                <FileText size={20} style={{ color: 'var(--brand-600)' }} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</p>
                  {t.category && <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t.category}</p>}
                </div>
                <Play size={16} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
              </button>
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
