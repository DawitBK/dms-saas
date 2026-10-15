// Scope of a form template (audit 2026-10-04, finding "templates have no department or org-unit scope").
//
// A template now carries the same tri-level scope as a document type: departmentId = that department
// only; else orgUnitId = every department under that org unit; both null = the whole tenant (what every
// pre-existing template is). This file is the one place that scope is validated, filtered and enforced:
//
//   * WRITE  (assertScopeWritable)       who may put a template at which scope, validated against the tenant;
//   * LIST   (templateVisibilityWhere)   which templates a person is offered, the way GET /document-types is;
//   * READ   (canViewFormTemplate)       a template outside a person's scope reads as "not found";
//   * USE    (assertTemplateUsableForDepartment) filing a form needs the template to cover the filing
//            department, exactly like assertDocumentTypeInScope does for a document type.
//
// Decisions (SAFE choices, recorded in MODULE-WORKFLOWS-AND-SCOPE.md section 4):
//   - tenant-wide and org-unit scope are for organisation-level people (acl:bypass_admin, orgunit:manage,
//     document:read_all, the same set that may define tenant-wide document types); everyone else
//     creates a department-scoped template for a department they are a direct member of;
//   - a department-scoped template is usable for that exact department (not its sub-departments),
//     matching document types;
//   - the author and anyone who holds a step on the template's approval chain can always open it, so
//     a template can never become un-reviewable.

import { Op, type WhereOptions } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { ApprovalChain, ApprovalStep, Department, OrgUnit } from "../../infrastructure/database/index.js";
import { hasTenantWideStructureAuthority } from "../../shared/orgScope.js";
import { getUserDepartmentIds } from "../approvals/stepRules.js";

export type TemplateScope = { departmentId?: string | null; orgUnitId?: string | null };

type Actor = {
  userId: string;
  tenantId: string;
  permissions?: readonly string[];
};

function perms(user: Pick<Actor, "permissions">): readonly string[] {
  return user.permissions ?? [];
}

/** May place a template tenant-wide or at org-unit scope. Same set that may define tenant-wide document types. */
export function hasOrgWideTemplateAuthority(user: Pick<Actor, "permissions">): boolean {
  return hasTenantWideStructureAuthority(user) || perms(user).includes(PERMISSIONS.DOCUMENT_READ_ALL);
}

/** Sees every template regardless of scope (administrators and records / oversight roles). */
export function seesEveryTemplate(user: Pick<Actor, "permissions">): boolean {
  return perms(user).includes(PERMISSIONS.ACL_BYPASS_ADMIN) || perms(user).includes(PERMISSIONS.DOCUMENT_READ_ALL);
}

export function normalizeScope(scope: TemplateScope | undefined): { departmentId: string | null; orgUnitId: string | null } {
  return { departmentId: scope?.departmentId || null, orgUnitId: scope?.orgUnitId || null };
}

/**
 * Validate a scope for writing. Throws 422 ERR-FORM-SCOPE-INVALID when it names both a department and an
 * org unit or a department / org unit that is not in this tenant, 422 ERR-FORM-SCOPE-REQUIRED when a
 * person without organisation-level authority leaves it tenant-wide, and 403 ERR-FORM-SCOPE when they
 * name a department they do not belong to.
 */
