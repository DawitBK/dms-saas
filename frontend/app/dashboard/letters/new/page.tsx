'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowLeft, Eye, FileUp, Paperclip, RefreshCw, Send, X } from 'lucide-react';
import Link from 'next/link';
import { addLetterAttachment, createLetter, createScannedLetter, listOrgUnits, previewLetterPdf } from '../../../../features/letters/api';
import { listDepartments } from '../../../../features/documents/api';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { RequirePermission } from '../../../../shared/components/RequirePermission';
import { PdfBlobPreview } from '../../../../shared/components/PdfBlobPreview';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { describeApiError } from '../../../../shared/lib/apiClient';
import { useResetOnChange } from '../../../../shared/hooks/useResetOnChange';
import { useMyDepartments } from '../../../../shared/hooks/useMyDepartments';
import { LetterBodyEditor, type CaretPosition } from '../../../../shared/components/letterBody/LetterBodyEditor';
import { letterErrorMessage } from '@/features/letters/errors';

// Debounced so every keystroke in the subject/body/recipient fields doesn't
// hit the backend — see the live-preview effect below.
const PREVIEW_DEBOUNCE_MS = 600;

export default function NewLetterPage() {
  const router = useRouter();
  const [origin, setOrigin] = useState<'COMPOSED' | 'SCANNED'>('COMPOSED');
  const [form, setForm] = useState({
    orgUnitId: '',
    departmentId: '',
    subject: '',
    bodyHtml: '',
    letterType: 'OUT',
    confidentiality: 'INTERNAL',
    priority: 'NORMAL',
    language: 'en',
    correspondent: '',
    correspondentOrganization: '',
    correspondentLocation: '',
    correspondentEmail: '',
  });
  const [scan, setScan] = useState<File | null>(null);
  // Gmail-style compose attachments: supplementary files staged client-side,
  // uploaded one by one right after the draft is created (attachments hang
  // off a letterId, which doesn't exist until then). COMPOSED mode only —
  // a SCANNED letter's uploaded file already IS its content.
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  // staleTime dropped from 300_000 (5 min) — see useMyDepartments for why:
  // a department/org unit created (or this user assigned to one) minutes ago
  // must appear the next time this page loads, not sit invisible for minutes.
  const { data: unitsData } = useQuery({ queryKey: ['org-units'], queryFn: listOrgUnits, staleTime: 30_000 });
  const { data: deptsData } = useQuery({ queryKey: ['departments'], queryFn: listDepartments, staleTime: 30_000 });
  // FIX: this picker used to list every department in the tenant — the
  // backend (letters.service.ts's assertDepartmentMembershipForAuthoring)
  // now rejects composing a letter under a department the caller isn't a
  // member of, but the picker shouldn't offer departments submit would
  // always be rejected on. LETTER_READ_ALL holders (oversight roles) keep
  // the full list, same bypass the backend check itself uses.
  const { can } = usePermissions();
  const canAuthorAnywhere = can(PERMISSIONS.LETTER_READ_ALL);
  const { myDepartmentIds: myDeptIds, myOrgUnitIds } = useMyDepartments(!canAuthorAnywhere);
  const membershipFilteredDepts = useMemo(
    () => (canAuthorAnywhere ? (deptsData ?? []) : (deptsData ?? []).filter((d: any) => myDeptIds.has(d.id))),
    [canAuthorAnywhere, deptsData, myDeptIds],
  );

  // Same auto-lock treatment as Upload's org-unit/department fields: the org
  // unit picker used to offer every org unit in the tenant regardless of
  // authoring rights, which meant a non-privileged user could pick a unit
  // they have no department in and land on an empty, dead-end department
  // dropdown. Restrict it to the org units their own memberships actually
  // belong to (myOrgUnitIds, from the shared useMyDepartments resolver), and
  // auto-select-and-lock when that's exactly one.
  const selectableUnits = useMemo(() => {
    const all = unitsData?.data ?? [];
    return canAuthorAnywhere ? all : all.filter((u: any) => myOrgUnitIds.includes(u.id));
  }, [unitsData, canAuthorAnywhere, myOrgUnitIds]);
  useResetOnChange([myOrgUnitIds, form.orgUnitId, canAuthorAnywhere], () => {
    if (canAuthorAnywhere) return;
    if (form.orgUnitId) return;
    if (myOrgUnitIds.length !== 1) return;
    setForm((f) => ({ ...f, orgUnitId: myOrgUnitIds[0] }));
  });

  // A department belongs to exactly one org unit, and the backend rejects a
  // letter whose orgUnitId/departmentId pair don't match (validateUnitAndDepartment)
  // -- so once an org unit is picked, only offer departments that would
  // actually be accepted for it, rather than letting the form accept a
  // combination that's guaranteed to be rejected on submit.
  const selectableDepts = useMemo(
    () =>
      form.orgUnitId
        ? membershipFilteredDepts.filter((d: any) => d.orgUnitId === form.orgUnitId)
        : membershipFilteredDepts,
    [form.orgUnitId, membershipFilteredDepts],
  );
  // Same "nothing to actually pick" auto-lock as the department field gets
  // on Upload/Signing — this form previously only narrowed the list, never
  // auto-selected it.
  useResetOnChange([selectableDepts, form.departmentId], () => {
    if (form.departmentId) return;
    if (selectableDepts.length !== 1) return;
    setForm((f) => ({ ...f, departmentId: selectableDepts[0].id }));
  });

  // Live preview: renders the ACTUAL generated PDF (letterPdf.ts's
  // generateLetterSignableDraft, the same pipeline the real signable draft
  // uses at submit-for-signing time) against whatever has been typed so far
  // — rather than reimplementing its letterhead-safe-zone layout in HTML/CSS
  // — via POST /letters/preview-pdf. No letter is created; see
  // previewLetterPdf's own comment. Mirrors TemplateBuilderModal's identical
  // pattern for form templates.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const canPreview = Boolean(form.orgUnitId && form.departmentId);
  // Where the caret is (LetterBodyEditor's caretPosition()) and the latest
  // preview's per-block page map (previewLetterPdf's blockPages) — together
  // resolved into an exact page and fed to PdfBlobPreview, so the live
  // preview shows whichever page the author is actually typing on.
  const [caretPos, setCaretPos] = useState<CaretPosition | null>(null);
  const [blockPages, setBlockPages] = useState<number[]>([]);

  // Pure function of the inputs below, so adjusted during render rather than
  // set synchronously in the effect (react-hooks/set-state-in-effect); the
  // debounced render request itself stays an effect.
  useResetOnChange(
    [form.orgUnitId, form.departmentId, form.subject, form.bodyHtml, form.correspondent, form.correspondentOrganization, form.correspondentLocation],
    () => {
      setPreviewError(null);
      setPreviewLoading(canPreview);
    },
  );

  useEffect(() => {
    if (!canPreview) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { blob, blockPages: newBlockPages } = await previewLetterPdf({
          orgUnitId: form.orgUnitId,
          departmentId: form.departmentId,
          subject: form.subject || undefined,
          bodyHtml: form.bodyHtml || undefined,
          correspondent: form.correspondent || undefined,
          correspondentOrganization: form.correspondentOrganization || undefined,
          correspondentLocation: form.correspondentLocation || undefined,
        });
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setBlockPages(newBlockPages);
      } catch (e) {
        if (!cancelled) setPreviewError(describeApiError(e, 'Preview failed'));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.orgUnitId, form.departmentId, form.subject, form.bodyHtml, form.correspondent, form.correspondentOrganization, form.correspondentLocation]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const create = useMutation({
    mutationFn: () =>
      origin === 'COMPOSED'
        ? createLetter({
            orgUnitId: form.orgUnitId,
            departmentId: form.departmentId,
            subject: form.subject,
            bodyHtml: form.bodyHtml || undefined,
            letterType: form.letterType as 'OUT' | 'MEMO' | 'CIRC' | 'CONT',
            confidentiality: form.confidentiality,
            priority: form.priority,
            language: form.language,
            correspondent: form.correspondent || undefined,
            correspondentOrganization: form.correspondentOrganization || undefined,
            correspondentLocation: form.correspondentLocation || undefined,
            correspondentEmail: form.correspondentEmail || undefined,
          })
        : createScannedLetter(
            {
              orgUnitId: form.orgUnitId,
              departmentId: form.departmentId,
              subject: form.subject,
              letterType: form.letterType,
              confidentiality: form.confidentiality,
              priority: form.priority,
              language: form.language,
              correspondent: form.correspondent,
              correspondentOrganization: form.correspondentOrganization,
              correspondentLocation: form.correspondentLocation,
              correspondentEmail: form.correspondentEmail,
            },
            scan!,
          ),
    onSuccess: async (res) => {
      // WARN-UNSCANNED is fail-open (never blocking, same as the main document
      // upload path) — tally it across the primary file and every attachment
      // so a batch of several files doesn't hide one that wasn't scanned.
      let unscannedCount = res.data.warnings?.includes('WARN-UNSCANNED') ? 1 : 0;
      if (pendingAttachments.length > 0) {
        let failed = 0;
        for (const file of pendingAttachments) {
          try {
            const attRes = await addLetterAttachment(res.data.id, file);
            if (attRes.data.warnings?.includes('WARN-UNSCANNED')) unscannedCount += 1;
          } catch {
            failed += 1;
          }
        }
        if (failed > 0) toast.error(`Draft saved, but ${failed} attachment(s) failed to upload — add them from the letter page`);
        else toast.success('Draft saved with attachments');
      } else {
        toast.success('Draft saved');
      }
      if (unscannedCount > 0) {
        toast(
          `${unscannedCount === 1 ? 'One file' : `${unscannedCount} files`} could not be scanned for viruses — allowed through and flagged for review.`,
          {
            icon: '⚠️',
            duration: 8000,
            style: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' },
          },
        );
      }
      router.push(`/dashboard/letters/${res.data.id}`);
    },
    onError: (e: unknown) => setError(letterErrorMessage(e, 'Failed to create letter')),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.orgUnitId || !form.departmentId || !form.subject.trim()) {
      setError('Unit, department, and subject are required');
      return;
    }
    if (origin === 'SCANNED' && !scan) {
      setError('Attach the scanned or uploaded file');
      return;
    }
    create.mutate();
  };

  return (
    <RequirePermission permission={PERMISSIONS.LETTER_CREATE}>
      {/* Header stays put; the form and its preview each get their own
          independent scroll below (same flex-1/min-h-0/overflow-y-auto
          pattern the rest of this app uses for a scrollable pane) — a
          page-level scroll plus a `sticky` preview used to mean that once
          the form scrolled far enough to reach the Body field, the preview
          had already scrolled itself up out of alignment with it. Keeping
          both panes' scroll confined to a fixed-height row instead means
          they always stay side by side, regardless of how far down the form
          the author has scrolled. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-4 pt-6 sm:px-6 shrink-0 mx-auto max-w-[1400px] w-full">
          <Link href="/dashboard/letters" className="inline-flex items-center gap-1.5 text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back to correspondence
          </Link>
          <PageHeader
            title="New outgoing letter"
            subtitle="Drafts have no reference number — it is generated automatically at final approval"
          />

          <div className="mt-4 inline-flex rounded-md border p-1" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              onClick={() => setOrigin('COMPOSED')}
              className="rounded px-3 py-1.5 text-[13px] font-medium"
              style={origin === 'COMPOSED' ? { background: 'var(--brand-600)', color: '#fff' } : { color: 'var(--text-muted)' }}
            >
              Compose in system
            </button>
            <button
              type="button"
              onClick={() => setOrigin('SCANNED')}
              className="rounded px-3 py-1.5 text-[13px] font-medium"
              style={origin === 'SCANNED' ? { background: 'var(--brand-600)', color: '#fff' } : { color: 'var(--text-muted)' }}
            >
              Upload scanned / signed letter
            </button>
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
          )}
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px] items-stretch mt-4 px-4 pb-6 sm:px-6 mx-auto max-w-[1400px] w-full">
          <form onSubmit={submit} className="ui-card space-y-4 min-h-0 overflow-y-auto ui-scrollbar">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Organizational unit *</span>
                <select
                  value={form.orgUnitId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm((f) => {
                      const deptStillValid = !f.departmentId || membershipFilteredDepts.find((d: any) => d.id === f.departmentId)?.orgUnitId === value;
                      return { ...f, orgUnitId: value, departmentId: deptStillValid ? f.departmentId : '' };
                    });
                  }}
                  disabled={!canAuthorAnywhere && selectableUnits.length <= 1}
                  className="ui-input mt-1 w-full disabled:opacity-75"
                >
                  <option value="">Select unit…</option>
                  {selectableUnits.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.code} — {u.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Department *</span>
                <select
                  value={form.departmentId}
                  onChange={set('departmentId')}
                  disabled={selectableDepts.length === 1}
                  className="ui-input mt-1 w-full disabled:opacity-75"
                >
                  <option value="">Select department…</option>
                  {selectableDepts.map((d: any) => (
                    <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Letter type</span>
                <select value={form.letterType} onChange={set('letterType')} className="ui-input mt-1 w-full">
                  <option value="OUT">Outgoing (OUT)</option>
                  <option value="MEMO">Memo (MEMO)</option>
                  <option value="CIRC">Circular (CIRC)</option>
                  <option value="CONT">Contract-related (CONT)</option>
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
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Priority</span>
                <select value={form.priority} onChange={set('priority')} className="ui-input mt-1 w-full">
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Language</span>
                <select value={form.language} onChange={set('language')} className="ui-input mt-1 w-full">
                  <option value="en">English</option>
                  <option value="am">Amharic</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Recipient (person)</span>
                <input value={form.correspondent} onChange={set('correspondent')} className="ui-input mt-1 w-full" placeholder="e.g. Ato Bekele Alemu" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Recipient organization</span>
                <input value={form.correspondentOrganization} onChange={set('correspondentOrganization')} className="ui-input mt-1 w-full" placeholder="e.g. Ministry of Trade" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Recipient location</span>
                <input value={form.correspondentLocation} onChange={set('correspondentLocation')} className="ui-input mt-1 w-full" placeholder="e.g. Example City, Exampleland" />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Recipient email</span>
                <input type="email" value={form.correspondentEmail} onChange={set('correspondentEmail')} className="ui-input mt-1 w-full" placeholder="e.g. recipient@ministry.gov.et" />
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Optional — lets you email the finished letter directly on dispatch. Leave blank to only dispatch on paper.
                </p>
              </label>
            </div>

            <label className="block">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Subject *</span>
              <input value={form.subject} onChange={set('subject')} className="ui-input mt-1 w-full" maxLength={500} placeholder="Letter subject" />
            </label>

            {origin === 'COMPOSED' ? (
              <>
                <div className="block">
                  <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Body</span>
                  <div className="mt-1">
                    <LetterBodyEditor
                      content={form.bodyHtml}
                      onChange={(json) => setForm((f) => ({ ...f, bodyHtml: json }))}
                      onCaretPositionChange={setCaretPos}
                    />
                  </div>
                </div>

                <div>
                  <label className="ui-btn ui-btn-secondary !py-1.5 !px-3 text-[12px] cursor-pointer inline-flex">
                    <Paperclip className="h-3.5 w-3.5" /> Attach files
                    <input
                      type="file"
                      multiple
                      accept="application/pdf,image/*,.doc,.docx"
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) setPendingAttachments((prev) => [...prev, ...files]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {pendingAttachments.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {pendingAttachments.map((f, i) => (
                        <li
                          key={`${f.name}-${i}`}
                          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          <Paperclip className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{f.name}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                          <button
                            type="button"
                            onClick={() => setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                            className="p-0.5 rounded hover:bg-red-50"
                          >
                            <X className="h-3.5 w-3.5 text-red-500" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <label className="block">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Scanned or signed letter (PDF, Word, or image) *</span>
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
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  A QR verification cover sheet is generated automatically at approval, since a QR code can&apos;t be stamped onto an uploaded file the way it is on a system-composed letter.
                </p>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <Link href="/dashboard/letters" className="ui-btn ui-btn-secondary">Cancel</Link>
              <button type="submit" disabled={create.isPending} className="ui-btn ui-btn-primary">
                <Send className="h-4 w-4" />
                {create.isPending ? 'Saving…' : 'Save draft'}
              </button>
            </div>
          </form>

          <aside className="ui-card flex flex-col min-h-0 h-full">
            <div className="flex items-center gap-2 pb-2 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <Eye className="h-4 w-4" style={{ color: 'var(--brand-600)' }} />
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Live preview</span>
              {previewLoading && <RefreshCw className="h-3.5 w-3.5 animate-spin ml-auto" style={{ color: 'var(--text-muted)' }} />}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar pt-3">
              {!canPreview ? (
                <p className="text-[12px] text-center py-10 px-2" style={{ color: 'var(--text-muted)' }}>
                  Pick a unit and department to preview how this letter will look.
                </p>
              ) : previewError ? (
                <p className="text-[12px] text-center py-10 px-2" style={{ color: 'var(--danger, #dc2626)' }}>
                  Couldn&apos;t render a preview: {previewError}
                </p>
              ) : previewUrl ? (
                <PdfBlobPreview
                  blobUrl={previewUrl}
                  maxWidth={380}
                  keepPageOnReload
                  exactPage={caretPos ? blockPages[caretPos.blockIndex] ?? null : null}
                  caretRatio={caretPos?.ratio ?? null}
                />
              ) : (
                <div className="h-48 flex items-center justify-center">
                  <RefreshCw className="h-5 w-5 animate-spin" style={{ color: 'var(--brand-600)' }} />
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </RequirePermission>
  );
}
