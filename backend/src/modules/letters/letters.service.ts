// CAMS letters service — outgoing correspondence lifecycle.
//
// DRAFT → IN_REVIEW → (RETURNED → resubmit) → APPROVED → DISPATCHED → ARCHIVED
//
// The reference number is allocated ONLY at final approval (6.1.3), from a
// gap-free per-unit-per-type-per-year counter locked inside the approval
// transaction. On approval the letter is rendered to PDF (with QR), hashed,
// and filed into the document store through the canonical encryption path.

import crypto from 'node:crypto';
import { Op, QueryTypes, type Transaction as SequelizeTransaction } from 'sequelize';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import {
  AclEntry,
  ArchiveRecord,
  Department,
  Document,
  DocumentDek,
  DocumentType,
  DocumentVersion,
  Letter,
  LetterApprovalStep,
  LetterAttachment,
  LetterDispatch,
  LetterLink,
  LetterRevision,
  LetterSequence,
  OrgUnit,
  OutboxEvent,
  Role,
  sequelize,
  SignatureRequest,
  SignatureField,
  Tenant,
  User,
  UserTenant,
} from '../../infrastructure/database/index.js';
import { enqueueWebsocketEvent } from '../../infrastructure/queue/outbox.js';
import { createQueue } from '../../infrastructure/queue/queues.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { getResolvedRolePermissions } from '../roles/roles.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { encryptAndStore, fetchAndDecrypt } from '../documents/documentCrypto.js';
import { reserveStorageQuota } from '../documents/quotaService.js';
import { applyRetention } from '../retention/retentionEngine.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import { fanOut } from '../notifications/notifications.service.js';
import { generateLetterCoverSheet, generateLetterPdf, generateLetterSignableDraft } from './letterPdf.js';
import { extractPlainText, letterBodyDocSchema, parseLetterBody } from './letterBodyDoc.js';
import {
  assertBodyImagesUsable,
  linkBodyImagesToLetter,
  makeLetterBodyImageResolver,
} from './letterBodyImages.service.js';
import {
  collectLetterParticipantIds,
  grantLetterDocumentAcl,
  isParticipantsOnly,
  LETTER_DRAFT_NAME_PREFIX,
  syncLetterDocumentAcl,
} from './letterDocumentAcl.js';
import { reconcileLetterSigning } from './letterSigningRecovery.js';
// E27: the eager hook the e-signing module may call when it closes a request (see letterSigningRecovery.ts).
export { recoverLetterAfterSigningClosed, reconcilePendingSignatureLetters } from './letterSigningRecovery.js';
import { assertTransition, EDITABLE_STATES } from './LetterStateMachine.js';
import { runInTransaction } from '../../shared/transaction.js';
import { requireLegalHoldClear } from '../../shared/documentGuards.js';
import { withWorkerTenantContext } from '../../shared/workerTenantContext.js';
import { sanitizeFilename } from '../../shared/sanitizeFilename.js';
import { resolveRoleUserIds } from '../../shared/assignmentAdvisory.js';
// The platform administrator is invisible to everyone else (shared/platformAdmin.ts):
// never offered in a picker, and a request that names it answers as "user not found".
import { assertNotHiddenUser, maskHiddenUsersDeep, withoutHiddenIds } from '../../shared/platformAdmin.js';
// A department head administers their own department and every sub-department
// below it; tenant-wide authority (acl:bypass_admin / orgunit:manage) the whole tenant.
import { assertCanManageDepartment } from '../../shared/orgScope.js';
// R-08 (audit 2026-09-03): the step-assignment/decision rules
// used to be implemented here AND again in approvals.service.ts, where the
// copy was labelled "Mirror of letters' assertStepIsActionable" — and the
// two had drifted. One implementation now, parameterised by domain profile.
import {
  LETTER_STEP_RULES,
  assertAssigneeInTenant,
  assertRoleStepDepartmentScope,
  assertStepIsActionable,
  getUserDepartmentIds,
  hasPermission,
  stepIsAssignedTo,
  type CurrentUser,
} from '../approvals/stepRules.js';
export type { CurrentUser } from '../approvals/stepRules.js';
import { createSignatureRequest, sendSignatureRequest } from '../esigning/esigning.service.js';
import type { AuthenticatedUser } from '../../shared/auth.js';
import type { Permission } from '../../config/permissions.js';

/** Statuses past which a letter's due date no longer matters — mirrors the
 *  client-side rule the letter detail page uses (frontend/app/dashboard/letters/[id]/page.tsx).
 *  SINGLE SOURCE OF TRUTH (Finding 11): this used to be duplicated,
 *  independently and inconsistently, by the `?overdue=true` query filter
 *  below (which matched status IN ('RECEIVED','RESPONDED') — the opposite of
 *  this list, i.e. it INCLUDED RESPONDED) and by approvals/myWork.service.ts
 *  (which excluded only RESPONDED, not CLOSED/ARCHIVED). Both now derive from
 *  this exported list instead of independently re-stating the rule. */
export const OVERDUE_TERMINAL_STATUSES = ['RESPONDED', 'CLOSED', 'ARCHIVED'];

export function isLetterOverdue(status: string, dueDate: string | Date | null): boolean {
  return Boolean(
    dueDate &&
      !OVERDUE_TERMINAL_STATUSES.includes(status) &&
      new Date(dueDate) < new Date(),
  );
}

/** DEPT_MANAGER is one role name shared by every department's manager, so on
 *  its own ("Dept Manager") the printed signature block doesn't say which
 *  department. Role-assigned letter signatories are always scoped to the
 *  letter's own department (see assertRoleStepDepartmentScope / the claim
 *  check in signDocument), so qualifying with departmentName here is always
 *  accurate, not just a display guess. Other roles (AUDITOR, SYSTEM_ADMIN,
 *  EXECUTIVE, ...) aren't per-department position names, so they're left as
 *  a plain humanized role name. */
function humanizeSignatoryTitle(roleName: string, departmentName: string): string {
  if (roleName === 'DEPT_MANAGER') return `${departmentName} Department Manager`;
  return roleName.replace(/_/g, ' ');
}

/**
 * Candidate named-person assignees for the letter submit-chain modal
 * (approver/reviewer step, and the new "who signs this letter" picker).
 *
 * Before this existed, the modal's user list came straight from GET /users,
 * gated on USER_MANAGE/DEPT_MANAGE/ACL_BYPASS_ADMIN — permissions an ordinary
 * letter drafter (letter:create only) never holds, so the named-person
 * dropdown was always empty for them and the role dropdown was the only
 * usable option. Mirrors approvals.service.ts's listAssignableUsers (H4).
 *
 * `stepType` REVIEW/APPROVE is scoped to LETTER_APPROVE/LETTER_REVIEW through
 * the same per-tenant getResolvedRolePermissions assertStepIsActionable now
 * validates a chosen assignee against, so the picker's candidate list can
 * never disagree with what submitLetter will actually accept. `SIGNATORY` is
 * unrestricted (any active tenant member) because assertSignatoryIsValid
 * holds a named signatory to no LETTER_* permission at all — the current
 * default (the final approver) doesn't hold one either.
 *
 * Deliberately NOT department-filtered for any stepType, even though a role
 * step ultimately only accepts department-scoped role holders — a NAMED
 * assignee is always globally scoped by design (letters.service.ts's own
 * assertStepIsActionable/decideStep comments), so this candidate list stays
 * tenant-wide; each result carries its own `departments` for the frontend's
 * cross-department warning instead of the server silently narrowing the
 * list, which would make an intentional cross-department pick impossible
 * rather than just informationally flagged.
 */
export async function listLetterAssignableUsers(
  user: CurrentUser,
  stepType: 'REVIEW' | 'APPROVE' | 'SIGNATORY',
): Promise<Array<{ id: string; firstName: string; lastName: string; email: string; departments: Array<{ id: string; name: string; code: string }> }>> {
  let candidateIds: string[];
  if (stepType === 'SIGNATORY') {
    const memberships = await UserTenant.findAll({ where: { tenantId: user.tenantId }, attributes: ['userId'] });
    candidateIds = await withoutHiddenIds([...new Set(memberships.map((m) => m.userId))], user.userId);
  } else {
    const neededPermission = stepType === 'APPROVE' ? PERMISSIONS.LETTER_APPROVE : PERMISSIONS.LETTER_REVIEW;
    // Every role that actually exists in the DB (so a runtime-created custom
    // role is a real candidate), resolved per-tenant — the static
    // ROLE_PERMISSIONS map is only getResolvedRolePermissions's fallback.
    const allRoles = await Role.findAll({ attributes: ['id', 'name'] });
    const resolvedRoles = await Promise.all(
      allRoles.map(async (r) => ({
        name: r.name,
        permissions: await getResolvedRolePermissions(r.name, user.tenantId),
      })),
    );
    const qualifyingRoles = resolvedRoles
      .filter((r) => r.permissions.includes(neededPermission as Permission))
      .map((r) => r.name);
    if (qualifyingRoles.length === 0) return [];
    const idSets = await Promise.all(
      qualifyingRoles.map((role) => resolveRoleUserIds(role, user.tenantId, null)),
    );
    candidateIds = await withoutHiddenIds([...new Set(idSets.flat())], user.userId);
  }
  if (candidateIds.length === 0) return [];

  const users = await User.findAll({
    where: { id: { [Op.in]: candidateIds }, isActive: true, deletedAt: null },
    attributes: ['id', 'firstName', 'lastName', 'email'],
    include: [{ model: Department, as: 'departments', attributes: ['id', 'name', 'code'] }],
    order: [['firstName', 'ASC']],
  });
  return users.map((u) => ({
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    departments: ((u as unknown as { departments?: Department[] }).departments ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
    })),
  }));
}

/** esigning.service.ts's ceremony functions want the stricter
 *  AuthenticatedUser shape (non-optional roles/permissions) — decideStep's
 *  caller always populates both on CurrentUser in practice (hasPermission()
 *  in this same file already relies on `user.permissions` being present),
 *  this just makes that explicit at the type level for the cross-module call. */
function toAuthenticatedUser(user: CurrentUser): AuthenticatedUser {
  return {
    userId: user.userId,
    role: user.role,
    roles: user.roles ?? [user.role],
    tenantId: user.tenantId,
    permissions: (user.permissions ?? []) as Permission[],
  };
}

const LETTER_TYPES = ['OUT', 'MEMO', 'CIRC', 'CONT'] as const;

// Accepted formats for SCANNED-origin letters (incoming registration, and
// outgoing letters filed as an uploaded scan of a signed paper original)
// — PDF/image (original) plus Word, since a letter typed and printed for a
// wet signature is very often still held as a .doc/.docx, not just a scan.
const SCAN_WORD_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
function isValidScanFile(file: Express.Multer.File): boolean {
  return file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/') || SCAN_WORD_MIME_TYPES.has(file.mimetype);
}

// A letter body is either legacy plain text (any string, under the old cap)
// or the new editor's structured document, JSON-stringified — bigger cap
// (rich formatting/table markup carries real overhead a plain paragraph
// didn't; still far short of anything that could strain PDF generation) and,
// when it LOOKS like structured JSON (starts with `{`, mentions `"type"` —
// the same heuristic letterBodyDoc.ts's isStructuredLetterBody uses), it
// must actually parse and validate
// against letterBodyDocSchema. That refinement is the load-bearing part: a
// client that got the shape wrong fails here, at the API boundary, with a
// normal ERR-VALIDATION, instead of reaching parseLetterBody's fallback (which
// tolerates it by silently downgrading to legacy plain text) only for the
// author to find their formatting quietly discarded.
const bodyHtmlField = z
  .string()
  .max(2_000_000)
  .optional()
  .superRefine((value, ctx) => {
    if (!value) return;
    const trimmed = value.trim();
    const looksStructured = trimmed.startsWith('{') && trimmed.includes('"type"');
    if (!looksStructured) return; // genuine plain text — the legacy shape, always accepted
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bodyHtml looks like structured content but is not valid JSON: ${(e as Error).message}` });
      return;
    }
    const result = letterBodyDocSchema.safeParse(parsed);
    if (result.success) return;
    // Surface every nested issue with its exact path (e.g.
    // "content[2].content[0].content[1].attrs.href") instead of one generic
    // message — a discriminated-union/lazy-recursive schema like this one can
    // fail deep inside a table cell or list item, and the caller (the
    // compose page's live preview) has no other way to tell the author (or
    // us, debugging live) which element of a pasted Word document tripped
    // the schema. AUDIT: 2026-09-22, the "Validation failed" dead end this
    // replaces.
    for (const issue of result.error.issues.slice(0, 20)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bodyHtml: at "${issue.path.join('.')}" — ${issue.message}` });
    }
  });

const createLetterSchema = z.object({
  orgUnitId: z.string().uuid(),
  departmentId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  bodyHtml: bodyHtmlField,
  letterType: z.enum(LETTER_TYPES).default('OUT'),
  confidentiality: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).default('INTERNAL'),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  language: z.string().max(10).default('en'),
  correspondent: z.string().max(500).optional(),
  correspondentOrganization: z.string().max(500).optional(),
  // City/country line rendered under the "To:" addressee (e.g. "Example City,
  // Exampleland") — display-only, like correspondent/correspondentOrganization.
  correspondentLocation: z.string().max(500).optional(),
  // Actual send-to address — distinct from the display name above. Optional:
  // dispatch falls back to a physical/print channel without one.
  correspondentEmail: z.string().email().max(320).optional(),
});

const updateLetterSchema = createLetterSchema.partial();

const submitSchema = z.object({
  steps: z
    .array(
      z.object({
        stepType: z.enum(['REVIEW', 'APPROVE']),
        assignedUserId: z.string().uuid().optional(),
        assignedRole: z.string().max(64).optional(),
        // Deadline for this step in hours from the moment it becomes the current step (absent = tenant default).
        slaHours: z.number().int().min(1).max(24 * 90).optional(),
      }).refine((s) => s.assignedUserId || s.assignedRole, {
        message: 'Each step needs an assigned user or role',
      }),
    )
    .min(1)
    .optional(),
});

/** Who signs the letter — the input to initiateLetterSigning.
 *
 *  This used to be a field on submitSchema, which is exactly why a chosen
 *  signatory received an APPROVAL task: the signatory rode along with the
 *  approval chain and the ceremony was a side effect of the final approval.
 *  Submitting for approval and initiating signing are separate actions with
 *  separate assignee pickers now.
 *
 *  Same "exactly one of assignedUserId/assignedRole" shape as
 *  reassignStepSchema below. Required, not optional: initiating signing
 *  without saying who signs is meaningless. */
const initiateSigningSchema = z.object({
  signatory: z
    .object({
      assignedUserId: z.string().uuid().optional(),
      assignedRole: z.string().max(64).optional(),
    })
    .refine((s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole), {
      message: 'Provide exactly one of assignedUserId or assignedRole',
    }),
});

const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'RETURN']),
    comment: z.string().max(2000).optional(),
  })
  // L20: sending a letter back without saying why leaves the drafter guessing; the unified engine
  // already requires a comment for REQUEST_CHANGES/DECLINE. Approving needs none.
  .refine((d) => d.decision !== 'RETURN' || (d.comment ?? '').trim().length > 0, {
    message: 'A comment is required when returning a letter, so the drafter knows what to change',
    path: ['comment'],
  });

/** Reassign a still-PENDING step to a different user or role. Exactly one of
 *  assignedUserId/assignedRole must be given — same "one holder, not both"
 *  shape submitSchema's steps already enforce. */
const reassignStepSchema = z
  .object({
    assignedUserId: z.string().uuid().optional(),
    assignedRole: z.string().max(64).optional(),
    reason: z.string().max(2000).optional(),
  })
  .refine((s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole), {
    message: 'Provide exactly one of assignedUserId or assignedRole',
  });

/** `reason` is only mandatory when cancelling out of IN_REVIEW (checked in
 *  cancelLetter, not here, since the DRAFT/RETURNED owner-cancel path needs none). */
const cancelLetterSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const dispatchSchema = z.object({
  channel: z.enum(['EMAIL', 'PORTAL', 'PRINT', 'COURIER', 'HAND_DELIVERY', 'REGISTERED_MAIL']),
  recipientName: z.string().max(500).optional(),
  recipientAddress: z.string().max(1000).optional(),
  trackingReference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * Validates an optional explicit signatory choice at submit time (the new
 * "who signs this letter" picker — see submitSchema's `signatory` field).
 * Deliberately lighter than assertStepIsActionable: signing a letter isn't
 * gated by a LETTER_* permission today (the current auto-assigned signatory
 * — the final approver — holds none either), so a named signatory only needs
 * to be an active tenant member; a role-based signatory only needs at least
 * one active department-scoped holder to exist (same ERR-STEP-ROLE-UNSTAFFED
 * shape as a role-assigned approval step). */
async function assertSignatoryIsValid(
  signatory: { assignedUserId?: string; assignedRole?: string } | undefined,
  tenantId: string,
  departmentId: string | null,
  viewerUserId?: string,
): Promise<void> {
  if (!signatory) return;

  if (signatory.assignedUserId) {
    await assertNotHiddenUser(signatory.assignedUserId, viewerUserId);
    await assertAssigneeInTenant(signatory.assignedUserId, tenantId);
    const assignee = await User.findOne({ where: { id: signatory.assignedUserId, isActive: true } });
    if (!assignee) throw new AppError(422, 'ERR-SIGNATORY-INVALID', 'Assigned signatory is not active');
    return;
  }

  if (signatory.assignedRole) {
    const holders = await resolveRoleUserIds(signatory.assignedRole, tenantId, departmentId);
    if (holders.length === 0) {
      throw new AppError(
        422,
        'ERR-STEP-ROLE-UNSTAFFED',
        departmentId
          ? `No active user holding role ${signatory.assignedRole} is a member of this letter's department`
          : `No active user holds role ${signatory.assignedRole} in this tenant`,
      );
    }
    return;
  }
}

/** Letters a user is on through the approval chain, so they can open what they were asked to decide.
 *
 *  - NAMED assignees: decideStep() never department-scopes a named-user step, so a named assignee
 *    outside the letter's department must still be able to read it.
 *  - Deciders: whoever actually approved or returned a step keeps read access to that letter.
 *  - CANCELLED steps do NOT count (L19): a step that was cancelled (resubmit, in-flight cancel) used to keep
 *    its assignee's access for good although they never acted. A reassigned step is rewritten in place, so
 *    the previous holder is already gone.
 *  - ROLE steps: holders of the assigned role, but only inside the letter's own department (the same rule
 *    decideStep enforces), and only while the step is still open. Without this a DEPT_MANAGER holding the
 *    default role step could not even open a CONFIDENTIAL letter they were asked to approve. */
async function getStepParticipationLetterIds(
  user: CurrentUser,
): Promise<{ named: string[]; role: string[] }> {
  const namedRows = await LetterApprovalStep.findAll({
    where: {
      [Op.or]: [
        { assignedUserId: user.userId, status: { [Op.ne]: 'CANCELLED' } },
        { decidedBy: user.userId },
        { escalatedToUserIds: { [Op.contains]: [user.userId] }, status: 'PENDING' },
      ],
    },
    attributes: ['letterId'],
  });
  const roles = user.roles ?? (user.role ? [user.role] : []);
  const roleRows = roles.length
    ? await LetterApprovalStep.findAll({
        where: { assignedRole: { [Op.in]: roles }, assignedUserId: null, status: { [Op.in]: ['PENDING', 'WAITING'] } },
        attributes: ['letterId'],
      })
    : [];
  return {
    named: [...new Set((namedRows ?? []).map((r) => r.letterId))],
    role: [...new Set((roleRows ?? []).map((r) => r.letterId))],
  };
}

/** Departments whose letters `user` may READ besides the ones they belong to (L18).
 *
 *  DECISION (owner, 2026-10-09): reading follows DIRECT membership everywhere — documents, folders and letters.
 *  Being a member (or head) of a parent department does not open its sub-departments' letters; the person is
 *  made a member of the sub-department instead. The earlier read-only widening for department heads is removed.
 *  Management actions (cancel, reassign) keep their own head-of-subtree rule in assertCanManageDepartment. */
async function getReadOnlySubDepartmentIds(_user: CurrentUser, _directIds: string[]): Promise<string[]> {
  return [];
}

/** Unit-archive scoping: read_all sees the Central Archive; everyone else sees
 *  their own departments' letters plus letters they created or were assigned.
 *  CONFIDENTIAL/RESTRICTED letters are additionally limited to the people on
 *  the letter (creator / assignee / signatory / chain participants) — dept membership
 *  alone is not enough to read them (7.1 confidentiality tagging).
 *  `forRead` adds the department head's read-only view of sub-departments (L18). */
async function scopeWhere(user: CurrentUser, options: { forRead?: boolean } = {}): Promise<Record<string, unknown>> {
  if (hasPermission(user, PERMISSIONS.LETTER_READ_ALL)) return {};
  const deptIds = await getUserDepartmentIds(user.tenantId, user.userId);
  const subDeptIds = options.forRead ? await getReadOnlySubDepartmentIds(user, deptIds) : [];
  const step = await getStepParticipationLetterIds(user);
  const stepAssigneeGrant = step.named.length ? [{ id: { [Op.in]: step.named } }] : [];
  // Role-step holders are participants only inside the letter's own department.
  const roleStepGrant = step.role.length && deptIds.length
    ? [{ id: { [Op.in]: step.role }, departmentId: { [Op.in]: deptIds } }]
    : [];
  const participant = [
    { createdBy: user.userId },
    { assignedToUserId: user.userId },
    { signatoryUserId: user.userId },
    ...stepAssigneeGrant,
    ...roleStepGrant,
  ];
  const readableDeptIds = [...deptIds, ...subDeptIds];
  return {
    [Op.and as unknown as string]: [
      {
        [Op.or]: [
          ...(readableDeptIds.length ? [{ departmentId: { [Op.in]: readableDeptIds } }] : []),
          { createdBy: user.userId },
          { assignedToUserId: user.userId },
          // A named signatory is chosen tenant-wide (assertSignatoryIsValid only
          // needs an active tenant member), exactly like a named approval-step
          // assignee — so, like them, they must be able to open the letter they
          // were asked to sign even when it sits in another department. They were
          // only in the confidentiality clause below, never in this one.
          { signatoryUserId: user.userId },
          ...stepAssigneeGrant,
          ...roleStepGrant,
        ],
      },
      {
        [Op.or]: [
          { confidentiality: { [Op.in]: ['PUBLIC', 'INTERNAL'] } },
          ...participant,
        ],
      },
    ],
  };
}

/** For the body-image endpoint: may this user read at least one of these letters? */
export async function canReadAnyLetter(letterIds: string[], user: CurrentUser): Promise<boolean> {
  if (letterIds.length === 0) return false;
  const found = await Letter.findOne({
    where: { id: { [Op.in]: letterIds }, tenantId: user.tenantId, ...(await scopeWhere(user, { forRead: true })) },
    attributes: ['id'],
  });
  return Boolean(found);
}

const letterInclude = [
  { model: OrgUnit, as: 'orgUnit', attributes: ['id', 'code', 'name', 'unitType'] },
  { model: Department, as: 'department', attributes: ['id', 'code', 'name'] },
  { model: User, as: 'creator', attributes: ['id', 'firstName', 'lastName', 'email'] },
  { model: User, as: 'assignee', attributes: ['id', 'firstName', 'lastName', 'email'] },
  { model: User, as: 'signatory', attributes: ['id', 'firstName', 'lastName', 'email'] },
];

export async function listLetters(
  query: {
    direction?: string; status?: string; orgUnitId?: string; departmentId?: string;
    year?: number; letterType?: string; q?: string; overdue?: boolean; skip?: number; take?: number;
  },
  user: CurrentUser,
) {
  await reconcileVisiblePendingSignatures(user);
  const where: Record<string, unknown> = { tenantId: user.tenantId, ...(await scopeWhere(user, { forRead: true })) };
  if (query.direction) where.direction = query.direction;
  if (query.status) where.status = query.status;
  if (query.orgUnitId) where.orgUnitId = query.orgUnitId;
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.year) where.year = query.year;
  if (query.letterType) where.letterType = query.letterType;
  if (query.overdue) {
    // Incoming letters past their due date and not yet resolved. FIX
    // (Finding 11): this used to match status IN ('RECEIVED','RESPONDED') —
    // the opposite of isLetterOverdue's own terminal-status rule three lines
    // away, since it INCLUDED RESPONDED rather than excluding it (and every
    // other terminal status). Now expressed as NOT IN the same terminal-
    // status list isLetterOverdue uses, so a RESPONDED/CLOSED/ARCHIVED letter
    // can no longer show up here while isOverdue is computed false for the
    // very same row below.
    where.direction = 'INCOMING';
    where.status = { [Op.notIn]: OVERDUE_TERMINAL_STATUSES };
    where.dueDate = { [Op.lt]: new Date().toISOString().slice(0, 10) };
  }
  if (query.q) {
    // FIX: Op.and is a Symbol, so `where[Op.and as unknown as string] = ...`
    // was not a distinct string key — it was the exact same key scopeWhere()
    // already used for the confidentiality/department scoping array, and this
    // assignment was silently OVERWRITING that array instead of adding to
    // it. Read back whatever scopeWhere() already put under the real Op.and
    // symbol and append to it, so both sets of conditions survive.
    const existingAnd = ((where as Record<symbol, unknown>)[Op.and] as unknown[]) ?? [];
    where[Op.and as unknown as string] = [
      ...existingAnd,
      {
        [Op.or]: [
          { subject: { [Op.iLike]: `%${query.q}%` } },
          { referenceNumber: { [Op.iLike]: `%${query.q}%` } },
          { correspondent: { [Op.iLike]: `%${query.q}%` } },
          { correspondentOrganization: { [Op.iLike]: `%${query.q}%` } },
        ],
      },
    ];
  }

  const take = Math.min(query.take ?? 50, 200);
  const { rows, count } = await Letter.findAndCountAll({
    where,
    include: letterInclude,
    order: [['updatedAt', 'DESC']],
    offset: query.skip ?? 0,
    limit: take,
    distinct: true,
  });
  // isOverdue is derived, not a column — compute it here so the register page
  // doesn't need to duplicate the detail page's client-side rule (and so both
  // stay consistent with each other).
  for (const row of rows) await maskHiddenUsersDeep(row, user.userId);
  const data = rows.map((row) => {
    const plain = row.toJSON() as Record<string, unknown> & { status: string; dueDate: string | null };
    return { ...plain, isOverdue: isLetterOverdue(plain.status, plain.dueDate) };
  });
  return { data, total: count };
}

export async function getLetter(id: string, user: CurrentUser) {
  const where: Record<string, unknown> = { id, tenantId: user.tenantId, ...(await scopeWhere(user, { forRead: true })) };
  let letter = await findLetterDetail(where, user.userId);
  if (letter?.status === 'PENDING_SIGNATURE' && (await reconcileLetterSigning(letter.id)).recovered) {
    letter = await findLetterDetail(where, user.userId); // E27: the signing request had closed; the letter is APPROVED again
  }
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found or not accessible');
  return letter;
}

/** E27 read-repair for the register: any PENDING_SIGNATURE letter whose signing request has closed
 *  (declined, cancelled, expired) goes back to APPROVED before the list is built. */
async function reconcileVisiblePendingSignatures(user: CurrentUser): Promise<void> {
  try {
    const pending = await Letter.findAll({
      where: { tenantId: user.tenantId, status: 'PENDING_SIGNATURE', ...(await scopeWhere(user, { forRead: true })) },
      attributes: ['id'],
    });
    for (const l of pending ?? []) await reconcileLetterSigning(l.id);
  } catch (err) {
    logger.warn({ err }, '[letters] pending-signature reconciliation failed; list continues');
  }
}

async function findLetterDetail(where: Record<string, unknown>, viewerUserId: string) {
  const found = await Letter.findOne({
    where,
    include: [
      ...letterInclude,
      {
        model: LetterApprovalStep, as: 'approvalSteps', separate: true, order: [['stepOrder', 'ASC']],
        include: [
          { model: User, as: 'assignedUser', attributes: ['id', 'firstName', 'lastName', 'email'] },
          // Who actually decided it — distinct from assignedUser, which for a
          // role-assigned step ("any DEPT_MANAGER") is null; decidedByUser is
          // always the specific person who clicked Approve/Return, however
          // the step was assigned.
          { model: User, as: 'decidedByUser', attributes: ['id', 'firstName', 'lastName', 'email'] },
        ],
      },
      {
        model: LetterRevision, as: 'revisions', separate: true, order: [['revisionNo', 'DESC']], limit: 20,
        // bodyHtml can be up to 200,000 chars per revision — callers almost
        // never need it here; fetch it on demand via getLetterRevisionBody().
        attributes: ['id', 'letterId', 'revisionNo', 'subject', 'savedBy', 'createdAt'],
        include: [{ model: User, as: 'author', attributes: ['id', 'firstName', 'lastName', 'email'] }],
      },
      {
        model: LetterDispatch, as: 'dispatches', separate: true, order: [['dispatchedAt', 'DESC']],
        include: [{ model: User, as: 'dispatcher', attributes: ['id', 'firstName', 'lastName', 'email'] }],
      },
      { model: LetterAttachment, as: 'attachments', separate: true, order: [['createdAt', 'ASC']] },
    ],
  });
  if (found) await maskHiddenUsersDeep(found, viewerUserId);
  return found;
}

/** The reverse lookup the Documents module's own detail page needs: given a
 *  document id, is this actually a filed letter (its final PDF, an
 *  attachment, or its cover sheet) — and if so, its full approval chain.
 *  Letters keep their own approval-chain implementation entirely separate
 *  from the unified approval engine, so a letter-backed
 *  CORR document's generic Workflow tab has nothing to show even though the
 *  letter itself went through a complete, real review/approve chain — this
 *  is what lets that tab render the real thing instead of a false "not
 *  submitted yet". Returns null (not a 404) when the document isn't
 *  letter-backed at all, since that's the ordinary case for every other
 *  document type. */
export async function getLetterByDocumentId(documentId: string, user: CurrentUser) {
  const where: Record<string, unknown> = {
    tenantId: user.tenantId,
    ...(await scopeWhere(user, { forRead: true })),
    [Op.or]: [
      { documentId },
      { attachmentDocumentId: documentId },
      { coverSheetDocumentId: documentId },
      // The signable draft a composed-outgoing letter was actually signed
      // against — finalizeLetterAfterSigning overwrites `documentId` with
      // the new numbered final document once signing completes, so the
      // draft is only reachable through this column afterward. Without it,
      // opening the (still very much real, ARCHIVED, already-signed) draft
      // document's own page found no matching letter and showed "Not
      // submitted yet" despite a complete, real approval+signing chain.
      { signedDraftDocumentId: documentId },
    ],
  };
  const letter = await Letter.findOne({ where, attributes: ['id'] });
  if (letter) return getLetter(letter.id, user);

  // A signable draft whose signing request was closed (E27) is no longer on the letter row, but it is
  // still filed as `Letter draft — <letterId> (closed ...)`: resolve it back to its letter by name.
  const doc = await Document.findOne({ where: { id: documentId, tenantId: user.tenantId }, attributes: ['documentName'] });
  const named = doc?.documentName.startsWith(LETTER_DRAFT_NAME_PREFIX)
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(doc.documentName.slice(LETTER_DRAFT_NAME_PREFIX.length))
    : null;
  if (!named) return null;
  const draftLetter = await Letter.findOne({
    where: { id: named[0].toLowerCase(), tenantId: user.tenantId, ...(await scopeWhere(user, { forRead: true })) },
    attributes: ['id'],
  });
  return draftLetter ? getLetter(draftLetter.id, user) : null;
}

/** Fetch a single revision's full bodyHtml on demand — getLetter()'s
 *  revision list omits bodyHtml (up to 200,000 chars each) since callers
 *  almost never need it. Access is gated the same way as getLetter(). */
export async function getLetterRevisionBody(letterId: string, revisionNo: number, user: CurrentUser) {
  await getLetter(letterId, user); // access check (tenant + scope)
  const revision = await LetterRevision.findOne({
    where: { letterId, revisionNo },
    attributes: ['id', 'letterId', 'revisionNo', 'subject', 'bodyHtml', 'savedBy', 'createdAt'],
  });
  if (!revision) throw new AppError(404, 'ERR-REVISION-NOT-FOUND', 'Letter revision not found');
  return revision;
}

async function validateUnitAndDepartment(orgUnitId: string, departmentId: string, tenantId: string) {
  const [unit, department] = await Promise.all([
    OrgUnit.findOne({ where: { id: orgUnitId, tenantId, isActive: true } }),
    Department.findOne({ where: { id: departmentId, tenantId } }),
  ]);
  if (!unit) throw new AppError(422, 'ERR-ORG-UNIT-INVALID', 'Organizational unit is not registered');
  if (!department) throw new AppError(422, 'ERR-DEPT-INVALID', 'Department is not registered');
  // A department belongs to exactly one org unit, and the org unit's code is the
  // UNIT segment of the reference number (REF/UNIT/DEPT/...). Without this check
  // the API accepted any (unit, department) pair, so a letter could be numbered
  // and letterheaded under a unit its department does not belong to — the compose
  // form only ever offers matching pairs, but the endpoint did not enforce it.
  if (department.orgUnitId !== unit.id)
    throw new AppError(422, 'ERR-DEPT-ORG-UNIT-MISMATCH', 'The department does not belong to the selected organizational unit');
  return { unit, department };
}

/** FIX: nothing ever checked that the caller belongs to the department
 *  they're attributing a letter to when AUTHORING one — validateUnitAndDepartment
 *  only checked the org unit/department exist. Same bug class as
 *  documents.service.ts's createDocument (see its own ensureCanCreate fix):
 *  any user holding letter:create (virtually every role) could compose a
 *  letter under ANY department, Executive included, regardless of their own
 *  membership. decideStep already enforces department scope for *deciding*
 *  a role-assigned step (see its own comment above) — this closes the
 *  matching gap at *authoring* time.
 *
 *  Deliberately NOT applied to registerIncomingLetter: registering incoming
 *  mail is inherently cross-department (a front-desk/records registrant
 *  routes physical mail to whichever department it's actually addressed to,
 *  by design — LETTER_REGISTER is a distinct permission from LETTER_CREATE
 *  precisely for that reason), so it stays a separate opt-in call rather
 *  than folded into validateUnitAndDepartment itself, which would have
 *  silently reopened this exact hole for anyone holding LETTER_REGISTER
 *  (DEPT_MANAGER holds both).
 *
 *  LETTER_READ_ALL is reused as the bypass, same as decideStep's — it's
 *  already the letters module's existing "not department-scoped"
 *  permission, not a new one invented for this. */
async function assertDepartmentMembershipForAuthoring(departmentId: string, user: CurrentUser): Promise<void> {
  if (hasPermission(user, PERMISSIONS.LETTER_READ_ALL)) return;
  const deptIds = await getUserDepartmentIds(user.tenantId, user.userId);
  if (!deptIds.includes(departmentId)) {
    throw new AppError(403, 'ERR-DEPT-SCOPE', 'You are not a member of this department and cannot create correspondence under it');
  }
}

export async function createLetter(input: unknown, user: CurrentUser) {
  const data = createLetterSchema.parse(input);
  await validateUnitAndDepartment(data.orgUnitId, data.departmentId, user.tenantId);
  await assertDepartmentMembershipForAuthoring(data.departmentId, user);
  const bodyImageIds = await assertBodyImagesUsable(data.bodyHtml, user); // L13

  const letter = await runInTransaction(async (tx) => {
    const created = await Letter.create(
      {
        tenantId: user.tenantId,
        direction: 'OUTGOING',
        orgUnitId: data.orgUnitId,
        departmentId: data.departmentId,
        letterType: data.letterType,
        subject: data.subject,
        bodyHtml: data.bodyHtml ?? null,
        language: data.language,
        confidentiality: data.confidentiality,
        priority: data.priority,
        correspondent: data.correspondent ?? null,
        correspondentOrganization: data.correspondentOrganization ?? null,
        correspondentLocation: data.correspondentLocation ?? null,
        correspondentEmail: data.correspondentEmail ?? null,
        originType: 'COMPOSED',
        receivedDate: null,
        dueDate: null,
        assignedToUserId: null,
        signatoryUserId: null,
        signatoryName: null,
        signatoryTitle: null,
        approvedAt: null,
        documentId: null,
        attachmentDocumentId: null,
        coverSheetDocumentId: null,
        documentHash: null,
        qrPayload: null,
        referenceNumber: null,
        year: null,
        createdBy: user.userId,
      },
      { transaction: tx },
    );
    await LetterRevision.create(
      { letterId: created.id, revisionNo: 1, subject: data.subject, bodyHtml: data.bodyHtml ?? null, savedBy: user.userId },
      { transaction: tx },
    );
    await linkBodyImagesToLetter(created.id, user.tenantId, bodyImageIds, tx);
    return created;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_CREATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: letter.id, subject: letter.subject, orgUnitId: letter.orgUnitId },
  });
  return letter;
}

// Everything the compose form (letters/new) already collects before there's
// a Letter row to attach a preview to — subject/body are optional here
// (createLetterSchema requires them) so the preview stays available on a
// half-filled draft, same relaxation forms.service.ts's previewFormTemplatePdf
// makes for its own builder.
const previewLetterSchema = z.object({
  orgUnitId: z.string().uuid(),
  departmentId: z.string().uuid(),
  subject: z.string().max(500).optional(),
  bodyHtml: bodyHtmlField,
  correspondent: z.string().max(500).optional(),
  correspondentOrganization: z.string().max(500).optional(),
  correspondentLocation: z.string().max(500).optional(),
});

/** Stateless preview render for the compose page — same
 *  generateLetterSignableDraft() pipeline finalizeLetterInTx uses for the
 *  real signable draft, with whatever the author has typed so far, and no DB
 *  writes/reference number/audit log. Mirrors forms.service.ts's own
 *  previewFormTemplatePdf (POST /forms/templates/preview): same "render the
 *  actual thing, not an HTML/CSS approximation of it" reasoning — a plain
 *  textarea gives no sense of how the body will actually paginate against
 *  the real letterhead artwork's safe zone (letterPdf.ts's
 *  LETTERHEAD_START_Y/LETTERHEAD_BOTTOM_LIMIT_Y).
 *
 *  Same org-unit/department authorization as createLetter (validated even
 *  though nothing is persisted) — otherwise this would be a free way to read
 *  back another department's letterhead title/name pairing. */
export async function previewLetterPdf(input: unknown, user: CurrentUser): Promise<{ pdf: Buffer; blockPages: number[] }> {
  const data = previewLetterSchema.parse(input);
  const { unit, department } = await validateUnitAndDepartment(data.orgUnitId, data.departmentId, user.tenantId);
  await assertDepartmentMembershipForAuthoring(data.departmentId, user);
  await assertBodyImagesUsable(data.bodyHtml, user); // L13

  const { pdf, blockPages } = await generateLetterSignableDraft({
    subject: data.subject?.trim() || '(Subject)',
    bodyHtml: data.bodyHtml ?? null,
    unitName: unit.name,
    letterheadTitle: unit.letterheadTitle,
    departmentName: department.name,
    correspondent: data.correspondent ?? null,
    correspondentOrganization: data.correspondentOrganization ?? null,
    correspondentLocation: data.correspondentLocation ?? null,
    resolveBodyImage: makeLetterBodyImageResolver(user.tenantId, user.userId),
  });
  return { pdf, blockPages };
}

const createScannedLetterSchema = createLetterSchema.omit({ bodyHtml: true });

/** Create an OUTGOING letter whose content is an uploaded scan of a letter
 *  typed/signed on paper, rather than composed in-system — the paper-origin
 *  counterpart of createLetter(). Goes through the identical DRAFT →
 *  IN_REVIEW → APPROVED chain (submitLetter/decideStep, unchanged); only
 *  finalizeLetterInTx branches on originType to skip HTML→PDF rendering and
 *  promote the staged attachment to the final documentId instead. */
export async function createScannedOutgoingLetter(
  input: unknown,
  file: Express.Multer.File | undefined,
  user: CurrentUser,
) {
  const data = createScannedLetterSchema.parse(input);
  const { unit, department } = await validateUnitAndDepartment(data.orgUnitId, data.departmentId, user.tenantId);
  await assertDepartmentMembershipForAuthoring(data.departmentId, user);
  if (!file) throw new AppError(422, 'ERR-SCAN-REQUIRED', 'A scanned file is required for a scanned outgoing letter');
  if (!isValidScanFile(file))
    throw new AppError(422, 'ERR-SCAN-TYPE', 'Outgoing scans must be PDF, Word, or image files');
  // Same AV scan as the main document upload path (documents.service.ts
  // createDocument) — a CAMS scan is a real uploaded file like any other and
  // must not become a softer, unscanned upload path just because it files
  // through a different module.
  const avScanStatus = await scanBuffer(file.buffer);

  const docType = await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'CORR' } });
  if (!docType)
    throw new AppError(500, 'ERR-DOCTYPE-CORR-MISSING', 'Correspondence document type is not seeded for this tenant');

  const letter = await runInTransaction(async (tx) => {
    // Staged now (before any approval) so reviewers can actually see what
    // they're approving — promoted to documentId only at final approval,
    // mirroring COMPOSED's invariant that documentId means "finalized".
    const attachmentDocumentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
    const storageKey = `${user.tenantId}/${department.code}/CORR/${attachmentDocumentId}/${versionId}/${sanitizeFilename(file.originalname)}`;
    const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
      storageKey, file.buffer, file.mimetype, department.id, user.tenantId,
    );
    // FIX 2026-09-15: letters never checked/reserved tenant storage quota at
    // any of its encrypted-storage write sites (unlike documents.service.ts,
    // esigning.service.ts, forms.service.ts, tusUpload.ts, all of which call
    // this before Document.create) — a tenant could consume unlimited
    // storage through CAMS scans/attachments regardless of its configured
    // quota. Same convention as those: reserve inside the transaction, right
    // before the Document row that will account for it.
    await reserveStorageQuota(user.tenantId, file.size, tx);
    await Document.create(
      {
        id: attachmentDocumentId,
        tenantId: user.tenantId,
        // documents(tenant_id, document_name) is unique — subject alone
        // isn't (two letters can share a subject), so suffix the document's
        // own id. Renamed to the reference number at approval, like COMPOSED.
        documentName: `${data.subject.slice(0, 235)} — ${attachmentDocumentId.slice(0, 8)}`,
        title: data.subject.slice(0, 255),
        departmentId: department.id,
        documentTypeId: docType.id,
        folderId: null,
        ownerId: user.userId,
        organisationUnit: unit.code,
        status: 'ACTIVE',
        securityClassification: data.confidentiality,
        retentionClass: 'RET-CORR-5Y',
        documentDate: new Date(),
        retentionTriggerDate: new Date(),
        disposalEligibleDate: null,
        latestVersionId: null,
        source: 'SCANNER',
        archivedAt: null,
        ocrStatus: 'PENDING',
        ocrConfidenceScore: null,
        aiSummary: null,
        aiSuggestedMetadata: null,
        deletedAt: null,
      },
      { transaction: tx },
    );
    // Retention engine (gap register #1 / D11): letters never called this —
    // every letter/attachment/cover-sheet document carried a real, seeded
    // retentionClass (RET-CORR-5Y) but never got a disposalEligibleDate or a
    // RetentionApplication row, silently exempting the whole correspondence
    // module from the disposal-eligibility engine. Every other
    // document-creation path in the platform calls this right after create.
    await applyRetention(attachmentDocumentId, tx);
    // A freshly Document.create'd row has zero ACL entries until something
    // grants them -- this document is staged and viewable pre-approval (the
    // whole point is reviewers can see what they're approving), and stays
    // the letter's document of record when promoted at finalize.
    await grantLetterDocumentAcl(
      { documentId: attachmentDocumentId, ownerId: user.userId, tenantId: user.tenantId, departmentId: department.id, confidentiality: data.confidentiality },
      tx,
    );
    const version = await DocumentVersion.create(
      {
        id: versionId,
        documentId: attachmentDocumentId,
        versionNumber: '1.0',
        isMajorVersion: true,
        storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        sha256Hash: encHash,
        plaintextSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'CAMS: staged scanned outgoing letter (pending approval)',
        avScanStatus,
      },
      { transaction: tx },
    );
    await Document.update({ latestVersionId: version.id }, { where: { id: attachmentDocumentId }, transaction: tx });
    await DocumentDek.create(
      { documentId: attachmentDocumentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
      { transaction: tx },
    );
    // OCR-index the staged scan so it's searchable even before approval.
    await OutboxEvent.bulkCreate(
      [
        { documentId: attachmentDocumentId, type: 'OCR_PROCESSING', channel: 'OCR', payload: JSON.stringify({ documentId: attachmentDocumentId, versionId, tenantId: user.tenantId }) },
        { documentId: attachmentDocumentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId: attachmentDocumentId, tenantId: user.tenantId }) },
      ],
      { transaction: tx },
    );

    const created = await Letter.create(
      {
        tenantId: user.tenantId,
        direction: 'OUTGOING',
        orgUnitId: data.orgUnitId,
        departmentId: data.departmentId,
        letterType: data.letterType,
        originType: 'SCANNED',
        subject: data.subject,
        bodyHtml: null,
        language: data.language,
        confidentiality: data.confidentiality,
        priority: data.priority,
        correspondent: data.correspondent ?? null,
        correspondentOrganization: data.correspondentOrganization ?? null,
        correspondentLocation: data.correspondentLocation ?? null,
        correspondentEmail: data.correspondentEmail ?? null,
        receivedDate: null,
        dueDate: null,
        assignedToUserId: null,
        signatoryUserId: null,
        signatoryName: null,
        signatoryTitle: null,
        approvedAt: null,
        documentId: null,
        attachmentDocumentId,
        coverSheetDocumentId: null,
        documentHash: null,
        qrPayload: null,
        referenceNumber: null,
        year: null,
        createdBy: user.userId,
      },
      { transaction: tx },
    );
    await LetterRevision.create(
      { letterId: created.id, revisionNo: 1, subject: data.subject, bodyHtml: null, savedBy: user.userId },
      { transaction: tx },
    );
    return created;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_CREATED,
    userId: user.userId, userRole: user.role, documentId: letter.attachmentDocumentId,
    actionDetails: { letterId: letter.id, subject: letter.subject, orgUnitId: letter.orgUnitId, originType: 'SCANNED' },
  });
  if (avScanStatus === 'unscanned') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
      userId: user.userId, userRole: user.role, documentId: letter.attachmentDocumentId,
      actionDetails: { reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
    });
  }
  // Surface the same fail-open scan warning the frontend already understands
  // for the main document upload path (documents.service.ts's createDocument/
  // uploadVersion) — avScanStatus was computed above but never told to the
  // caller until now.
  return { ...letter.get({ plain: true }), warnings: avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : [] };
}

