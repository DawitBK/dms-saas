'use client';

// Inline, NON-BLOCKING advisory shown under any "assign a named person"
// picker (letters submit-chain approver rows + signatory picker, the unified
// approvals engine's ApprovalChainCard, e-signing's recipient picker).
//
// Named-person assignment is globally scoped everywhere in DMS *by design*
// (see letters.service.ts's assertStepIsActionable comment) — role steps are
// department-scoped, named ones deliberately are not. This component only
// makes that existing rule visible: it warns when the picked person sits
// outside the item's department, or holds no ACL grant on it, and never
// prevents the assignment.
//
// Style deliberately matches ApprovalChainCard's existing amber (#d97706)
// inline hints rather than introducing a new visual language.

import { useAssignmentAdvisory, isOutsideDepartment, type AclResourceType } from '../lib/assignmentAdvisory';

export function AssignmentAdvisoryNotice({
  candidateUserId,
  candidateDepartments,
  candidateLabel,
  departmentId,
  resourceType,
  resourceId,
  permission,
  className = '',
}: {
  candidateUserId: string | null | undefined;
  /** From the assignable-users endpoints — lets the department half of the
   *  warning render instantly, before/without the server round trip. */
  candidateDepartments?: Array<{ id: string; name?: string }>;
  candidateLabel?: string;
  departmentId?: string | null;
  resourceType: AclResourceType;
  resourceId: string | null | undefined;
  permission?: string;
  className?: string;
}) {
  const { data } = useAssignmentAdvisory({ candidateUserId, departmentId, resourceType, resourceId, permission });

  if (!candidateUserId) return null;

  // Server answer wins once it arrives; until then fall back to the
  // department memberships the picker already has in hand.
  const outsideDepartment = data ? !data.inDepartment : isOutsideDepartment(candidateDepartments, departmentId);
  // A department-scoped ACL entry (acl_entries with resource_type=
  // 'department') is how someone OUTSIDE a department gets explicit read
  // access into it (see departments.service.ts's getAclGrantedDepartmentIds)
  // — it is never how an actual member of the department gets access; members
  // get theirs through per-document ACL grants instead (documents.service.ts's
  // grantDefaultDocumentAcl), which this check doesn't look at. Gating
  // missingAcl on outsideDepartment too used to mean this fired for EVERY
  // in-department pick, always, since no ordinary member ever holds a
  // department-resource ACL row — confirmed live: a department's own
  // DEPT_MANAGER, a genuine member with letter:approve on the letter's own
  // department, still showed "no access grant on this department's records"
  // on every single assignment. Only meaningful combined with an actual
  // cross-department pick.
  const missingAcl = outsideDepartment && (data ? !data.aclAllowed : false);
  if (!outsideDepartment && !missingAcl) return null;

  const who = candidateLabel ? `${candidateLabel} is` : 'This person is';
  return (
    <span className={`block text-[11px] ${className}`} style={{ color: '#d97706' }}>
      {missingAcl
        ? `${who} outside this department and has no access grant on it — they can still be assigned, and will be granted access for this task.`
        : `${who} outside this department — they can still be assigned.`}
    </span>
  );
}
