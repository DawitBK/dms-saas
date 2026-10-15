// Non-blocking "should the person assigning this candidate be warned"
// endpoint, shared by the letters, unified-approvals, and e-signing pickers
// (see PARTITIONED-PERCOLATING-KITTEN plan, 2026-09-02). Read-only, no side
// effects — it never refuses an assignment, only informs the UI whether to
// show a cross-department / no-ACL warning next to a named-person pick.

import { withoutPlatformAdminRole } from '../../shared/platformAdmin.js';
import { Router } from 'express';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requireAnyPermission } from '../../shared/auth.js';
import { PERMISSIONS, type Permission } from '../../config/permissions.js';
import { AppError } from '../../core/AppError.js';
import { checkAssignmentAdvisory } from '../../shared/assignmentAdvisory.js';
import type { AclResourceType } from '../../shared/resolveACL.js';
import { Role } from '../../infrastructure/database/index.js';
import { getRolePermissionsByRoleId } from '../roles/roles.service.js';
import {
  resolveRoleStepEligibility,
  LETTER_STEP_RULES,
  ENGINE_STEP_RULES,
  type StepRuleProfile,
} from '../approvals/stepRules.js';
import { resolveRoleUserIds } from '../../shared/assignmentAdvisory.js';

export const assignmentAdvisoryRoutes = Router();

const ACL_RESOURCE_TYPES = new Set<AclResourceType>([
  'document', 'folder', 'department', 'workflow', 'workflow_task', 'retention', 'legal_hold',
]);

const VALID_PERMISSIONS = new Set<string>(Object.values(PERMISSIONS));

/**
 * Which approval domain a picker belongs to, keyed by the decide permission
 * it is already narrowing on. Needed only for the staffing count: whether a
 * role's holders are department-scoped depends on the domain's
 * cross-department escape hatch (letter:read_all vs document:read_all), so
 * the count cannot be computed from the role alone.
 *
 * A permission that is not an approval-step decide permission is not an
 * error -- it just means this endpoint cannot know the scoping rule, so it
 * reports no count rather than a wrong one.
 */
const STEP_PROFILE_BY_PERMISSION = new Map<string, StepRuleProfile>([
  [PERMISSIONS.LETTER_REVIEW, LETTER_STEP_RULES],
  [PERMISSIONS.LETTER_APPROVE, LETTER_STEP_RULES],
  [PERMISSIONS.APPROVAL_DECIDE, ENGINE_STEP_RULES],
]);

/** Role names an assignment picker may legitimately offer — optionally only
 *  those that actually resolve (per this tenant's role_permissions, static
 *  fallback included) to `permission`.
 *
 *  Every picker in the product used to hardcode the same four role names
 *  (`letters/[id]/page.tsx`, `ApprovalChainCard.tsx`), which meant (a) a
 *  custom role created at runtime via POST /roles could never be assigned a
 *  step, and (b) the list drifted from what the backend would actually
 *  accept — RECORDS_OFFICER was missing from letters' array for a long time
 *  even though submitLetter always accepted it. GET /roles can't serve this:
 *  it's gated on role:read / acl:manage, which the people using these
 *  pickers (EMPLOYEE drafting a letter, RECORDS_OFFICER building a signing
 *  ceremony) don't hold. Same gate as /check below — anyone who can reach a
 *  picker can read the names it offers. Names only, never permissions. */
assignmentAdvisoryRoutes.get(
  '/roles',
  requireAnyPermission(PERMISSIONS.LETTER_CREATE, PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const permission = req.query.permission ? String(req.query.permission) : undefined;
    if (permission && !VALID_PERMISSIONS.has(permission)) {
      throw new AppError(422, 'ERR-ADVISORY-PARAMS', 'Unknown permission');
    }

    // The item's department, when the caller has one. Turns the response from
    // "roles that COULD decide this" into "roles that could decide this HERE",
    // which is the question the picker actually needs answered.
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;
    const tenantId = req.user!.tenantId;

    const roles = withoutPlatformAdminRole(await Role.findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] }));

    const offered = permission
      ? (
          await Promise.all(
            roles.map(async (r) => ({
              id: r.id,
              name: r.name,
              permissions: await getRolePermissionsByRoleId(r.id, tenantId, r.name),
            })),
          )
        )
          .filter((r) => r.permissions.includes(permission as Permission))
          .map((r) => ({ id: r.id, name: r.name }))
      : roles.map((r) => ({ id: r.id, name: r.name }));

    if (!departmentId) {
      res.json({ data: offered });
      return;
    }

    // With a department in hand, answer the staffing half too -- the other
    // reason a submit gets refused (ERR-STEP-ROLE-UNSTAFFED). Both branches
    // call the SAME code the corresponding validator calls, so the picker
    // cannot promise something submit will then reject:
    //   - an approval step  -> resolveRoleStepEligibility (stepRules.ts), which
    //     honours the domain's cross-department escape hatch;
    //   - a letter signatory -> resolveRoleUserIds, which assertSignatoryIsValid
    //     uses and which is always department-scoped (no hatch there).
    const profile = permission ? STEP_PROFILE_BY_PERMISSION.get(permission) : undefined;
    const withStaffing = await Promise.all(
      offered.map(async (r) => {
        if (permission && profile) {
          const eligibility = await resolveRoleStepEligibility(
            r.name,
            permission as Permission,
            profile.crossDepartmentPermission,
            tenantId,
            departmentId,
          );
          return {
            ...r,
            holderCount: eligibility.holderCount,
            departmentScoped: eligibility.departmentScoped,
          };
        }
        if (!permission) {
          const holders = await resolveRoleUserIds(r.name, tenantId, departmentId);
          return { ...r, holderCount: holders.length, departmentScoped: true };
        }
        // Known permission, unknown domain: no count rather than a wrong one.
        return r;
      }),
    );

    res.json({ data: withStaffing });
  }),
);

assignmentAdvisoryRoutes.get(
  '/check',
  // Reachable by anyone who could reach one of the pickers this feeds —
  // letters' submit-chain modal, the unified approvals engine's step
  // picker, and e-signing's recipient picker.
  requireAnyPermission(PERMISSIONS.LETTER_CREATE, PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const candidateUserId = String(req.query.candidateUserId ?? '');
    const resourceType = String(req.query.resourceType ?? '');
    const resourceId = String(req.query.resourceId ?? '');
    const permission = String(req.query.permission ?? 'document:read');
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;

    if (!candidateUserId || !resourceId || !ACL_RESOURCE_TYPES.has(resourceType as AclResourceType)) {
      throw new AppError(422, 'ERR-ADVISORY-PARAMS', 'candidateUserId, a valid resourceType, and resourceId are required');
    }

    const result = await checkAssignmentAdvisory({
      candidateUserId,
      tenantId: req.user!.tenantId,
      departmentId,
      resourceType: resourceType as AclResourceType,
      resourceId,
      permission,
    });
    res.json({ data: result });
  }),
);