/** Lock the letter row and assert it is still DRAFT/RETURNED — the write-side twin of the
 *  unlocked EDITABLE_STATES pre-checks in updateLetter / addLetterAttachment /
 *  removeLetterAttachment, so a concurrent submit or cancel cannot interleave. */
async function lockEditableLetter(letterId: string, tenantId: string, tx: SequelizeTransaction) {
  const locked = await Letter.findOne({
    where: { id: letterId, tenantId, status: { [Op.in]: EDITABLE_STATES } },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!locked)
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', 'Letter is no longer editable (state changed concurrently)');
  return locked;
}

export async function updateLetter(id: string, input: unknown, user: CurrentUser) {
  const data = updateLetterSchema.parse(input);
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.createdBy !== user.userId)
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can edit this letter');
  if (!EDITABLE_STATES.includes(letter.status as any))
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Letter cannot be edited in status ${letter.status}`);
  if (data.orgUnitId || data.departmentId) {
    await validateUnitAndDepartment(
      data.orgUnitId ?? letter.orgUnitId,
      data.departmentId ?? letter.departmentId!,
      user.tenantId,
    );
    if (data.departmentId) await assertDepartmentMembershipForAuthoring(data.departmentId, user);
  }
  const bodyImageIds = data.bodyHtml !== undefined ? await assertBodyImagesUsable(data.bodyHtml, user) : []; // L13
  const classificationChanged = data.confidentiality !== undefined && data.confidentiality !== letter.confidentiality;

  const contentChanged =
    (data.subject !== undefined && data.subject !== letter.subject) ||
    (data.bodyHtml !== undefined && data.bodyHtml !== (letter.bodyHtml ?? undefined));

  await runInTransaction(async (tx) => {
    // Race guard: the editable-state check above ran unlocked, so a submit that
    // committed in between would otherwise let this write change the subject/
    // body of a letter that is already in review. Re-assert under the row lock.
    await lockEditableLetter(letter.id, user.tenantId, tx);
    await letter.update(
      {
        ...(data.orgUnitId !== undefined ? { orgUnitId: data.orgUnitId } : {}),
        ...(data.departmentId !== undefined ? { departmentId: data.departmentId } : {}),
        ...(data.subject !== undefined ? { subject: data.subject } : {}),
        ...(data.bodyHtml !== undefined ? { bodyHtml: data.bodyHtml } : {}),
        ...(data.letterType !== undefined ? { letterType: data.letterType } : {}),
        ...(data.confidentiality !== undefined ? { confidentiality: data.confidentiality } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.language !== undefined ? { language: data.language } : {}),
        ...(data.correspondent !== undefined ? { correspondent: data.correspondent } : {}),
        ...(data.correspondentOrganization !== undefined
          ? { correspondentOrganization: data.correspondentOrganization }
          : {}),
        ...(data.correspondentLocation !== undefined ? { correspondentLocation: data.correspondentLocation } : {}),
        ...(data.correspondentEmail !== undefined ? { correspondentEmail: data.correspondentEmail } : {}),
      },
      { transaction: tx },
    );
    await linkBodyImagesToLetter(letter.id, user.tenantId, bodyImageIds, tx);
    // L14: the backing documents (attachments, staged scan) carry the letter's classification and ACL;
    // changing either after creation must re-apply the participants-only rule to them.
    if (classificationChanged) {
      await syncLetterDocumentAcl(letter.id, user.tenantId, tx, { classificationChanged: true });
    }
    if (contentChanged) {
      const last = await LetterRevision.findOne({
        where: { letterId: letter.id }, order: [['revisionNo', 'DESC']], transaction: tx,
      });
      await LetterRevision.create(
        {
          letterId: letter.id,
          revisionNo: (last?.revisionNo ?? 0) + 1,
          subject: letter.subject,
          bodyHtml: letter.bodyHtml,
          savedBy: user.userId,
        },
        { transaction: tx },
      );
    }
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_UPDATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: letter.id, contentChanged },
  });
  return letter;
}

/** Attach a supplementary file to a letter while it's still editable — the
 *  "paperclip" equivalent of composing an email with attachments. Distinct
 *  from a SCANNED-origin letter's single content file (attachmentDocumentId):
 *  a letter can carry any number of these alongside its composed body or
 *  scanned original. Owner-only, same EDITABLE_STATES gate as updateLetter(). */
export async function addLetterAttachment(
  letterId: string,
  file: Express.Multer.File | undefined,
  user: CurrentUser,
) {
  if (!file) throw new AppError(422, 'ERR-ATTACHMENT-REQUIRED', 'A file is required');
  if (!isValidScanFile(file))
    throw new AppError(422, 'ERR-ATTACHMENT-TYPE', 'Attachments must be PDF, Word, or image files');
  // Same AV scan as the main document upload path — an attachment is a real
  // uploaded file like any other.
  const avScanStatus = await scanBuffer(file.buffer);

  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.createdBy !== user.userId)
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can attach files to this letter');
  if (!EDITABLE_STATES.includes(letter.status as any))
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Cannot attach files while the letter is ${letter.status}`);
  if (!letter.departmentId) throw new AppError(422, 'ERR-DEPT-INVALID', 'Letter must belong to a department');

  const [unit, department] = await Promise.all([
    OrgUnit.findByPk(letter.orgUnitId),
    Department.findByPk(letter.departmentId),
  ]);
  if (!unit || !department) throw new AppError(500, 'ERR-LETTER-ORG-MISSING', "Letter's org unit or department not found");
  const docType = await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'CORR' } });
  if (!docType)
    throw new AppError(500, 'ERR-DOCTYPE-CORR-MISSING', 'Correspondence document type is not seeded for this tenant');

  const attachment = await runInTransaction(async (tx) => {
    await lockEditableLetter(letter.id, user.tenantId, tx); // race guard vs a concurrent submit/cancel
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
    const storageKey = `${user.tenantId}/${department.code}/CORR/${letterId}/attachments/${documentId}/${sanitizeFilename(file.originalname)}`;
    const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
      storageKey, file.buffer, file.mimetype, department.id, user.tenantId,
    );
    await reserveStorageQuota(user.tenantId, file.size, tx);
    await Document.create(
      {
        id: documentId,
        tenantId: user.tenantId,
        // documents(tenant_id, document_name) is unique — a filename alone
        // isn't (e.g. two "invoice.pdf" attachments), so suffix the id.
        documentName: `${file.originalname.slice(0, 235)} — ${documentId.slice(0, 8)}`,
        title: file.originalname.slice(0, 255),
        departmentId: department.id,
        documentTypeId: docType.id,
        folderId: null,
        ownerId: user.userId,
        organisationUnit: unit.code,
        status: 'ACTIVE',
        securityClassification: letter.confidentiality,
        retentionClass: 'RET-CORR-5Y',
        documentDate: new Date(),
        retentionTriggerDate: new Date(),
        disposalEligibleDate: null,
        latestVersionId: null,
        source: 'MANUAL_UPLOAD',
        archivedAt: null,
        ocrStatus: 'PENDING',
        ocrConfidenceScore: null,
        aiSummary: null,
        aiSuggestedMetadata: null,
        deletedAt: null,
      },
      { transaction: tx },
    );
    // Retention engine (gap register #1 / D11) — see the parallel comment in
    // createScannedOutgoingLetter above.
    await applyRetention(documentId, tx);
    // A freshly Document.create'd row has zero ACL entries until something
    // grants them.
    await grantLetterDocumentAcl(
      {
        documentId, ownerId: user.userId, tenantId: user.tenantId, departmentId: department.id,
        confidentiality: letter.confidentiality,
        participantIds: isParticipantsOnly(letter.confidentiality) ? await collectLetterParticipantIds(letter, tx) : [],
      },
      tx,
    );
    const version = await DocumentVersion.create(
      {
        id: versionId,
        documentId,
        versionNumber: '1.0',
        isMajorVersion: true,
        storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        sha256Hash: encHash,
        plaintextSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'CAMS: letter attachment uploaded',
        avScanStatus,
      },
      { transaction: tx },
    );
    await Document.update({ latestVersionId: version.id }, { where: { id: documentId }, transaction: tx });
    await DocumentDek.create(
      { documentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
      { transaction: tx },
    );
    await OutboxEvent.bulkCreate(
      [
        { documentId, type: 'OCR_PROCESSING', channel: 'OCR', payload: JSON.stringify({ documentId, versionId, tenantId: user.tenantId }) },
        { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
      ],
      { transaction: tx },
    );
    return LetterAttachment.create(
      { tenantId: user.tenantId, letterId, documentId, originalFilename: file.originalname, uploadedBy: user.userId },
      { transaction: tx },
    );
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_UPDATED,
    userId: user.userId, userRole: user.role, documentId: attachment.documentId,
    actionDetails: { letterId, attachmentId: attachment.id, filename: file.originalname, action: 'attachment-added' },
  });
  if (avScanStatus === 'unscanned') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
      userId: user.userId, userRole: user.role, documentId: attachment.documentId,
      actionDetails: { reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
    });
  }
  // Same WARN-UNSCANNED surfacing as the other scan-computing letter paths —
  // getLetter() itself never sets this, so it's merged in here explicitly.
  const updatedLetter = await getLetter(letterId, user);
  return { ...updatedLetter.get({ plain: true }), warnings: avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : [] };
}

export async function removeLetterAttachment(letterId: string, attachmentId: string, user: CurrentUser) {
  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.createdBy !== user.userId)
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can remove attachments from this letter');
  if (!EDITABLE_STATES.includes(letter.status as any))
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Cannot remove attachments while the letter is ${letter.status}`);

  const attachment = await LetterAttachment.findOne({ where: { id: attachmentId, letterId, tenantId: user.tenantId } });
  if (!attachment) throw new AppError(404, 'ERR-ATTACHMENT-NOT-FOUND', 'Attachment not found');

  // COMP-1: this hard-deletes the backing document below (DEK, version, and
  // the row itself, force: true) — unlike every OTHER hard-delete path in
  // the codebase (executePurge, deleteDraftPermanently, moveToTrash,
  // authoriseDisposal), this one had no legal-hold check at all. A records
  // officer placing a hold on a correspondence document did not stop the
  // original author from destroying it here while the parent letter was
  // still DRAFT/RETURNED — the entire point of a hold is that nothing
  // destructive proceeds, regardless of who requests it or why.
  const backingDocument = await Document.findByPk(attachment.documentId);
  if (backingDocument) requireLegalHoldClear(backingDocument);

  // The attachment's backing CORR document exists ONLY to carry this file —
  // removing just the LetterAttachment row used to orphan the Document,
  // its version, its DEK, and the encrypted blob forever (storage leak).
  // Purge the whole graph, mirroring trashService's purge: rows in the
  // transaction, the irreversible storage delete only after commit.
  const documentId = attachment.documentId;
  await runInTransaction(async (tx) => {
    await lockEditableLetter(letter.id, user.tenantId, tx); // race guard vs a concurrent submit/cancel
    const versions = await DocumentVersion.findAll({
      where: { documentId }, attributes: ['storageKey'], transaction: tx,
    });
    await attachment.destroy({ transaction: tx });
    await DocumentDek.destroy({ where: { documentId }, transaction: tx });
    await DocumentVersion.destroy({ where: { documentId }, transaction: tx });
    // access rows are polymorphic (no FK), so they do not cascade with the document
    await AclEntry.destroy({ where: { tenantId: user.tenantId, resourceType: 'document', resourceId: documentId }, transaction: tx });
    await Document.destroy({ where: { id: documentId, tenantId: user.tenantId }, transaction: tx, force: true });
    await OutboxEvent.create(
      {
        documentId: null,
        type: 'SEARCH_INDEX_DELETE',
        channel: 'SEARCH_INDEX',
        payload: JSON.stringify({ documentId, tenantId: user.tenantId }),
      },
      { transaction: tx },
    );
    tx.afterCommit(async () => {
      // Lazy import: StorageAdapter pulls in the MinIO client at module load,
      // which the unit-test environment (mocked config) can't construct.
      const { getStorageAdapter } = await import('../../infrastructure/storage/StorageAdapter.js');
      const storage = getStorageAdapter();
      for (const version of versions) {
        try {
          await storage.delete(`${version.storageKey}.enc`);
        } catch (err) {
          logger.warn({ err, documentId, storageKey: version.storageKey },
            '[letters] attachment blob delete failed after row purge — clean up via sweep-orphaned-storage');
        }
      }
    });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_UPDATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId, attachmentId, action: 'attachment-removed' },
  });
  return getLetter(letterId, user);
}

export async function downloadLetterAttachment(letterId: string, attachmentId: string, user: CurrentUser) {
  const letter = await getLetter(letterId, user); // scope-checked read access
  const attachment = await LetterAttachment.findOne({ where: { id: attachmentId, letterId: letter.id } });
  if (!attachment) throw new AppError(404, 'ERR-ATTACHMENT-NOT-FOUND', 'Attachment not found');
  const version = await DocumentVersion.findOne({
    where: { documentId: attachment.documentId }, order: [['createdAt', 'DESC']],
  });
  if (!version) throw new AppError(500, 'ERR-VERSION-MISSING', 'Filed document version not found');
  const buffer = await fetchAndDecrypt(version.storageKey, version.id);
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_VIEWED,
    userId: user.userId, userRole: user.role, documentId: attachment.documentId,
    actionDetails: { letterId, attachmentId, action: 'download-attachment' },
  });
  return { buffer, filename: version.originalFilename, mimeType: version.mimeType };
}

export async function submitLetter(id: string, input: unknown, user: CurrentUser) {
  const { steps } = submitSchema.parse(input ?? {});
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.createdBy !== user.userId)
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can submit this letter');
  if (!EDITABLE_STATES.includes(letter.status as any))
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Letter cannot be submitted in status ${letter.status}`);

  const chain = steps ?? [{ stepType: 'APPROVE' as const, assignedRole: 'DEPT_MANAGER' }];
  if (chain[chain.length - 1]!.stepType !== 'APPROVE')
    throw new AppError(422, 'ERR-LETTER-CHAIN-INVALID', 'The final step of the approval chain must be an APPROVE step');

  for (const step of chain) {
    if (step.assignedUserId) await assertNotHiddenUser(step.assignedUserId, user.userId);
    // L15: a step named after the drafter could never be decided (decideStep refuses self-approval);
    // refuse it up front instead of creating a chain that is stuck from its first step.
    if (step.assignedUserId && step.assignedUserId === letter.createdBy)
      throw new AppError(422, 'ERR-STEP-SELF-APPROVAL', "You cannot assign an approval step to the letter's drafter");
    await assertStepIsActionable(step, user.tenantId, letter.departmentId ?? null, LETTER_STEP_RULES);
  }
  await runInTransaction(async (tx) => {
    // Race guard: re-fetch under lock so a concurrent submit/decide can't
    // interleave (the pre-checks above ran unlocked).
    const locked = await Letter.findOne({
      where: { id: letter.id, tenantId: user.tenantId, status: { [Op.in]: ['DRAFT', 'RETURNED'] } },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked)
      throw new AppError(409, 'ERR-LETTER-STATE-INVALID', 'Letter is no longer submittable (state changed concurrently)');
    await LetterApprovalStep.update(
      { status: 'CANCELLED' },
      { where: { letterId: letter.id, status: { [Op.in]: ['WAITING', 'PENDING'] } }, transaction: tx },
    );
    const last = await LetterApprovalStep.findOne({
      where: { letterId: letter.id }, order: [['stepOrder', 'DESC']], transaction: tx,
    });
    let order = (last?.stepOrder ?? 0) + 1;
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]!;
      const slaHours = step.slaHours ?? (config.LETTER_STEP_DEFAULT_SLA_HOURS || null);
      await LetterApprovalStep.create(
        {
          letterId: letter.id,
          stepOrder: order++,
          stepType: step.stepType,
          assignedUserId: step.assignedUserId ?? null,
          assignedRole: step.assignedRole ?? null,
          status: i === 0 ? 'PENDING' : 'WAITING',
          comment: null,
          decidedBy: null,
          decidedAt: null,
          slaHours,
          // The clock starts when a step becomes the current one, so only the first step has a due date now.
          dueAt: i === 0 && slaHours ? new Date(Date.now() + slaHours * 3_600_000) : null,
        },
        { transaction: tx },
      );
    }
    // The signatory is deliberately NOT set here any more — it belongs to
    // initiateLetterSigning. Clearing it on (re)submit also means a letter
    // that was RETURNED and resubmitted cannot silently carry a stale
    // signatory chosen before the changes were made.
    await locked.update(
      { status: 'IN_REVIEW', assignedSignatoryUserId: null, assignedSignatoryRole: null },
      { transaction: tx },
    );
    // L14: the chain's participants are new; a participants-only letter's documents must reach them.
    await syncLetterDocumentAcl(letter.id, user.tenantId, tx);
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_SUBMITTED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: letter.id, steps: chain },
  });

  await enqueueWebsocketEvent('LETTER.SUBMITTED', {
    tenantId: user.tenantId, departmentId: letter.departmentId, letterId: letter.id, subject: letter.subject,
  });
  // Notify the first step's assignee that it awaits them.
  const firstStep = await LetterApprovalStep.findOne({
    where: { letterId: letter.id, status: 'PENDING' }, order: [['stepOrder', 'ASC']],
  });
  if (firstStep) await notifyStepPending(letter, firstStep).catch(() => {});
  return getLetter(id, user);
}

