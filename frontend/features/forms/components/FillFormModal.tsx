'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FieldSchema, SectionMeta } from '../schema';
import { evaluateVisibility, validateAll, applyComputedFields, LAYOUT_WIDTH_SPAN, UNSECTIONED_ID } from '../schema';
import { useModalA11y } from '../../../shared/hooks/useModalA11y';
import { withBasePath } from '../../../shared/lib/basePath';
import { apiClient } from '../../../shared/lib/apiClient';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { useAssignableRoles } from '../../../shared/lib/assignmentAdvisory';
import { ApprovalStepsEditor, toSubmitSteps, type EditableStep } from '../../approvals/ApprovalStepsEditor';
import { getRoleHolders, type SubmitStepInput, type UserSummary } from '../../approvals/api';
import { getFormInstanceApprovalPrefill } from '../api';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';
import { useOrgUnits } from '../../../shared/hooks/useLookups';
import { useAuthStore } from '../../../state/auth.store';

// Auto-fill fields that are unmistakably asking for the submitter's OWN
// identity — full name, email, department — from their DMS profile, so they
// don't have to retype the same things on every form. Deliberately
// conservative: only fires for a label that clearly means "you, the person
// filling this out" (an unqualified "Name"/"Email"/"Department", or one
// explicitly prefixed "employee"/"your"/"my"/"applicant"/etc) and explicitly
// skips anything that could belong to someone ELSE named on the form (a
// manager, approver, witness, HR contact...) — silently filling a THIRD
// PARTY's field with the submitter's own name would corrupt the record,
// which is worse than leaving it blank for them to type themselves.
//
// Deliberately NOT extended to "Position"/"Employee ID"/"Job Title": the
// User model has only name, email, department, and role today — there is no
// such data anywhere to fetch. Adding those would mean adding new profile
// fields first, a separate change from wiring up what already exists.
const THIRD_PARTY_LABEL_RE = /\b(manager|supervisor|approv|witness|reference|referee|contact|recipient|sender|guarantor|spouse|emergency|next of kin|guardian|parent|colleague|human resources)\b|(?<!\bmy )\bhr\b/i;
const SELF_NAME_LABEL_RE = /^(name|employee name|your name|my name|full name|applicant name|requester name|requestor name|staff name|signee name)$/i;
const SELF_EMAIL_LABEL_RE = /^(email|email address|your email|my email)$/i;
const DEPARTMENT_LABEL_RE = /\bdepartment\b/i;

function computeSelfPrefill(
  fields: FieldSchema[],
  fullName: string,
  email: string | undefined,
  primaryDepartmentName: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.type !== 'text' && f.type !== 'email') continue;
    const label = (f.title ?? f.name).trim();
    if (THIRD_PARTY_LABEL_RE.test(label)) continue;
    if (fullName && SELF_NAME_LABEL_RE.test(label)) out[f.name] = fullName;
    else if (email && SELF_EMAIL_LABEL_RE.test(label)) out[f.name] = email;
    else if (primaryDepartmentName && DEPARTMENT_LABEL_RE.test(label)) out[f.name] = primaryDepartmentName;
  }
  return out;
}

// The real Example Corp letterhead artwork (backend/assets/letterheads/
// examplecorp-group-letterhead.pdf), rasterized via
// backend/scripts/rasterize-letterhead.mjs and checked in as a static asset —
// NOT a hand-drawn recreation. Cropped via aspect-ratio + background-position
// below using the exact same LETTERHEAD_TOP_MM/LETTERHEAD_BOTTOM_MM bands
// letterPdf.ts and this template's real generated PDF use, so this preview
// shows what the actual artwork looks like instead of an invented substitute.
const LETTERHEAD_IMAGE = withBasePath('/letterhead/examplecorp-group-letterhead.png');
const LETTERHEAD_HEADER_ASPECT = '210 / 65';
const LETTERHEAD_FOOTER_ASPECT = '210 / 44';

interface FillTemplate {
  id: string;
  name: string;
  basePdfObjectKey?: string | null;
  isLetterhead?: boolean;
  schemaJson?: FieldSchema[][];
  sectionsJson?: SectionMeta[] | null;
  /** 'chain' means a filled instance goes through the approval engine — the
   *  only case where choosing approvers is meaningful, and the only case the
   *  backend accepts `approvalSteps` for. */
  instanceApproval?: 'none' | 'chain';
}

