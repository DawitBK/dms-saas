'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import { AlertCircle, AlertTriangle, CheckCircle2, Layers, Loader2, UploadCloud, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useCreateDocument,
  useDepartments,
} from '../../../features/documents/hooks';
import { useOrgUnits } from '../../../shared/hooks/useLookups';
import { apiClient } from '../../../shared/lib/apiClient';
import { TopBar } from '../../../shared/components/TopBar';
import { useUIStore } from '../../../state/ui.store';
import { useAuthStore } from '../../../state/auth.store';
import { cn } from '../../../shared/lib/cn';
import type { CreateDocumentInput, CreateDocumentResponse } from '../../../features/documents/types';
import { RequirePermission } from '../../../shared/components/RequirePermission';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { CreateBundleModal } from '../../../features/bundles/CreateBundleModal';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';
import { useMyDepartments } from '../../../shared/hooks/useMyDepartments';
import { WHO_CAN_OPEN } from '../../../features/documents/ClassificationControl';
import { CLASSIFICATIONS, CLASSIFICATION_LABEL, type Classification } from '../../../shared/lib/classification';

type FolderNode = {
  id: string;
  name: string;
  path: string;
  level: number;
  parentId: string | null;
};

const STEPS = ['Select File', 'Add Metadata', 'Review & Submit'];

function UploadPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { userId } = useAuthStore();
  const { mutateAsync: createDocAsync, isPending } = useCreateDocument();
  const { data: departmentsRaw } = useDepartments();
  // Defensive: always treat departments as an array even if the shared
  // ['departments'] cache is ever populated with an envelope shape by another
  // page — a blank select here is what made uploads say "select a department".
  //
  // Memoised because the `?? []` branch produced a fresh array on every render,
  // which propagated into selectableDepartments below and from there into a
  // render-time change key, where an always-changing value is an infinite
  // render loop rather than merely wasted work.
  const departments = useMemo(
    () =>
      Array.isArray(departmentsRaw)
        ? departmentsRaw
        : ((departmentsRaw as { data?: any[] } | undefined)?.data ?? []),
    [departmentsRaw],
  );

  // FIX: this dropdown used to list every department in the tenant — IT
  // staff could pick Executive, Finance, anywhere, and the click "worked"
  // right up until the backend's ensureCanCreate rejected the submit at the
  // very last step of a 3-step wizard (or, before that fix existed, didn't
  // reject it at all). GET /departments itself intentionally stays
  // unfiltered (it's the shared navigational picker used by Browse, the ACL
  // admin panel, etc. — see departments.routes.ts's own comment on why), so
  // the restriction belongs here, at the one place that's actually about to
  // FILE something into a department rather than just browse/reference one.
  // /users/me already returns the caller's own department memberships (used
  // by ProfileSettingsPanel); reused here rather than adding a new endpoint.
  const { can } = usePermissions();
  const canUploadAnywhere = can(PERMISSIONS.ACL_BYPASS_ADMIN); // mirrors ensureCanCreate's own override
  const { meRes, myDepartmentIds, myOrgUnitIds } = useMyDepartments(!canUploadAnywhere);
  // Memoised. `.filter()` built a brand-new array on every render, so this was
  // a dependency that never compared equal — harmless-looking churn while it
  // only fed a useEffect, but it is used below as a change key for a
  // render-time adjustment, where an always-changing key is an infinite render
  // loop. `departments` comes from react-query and is already stable per fetch.
  const selectableDepartments = useMemo(() => {
    if (canUploadAnywhere) return departments;
    return departments.filter((d: any) => myDepartmentIds.has(d.id));
  }, [canUploadAnywhere, departments, myDepartmentIds]);

  const { data: orgUnits } = useOrgUnits();
  const orgUnitNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of orgUnits ?? []) map.set(u.id, u.name);
    return map;
  }, [orgUnits]);

  // Org Unit filter: sysadmins (canUploadAnywhere) get a free-choice dropdown
  // of every org unit in the tenant. Everyone else is auto-located to the org
  // unit(s) their own department memberships belong to (via
  // Department.orgUnitId — users have no direct orgUnitId column) and, when
  // that resolves to exactly one, the field auto-fills and locks — the same
  // "nothing to pick" treatment departmentCode already got below. A user
  // spanning >1 org unit gets a dropdown restricted to just those, not the
  // full tenant list. (myOrgUnitIds comes from useMyDepartments — the shared
  // resolver every membership-scoped picker in the app now uses.)
  const [orgUnitId, setOrgUnitId] = useState('');
  const selectableOrgUnits = useMemo(() => {
    const all = orgUnits ?? [];
    const list = canUploadAnywhere ? all : all.filter((u) => myOrgUnitIds.includes(u.id));
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [orgUnits, canUploadAnywhere, myOrgUnitIds]);

  useResetOnChange([myOrgUnitIds, orgUnitId, canUploadAnywhere], () => {
    if (canUploadAnywhere) return;
    if (orgUnitId) return;
    if (myOrgUnitIds.length !== 1) return;
    setOrgUnitId(myOrgUnitIds[0]);
  });

  // Department picker narrows to the selected org unit once one is known
  // (locked or admin-picked) — otherwise every membership-eligible department
  // across all the user's org units is offered, same as before.
  const departmentsForPicker = useMemo(() => {
    if (!orgUnitId) return selectableDepartments;
    return selectableDepartments.filter((d: any) => d.orgUnitId === orgUnitId);
  }, [selectableDepartments, orgUnitId]);
  const selectableDepartmentGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const d of departmentsForPicker) {
      const label = (d.orgUnitId && orgUnitNameById.get(d.orgUnitId)) || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(d);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [departmentsForPicker, orgUnitNameById]);
  // FIX 2026-09-14: two departments can legitimately share a name across
  // different org units (reproduced live: two "Information Technology"
  // departments in one tenant) — the optgroup label disambiguates them only
  // while the dropdown is open; a collapsed select shows just the option
  // text, so the wrong pick was indistinguishable from the right one once
  // selected. Only actually-ambiguous names get the org unit suffixed onto
  // the option itself.
  const departmentNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of departmentsForPicker) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    return counts;
  }, [departmentsForPicker]);
  const departmentOptionLabel = (d: any, orgUnitName: string) =>
    (departmentNameCounts.get(d.name) ?? 0) > 1 ? `${d.name} (${orgUnitName})` : d.name;

  const [step, setStep] = useState(1);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<
    { name: string; status: 'pending' | 'uploading' | 'success' | 'warning' | 'error'; error?: string }[]
  >([]);
  const [isBatchUploading, setIsBatchUploading] = useState(false);
  // Post-upload "bundle these together" CTA: only offered once every file in
  // a multi-file batch finished uploading — a single-file batch has nothing
  // to bundle with itself yet (still possible later via the Files page bulk
  // action). Holding off the auto-navigate-to-dashboard on that path is what
  // makes the CTA visible at all.
  const [uploadedDocIds, setUploadedDocIds] = useState<string[]>([]);
  const [showBundleCta, setShowBundleCta] = useState(false);
  const [showBundleModal, setShowBundleModal] = useState(false);
  // The two dates are read inside the lazy initialiser, not at the top of the
  // component body. `new Date()` and `Date.now()` are impure, and calling them
  // during render is a react-hooks/purity error under eslint-config-next 16 —
  // rightly so: they were re-evaluated on every re-render even though only the
  // very first value was ever used. A lazy initialiser runs exactly once,
  // which is what was meant all along.
  const [formData, setFormData] = useState<Partial<CreateDocumentInput>>(() => {
    const todayISO = new Date().toISOString().slice(0, 10);
    const retentionDate = new Date(Date.now() + 5 * 365 * 86400000).toISOString().slice(0, 10);
    return {
      securityClassification: 'INTERNAL',
      source: 'MANUAL_UPLOAD',
      retentionClass: 'RET-CORP-5Y',
      ownerId: userId ?? '',
      organisationUnit: '',
      documentDate: todayISO,
      retentionTriggerDate: retentionDate,
      keywords: '',
      description: '',
      language: 'en',
      originatingSystem: 'DMS',
      confidentialityNotice: 'Internal',
      geographicScope: 'Exampleland',
      externalReference: '',
      folderPath: '',
    };
  });

  // Keep the submitted organisationUnit free-text field (Document.organisationUnit
  // is a display string, not an FK) in sync with whichever org unit is selected.
  useResetOnChange([orgUnitId, orgUnits], () => {
    if (!orgUnitId) return;
    const match = (orgUnits ?? []).find((u) => u.id === orgUnitId);
    if (match) setFormData((prev) => ({ ...prev, organisationUnit: match.name }));
  });

  // Cascade: if the org unit changes out from under the currently-selected
  // department (only reachable via the sysadmin dropdown — locked/auto users
  // never change it after the fact), the department (and its dependents) no
  // longer apply.
  useResetOnChange([orgUnitId], () => {
    setFormData((prev) => {
      if (!prev.departmentId) return prev;
      const dept = departments.find((d: any) => d.id === prev.departmentId);
      if (dept && orgUnitId && dept.orgUnitId !== orgUnitId) {
        return { ...prev, departmentId: '', documentTypeCode: '', folderPath: '' };
      }
      return prev;
    });
  });

  // "Upload Here" (Browse page, inside a specific category folder) links
  // here with ?departmentId=&folderPath= so this form starts pre-scoped to
  // that folder instead of making the user pick department + folder again
  // from scratch. Runs once departments has loaded and only if the user
  // hasn't already picked a department themselves.
  // State, not a ref: a "have we already prefilled" flag is now read during
  // render, and reading or writing a ref during render is a react-hooks/refs
  // error. It behaves identically — it is only ever set once, and never read
  // by anything that renders from it.
  const [prefilledFromFolder, setPrefilledFromFolder] = useState(false);
  const departmentIdParam = searchParams.get('departmentId');
  // `searchParams.toString()` rather than the object: a change key compared by
  // identity has to be something whose identity actually tracks its value, and
  // a primitive is the safest form of that.
  useResetOnChange([selectableDepartments, formData.departmentId, searchParams.toString()], () => {
    if (prefilledFromFolder) return;
    if (formData.departmentId) return;
    if (!departmentIdParam || selectableDepartments.length === 0) return;
    // Restricted to selectableDepartments, not the full list — a stale/
    // crafted ?departmentId= for a department the user can't upload into
    // shouldn't silently prefill it; falls through to the single-department
    // auto-prefill (or a blank field) below instead.
    const dept = selectableDepartments.find((d: any) => d.id === departmentIdParam);
    if (!dept) return;
    setPrefilledFromFolder(true);
    // Follow the linked department's own org unit rather than leaving
    // whatever auto-lock/admin-selection already picked — a multi-org-unit
    // user landing here via "Upload Here" should see the matching org unit,
    // not a mismatched one left over from the default auto-lock attempt.
    if (dept.orgUnitId) setOrgUnitId(dept.orgUnitId);
    const folderPathParam = searchParams.get('folderPath');
    setFormData((prev) => ({
      ...prev,
      departmentId: dept.id,
      ...(folderPathParam ? { folderPath: folderPathParam } : {}),
    }));
  });

  // Auto-prefill (and, since there's nothing else to pick, effectively lock)
  // the department for the common case: a user who belongs to exactly one
  // department (within the resolved org unit) shouldn't have to pick it at all.
  useResetOnChange([departmentsForPicker, formData.departmentId], () => {
    if (formData.departmentId) return;
    if (departmentsForPicker.length !== 1) return;
    setFormData((prev) => ({ ...prev, departmentId: departmentsForPicker[0].id }));
  });

  // Fetch department-filtered document types (must come after formData is declared).
  // formData.departmentId IS the department's id -- unlike departmentCode
  // (only unique per org unit as of the 20260912000001 migration, so two
  // departments can share a code), resolving "which department" by id here
  // needs no lookup and can never pick the wrong same-coded department the
  // way a `departments.find(d => d.code === ...)` lookup silently could.
  const departmentId = formData.departmentId;
  const { data: filteredDocTypes } = useQuery({
    queryKey: ['filtered-doc-types', departmentId],
    queryFn: () => apiClient<{ data: any[] }>(`/document-types/for-department${departmentId ? `?departmentId=${departmentId}` : ''}`),
    enabled: !!formData.departmentId,
    staleTime: 60_000,
  });

  // FIX: fallback list shown before a department is picked (or while the
  // caller has more than one and hasn't chosen yet) used to be the shared,
  // unfiltered useDocumentTypes() hook — every document type in the tenant,
  // including ones scoped to departments this user has nothing to do with.
  // The backend now rejects an out-of-scope type at submit time regardless
  // (documents.service.ts's createDocument), but the dropdown shouldn't offer
  // it in the first place. A dedicated query (not the shared hook, which
  // Search/Reports/Signing/etc. still rely on for the full list) keeps this
  // fix local to Upload; `?scope=mine` is global types ∪ types scoped to any
  // department this user belongs to.
  const { data: myDocTypes } = useQuery({
    queryKey: ['document-types', 'mine'],
    queryFn: () => apiClient<{ data: any[] }>('/document-types?scope=mine'),
    enabled: !formData.departmentId,
    staleTime: 30_000,
  });

  // Department-scoped folder picker: the department IS a bound FolderNode, so
  // its category folders are just that folder's children — not a hardcoded
  // "/Example Corp/{name}" path prefix at a fixed tree depth, which only ever
  // matched folders created by the original seed script and silently hid any
  // folder a user created under a department themselves.
  const { data: departmentFolderData } = useQuery({
    queryKey: ['department-folder', departmentId],
    queryFn: () => apiClient<{ data: { folder: FolderNode; subfolders: FolderNode[] } }>(`/folders/department/${departmentId}`),
    enabled: !!departmentId,
    staleTime: 30_000,
  });

  // Use filtered types if department is selected, otherwise use all types.
  // Memoised: an unmemoised `?? []` fallback is a fresh array every render,
  // which is exactly the "always-changing dependency" trap this file's other
  // useResetOnChange calls are written around — this one feeds the auto-lock
  // effect below.
  const availableDocTypes: any[] = useMemo(() => {
    if (formData.departmentId) return ((filteredDocTypes as any)?.data ?? filteredDocTypes ?? []) as any[];
    return ((myDocTypes as any)?.data ?? myDocTypes ?? []) as any[];
  }, [formData.departmentId, filteredDocTypes, myDocTypes]);

  // Same auto-lock treatment as the department field: when exactly one
  // document type applies (usually because the department only has one
  // department-specific type, or none and just one global type), there's
  // nothing to actually choose.
  useResetOnChange([availableDocTypes, formData.documentTypeCode], () => {
    if (formData.documentTypeCode) return;
    if (availableDocTypes.length !== 1) return;
    setFormData((prev) => ({ ...prev, documentTypeCode: availableDocTypes[0].code }));
  });

  const { getRootProps, getInputProps, isDragActive, isDragReject } =
    useDropzone({
      accept: {
        'application/pdf': ['.pdf'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          ['.docx'],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
          '.xlsx',
        ],
        'image/png': ['.png'],
        'image/jpeg': ['.jpg', '.jpeg'],
      },
      maxSize: 500 * 1024 * 1024,
      multiple: true,
      onDrop: (accepted) => {
        if (accepted.length === 0) return;
        // Appends rather than replaces — dropping a second batch of files used
        // to silently discard the first selection.
        setFiles((prev) => [...prev, ...accepted]);
      },
    });

  // Document Title only makes sense as a single field when there's exactly one
  // file; auto-fill it from that file's name the way single-file upload always
  // did. With multiple files each document is titled from its own filename
  // instead (see handleSubmit).
  useResetOnChange([files], () => {
    if (files.length === 1 && !formData.title) {
      setFormData((prev) => ({ ...prev, title: files[0].name.replace(/\.[^.]+$/, '') }));
    }
  });

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleInputChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  // WARN-DUPLICATE-DETECTED is never blocking (documents.service.ts's
  // createDocument always proceeds and returns 201), so this is purely a
  // visibility fix: a distinct amber warning toast naming which document it
  // duplicates, with a link to jump to the original. Uses toast()'s default
  // ('blank') type with amber-styled overrides rather than toast.success /
  // toast.error, so it reads as neither a success nor a failure.
  const showDuplicateToast = (fileName: string, res: CreateDocumentResponse) => {
    const dupTitle = res.duplicateOfTitle || res.duplicateOfDocumentName || 'an existing document';
    toast(
      (t) => (
        <span className="text-sm leading-snug">
          <strong>&quot;{fileName}&quot;</strong> looks identical to an existing document
          (&quot;{dupTitle}&quot;). It was still uploaded — review both if this wasn&apos;t intentional.
          {res.duplicateOf && (
            <>
              {' '}
              <a
                href={`/dashboard/documents/${res.duplicateOf}`}
                onClick={(e) => {
                  e.preventDefault();
                  toast.dismiss(t.id);
                  router.push(`/dashboard/documents/${res.duplicateOf}`);
                }}
                className="font-semibold underline whitespace-nowrap"
              >
                View original &rarr;
              </a>
            </>
          )}
        </span>
      ),
      {
        icon: '⚠️',
        duration: 10000,
        style: {
          background: '#fffbeb',
          color: '#92400e',
          border: '1px solid #fde68a',
          maxWidth: '440px',
        },
      },
    );
  };

  // WARN-UNSCANNED is also fail-open (the antivirus scan didn't complete, but
  // the upload is never blocked on it — see backend documents.service.ts).
  // Same amber-toast treatment as the duplicate warning above, so a file that
  // slipped through unscanned doesn't look identical to a normally-cleared one.
  const showUnscannedToast = (fileName: string) => {
    toast(
      <span className="text-sm leading-snug">
        <strong>&quot;{fileName}&quot;</strong> could not be scanned for viruses (scanner unavailable). It was
        still uploaded — review it before relying on it.
      </span>,
      {
        icon: '⚠️',
        duration: 10000,
        style: {
          background: '#fffbeb',
          color: '#92400e',
          border: '1px solid #fde68a',
          maxWidth: '440px',
        },
      },
    );
  };

  const handleSubmit = async (openBundleAfterUpload = false) => {
    setSubmitError(null);
    if (files.length === 0) { setSubmitError('Please select at least one file.'); return; }
    if (files.length === 1 && !formData.title) { setSubmitError('Document title is required.'); return; }
    if (!formData.departmentId) { setSubmitError('Please select a department.'); return; }
    if (!formData.organisationUnit) { setSubmitError('Please select an org unit.'); return; }
    if (!formData.documentTypeCode) { setSubmitError('Please select a document type.'); return; }
    if (!formData.retentionTriggerDate) { setSubmitError('Retention trigger date is required.'); return; }

    setIsBatchUploading(true);
    setUploadProgress(files.map((f) => ({ name: f.name, status: 'pending' })));
    setShowBundleCta(false);
    setUploadedDocIds([]);

    let successCount = 0;
    const newDocIds: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const uploadFile = files[i];
      // Each file becomes its own document: with a single file the manually
      // edited Document Title wins, otherwise every document is titled from
      // its own filename and gets its own externalReference so a batch of N
      // files doesn't collide on one shared value.
      const title = files.length === 1 ? (formData.title as string) : uploadFile.name.replace(/\.[^.]+$/, '');
      const externalReference = formData.externalReference
        ? (files.length === 1 ? formData.externalReference : `${formData.externalReference}-${i + 1}`)
        : `DMS-${Date.now()}-${i}`;
      const payload: CreateDocumentInput = {
        ...formData,
        title,
        ownerId: userId ?? '',
        externalReference,
      } as CreateDocumentInput;

      setUploadProgress((prev) => prev.map((p, idx) => (idx === i ? { ...p, status: 'uploading' } : p)));
      try {
        const res = await createDocAsync({ input: payload, file: uploadFile });
        successCount += 1;
        newDocIds.push(res.id);
        const isUnscanned = res.warnings?.includes('WARN-UNSCANNED');
        setUploadProgress((prev) =>
          prev.map((p, idx) => (idx === i ? { ...p, status: isUnscanned ? 'warning' : 'success' } : p)),
        );
        if (res.warnings?.includes('WARN-DUPLICATE-DETECTED')) {
          showDuplicateToast(uploadFile.name, res);
        }
        if (isUnscanned) {
          showUnscannedToast(uploadFile.name);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setUploadProgress((prev) => prev.map((p, idx) => (idx === i ? { ...p, status: 'error', error: msg } : p)));
      }
    }

    setIsBatchUploading(false);
    if (successCount > 1) {
      setUploadedDocIds(newDocIds);
      setShowBundleCta(true);
      if (openBundleAfterUpload) setShowBundleModal(true);
      if (successCount < files.length) {
        const msg = `${successCount} of ${files.length} file(s) uploaded successfully. Check the list below for failures.`;
        setSubmitError(msg);
        toast.error(msg);
      }
    } else if (successCount === files.length) {
      router.push('/dashboard');
    } else {
      const msg = `${successCount} of ${files.length} file(s) uploaded successfully. Check the list below for failures.`;
      setSubmitError(msg);
      toast.error(msg);
    }
  };

  const categoryFolders = (departmentFolderData?.data.subfolders ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  return (
    <RequirePermission permission={PERMISSIONS.DOCUMENT_UPLOAD}>
      <TopBar
        title="Upload Document"
        breadcrumbs={[
          { label: 'Repository', href: '/dashboard' },
          { label: 'Upload' },
        ]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-4xl mx-auto w-full">
          <div className="ui-hero mb-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-brand-600/10 rounded-xl">
                <UploadCloud className="h-7 w-7 text-brand-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-text-primary">
                  Upload Document
                </h1>
                <p className="text-text-muted text-sm mt-0.5">
                  Upload a new document to the repository. All files are scanned
                  and classified automatically.
                </p>
              </div>
            </div>
          </div>

          {/* Step indicator */}
          <div className="flex items-center mb-8">
            {STEPS.map((label, idx) => {
              const s = idx + 1;
              const done = step > s;
              const active = step === s;
              return (
                <div key={s} className="flex items-center">
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold transition-all',
                        done
                          ? 'bg-brand-600 text-white'
                          : active
                            ? 'bg-brand-600 text-white ring-4 ring-brand-600/20'
                            : 'bg-surface-raised text-text-muted border border-border',
                      )}
                    >
                      {done ? <CheckCircle2 className="h-4 w-4" /> : s}
                    </div>
                    <span
                      className={cn(
                        'text-xs font-semibold hidden sm:block',
                        active ? 'text-brand-600' : 'text-text-muted',
                      )}
                    >
                      {label}
                    </span>
                  </div>
                  {s < STEPS.length && (
                    <div
                      className={cn(
                        'h-0.5 w-12 sm:w-20 mx-2 mb-5',
                        done ? 'bg-brand-600' : 'bg-border',
                      )}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="ui-card bg-surface-card shadow-sm ring-1 ring-slate-900/5 rounded-xl p-6 sm:p-8">
            {step === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">
                    Step 1: Select Files
                  </h2>
                  <p className="text-sm text-text-muted">
                    Choose one or more documents to upload. Max 500 MB each.
                  </p>
                </div>

                <div
                  {...getRootProps()}
                  className={cn(
                    'flex flex-col items-center justify-center w-full h-64 rounded-2xl border-2 border-dashed cursor-pointer transition-all',
                    isDragActive &&
                      !isDragReject &&
                      'border-brand-500 bg-brand-50 scale-[1.01]',
                    isDragReject && 'border-red-400 bg-danger-bg',
                    !isDragActive &&
                      'border-border bg-surface-raised hover:border-brand-500 hover:bg-surface-raised/80',
                  )}
                >
                  <input {...getInputProps()} />
                  <UploadCloud
                    className={cn(
                      'h-10 w-10 mb-3',
                      isDragReject ? 'text-danger' : 'text-text-muted',
                    )}
                  />
                  {isDragReject ? (
                    <p className="text-sm font-semibold text-danger">
                      File type not accepted
                    </p>
                  ) : isDragActive ? (
                    <p className="text-sm font-semibold text-brand-600">
                      Drop it here!
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-text-secondary">
                        Drop files here, or{' '}
                        <span className="text-brand-600">click to browse</span>
                      </p>
                      <p className="text-xs text-text-muted mt-1">
                        PDF, DOCX, XLSX, PNG, JPG — max 500 MB each, multiple files supported
                      </p>
                    </>
                  )}
                </div>

                {files.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                      {files.length} file{files.length > 1 ? 's' : ''} selected
                    </p>
                    {files.map((f, idx) => (
                      <div
                        key={`${f.name}-${idx}`}
                        className="flex items-center p-4 bg-indigo-50 rounded-lg border border-indigo-100"
                      >
                        <svg
                          className="h-6 w-6 text-indigo-600 mr-3 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-indigo-900 truncate">
                            {f.name}
                          </p>
                          <p className="text-xs text-indigo-700">
                            {(f.size / (1024 * 1024)).toFixed(2)} MB
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFile(idx)}
                          className="p-1.5 text-indigo-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
                          title="Remove"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    disabled={files.length === 0}
                    onClick={() => setStep(2)}
                    className="ui-btn ui-btn-primary"
                  >
                    Next Step
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">
                    Step 2: Metadata
                  </h2>
                  <p className="text-sm text-text-muted">
                    Provide essential details about the document.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                  {files.length === 1 ? (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-text-secondary">
                        Document Title
                      </label>
                      <input
                        type="text"
                        name="title"
                        value={formData.title || ''}
                        onChange={handleInputChange}
                        className="ui-input mt-1"
                      />
                    </div>
                  ) : (
                    <div className="sm:col-span-2 text-xs text-text-muted bg-surface-raised border border-border rounded-lg px-3 py-2">
                      Uploading {files.length} files — each document will be titled from its own file name.
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Org Unit
                    </label>
                    <select
                      value={orgUnitId}
                      onChange={(e) => setOrgUnitId(e.target.value)}
                      disabled={!canUploadAnywhere && selectableOrgUnits.length <= 1}
                      className="ui-input mt-1 disabled:opacity-75"
                    >
                      <option value="">{canUploadAnywhere ? 'All org units' : 'Select org unit'}</option>
                      {selectableOrgUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                    {!canUploadAnywhere && meRes && selectableOrgUnits.length === 0 && (
                      <p className="mt-1 text-xs text-red-600">
                        You aren&apos;t a member of any department, so there&apos;s no org unit to resolve. Ask an admin to add you to one.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Department
                    </label>
                    <select
                      name="departmentId"
                      value={formData.departmentId || ''}
                      onChange={(e) => {
                        // Phase 3: Task 3.8 - Reset document type when department changes (cascading)
                        handleInputChange(e);
                        setFormData((prev) => ({ ...prev, documentTypeCode: '', folderPath: '' }));
                        // A department belongs to exactly one org unit. Keep
                        // the display value submitted to the backend aligned
                        // with that relationship even when an administrator
                        // starts from the deliberately broad “All org units”
                        // picker. Without this, a valid department choice
                        // produced an empty required organisationUnit field at
                        // upload time.
                        const selectedDepartment = departments.find((d: any) => d.id === e.target.value);
                        if (selectedDepartment?.orgUnitId) setOrgUnitId(selectedDepartment.orgUnitId);
                      }}
                      disabled={departmentsForPicker.length === 1}
                      className="ui-input mt-1 disabled:opacity-75"
                    >
                      <option value="">Select Department</option>
                      {selectableDepartmentGroups.length > 1
                        ? selectableDepartmentGroups.map(([orgUnitName, depts]) => (
                            <optgroup key={orgUnitName} label={orgUnitName}>
                              {depts.map((d: any) => (
                                <option key={d.id} value={d.id}>
                                  {departmentOptionLabel(d, orgUnitName)}
                                </option>
                              ))}
                            </optgroup>
                          ))
                        : departmentsForPicker.map((d: any) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                    </select>
                    {!canUploadAnywhere && meRes && departmentsForPicker.length === 0 && (
                      <p className="mt-1 text-xs text-red-600">
                        {selectableDepartments.length === 0
                          ? "You aren't a member of any department, so there's nowhere to file a document. Ask an admin to add you to one."
                          : "You aren't a member of any department in this org unit."}
                      </p>
                    )}
                    {/* "Upload Here" from Browse links with ?departmentId= for the folder's
                        bound department. The prefill effect above deliberately only honors it
                        when that department is in selectableDepartments (membership-scoped) —
                        this explains a blank field instead of leaving the user to wonder why a
                        linked department silently didn't fill in. */}
                    {!canUploadAnywhere &&
                      meRes &&
                      !formData.departmentId &&
                      departmentIdParam &&
                      !selectableDepartments.some((d: any) => d.id === departmentIdParam) &&
                      (() => {
                        const linked = departments.find((d: any) => d.id === departmentIdParam);
                        return linked ? (
                          <p className="mt-1 text-xs text-amber-600">
                            The department linked from Browse (&quot;{linked.name}&quot;) wasn&apos;t pre-filled because you
                            aren&apos;t a member of it — pick one you belong to below, or ask an admin to add you to it.
                          </p>
                        ) : null;
                      })()}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Document Type
                    </label>
                    <select
                      name="documentTypeCode"
                      value={formData.documentTypeCode || ''}
                      onChange={handleInputChange}
                      disabled={!formData.departmentId || availableDocTypes.length === 1}
                      className="ui-input mt-1 disabled:opacity-50"
                    >
                      <option value="">
                        {formData.departmentId ? 'Select Type' : 'Pick a department first'}
                      </option>
                      {availableDocTypes.map((t) => (
                        <option key={t.id} value={t.code}>
                          {t.name} {t.departmentId ? '(Dept-specific)' : '(Global)'}
                        </option>
                      ))}
                    </select>
                    {formData.departmentId && availableDocTypes.length === 0 && (
                      <p className="mt-1 text-xs text-amber-600">
                        No document types available for this department.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Security Classification
                    </label>
                    <select
                      name="securityClassification"
                      value={formData.securityClassification}
                      onChange={handleInputChange}
                      className="ui-input mt-1"
                    >
                      {CLASSIFICATIONS.map((c) => (
                        <option key={c} value={c}>
                          {CLASSIFICATION_LABEL[c]}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-text-muted" data-testid="upload-classification-help">
                      {WHO_CAN_OPEN[(formData.securityClassification as Classification) ?? 'INTERNAL']}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-text-secondary">
                      Description <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      name="description"
                      value={formData.description || ''}
                      onChange={handleInputChange}
                      rows={3}
                      placeholder="Brief description of the document"
                      className="ui-input mt-1"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-text-secondary">
                      Keywords <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      name="keywords"
                      value={formData.keywords || ''}
                      onChange={handleInputChange}
                      placeholder="e.g. finance, report, 2025 (comma-separated)"
                      className="ui-input mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Document Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      name="documentDate"
                      value={formData.documentDate || ''}
                      onChange={handleInputChange}
                      className="ui-input mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Retention Trigger Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      name="retentionTriggerDate"
                      value={formData.retentionTriggerDate || ''}
                      onChange={handleInputChange}
                      className="ui-input mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Language
                    </label>
                    <select
                      name="language"
                      value={formData.language || 'en'}
                      onChange={handleInputChange}
                      className="ui-input mt-1"
                    >
                      <option value="en">English</option>
                      <option value="am">Amharic</option>
                      <option value="om">Oromo</option>
                      <option value="ti">Tigrinya</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      Geographic Scope
                    </label>
                    <input
                      type="text"
                      name="geographicScope"
                      maxLength={100}
                      value={formData.geographicScope || ''}
                      onChange={handleInputChange}
                      placeholder="e.g. Exampleland, Regional, Global"
                      className="ui-input mt-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-secondary">
                      External Reference
                    </label>
                    <input
                      type="text"
                      name="externalReference"
                      maxLength={200}
                      value={formData.externalReference || ''}
                      onChange={handleInputChange}
                      placeholder="e.g. REF-2026-001 (optional)"
                      className="ui-input mt-1"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-text-secondary">
                      Folder (Category in the hierarchy)
                    </label>
                    <select
                      name="folderPath"
                      value={formData.folderPath || ''}
                      onChange={handleInputChange}
                      disabled={!formData.departmentId}
                      className="ui-input mt-1 disabled:opacity-50"
                    >
                      <option value="">
                        {formData.departmentId
                          ? 'Select category folder'
                          : 'Pick a department first'}
                      </option>
                      {categoryFolders.map((f) => (
                        <option key={f.id} value={f.path}>
                          {f.path}
                        </option>
                      ))}
                    </select>
                    {formData.departmentId &&
                      categoryFolders.length === 0 && (
                        <p className="mt-1 text-xs text-amber-600">
                          No category folders seeded for this department yet.
                        </p>
                      )}
                  </div>
                </div>
                <div className="flex justify-between">
                  <button
                    onClick={() => setStep(1)}
                    className="ui-btn ui-btn-secondary"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="ui-btn ui-btn-primary"
                  >
                    Next Step
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">
                    Step 3: Review &amp; Submit
                  </h2>
                  <p className="text-sm text-text-muted">
                    Confirm the details before uploading.
                  </p>
                </div>
                <div className="bg-surface-raised border border-border rounded-xl p-4 space-y-3">
                  {[
                    ['Files', files.length === 1 ? files[0].name : `${files.length} files`],
                    ['Title', files.length === 1 ? (formData.title ?? '—') : '(from each file name)'],
                    [
                      'Dept / Type',
                      `${departments.find((d: any) => d.id === formData.departmentId)?.code ?? '—'} / ${formData.documentTypeCode ?? '—'}`,
                    ],
                    ['Classification', formData.securityClassification ?? '—'],
                    ['Folder', formData.folderPath || '(root)'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between text-sm gap-4">
                      <span className="text-text-muted shrink-0">{label}:</span>
                      <span className="font-medium text-text-primary text-right truncate">{value}</span>
                    </div>
                  ))}
                </div>

                {uploadProgress.length > 0 && (
                  <div className="space-y-1.5">
                    {uploadProgress.map((p) => (
                      <div
                        key={p.name}
                        className="flex items-center justify-between gap-3 text-sm px-3 py-2 rounded-lg bg-surface-raised border border-border"
                      >
                        <span className="truncate text-text-secondary">{p.name}</span>
                        {p.status === 'pending' && <span className="text-xs text-text-muted shrink-0">Waiting…</span>}
                        {p.status === 'uploading' && (
                          <span className="flex items-center gap-1.5 text-xs text-indigo-500 shrink-0">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading &amp; scanning…
                          </span>
                        )}
                        {p.status === 'success' && (
                          <span
                            className="flex items-center gap-1.5 text-xs text-emerald-600 shrink-0"
                            title="Uploaded, and the antivirus scan completed and found nothing."
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Uploaded — scanned clean
                          </span>
                        )}
                        {p.status === 'warning' && (
                          <span
                            className="flex items-center gap-1.5 text-xs text-amber-600 shrink-0"
                            title="Uploaded, but the antivirus scan did not complete — allowed through and flagged for review."
                          >
                            <AlertTriangle className="h-3.5 w-3.5" /> Uploaded — not scanned
                          </span>
                        )}
                        {p.status === 'error' && (
                          <span className="flex items-center gap-1.5 text-xs text-danger shrink-0 text-right">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>Failed{p.error ? `: ${p.error}` : ''}</span>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {submitError && (
                  <div className="flex items-center gap-2 text-sm text-danger bg-danger-bg border border-danger-border rounded-xl px-3 py-2">
                    <AlertCircle className="h-4 w-4 shrink-0" /> {submitError}
                  </div>
                )}
                {showBundleCta ? (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
                      <Layers className="h-4 w-4 shrink-0" />
                      <span>
                        {uploadedDocIds.length} documents uploaded. Bundle them together into one compiled PDF?
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => router.push('/dashboard')} className="ui-btn ui-btn-secondary text-xs">
                        Skip
                      </button>
                      <button onClick={() => setShowBundleModal(true)} className="ui-btn ui-btn-primary text-xs">
                        <Layers className="h-3.5 w-3.5" /> Bundle these documents together
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3">
                    <button
                      onClick={() => setStep(2)}
                      disabled={isBatchUploading}
                      className="ui-btn ui-btn-secondary"
                    >
                      Back
                    </button>
                    <div className="flex flex-col sm:flex-row gap-2 sm:ml-auto">
                      <button
                        onClick={() => handleSubmit(false)}
                        disabled={isBatchUploading || isPending}
                        className="ui-btn ui-btn-secondary inline-flex items-center justify-center gap-2"
                      >
                        {isBatchUploading || isPending ? (
                          <>
                            <Loader2 className="animate-spin h-4 w-4" />
                            Uploading...
                          </>
                        ) : (
                          files.length > 1 ? `Submit & Upload ${files.length} Files` : 'Submit & Upload'
                        )}
                      </button>
                      {files.length > 1 && (
                        <button
                          onClick={() => handleSubmit(true)}
                          disabled={isBatchUploading || isPending}
                          className="ui-btn ui-btn-primary inline-flex items-center justify-center gap-2"
                          title="Upload every selected file, then create one bundle from the successful uploads"
                        >
                          {isBatchUploading || isPending ? (
                            <>
                              <Loader2 className="animate-spin h-4 w-4" />
                              Uploading...
                            </>
                          ) : (
                            <><Layers className="h-4 w-4" /> Upload &amp; bundle</>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
      </div>
      {showBundleModal && (
        <CreateBundleModal
          documentIds={uploadedDocIds}
          onClose={() => setShowBundleModal(false)}
          onDone={(bundleId) => {
            setShowBundleModal(false);
            router.push(`/dashboard/bundles/${bundleId}`);
          }}
        />
      )}
    </RequirePermission>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={null}>
      <UploadPageInner />
    </Suspense>
  );
}
