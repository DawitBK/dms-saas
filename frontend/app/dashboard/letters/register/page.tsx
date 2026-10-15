'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowLeft, Inbox, FileUp } from 'lucide-react';
import Link from 'next/link';
import { listLetters, listOrgUnits, registerIncoming } from '../../../../features/letters/api';
import { listDepartments } from '../../../../features/documents/api';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { RequirePermission } from '../../../../shared/components/RequirePermission';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { apiClient } from '../../../../shared/lib/apiClient';
import { letterErrorMessage } from '@/features/letters/errors';

type UserOption = { id: string; firstName: string; lastName: string; email: string };

export default function RegisterIncomingPage() {
  const router = useRouter();
  const { can } = usePermissions();
  const [form, setForm] = useState({
    orgUnitId: '',
    departmentId: '',
    subject: '',
    correspondent: '',
    correspondentOrganization: '',
    correspondentLocation: '',
    correspondentEmail: '',
    receivedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    priority: 'NORMAL',
    confidentiality: 'INTERNAL',
    assignedToUserId: '',
    relatedLetterId: '',
  });
  const [scan, setScan] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relatedSearch, setRelatedSearch] = useState('');
  const [relatedLabel, setRelatedLabel] = useState('');

  // 30s, not 5 minutes — a department/org unit created moments ago must be
  // pickable the next time this page loads (same fix as useLookups.ts).
  const { data: unitsData } = useQuery({ queryKey: ['org-units'], queryFn: listOrgUnits, staleTime: 30_000 });
  const { data: deptsData } = useQuery({ queryKey: ['departments'], queryFn: listDepartments, staleTime: 30_000 });

  // Same best-effort picker as the letter detail page's Assign modal — a 403
  // just leaves this empty for callers who lack user:manage/department:manage.
  const { data: usersData } = useQuery({
    queryKey: ['users', 'letter-assignees'],
    queryFn: () => apiClient<{ data: UserOption[] }>('/users'),
    enabled: can(PERMISSIONS.USER_MANAGE) || can(PERMISSIONS.DEPT_MANAGE) || can(PERMISSIONS.ACL_BYPASS_ADMIN),
    staleTime: 60_000,
  });

  const { data: relatedCandidates } = useQuery({
    queryKey: ['letters', 'related-picker', relatedSearch],
    queryFn: () => listLetters({ q: relatedSearch, take: 8 }),
    enabled: relatedSearch.trim().length >= 2,
  });

  const register = useMutation({
    mutationFn: () => registerIncoming({ ...form }, scan ?? undefined),
    onSuccess: (res) => {
      // WARN-UNSCANNED is fail-open (never blocking) — same amber-toast
      // treatment as the document upload paths, not a plain success.
      if (res.data.warnings?.includes('WARN-UNSCANNED')) {
        toast(
          `Registered as ${res.data.referenceNumber} — but the scan could not be checked for viruses. It was still allowed through and is flagged for review.`,
          {
            icon: '⚠️',
            duration: 8000,
            style: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' },
          },
        );
      } else {
        toast.success(`Registered as ${res.data.referenceNumber}`);
      }
      router.push(`/dashboard/letters/${res.data.id}`);
    },
    onError: (e: unknown) => setError(letterErrorMessage(e, 'Registration failed')),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.orgUnitId || !form.departmentId || !form.subject.trim() || !form.correspondent.trim()) {
      setError('Unit, department, subject, and sender are required');
      return;
    }
    register.mutate();
  };

  return (
    <RequirePermission permission={PERMISSIONS.LETTER_REGISTER}>
      <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <Link href="/dashboard/letters" className="inline-flex items-center gap-1.5 text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back to correspondence
          </Link>
          <PageHeader
            title="Register incoming letter"
            subtitle="A registration reference is allocated immediately; scans are OCR-indexed for full-text search"
          />

          {error && (
            <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
          )}

          <form onSubmit={submit} className="ui-card mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Receiving unit *</span>
                <select
                  value={form.orgUnitId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm((f) => {
                      // A department belongs to exactly one org unit -- drop
                      // a department choice that no longer belongs to the
                      // newly selected receiving unit.
                      const deptStillValid = !f.departmentId || (deptsData ?? []).find((d: any) => d.id === f.departmentId)?.orgUnitId === value;
                      return { ...f, orgUnitId: value, departmentId: deptStillValid ? f.departmentId : '' };
                    });
                  }}
                  className="ui-input mt-1 w-full"
                >
                  <option value="">Select unit…</option>
                  {(unitsData?.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>{u.code} — {u.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Route to department *</span>
                <select value={form.departmentId} onChange={set('departmentId')} className="ui-input mt-1 w-full">
                  <option value="">Select department…</option>
                  {(deptsData ?? [])
                    .filter((d: any) => !form.orgUnitId || d.orgUnitId === form.orgUnitId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
                    ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Sender (person) *</span>
                <input value={form.correspondent} onChange={set('correspondent')} className="ui-input mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Sender organization</span>
                <input value={form.correspondentOrganization} onChange={set('correspondentOrganization')} className="ui-input mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Sender location</span>
                <input value={form.correspondentLocation} onChange={set('correspondentLocation')} className="ui-input mt-1 w-full" placeholder="e.g. Example City, Exampleland" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Sender email</span>
                <input type="email" value={form.correspondentEmail} onChange={set('correspondentEmail')} className="ui-input mt-1 w-full" placeholder="for reply / reference" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Date received</span>
                <input type="date" value={form.receivedDate} onChange={set('receivedDate')} className="ui-input mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Response due date</span>
                <input type="date" value={form.dueDate} onChange={set('dueDate')} className="ui-input mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Priority</span>
                <select value={form.priority} onChange={set('priority')} className="ui-input mt-1 w-full">
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Confidentiality</span>
                <select value={form.confidentiality} onChange={set('confidentiality')} className="ui-input mt-1 w-full">
                  <option value="PUBLIC">Public</option>
                  <option value="INTERNAL">Internal</option>
                  <option value="CONFIDENTIAL">Confidential</option>
                  <option value="RESTRICTED">Restricted</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Route to officer</span>
                <select value={form.assignedToUserId} onChange={set('assignedToUserId')} className="ui-input mt-1 w-full">
                  <option value="">Unassigned — route by department only</option>
                  {(usersData?.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Subject *</span>
              <input value={form.subject} onChange={set('subject')} className="ui-input mt-1 w-full" maxLength={500} />
            </label>

            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Reply to (optional)</span>
              <div className="mt-1 space-y-1.5">
                <input
                  value={form.relatedLetterId ? relatedLabel : relatedSearch}
                  onChange={(e) => {
                    setRelatedSearch(e.target.value);
                    setForm((f) => ({ ...f, relatedLetterId: '' }));
                    setRelatedLabel('');
                  }}
                  placeholder="Search an outgoing letter this is replying to, by reference or subject"
                  className="ui-input w-full"
                />
                {!form.relatedLetterId && (relatedCandidates?.data ?? []).length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                    {(relatedCandidates?.data ?? []).map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => {
                          setForm((f) => ({ ...f, relatedLetterId: c.id }));
                          setRelatedLabel(`${c.referenceNumber ?? 'draft'} — ${c.subject}`);
                        }}
                        className="block w-full text-left px-3 py-2 text-[13px] hover:bg-surface-raised"
                      >
                        <span className="font-mono text-[12px]">{c.referenceNumber ?? 'draft'}</span> - {c.subject}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>

            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Scanned original (PDF, Word, or image)</span>
              <div
                className="mt-1 flex items-center gap-3 rounded-md border border-dashed px-4 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <FileUp className="h-5 w-5" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="file"
                  accept="application/pdf,image/*,.doc,.docx"
                  onChange={(e) => setScan(e.target.files?.[0] ?? null)}
                  className="text-[13px]"
                />
                {scan && <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{(scan.size / 1024 / 1024).toFixed(1)} MB</span>}
              </div>
            </label>

            <div className="flex justify-end gap-2">
              <Link href="/dashboard/letters" className="ui-btn ui-btn-secondary">Cancel</Link>
              <button type="submit" disabled={register.isPending} className="ui-btn ui-btn-primary">
                <Inbox className="h-4 w-4" />
                {register.isPending ? 'Registering…' : 'Register letter'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </RequirePermission>
  );
}