/** Notify the assignee that a letter step is now awaiting their decision:
 *  a websocket ping (department room + the assignee's own room), an EMAIL
 *  outbox event, and an in-app Notification row (resolves to the named
 *  user, or holders of the assigned role within the letter's department).
 *  Fire-and-forget. */
async function notifyStepPending(letter: Letter, step: LetterApprovalStep): Promise<void> {
  // FIX: a named assignee is not guaranteed to be a member of the letter's
  // own department (the same gap already fixed for APPROVAL_CHAIN.UPDATED
  // and SIGNING.UPDATED) — department-room-only routing silently missed
  // them. Resolve recipients once, up front, and reuse for both the
  // websocket room targeting and the in-app fanOut below.
  const recipientIds = step.assignedUserId
    ? [step.assignedUserId]
    : step.assignedRole
      ? await resolveRoleUserIds(step.assignedRole, letter.tenantId, letter.departmentId)
      : [];

  await enqueueWebsocketEvent('LETTER.STEP_PENDING', {
    tenantId: letter.tenantId,
    departmentId: letter.departmentId,
    letterId: letter.id,
    subject: letter.subject,
    stepType: step.stepType,
    recipientUserIds: recipientIds.length > 0 ? recipientIds : undefined,
  });
  await OutboxEvent.create({
    type: 'LETTER.STEP_PENDING',
    channel: 'EMAIL',
    payload: JSON.stringify({
      tenantId: letter.tenantId,
      letterId: letter.id,
      subject: letter.subject,
      stepType: step.stepType,
      assignedUserId: step.assignedUserId,
      assignedRole: step.assignedRole,
    }),
  });

  if (recipientIds.length > 0) {
    await fanOut({
      type: 'LETTER_STEP_PENDING',
      tenantId: letter.tenantId,
      recipientIds,
      severity: 'INFO',
      payload: { letterId: letter.id, subject: letter.subject, stepType: step.stepType },
    }).catch(() => {});
  }
}

/** Emails every EXECUTIVE-role user in the tenant when a letter reaches a
 *  final state — outgoing approval or incoming registration, never drafts —
 *  with the letter's file attached (when one exists). Tenant-wide standing
 *  oversight, independent of the letter's department, and separate from the
 *  in-app notifications the actual participants (creator/assignee/approver)
 *  get via fanOut(). Best-effort: a notification failure must never fail the
 *  letter operation itself. */
const CONFIDENTIALITY_RANK: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

export async function notifyExecutivesOfLetter(
  letter: Letter,
  context: { departmentName: string | null; attachDocumentId: string | null },
): Promise<void> {
  try {
    // D10: the every-letter-to-all-executives blast is now governed by tenant
    // config — per letter type and confidentiality threshold — plus a
    // per-executive opt-out. Defaults: all letter types, PUBLIC+INTERNAL only
    // (CONFIDENTIAL/RESTRICTED letters are never auto-emailed).
    const tenant = await Tenant.findByPk(letter.tenantId);
    const cfg = (tenant?.execNoticeConfig ?? {}) as { letterTypes?: string[]; maxConfidentiality?: string };
    const allowedTypes = Array.isArray(cfg.letterTypes) && cfg.letterTypes.length > 0 ? cfg.letterTypes : null;
    if (allowedTypes && !allowedTypes.includes(letter.letterType)) return;
    const maxRank = CONFIDENTIALITY_RANK[cfg.maxConfidentiality ?? 'INTERNAL'] ?? 1;
    if ((CONFIDENTIALITY_RANK[letter.confidentiality] ?? 3) > maxRank) return;

    const allExecIds = await resolveRoleUserIds('EXECUTIVE', letter.tenantId, null);
    if (allExecIds.length === 0) return;
    const optedIn = await User.findAll({
      where: { id: { [Op.in]: allExecIds }, execNoticeOptOut: false },
      attributes: ['id'],
    });
    const recipientIds = optedIn.map((u) => u.id);
    if (recipientIds.length === 0) return;
    await OutboxEvent.bulkCreate(
      recipientIds.map((recipientUserId) => ({
        type: 'LETTER.EXECUTIVE_NOTICE',
        channel: 'EMAIL' as const,
        payload: JSON.stringify({
          tenantId: letter.tenantId,
          letterId: letter.id,
          referenceNumber: letter.referenceNumber,
          subject: letter.subject,
          direction: letter.direction,
          correspondent: letter.correspondent,
          departmentName: context.departmentName,
          recipientUserId,
          attachDocumentId: context.attachDocumentId,
          hasAttachment: Boolean(context.attachDocumentId),
        }),
      })),
    );
  } catch (err) {
    logger.warn({ err, letterId: letter.id }, 'Failed to queue executive correspondence notice');
  }
}

