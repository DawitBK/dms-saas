'use client';

// "Who can use this" selector: Whole organisation / Organisation unit / Department.
// Used for form templates (template builder) and for approval recipes (Operations -> Approval chains).
//
// A person without organisation-level authority is offered Department only, and only the departments they belong to;
// organisation-level people see everything. The server enforces the same rule (ERR-FORM-SCOPE-REQUIRED / ERR-FORM-SCOPE).

import { useMemo } from 'react';
import { useDepartments, useOrgUnits } from '../../../shared/hooks/useLookups';
import { useMyDepartments } from '../../../shared/hooks/useMyDepartments';
import {
  SCOPE_KIND_LABEL, allowedScopeKinds, scopeProblem, type ScopeKind, type ScopeSelection,
} from '../templateScope';

export function ScopeSelect({
  value,
  onChange,
  orgLevel,
  idPrefix,
  label = 'Who can use this form',
  hint,
  disabled,
}: {
  value: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  /** Organisation-level authority (see hasOrgLevelAuthority). */
  orgLevel: boolean;
  idPrefix: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { data: allDepartments } = useDepartments();
  const { data: orgUnits } = useOrgUnits();
  // Only fetched for people who are limited to their own departments.
  const { myDepartmentIds } = useMyDepartments(!orgLevel);

  const kinds = allowedScopeKinds(orgLevel);
  const departments = useMemo(
    () => (orgLevel ? (allDepartments ?? []) : (allDepartments ?? []).filter((d) => myDepartmentIds.has(d.id))),
    [orgLevel, allDepartments, myDepartmentIds],
  );
  const unitName = useMemo(() => new Map((orgUnits ?? []).map((u) => [u.id, u.name])), [orgUnits]);
  const problem = scopeProblem(value);

  return (
    <div data-testid={`${idPrefix}-scope`}>
      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }} htmlFor={`${idPrefix}-scope-kind`}>
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        {kinds.length > 1 ? (
          <select
            id={`${idPrefix}-scope-kind`}
            className="ui-input !w-auto text-sm"
            value={value.kind}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, kind: e.target.value as ScopeKind })}
          >
            {kinds.map((k) => <option key={k} value={k}>{SCOPE_KIND_LABEL[k]}</option>)}
          </select>
        ) : (
          <span id={`${idPrefix}-scope-kind`} className="ui-input !w-auto text-sm inline-flex items-center" style={{ opacity: 0.8 }}>
            {SCOPE_KIND_LABEL[kinds[0]!]}
          </span>
        )}
        {value.kind === 'orgunit' && (
          <select
            aria-label="Organisation unit"
            className="ui-input !w-auto text-sm min-w-[12rem]"
            value={value.orgUnitId}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, orgUnitId: e.target.value })}
          >
            <option value="">Select an organisation unit…</option>
            {(orgUnits ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        {value.kind === 'department' && (
          <select
            aria-label="Department"
            className="ui-input !w-auto text-sm min-w-[12rem]"
            value={value.departmentId}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, departmentId: e.target.value })}
          >
            <option value="">{departments.length === 0 ? 'No departments available' : 'Select a department…'}</option>
            {departments.map((d) => {
              const unit = d.orgUnitId ? unitName.get(d.orgUnitId) : undefined;
              return <option key={d.id} value={d.id}>{unit ? `${unit} / ` : ''}{d.code} - {d.name}</option>;
            })}
          </select>
        )}
      </div>
      <p className="text-[11px] mt-1" style={{ color: problem ? 'var(--color-amber-500)' : 'var(--text-muted)' }}>
        {problem
          ?? hint
          ?? (value.kind === 'organisation'
            ? 'Everyone in the organisation can use it.'
            : value.kind === 'orgunit'
              ? 'Everyone in this organisation unit can use it.'
              : 'Only members of this department can use it.')}
        {!orgLevel && !problem && ' Without organisation-level authority you can only choose a department you belong to.'}
      </p>
    </div>
  );
}
