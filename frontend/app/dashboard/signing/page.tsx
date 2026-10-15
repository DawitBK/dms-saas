'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileSignature, Plus, Send, CheckCircle2, XCircle, Search, Bell, UploadCloud } from 'lucide-react';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { Modal } from '../../../shared/components/Modal';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { apiClient } from '../../../shared/lib/apiClient';
import { useMyDepartments } from '../../../shared/hooks/useMyDepartments';
import { listDocuments, getDocument } from '../../../features/documents/api';
import { useDepartments, useDocumentTypes, useOrgUnits } from '../../../shared/hooks/useLookups';
import { useAssignableRoles } from '../../../shared/lib/assignmentAdvisory';
import { AssignmentAdvisoryNotice } from '../../../shared/components/AssignmentAdvisoryNotice';
import { useAuthStore } from '../../../state/auth.store';
import { PdfFieldPlacer, type FieldMarker } from '../../../features/signing/components/PdfFieldPlacer';
import { SignaturePad } from '../../../features/signing/components/SignaturePad';
import { signingErrorMessage } from '../../../features/signing/errors';
import {
  remindSignatureRequest,
  listSigningAssignableUsers,
  uploadDocumentForSigning,
  type AssignableSigner,
} from '../../../features/signing/internalApi';

type Recipient = { id: string; name: string; email: string; status: string; orderIndex: number };
type SigningRequest = { id: string; status: string; orderingMode: 'parallel' | 'serial'; recipients?: Recipient[]; fields?: Array<{ id: string; recipientId: string; fieldType: string }> };
type FolderNode = { id: string; name: string; path: string; level: number };