/** Lock the letter row (no joins — FOR UPDATE) and assert it is still in review. */
async function lockLetterInReview(letterId: string, tenantId: string, tx: SequelizeTransaction) {
  const locked = await Letter.findOne({
    where: { id: letterId, tenantId, status: 'IN_REVIEW' },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!locked)
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', 'Letter is no longer awaiting review (state changed concurrently)');
  return locked;
}

/** Guarded step transition: the WHERE clause re-asserts PENDING so a concurrent
 *  decision loses with a 409 instead of double-applying. */
async function guardedStepDecision(
  stepId: string,
  letterId: string,
  values: { status: 'APPROVED' | 'RETURNED'; comment: string | null; decidedBy: string; decidedAt: Date },
  tx: SequelizeTransaction,
) {
  const [updated] = await LetterApprovalStep.update(values, {
    where: { id: stepId, letterId, status: 'PENDING' },
    transaction: tx,
  });
  if (updated !== 1)
    throw new AppError(409, 'ERR-STEP-NOT-PENDING', 'This step has already been decided');
}

export async function decideStep(letterId: string, stepId: string, input: unknown, user: CurrentUser) {
  const { decision, comment } = decisionSchema.parse(input);
  const letter = await Letter.findOne({
    where: { id: letterId, tenantId: user.tenantId },
    include: [{ model: OrgUnit, as: 'orgUnit' }, { model: Department, as: 'department' }],
  });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.status !== 'IN_REVIEW')
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Letter is not awaiting review (status ${letter.status})`);

  const step = await LetterApprovalStep.findOne({ where: { id: stepId, letterId } });
  if (!step) throw new AppError(404, 'ERR-STEP-NOT-FOUND', 'Approval step not found');
  if (step.status !== 'PENDING')
    throw new AppError(409, 'ERR-STEP-NOT-PENDING', 'This step is not awaiting a decision');
  // An overdue step that escalated (letterEscalation.service.ts) may also be decided by the department head(s)
  // it escalated to; they are added beside the assignee, nobody is removed.
  const escalatedToUser = !stepIsAssignedTo(step, user) && (step.escalatedToUserIds ?? []).includes(user.userId);
  if (!stepIsAssignedTo(step, user) && !escalatedToUser)
    throw new AppError(403, 'ERR-STEP-NOT-ASSIGNED', 'This step is not assigned to you');

  // Role-assigned steps are department-scoped: a DEPT_MANAGER in Finance must
  // not be able to approve HR's letters just because the role name matches.
  // Shared with the unified engine via stepRules.ts (R-08). An escalatee was chosen from the letter's own
  // department (or above it) by the escalation, so the role scope does not apply to them.
  if (!escalatedToUser) {
    await assertRoleStepDepartmentScope(
      step, user, user.tenantId, letter.departmentId ?? null, LETTER_STEP_RULES,
    );
  }

  const neededPermission = step.stepType === 'APPROVE' ? PERMISSIONS.LETTER_APPROVE : PERMISSIONS.LETTER_REVIEW;
  if (!hasPermission(user, neededPermission) && !hasPermission(user, PERMISSIONS.LETTER_APPROVE))
    throw new AppError(403, 'ERR-PERMISSION-DENIED', `Missing permission: ${neededPermission}`);

  // L15 separation of duties, same rule and code as the unified engine (ERR-SELF-APPROVAL): the drafter
  // cannot approve their own letter, whatever step they hold. Returning it stays allowed (it only sends
  // it back to them). If the drafter is the only qualified approver, a department head reassigns the
  // step (reassignStep) — that is the intended escape, not self-approval.
  if (decision === 'APPROVE' && letter.createdBy === user.userId) {
    throw new AppError(
      403,
      'ERR-SELF-APPROVAL',
      'You drafted this letter and cannot approve it yourself — ask a department head to assign another approver',
    );
  }

  if (decision === 'RETURN') {
    await runInTransaction(async (tx) => {
      const locked = await lockLetterInReview(letterId, user.tenantId, tx);
      await guardedStepDecision(stepId, letterId,
        { status: 'RETURNED', comment: comment ?? null, decidedBy: user.userId, decidedAt: new Date() }, tx);
      await LetterApprovalStep.update(
        { status: 'CANCELLED' },
        { where: { letterId, status: 'WAITING' }, transaction: tx },
      );
      await locked.update({ status: 'RETURNED' }, { transaction: tx });
    });
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_RETURNED,
      userId: user.userId, userRole: user.role,
      actionDetails: { letterId, stepId, comment: comment ?? null },
    });
    await enqueueWebsocketEvent('LETTER.RETURNED', {
      tenantId: user.tenantId, departmentId: letter.departmentId, letterId, subject: letter.subject,
    });
    await fanOut({
      type: 'LETTER_RETURNED',
      tenantId: user.tenantId,
      recipientIds: [letter.createdBy],
      severity: 'WARNING',
      payload: { letterId, subject: letter.subject, comment: comment ?? null },
    }).catch(() => {});
    return getLetter(letterId, user);
  }

  // APPROVE — one transaction covers the guard, the advance, and (if final)
  // the whole finalize, so two concurrent approvals can never both allocate
  // a reference number: the letter row lock serializes them and the guarded
  // step update 409s the loser.
  const outcome = await runInTransaction(async (tx) => {
    const locked = await lockLetterInReview(letterId, user.tenantId, tx);
    await guardedStepDecision(stepId, letterId,
      { status: 'APPROVED', comment: comment ?? null, decidedBy: user.userId, decidedAt: new Date() }, tx);

    const next = await LetterApprovalStep.findOne({
      where: { letterId, status: 'WAITING' },
      order: [['stepOrder', 'ASC']],
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (next) {
      await next.update(
        { status: 'PENDING', dueAt: next.slaHours ? new Date(Date.now() + next.slaHours * 3_600_000) : null },
        { transaction: tx },
      );
      await syncLetterDocumentAcl(letterId, user.tenantId, tx); // L14: the new step's holder joins
      return { outcome: 'advanced' as const, letter: locked };
    }

    if (step.stepType !== 'APPROVE')
      throw new AppError(409, 'ERR-LETTER-CHAIN-INVALID', 'Final step must be an APPROVE step');

    // Outgoing composed letters still need a real signature before they can be
    // finalized: the reference number and its QR are baked into the signed page
    // content, so the number cannot be allocated first (see the comment block
    // above finalizeLetterAfterSigning).
    //
    // CHANGED: this used to create the signing ceremony right here, as a side
    // effect of the final approval, defaulting the signatory to whoever gave
    // that approval. That fused two different actions — the person chosen to
    // SIGN was sent an APPROVAL task and only received a signature request
    // afterwards. Approval now simply completes, and signing is started
    // explicitly by initiateLetterSigning, which is where the signatory is
    // chosen.
    if (locked.direction === 'OUTGOING' && locked.originType === 'COMPOSED') {
      await locked.update({ status: 'APPROVED' }, { transaction: tx });
      return { outcome: 'awaitingSigning' as const, letter: locked };
    }
    await finalizeLetterAfterSigning(locked, user, tx);
    return { outcome: 'finalized' as const, letter: locked };
  });

  if (outcome.outcome === 'advanced') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_REVIEW_DECIDED,
      userId: user.userId, userRole: user.role,
      actionDetails: { letterId, stepId, decision: 'APPROVE', comment: comment ?? null },
    });
    // The next step is now PENDING — notify its assignee.
    const nextPending = await LetterApprovalStep.findOne({
      where: { letterId, status: 'PENDING' }, order: [['stepOrder', 'ASC']],
    });
    if (nextPending) await notifyStepPending(outcome.letter, nextPending).catch(() => {});
    return getLetter(letterId, user);
  }

  // NOTE: there is no 'pendingSignature' outcome here any more. decideStep no
  // longer creates the signing ceremony — see the comment on the
  // 'awaitingSigning' branch. LETTER_PENDING_SIGNATURE is audited by
  // initiateLetterSigning instead, which is the action that now starts it.

  if (outcome.outcome === 'awaitingSigning') {
    // Approval is complete. No reference number exists yet and no document has
    // been filed — both happen at finalize, after the signature. The drafter is
    // told so they can initiate signing; executives are NOT notified yet,
    // because there is no letter of record to attach.
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_APPROVED,
      userId: user.userId, userRole: user.role,
      actionDetails: { letterId, awaitingSigningInitiation: true },
    });
    await enqueueWebsocketEvent('LETTER.APPROVED', {
      tenantId: user.tenantId, departmentId: outcome.letter.departmentId,
      letterId, subject: outcome.letter.subject,
    });
    await fanOut({
      type: 'LETTER_APPROVED',
      tenantId: user.tenantId,
      recipientIds: [outcome.letter.createdBy],
      severity: 'INFO',
      payload: {
        letterId,
        subject: outcome.letter.subject,
        awaitingSigningInitiation: true,
      },
    }).catch(() => {});
    return getLetter(letterId, user);
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_APPROVED,
    userId: user.userId, userRole: user.role, documentId: outcome.letter.documentId,
    actionDetails: { letterId, referenceNumber: outcome.letter.referenceNumber },
  });
  await enqueueWebsocketEvent('LETTER.APPROVED', {
    tenantId: user.tenantId, departmentId: outcome.letter.departmentId,
    letterId, referenceNumber: outcome.letter.referenceNumber, subject: outcome.letter.subject,
  });
  await fanOut({
    type: 'LETTER_APPROVED',
    tenantId: user.tenantId,
    recipientIds: [outcome.letter.createdBy],
    severity: 'INFO',
    payload: { letterId, referenceNumber: outcome.letter.referenceNumber, subject: outcome.letter.subject },
  }).catch(() => {});
  await notifyExecutivesOfLetter(outcome.letter, {
    departmentName: (letter as Letter & { department?: Department }).department?.name ?? null,
    attachDocumentId: outcome.letter.documentId,
  });
  return getLetter(letterId, user);
}

/** Runs INSIDE the caller's transaction (which holds the letter row lock).
 *  Renders the unnumbered signable draft, files it as a working (ACTIVE)
 *  document, moves the letter to PENDING_SIGNATURE, and creates+sends a
 *  single-recipient signature ceremony targeting the approver who just
 *  completed the final review step — they're the same person the old fake
 *  "Approved and digitally signed by" stamp used to name, now actually
 *  signing instead of just being typeset. See the file-level comment block
 *  above finalizeLetterAfterSigning for why the reference number can't be
 *  allocated yet at this point. */
async function enterPendingSignatureInTx(
  letter: Letter,
  user: CurrentUser,
  tx: SequelizeTransaction,
): Promise<{ requestId: string }> {
  // documentId is the real idempotency guard: a composed letter only gets one
  // once its signable draft is filed, so a non-null value means a ceremony
  // already exists (or the letter is fully finalized). The status check widened
  // from IN_REVIEW-only to also accept APPROVED, because signing is now
  // initiated AFTER approval completes rather than during the final decision.
  if (letter.documentId || !['IN_REVIEW', 'APPROVED'].includes(letter.status))
    throw new AppError(409, 'ERR-LETTER-ALREADY-FINALIZED', 'Letter has already been finalized');

  const unit = await OrgUnit.findByPk(letter.orgUnitId, { transaction: tx });
  if (!unit) throw new AppError(500, 'ERR-ORG-UNIT-MISSING', 'Letter org unit not found');
  const department = letter.departmentId
    ? await Department.findByPk(letter.departmentId, { transaction: tx })
    : null;
  if (!department)
    throw new AppError(422, 'ERR-DEPT-INVALID', 'Letter must belong to a department before approval');

  // Who signs this letter: an explicit choice captured at submit time
  // (letter.assignedSignatoryUserId/assignedSignatoryRole — the "who signs
  // this letter" picker in submitLetter's `signatory` field), or — the
  // unchanged default — the approver who just completed the final APPROVE
  // step. A role-based choice has no specific person yet: the recipient is
  // created unclaimed (esigning.service.ts's new assignedRole support) and
  // claimed by whichever department-scoped holder of that role signs first.
  let signatoryName: string;
  let signatoryTitle: string;
  let signatoryUserId: string | null;
  let recipientEmail: string;
  let recipientDmsUserId: string | undefined;
  let recipientAssignedRole: string | undefined;

  if (letter.assignedSignatoryUserId) {
    const assignedUser = await User.findByPk(letter.assignedSignatoryUserId, { transaction: tx });
    if (!assignedUser) throw new AppError(500, 'ERR-SIGNATORY-MISSING', 'Assigned signatory profile not found');
    const titleRows = await sequelize.query<{ name: string }>(
      `SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId LIMIT 1`,
      { replacements: { userId: assignedUser.id }, type: QueryTypes.SELECT, transaction: tx },
    );
    signatoryName = `${assignedUser.firstName} ${assignedUser.lastName}`.trim();
    signatoryTitle = humanizeSignatoryTitle(titleRows[0]?.name ?? '', department.name);
    signatoryUserId = assignedUser.id;
    recipientEmail = assignedUser.email;
    recipientDmsUserId = assignedUser.id;
    // The assigned signatory is a different person from the approver
    // (`user`) below, who isn't necessarily who this document was granted
    // to via grantDefaultDocumentAcl's department snapshot — without this
    // they'd hit AUTHZ_ACL_NO_ENTRY the moment they tried to open the
    // document directly (listMySignatureTasks itself doesn't need it, but
    // GET /documents/:id and GET /signing/:requestId do). Deferred until
    // after draftDocumentId exists below (bulkCreate call right after
    // Document.create).
  } else if (letter.assignedSignatoryRole) {
    signatoryName = `Role: ${letter.assignedSignatoryRole.replace(/_/g, ' ')} (unclaimed)`;
    signatoryTitle = humanizeSignatoryTitle(letter.assignedSignatoryRole, department.name);
    signatoryUserId = null;
    recipientEmail = `role-${letter.assignedSignatoryRole.toLowerCase()}@unassigned.internal`;
    recipientAssignedRole = letter.assignedSignatoryRole;
  } else {
    const signatoryUser = await User.findByPk(user.userId, { transaction: tx });
    if (!signatoryUser) throw new AppError(500, 'ERR-SIGNATORY-MISSING', 'Approving user profile not found');
    signatoryName = `${signatoryUser.firstName} ${signatoryUser.lastName}`.trim();
    signatoryTitle = humanizeSignatoryTitle(user.role, department.name);
    signatoryUserId = user.userId;
    recipientEmail = signatoryUser.email;
    recipientDmsUserId = user.userId;
  }

  const docType = await DocumentType.findOne({
    where: { tenantId: letter.tenantId, code: 'CORR' }, transaction: tx,
  });
  if (!docType)
    throw new AppError(500, 'ERR-DOCTYPE-CORR-MISSING', 'Correspondence document type is not seeded for this tenant');

  const { pdf: draftPdf, signatureField } = await generateLetterSignableDraft({
    subject: letter.subject,
    bodyHtml: letter.bodyHtml,
    unitName: unit.name,
    letterheadTitle: unit.letterheadTitle,
    departmentName: department.name,
    correspondent: letter.correspondent,
    correspondentOrganization: letter.correspondentOrganization,
    correspondentLocation: letter.correspondentLocation,
    resolveBodyImage: makeLetterBodyImageResolver(letter.tenantId, letter.createdBy),
  });

  const draftDocumentId = crypto.randomUUID();
  const draftVersionId = crypto.randomUUID();
  const draftStorageKey = `${department.code}/CORR/${draftDocumentId}/${draftVersionId}/signable-draft.pdf`;
  const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
    draftStorageKey, draftPdf, 'application/pdf', department.id, letter.tenantId,
  );

  await reserveStorageQuota(letter.tenantId, draftPdf.length, tx);
  await Document.create(
    {
      id: draftDocumentId,
      tenantId: letter.tenantId,
      // documents.document_name is UNIQUE per (tenant_id, document_name) —
      // the letter's subject text is NOT guaranteed unique (two different
      // letters can share a subject), so this embeds the letter's own id
      // instead, same way the final numbered document embeds the
      // (guaranteed-unique) reference number.
      documentName: `Letter draft — ${letter.id}`,
      title: letter.subject.slice(0, 255),
      departmentId: department.id,
      documentTypeId: docType.id,
      folderId: null,
      ownerId: letter.createdBy,
      organisationUnit: unit.code,
      // ACTIVE, not ARCHIVED — createSignatureRequest only accepts a target
      // document in APPROVED/ACTIVE/SIGNING_DECLINED/PENDING_SIGNATURE. This
      // is a working artifact until the ceremony completes, not yet a
      // finalized record (that's the separate, later numbered PDF).
      status: 'ACTIVE',
      securityClassification: letter.confidentiality,
      retentionClass: 'RET-CORR-5Y',
      documentDate: new Date(),
      retentionTriggerDate: null,
      disposalEligibleDate: null,
      latestVersionId: null,
      source: 'CREATED_IN_SYSTEM',
      archivedAt: null,
      ocrStatus: null,
      ocrConfidenceScore: null,
      aiSummary: null,
      aiSuggestedMetadata: null,
      deletedAt: null,
    },
    { transaction: tx },
  );
  const draftVersion = await DocumentVersion.create(
    {
      id: draftVersionId,
      documentId: draftDocumentId,
      versionNumber: '1.0',
      isMajorVersion: true,
      storageKey: draftStorageKey,
      storageBucket: config.MINIO_BUCKET_DOCUMENTS,
      fileSize: BigInt(draftPdf.length),
      mimeType: 'application/pdf',
      originalFilename: `letter-draft-${draftDocumentId}.pdf`,
      sha256Hash: encHash,
      plaintextSha256: crypto.createHash('sha256').update(draftPdf).digest('hex'),
      extractedText: extractPlainText(parseLetterBody(letter.bodyHtml)).slice(0, 100_000),
      authorId: user.userId,
      changeSummary: 'CAMS: signable draft awaiting e-signature',
    },
    { transaction: tx },
  );
  await Document.update({ latestVersionId: draftVersion.id }, { where: { id: draftDocumentId }, transaction: tx });
  await DocumentDek.create(
    { documentId: draftDocumentId, versionId: draftVersionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
    { transaction: tx },
  );
  // Letters' own routes never gate on generic document ACL (they check
  // letter:read + department scope instead — see letters.routes.ts and
  // decideStep's dept-scope check above), so this gap was invisible until
  // now: the e-signing subsystem DOES enforce it (loadRequest's
  // assertACLAllow, used by every /signing/:requestId route including the
  // one the afterCommit hook below calls). Without ANY grant, the signer
  // hits AUTHZ_ACL_NO_ENTRY the moment sendSignatureRequest tries to load
  // the request — silently, since that call is fire-and-forget below — and
  // the request is stuck in 'draft' forever, invisible on every signing
  // queue.
  //
  // documents.service.ts's grantDefaultDocumentAcl now grants department-
  // scoped read (a snapshot of the department's current members) rather
  // than the tenant-wide role grant it used to — that bug (any DEPT_MANAGER/
  // RECORDS_OFFICER/etc. anywhere in the tenant could open ANY document
  // regardless of department, caught live via this exact draft: a Finance
  // manager could open a Procurement letter's signable draft) has been
  // fixed at the shared helper, not worked around here, since every other
  // document-creation path in the platform has the identical exposure.
  // Retention engine (gap register #1 / D11) — see the parallel comment in
  // createScannedOutgoingLetter above.
  await applyRetention(draftDocumentId, tx);
  // Explicit extra grant for the signer (user.userId) below because they
  // won't necessarily be a member of the letter's OWN department (e.g. an
  // executive signing off on another department's letter) and so might not
  // be covered by the department-member snapshot — they're the one person
  // this entire ceremony is guaranteed to be for.
  await grantLetterDocumentAcl(
    {
      documentId: draftDocumentId, ownerId: letter.createdBy, tenantId: letter.tenantId, departmentId: letter.departmentId!,
      confidentiality: letter.confidentiality,
      participantIds: isParticipantsOnly(letter.confidentiality) ? await collectLetterParticipantIds(letter, tx) : [],
    },
    tx,
  );
  await AclEntry.bulkCreate(
    [{
      tenantId: letter.tenantId, resourceType: 'document' as const, resourceId: draftDocumentId,
      principalType: 'user' as const, principalId: user.userId,
      effect: 'ALLOW' as const, permission: 'document:read', grantedById: user.userId,
    }],
    { transaction: tx, ignoreDuplicates: true },
  );
  // If an explicit signatory was chosen (different from the approver above),
  // grant them read access too — same reasoning as the approver's own grant
  // just above, they're not guaranteed to be covered by the department
  // snapshot either. A role-based choice has no specific person yet, so the
  // role itself is granted instead (resolveACL.ts matches an ACL role
  // principal against the acting user's role NAMES, not a Role table id) —
  // actually signing still requires department-scoped role membership,
  // enforced separately by signDocument's claim check.
  if (recipientDmsUserId && recipientDmsUserId !== user.userId) {
    await AclEntry.bulkCreate(
      [{
        tenantId: letter.tenantId, resourceType: 'document' as const, resourceId: draftDocumentId,
        principalType: 'user' as const, principalId: recipientDmsUserId,
        effect: 'ALLOW' as const, permission: 'document:read', grantedById: user.userId,
      }],
      { transaction: tx, ignoreDuplicates: true },
    );
  } else if (recipientAssignedRole) {
    await AclEntry.bulkCreate(
      [{
        tenantId: letter.tenantId, resourceType: 'document' as const, resourceId: draftDocumentId,
        principalType: 'role' as const, principalId: recipientAssignedRole,
        effect: 'ALLOW' as const, permission: 'document:read', grantedById: user.userId,
      }],
      { transaction: tx, ignoreDuplicates: true },
    );
  }
  await OutboxEvent.bulkCreate(
    [{ documentId: draftDocumentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId: draftDocumentId, tenantId: letter.tenantId }) }],
    { transaction: tx },
  );

  await letter.update(
    {
      status: 'PENDING_SIGNATURE',
      documentId: draftDocumentId,
      signatoryUserId,
      signatoryName,
      signatoryTitle,
    },
    { transaction: tx },
  );

  const authenticatedUser = toAuthenticatedUser(user);
  const request = await createSignatureRequest(
    draftDocumentId,
    {
      recipients: [
        recipientAssignedRole
          ? { name: signatoryName, email: recipientEmail, assignedRole: recipientAssignedRole }
          : { name: signatoryName, email: recipientEmail, dmsUserId: recipientDmsUserId },
      ],
      fields: [{ recipientIndex: 0, fieldType: 'signature', ...signatureField }],
    },
    authenticatedUser,
  );

  // sendSignatureRequest fires notifications/websocket events synchronously,
  // outside its own transaction — it must not run until THIS transaction
  // (which just wrote PENDING_SIGNATURE) has actually committed, and the
  // setImmediate escapes the CLS async context so its own internal
  // runInTransaction() opens a fresh transaction instead of trying to reuse
  // this one (which is dead by the time afterCommit fires). Mirrors the
  // identical filePadesSignedCopy pattern in esigning.service.ts's
  // signDocument(). A request that never gets sent this way is recoverable
  // via the PENDING_SIGNATURE → CANCELLED path, same as any other stuck step.
  tx.afterCommit(() => {
    setImmediate(() => {
      // FIX 2026-09-15: setImmediate escapes the request's AsyncLocalStorage
      // frame, so sendSignatureRequest's own internal queries (loadRequest,
      // runInTransaction) used to run with NO `app.current_tenant` GUC set —
      // silently returning/affecting nothing under mirror's RLS-enforcing DB
      // role (invisible on dev, which connects as the postgres superuser and
      // bypasses RLS entirely). Exact same bug class as esigning.service.ts's
      // filePadesSignedCopy dispatch, fixed there the same way: re-establish
      // the tenant GUC explicitly via withWorkerTenantContext before the
      // deferred call runs.
      void withWorkerTenantContext(letter.tenantId, () => sendSignatureRequest(request.id, authenticatedUser)).catch((err) =>
        logger.error(
          { err, requestId: request.id, letterId: letter.id },
          '[letters] failed to send signature request after entering PENDING_SIGNATURE',
        ),
      );
    });
  });

  return { requestId: request.id };
}

/** Runs INSIDE the caller's transaction (which holds the letter row lock).
 *  For a non-signing letter (incoming, or outgoing-scanned) this runs right
 *  after the step decision, same as before. For an outgoing composed letter
 *  this instead runs from esigning.service.ts's signDocument() once the
 *  ceremony enterPendingSignatureInTx kicked off actually completes — the
 *  reference number is allocated here, not before, because it (and its QR)
 *  get baked into the page content, and a real signature can't have content
 *  added to its pages after the fact without invalidating it. */
/**
 * The signature actually captured when this letter was signed.
 *
 * WHY THIS EXISTS
 *
 * The final numbered letter used to take its signature from
 * `User.signatureImage` — the signatory's stored PROFILE signature. Nobody had
 * one (0 of 24 users on the dev database), so the letter of record was always
 * unsigned. Worse, it would still have been unsigned if they had: the mark a
 * signatory draws during the e-signing ceremony is written to the ceremony's
 * signature FIELD, and never went anywhere near the profile.
 *
 * The ceremony stamps that mark into the unnumbered signable draft, and
 * finalizeLetterAfterSigning then renders the numbered letter of record from
 * scratch afterwards — so without this, the signature stays behind on the draft
 * and the document that actually gets dispatched shows none.
 *
 * Falls back to the profile signature, which keeps the original intent working
 * for anyone who has set one.
 *
 * Returns null freely. A letter finalized without a ceremony has no captured
 * signature and correctly renders no signature block at all.
 */
async function resolveCapturedSignature(
  signedDraftDocumentId: string | null,
  signatoryUser: User,
  tx: SequelizeTransaction,
): Promise<string | null> {
  if (signedDraftDocumentId) {
    const field = await SignatureField.findOne({
      where: { fieldType: 'signature', value: { [Op.like]: 'data:image/%' } },
      include: [
        {
          model: SignatureRequest,
          as: 'request',
          required: true,
          attributes: [],
          where: { documentId: signedDraftDocumentId },
        },
      ],
      // Newest signature wins: a ceremony can be voided and restarted on the
      // same document, and the letter of record must carry the mark from the
      // ceremony that actually completed it.
      order: [['signedAt', 'DESC']],
      transaction: tx,
    });
    if (field?.value) return field.value;
  }
  return signatoryUser.signatureImage ?? null;
}

export async function finalizeLetterAfterSigning(
  letter: Letter,
  user: CurrentUser,
  tx: SequelizeTransaction,
) {
  // Take (or re-take, inside the same transaction — a no-op for decideStep, which
  // already holds it) the row lock and refresh the instance BEFORE judging its state.
  // The e-signing caller (esigning.service.ts signDocument) loads the letter with a
  // plain findOne, so without this a cancelLetter that committed in between would be
  // overwritten: the reference number allocated and status forced back to APPROVED.
  await letter.reload({ transaction: tx, lock: tx.LOCK.UPDATE });
  // Idempotency: the row lock serializes finalizes; a second entrant must
  // bail. IN_REVIEW covers the non-signing path; PENDING_SIGNATURE covers
  // the post-ceremony path.
  if (letter.referenceNumber || !['IN_REVIEW', 'PENDING_SIGNATURE'].includes(letter.status))
    throw new AppError(409, 'ERR-LETTER-ALREADY-FINALIZED', 'Letter has already been finalized');
  // The signable draft's document id (if this letter went through a signing
  // ceremony) is about to be overwritten below with the final numbered
  // document — capture it first so the signed proof stays linked.
  const signedDraftDocumentId = letter.status === 'PENDING_SIGNATURE' ? letter.documentId : null;

  const unit = await OrgUnit.findByPk(letter.orgUnitId, { transaction: tx });
  if (!unit) throw new AppError(500, 'ERR-ORG-UNIT-MISSING', 'Letter org unit not found');
  const department = letter.departmentId
    ? await Department.findByPk(letter.departmentId, { transaction: tx })
    : null;
  if (!department)
    throw new AppError(422, 'ERR-DEPT-INVALID', 'Letter must belong to a department before approval');

  const signatoryUser = await User.findByPk(user.userId, { transaction: tx });
  if (!signatoryUser) throw new AppError(500, 'ERR-SIGNATORY-MISSING', 'Approving user profile not found');
  const signatoryName = `${signatoryUser.firstName} ${signatoryUser.lastName}`.trim();
  const signatoryTitle = humanizeSignatoryTitle(user.role, department.name);
  const capturedSignature = await resolveCapturedSignature(signedDraftDocumentId, signatoryUser, tx);

  const docType = await DocumentType.findOne({
    where: { tenantId: letter.tenantId, code: 'CORR' }, transaction: tx,
  });
  if (!docType)
    throw new AppError(500, 'ERR-DOCTYPE-CORR-MISSING', 'Correspondence document type is not seeded for this tenant');

  {
    // Gap-free counter: lock (or create) the sequence row for unit+type+year.
    const approvedAt = new Date(); // server time, never client time (6.1.4)
    const year = approvedAt.getFullYear();
    await sequelize.query(
      `INSERT INTO letter_sequences (tenant_id, org_unit_id, letter_type, year, last_value)
       VALUES (:tenantId, :orgUnitId, :letterType, :year, 0)
       ON CONFLICT (tenant_id, org_unit_id, letter_type, year) DO NOTHING`,
      { replacements: { tenantId: letter.tenantId, orgUnitId: letter.orgUnitId, letterType: letter.letterType, year }, transaction: tx },
    );
    const seqRow = await LetterSequence.findOne({
      where: { tenantId: letter.tenantId, orgUnitId: letter.orgUnitId, letterType: letter.letterType, year },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!seqRow) throw new AppError(500, 'ERR-SEQUENCE-MISSING', 'Reference sequence row missing');
    const nextValue = seqRow.lastValue + 1;
    await seqRow.update({ lastValue: nextValue }, { transaction: tx });

    const referenceNumber = `${config.REFERENCE_NUMBER_PREFIX}/${unit.code}/${department.code}/${letter.letterType}/${year}/${String(nextValue).padStart(5, '0')}`;

    // QR encodes the verification URL + a content hash (never the letter body).
    // documentHash (sha256 of the final artifact) is stored server-side for
    // the integrity check on the verification page.
    const bodyText = extractPlainText(parseLetterBody(letter.bodyHtml));
    const contentHash = crypto
      .createHash('sha256')
      .update(`${referenceNumber}|${letter.subject}|${bodyText}|${signatoryName}|${approvedAt.toISOString()}`)
      .digest('hex');
    const qrUrl = `${config.CAMS_VERIFY_BASE_URL}?ref=${encodeURIComponent(referenceNumber)}&hash=${contentHash}`;

    let documentId: string;
    let documentHash: string;
    let coverSheetDocumentId: string | null = null;

    if (letter.originType === 'SCANNED') {
      // Content already staged at creation (attachmentDocumentId) — nothing
      // to render. Promote it to documentId (finalized, matches COMPOSED's
      // invariant) and file a QR cover sheet alongside it as a separate doc.
      if (!letter.attachmentDocumentId)
        throw new AppError(500, 'ERR-LETTER-NO-ATTACHMENT', 'Scanned letter has no staged attachment to finalize');
      const attachmentVersion = await DocumentVersion.findOne({
        where: { documentId: letter.attachmentDocumentId }, order: [['createdAt', 'DESC']], transaction: tx,
      });
      if (!attachmentVersion) throw new AppError(500, 'ERR-VERSION-MISSING', 'Staged attachment version not found');
      documentId = letter.attachmentDocumentId;
      documentHash = attachmentVersion.plaintextSha256 ?? '';

      // Promotion never actually changed this document's status — it was
      // staged ACTIVE at creation (createScannedOutgoingLetter above) and
      // nothing here updated it afterward. An approved letter is a finalized
      // record, not a working document, so file it straight to ARCHIVED
      // rather than leaving it ACTIVE forever post-approval.
      await Document.update(
        { status: 'ARCHIVED', archivedAt: approvedAt },
        { where: { id: documentId }, transaction: tx },
      );
      await ArchiveRecord.findOrCreate({
        where: { documentId },
        defaults: { documentId, status: 'ARCHIVED', archiveStorageTier: 'WARM', archivedById: user.userId, archivedAt: approvedAt },
        transaction: tx,
      });

      const coverSheet = await generateLetterCoverSheet({
        referenceNumber,
        direction: 'OUTGOING',
        subject: letter.subject,
        unitName: unit.name,
        letterheadTitle: unit.letterheadTitle,
        departmentName: department.name,
        correspondent: letter.correspondent,
        correspondentOrganization: letter.correspondentOrganization,
        correspondentLocation: letter.correspondentLocation,
        attachmentFilename: attachmentVersion.originalFilename,
        confidentiality: letter.confidentiality,
        stampedAt: approvedAt,
        qrUrl,
      });
      coverSheetDocumentId = crypto.randomUUID();
      const coverVersionId = crypto.randomUUID();
      const coverStorageKey = `${department.code}/CORR/${coverSheetDocumentId}/${coverVersionId}/cover-sheet.pdf`;
      const coverEnc = await encryptAndStore(
        coverStorageKey, coverSheet, 'application/pdf', department.id, letter.tenantId,
      );
      await reserveStorageQuota(letter.tenantId, coverSheet.length, tx);
      await Document.create(
        {
          id: coverSheetDocumentId,
          tenantId: letter.tenantId,
          documentName: `${referenceNumber} — Cover Sheet`,
          title: `Cover sheet: ${letter.subject}`.slice(0, 255),
          departmentId: department.id,
          documentTypeId: docType.id,
          folderId: null,
          ownerId: letter.createdBy,
          organisationUnit: unit.code,
          // Filed straight to ARCHIVED, same as the promoted attachment above
          // — a cover sheet for an already-approved letter has no "active"
          // working phase of its own.
          status: 'ARCHIVED',
          securityClassification: letter.confidentiality,
          retentionClass: 'RET-CORR-5Y',
          documentDate: approvedAt,
          retentionTriggerDate: approvedAt,
          disposalEligibleDate: null,
          latestVersionId: null,
          source: 'CREATED_IN_SYSTEM',
          archivedAt: approvedAt,
          ocrStatus: null,
          ocrConfidenceScore: null,
          aiSummary: null,
          aiSuggestedMetadata: null,
          deletedAt: null,
        },
        { transaction: tx },
      );
      await ArchiveRecord.findOrCreate({
        where: { documentId: coverSheetDocumentId },
        defaults: { documentId: coverSheetDocumentId, status: 'ARCHIVED', archiveStorageTier: 'WARM', archivedById: user.userId, archivedAt: approvedAt },
        transaction: tx,
      });
      // Retention engine (gap register #1 / D11) — see the parallel comment in
      // createScannedOutgoingLetter above.
      await applyRetention(coverSheetDocumentId, tx);
      // A freshly Document.create'd row has zero ACL entries until something
      // grants them -- without this, "Could not load document / No access
      // control entry" for everyone, including the letter's own department.
      // (The promoted attachmentDocumentId above has the same gap at its own
      // creation site, createScannedOutgoingLetter -- fixed separately there.)
      await grantLetterDocumentAcl(
        {
          documentId: coverSheetDocumentId, ownerId: letter.createdBy, tenantId: letter.tenantId, departmentId: department.id,
          confidentiality: letter.confidentiality,
          participantIds: isParticipantsOnly(letter.confidentiality) ? [...(await collectLetterParticipantIds(letter, tx)), user.userId] : [],
        },
        tx,
      );
      const coverVersion = await DocumentVersion.create(
        {
          id: coverVersionId,
          documentId: coverSheetDocumentId,
          versionNumber: '1.0',
          isMajorVersion: true,
          storageKey: coverStorageKey,
          storageBucket: config.MINIO_BUCKET_DOCUMENTS,
          fileSize: BigInt(coverSheet.length),
          mimeType: 'application/pdf',
          originalFilename: `${referenceNumber.replace(/\//g, '-')}-cover-sheet.pdf`,
          sha256Hash: coverEnc.sha256Hash,
          plaintextSha256: crypto.createHash('sha256').update(coverSheet).digest('hex'),
          extractedText: `${referenceNumber} ${letter.subject}`.slice(0, 100_000),
          authorId: user.userId,
          changeSummary: 'CAMS: verification cover sheet for approved scanned letter',
        },
        { transaction: tx },
      );
      await Document.update({ latestVersionId: coverVersion.id }, { where: { id: coverSheetDocumentId }, transaction: tx });
      await DocumentDek.create(
        { documentId: coverSheetDocumentId, versionId: coverVersionId, encryptedDek: coverEnc.encryptedKey, kekId: coverEnc.kekId, algorithm: 'AES-256-GCM' },
        { transaction: tx },
      );
      await OutboxEvent.bulkCreate(
        [
          { documentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId, tenantId: letter.tenantId }) },
          { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: letter.tenantId }) },
        ],
        { transaction: tx },
      );
    } else {
      const pdf = await generateLetterPdf({
        referenceNumber,
        subject: letter.subject,
        bodyHtml: letter.bodyHtml,
        unitName: unit.name,
        letterheadTitle: unit.letterheadTitle,
        departmentName: department.name,
        correspondent: letter.correspondent,
        correspondentOrganization: letter.correspondentOrganization,
        correspondentLocation: letter.correspondentLocation,
        signatoryName,
        signatoryTitle,
        // The mark captured by the signing ceremony, not the (almost always
        // empty) profile signature — see resolveCapturedSignature.
        signatureImageDataUrl: capturedSignature,
        approvedAt,
        confidentiality: letter.confidentiality,
        qrUrl,
        resolveBodyImage: makeLetterBodyImageResolver(letter.tenantId, letter.createdBy),
      });
      documentHash = crypto.createHash('sha256').update(pdf).digest('hex');

      // File the final PDF as a real document (encryption, versioning, audit
      // and retention all ride the existing document pipeline).
      documentId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
      const storageKey = `${letter.tenantId}/${department.code}/CORR/${documentId}/${versionId}/letter.pdf`;
      const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
        storageKey, pdf, 'application/pdf', department.id, letter.tenantId,
      );

      await reserveStorageQuota(letter.tenantId, pdf.length, tx);
      await Document.create(
        {
          id: documentId,
          tenantId: letter.tenantId,
          documentName: referenceNumber,
          title: letter.subject.slice(0, 255),
          departmentId: department.id,
          documentTypeId: docType.id,
          folderId: null,
          ownerId: letter.createdBy,
          organisationUnit: unit.code,
          // Filed straight to ARCHIVED — an approved, signed, reference-
          // numbered letter is a finalized record from the moment it's
          // filed, not something that sits ACTIVE first and gets archived
          // later by a separate action.
          status: 'ARCHIVED',
          securityClassification: letter.confidentiality,
          retentionClass: 'RET-CORR-5Y',
          documentDate: approvedAt,
          retentionTriggerDate: approvedAt,
          disposalEligibleDate: null,
          latestVersionId: null,
          source: 'CREATED_IN_SYSTEM',
          archivedAt: approvedAt,
          ocrStatus: null,
          ocrConfidenceScore: null,
          aiSummary: null,
          aiSuggestedMetadata: null,
          deletedAt: null,
        },
        { transaction: tx },
      );
      await ArchiveRecord.findOrCreate({
        where: { documentId },
        defaults: { documentId, status: 'ARCHIVED', archiveStorageTier: 'WARM', archivedById: user.userId, archivedAt: approvedAt },
        transaction: tx,
      });
      // Retention engine (gap register #1 / D11) — see the parallel comment in
      // createScannedOutgoingLetter above. This is the letter of record
      // itself, so this is the single most important call site of the seven.
      await applyRetention(documentId, tx);
      // The letter of record itself -- without this, a freshly Document.create'd
      // row has zero ACL entries and resolveACL denies everyone by default,
      // including the letter's own department (confirmed live: "Could not load
      // document / No access control entry for this resource" for the FIN
      // manager on their own department's finalized letter).
      await grantLetterDocumentAcl(
        {
          documentId, ownerId: letter.createdBy, tenantId: letter.tenantId, departmentId: department.id,
          confidentiality: letter.confidentiality,
          participantIds: isParticipantsOnly(letter.confidentiality) ? [...(await collectLetterParticipantIds(letter, tx)), user.userId] : [],
        },
        tx,
      );
      const version = await DocumentVersion.create(
        {
          id: versionId,
          documentId,
          versionNumber: '1.0',
          isMajorVersion: true,
          storageKey,
          storageBucket: config.MINIO_BUCKET_DOCUMENTS,
          fileSize: BigInt(pdf.length),
          mimeType: 'application/pdf',
          originalFilename: `${referenceNumber.replace(/\//g, '-')}.pdf`,
          sha256Hash: encHash,
          plaintextSha256: documentHash,
          extractedText: bodyText.slice(0, 100_000),
          authorId: user.userId,
          changeSummary: 'CAMS: final approved letter',
        },
        { transaction: tx },
      );
      await Document.update({ latestVersionId: version.id }, { where: { id: documentId }, transaction: tx });
      await DocumentDek.create(
        { documentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
        { transaction: tx },
      );

      // Approved letters must be findable via /search (incoming already does this).
      await OutboxEvent.bulkCreate(
        [
          { documentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId, tenantId: letter.tenantId }) },
          { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: letter.tenantId }) },
        ],
        { transaction: tx },
      );
    }

    // The signable draft (if this letter went through a signing ceremony)
    // stays permanently visible in every generic document list (Dashboard
    // recent documents, Browse, search) — it's a real, separately-filed
    // Document row, not a hidden implementation detail — but it was filed
    // under `Letter draft — ${letter.id}` (letters.service.ts's
    // enterPendingSignatureInTx), a name chosen only for guaranteed DB
    // uniqueness before a reference number existed yet. Left as-is forever,
    // it reads as an orphaned/broken record once the real reference number
    // is allocated here. Rename it to carry that reference number too, so
    // it's identifiable as "the signed proof behind REF/…/00006" instead of a
    // bare UUID. Suffixed (not set to the bare reference number) because the
    // final document below is ABOUT to claim that exact name, and
    // documents.document_name is unique per tenant.
    if (signedDraftDocumentId) {
      await Document.update(
        { documentName: `${referenceNumber} — Signed Draft` },
        { where: { id: signedDraftDocumentId }, transaction: tx },
      );
    }

    await letter.update(
      {
        status: 'APPROVED',
        referenceNumber,
        year,
        signatoryUserId: user.userId,
        signatoryName,
        signatoryTitle,
        approvedAt,
        documentId,
        coverSheetDocumentId,
        signedDraftDocumentId: signedDraftDocumentId ?? letter.signedDraftDocumentId,
        documentHash,
        qrPayload: qrUrl,
      },
      { transaction: tx },
    );
  }
}

