// "Who can use this form": a form template is scoped to the whole organisation, to one organisation unit, or to one
// department. Pure helpers shared by the template builder, the templates list and the fill flow.
//
// Backend rules (forms.service.ts / formTemplateScope.ts): a person WITHOUT organisation-level authority must pick a
// department they belong to (ERR-FORM-SCOPE-REQUIRED / ERR-FORM-SCOPE); organisation-level people may choose the whole
// organisation, an organisation unit, or a department. Both ids null = the whole organisation.

import { PERMISSIONS } from '../../shared/lib/permissions';
import { scopeKindOf, type ScopeKind } from '../approvals/api';

export type { ScopeKind };

export type ScopeSelection = {
  kind: ScopeKind;
  orgUnitId: string;
  departmentId: string;
};

/** Organisation-level authority: acl:bypass_admin, orgunit:manage or document:read_all. */
export function hasOrgLevelAuthority(can: (permission: string) => boolean): boolean {
  return can(PERMISSIONS.ACL_BYPASS_ADMIN) || can(PERMISSIONS.ORG_UNIT_MANAGE) || can(PERMISSIONS.DOCUMENT_READ_ALL);
}

/** The scope choices a person is offered. Without organisation-level authority only Department is allowed. */
export function allowedScopeKinds(orgLevel: boolean): ScopeKind[] {
  return orgLevel ? ['organisation', 'orgunit', 'department'] : ['department'];
}

export const SCOPE_KIND_LABEL: Record<ScopeKind, string> = {
  organisation: 'Whole organisation',
  orgunit: 'Organisation unit',
  department: 'Department',
};

/** The selection a template already has, or the default for a new one. */
export function initialScope(
  template: { departmentId?: string | null; orgUnitId?: string | null } | undefined,
  orgLevel: boolean,
  onlyDepartmentId?: string,
): ScopeSelection {
  if (template) {
    const kind = scopeKindOf(template);
    if (allowedScopeKinds(orgLevel).includes(kind)) {
      return { kind, orgUnitId: template.orgUnitId ?? '', departmentId: template.departmentId ?? '' };
    }
  }
  return orgLevel
    ? { kind: 'organisation', orgUnitId: '', departmentId: '' }
    : { kind: 'department', orgUnitId: '', departmentId: onlyDepartmentId ?? '' };
}

/** What the API takes: both null = the whole organisation. */
export function scopePayload(sel: ScopeSelection): { departmentId: string | null; orgUnitId: string | null } {
  if (sel.kind === 'department') return { departmentId: sel.departmentId || null, orgUnitId: null };
  if (sel.kind === 'orgunit') return { departmentId: null, orgUnitId: sel.orgUnitId || null };
  return { departmentId: null, orgUnitId: null };
}

/** A sentence for what is still missing, or null when the selection is complete. */
export function scopeProblem(sel: ScopeSelection): string | null {
  if (sel.kind === 'department' && !sel.departmentId) return 'Choose the department that can use this form';
  if (sel.kind === 'orgunit' && !sel.orgUnitId) return 'Choose the organisation unit that can use this form';
  return null;
}

/** Short badge text for a template card: "Whole organisation", "Unit: HQ", "Dept: HR - Human Resources". */
export function scopeBadgeText(
  scope: { departmentId?: string | null; orgUnitId?: string | null },
  departments: Array<{ id: string; code: string; name: string }>,
  orgUnits: Array<{ id: string; code: string; name: string }>,
): string {
  const kind = scopeKindOf(scope);
  if (kind === 'department') {
    const d = departments.find((x) => x.id === scope.departmentId);
    return d ? `Dept: ${d.code} - ${d.name}` : 'Department';
  }
  if (kind === 'orgunit') {
    const u = orgUnits.find((x) => x.id === scope.orgUnitId);
    return u ? `Unit: ${u.name}` : 'Organisation unit';
  }
  return SCOPE_KIND_LABEL.organisation;
}