export default function SigningPage() {
  const qc = useQueryClient();
  const { userId, email, firstName, lastName } = useAuthStore();
  const searchParams = useSearchParams();
  const [q, setQ] = useState('');
  // Deep-link support: the document page's "Initiate Signing" button lands
  // here with the document preselected.
  const [selectedDocumentId, setSelectedDocumentId] = useState(searchParams.get('documentId') ?? '');
  const [orderingMode, setOrderingMode] = useState<'parallel' | 'serial'>('serial');
  const [expiresAt, setExpiresAt] = useState('');
  const [completionAction, setCompletionAction] = useState<'none' | 'move_folder' | 'notify_only'>('none');
  const [completionTargetFolderId, setCompletionTargetFolderId] = useState('');
  // `key` is a stable identifier (internal signers: their dmsUserId, which
  // never changes; external signers: a fresh client-side uuid at add-time) —
  // PdfFieldPlacer keys placed fields off this, not off array position, so
  // removing/reordering a recipient can never silently reassign an
  // already-placed field to a different signer (platform audit finding
  // 2026-08-14). See PdfFieldPlacer.tsx's FieldMarker.recipientKey comment.
  // `assignedRole` is the third recipient kind (alongside internal-named
  // `dmsUserId` and external name+email): nobody specific yet — every
  // department-scoped holder of that role is notified and the first to open it
  // claims the signature. Exactly one of dmsUserId / assignedRole / external
  // per row, enforced again server-side in createSignatureRequest.
  const [recipients, setRecipients] = useState<Array<{ key: string; name: string; email: string; dmsUserId: string; role?: string | null; assignedRole?: string }>>([]);
  const [signerSearch, setSignerSearch] = useState('');
  const [signerDeptFilter, setSignerDeptFilter] = useState('');
  const [signerRoleFilter, setSignerRoleFilter] = useState('');
  const [roleSignerToAdd, setRoleSignerToAdd] = useState('');
  const [fields, setFields] = useState<FieldMarker[]>([]);
  const [declineTarget, setDeclineTarget] = useState<{ request: SigningRequest; recipient: Recipient } | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [signTarget, setSignTarget] = useState<{ request: SigningRequest; recipient: Recipient } | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);

  // Same query key as ProfileSettingsPanel.tsx / signing/pending/page.tsx's
  // own /users/me fetch — pre-fills the "sign this document" SignaturePad
  // below with whatever signature this user already saved in Settings.
  const { data: myProfile } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => apiClient<{ signatureImage?: string | null }>('/users/me'),
  });

  // Left-panel picker: an already-uploaded document (search), or a brand new
  // local file to file-and-sign in one go.
  const [pickerMode, setPickerMode] = useState<'existing' | 'upload'>('existing');
  const [newFile, setNewFile] = useState<File | null>(null);
  // Stores the department's id, not its code -- department codes are only
  // unique per (tenant, org unit) as of the 20260912000001 migration, so two
  // departments can share a code and a code-keyed lookup could silently
  // resolve to the wrong one (reproduced live: an upload rejected as "not a
  // member" of a same-coded department in a different org unit than the
  // user's own). See documents.service.ts's createDocument for the backend
  // half of this same fix.
  const [newDeptId, setNewDeptId] = useState('');
  const [newDocTypeCode, setNewDocTypeCode] = useState('');
  const [newFolderPath, setNewFolderPath] = useState('');

  const { data: docsData, isLoading: docsLoading } = useQuery({ queryKey: ['documents', 'signing-picker', q], queryFn: () => listDocuments(0, 20, { q: q || undefined }) });
  // A just-uploaded document may not show up in the (search-filtered) picker
  // list above — fetch it directly so the header still shows its name instead
  // of falling back to "Select a document".
  const selectedInPickerList = (docsData?.data ?? []).some((d: any) => d.id === selectedDocumentId);
  const { data: selectedDocDetail } = useQuery({
    queryKey: ['signing-selected-document-detail', selectedDocumentId],
    queryFn: () => getDocument(selectedDocumentId),
    enabled: Boolean(selectedDocumentId) && !selectedInPickerList,
    staleTime: 30_000,
  });
  const { data: requestsData, isLoading: reqLoading } = useQuery({ queryKey: ['signing', selectedDocumentId], queryFn: () => apiClient<{ data: SigningRequest[] }>(`/documents/${selectedDocumentId}/signing`), enabled: Boolean(selectedDocumentId) });
  const { data: folderTree } = useQuery({
    queryKey: ['folder-tree'],
    queryFn: () => apiClient<{ data: FolderNode[] }>('/folders/tree'),
    enabled: completionAction === 'move_folder',
    staleTime: 60_000,
  });
  // Searchable internal-user list for the recipient picker. Searches name+email
  // server-side (GET /signing/assignable-users), optionally narrowed by
  // department/role. Enabled once a document is selected (i.e. the create
  // form is visible).
  const { data: signerResults, isFetching: signerLoading } = useQuery({
    queryKey: ['signing-assignable-users', signerSearch, signerDeptFilter, signerRoleFilter],
    queryFn: () => listSigningAssignableUsers(signerSearch, { departmentId: signerDeptFilter || undefined, roleId: signerRoleFilter || undefined }),
    enabled: Boolean(selectedDocumentId),
    staleTime: 30_000,
  });

  // Lookups for both the upload tab's optional metadata fields and the signer
  // search's department/role filters — reuse the existing shared hooks/
  // endpoints rather than adding new ones.
  const { data: departmentsRaw } = useDepartments();
  const departments = Array.isArray(departmentsRaw) ? departmentsRaw : ((departmentsRaw as { data?: any[] } | undefined)?.data ?? []);
  // FIX: the upload tab's department picker below used to list every
  // department in the tenant, same bug as the main Upload page — the
  // backend (esigning.service.ts's uploadAndFileDocumentForSigning) now
  // rejects a departmentCode the caller isn't a member of, but the picker
  // itself shouldn't offer the choice in the first place. Scoped narrowly to
  // THIS picker — `departments` above stays the full list because the
  // signer-search department filter a few lines down legitimately needs to
  // search across every department to find the right recipient.
  const { can } = usePermissions();
  const canUploadAnywhere = can(PERMISSIONS.ACL_BYPASS_ADMIN);
  const { myDepartmentIds: myDeptIds } = useMyDepartments(!canUploadAnywhere);
  const myUploadDepartments = canUploadAnywhere ? departments : departments.filter((d: any) => myDeptIds.has(d.id));
  // Org unit labels for the two department pickers below — the upload tab's
  // picker (narrowed to memberships) and the signer-search filter (legitimately
  // tenant-wide, see comment above) both benefit from disambiguating same-named
  // departments across org units, same as every other picker fixed for this.
  const { data: orgUnits } = useOrgUnits();
  const orgUnitNameById = new Map((orgUnits ?? []).map((u) => [u.id, u.name]));
  const groupByOrgUnit = (list: any[]) => {
    const groups = new Map<string, any[]>();
    for (const d of list) {
      const label = (d.orgUnitId && orgUnitNameById.get(d.orgUnitId)) || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(d);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  };
  const myUploadDepartmentGroups = groupByOrgUnit(myUploadDepartments);
  const allDepartmentGroups = groupByOrgUnit(departments);
  // FIX 2026-09-14: two departments can legitimately share a name across
  // different org units (e.g. two "Information Technology" departments,
  // reproduced live in the examplecorp tenant) — the optgroup label alone
  // disambiguates them while the dropdown is OPEN, but a collapsed/closed
  // select shows only the option's own text, so the wrong pick (and its
  // near-empty folder/signer results) was indistinguishable from the right
  // one once selected. Only ambiguous names get the org unit suffixed onto
  // the option itself so the closed value stays disambiguated too.
  const nameCounts = (list: any[]) => {
    const counts = new Map<string, number>();
    for (const d of list) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    return counts;
  };
  const myUploadDeptNameCounts = nameCounts(myUploadDepartments);
  const allDeptNameCounts = nameCounts(departments);
  const deptOptionLabel = (d: any, orgUnitName: string, counts: Map<string, number>) =>
    (counts.get(d.name) ?? 0) > 1 ? `${d.name} (${orgUnitName})` : d.name;
  const { data: docTypesRaw } = useDocumentTypes();
  const allDocTypes = Array.isArray(docTypesRaw) ? docTypesRaw : ((docTypesRaw as { data?: any[] } | undefined)?.data ?? []);
  // FIX 2026-09-14: this picker used to offer every document type in the
  // tenant, including ones with no signing ceremony configured at all — you
  // could file a document under a type that has nothing to do with signing.
  // `requiresSignature` is now the single, reliable flag for "this type is
  // meant to go through e-signing" (documentTypes.service.ts derives
  // signingPolicy from it, so the two can't disagree anymore), so this only
  // offers types that actually opted into it — the tenant's uncategorized
  // e-sign fallback (SIGN-UNCAT) included, now that it's flagged correctly too.
  const docTypes = allDocTypes.filter((t: any) => t.requiresSignature);
  // FIX: this used GET /roles (role:read | acl:manage) — which RECORDS_OFFICER,
  // the main signing:manage holder, does not hold — so the role filter below
  // silently rendered an empty dropdown for exactly the people who live on
  // this page. /assignment-advisory/roles carries the picker-audience gate
  // (signing:manage included) and returns the same {id, name} shape.
  const { data: rolesData } = useAssignableRoles();
  const roles = rolesData ?? [];

  // Department-scoped folder picker for the upload tab, same source as the
  // main Upload page (`/folders/department/:id`) — only fetched once a
  // department is actually chosen, and entirely optional here.
  const { data: newDeptFolderData } = useQuery({
    queryKey: ['signing-upload-department-folder', newDeptId],
    queryFn: () => apiClient<{ data: { folder: FolderNode; subfolders: FolderNode[] } }>(`/folders/department/${newDeptId}`),
    enabled: !!newDeptId,
    staleTime: 30_000,
  });
  const newCategoryFolders = (newDeptFolderData?.data.subfolders ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));

  const uploadForSigning = useMutation({
    mutationFn: () => {
      if (!newFile) throw new Error('Choose a file first');
      return uploadDocumentForSigning(newFile, {
        departmentId: newDeptId || undefined,
        documentTypeCode: newDocTypeCode || undefined,
        folderPath: newFolderPath || undefined,
      });
    },
    onSuccess: (res) => {
      setSelectedDocumentId(res.data.documentId);
      setFields([]);
      setPickerMode('existing');
      setNewFile(null);
      setNewDeptId('');
      setNewDocTypeCode('');
      setNewFolderPath('');
      // Both warnings are fail-open (never blocking) — surface whichever
      // apply instead of a plain success, same as the main upload page.
      const noteworthy: string[] = [];
      if (res.data.warnings.includes('WARN-DUPLICATE-DETECTED')) {
        noteworthy.push('this looks like a duplicate of an existing document');
      }
      if (res.data.warnings.includes('WARN-UNSCANNED')) {
        noteworthy.push('it could not be scanned for viruses (allowed through and flagged for review)');
      }
      if (noteworthy.length > 0) {
        toast(`Filed — but ${noteworthy.join(', and ')}. You can still continue signing it.`);
      } else {
        toast.success('Document filed. Set up the signing request below.');
      }
      qc.invalidateQueries({ queryKey: ['documents', 'signing-picker'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Upload failed')),
  });

  const addInternalSigner = (u: AssignableSigner) => {
    setRecipients((list) => {
      if (list.some((r) => r.dmsUserId === u.id || (r.email && r.email.toLowerCase() === u.email.toLowerCase()))) return list;
      return [...list, { key: u.id, name: `${u.firstName} ${u.lastName}`.trim() || u.email, email: u.email, dmsUserId: u.id, role: u.role }];
    });
    // Intentionally keep the search term (and dropdown open) so several signers
    // can be added in a row — the just-added one flips to "Added" while the rest
    // stay clickable. Clearing it here made the picker look "locked" after the
    // first pick because the dropdown closed and you had to retype to add more.
  };

  const createRequest = useMutation({
    // FIX (platform audit finding 2026-08-14): recipientIndex used to be
    // whatever PdfFieldPlacer stamped at placement time against the
    // then-current (unfiltered) recipients array — silently wrong the moment
    // a recipient was removed or an incomplete row got filtered out right
    // here. The "needs" validation above now requires every row complete and
    // no orphaned fields before this can even run, so `recipients` below is
    // exactly the array being sent — recompute each field's recipientIndex
    // fresh from THIS array's final order via its stable recipientKey.
    mutationFn: () => {
      const keyToIndex = new Map(recipients.map((r, i) => [r.key, i]));
      return apiClient<{ data: SigningRequest }>(`/documents/${selectedDocumentId}/signing`, {
        method: 'POST',
        body: JSON.stringify({
          orderingMode,
          expiresAt: expiresAt || null,
          completionAction,
          completionTargetFolderId: completionAction === 'move_folder' ? (completionTargetFolderId || null) : null,
          recipients: recipients.map((r, i) => ({
            name: r.name,
            email: r.email,
            dmsUserId: r.dmsUserId || undefined,
            // Role rows carry no person yet — the backend synthesizes the
            // placeholder name/email and swaps in the real claimer's identity
            // when they sign.
            assignedRole: r.assignedRole || undefined,
            orderIndex: i,
          })),
          fields: fields.map(({ id: _id, recipientKey, ...f }) => ({ ...f, recipientIndex: keyToIndex.get(recipientKey) })),
        }),
      });
    },
    onSuccess: () => {
      toast.success('Signature request created');
      setFields([]);
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['document', selectedDocumentId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Create failed')),
  });
  const sendRequest = useMutation({
    mutationFn: (id: string) => apiClient(`/signing/${id}/send`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Request sent');
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['document', selectedDocumentId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Send failed')),
  });
  const remindRequest = useMutation({
    mutationFn: (id: string) => remindSignatureRequest(id),
    onSuccess: () => toast.success('Reminder sent to everyone who hasn\'t signed yet'),
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Reminder failed')),
  });
  const signRecipient = useMutation({
    mutationFn: ({ request, recipient, signature }: { request: SigningRequest; recipient: Recipient; signature: string }) =>
      apiClient(`/signing/${request.id}/recipients/${recipient.id}/sign`, {
        method: 'POST',
        body: JSON.stringify({
          fieldValues: (request.fields ?? []).filter((f) => f.recipientId === recipient.id).map((f) => ({
            fieldId: f.id,
            value: f.fieldType === 'date'
              ? new Date().toLocaleDateString()
              : ['signature', 'initial', 'seal'].includes(f.fieldType)
                ? signature
                : (`${firstName ?? ''} ${lastName ?? ''}`.trim() || email || userId || 'Signed'),
          })),
        }),
      }),
    onSuccess: () => {
      toast.success('Signed');
      setSignTarget(null);
      setSignatureDataUrl(null);
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['document', selectedDocumentId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Sign failed')),
  });
  const declineRecipient = useMutation({
    mutationFn: ({ request, recipient, reason }: { request: SigningRequest; recipient: Recipient; reason: string }) => apiClient(`/signing/${request.id}/recipients/${recipient.id}/decline`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      toast.success('Declined');
      setDeclineTarget(null);
      setDeclineReason('');
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['document', selectedDocumentId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Decline failed')),
  });

  const selectedDoc = (docsData?.data ?? []).find((d: any) => d.id === selectedDocumentId) ?? selectedDocDetail;
  // The document's own department — a role-assigned signature is scoped to it
  // (server-side, in resolveSigningRoleHolders), and it's the reference point
  // for the named-signer "outside this department" advisory.
  const selectedDocDept = ((selectedDoc as any)?.department ?? null) as { id?: string; name?: string; code?: string } | null;
  const requests = requestsData?.data ?? [];

  return (
    <PermissionGate permission={PERMISSIONS.SIGNING_READ}>
      <div className="h-full flex flex-col" style={{ background: 'var(--surface-base)' }}>
        <TopBar title="E-signing" />
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-8">
        <div className="max-w-6xl mx-auto">
          <PageHeader title="E-signing" subtitle="Create signature requests, send them, and complete internal signing tasks." />

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
            <div className="ui-card">
              {/* Existing document vs. brand-new local file */}
              <div className="mb-3 flex gap-1 rounded-lg border p-1" style={{ borderColor: 'var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setPickerMode('existing')}
                  className="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                  style={pickerMode === 'existing' ? { background: 'var(--brand-600)', color: 'white' } : { color: 'var(--text-muted)' }}
                >
                  <Search size={13} className="inline -mt-0.5 mr-1" /> Pick existing
                </button>
                <button
                  type="button"
                  onClick={() => setPickerMode('upload')}
                  className="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                  style={pickerMode === 'upload' ? { background: 'var(--brand-600)', color: 'white' } : { color: 'var(--text-muted)' }}
                >
                  <UploadCloud size={13} className="inline -mt-0.5 mr-1" /> Upload new
                </button>
              </div>

              {pickerMode === 'existing' ? (
                <>
                  <div className="relative mb-3"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} /><input value={q} onChange={(e) => setQ(e.target.value)} className="ui-input pl-8 w-full" placeholder="Search documents" /></div>
                  {docsLoading ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p> : <div className="space-y-1 max-h-[520px] overflow-y-auto">{(docsData?.data ?? []).map((d: any) => <button key={d.id} onClick={() => { setSelectedDocumentId(d.id); setFields([]); }} className="w-full rounded-lg px-3 py-2 text-left text-sm" style={{ background: selectedDocumentId === d.id ? 'var(--surface-raised)' : 'transparent', color: 'var(--text-primary)' }}><span className="font-medium block truncate">{d.documentName ?? d.title}</span><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{d.status}</span></button>)}</div>}
                </>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>File</label>
                    <input
                      type="file"
                      onChange={(e) => setNewFile(e.target.files?.[0] ?? null)}
                      className="ui-input w-full text-sm"
                    />
                    {newFile && <p className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>{newFile.name} ({(newFile.size / (1024 * 1024)).toFixed(2)} MB)</p>}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Department (optional)</label>
                    <select
                      value={newDeptId}
                      onChange={(e) => { setNewDeptId(e.target.value); setNewFolderPath(''); }}
                      className="ui-input w-full"
                    >
                      <option value="">Uncategorized</option>
                      {myUploadDepartmentGroups.length > 1
                        ? myUploadDepartmentGroups.map(([orgUnitName, depts]) => (
                            <optgroup key={orgUnitName} label={orgUnitName}>
                              {depts.map((d: any) => <option key={d.id} value={d.id}>{deptOptionLabel(d, orgUnitName, myUploadDeptNameCounts)}</option>)}
                            </optgroup>
                          ))
                        : myUploadDepartments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Document Type (optional)</label>
                    <select
                      value={newDocTypeCode}
                      onChange={(e) => setNewDocTypeCode(e.target.value)}
                      className="ui-input w-full"
                    >
                      <option value="">Uncategorized Signed Document</option>
                      {docTypes.map((t: any) => <option key={t.id} value={t.code}>{t.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase mb-1" style={{ color: 'var(--text-muted)' }}>Folder (optional)</label>
                    <select
                      value={newFolderPath}
                      onChange={(e) => setNewFolderPath(e.target.value)}
                      disabled={!newDeptId}
                      className="ui-input w-full disabled:opacity-50"
                    >
                      <option value="">{newDeptId ? 'Root of department' : 'Pick a department first'}</option>
                      {newCategoryFolders.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
                    </select>
                  </div>

                  <p className="text-xs rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', background: 'var(--surface-raised)' }}>
                    Leave these blank to file this under Uncategorized — you can move it later.
                  </p>

                  <button
                    type="button"
                    onClick={() => uploadForSigning.mutate()}
                    disabled={!newFile || uploadForSigning.isPending}
                    className="ui-btn ui-btn-primary w-full"
                  >
                    {uploadForSigning.isPending ? 'Filing…' : 'File & continue'}
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="ui-card">
                <div className="flex items-center justify-between gap-3 mb-4"><div><h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedDoc ? (selectedDoc as any).documentName ?? (selectedDoc as any).title : 'Select a document'}</h2><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Signature requests are stored per document.</p></div><FileSignature className="h-5 w-5" style={{ color: 'var(--brand-600)' }} /></div>
                {selectedDocumentId && (
                  <PermissionGate permission={PERMISSIONS.SIGNING_MANAGE}>
                    <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <select value={orderingMode} onChange={(e) => setOrderingMode(e.target.value as 'parallel' | 'serial')} className="ui-input w-full">
                          <option value="serial">Serial</option>
                          <option value="parallel">Parallel</option>
                        </select>
                        <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="ui-input w-full" title="Expires at" />
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <select value={completionAction} onChange={(e) => setCompletionAction(e.target.value as 'none' | 'move_folder' | 'notify_only')} className="ui-input w-full">
                          <option value="none">On completion: do nothing</option>
                          <option value="notify_only">On completion: notify only</option>
                          <option value="move_folder">On completion: move to folder</option>
                        </select>
                        {completionAction === 'move_folder' && (
                          <select value={completionTargetFolderId} onChange={(e) => setCompletionTargetFolderId(e.target.value)} className="ui-input w-full">
                            <option value="">Select target folder…</option>
                            {(folderTree?.data ?? []).map((f) => (
                              <option key={f.id} value={f.id}>{f.path}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                        <p className="text-xs font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>Signers</p>

                        {/* Searchable internal-user picker — searches by name AND email,
                            narrowable by department/role */}
                        <div>
                          <div className="relative">
                            <Search className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                            <input
                              value={signerSearch}
                              onChange={(e) => setSignerSearch(e.target.value)}
                              className="ui-input pr-8 w-full"
                              placeholder="Search users by name or email…"
                            />
                          </div>
                          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                            <select
                              value={signerDeptFilter}
                              onChange={(e) => setSignerDeptFilter(e.target.value)}
                              className="ui-input !py-1.5 text-xs"
                              title="Filter by department"
                            >
                              <option value="">All departments</option>
                              {allDepartmentGroups.length > 1
                                ? allDepartmentGroups.map(([orgUnitName, depts]) => (
                                    <optgroup key={orgUnitName} label={orgUnitName}>
                                      {depts.map((d: any) => <option key={d.id} value={d.id}>{deptOptionLabel(d, orgUnitName, allDeptNameCounts)}</option>)}
                                    </optgroup>
                                  ))
                                : departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                            <select
                              value={signerRoleFilter}
                              onChange={(e) => setSignerRoleFilter(e.target.value)}
                              className="ui-input !py-1.5 text-xs"
                              title="Filter by role"
                            >
                              <option value="">All roles</option>
                              {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                          </div>
                          {(signerSearch.trim() || signerDeptFilter || signerRoleFilter) && (
                            <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)', background: 'var(--surface-card)' }}>
                              {signerLoading ? (
                                <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>Searching…</p>
                              ) : (signerResults?.data ?? []).length === 0 ? (
                                <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>No matching users. Use “Add external signer” for people without an account.</p>
                              ) : (
                                (signerResults?.data ?? []).map((u) => {
                                  const already = recipients.some((r) => r.dmsUserId === u.id);
                                  return (
                                    <button
                                      key={u.id}
                                      type="button"
                                      disabled={already}
                                      onClick={() => addInternalSigner(u)}
                                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm disabled:opacity-50"
                                      style={{ color: 'var(--text-primary)' }}
                                    >
                                      <span className="min-w-0">
                                        <span className="font-medium block truncate">{u.firstName} {u.lastName}</span>
                                        <span className="text-xs block truncate" style={{ color: 'var(--text-muted)' }}>{u.email}{u.role ? ` · ${u.role}` : ''}</span>
                                      </span>
                                      {already ? <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>Added</span> : <Plus size={15} className="shrink-0" />}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          )}
                        </div>

                        {/* Selected signers (internal = read-only chip, external = editable) */}
                        {recipients.length === 0 ? (
                          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No signers yet. Search for a user above, or add an external signer.</p>
                        ) : (
                          <div className="space-y-2">
                            {recipients.map((r, index) => (
                              <div key={index} className="flex items-start gap-2">
                                <span className="mt-2 w-5 shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>{index + 1}.</span>
                                {r.assignedRole ? (
                                  <div className="flex-1 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
                                    <span className="block truncate font-medium" style={{ color: 'var(--text-primary)' }}>Role: {r.assignedRole.replace(/_/g, ' ')}</span>
                                    <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                                      Unclaimed · every holder{selectedDocDept?.name ? ` in ${selectedDocDept.name}` : ''} is notified; the first to open it signs
                                    </span>
                                  </div>
                                ) : r.dmsUserId ? (
                                  <div className="flex-1 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
                                    <span className="block truncate font-medium" style={{ color: 'var(--text-primary)' }}>{r.name || r.email}</span>
                                    <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>{r.email}{r.role ? ` · ${r.role}` : ''} · internal</span>
                                    <AssignmentAdvisoryNotice
                                      className="mt-1"
                                      candidateUserId={r.dmsUserId}
                                      candidateDepartments={(signerResults?.data ?? []).find((u) => u.id === r.dmsUserId)?.departments}
                                      candidateLabel={r.name || r.email}
                                      departmentId={selectedDocDept?.id ?? null}
                                      resourceType="document"
                                      resourceId={selectedDocumentId || null}
                                    />
                                  </div>
                                ) : (
                                  <div className="grid flex-1 grid-cols-1 gap-2 md:grid-cols-2">
                                    <input value={r.name} onChange={(e) => setRecipients((list) => list.map((x, i) => i === index ? { ...x, name: e.target.value } : x))} className="ui-input" placeholder="External signer name" />
                                    <input value={r.email} onChange={(e) => setRecipients((list) => list.map((x, i) => i === index ? { ...x, email: e.target.value } : x))} className="ui-input" placeholder="email@example.com" />
                                  </div>
                                )}
                                <button
                                  onClick={() => {
                                    const removed = recipients[index];
                                    const orphaned = fields.filter((f) => f.recipientKey === removed.key).length;
                                    setRecipients((list) => list.filter((_, i) => i !== index));
                                    if (orphaned > 0) {
                                      toast(`${orphaned} placed field${orphaned === 1 ? '' : 's'} for ${removed.name || removed.email} now need${orphaned === 1 ? 's' : ''} to be removed or reassigned (shown in red on the document) before you can create the request.`);
                                    }
                                  }}
                                  className="ui-btn ui-btn-secondary shrink-0"
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Third recipient kind: nobody specific yet — anyone
                            holding the role (scoped to this document's own
                            department) can claim and sign it. Mirrors letters'
                            role-assigned approval steps. */}
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={roleSignerToAdd}
                            onChange={(e) => setRoleSignerToAdd(e.target.value)}
                            className="ui-input !py-1.5 text-xs !w-auto"
                            title="Assign a signature to a role instead of a named person"
                          >
                            <option value="">— assign by role —</option>
                            {roles.map((r: { id: string; name: string }) => (
                              <option key={r.id} value={r.name}>{r.name.replace(/_/g, ' ')}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={!roleSignerToAdd || recipients.some((r) => r.assignedRole === roleSignerToAdd)}
                            onClick={() => {
                              setRecipients((list) => list.some((r) => r.assignedRole === roleSignerToAdd)
                                ? list
                                : [...list, { key: crypto.randomUUID(), name: `Role: ${roleSignerToAdd.replace(/_/g, ' ')}`, email: '', dmsUserId: '', assignedRole: roleSignerToAdd }]);
                              setRoleSignerToAdd('');
                            }}
                            className="ui-btn ui-btn-secondary"
                          >
                            <Plus size={15} /> Add role signer
                          </button>
                          <button onClick={() => setRecipients((list) => [...list, { key: crypto.randomUUID(), name: '', email: '', dmsUserId: '' }])} className="ui-btn ui-btn-secondary"><Plus size={15} /> Add external signer</button>
                        </div>
                      </div>

                      <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                        <p className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>Place fields on the document</p>
                        <PdfFieldPlacer
                          documentId={selectedDocumentId}
                          mimeType={(selectedDoc as any)?.versions?.[0]?.mimeType}
                          recipients={recipients}
                          value={fields}
                          onChange={setFields}
                        />
                      </div>

                      {(() => {
                        // Surface exactly why the button is disabled instead of
                        // leaving it mysteriously inactive.
                        const needs: string[] = [];
                        if (recipients.length === 0) needs.push('add at least one signer');
                        // FIX (platform audit finding 2026-08-14): createRequest
                        // used to silently drop incomplete rows (blank name/
                        // email) at submit time — since fields were keyed by
                        // array position, a dropped row shifted every later
                        // signer's index and misassigned their fields. Require
                        // every row complete up front instead, so what's shown
                        // while placing fields is exactly what gets submitted.
                        // Role rows have no person (and so no real email) until
                        // they're claimed — only genuinely external rows need
                        // a hand-typed name + address.
                        else if (recipients.some((r) => !r.dmsUserId && !r.assignedRole && (!r.name.trim() || !r.email.trim()))) needs.push('fill in every external signer’s name and email (or remove incomplete rows)');
                        const recipientKeys = new Set(recipients.map((r) => r.key));
                        const orphanedFields = fields.filter((f) => !recipientKeys.has(f.recipientKey)).length;
                        if (orphanedFields > 0) needs.push(`remove or reassign ${orphanedFields} field${orphanedFields === 1 ? '' : 's'} placed for a signer who was removed (shown in red)`);
                        if (fields.length === 0) needs.push('place at least one field on the document');
                        // FIX (2026-09-19): this used to only check fields.length
                        // === 0 — satisfied the moment ANY one field existed, even
                        // with 2 other named signers still sitting at zero. A
                        // request like that submitted successfully with those
                        // signers having nothing to sign, which they'd only
                        // discover after being notified. Every signer needs at
                        // least one field of their own, not just the request as
                        // a whole.
                        else {
                          const signersWithNoField = recipients.filter((r) => !fields.some((f) => f.recipientKey === r.key));
                          if (signersWithNoField.length > 0) {
                            needs.push(`place at least one field for ${signersWithNoField.map((r) => r.name || 'an unnamed signer').join(', ')} (highlighted above)`);
                          }
                        }
                        if (completionAction === 'move_folder' && !completionTargetFolderId) needs.push('choose a target folder');
                        return (
                          <div className="flex items-center justify-end gap-3">
                            {needs.length > 0 && (
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                To create the request, {needs.join(', ')}.
                              </p>
                            )}
                            <button
                              onClick={() => createRequest.mutate()}
                              disabled={createRequest.isPending || !selectedDocumentId || needs.length > 0}
                              className="ui-btn ui-btn-primary"
                            >
                              {createRequest.isPending ? 'Creating…' : 'Create request'}
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </PermissionGate>
                )}
              </div>

              <div className="ui-card">
                <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Requests</h3>
                {!selectedDocumentId ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Choose a document to view requests.</p> : reqLoading ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p> : requests.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No signature requests for this document.</p> : <div className="space-y-2">{requests.map((r) => <div key={r.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}><div className="flex items-center justify-between gap-2"><StatusBadge status={r.status.toUpperCase()} /><span className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.orderingMode}</span></div><div className="mt-3 space-y-1">{(r.recipients ?? []).map((rec) => <div key={rec.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{rec.orderIndex + 1}. {rec.name} <span style={{ color: 'var(--text-muted)' }}>{rec.email}</span></span><StatusBadge status={rec.status.toUpperCase()} />{rec.email === email && rec.status !== 'signed' && rec.status !== 'declined' && (
                    <>
                      <button onClick={() => { setSignTarget({ request: r, recipient: rec }); setSignatureDataUrl(null); }} className="ui-btn ui-btn-secondary !py-1 text-xs"><CheckCircle2 size={14} /> Sign</button>
                      <button
                        onClick={() => { setDeclineTarget({ request: r, recipient: rec }); setDeclineReason(''); }}
                        className="ui-btn ui-btn-secondary !py-1 text-xs"
                        style={{ color: 'var(--danger)' }}
                      >
                        <XCircle size={14} /> Decline
                      </button>
                    </>
                  )}</div>)}</div>
                  <div className="flex gap-2 mt-3">
                    {r.status === 'draft' && <PermissionGate permission={PERMISSIONS.SIGNING_MANAGE}><button onClick={() => sendRequest.mutate(r.id)} className="ui-btn ui-btn-primary !py-1.5"><Send size={14} /> Send</button></PermissionGate>}
                    {['sent', 'partially_signed'].includes(r.status) && <PermissionGate permission={PERMISSIONS.SIGNING_MANAGE}><button onClick={() => remindRequest.mutate(r.id)} disabled={remindRequest.isPending} className="ui-btn ui-btn-secondary !py-1.5"><Bell size={14} /> Remind</button></PermissionGate>}
                  </div>
                  </div>)}</div>}
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>

      <Modal isOpen={Boolean(signTarget)} onClose={() => setSignTarget(null)} title="Sign this document">
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Draw your signature, or type your name to render it in a signature-style font. This applies to every
            signature/initial/seal field assigned to you on this request.
          </p>
          <SignaturePad
            defaultTypedName={`${firstName ?? ''} ${lastName ?? ''}`.trim()}
            defaultSignatureImage={myProfile?.signatureImage}
            onChange={setSignatureDataUrl}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setSignTarget(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => signTarget && signatureDataUrl && signRecipient.mutate({ request: signTarget.request, recipient: signTarget.recipient, signature: signatureDataUrl })}
              disabled={signRecipient.isPending || !signatureDataUrl}
              className="ui-btn ui-btn-primary"
            >
              {signRecipient.isPending ? 'Working…' : 'Confirm & Sign'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={Boolean(declineTarget)} onClose={() => setDeclineTarget(null)} title="Decline this signature request">
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Declining is a hard rejection for {declineTarget?.recipient.name} — the sender will need to void and
            re-send the request. A reason is optional but recorded on the recipient&apos;s status.
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Reason for declining (optional)"
            className="ui-input w-full min-h-[80px]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeclineTarget(null)} className="ui-btn ui-btn-secondary">Back</button>
            <button
              onClick={() => declineTarget && declineRecipient.mutate({ request: declineTarget.request, recipient: declineTarget.recipient, reason: declineReason })}
              disabled={declineRecipient.isPending}
              className="ui-btn ui-btn-danger"
            >
              {declineRecipient.isPending ? 'Working…' : 'Decline'}
            </button>
          </div>
        </div>
      </Modal>
    </PermissionGate>
  );
}