/** Downloads the letter's primary content: the system-rendered PDF for a
 *  COMPOSED letter, or the uploaded scan/Word/image for a SCANNED one. The
 *  mimetype is whatever was actually filed, not assumed to be PDF.
 *
 * FIX 2026-09-15: `documentId` is only null->non-null at two points for a
 * SCANNED letter — the ORIGINAL upload is staged into `attachmentDocumentId`
 * immediately (createScannedOutgoingLetter), and `documentId` itself stays
 * null until final approval promotes it (finalizeLetterAfterSigning). This
 * function used to require `documentId`, so a reviewer/approver deciding a
 * SCANNED letter in DRAFT/IN_REVIEW — precisely when they need to see it —
 * got ERR-LETTER-NO-PDF with nothing to look at, even though the staged file
 * is already ACL-readable (grantDefaultDocumentAcl is called on it at
 * creation for exactly this reason; see that call site's own comment). Now
 * falls back to attachmentDocumentId so "what am I approving" always has an
 * answer for a SCANNED letter at every stage, not just after it's finalized. */
export async function downloadLetterPdf(id: string, user: CurrentUser) {
  const letter = await getLetter(id, user);
  const targetDocumentId = letter.documentId ?? letter.attachmentDocumentId;
  if (!targetDocumentId)
    throw new AppError(409, 'ERR-LETTER-NO-PDF', 'Letter has no content to preview yet');
  const version = await DocumentVersion.findOne({
    where: { documentId: targetDocumentId }, order: [['createdAt', 'DESC']],
  });
  if (!version) throw new AppError(500, 'ERR-VERSION-MISSING', 'Filed document version not found');
  const buffer = await fetchAndDecrypt(version.storageKey, version.id);

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_VIEWED,
    userId: user.userId, userRole: user.role, documentId: targetDocumentId,
    actionDetails: { letterId: id, referenceNumber: letter.referenceNumber, action: 'download' },
  });
  return { buffer, filename: version.originalFilename, mimeType: version.mimeType };
}

/** Downloads the generated QR verification cover sheet filed alongside a
 *  SCANNED-origin letter's original attachment (see letters.md's origin_type
 *  doc comment) — COMPOSED letters have no separate cover sheet, the QR is
 *  already baked into their rendered PDF. */
export async function downloadLetterCoverSheet(id: string, user: CurrentUser) {
  const letter = await getLetter(id, user);
  if (!letter.coverSheetDocumentId)
    throw new AppError(409, 'ERR-LETTER-NO-COVER-SHEET', 'Letter has no cover sheet');
  const version = await DocumentVersion.findOne({
    where: { documentId: letter.coverSheetDocumentId }, order: [['createdAt', 'DESC']],
  });
  if (!version) throw new AppError(500, 'ERR-VERSION-MISSING', 'Filed document version not found');
  const buffer = await fetchAndDecrypt(version.storageKey, version.id);

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_VIEWED,
    userId: user.userId, userRole: user.role, documentId: letter.coverSheetDocumentId,
    actionDetails: { letterId: id, referenceNumber: letter.referenceNumber, action: 'download-cover-sheet' },
  });
  return { buffer, filename: version.originalFilename, mimeType: version.mimeType };
}

/** A letter is a letter of record only once finalize has allocated its reference number
 *  (outgoing: at the end of approval/signing; incoming: at registration). */
function assertLetterFinalized(letter: Letter): void {
  if (!letter.referenceNumber)
    throw new AppError(
      409,
      'ERR-LETTER-NOT-FINALIZED',
      'This letter has no reference number yet — it is approved but still awaiting signing',
    );
}

export async function recordDispatch(letterId: string, input: unknown, user: CurrentUser) {
  const data = dispatchSchema.parse(input);
  // Platform audit finding (2026-08-14, HIGH): this only checked tenantId, not
  // scopeWhere() — a department/confidentiality bypass letting anyone holding
  // the tenant-wide LETTER_DISPATCH permission dispatch (and, worse, have
  // acknowledgeDispatch/assignLetter/archiveLetter/resolveIncomingLetter
  // below return the full letter body of) a letter their own department/
  // confidentiality scope would hide from getLetter(). Same fix applied to
  // every mutation in this file that only had a tenantId check.
  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.direction !== 'OUTGOING')
    throw new AppError(409, 'ERR-LETTER-DIRECTION', 'Only outgoing letters can be dispatched');
  // FIX (Finding 13): was a hand-rolled `!['APPROVED','DISPATCHED'].includes(...)`
  // check — a second, independently-maintained copy of the same rule
  // assertTransition already centralizes elsewhere in this file (e.g. below,
  // and at CANCELLED/ARCHIVED transitions). assertTransition treats
  // from === to as always legal, so re-recording dispatch while already
  // DISPATCHED still works exactly as before.
  assertTransition(letter.status, 'DISPATCHED');
  // An approved COMPOSED letter sits in APPROVED with no reference number, no
  // document and no signature until initiateLetterSigning + the ceremony finalize
  // it (decideStep → 'awaitingSigning'). Dispatching it would mark an unnumbered,
  // unsigned letter as sent AND strand it: initiateLetterSigning only accepts APPROVED.
  assertLetterFinalized(letter);

  const dispatch =await runInTransaction(async (tx) => {
    const created = await LetterDispatch.create(
      {
        letterId,
        channel: data.channel,
        recipientName: data.recipientName ?? letter.correspondent,
        recipientAddress: data.recipientAddress ?? null,
        trackingReference: data.trackingReference ?? null,
        notes: data.notes ?? null,
        dispatchedBy: user.userId,
        acknowledgedAt: null,
        acknowledgmentNote: null,
      },
      { transaction: tx },
    );
    if (letter.status === 'APPROVED') await letter.update({ status: 'DISPATCHED' }, { transaction: tx });
    return created;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_DISPATCHED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId, referenceNumber: letter.referenceNumber, channel: data.channel },
  });

  // Digital delivery: if this dispatch is over EMAIL and a send-to address is
  // available (explicit recipientAddress on this dispatch, else the letter's
  // own correspondentEmail), actually email the recipient the letter (+ QR
  // cover sheet, for a SCANNED letter) via the BullMQ EMAILS queue — retried
  // per createQueue()'s defaultJobOptions, independent of the outbox's own
  // backoff. No email address (unset, or the recipient doesn't accept
  // digital correspondence) simply means this dispatch stays a paper-trail
  // record — the physical/print path (see downloadLetterPdf /
  // downloadLetterCoverSheet, used by the frontend's print buttons) covers
  // that case instead.
  const sendTo = data.recipientAddress ?? letter.correspondentEmail;
  if (data.channel === 'EMAIL' && sendTo) {
    try {
      const queue = createQueue('EMAILS');
      if (!queue) {
        logger.warn({ letterId }, 'EMAILS queue unavailable (Redis not configured) — dispatch email not sent');
      } else {
        const attachDocumentIds = [letter.documentId, letter.coverSheetDocumentId].filter((id): id is string => Boolean(id));
        await queue.add(
          'LETTER.DISPATCH_EMAIL',
          {
            to: sendTo,
            type: 'LETTER.DISPATCH_EMAIL',
            tenantId: letter.tenantId,
            payload: {
              referenceNumber: letter.referenceNumber,
              subject: letter.subject,
              dateStr: new Date().toISOString().slice(0, 10),
              verifyUrl: letter.qrPayload,
              hasCoverSheet: Boolean(letter.coverSheetDocumentId),
            },
            attachDocumentIds,
          },
          { jobId: `letter-dispatch-${dispatch.id}` }, // BullMQ job ids reject ':'
        );
        await queue.close();
      }
    } catch (err) {
      // Best-effort: a failed enqueue must not fail the dispatch record itself.
      logger.warn({ err, letterId, dispatchId: dispatch.id }, 'Failed to queue dispatch email');
    }
  }

  return dispatch;
}

export async function acknowledgeDispatch(letterId: string, dispatchId: string, note: string | undefined, user: CurrentUser) {
  // Tenant + department/confidentiality scope (platform audit finding
  // 2026-08-14, HIGH — see recordDispatch's comment above).
  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  const dispatch = await LetterDispatch.findOne({ where: { id: dispatchId, letterId } });
  if (!dispatch) throw new AppError(404, 'ERR-DISPATCH-NOT-FOUND', 'Dispatch record not found');
  await dispatch.update({ acknowledgedAt: new Date(), acknowledgmentNote: note ?? null });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_DISPATCH_ACKNOWLEDGED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId, dispatchId },
  });
  return dispatch;
}

/**
 * FIX: a letter stuck IN_REVIEW (deactivated assignee, unstaffed role, and no
 * reassignment path) previously had NO way to be cancelled — cancelLetter only
 * accepted DRAFT/RETURNED. IN_REVIEW → CANCELLED is now a legal transition
 * (LetterStateMachine.ts), but only as an admin override: elevated permission
 * (department:manage or the admin bypass) plus a mandatory reason, the same
 * shape lockService.forceUnlock uses for its "admin override with mandatory
 * reason" flow. The normal drafter-owns-it DRAFT/RETURNED path is unchanged.
 */
