import { apiClient, apiClientBlob } from '../../shared/lib/apiClient';
import type { FieldSchema, SectionMeta } from './schema';
import type { SignatureRequestSummary } from '../approvals/ApprovalChainCard';
import type { SubmitStepInput } from '../approvals/api';

export interface FormTemplate {
  id: string;
  name: string;
  category: string | null;
  status: 'draft' | 'pending_approval' | 'active' | 'deprecated';
  version: number;
  layoutMode: 'static' | 'dynamic';
  basePdfObjectKey?: string | null;
  isLetterhead?: boolean;
  schemaJson?: FieldSchema[][];
  sectionsJson?: SectionMeta[] | null;
  instanceApproval?: 'none' | 'chain';
  auditPolicy?: 'required' | 'optional' | 'never';
  signingPolicy?: 'none' | 'ceremony';
  /** The author. Editing, versioning, deprecating and submitting a template are limited to the author or an approval:admin holder. */
  createdBy?: string;
  /** Who can use this form. Both null = the whole organisation; an org unit = every department in it; a department = that department only. */
  departmentId?: string | null;
  orgUnitId?: string | null;
  approvedBy?: string | null;
  approver?: { id: string; firstName: string; lastName: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormInstanceSummary {
  id: string;
  templateId: string;
  templateVersion: number;
  documentId: string | null;
  dataJson: Record<string, unknown>;
  /** The filer. Editing, withdrawing and cancelling a filed form are limited to them. */
  createdBy?: string;
  createdAt: string;
  updatedAt?: string | null;
  /** REF/<UNIT>/<DEPT>/FORM/<YEAR>/<00001>, allocated at FINAL APPROVAL from a
   *  gap-free per-unit-per-year counter — the same shape and the same
   *  guarantees as a letter's. Null until approved, and null forever for a
   *  template that does not use chain approval. */
  referenceNumber?: string | null;
  referenceAllocatedAt?: string | null;
  /** The list endpoint returns only id/name/category/auditPolicy; GET /forms/instances/:id returns the whole template. */
  template?: Partial<FormTemplate> & { id: string; name: string; category: string | null; auditPolicy?: 'required' | 'optional' | 'never' };
  document?: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    /** Where the form was filed. `form_instances` stores neither a department
     *  nor an org unit, but the backing document carries the department and
     *  Department.orgUnitId is NOT NULL, so both are derived rather than
     *  missing — and they are what a letters-style reference number's UNIT and
     *  DEPT segments would resolve from. */
    department?: { id: string; code: string; name: string; orgUnit?: { id: string; code: string; name: string } | null } | null;
    signatureRequests?: SignatureRequestSummary[];
  };
}

export function listFormTemplates(status?: string, skip = 0, take = 25) {
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  query.set('skip', String(skip));
  query.set('take', String(take));
  return apiClient<{ data: FormTemplate[]; total: number }>(`/forms/templates?${query.toString()}`);
}

export function getFormTemplate(id: string) {
  return apiClient<{ data: FormTemplate }>(`/forms/templates/${id}`);
}

/** Distinct category values already used by this tenant's templates — feeds
 *  the builder's category field as suggestions (a `<datalist>`, not a hard
 *  enum) so near-duplicate categories ("HR" / "Hr" / "Human Resources")
 *  don't silently accumulate the way a free-typed field invites. */
export function listFormTemplateCategories() {
  return apiClient<{ data: string[] }>('/forms/templates/categories');
}

export function createFormTemplate(payload: {
  name: string;
  category?: string;
  basePdfObjectKey?: string;
  isLetterhead?: boolean;
  schemaJson: object;
  sectionsJson: SectionMeta[];
  layoutMode?: 'static' | 'dynamic';
  instanceApproval?: 'none' | 'chain';
  auditPolicy?: 'required' | 'optional' | 'never';
  signingPolicy?: 'none' | 'ceremony';
  /** Scope: both null/omitted = the whole organisation (organisation-level people only); anyone else must name a department they belong to. */
  departmentId?: string | null;
  orgUnitId?: string | null;
}) {
  return apiClient<{ data: FormTemplate }>('/forms/templates', { method: 'POST', body: JSON.stringify(payload) });
}

/** Only valid while the template is still `draft` — a published template uses createFormTemplateVersion() instead. */
export function updateFormTemplateContent(id: string, payload: Partial<{
  name: string; category: string; basePdfObjectKey: string | null; isLetterhead: boolean;
  schemaJson: object; sectionsJson: SectionMeta[]; instanceApproval: 'none' | 'chain';
  auditPolicy: 'required' | 'optional' | 'never'; signingPolicy: 'none' | 'ceremony';
  /** Scope: omit both to keep the current scope; send either (null = cleared) to change it. */
  departmentId: string | null; orgUnitId: string | null;
}>) {
  return apiClient<{ data: FormTemplate }>(`/forms/templates/${id}/content`, { method: 'PATCH', body: JSON.stringify(payload) });
}

/** Clones a published template into a fresh draft revision (version + 1). */
export function createFormTemplateVersion(id: string) {
  return apiClient<{ data: FormTemplate }>(`/forms/templates/${id}/versions`, { method: 'POST' });
}

export function updateFormTemplateStatus(id: string, status: string) {
  return apiClient<{ data: FormTemplate }>(`/forms/templates/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

/** Uploads a base file (PDF, or PNG/JPEG — wrapped into a one-page PDF server-side)
 *  to overlay a template's fields onto; returns the storage key to pass as basePdfObjectKey. */
export function uploadFormBasePdf(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiClient<{ data: { objectKey: string } }>('/forms/templates/base-pdf', { method: 'POST', body: formData });
}

/** The "Use Example Corp Letterhead" quick-pick — resolves to a
 *  well-known object key rather than the author manually uploading it. */
export function getExampleCorpLetterheadObjectKey() {
  return apiClient<{ data: { objectKey: string } }>('/forms/templates/letterhead');
}

export type ExtractedFormField = {
  label: string;
  type: string;
  required: boolean;
  sectionId?: string;
  layoutWidth?: 'full' | 'half' | 'third' | 'quarter';
  options?: string[];
};

/** AI-assisted authoring: upload a photo or PDF of what the form should look
 *  like, get back a proposed field/section list to load into the (still
 *  fully editable) builder — see the backend's formAiExtract.ts for why this
 *  is a proposal to review, never an auto-saved template. Can fail with
 *  ERR-AI-UNAVAILABLE (no provider configured) or ERR-AI-NOT-ENABLED (tenant
 *  hasn't turned on the ai_processing feature flag) — same codes every other
 *  AI feature in this app already surfaces. */
export function extractFormFieldsFromImage(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiClient<{ data: { sections: Array<{ id: string; label: string }>; fields: ExtractedFormField[] } }>(
    '/forms/templates/extract-from-image',
    { method: 'POST', body: formData },
  );
}

/** Renders a live preview of the actual generated PDF for a template still
 *  being authored — same @pdfme/generator pipeline as a real form instance,
 *  but with sample data and no DB writes. Not tied to a saved template id
 *  (works for an in-progress, unsaved template); pass whatever schemaJson/
 *  basePdfObjectKey are currently staged in the builder. Returns a Blob the
 *  caller turns into an object URL (and must revoke when done). Routed
 *  through apiClientBlob (axios) so a token that expired while the template
 *  builder was open gets the same silent-refresh-and-retry every other
 *  request gets, instead of a bare 401. */
export async function previewFormTemplatePdf(payload: {
  schemaJson: object;
  basePdfObjectKey?: string | null;
  isLetterhead?: boolean;
  name?: string;
}): Promise<Blob> {
  return apiClientBlob('/forms/templates/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listFormInstances(
  filters: { createdBy?: string; templateId?: string; status?: string } = {},
  skip = 0,
  take = 25,
) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) query.set(k, v); });
  query.set('skip', String(skip));
  query.set('take', String(take));
  return apiClient<{ data: FormInstanceSummary[]; total: number }>(`/forms/instances?${query.toString()}`);
}

export function getFormInstance(id: string) {
  return apiClient<{ data: FormInstanceSummary }>(`/forms/instances/${id}`);
}

/** The approval chain a filled instance of this template would get, resolved
 *  from the FORM TEMPLATE because the instance does not exist yet.
 *
 *  `departmentId` only scopes role-holder resolution: a role step is
 *  department-scoped at decide time, so the fill modal re-fetches this once the
 *  submitter picks a department, otherwise the "no one holds this role" warning
 *  is answered tenant-wide and can be wrong exactly when it matters. */
export function getFormInstanceApprovalPrefill(templateId: string, departmentId?: string) {
  const query = departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : '';
  return apiClient<{
    instanceApproval: 'none' | 'chain';
    chainTemplateId: string | null;
    chainTemplateName: string | null;
    /** The department the instance will actually be filed under — the caller's
     *  choice when they made one, otherwise the server's own fallback. Scope
     *  every role-holder lookup in the dialog to THIS, not to the raw picker
     *  value, or "Use my primary department" resolves differently on each side. */
    departmentId: string;
    departmentName: string;
    departmentCode: string;
    steps: Array<{
      stepOrder: number;
      stepType: 'REVIEW' | 'APPROVE';
      assignedRole?: string | null;
      assignedUserId?: string | null;
      locked?: boolean;
      slaHours?: number | null;
      roleHolders?: { id: string; firstName: string; lastName: string; email: string }[];
    }>;
  }>(`/forms/templates/${templateId}/approval-prefill${query}`);
}

/** files are keyed by the form field's `name` — only "file"-type fields need an entry.
 *
 *  `approvalSteps` is the author's chosen chain. Omitting it keeps the previous
 *  behaviour exactly (the template's chain recipe, else the engine default) —
 *  passing `{}` is what made every form in the estate land on the hardcoded
 *  single APPROVE/DEPT_MANAGER step regardless of intent. Sent as a JSON string
 *  because this request is multipart (file-type fields ride the same body). */
export function createFormInstance(
  templateId: string,
  dataJson: Record<string, unknown>,
  departmentId?: string,
  files?: Record<string, File>,
  approvalSteps?: SubmitStepInput[],
  /** `saveAsDraft` (chain templates only) files the form as a DRAFT without submitting it; submit it later with
   *  submitForApproval('FORM_INSTANCE', id). Approval steps are chosen at that later submit, so none are sent here. */
  options: { saveAsDraft?: boolean } = {},
) {
  const formData = new FormData();
  formData.append('templateId', templateId);
  formData.append('dataJson', JSON.stringify(dataJson));
  if (departmentId) formData.append('departmentId', departmentId);
  if (options.saveAsDraft) formData.append('saveAsDraft', 'true');
  else if (approvalSteps && approvalSteps.length > 0) formData.append('approvalSteps', JSON.stringify(approvalSteps));
  Object.entries(files ?? {}).forEach(([name, file]) => formData.append(name, file));
  return apiClient<{ data: { id: string; documentId: string | null }; approvalWarning?: string }>('/forms/instances', {
    method: 'POST',
    body: formData,
  });
}

/** Filer-only edit of a form that is still pre-approval (the backing document is DRAFT, CHANGES_REQUESTED or
 *  DECLINED — never IN_REVIEW). Same multipart shape as filing: file fields are optional here, an omitted one keeps
 *  the file already filed. Re-renders the PDF as a new minor version. */
export function updateFormInstance(id: string, dataJson: Record<string, unknown>, files?: Record<string, File>) {
  const formData = new FormData();
  formData.append('dataJson', JSON.stringify(dataJson));
  Object.entries(files ?? {}).forEach(([name, file]) => formData.append(name, file));
  return apiClient<{ data: FormInstanceSummary }>(`/forms/instances/${id}`, { method: 'PATCH', body: formData });
}

/** Recall a form from review (IN_REVIEW -> DRAFT, the running chain is cancelled) so it can be edited and resubmitted. Filer only. */
export function withdrawFormInstance(id: string, reason?: string) {
  return apiClient<{ data: FormInstanceSummary }>(`/forms/instances/${id}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason?.trim() || undefined }),
  });
}

/** Abandon a pre-approval form: its document becomes CANCELLED (terminal). Filer only. */
export function cancelFormInstance(id: string, reason?: string) {
  return apiClient<{ data: FormInstanceSummary }>(`/forms/instances/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason?.trim() || undefined }),
  });
}