type FillPayload = { dataJson: Record<string, string>; departmentId?: string; files: Record<string, File>; approvalSteps?: SubmitStepInput[] };

/** A file field's stored value on a filed form: the attachment document and its original name. */
function storedFileName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { documentId?: unknown; fileName?: unknown };
  return v.documentId ? String(v.fileName ?? 'Attached file') : null;
}

export function FillFormModal({
  template,
  departments,
  onClose,
  onSubmit,
  onSaveDraft,
  isSubmitting,
  existingInstance,
}: {
  template: FillTemplate;
  departments: { id: string; code: string; name: string; orgUnitId?: string | null }[];
  onClose: () => void;
  onSubmit: (payload: FillPayload) => void;
  /** Chain templates only: file the form as a DRAFT without submitting it (the filer submits it later from My
   *  submissions). Ignored when editing an existing instance. */
  onSaveDraft?: (payload: FillPayload) => void;
  isSubmitting: boolean;
  /** Edit mode: the filer's own pre-approval instance. The form opens with its saved answers; a file field shows the
   *  file already filed and is only re-uploaded if the person picks a new one. The department and the approvers are
   *  not editable here (they were fixed when the form was filed; approvers are chosen at submit). */
  existingInstance?: { id: string; dataJson: Record<string, unknown> };
}) {
  const editing = Boolean(existingInstance);
  // Flatten every page — mirrors the backend's allFields = schemaJson.flat()
  // (forms.service.ts createFormInstance/buildZodSchemaFromTemplate). Reading
  // only page 0 here would silently drop page 2+ fields from the fill form
  // while the backend still validates/renders them, failing every submission.
  const fields = (template.schemaJson ?? []).flat() as FieldSchema[];
  const sections = template.sectionsJson ?? [];
  // The generated/downloaded PDF for a letterhead template carries the real
  // Example Corp header/footer artwork — without any echo of that here,
  // filling the form looked like a bare internal web form with no hint of
  // what the final branded document will actually look like.
  const isLetterhead = Boolean(template.basePdfObjectKey) && Boolean(template.isLetterhead);
  const { firstName, lastName, email } = useAuthStore();
  // Files already filed on the instance being edited, by field name (kept unless a new file is picked).
  // The modal is mounted per edit, so the instance never changes for its lifetime.
  const [existingFiles] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (!existingInstance) return out;
    for (const f of fields) {
      if (f.type !== 'file') continue;
      const name = storedFileName(existingInstance.dataJson[f.name]);
      if (name) out[f.name] = name;
    }
    return out;
  });
  const [fillData, setFillData] = useState<Record<string, string>>(() => {
    if (existingInstance) {
      const saved: Record<string, string> = {};
      for (const f of fields) {
        const v = existingInstance.dataJson[f.name];
        if (f.type === 'file' || v === undefined || v === null || typeof v === 'object') continue;
        saved[f.name] = String(v);
      }
      return saved;
    }
    return computeSelfPrefill(fields, `${firstName ?? ''} ${lastName ?? ''}`.trim(), email ?? undefined, departments[0]?.name);
  });
  const [fileValues, setFileValues] = useState<Record<string, File>>({});
  const [departmentId, setDepartmentId] = useState('');
  const [touched, setTouched] = useState<Set<string>>(new Set());

  // Org unit is a label here only — `departments` is already narrowed to the
  // caller's own memberships by the parent page, same as Upload/Signing's
  // pickers — this just disambiguates same-named/coded departments the user
  // belongs to across different org units.
  const { data: orgUnits } = useOrgUnits();
  const departmentGroups = useMemo(() => {
    const nameById = new Map((orgUnits ?? []).map((u) => [u.id, u.name]));
    const groups = new Map<string, typeof departments>();
    for (const d of departments) {
      const label = (d.orgUnitId && nameById.get(d.orgUnitId)) || 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(d);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [departments, orgUnits]);

  // ── Who approves this submission ─────────────────────────────────────────
  //
  // This whole section is the fix for the forms gap: `fillForm` used to call
  // submitForApproval with an EMPTY step list, so every form chain in the
  // estate collapsed onto the engine's hardcoded [{ APPROVE, DEPT_MANAGER }]
  // default and the submitter had no say at all. The engine always supported
  // author-chosen users and roles — documents and letters both use it — so
  // this offers the same editor, not a second implementation of it.
  //
  // Only meaningful for a 'chain' template: a 'none' template files the
  // instance with no chain, and the backend rejects approvalSteps for it
  // (ERR-FORM-APPROVAL-NOT-USED).
  const isChainTemplate = template.instanceApproval === 'chain';
  // Approvers are not part of an edit: they are chosen when the form is (re)submitted.
  const usesChain = isChainTemplate && !editing;
  const [approvalSteps, setApprovalSteps] = useState<EditableStep[]>([]);
  // Only overwrite the author's edits when the PREFILL ITSELF changes, never on
  // every render — the prefill re-fetches whenever the department changes (for
  // role-holder scoping), and clobbering hand-picked approvers on a department
  // change would silently discard their choices.
  const [prefillApplied, setPrefillApplied] = useState<string | null>(null);

  const { data: prefill } = useQuery({
    queryKey: ['forms', 'approval-prefill', template.id, departmentId],
    queryFn: () => getFormInstanceApprovalPrefill(template.id, departmentId || undefined),
    enabled: usesChain,
    staleTime: 60_000,
  });

  // Applied during render rather than in an effect: this is derived from the
  // prefill query's data, and doing it in an effect painted the chain editor
  // once with the previous (or empty) steps before filling them in.
  // react-hooks/set-state-in-effect rejects the effect form under
  // eslint-config-next 16. The `prefillApplied` key still guards against
  // re-applying over steps the author has edited.
  useResetOnChange([prefill, prefillApplied], () => {
    if (!prefill || prefill.instanceApproval !== 'chain') return;
    // Keyed on the recipe, not the department: a department change re-resolves
    // role holders but must not reset steps the author already edited.
    const key = prefill.chainTemplateId ?? 'engine-default';
    if (prefillApplied === key) return;
    setApprovalSteps(
      prefill.steps.map((st) => ({
        stepType: st.stepType,
        assignedRole: st.assignedRole ?? undefined,
        assignedUserId: st.assignedUserId ?? undefined,
        slaHours: st.slaHours ?? undefined,
        locked: st.locked ?? false,
        roleHolders: st.roleHolders,
      })),
    );
    setPrefillApplied(key);
  });

  // Department-scoped holder names for the steps the author picks fresh from
  // the dropdown (the prefill only carries them for the steps it supplied).
  // Re-resolved against the chosen department for the same reason the prefill
  // is: a role step is department-scoped at decide time.
  const effectiveDepartmentId = prefill?.departmentId;
  const { names: roleOptions, unstaffed: unstaffedRoles } = useAssignableRoles(
    PERMISSIONS.APPROVAL_DECIDE,
    ['DEPT_MANAGER', 'APPROVER', 'RECORDS_OFFICER', 'SYSTEM_ADMIN'],
    effectiveDepartmentId,
  );
  // Scoped to the department the form will ACTUALLY be filed under, which the
  // prefill resolves server-side — not to the raw picker value, because "Use my
  // primary department" is an empty value here and a real department there.
  //
  // This was a genuine defect, not a nicety: resolved tenant-wide, the dialog
  // reported every role as staffed in every department. The author picked one,
  // the PDF rendered, the instance was filed — and only then did the engine
  // refuse the chain with ERR-STEP-ROLE-UNSTAFFED, leaving a filed form with no
  // approval chain and no way to add one.
  const { data: roleHoldersData } = useQuery({
    queryKey: ['role-holders', roleOptions, effectiveDepartmentId],
    queryFn: () => getRoleHolders(roleOptions, effectiveDepartmentId),
    enabled: usesChain && roleOptions.length > 0 && Boolean(effectiveDepartmentId),
    staleTime: 60_000,
  });

  // Named approvers are TENANT-GLOBAL by design — this list is deliberately not
  // department-filtered. Picking someone outside the form's department is
  // allowed and only draws an advisory, because the engine grants a named
  // assignee a document:read ACL entry when the step is created.
  const { data: assignableUsersData } = useQuery({
    queryKey: ['assignable-users', 'decide'],
    queryFn: () => apiClient<{ data: UserSummary[] }>('/approvals/assignable-users?capability=decide'),
    enabled: usesChain,
    staleTime: 60_000,
  });

  // Mirrors the engine's own submit rule (approvals.service.ts) so the author
  // is told here rather than losing a filled form to a 422 after the PDF has
  // already been rendered.
  const chainError = !usesChain
    ? undefined
    : approvalSteps.length === 0
      ? 'Add at least one approval step.'
      : approvalSteps[approvalSteps.length - 1]!.stepType !== 'APPROVE'
        ? 'The last step must be an Approve.'
        : approvalSteps.some((st) => Boolean(st.assignedUserId) === Boolean(st.assignedRole))
          ? 'Every step needs exactly one of a role or a named person.'
          : approvalSteps.some((st) => !st.assignedUserId && st.assignedRole && unstaffedRoles.has(st.assignedRole))
            ? 'A step is assigned to a role with nobody in this form’s department. Pick a named person, or another role.'
            : undefined;

  // Mounted only while open (the parent conditionally renders this component),
  // so `isOpen` is always true for the lifetime of this instance.
  useModalA11y(true, onClose);

  // Computed fields (e.g. "No of days" derived from "Request from"/"Request
  // to") are never taken from fillData directly — they're always re-derived
  // from whatever the submitter has entered so far, so the displayed value,
  // the validated value, and the submitted value can never drift apart or
  // go stale. See schema.ts's applyComputedFields/computeFieldValue.
  const effectiveFillData = useMemo(() => applyComputedFields(fields, fillData), [fields, fillData]);
  const visibleFields = useMemo(() => fields.filter((f) => evaluateVisibility(f, effectiveFillData)), [fields, effectiveFillData]);
  // File fields carry their presence in fileValues, not fillData — override
  // the shared (backend-mirroring) validator's "required" check for them here.
  const errors = useMemo(() => {
    const base = validateAll(fields, effectiveFillData);
    for (const f of visibleFields) {
      if (f.type !== 'file') continue;
      if (fileValues[f.name] || existingFiles[f.name]) delete base[f.name];
      else if (f.required) base[f.name] = 'A file is required';
      else delete base[f.name];
    }
    return base;
  }, [fields, effectiveFillData, visibleFields, fileValues, existingFiles]);
  const visibleFieldNames = new Set(visibleFields.map((f) => f.name));
  const blockingErrors = Object.entries(errors).filter(([name]) => visibleFieldNames.has(name));
  // A draft is not submitted, so the approval chain below does not have to be valid yet.
  const canSaveDraft = blockingErrors.length === 0 && !isSubmitting;
  const canSubmit = canSaveDraft && !chainError;
  const buildPayload = (): FillPayload => ({
    dataJson: effectiveFillData,
    departmentId: departmentId || undefined,
    files: fileValues,
    approvalSteps: usesChain ? toSubmitSteps(approvalSteps) : undefined,
  });

  const setValue = (name: string, value: string) => {
    setFillData((d) => ({ ...d, [name]: value }));
    setTouched((t) => new Set(t).add(name));
  };
  const setFile = (name: string, file: File | undefined) => {
    setFileValues((f) => {
      if (!file) { const next = { ...f }; delete next[name]; return next; }
      return { ...f, [name]: file };
    });
    setTouched((t) => new Set(t).add(name));
  };

  const fieldsBySection = useMemo(() => {
    const grouped = new Map<string, FieldSchema[]>();
    for (const f of visibleFields) {
      const key = f.section ?? UNSECTIONED_ID;
      grouped.set(key, [...(grouped.get(key) ?? []), f]);
    }
    return grouped;
  }, [visibleFields]);

  const renderInput = (f: FieldSchema) => {
    // Computed fields are never typed into directly — see schema.ts's
    // computeFieldValue. Shown read-only so it's obvious to the submitter
    // this is derived, not something they forgot to fill in.
    if (f.computed) {
      const value = effectiveFillData[f.name];
      return (
        <input
          type="text"
          value={value ?? ''}
          readOnly
          disabled
          placeholder="Calculated automatically"
          className="ui-input mt-1 w-full"
          style={{ background: 'var(--surface-muted, #f3f4f6)', color: 'var(--text-secondary)' }}
        />
      );
    }
    if (f.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={fillData[f.name] === 'true'}
          onChange={(e) => setValue(f.name, String(e.target.checked))}
          className="mt-2"
        />
      );
    }
    if (f.type === 'select') {
      return (
        <select className="ui-input mt-1 w-full" value={fillData[f.name] ?? ''} onChange={(e) => setValue(f.name, e.target.value)}>
          <option value="">Select...</option>
          {(f.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
    }
    if (f.type === 'radio') {
      return (
        <div className="mt-1 flex flex-wrap gap-3">
          {(f.options ?? []).map((opt) => (
            <label key={opt} className="flex items-center gap-1 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input type="radio" name={f.name} checked={fillData[f.name] === opt} onChange={() => setValue(f.name, opt)} /> {opt}
            </label>
          ))}
        </div>
      );
    }
    if (f.type === 'textarea') {
      return (
        <textarea
          value={fillData[f.name] ?? ''}
          onChange={(e) => setValue(f.name, e.target.value)}
          onBlur={() => setTouched((t) => new Set(t).add(f.name))}
          rows={3}
          className="ui-input mt-1 w-full"
        />
      );
    }
    if (f.type === 'file') {
      return (
        <div className="mt-1">
          <input
            type="file"
            className="ui-input w-full"
            onChange={(e) => setFile(f.name, e.target.files?.[0])}
          />
          {fileValues[f.name] ? (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {fileValues[f.name].name} ({(fileValues[f.name].size / 1024).toFixed(0)} KB)
            </p>
          ) : existingFiles[f.name] ? (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid={`existing-file-${f.name}`}>
              Currently filed: {existingFiles[f.name]}. Choose a file only if you want to replace it.
            </p>
          ) : null}
        </div>
      );
    }
    return (
      <input
        type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
        value={fillData[f.name] ?? ''}
        onChange={(e) => setValue(f.name, e.target.value)}
        onBlur={() => setTouched((t) => new Set(t).add(f.name))}
        className="ui-input mt-1 w-full"
      />
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.5)' }}>
      <div className="rounded-xl w-full max-w-2xl shadow-xl max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface-raised)' }} role="dialog" aria-modal="true" aria-labelledby="fill-form-modal-title">
        {isLetterhead && (
          <div
            className="rounded-t-xl"
            style={{
              backgroundImage: `url('${LETTERHEAD_IMAGE}')`,
              backgroundSize: '100% auto',
              backgroundPosition: 'top',
              backgroundRepeat: 'no-repeat',
              aspectRatio: LETTERHEAD_HEADER_ASPECT,
            }}
            role="img"
            aria-label="Example Corp letterhead"
          />
        )}
        <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="fill-form-modal-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{editing ? 'Edit' : 'Fill'} {template.name}</h2>
          <button onClick={onClose} className="text-sm" style={{ color: 'var(--text-muted)' }}>Close</button>
        </div>
        {editing ? (
          <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
            Saving re-generates the PDF as a new version. The department and the approvers are not changed here; you
            choose the approvers when you submit the form for approval.
          </p>
        ) : (
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="ui-input w-full mb-3">
            <option value="">Use my primary department</option>
            {departmentGroups.length > 1
              ? departmentGroups.map(([orgUnitName, depts]) => (
                  <optgroup key={orgUnitName} label={orgUnitName}>
                    {depts.map((d) => <option key={d.id} value={d.id}>{d.code} - {d.name}</option>)}
                  </optgroup>
                ))
              : departments.map((d) => <option key={d.id} value={d.id}>{d.code} - {d.name}</option>)}
          </select>
        )}

        {[UNSECTIONED_ID, ...sections.map((s) => s.id)].map((sectionKey) => {
          const sectionFields = fieldsBySection.get(sectionKey) ?? [];
          if (sectionFields.length === 0) return null;
          const sectionLabel = sectionKey === UNSECTIONED_ID ? 'General' : sections.find((s) => s.id === sectionKey)?.label;
          return (
            <fieldset key={sectionKey} className="mb-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
              {sections.length > 0 && (
                <legend className="text-xs font-bold uppercase px-1" style={{ color: 'var(--text-muted)' }}>{sectionLabel}</legend>
              )}
              <div className="grid grid-cols-12 gap-x-3 gap-y-3">
                {sectionFields.map((f) => {
                  const error = touched.has(f.name) ? errors[f.name] : undefined;
                  const span = LAYOUT_WIDTH_SPAN[f.layoutWidth ?? 'full'];
                  return (
                    <label key={f.name} className="block min-w-0" style={{ gridColumn: `span ${span} / span ${span}` }}>
                      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {f.title ?? f.name}{f.required ? ' *' : ''}
                      </span>
                      {renderInput(f)}
                      {error && <p className="mt-1 text-xs" style={{ color: 'var(--color-red-400)' }}>{error}</p>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        {usesChain && (
          <fieldset className="mb-4 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }} data-testid="form-approval-chain">
            <legend className="text-xs font-bold uppercase px-1" style={{ color: 'var(--text-muted)' }}>Who approves this</legend>
            <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
              Steps run one at a time, top to bottom, and the last one must be an Approve.
              A <strong>role</strong> is scoped to{' '}
              {prefill?.departmentCode ? <strong>{prefill.departmentCode}</strong> : 'this form’s department'}
              {' '}— whoever holds it there acts on it.
              A <strong>named person</strong> is chosen from the whole organisation; picking someone outside
              the department is allowed and they are granted access to this submission.
              {prefill?.chainTemplateName ? ` Pre-filled from “${prefill.chainTemplateName}”.` : ''}
            </p>
            <ApprovalStepsEditor
              steps={approvalSteps}
              onChange={setApprovalSteps}
              users={assignableUsersData?.data ?? []}
              roleOptions={roleOptions}
              unstaffedRoles={unstaffedRoles}
              roleHoldersMap={roleHoldersData?.data ?? {}}
              departmentId={departmentId || null}
              resourceType="document"
              // The instance has not been filed yet, so there is no document to
              // resolve an ACL against — the advisory renders its department
              // half only.
              resourceId={null}
              disabled={isSubmitting}
              idPrefix="form-approval-step"
            />
            {chainError && (
              <p className="mt-2 text-xs" style={{ color: 'var(--color-red-400)' }} data-testid="form-approval-chain-error">{chainError}</p>
            )}
          </fieldset>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">Cancel</button>
          {isChainTemplate && !editing && onSaveDraft && (
            <button
              onClick={() => {
                setTouched(new Set(fields.map((f) => f.name)));
                if (!canSaveDraft) return;
                // Approvers are chosen when the draft is submitted, so none are sent with it.
                onSaveDraft({ ...buildPayload(), approvalSteps: undefined });
              }}
              disabled={!canSaveDraft}
              className="ui-btn ui-btn-secondary"
              title="File the form without sending it for approval. You can edit it and submit it later from My submissions."
              data-testid="form-save-draft"
            >
              Save as draft
            </button>
          )}
          <button
            onClick={() => {
              setTouched(new Set(fields.map((f) => f.name)));
              if (!canSubmit) return;
              onSubmit(buildPayload());
            }}
            disabled={!canSubmit}
            className="ui-btn ui-btn-primary"
          >
            {editing ? 'Save changes' : 'Generate PDF document'}
          </button>
        </div>
        </div>
        {isLetterhead && (
          <div
            className="rounded-b-xl border-t"
            style={{
              backgroundImage: `url('${LETTERHEAD_IMAGE}')`,
              backgroundSize: '100% auto',
              backgroundPosition: 'bottom',
              backgroundRepeat: 'no-repeat',
              aspectRatio: LETTERHEAD_FOOTER_ASPECT,
              borderColor: 'var(--border)',
            }}
            role="img"
            aria-label="Example Corp letterhead footer"
          />
        )}
      </div>
    </div>
  );
}