export async function cancelLetter(id: string, input: unknown, user: CurrentUser) {
  const { reason } = cancelLetterSchema.parse(input ?? {});
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  assertTransition(letter.status, 'CANCELLED');

  // Both IN_REVIEW (a review step deadlocked) and PENDING_SIGNATURE (a
  // signature ceremony deadlocked — signer deactivated, request expired)
  // need the same admin+reason recovery gate: cancelling either one tears
  // down in-flight approval/signing state an ordinary drafter has no
  // business destroying.
  const previousStatus = letter.status;
  // L17: an approved composed letter that nobody ever signed has no exit but this. A NUMBERED letter
  // (signed, a letter of record, possibly already verified from its QR) is never cancelled here.
  if (previousStatus === 'APPROVED' && letter.referenceNumber)
    throw new AppError(409, 'ERR-LETTER-NOT-CANCELLABLE', 'A numbered letter of record cannot be cancelled');
  const awaitingSigning = previousStatus === 'APPROVED';
  const wasInFlight = previousStatus === 'IN_REVIEW' || previousStatus === 'PENDING_SIGNATURE';
  if (awaitingSigning) {
    // The drafter may withdraw their own approved-but-unsigned letter; otherwise the same department
    // head / admin gate as an in-flight cancel. Either way it discards a completed approval, so the
    // reason is mandatory.
    if (letter.createdBy !== user.userId) {
      const isAdmin = hasPermission(user, PERMISSIONS.DEPT_MANAGE) || hasPermission(user, PERMISSIONS.ACL_BYPASS_ADMIN);
      if (!isAdmin)
        throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter, or a department head, can cancel an approved letter that has not been signed');
      await assertCanManageDepartment(user, letter.departmentId ?? '');
    }
    if (!reason || reason.trim().length < 10)
      throw new AppError(422, 'ERR-REASON-REQUIRED', 'Cancelling an approved letter requires a reason of at least 10 characters');
  }
  if (wasInFlight) {
    const isAdmin = hasPermission(user, PERMISSIONS.DEPT_MANAGE) || hasPermission(user, PERMISSIONS.ACL_BYPASS_ADMIN);
    if (!isAdmin)
      throw new AppError(403, 'ERR-PERMISSION-DENIED', 'Cancelling an in-flight letter requires department:manage or admin bypass');
    if (!reason || reason.trim().length < 10)
      throw new AppError(422, 'ERR-REASON-REQUIRED', 'Cancelling an in-flight letter requires a reason of at least 10 characters');
    // department:manage says the caller may administer departments at all, not WHICH:
    // a Finance head must not tear down HR's in-flight letter. Own department and
    // everything below it, or tenant-wide authority (shared/orgScope.ts).
    await assertCanManageDepartment(user, letter.departmentId ?? '');
  } else if (letter.createdBy !== user.userId) {
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can cancel this letter');
  }

  if (wasInFlight || awaitingSigning) {
    await runInTransaction(async (tx) => {
      const locked = await Letter.findOne({
        where: { id, tenantId: user.tenantId, status: previousStatus },
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
      if (!locked)
        throw new AppError(409, 'ERR-LETTER-STATE-INVALID', 'Letter is no longer in the expected state (state changed concurrently)');
      // The chain must not remain queryable as "still active" — cancel every
      // step that hasn't already been decided. (No-op for PENDING_SIGNATURE:
      // every step is already APPROVED by the time a letter gets there.)
      await LetterApprovalStep.update(
        { status: 'CANCELLED' },
        { where: { letterId: id, status: { [Op.in]: ['PENDING', 'WAITING'] } }, transaction: tx },
      );
      // Void the outstanding signature ceremony too, or it stays "sent"
      // forever pointing at a document whose letter no longer exists in any
      // active state — the signer would otherwise still see it as pending.
      if (previousStatus === 'PENDING_SIGNATURE' && locked.documentId) {
        await SignatureRequest.update(
          { status: 'voided', voidedReason: `Letter cancelled: ${reason}` },
          {
            where: { documentId: locked.documentId, status: { [Op.in]: ['draft', 'sent', 'partially_signed'] } },
            transaction: tx,
          },
        );
      }
      await locked.update({ status: 'CANCELLED' }, { transaction: tx });
    });
  } else {
    // Guarded on the state we checked: a concurrent submit (DRAFT/RETURNED ->
    // IN_REVIEW) must not be silently overwritten into CANCELLED with live steps.
    const [cancelled] = await Letter.update(
      { status: 'CANCELLED' },
      { where: { id, tenantId: user.tenantId, status: previousStatus } },
    );
    if (cancelled !== 1)
      throw new AppError(409, 'ERR-LETTER-STATE-INVALID', 'Letter is no longer in the expected state (state changed concurrently)');
    letter.status = 'CANCELLED';
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_CANCELLED,
    userId: user.userId, userRole: user.role,
    actionDetails: wasInFlight || awaitingSigning
      ? { letterId: id, previousStatus, forced: wasInFlight, reason }
      : { letterId: id },
  });

  if (wasInFlight || awaitingSigning) {
    await enqueueWebsocketEvent('LETTER.CANCELLED', {
      tenantId: user.tenantId, departmentId: letter.departmentId, letterId: id, subject: letter.subject,
    });
    await fanOut({
      type: 'LETTER_CANCELLED',
      tenantId: user.tenantId,
      recipientIds: [letter.createdBy],
      severity: 'WARNING',
      payload: { letterId: id, subject: letter.subject, reason },
    }).catch(() => {});
    return getLetter(id, user);
  }
  return letter;
}

/**
 * Recall: the drafter pulls a letter back out of review to edit it. IN_REVIEW -> RETURNED, the same
 * state a reviewer's "return" produces, so editing and resubmitting need no new path (submitLetter
 * already accepts RETURNED and builds a fresh chain). Steps already decided stay in the history; the
 * open ones are cancelled. Before anyone has decided, no reason is needed; once a step has been
 * decided the drafter is discarding someone's work, so a reason is mandatory and the people who
 * acted are told. Only the drafter may recall; a head who wants it back uses cancel or return.
 */
export async function recallLetter(id: string, input: unknown, user: CurrentUser) {
  const { reason } = cancelLetterSchema.parse(input ?? {});
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.createdBy !== user.userId)
    throw new AppError(403, 'ERR-LETTER-NOT-OWNER', 'Only the drafter can recall this letter');
  if (letter.status !== 'IN_REVIEW')
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `A letter can only be recalled while it is in review (now ${letter.status})`);
  assertTransition(letter.status, 'RETURNED');

  const decidedBefore = await LetterApprovalStep.count({
    where: { letterId: id, status: { [Op.in]: ['APPROVED', 'RETURNED'] } },
  });
  const trimmed = reason?.trim() ?? '';
  if (decidedBefore > 0 && trimmed.length < 10)
    throw new AppError(422, 'ERR-REASON-REQUIRED', 'Recalling a letter after a step was decided requires a reason of at least 10 characters');

  let affectedUserIds: string[] = [];
  await runInTransaction(async (tx) => {
    const locked = await lockLetterInReview(id, user.tenantId, tx);
    const open = await LetterApprovalStep.findAll({
      where: { letterId: id, status: { [Op.in]: ['PENDING', 'WAITING'] } }, transaction: tx,
    });
    affectedUserIds = open.filter((s) => s.status === 'PENDING' && s.assignedUserId).map((s) => s.assignedUserId!);
    await LetterApprovalStep.update(
      { status: 'CANCELLED' },
      { where: { letterId: id, status: { [Op.in]: ['PENDING', 'WAITING'] } }, transaction: tx },
    );
    await locked.update({ status: 'RETURNED' }, { transaction: tx });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_RECALLED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: id, decidedStepsBefore: decidedBefore, reason: trimmed || null },
  });
  await enqueueWebsocketEvent('LETTER.RETURNED', {
    tenantId: user.tenantId, departmentId: letter.departmentId, letterId: id, subject: letter.subject,
  });
  if (affectedUserIds.length > 0) {
    await fanOut({
      type: 'LETTER_RECALLED',
      tenantId: user.tenantId,
      recipientIds: affectedUserIds,
      severity: 'INFO',
      payload: { letterId: id, subject: letter.subject, reason: trimmed || null },
    }).catch(() => {});
  }
  return getLetter(id, user);
}

/**
 * FIX: no reassignment path existed for a step whose assignee was later
 * deactivated, or a role-step whose every holder left the department — the
 * step just sat PENDING forever with the letter permanently IN_REVIEW.
 * Admin-only (department:manage or the admin bypass); does NOT require (or
 * cause) a letter state transition — this corrects who is holding the ball,
 * not the letter's lifecycle. Reuses assertStepIsActionable, the exact same
 * "someone can actually act on this" check the submit-time fix applies to a
 * brand-new chain, so a reassignment can't recreate the same deadlock.
 */
/**
 * Initiate signing on a letter whose approval is complete. LETTERS ONLY.
 *
 * The second half of the split described on initiateSigningSchema: submitting
 * for approval chooses APPROVERS, this chooses the SIGNATORY. Neither implies
 * the other, and the signatory is never handed an approval task.
 *
 * Assignee scoping matches approval steps exactly, because that was already
 * the intended rule:
 *   - a NAMED user is tenant-wide (GLOBAL). assertSignatoryIsValid only
 *     requires an active tenant member — a signatory outside the letter's own
 *     department is a deliberate, allowed choice, surfaced to the chooser as
 *     an advisory rather than blocked.
 *   - a ROLE is DEPARTMENT-SCOPED. resolveRoleUserIds is called with the
 *     letter's departmentId, so only holders inside that department qualify,
 *     and submitting fails if nobody currently does.
 * Both notify: a named signatory gets ESIGN_REQUEST_ASSIGNED, a role-based one
 * leaves the recipient unclaimed and notifies every qualifying holder, with the
 * first to open it claiming the signature.
 *
 * Preconditions, all enforced under the letter's row lock:
 *   - outgoing + composed (incoming and scanned letters have no ceremony path;
 *     they finalize directly on approval and always did)
 *   - status APPROVED — i.e. approval genuinely completed
 *   - no approval step still open
 *   - documentId still null, so no ceremony exists yet (also the idempotency
 *     guard inside enterPendingSignatureInTx)
 */
export async function initiateLetterSigning(id: string, input: unknown, user: CurrentUser) {
  const { signatory } = initiateSigningSchema.parse(input ?? {});

  // Scoped like every other read/act on a letter: the LETTER_APPROVE branch below is a
  // permission, not a place — without scopeWhere any approver in the tenant (a Finance
  // manager) could start signing on HR's approved letter, naming whoever they like as
  // signatory. (The response's getLetter() would also have 404'd AFTER the commit.)
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');

  // Who may start signing: the drafter, or anyone who can approve letters
  // (the approver who just finished is the other natural person to do it).
  const canManage = hasPermission(user, PERMISSIONS.LETTER_APPROVE);
  if (letter.createdBy !== user.userId && !canManage)
    throw new AppError(
      403,
      'ERR-LETTER-NOT-OWNER',
      'Only the drafter, or someone who can approve letters, can initiate signing',
    );

  if (letter.direction !== 'OUTGOING' || letter.originType !== 'COMPOSED')
    throw new AppError(
      409,
      'ERR-LETTER-NOT-SIGNABLE',
      'Only outgoing composed letters are signed; incoming and scanned letters are finalized on approval',
    );

  if (letter.documentId)
    throw new AppError(409, 'ERR-LETTER-ALREADY-FINALIZED', 'This letter has already been signed or finalized');

  if (letter.status !== 'APPROVED')
    throw new AppError(
      409,
      'ERR-LETTER-NOT-APPROVED',
      `Signing can only be initiated once approval is complete (letter is ${letter.status})`,
    );

  // Validated before the transaction so an unstaffed role or an inactive
  // person fails fast, with the same rules submit uses for its approvers.
  await assertSignatoryIsValid(signatory, user.tenantId, letter.departmentId ?? null, user.userId);

  const requestId = await runInTransaction(async (tx) => {
    // Re-assert every precondition under the row lock: a concurrent initiate
    // must lose rather than create a second ceremony.
    const locked = await Letter.findOne({
      where: { id: letter.id, tenantId: user.tenantId, status: 'APPROVED', documentId: null },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked)
      throw new AppError(
        409,
        'ERR-LETTER-STATE-INVALID',
        'Letter is no longer awaiting signing (state changed concurrently)',
      );

    const openStep = await LetterApprovalStep.findOne({
      where: { letterId: letter.id, status: { [Op.in]: ['WAITING', 'PENDING'] } },
      transaction: tx,
    });
    if (openStep)
      throw new AppError(
        409,
        'ERR-LETTER-APPROVAL-INCOMPLETE',
        'Approval is not complete — a step is still awaiting a decision',
      );

    await locked.update(
      {
        assignedSignatoryUserId: signatory.assignedUserId ?? null,
        assignedSignatoryRole: signatory.assignedRole ?? null,
      },
      { transaction: tx },
    );

    // Renders the signable draft, files it, moves the letter to
    // PENDING_SIGNATURE and creates + sends the single-recipient ceremony.
    // Reads the signatory off the row we just updated.
    const { requestId } = await enterPendingSignatureInTx(locked, user, tx);
    return requestId;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_PENDING_SIGNATURE,
    userId: user.userId,
    userRole: user.role,
    actionDetails: {
      letterId: letter.id,
      requestId,
      signatoryUserId: signatory.assignedUserId ?? null,
      signatoryRole: signatory.assignedRole ?? null,
      initiatedExplicitly: true,
    },
  });

  await enqueueWebsocketEvent('LETTER.PENDING_SIGNATURE', {
    tenantId: user.tenantId,
    departmentId: letter.departmentId,
    letterId: letter.id,
    subject: letter.subject,
  });

  return getLetter(id, user);
}

export async function reassignStep(letterId: string, stepId: string, input: unknown, user: CurrentUser) {
  const data = reassignStepSchema.parse(input);

  const isManager = hasPermission(user, PERMISSIONS.DEPT_MANAGE) || hasPermission(user, PERMISSIONS.ACL_BYPASS_ADMIN);

  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  // DELEGATION (2026-10-10): the person a step is waiting on may hand it to ONE named colleague themselves (on leave, out of
  // the office) without a department head: a reason is required, it must be a named person, and every rule below (not the
  // drafter, must be able to act, audit trail, notification) applies unchanged. Anyone else needs department authority.
  const delegating = !isManager
    && !!(await LetterApprovalStep.findOne({ where: { id: stepId, letterId, assignedUserId: user.userId, status: 'PENDING' } }));
  if (!isManager && !delegating)
    throw new AppError(403, 'ERR-PERMISSION-DENIED', 'Only the person the step is waiting on, a department head or an administrator can reassign it');
  if (delegating && (!data.assignedUserId || !(data.reason ?? '').trim()))
    throw new AppError(422, 'ERR-DELEGATION-INVALID', 'To delegate your step, choose one named colleague and give a reason');
  // department:manage says the caller may administer departments at all, not WHICH.
  // Unscoped, a Finance head could hand HR's pending step to themselves and then decide
  // it (a named assignee is never department-scoped in decideStep). Own department and
  // everything below it, or tenant-wide authority (shared/orgScope.ts).
  if (!delegating) await assertCanManageDepartment(user, letter.departmentId ?? '');
  if (letter.status !== 'IN_REVIEW')
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Letter is not awaiting review (status ${letter.status})`);

  const step = await LetterApprovalStep.findOne({ where: { id: stepId, letterId } });
  if (!step) throw new AppError(404, 'ERR-STEP-NOT-FOUND', 'Approval step not found');
  if (step.status !== 'PENDING')
    throw new AppError(409, 'ERR-STEP-NOT-PENDING', 'Only the currently-pending step can be reassigned');

  const newAssignedUserId = data.assignedUserId ?? null;
  const newAssignedRole = data.assignedRole ?? null;
  if (newAssignedUserId) await assertNotHiddenUser(newAssignedUserId, user.userId);
  // L15: reassigning to the drafter would recreate the stuck step the reassignment is meant to fix.
  if (newAssignedUserId && newAssignedUserId === letter.createdBy)
    throw new AppError(422, 'ERR-STEP-SELF-APPROVAL', "You cannot assign an approval step to the letter's drafter");
  await assertStepIsActionable(
    { stepType: step.stepType, assignedUserId: newAssignedUserId, assignedRole: newAssignedRole },
    user.tenantId,
    letter.departmentId ?? null,
    LETTER_STEP_RULES,
  );

  const oldAssignedUserId = step.assignedUserId;
  const oldAssignedRole = step.assignedRole;

  await runInTransaction(async (tx) => {
    // Guarded: re-assert PENDING so a concurrent decision/reassignment loses
    // with a 409 instead of silently reassigning a step someone just decided.
    const [updated] = await LetterApprovalStep.update(
      {
        assignedUserId: newAssignedUserId,
        assignedRole: newAssignedRole,
        // A new holder gets a fresh clock; breach and escalation belonged to the previous one.
        dueAt: step.slaHours ? new Date(Date.now() + step.slaHours * 3_600_000) : null,
        slaBreachedAt: null,
        escalatedAt: null,
        escalatedToUserIds: [],
      },
      { where: { id: stepId, letterId, status: 'PENDING' }, transaction: tx },
    );
    if (updated !== 1)
      throw new AppError(409, 'ERR-STEP-NOT-PENDING', 'This step has already been decided or reassigned concurrently');
    await syncLetterDocumentAcl(letterId, user.tenantId, tx); // L14: the new holder joins
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_STEP_REASSIGNED,
    userId: user.userId, userRole: user.role,
    actionDetails: {
      letterId, stepId,
      from: { assignedUserId: oldAssignedUserId, assignedRole: oldAssignedRole },
      to: { assignedUserId: newAssignedUserId, assignedRole: newAssignedRole },
      reason: data.reason ?? null,
      delegated: delegating,
    },
  });

  // Notify the newly-assigned user/role — the step is still PENDING, it just
  // moved to a new holder.
  const updatedStep = await LetterApprovalStep.findOne({ where: { id: stepId, letterId } });
  if (updatedStep) await notifyStepPending(letter, updatedStep).catch(() => {});

  return getLetter(letterId, user);
}

// ── Incoming letters (6.2) ───────────────────────────────────────────────────

const registerIncomingSchema = z.object({
  orgUnitId: z.string().uuid(),
  departmentId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  correspondent: z.string().min(1).max(500), // sender
  correspondentOrganization: z.string().max(500).optional(),
  correspondentLocation: z.string().max(500).optional(), // sender's city/country line
  correspondentEmail: z.string().email().max(320).optional(), // sender's reply-to address
  receivedDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  confidentiality: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).default('INTERNAL'),
  language: z.string().max(10).default('en'),
  assignedToUserId: z.string().uuid().optional(),
  relatedLetterId: z.string().uuid().optional(), // thread this against an outgoing letter
});

/** Register an incoming letter (6.2). Allocates a registration reference
 *  immediately, optionally files the uploaded scan as an encrypted document
 *  (with OCR queued for full-text search), and auto-routes to a department. */
export async function registerIncomingLetter(
  input: unknown,
  file: Express.Multer.File | undefined,
  user: CurrentUser,
) {
  const data = registerIncomingSchema.parse(input);
  const { unit, department } = await validateUnitAndDepartment(data.orgUnitId, data.departmentId, user.tenantId);
  if (data.assignedToUserId) {
    await assertNotHiddenUser(data.assignedToUserId, user.userId);
    await assertAssigneeInTenant(data.assignedToUserId, user.tenantId);
  }
  if (data.relatedLetterId) {
    // Same gap as linkLetters (platform audit finding 2026-08-14, HIGH) — this
    // only checked tenantId, letting a caller thread a new letter against, and
    // thereby confirm the existence of, a letter their own department/
    // confidentiality scope should hide. Scoped the same way.
    const related = await Letter.findOne({ where: { id: data.relatedLetterId, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
    if (!related) throw new AppError(422, 'ERR-RELATED-LETTER-INVALID', 'Related letter not found');
  }

  const docType = file
    ? await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'CORR' } })
    : null;
  if (file && !docType)
    throw new AppError(500, 'ERR-DOCTYPE-CORR-MISSING', 'Correspondence document type is not seeded for this tenant');
  if (file && !isValidScanFile(file))
    throw new AppError(422, 'ERR-SCAN-TYPE', 'Incoming scans must be PDF, Word, or image files');
  // Same AV scan as the main document upload path — a registered incoming
  // scan is a real uploaded file like any other.
  const avScanStatus = file ? await scanBuffer(file.buffer) : null;

  const receivedDate = data.receivedDate ?? new Date();
  // Registration-number year comes from SERVER time — a client-supplied
  // receivedDate must not be able to draw numbers from a prior year's counter.
  const year = new Date().getFullYear();

  const letter = await runInTransaction(async (tx) => {
    // Registration number allocated at intake, same gap-free counter (type IN).
    await sequelize.query(
      `INSERT INTO letter_sequences (tenant_id, org_unit_id, letter_type, year, last_value)
       VALUES (:tenantId, :orgUnitId, 'IN', :year, 0)
       ON CONFLICT (tenant_id, org_unit_id, letter_type, year) DO NOTHING`,
      { replacements: { tenantId: user.tenantId, orgUnitId: data.orgUnitId, year }, transaction: tx },
    );
    const seqRow = await LetterSequence.findOne({
      where: { tenantId: user.tenantId, orgUnitId: data.orgUnitId, letterType: 'IN', year },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!seqRow) throw new AppError(500, 'ERR-SEQUENCE-MISSING', 'Reference sequence row missing');
    const nextValue = seqRow.lastValue + 1;
    await seqRow.update({ lastValue: nextValue }, { transaction: tx });
    const referenceNumber = `${config.REFERENCE_NUMBER_PREFIX}/${unit.code}/${department.code}/IN/${year}/${String(nextValue).padStart(5, '0')}`;

    let documentId: string | null = null;
    let documentHash: string | null = null;
    if (file && docType) {
      documentId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
      const storageKey = `${user.tenantId}/${department.code}/CORR/${documentId}/${versionId}/${sanitizeFilename(file.originalname)}`;
      documentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
        storageKey, file.buffer, file.mimetype, department.id, user.tenantId,
      );
      await reserveStorageQuota(user.tenantId, file.size, tx);
      await Document.create(
        {
          id: documentId,
          tenantId: user.tenantId,
          documentName: referenceNumber,
          title: data.subject.slice(0, 255),
          departmentId: department.id,
          documentTypeId: docType.id,
          folderId: null,
          ownerId: user.userId,
          organisationUnit: unit.code,
          status: 'ACTIVE',
          securityClassification: data.confidentiality,
          retentionClass: 'RET-CORR-5Y',
          documentDate: receivedDate,
          retentionTriggerDate: receivedDate,
          disposalEligibleDate: null,
          latestVersionId: null,
          source: 'SCANNER',
          archivedAt: null,
          ocrStatus: 'PENDING',
          ocrConfidenceScore: null,
          aiSummary: null,
          aiSuggestedMetadata: null,
          deletedAt: null,
        },
        { transaction: tx },
      );
      // Retention engine (gap register #1 / D11) — see the parallel comment in
      // createScannedOutgoingLetter above.
      await applyRetention(documentId, tx);
      // A freshly Document.create'd row has zero ACL entries until something
      // grants them. Registration is intentionally cross-department (a
      // records/front-desk registrant routes mail to whichever department
      // it's addressed to, regardless of the registrant's own membership) --
      // that's why there's no authoring-time department-membership check on
      // this path, but the resulting document still needs to be visible to
      // the department it was actually routed to.
      await grantLetterDocumentAcl(
        {
          documentId, ownerId: user.userId, tenantId: user.tenantId, departmentId: department.id,
          confidentiality: data.confidentiality,
          participantIds: data.assignedToUserId ? [data.assignedToUserId] : [],
        },
        tx,
      );
      const version = await DocumentVersion.create(
        {
          id: versionId,
          documentId,
          versionNumber: '1.0',
          isMajorVersion: true,
          storageKey,
          storageBucket: config.MINIO_BUCKET_DOCUMENTS,
          fileSize: BigInt(file.size),
          mimeType: file.mimetype,
          originalFilename: file.originalname,
          sha256Hash: encHash,
          plaintextSha256: documentHash,
          extractedText: null,
          authorId: user.userId,
          changeSummary: 'CAMS: registered incoming letter scan',
          avScanStatus: avScanStatus!, // non-null: computed above whenever `file` is truthy, same condition as this block
        },
        { transaction: tx },
      );
      await Document.update({ latestVersionId: version.id }, { where: { id: documentId }, transaction: tx });
      await DocumentDek.create(
        { documentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
        { transaction: tx },
      );
      // OCR-index the scan so incoming letters are full-text searchable (6.2).
      await OutboxEvent.bulkCreate(
        [
          { documentId, type: 'OCR_PROCESSING', channel: 'OCR', payload: JSON.stringify({ documentId, versionId, tenantId: user.tenantId }) },
          { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
        ],
        { transaction: tx },
      );
    }

    // A QR can't be baked into the uploaded scan itself, so a separate
    // one-page cover sheet carries the verification QR for this reference
    // number (only when there's an actual scan to accompany — a logged-only
    // registration with no file has nothing to file a cover sheet against).
    let coverSheetDocumentId: string | null = null;
    let qrPayload: string | null = null;
    if (file && docType) {
      const contentHash = crypto
        .createHash('sha256')
        .update(`${referenceNumber}|${data.subject}|${data.correspondent}|${receivedDate.toISOString()}`)
        .digest('hex');
      qrPayload = `${config.CAMS_VERIFY_BASE_URL}?ref=${encodeURIComponent(referenceNumber)}&hash=${contentHash}`;
      const coverSheet = await generateLetterCoverSheet({
        referenceNumber,
        direction: 'INCOMING',
        subject: data.subject,
        unitName: unit.name,
        letterheadTitle: unit.letterheadTitle,
        departmentName: department.name,
        correspondent: data.correspondent,
        correspondentOrganization: data.correspondentOrganization ?? null,
        correspondentLocation: data.correspondentLocation ?? null,
        attachmentFilename: file.originalname,
        confidentiality: data.confidentiality,
        stampedAt: receivedDate,
        qrUrl: qrPayload,
      });
      coverSheetDocumentId = crypto.randomUUID();
      const coverVersionId = crypto.randomUUID();
      const coverStorageKey = `${department.code}/CORR/${coverSheetDocumentId}/${coverVersionId}/cover-sheet.pdf`;
      const coverEnc = await encryptAndStore(
        coverStorageKey, coverSheet, 'application/pdf', department.id, user.tenantId,
      );
      await reserveStorageQuota(user.tenantId, coverSheet.length, tx);
      await Document.create(
        {
          id: coverSheetDocumentId,
          tenantId: user.tenantId,
          documentName: `${referenceNumber} — Cover Sheet`,
          title: `Cover sheet: ${data.subject}`.slice(0, 255),
          departmentId: department.id,
          documentTypeId: docType.id,
          folderId: null,
          ownerId: user.userId,
          organisationUnit: unit.code,
          status: 'ACTIVE',
          securityClassification: data.confidentiality,
          retentionClass: 'RET-CORR-5Y',
          documentDate: receivedDate,
          retentionTriggerDate: receivedDate,
          disposalEligibleDate: null,
          latestVersionId: null,
          source: 'CREATED_IN_SYSTEM',
          archivedAt: null,
          ocrStatus: null,
          ocrConfidenceScore: null,
          aiSummary: null,
          aiSuggestedMetadata: null,
          deletedAt: null,
        },
        { transaction: tx },
      );
      // Retention engine (gap register #1 / D11) — see the parallel comment in
      // createScannedOutgoingLetter above.
      await applyRetention(coverSheetDocumentId, tx);
      await grantLetterDocumentAcl(
        {
          documentId: coverSheetDocumentId, ownerId: user.userId, tenantId: user.tenantId, departmentId: department.id,
          confidentiality: data.confidentiality,
          participantIds: data.assignedToUserId ? [data.assignedToUserId] : [],
        },
        tx,
      );
      const coverVersion = await DocumentVersion.create(
        {
          id: coverVersionId,
          documentId: coverSheetDocumentId,
          versionNumber: '1.0',
          isMajorVersion: true,
          storageKey: coverStorageKey,
          storageBucket: config.MINIO_BUCKET_DOCUMENTS,
          fileSize: BigInt(coverSheet.length),
          mimeType: 'application/pdf',
          originalFilename: `${referenceNumber.replace(/\//g, '-')}-cover-sheet.pdf`,
          sha256Hash: coverEnc.sha256Hash,
          plaintextSha256: crypto.createHash('sha256').update(coverSheet).digest('hex'),
          extractedText: `${referenceNumber} ${data.subject} ${data.correspondent}`.slice(0, 100_000),
          authorId: user.userId,
          changeSummary: 'CAMS: verification cover sheet for registered incoming scan',
        },
        { transaction: tx },
      );
      await Document.update({ latestVersionId: coverVersion.id }, { where: { id: coverSheetDocumentId }, transaction: tx });
      await DocumentDek.create(
        { documentId: coverSheetDocumentId, versionId: coverVersionId, encryptedDek: coverEnc.encryptedKey, kekId: coverEnc.kekId, algorithm: 'AES-256-GCM' },
        { transaction: tx },
      );
    }

    const created = await Letter.create(
      {
        tenantId: user.tenantId,
        direction: 'INCOMING',
        status: 'RECEIVED',
        referenceNumber,
        orgUnitId: data.orgUnitId,
        departmentId: data.departmentId,
        letterType: 'IN',
        originType: file ? 'SCANNED' : null,
        subject: data.subject,
        bodyHtml: null,
        language: data.language,
        confidentiality: data.confidentiality,
        priority: data.priority,
        correspondent: data.correspondent,
        correspondentOrganization: data.correspondentOrganization ?? null,
        correspondentLocation: data.correspondentLocation ?? null,
        correspondentEmail: data.correspondentEmail ?? null,
        receivedDate: receivedDate.toISOString().slice(0, 10),
        dueDate: data.dueDate ? data.dueDate.toISOString().slice(0, 10) : null,
        assignedToUserId: data.assignedToUserId ?? null,
        signatoryUserId: null,
        signatoryName: null,
        signatoryTitle: null,
        approvedAt: null,
        documentId,
        attachmentDocumentId: null,
        coverSheetDocumentId,
        documentHash,
        qrPayload,
        year,
        createdBy: user.userId,
      },
      { transaction: tx },
    );

    if (data.relatedLetterId) {
      await LetterLink.create(
        {
          tenantId: user.tenantId,
          letterId: created.id,
          relatedLetterId: data.relatedLetterId,
          linkType: 'REPLY_TO',
          createdBy: user.userId,
        },
        { transaction: tx },
      );
    }
    return created;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_REGISTERED,
    userId: user.userId, userRole: user.role, documentId: letter.documentId,
    actionDetails: {
      letterId: letter.id, referenceNumber: letter.referenceNumber,
      sender: letter.correspondent, hasScan: Boolean(letter.documentId),
    },
  });
  if (avScanStatus === 'unscanned') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
      userId: user.userId, userRole: user.role, documentId: letter.documentId,
      actionDetails: { reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
    });
  }
  await enqueueWebsocketEvent('LETTER.REGISTERED', {
    tenantId: user.tenantId, departmentId: letter.departmentId,
    letterId: letter.id, referenceNumber: letter.referenceNumber, subject: letter.subject,
  });
  if (letter.assignedToUserId) {
    await fanOut({
      type: 'LETTER_REGISTERED',
      tenantId: user.tenantId,
      recipientIds: [letter.assignedToUserId],
      severity: 'INFO',
      payload: { letterId: letter.id, referenceNumber: letter.referenceNumber, subject: letter.subject },
    }).catch(() => {});
  }
  await notifyExecutivesOfLetter(letter, {
    departmentName: department.name,
    attachDocumentId: letter.documentId,
  });
  // avScanStatus is null when no scan file was provided at all — no warning
  // in that case, same convention as the other two scan-computing paths.
  return { ...letter.get({ plain: true }), warnings: avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : [] };
}

