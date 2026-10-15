'use client';

// The author's approval-chain editor, extracted from ApprovalChainCard's
// submit modal so the two places a chain is chosen cannot drift.
//
// Why it was extracted: filling a form never offered this at all —
// forms.service.ts's `fillForm` called `submitForApproval(..., {}, user)` with
// an empty step list, so every form chain in the estate collapsed onto the
// engine's hardcoded single [{ APPROVE, DEPT_MANAGER }] default no matter who
// the submitter actually wanted. The engine has always supported author-chosen
// users and roles (documents and letters both use it); only the forms path
// never passed any. Copying the editor into FillFormModal would have created a
// second implementation of rules the engine enforces exactly once — the same
// mirror-and-drift problem R-08 removed from the approval engines — so it
// lives here and both callers render it.
//
// The two selection scopes are the product rule, not an implementation detail:
//   * a NAMED person is tenant-global. The candidate list is deliberately not
//     department-filtered; picking someone outside the item's department is
//     allowed and only draws a non-blocking advisory (AssignmentAdvisoryNotice),
//     because the engine grants that assignee a document:read ACL entry when
//     the step is created (approvals.service.ts's grantChainParticipantAcl).
//   * a ROLE is department-scoped. `roleHolders` on a step, when present,
//     came from a prefill that resolved holders against the item's own
//     department — the same membership check assertStepIsActionable enforces
//     at decide time (ERR-STEP-DEPT-SCOPE). A role the author freely picks from
//     the dropdown has no per-step scoped data yet and falls back to the
//     tenant-wide map, which is clearly the coarser "who holds this anywhere"
//     signal.
//
// Presentational: it owns no fetching and no submit. Callers supply the
// candidate lists and hold the `steps` state, because the two hosts source
// their prefill differently (an item id for the engine, a form template id for
// a not-yet-existing instance).

import { Lock, Plus, Trash2 } from 'lucide-react';
import { AssignmentAdvisoryNotice } from '../../shared/components/AssignmentAdvisoryNotice';
import type { AclResourceType } from '../../shared/lib/assignmentAdvisory';
import type { SubmitStepInput, UserSummary } from './api';

/** A step as the editor holds it: the engine's submit shape plus the two
 *  display-only fields that never reach the API (`locked` is stripped by the
 *  caller before submit; `roleHolders` only drives the warning text). */
export type EditableStep = SubmitStepInput & { locked?: boolean; roleHolders?: UserSummary[] };

export function roleHolderNames(holders: UserSummary[] | undefined): string {
  return (holders ?? []).map((h) => `${h.firstName} ${h.lastName}`).join(', ');
}

/** Strip the editor-only fields and resolve the user/role exclusivity the
 *  backend requires (each step carries exactly one of the two). Both hosts
 *  send through this, so neither can post a shape the engine rejects. */
export function toSubmitSteps(steps: EditableStep[]): SubmitStepInput[] {
  return steps.map(({ locked: _locked, roleHolders: _holders, ...s }) => ({
    ...s,
    assignedRole: s.assignedUserId ? undefined : s.assignedRole,
  }));
}