export async function assertScopeWritable(user: Actor, input: TemplateScope | undefined): Promise<{ departmentId: string | null; orgUnitId: string | null }> {
  const scope = normalizeScope(input);
  if (scope.departmentId && scope.orgUnitId) {
    throw new AppError(422, "ERR-FORM-SCOPE-INVALID", "A form template is scoped to a department or to an organisation unit, not both");
  }
  if (scope.departmentId) {
    const dept = await Department.findOne({ where: { id: scope.departmentId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!dept) throw new AppError(422, "ERR-FORM-SCOPE-INVALID", "Department not found in this organisation");
  }
  if (scope.orgUnitId) {
    const unit = await OrgUnit.findOne({ where: { id: scope.orgUnitId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!unit) throw new AppError(422, "ERR-FORM-SCOPE-INVALID", "Organisation unit not found in this organisation");
  }
  if (hasOrgWideTemplateAuthority(user)) return scope;
  if (!scope.departmentId) {
    throw new AppError(
      422,
      "ERR-FORM-SCOPE-REQUIRED",
      scope.orgUnitId
        ? "Only an organisation-level role can scope a form to a whole organisation unit — choose one of your departments"
        : "Choose the department this form is for — only an organisation-level role can publish a form for the whole organisation",
    );
  }
  const own = await getUserDepartmentIds(user.tenantId, user.userId);
  if (!own.includes(scope.departmentId)) {
    throw new AppError(403, "ERR-FORM-SCOPE", "You can only scope a form template to a department you belong to");
  }
  return scope;
}

/** Does the template cover filing under this department? (document-type rule: exact department or its org unit.) */
export function templateCoversDepartment(
  scope: TemplateScope,
  department: { id: string; orgUnitId?: string | null },
): boolean {
  const { departmentId, orgUnitId } = normalizeScope(scope);
  if (!departmentId && !orgUnitId) return true;
  if (departmentId) return departmentId === department.id;
  return !!orgUnitId && orgUnitId === department.orgUnitId;
}

/** Filing a form needs the template to cover the filing department (administrators with acl:bypass_admin exempt). */
export function assertTemplateUsableForDepartment(
  scope: TemplateScope,
  department: { id: string; orgUnitId?: string | null },
  user: Pick<Actor, "permissions">,
): void {
  if (templateCoversDepartment(scope, department)) return;
  if (perms(user).includes(PERMISSIONS.ACL_BYPASS_ADMIN)) return;
  throw new AppError(403, "ERR-FORM-TEMPLATE-SCOPE", "This form template is not available for the selected department");
}

async function visibleScopeIds(user: Actor): Promise<{ departmentIds: string[]; orgUnitIds: string[] }> {
  // Lazy: departments.service pulls in folders/ACL machinery that most callers of this file never need.
  const { getVisibleDepartmentIds, getVisibleOrgUnitIds } = await import("../departments/departments.service.js");
  const [departmentIds, orgUnitIds] = await Promise.all([
    getVisibleDepartmentIds(user.tenantId, user.userId),
    getVisibleOrgUnitIds(user.tenantId, user.userId),
  ]);
  return { departmentIds: [...departmentIds], orgUnitIds: [...orgUnitIds] };
}

/**
 * Extra `where` for listing templates: null = no narrowing (the caller sees every template). Otherwise
 * tenant-wide templates, templates scoped to a department / org unit the caller can see (the same
 * "visible" sets GET /document-types uses), and templates the caller authored.
 */
export async function templateVisibilityWhere(user: Actor): Promise<WhereOptions | null> {
  if (seesEveryTemplate(user)) return null;
  const { departmentIds, orgUnitIds } = await visibleScopeIds(user);
  return {
    [Op.or]: [
      { departmentId: null, orgUnitId: null },
      { departmentId: { [Op.in]: departmentIds } },
      { orgUnitId: { [Op.in]: orgUnitIds } },
      { createdBy: user.userId },
    ],
  };
}

/** Can this person open this template? Out-of-scope templates read as not found. */
export async function canViewFormTemplate(
  template: { id: string; tenantId: string; departmentId?: string | null; orgUnitId?: string | null; createdBy?: string | null },
  user: Actor,
): Promise<boolean> {
  const scope = normalizeScope(template);
  if (!scope.departmentId && !scope.orgUnitId) return true;
  if (seesEveryTemplate(user)) return true;
  if (template.createdBy && template.createdBy === user.userId) return true;
  const { departmentIds, orgUnitIds } = await visibleScopeIds(user);
  if (scope.departmentId && departmentIds.includes(scope.departmentId)) return true;
  if (scope.orgUnitId && orgUnitIds.includes(scope.orgUnitId)) return true;
  // A named approver / escalatee / decider outside the scope must still be able to open what they review.
  const chains = await ApprovalChain.findAll({
    where: { tenantId: template.tenantId, itemType: "FORM_TEMPLATE", itemId: template.id },
    attributes: ["id"],
  });
  if (chains.length === 0) return false;
  const step = await ApprovalStep.findOne({
    where: {
      chainId: { [Op.in]: chains.map((c) => c.id) },
      [Op.or]: [
        { assignedUserId: user.userId },
        { decidedBy: user.userId },
        { delegatedBy: user.userId },
        { escalatedToUserIds: { [Op.contains]: [user.userId] } },
      ],
    },
    attributes: ["id"],
  });
  return Boolean(step);
}