const assignSchema = z.object({
  assignedToUserId: z.string().uuid().nullable(),
  dueDate: z.coerce.date().nullable().optional(),
});

/** Route / re-route an incoming letter to a responsible officer (6.2). */
export async function assignLetter(id: string, input: unknown, user: CurrentUser) {
  const data = assignSchema.parse(input);
  // Tenant + department/confidentiality scope (platform audit finding
  // 2026-08-14, HIGH — see recordDispatch's comment above). This function
  // also returns the full letter, so an unscoped lookup would leak content.
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.direction !== 'INCOMING')
    throw new AppError(409, 'ERR-LETTER-DIRECTION', 'Only incoming letters can be assigned');
  // Routing is for open correspondence: a CLOSED/ARCHIVED letter is a finished record.
  if (letter.status === 'CLOSED' || letter.status === 'ARCHIVED')
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Letter cannot be re-assigned in status ${letter.status}`);
  if (data.assignedToUserId) {
    await assertNotHiddenUser(data.assignedToUserId, user.userId);
    await assertAssigneeInTenant(data.assignedToUserId, user.tenantId);
  }
  await runInTransaction(async (tx) => {
    await letter.update({
      assignedToUserId: data.assignedToUserId,
      ...(data.dueDate !== undefined
        ? { dueDate: data.dueDate ? data.dueDate.toISOString().slice(0, 10) : null }
        : {}),
    }, { transaction: tx });
    await syncLetterDocumentAcl(letter.id, user.tenantId, tx); // L14: the officer must be able to open the scan
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_ASSIGNED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: id, assignedToUserId: data.assignedToUserId },
  });
  return letter;
}

// ── Cross-reference index (6.3) ──────────────────────────────────────────────

const linkSchema = z.object({
  relatedLetterId: z.string().uuid(),
  linkType: z.enum(['REPLY_TO', 'RELATED', 'FOLLOW_UP']).default('RELATED'),
});

export async function linkLetters(letterId: string, input: unknown, user: CurrentUser) {
  const data = linkSchema.parse(input);
  if (data.relatedLetterId === letterId)
    throw new AppError(422, 'ERR-LINK-SELF', 'A letter cannot be linked to itself');
  // Tenant + department/confidentiality scope on BOTH sides (platform audit
  // finding 2026-08-14, HIGH — see recordDispatch's comment above) — linking
  // would otherwise let a caller confirm the existence of, and cross-reference
  // into, a letter their own scope should hide.
  const scope = await scopeWhere(user);
  const [letter, related] = await Promise.all([
    Letter.findOne({ where: { id: letterId, tenantId: user.tenantId, ...scope } }),
    Letter.findOne({ where: { id: data.relatedLetterId, tenantId: user.tenantId, ...scope } }),
  ]);
  if (!letter || !related) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  const [link, created] = await LetterLink.findOrCreate({
    where: { letterId, relatedLetterId: data.relatedLetterId, linkType: data.linkType },
    defaults: {
      tenantId: user.tenantId, letterId,
      relatedLetterId: data.relatedLetterId, linkType: data.linkType, createdBy: user.userId,
    },
  });
  if (created) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_LINKED,
      userId: user.userId, userRole: user.role,
      actionDetails: { letterId, relatedLetterId: data.relatedLetterId, linkType: data.linkType },
    });
  }
  return link;
}

export async function unlinkLetters(letterId: string, linkId: string, user: CurrentUser) {
  // Tenant + department/confidentiality scope on the underlying letter
  // (platform audit finding 2026-08-14, HIGH — see recordDispatch's comment
  // above) — LetterLink itself has no confidentiality concept of its own.
  const letter = await Letter.findOne({ where: { id: letterId, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  const link = await LetterLink.findOne({ where: { id: linkId, letterId, tenantId: user.tenantId } });
  if (!link) throw new AppError(404, 'ERR-LINK-NOT-FOUND', 'Letter link not found');
  await link.destroy();
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_LINK_REMOVED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId, linkId },
  });
}

/** Both directions of the cross-reference index for one letter. */
export async function getLetterThread(letterId: string, user: CurrentUser) {
  await getLetter(letterId, user); // access check on the primary letter
  // Platform audit finding (2026-08-14, HIGH — same class as recordDispatch's
  // fix above): the primary letter being in scope says nothing about the
  // *linked* letters on the other end of each LetterLink — a link can exist
  // whose other side sits in a different department or a higher
  // confidentiality tier (e.g. created by a LETTER_READ_ALL holder). Without
  // this, subject/status/reference of an out-of-scope letter leaked to
  // anyone who could merely see the in-scope side of the link. `required:
  // true` on a scoped include makes it an inner join — an out-of-scope
  // linked letter is silently dropped from the thread, not errored, matching
  // this file's existing "treat out-of-scope as absent" convention.
  const scope = { tenantId: user.tenantId, ...(await scopeWhere(user, { forRead: true })) };
  const [outbound, inbound] = await Promise.all([
    LetterLink.findAll({
      where: { letterId },
      include: [{
        model: Letter, as: 'relatedLetter',
        attributes: ['id', 'referenceNumber', 'subject', 'direction', 'status', 'approvedAt', 'receivedDate'],
        where: scope,
        required: true,
      }],
    }),
    LetterLink.findAll({
      where: { relatedLetterId: letterId },
      include: [{
        model: Letter, as: 'letter',
        attributes: ['id', 'referenceNumber', 'subject', 'direction', 'status', 'approvedAt', 'receivedDate'],
        where: scope,
        required: true,
      }],
    }),
  ]);
  return { outbound, inbound };
}

/** Move a completed letter into the archive space (6.3). */
export async function archiveLetter(id: string, user: CurrentUser) {
  // Tenant + department/confidentiality scope (platform audit finding
  // 2026-08-14, HIGH — see recordDispatch's comment above). This function
  // also returns the full letter, so an unscoped lookup would leak content.
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  // L12: enforced through the state machine, not a hand-maintained inline list
  // that can silently drift from it.
  assertTransition(letter.status, 'ARCHIVED');
  assertLetterFinalized(letter); // see recordDispatch: APPROVED-awaiting-signing is not a letter of record yet
  await letter.update({ status: 'ARCHIVED' });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_ARCHIVED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: id, referenceNumber: letter.referenceNumber },
  });
  return letter;
}

/** Mark an incoming letter as responded / closed (due-date tracking, 6.2).
 *  RESPONDED = a reply has been sent; CLOSED = no further action needed. */
export async function resolveIncomingLetter(id: string, target: 'RESPONDED' | 'CLOSED', user: CurrentUser) {
  // Tenant + department/confidentiality scope (platform audit finding
  // 2026-08-14, HIGH — see recordDispatch's comment above). This function
  // also returns the full letter, so an unscoped lookup would leak content.
  const letter = await Letter.findOne({ where: { id, tenantId: user.tenantId, ...(await scopeWhere(user)) } });
  if (!letter) throw new AppError(404, 'ERR-LETTER-NOT-FOUND', 'Letter not found');
  if (letter.direction !== 'INCOMING')
    throw new AppError(409, 'ERR-LETTER-DIRECTION', 'Only incoming letters can be marked responded/closed');
  // L12: the state machine already encodes RECEIVED→RESPONDED/CLOSED and
  // RESPONDED→CLOSED — use it instead of a parallel inline rule.
  const previousStatus = letter.status;
  assertTransition(previousStatus, target);
  await letter.update({ status: target });
  // CLOSED used to be audited as LETTER_ARCHIVED, although the letter is not
  // archived (its status is CLOSED) — a false entry in the trail. Both targets
  // are status changes of the record, so both are LETTER_UPDATED, and the
  // before/after statuses say which.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_UPDATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { letterId: id, action: `mark_${target.toLowerCase()}`, from: previousStatus, to: target },
  });
  return letter;
}

/** Public QR verification (6.1.5): confirms authenticity from ref + content
 *  hash. Only non-sensitive confirmation data is exposed — never the body. */
export async function verifyLetter(referenceNumber: string, hash: string) {
  // Reference numbers are unique PER TENANT, not globally — two tenants with
  // the same unit/dept codes can hold the same ref. Fetch all candidates and
  // match on the EXACT hash (never substring) so a genuine letter can't be
  // masked by another tenant's, and a truncated hash can't pass.
  //
  // FIX 2026-09-23: this route is mounted on lettersPublicRoutes, BEFORE
  // `authenticate`/`tenantContext` (api/v1/index.ts) — there is no logged-in
  // user and so no `SET LOCAL app.current_tenant`. `letters` FORCE-enables
  // RLS with a strict `tenant_id = current_setting('app.current_tenant')`
  // policy and no fail-open/superuser clause, so edams_app (the app's real,
  // non-superuser production DB role) saw ZERO rows here, always — every
  // genuine letter reported "not registered" on the public QR-verify page,
  // silently, no error, exactly the class of bug workerTenantContext.ts's own
  // doc comment already warns about ("a worker does one big cross-tenant
  // SELECT with no tenant GUC"). This route is that same pattern in a public
  // HTTP handler instead of a worker. Since a ref is only unique PER tenant
  // (the very reason this always queried across all candidates rather than
  // findOne), there is no single tenant to scope this transaction to ahead of
  // time — loop the tenant registry (tenant-agnostic, no RLS) and scope one
  // transaction per tenant, short-circuiting the moment a candidate whose
  // qrPayload hash matches is found.
  const tenantRows = await sequelize.query<{ id: string }>('SELECT id FROM tenants', { type: QueryTypes.SELECT });
  const hashLowerForScan = hash.toLowerCase();
  let candidates: Letter[] = [];
  let matchedTenantId: string | null = null;
  for (const { id: scanTenantId } of tenantRows) {
    const rows = await withWorkerTenantContext(scanTenantId, () =>
      Letter.findAll({
        where: { referenceNumber },
        include: [{ model: OrgUnit, as: 'orgUnit', attributes: ['code', 'name', 'unitType'] }],
        limit: 10,
      }),
    );
    if (rows.length === 0) continue;
    const isMatch = rows.some((l) => {
      if (!l.qrPayload) return false;
      try {
        return new URL(l.qrPayload).searchParams.get('hash')?.toLowerCase() === hashLowerForScan;
      } catch {
        return false;
      }
    });
    if (isMatch) {
      candidates = rows;
      matchedTenantId = scanTenantId;
      break;
    }
    // No hash match in this tenant — keep the rows anyway ONLY if nothing
    // has matched yet, so an all-tenant miss still returns "not registered"
    // rather than "not found" for audit/error-shape purposes, same as the
    // original single-query behavior when candidates existed but none matched.
    if (candidates.length === 0) {
      candidates = rows;
      matchedTenantId = scanTenantId;
    }
  }
  // Hex hash comparison must be case-insensitive: the route's own validation
  // regex (/^[0-9a-f]{64}$/i) already accepts upper/mixed-case hex, but this
  // was still comparing with ===, so a hash that arrived in a different case
  // than the lowercase hex crypto.createHash(...).digest('hex') always stores
  // (a mobile browser's autocapitalize on a manually retyped link, a
  // case-altering link scrubber, etc.) reported a genuine, unaltered letter
  // as "not registered / altered" even though nothing was wrong with it.
  const hashLower = hash.toLowerCase();
  const letter = candidates.find((l) => {
    if (!l.qrPayload) return false;
    try {
      return new URL(l.qrPayload).searchParams.get('hash')?.toLowerCase() === hashLower;
    } catch {
      return false;
    }
  });
  const authentic = Boolean(letter && letter.status !== 'CANCELLED');

  // Audit only when the ref actually exists — an unauthenticated flood of
  // random refs must not turn into writes through the audit chain. The public
  // route is additionally rate-limited.
  if (candidates.length > 0) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_VERIFIED,
      tenantId: matchedTenantId ?? undefined,
      actionDetails: { referenceNumber, authentic },
    });
  }

  if (!letter || !authentic) {
    return { authentic: false as const, referenceNumber };
  }
  const unit = (letter as Letter & { orgUnit?: OrgUnit }).orgUnit;
  return {
    authentic: true as const,
    referenceNumber: letter.referenceNumber,
    issuingUnit: unit ? { code: unit.code, name: unit.name } : null,
    signatoryName: letter.signatoryName,
    signatoryTitle: letter.signatoryTitle,
    approvedAt: letter.approvedAt,
    status: letter.status,
  };
}