export function ApprovalStepsEditor({
  steps,
  onChange,
  users,
  roleOptions,
  unstaffedRoles,
  departmentLabel = 'this department',
  roleHoldersMap,
  departmentId,
  resourceType,
  resourceId,
  disabled = false,
  idPrefix = 'approval-step',
}: {
  steps: EditableStep[];
  onChange: (next: EditableStep[]) => void;
  /** Tenant-wide candidates for a named assignment — see the scope note above. */
  users: UserSummary[];
  roleOptions: string[];
  /** Roles the backend would refuse for THIS item as ERR-STEP-ROLE-UNSTAFFED —
   *  nobody holding them qualifies in the item's department. Advisory input to
   *  the label only; the parent decides whether to block submitting, because
   *  an empty/absent set legitimately means "not asked" as well as "all fine". */
  unstaffedRoles?: Set<string>;
  /** Department name for that label, so it reads "nobody in Audit". */
  departmentLabel?: string;
  /** Tenant-wide role holders, the fallback when a step has no scoped `roleHolders`. */
  roleHoldersMap: Record<string, UserSummary[]>;
  /** The item's own department. Drives only the cross-department advisory;
   *  omitting it suppresses that half of the warning and never changes who
   *  may be assigned. */
  departmentId?: string | null;
  resourceType: AclResourceType;
  /** null when there is no ACL row to resolve yet (a form template, or an
   *  instance that has not been filed) — the advisory then renders its
   *  department half only. */
  resourceId: string | null;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const update = (idx: number, patch: Partial<EditableStep>) =>
    onChange(steps.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  return (
    <>
      <ul className="space-y-2 mb-4">
        {steps.map((s, idx) => (
          <li key={idx} className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
            <span className="text-[12px] font-mono w-6">#{idx + 1}</span>
            {s.locked ? (
              <>
                <Lock className="h-3.5 w-3.5 text-slate-500" />
                <span className="text-[13px] font-medium">{s.stepType === 'APPROVE' ? 'Approve' : 'Review'}</span>
                <span className="text-[12px] text-text-muted">
                  {s.assignedUserId
                    ? (() => {
                        const u = users.find((x) => x.id === s.assignedUserId);
                        return u ? `${u.firstName} ${u.lastName} (${u.email})` : 'named user';
                      })()
                    : s.assignedRole?.replace(/_/g, ' ')}
                </span>
                <span className="ml-auto text-[10px] uppercase font-bold text-slate-400">mandatory</span>
                {!s.assignedUserId && s.assignedRole && (() => {
                  const holders = s.roleHolders ?? roleHoldersMap[s.assignedRole];
                  return (
                    <span className="basis-full text-[11px] pl-5" style={holders?.length ? { color: 'var(--text-muted)' } : { color: '#d97706' }}>
                      {holders?.length
                        ? `Assigned approver: ${roleHolderNames(holders)}`
                        : 'No one currently holds this role — assign it before submitting or it will stall.'}
                    </span>
                  );
                })()}
              </>
            ) : (
              <>
                <select
                  aria-label={`Step ${idx + 1} type`}
                  data-testid={`${idPrefix}-${idx}-type`}
                  value={s.stepType}
                  disabled={disabled}
                  onChange={(e) => update(idx, { stepType: e.target.value as 'REVIEW' | 'APPROVE' })}
                  className="ui-input !w-auto text-xs"
                >
                  <option value="REVIEW">Review</option>
                  <option value="APPROVE">Approve</option>
                </select>
                <select
                  aria-label={`Step ${idx + 1} role`}
                  data-testid={`${idPrefix}-${idx}-role`}
                  value={s.assignedRole ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(idx, { assignedRole: e.target.value || undefined, assignedUserId: undefined, roleHolders: undefined })}
                  className="ui-input !w-auto text-xs"
                >
                  <option value="">— role —</option>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}{unstaffedRoles?.has(r) ? ` — nobody in ${departmentLabel}` : ''}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Step ${idx + 1} named person`}
                  data-testid={`${idPrefix}-${idx}-user`}
                  value={s.assignedUserId ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(idx, { assignedUserId: e.target.value || undefined, assignedRole: e.target.value ? undefined : s.assignedRole })}
                  className="ui-input !w-auto text-xs"
                >
                  <option value="">— or a named person —</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>)}
                </select>
                <button
                  onClick={() => onChange(steps.filter((_x, i) => i !== idx))}
                  disabled={disabled}
                  className="ml-auto p-1 text-slate-400 hover:text-red-600"
                  aria-label="Remove step"
                  data-testid={`${idPrefix}-${idx}-remove`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {s.assignedRole && !s.assignedUserId && (() => {
                  const holders = s.roleHolders ?? roleHoldersMap[s.assignedRole];
                  return (
                    <span className="basis-full text-[11px] pl-1" style={holders?.length ? { color: 'var(--text-muted)' } : { color: '#d97706' }}>
                      {holders?.length
                        ? `Currently held by: ${roleHolderNames(holders)}`
                        : 'No one currently holds this role — pick a named person instead.'}
                    </span>
                  );
                })()}
                {s.assignedUserId && (() => {
                  const picked = users.find((u) => u.id === s.assignedUserId);
                  return (
                    <div className="basis-full pl-1">
                      <AssignmentAdvisoryNotice
                        candidateUserId={s.assignedUserId}
                        candidateDepartments={picked?.departments}
                        candidateLabel={picked ? `${picked.firstName} ${picked.lastName}` : undefined}
                        departmentId={departmentId}
                        resourceType={resourceType}
                        resourceId={resourceId}
                      />
                    </div>
                  );
                })()}
              </>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={() => onChange([...steps, { stepType: 'REVIEW', assignedRole: 'DEPT_MANAGER' }])}
        disabled={disabled}
        className="ui-btn ui-btn-secondary text-xs"
        data-testid={`${idPrefix}-add`}
      >
        <Plus className="h-3.5 w-3.5" /> Add step
      </button>
    </>
  );
}
