// Unified approval engine (SYSTEM-DECISIONS.md D1–D7).
//
// Generalizes the letters (CAMS) approval chain to documents and forms:
//   * admin-defined chain TEMPLATES per document type / form template, with
//     LOCKED mandatory steps the author cannot remove or change (D1);
//   * author completion at submit — swap roles for named people, add/reorder
//     optional steps (D1);
//   * sequential steps, exactly one PENDING at a time, named-user OR role
//     assignees (role steps department-scoped for documents);
//   * three decisions: APPROVE / REQUEST_CHANGES (chain suspends, author
//     fixes and resubmits) / DECLINE (hard no with mandatory comment,
//     revisable — D3);
//   * final approval routes into the audit stage (D5–D7) and/or a signing
//     ceremony (D8) per the item type's auditPolicy / signingPolicy;
//   * letters keep their own proven implementation (they already match this
//     UX); this engine serves DOCUMENT, FORM_TEMPLATE and FORM_INSTANCE.
//
// Concurrency hardening mirrors letters: the item's chain row is locked
// FOR UPDATE and step decisions use status-guarded updates, so two
// simultaneous deciders get exactly one success and one 409.

import { assertNotHiddenUser, hiddenUserIds, notPlatformAdminSql, withoutHiddenIds } from "../../shared/platformAdmin.js";
import { z } from "zod";
import { QueryTypes, Op, UniqueConstraintError, type Transaction as SequelizeTransaction } from "sequelize";
import {
  ApprovalChain,
  ApprovalChainTemplate,
  AclEntry,
  ApprovalStep,
  AuditStageReview,
  Department,
  Document,
  DocumentType,
  FormInstance,
  FormTemplate,
  OrgUnit,
  User,
  UserDepartment,
  UserTenant,
  sequelize,
  type ApprovalItemType,
  type ApprovalTemplateStep,
} from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { invalidateResourceACL } from "../../infrastructure/cache/aclCache.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { fanOut } from "../notifications/notifications.service.js";
import { enqueueWebsocketEvent } from "../../infrastructure/queue/outbox.js";
import { logger } from "../../core/logger.js";
import { runInTransaction } from "../../shared/transaction.js";
import { requireDocumentAccess, requireLegalHoldClear } from "../../shared/documentGuards.js";
import { assertACLAllow } from "../../shared/resolveACL.js";
import { validateTransition } from "../documents/DocumentStateMachine.js";
import { applyRetention } from "../retention/retentionEngine.js";
import { Role, UserRole } from "../../infrastructure/database/index.js";
import { getResolvedRolePermissions } from "../roles/roles.service.js";
import { assertCanManageDepartment } from "../../shared/orgScope.js";
import { hasOrgWideTemplateAuthority } from "../forms/formTemplateScope.js";
import { grantClassifiedReadsToParticipants } from "./classifiedParticipants.js";
import {
  ENGINE_STEP_RULES,
  assertAssigneeInTenant,
  assertRoleStepDepartmentScope,
  assertStepIsActionable,
  getUserDepartmentIds,
  hasPermission,
  normalizeApprovalDepartmentId,
  stepIsAssignedTo,
  type CurrentUser,
} from "./stepRules.js";
// R-08: the step-assignment/decision rules, the UNCAT normalizer and
// CurrentUser all used to be defined here AND again in letters.service.ts.
// They now live in ./stepRules.ts; re-exported so existing importers
// (auditStage.service.ts, myWork.service.ts) keep working unchanged.
export { getUserDepartmentIds, normalizeApprovalDepartmentId };
export type { CurrentUser } from "./stepRules.js";

/**
 * H4: candidate assignees for the approval/audit pickers.
 *
 * The frontend used GET /users (USER_MANAGE-only) to populate the named-person
 * and auditor dropdowns, so a submitter or final approver WITHOUT user:manage
 * saw an empty list — which made a `required`-audit document impossible to
 * approve and defeated "swap roles for named people" for ordinary submitters.
 *
 * This returns only the minimal fields the picker needs, scoped to the tenant
 * and to users who can actually act: `decide` → holders of approval:decide,
 * `audit` → holders of audit-stage:decide. Optionally filtered to a department
 * so role steps only offer people who could satisfy them.
 */
export async function listAssignableUsers(
  user: CurrentUser,
  capability: "decide" | "audit",
  departmentId?: string,
): Promise<Array<{ id: string; firstName: string; lastName: string; email: string; departments: Array<{ id: string; name: string; code: string }> }>> {
  const permission = capability === "audit" ? PERMISSIONS.AUDIT_STAGE_DECIDE : PERMISSIONS.APPROVAL_DECIDE;

  // Which roles grant the capability (built-in defaults + per-tenant overrides).
  const roles = await Role.findAll({ attributes: ["id", "name"] });
  const grantingRoleIds: string[] = [];
  for (const r of roles) {
    const perms = await getResolvedRolePermissions(r.name, user.tenantId);
    if (perms.includes(permission)) grantingRoleIds.push(r.id);
  }
  if (grantingRoleIds.length === 0) return [];

  // Users who hold one of those roles.
  const roleHolders = await UserRole.findAll({
    where: { roleId: { [Op.in]: grantingRoleIds } },
    attributes: ["userId"],
    raw: true,
  });
  let candidateIds = [...new Set(roleHolders.map((r) => r.userId))];
  if (candidateIds.length === 0) return [];

  // Scope to the actor's tenant membership (user_tenants), so the picker never
  // leaks names from other tenants.
  const memberships = await UserTenant.findAll({
    where: { tenantId: user.tenantId, userId: { [Op.in]: candidateIds } },
    attributes: ["userId"],
    raw: true,
  });
  candidateIds = await withoutHiddenIds([...new Set(memberships.map((m) => m.userId))], user.userId);
  if (candidateIds.length === 0) return [];

  // Optionally restrict to a department (for role-step assignees).
  if (departmentId) {
    const inDept = await UserDepartment.findAll({
      where: { departmentId, userId: { [Op.in]: candidateIds } },
      attributes: ["userId"],
      raw: true,
    });
    candidateIds = [...new Set(inDept.map((d) => d.userId))];
    if (candidateIds.length === 0) return [];
  }

  const users = await User.findAll({
    where: { id: { [Op.in]: candidateIds }, isActive: true, deletedAt: null },
    attributes: ["id", "firstName", "lastName", "email"],
    order: [["firstName", "ASC"]],
    raw: true,
  });
  if (users.length === 0) return [];

  // Departments per user, same "two small queries, no association-alias
  // assumptions" pattern used throughout this file — for the picker's
  // cross-department warning.
  const userDeptRows = await UserDepartment.findAll({
    where: { userId: { [Op.in]: users.map((u) => u.id) } },
    attributes: ["userId", "departmentId"],
    raw: true,
  });
  const deptIds = [...new Set(userDeptRows.map((r) => r.departmentId))];
  const depts = deptIds.length
    ? await Department.findAll({ where: { id: { [Op.in]: deptIds } }, attributes: ["id", "name", "code"], raw: true })
    : [];
  const deptById = new Map(depts.map((d) => [d.id, d]));
  const deptsByUser = new Map<string, Array<{ id: string; name: string; code: string }>>();
  for (const r of userDeptRows) {
    const dept = deptById.get(r.departmentId);
    if (!dept) continue;
    const list = deptsByUser.get(r.userId) ?? [];
    list.push({ id: dept.id, name: dept.name, code: dept.code });
    deptsByUser.set(r.userId, list);
  }

  return users.map((u) => ({
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    departments: deptsByUser.get(u.id) ?? [],
  }));
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const stepInputSchema = z
  .object({
    stepType: z.enum(["REVIEW", "APPROVE"]),
    assignedUserId: z.string().uuid().optional(),
    assignedRole: z.string().min(2).max(100).optional(),
    slaHours: z.number().int().min(1).max(24 * 90).optional(),
  })
  .refine((s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole), {
    message: "Provide exactly one of assignedUserId or assignedRole",
  });

const submitSchema = z.object({
  steps: z.array(stepInputSchema).min(1).max(20).optional(),
});

const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "DECLINE"]),
  comment: z.string().max(4000).optional(),
  // D6: on the FINAL approve of an item whose type has auditPolicy
  // required/optional, the final approver picks a named auditor.
  auditorUserId: z.string().uuid().optional(),
});

const reassignSchema = z
  .object({
    assignedUserId: z.string().uuid().optional(),
    assignedRole: z.string().min(2).max(100).optional(),
    reason: z.string().min(10).max(2000),
  })
  .refine((s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole), {
    message: "Provide exactly one of assignedUserId or assignedRole",
  });

const templateSchema = z.object({
  documentTypeId: z.string().uuid().optional(),
  formTemplateId: z.string().uuid().optional(),
  // Recipe scope: department / org unit it applies to (both empty = tenant-wide); forFormTemplates = the recipe that
  // approves form TEMPLATES themselves (audit E6).
  departmentId: z.string().uuid().nullish(),
  orgUnitId: z.string().uuid().nullish(),
  forFormTemplates: z.boolean().optional(),
  // A catch-all recipe: no document type, no form template. Applies to everything at its scope that has no recipe of its own.
  isDefault: z.boolean().optional(),
  name: z.string().min(1).max(255),
  steps: z
    .array(
      stepInputSchema.innerType().extend({ locked: z.boolean().optional() }).refine(
        (s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole),
        { message: "Provide exactly one of assignedUserId or assignedRole" },
      ),
    )
    .min(1)
    .max(20),
  isActive: z.boolean().optional(),
});

// ─── Item adapters ────────────────────────────────────────────────────────────
// Each item kind knows: how to load + authorize, its department (for role
// scoping), which states allow submit, and what happens on suspend/decline/
// complete. Everything else in the engine is item-agnostic.

export type LoadedItem = {
  itemType: ApprovalItemType;
  itemId: string;
  departmentId: string | null;
  documentTypeId: string | null; // policies source for DOCUMENT; fallback for FORM_INSTANCE
  formTemplateId: string | null; // primary policies source for FORM_INSTANCE
  /** FORM_TEMPLATE only: the template's org-unit scope (its department scope is `departmentId`). */
  orgUnitId: string | null;
  ownerId: string | null;
  title: string;
  /** The document an assignee has to be able to OPEN in order to act. Equal to
   *  itemId for DOCUMENT, the instance's filed PDF for FORM_INSTANCE, and null
   *  for FORM_TEMPLATE (which has no document). Used by
   *  grantChainParticipantAcl. */
  documentId: string | null;
};

/**
 * Grant the people an approval chain routes work to permission to OPEN the
 * thing they have been asked to act on.
 *
 * The bug this fixes, live-reproduced: assigning a step to a named user
 * outside the item's own department is deliberately allowed — a NAMED assignee
 * is globally scoped by design, and the picker only shows a cross-department
 * advisory rather than blocking it. But nothing granted that person access to
 * the document. grantDefaultDocumentAcl (documents.service.ts) grants
 * document:read to the owner and to a SNAPSHOT of the document's own
 * department members, and this module wrote no ACL entries at all — so the
 * assignee's very first click failed with AUTHZ_ACL_NO_ENTRY / "No access
 * control entry for this resource" and they could never reach the Workflow
 * tab to act. Assignment succeeded; acting on it was impossible.
 *
 * getChain() already lets a chain participant bypass its own ACL and
 * department checks, but the page loads GET /documents/:id first, and that has
 * no such bypass — so the document fetch is what actually failed.
 *
 * letters.service.ts already does exactly this for its signatory (see the
 * AclEntry grants in enterPendingSignatureInTx, and the comment there giving
 * this same reason). This is the engine's missing equivalent, applied at every
 * point that names a participant: submit, reassign, and auditor assignment.
 *
 * Shape follows the letters precedent:
 *   - a named user  -> principalType 'user', principalId = their id
 *   - a role        -> principalType 'role', principalId = the role NAME
 *     (resolveACL matches an ACL role principal against the acting user's role
 *     names). Granting the role is only a READ grant; actually deciding still
 *     requires department-scoped role membership, enforced separately by
 *     assertRoleStepDepartmentScope at decide time.
 *
 * document:read only — never write, archive or purge. And ignoreDuplicates, so
 * re-submitting a chain or reassigning back to someone is idempotent.
 */
export async function grantChainParticipantAcl(
  documentId: string | null,
  tenantId: string,
  grantedById: string,
  participants: Array<{ assignedUserId?: string | null; assignedRole?: string | null }>,
  tx: SequelizeTransaction,
): Promise<void> {
  // FORM_TEMPLATE approvals have no document behind them, so there is nothing
  // to grant and nothing to fail on.
  if (!documentId) return;

  // The chain's participants must be able to open everything the item is made of, not only the main
  // PDF: a form's file-field attachments are separate documents (audit E5). Same read-only grant.
  const targetDocumentIds = [documentId, ...(await linkedDocumentIds(documentId, tenantId, tx))];

  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const p of participants) {
    const principal = p.assignedUserId
      ? { principalType: "user" as const, principalId: p.assignedUserId }
      : p.assignedRole
        ? { principalType: "role" as const, principalId: p.assignedRole }
        : null;
    if (!principal) continue;
    const key = `${principal.principalType}:${principal.principalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const targetId of targetDocumentIds) {
      rows.push({
        tenantId,
        resourceType: "document" as const,
        resourceId: targetId,
        ...principal,
        effect: "ALLOW" as const,
        permission: "document:read",
        grantedById,
      });
    }
  }
  if (rows.length === 0) return;
  await AclEntry.bulkCreate(rows as never[], { transaction: tx, ignoreDuplicates: true });
  // A CLASSIFIED document opens only for people holding a deliberate per-person grant: promote the automatic department row and expand
  // role steps to the people who hold the role (approvals/classifiedParticipants.ts). Ordinary documents are untouched.
  await grantClassifiedReadsToParticipants(targetDocumentIds, tenantId, grantedById, participants, tx);

  // Writing the row is not enough: resolveACL caches its decisions for 300s
  // (aclCache.ts, TDD §5.1), including NEGATIVE ones. So an assignee who
  // happened to try opening the item before the assignment landed — clicking a
  // notification early, or sitting on the page while the approver assigns it —
  // stays locked out for up to five minutes AFTER being granted access, which
  // is indistinguishable from the bug this grant fixes.
  //
  // afterCommit, not inline: clearing the cache before the grant is committed
  // leaves a window where a concurrent request re-populates it from the
  // pre-grant state, putting the stale deny straight back.
  //
  // AWAITED, not fire-and-forget. Sequelize awaits afterCommit hooks, so the
  // submit response is not sent until the cache is actually clear. With a
  // `void` here the invalidation raced the caller's very next request and lost
  // deterministically — verify-approval-participant-access.ts failed on
  // exactly that: assign, then immediately open, still 403. Errors are
  // swallowed rather than thrown, because the grant itself has committed and
  // failing the assignment over a cache sweep would be worse than the delay.
  tx.afterCommit(async () => {
    try {
      for (const targetId of targetDocumentIds) await invalidateResourceACL(tenantId, "document", targetId);
    } catch (error) {
      logger.warn(
        { error, documentId, tenantId },
        "granted approval participants document:read but could not invalidate the ACL cache; access may lag by up to the cache TTL",
      );
    }
  });
}

/** Document ids referenced by a form instance's file fields ({ documentId, fileName } values in dataJson). */
export function attachmentDocumentIds(dataJson: unknown): string[] {
  const ids = new Set<string>();
  if (dataJson && typeof dataJson === "object") {
    for (const value of Object.values(dataJson as Record<string, unknown>)) {
      const id = value && typeof value === "object" ? (value as { documentId?: unknown }).documentId : undefined;
      if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** The other documents an item is made of: for a form instance's filed PDF, its attachments. (Signed copies are
 *  new VERSIONS of the same document, so the main grant already covers them.) Tenant-checked. */
async function linkedDocumentIds(documentId: string, tenantId: string, tx: SequelizeTransaction): Promise<string[]> {
  const instance = await FormInstance.findOne({ where: { documentId }, attributes: ["id", "dataJson"], transaction: tx });
  const ids = attachmentDocumentIds(instance?.dataJson);
  if (ids.length === 0) return [];
  const docs = await Document.findAll({ where: { id: { [Op.in]: ids }, tenantId }, attributes: ["id"], transaction: tx });
  return docs.map((d) => d.id);
}

/** The document an audit row about this item belongs to (so the document's own trail shows the approval). */
export function auditDocumentId(item: LoadedItem): string | undefined {
  return item.itemType === "FORM_TEMPLATE" ? undefined : item.documentId ?? undefined;
}

/** Ids worth recording on every engine audit event, whatever the item kind. */
export function itemRefs(item: LoadedItem): Record<string, unknown> {
  if (item.itemType === "FORM_INSTANCE")
    return { itemType: item.itemType, itemId: item.itemId, formInstanceId: item.itemId, formTemplateId: item.formTemplateId, documentId: item.documentId };
  if (item.itemType === "FORM_TEMPLATE") return { itemType: item.itemType, itemId: item.itemId, formTemplateId: item.itemId };
  return { itemType: item.itemType, itemId: item.itemId };
}

/** Who may reassign or cancel a running chain: a member of the item's department (or document:read_all), and for a
 *  form template that applies to the whole organisation (or an org unit; no single department to be a member of)
 *  only an organisation-level role -- otherwise any department manager could take over a company-wide template. */
export async function assertCanAdministerItem(item: LoadedItem, user: CurrentUser): Promise<void> {
  if (item.departmentId) {
    if (hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL)) return;
    const memberships = await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] });
    if (!memberships.some((m) => m.departmentId === item.departmentId))
      throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "This item belongs to a department you are not a member of");
    return;
  }
  if (item.itemType === "FORM_TEMPLATE" && !hasOrgWideTemplateAuthority(user))
    throw new AppError(
      403,
      "ERR-FORM-TEMPLATE-ORG-SCOPE",
      "This form template applies to the whole organisation (or an organisation unit): only an organisation-level role can reassign or cancel its approval",
    );
}

export async function loadItem(
  itemType: ApprovalItemType,
  itemId: string,
  user: CurrentUser,
  tx?: SequelizeTransaction,
): Promise<LoadedItem> {
  if (itemType === "DOCUMENT") {
    const doc = await Document.findByPk(itemId, { transaction: tx });
    if (!doc || doc.deletedAt) throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
    requireDocumentAccess(doc, user);
    return {
      itemType,
      itemId,
      departmentId: await normalizeApprovalDepartmentId(user.tenantId, doc.departmentId ?? null, tx),
      documentTypeId: doc.documentTypeId ?? null,
      formTemplateId: null,
      orgUnitId: null,
      ownerId: doc.ownerId ?? null,
      title: doc.title,
      documentId: itemId,
    };
  }
  if (itemType === "FORM_TEMPLATE") {
    const tpl = await FormTemplate.findOne({ where: { id: itemId, tenantId: user.tenantId }, transaction: tx });
    if (!tpl) throw new AppError(404, "ERR-FORM-TEMPLATE-NOT-FOUND", "Form template not found");
    // A template scoped to a department is approved INSIDE that department (role steps are scoped to it); an org-unit
    // or tenant-wide template has no single department and is approved at organisation level (defaultStepsFor).
    return {
      itemType, itemId, departmentId: tpl.departmentId ?? null, documentTypeId: null, formTemplateId: null,
      orgUnitId: tpl.orgUnitId ?? null, ownerId: tpl.createdBy, title: tpl.name, documentId: null,
    };
  }
  if (itemType === "FORM_INSTANCE") {
    const instance = await FormInstance.findByPk(itemId, { transaction: tx });
    if (!instance) throw new AppError(404, "ERR-FORM-INSTANCE-NOT-FOUND", "Form instance not found");
    const doc = instance.documentId ? await Document.findByPk(instance.documentId, { transaction: tx }) : null;
    // Same guard as the DOCUMENT branch above — a form instance's document
    // that's been trashed must not still be actionable via decideStep/
    // resubmitToAudit (its chain is cancelled by trashService's cascade fix,
    // but without this check a stale in-flight request could still race it).
    if (!doc || doc.tenantId !== user.tenantId || doc.deletedAt)
      throw new AppError(404, "ERR-FORM-INSTANCE-NOT-FOUND", "Form instance not found");
    return {
      itemType,
      itemId,
      departmentId: await normalizeApprovalDepartmentId(user.tenantId, doc.departmentId ?? null, tx),
      documentTypeId: doc.documentTypeId ?? null,
      formTemplateId: instance.templateId ?? null,
      orgUnitId: null,
      ownerId: doc.ownerId ?? null,
      title: doc.title,
      documentId: doc.id,
    };
  }
  throw new AppError(422, "ERR-ITEM-TYPE-INVALID", `Unknown approval item type: ${itemType}`);
}

/** Document backing a FORM_INSTANCE (its lifecycle carrier). */
async function documentForItem(item: LoadedItem, tx?: SequelizeTransaction): Promise<Document | null> {
  if (item.itemType === "DOCUMENT") return Document.findByPk(item.itemId, { transaction: tx });
  if (item.itemType === "FORM_INSTANCE") {
    const instance = await FormInstance.findByPk(item.itemId, { transaction: tx });
    return instance?.documentId ? Document.findByPk(instance.documentId, { transaction: tx }) : null;
  }
  return null;
}

/** The document id whose ACL governs an item, or null for FORM_TEMPLATE. */
async function backingDocumentId(itemType: ApprovalItemType, itemId: string): Promise<string | null> {
  if (itemType === "DOCUMENT") return itemId;
  if (itemType === "FORM_INSTANCE") {
    const inst = await FormInstance.findByPk(itemId, { attributes: ["documentId"] });
    return inst?.documentId ?? null;
  }
  return null;
}

/**
 * H1: enforce per-document ACL for the chain READ endpoints. `loadItem` only
 * checks tenant equality, so without this a tenant member holding the
 * tenant-wide document:read permission but no ACL on a confidential document
 * could read its chain, reviewer comments, and named participants. FORM_TEMPLATE
 * has no backing document, so the tenant check in loadItem is the boundary.
 */
async function assertItemAclReadable(itemType: ApprovalItemType, itemId: string, user: CurrentUser): Promise<void> {
  const docId = await backingDocumentId(itemType, itemId);
  if (!docId) return;
  await assertACLAllow(
    user.userId,
    user.roles && user.roles.length > 0 ? user.roles : [user.role],
    user.tenantId,
    { resourceType: "document", resourceId: docId, permission: "document:read" },
    user.permissions,
  );
}

async function setItemStateOnSubmit(item: LoadedItem, tx: SequelizeTransaction) {
  const doc = await documentForItem(item, tx);
  if (doc) {
    validateTransition(doc.status, "IN_REVIEW");
    await doc.update({ status: "IN_REVIEW", approvalStatus: "IN_PROGRESS" }, { transaction: tx });
    return;
  }
  if (item.itemType === "FORM_TEMPLATE") {
    const tpl = await FormTemplate.findByPk(item.itemId, { transaction: tx });
    if (!tpl) return;
    if (!["draft", "pending_approval"].includes(tpl.status))
      throw new AppError(409, "ERR-FORM-TEMPLATE-STATE", `Template is ${tpl.status}, not submittable`);
    await tpl.update({ status: "pending_approval" }, { transaction: tx });
  }
}

async function setItemStateOnBounce(item: LoadedItem, kind: "CHANGES_REQUESTED" | "DECLINED", tx: SequelizeTransaction) {
  const doc = await documentForItem(item, tx);
  if (doc) {
    validateTransition(doc.status, kind);
    await doc.update({ status: kind, approvalStatus: "PENDING" }, { transaction: tx });
    return;
  }
  if (item.itemType === "FORM_TEMPLATE") {
    const tpl = await FormTemplate.findByPk(item.itemId, { transaction: tx });
    if (tpl) await tpl.update({ status: "draft" }, { transaction: tx });
  }
}

// ─── Templates (admin recipes, D1) ────────────────────────────────────────────

export async function listChainTemplates(user: CurrentUser, filters: { documentTypeId?: string; formTemplateId?: string; forFormTemplates?: boolean } = {}) {
  const where: Record<string, unknown> = { tenantId: user.tenantId };
  if (filters.documentTypeId) where.documentTypeId = filters.documentTypeId;
  if (filters.formTemplateId) where.formTemplateId = filters.formTemplateId;
  if (filters.forFormTemplates) where.forFormTemplates = true;
  return ApprovalChainTemplate.findAll({ where, order: [["createdAt", "DESC"]] });
}

/** Switch a recipe off. Chains already in flight keep the steps they were built with (the steps are copied at
 *  submit); future submissions fall back to the next less specific recipe, else the built-in default. */
export async function deactivateChainTemplate(id: string, user: CurrentUser) {
  const tpl = await ApprovalChainTemplate.findOne({ where: { id, tenantId: user.tenantId } });
  if (!tpl) throw new AppError(404, "ERR-TEMPLATE-NOT-FOUND", "Recipe not found");
  if (!tpl.isActive) return tpl;
  if (!hasOrgWideTemplateAuthority(user)) {
    if (!tpl.departmentId)
      throw new AppError(403, "ERR-TEMPLATE-SCOPE", "You can only change approval recipes scoped to a department you manage");
    await assertCanManageDepartment(user, tpl.departmentId);
  }
  await tpl.update({ isActive: false });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_TEMPLATE_DEACTIVATED,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { approvalChainTemplate: tpl.id, name: tpl.name, departmentId: tpl.departmentId, orgUnitId: tpl.orgUnitId },
  });
  return tpl;
}

export async function upsertChainTemplate(input: unknown, user: CurrentUser) {
  const data = templateSchema.parse(input);
  if ([data.documentTypeId, data.formTemplateId, data.forFormTemplates ? "form-templates" : null, data.isDefault ? "default" : null].filter(Boolean).length !== 1)
    throw new AppError(422, "ERR-TEMPLATE-TARGET", "Template must target exactly one of: a document type, a form template, the approval of form templates, or be the default for its scope");

  const steps: ApprovalTemplateStep[] = data.steps.map((s, i) => ({
    stepOrder: i + 1,
    stepType: s.stepType,
    assignedRole: s.assignedRole ?? null,
    assignedUserId: s.assignedUserId ?? null,
    locked: s.locked ?? false,
    slaHours: s.slaHours ?? null,
  }));
  if (steps[steps.length - 1]!.stepType !== "APPROVE")
    throw new AppError(422, "ERR-TEMPLATE-FINAL-STEP", "The final template step must be an APPROVE step");

  // The targets and the named assignees must belong to THIS tenant. Nothing
  // checked either: a template could be keyed to another tenant's document type
  // or form template, or name a user/role that can never act — and the mistake
  // only surfaced when somebody tried to submit against it.
  if (data.documentTypeId) {
    const docType = await DocumentType.findOne({ where: { id: data.documentTypeId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!docType) throw new AppError(422, "ERR-TEMPLATE-TARGET", "Document type not found in this tenant");
  }
  if (data.formTemplateId) {
    const formTpl = await FormTemplate.findOne({ where: { id: data.formTemplateId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!formTpl) throw new AppError(422, "ERR-TEMPLATE-TARGET", "Form template not found in this tenant");
  }
  // Scope: a department or an org unit of THIS tenant (never both). Organisation-level roles may scope or leave a
  // recipe tenant-wide; anyone else holding workflow:manage only for a department they manage.
  const scope = { departmentId: data.departmentId ?? null, orgUnitId: data.orgUnitId ?? null };
  if (scope.departmentId && scope.orgUnitId)
    throw new AppError(422, "ERR-TEMPLATE-SCOPE", "A recipe is scoped to a department or to an organisation unit, not both");
  if (scope.departmentId) {
    const dept = await Department.findOne({ where: { id: scope.departmentId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!dept) throw new AppError(422, "ERR-TEMPLATE-SCOPE", "Department not found in this tenant");
  }
  if (scope.orgUnitId) {
    const unit = await OrgUnit.findOne({ where: { id: scope.orgUnitId, tenantId: user.tenantId }, attributes: ["id"] });
    if (!unit) throw new AppError(422, "ERR-TEMPLATE-SCOPE", "Organisation unit not found in this tenant");
  }
  if (!hasOrgWideTemplateAuthority(user)) {
    if (!scope.departmentId)
      throw new AppError(403, "ERR-TEMPLATE-SCOPE", "You can only define approval recipes scoped to a department you manage");
    await assertCanManageDepartment(user, scope.departmentId);
  }
  for (const step of steps) {
    if (step.assignedUserId) await assertAssigneeInTenant(step.assignedUserId, user.tenantId);
    if (step.assignedRole === "PLATFORM_ADMIN")
      throw new AppError(422, "ERR-STEP-ROLE-INVALID", "That role cannot be used as an approver");
  }

  // One active template per target: deactivate any existing one, then create.
  const result = await runInTransaction(async (tx) => {
    await ApprovalChainTemplate.update(
      { isActive: false },
      {
        where: {
          tenantId: user.tenantId,
          ...(data.documentTypeId ? { documentTypeId: data.documentTypeId } : {}),
          ...(data.formTemplateId ? { formTemplateId: data.formTemplateId } : {}),
          ...(data.forFormTemplates ? { forFormTemplates: true } : {}),
          // The default recipe is identified by having none of the targets.
          ...(data.isDefault ? { documentTypeId: null, formTemplateId: null, forFormTemplates: false } : {}),
          departmentId: scope.departmentId,
          orgUnitId: scope.orgUnitId,
          isActive: true,
        },
        transaction: tx,
      },
    );
    return ApprovalChainTemplate.create(
      {
        tenantId: user.tenantId,
        documentTypeId: data.documentTypeId ?? null,
        formTemplateId: data.formTemplateId ?? null,
        forFormTemplates: data.forFormTemplates ?? false,
        departmentId: scope.departmentId,
        orgUnitId: scope.orgUnitId,
        name: data.name,
        steps,
        isActive: data.isActive ?? true,
      },
      { transaction: tx },
    );
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_EDIT,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { approvalChainTemplate: result.id, name: data.name, steps: steps.length, scope, forFormTemplates: data.forFormTemplates ?? false },
  });
  return result;
}

type RecipeScope = { departmentId: string | null; orgUnitId: string | null };

/** The recipe that applies to a department: one scoped to exactly that department, else one scoped to its org
 *  unit, else the tenant-wide one (audit item 6). A recipe scoped elsewhere never applies. */
function mostSpecificRecipe(rows: ApprovalChainTemplate[] | null | undefined, scope: RecipeScope): ApprovalChainTemplate | null {
  const list = rows ?? [];
  return (
    (scope.departmentId ? list.find((r) => r.departmentId === scope.departmentId) : undefined) ??
    (scope.orgUnitId ? list.find((r) => !r.departmentId && r.orgUnitId === scope.orgUnitId) : undefined) ??
    list.find((r) => !r.departmentId && !r.orgUnitId) ??
    null
  );
}

async function recipeScopeFor(item: LoadedItem, tenantId: string, tx?: SequelizeTransaction): Promise<RecipeScope> {
  let orgUnitId = item.orgUnitId ?? null;
  if (!orgUnitId && item.departmentId) {
    const dept = await Department.findOne({ where: { id: item.departmentId, tenantId }, attributes: ["orgUnitId"], transaction: tx });
    orgUnitId = dept?.orgUnitId ?? null;
  }
  return { departmentId: item.departmentId, orgUnitId };
}

/** Recipe for a document type / form template at a scope: the form template's own recipe wins over its document type's. */
export async function findChainRecipe(args: {
  tenantId: string;
  scope: RecipeScope;
  formTemplateId?: string | null;
  documentTypeId?: string | null;
  tx?: SequelizeTransaction;
}): Promise<ApprovalChainTemplate | null> {
  const { tenantId, scope, tx } = args;
  if (args.formTemplateId) {
    const rows = await ApprovalChainTemplate.findAll({ where: { tenantId, formTemplateId: args.formTemplateId, isActive: true }, transaction: tx });
    const hit = mostSpecificRecipe(rows, scope);
    if (hit) return hit;
  }
  if (args.documentTypeId) {
    const rows = await ApprovalChainTemplate.findAll({ where: { tenantId, documentTypeId: args.documentTypeId, isActive: true }, transaction: tx });
    const hit = mostSpecificRecipe(rows, scope);
    if (hit) return hit;
  }
  // Nothing targets this document type or form template: the scope's catch-all default recipe, if one was set
  // (department, then organisation unit, then the whole organisation).
  const defaults = await ApprovalChainTemplate.findAll({
    where: { tenantId, documentTypeId: null, formTemplateId: null, forFormTemplates: false, isActive: true },
    transaction: tx,
  });
  return mostSpecificRecipe(defaults, scope);
}

/** What a filled form of this template WOULD be routed through when filed under this department (used by the fill UI's prefill). */
export async function findFormInstanceRecipe(
  tenantId: string,
  departmentId: string,
  formTemplateId: string,
  documentTypeId: string | null,
): Promise<ApprovalChainTemplate | null> {
  const dept = await Department.findOne({ where: { id: departmentId, tenantId }, attributes: ["orgUnitId"] });
  return findChainRecipe({ tenantId, scope: { departmentId, orgUnitId: dept?.orgUnitId ?? null }, formTemplateId, documentTypeId });
}

/** Role that approves an organisation-wide form template when no recipe says otherwise. A department manager of an
 *  unrelated department must not be able to activate a company-wide template (audit E6). */
export const ORG_LEVEL_APPROVER_ROLE = "SYSTEM_ADMIN";

/** The chain used when no recipe applies: the head of the item's department; for a form template with no single
 *  department (tenant-wide or org-unit scope), an organisation-level approver. */
export function defaultStepsFor(item: Pick<LoadedItem, "itemType" | "departmentId">): ApprovalTemplateStep[] {
  const role = item.itemType === "FORM_TEMPLATE" && !item.departmentId ? ORG_LEVEL_APPROVER_ROLE : "DEPT_MANAGER";
  return [{ stepOrder: 1, stepType: "APPROVE", assignedRole: role, assignedUserId: null, locked: false, slaHours: null }];
}

async function findActiveTemplate(item: LoadedItem, tenantId: string, tx?: SequelizeTransaction) {
  const scope = await recipeScopeFor(item, tenantId, tx);
  if (item.itemType === "FORM_TEMPLATE") {
    const rows = await ApprovalChainTemplate.findAll({ where: { tenantId, forFormTemplates: true, isActive: true }, transaction: tx });
    return mostSpecificRecipe(rows, scope);
  }
  return findChainRecipe({
    tenantId,
    scope,
    formTemplateId: item.itemType === "FORM_INSTANCE" ? item.formTemplateId : null,
    documentTypeId: item.documentTypeId,
    tx,
  });
}

/** The pre-filled chain the author sees at submit (template steps, or the
 *  default single APPROVE to DEPT_MANAGER — same default as letters). */
export async function getSubmitPrefill(itemType: ApprovalItemType, itemId: string, user: CurrentUser) {
  const item = await loadItem(itemType, itemId, user);
  // H1: the submitter must be able to read the item, not merely be a tenant
  // member (owners hold document:read via the default ACL).
  await assertItemAclReadable(itemType, itemId, user);
  const template = await findActiveTemplate(item, user.tenantId);
  const steps: ApprovalTemplateStep[] = template?.steps?.length
    ? template.steps
    : defaultStepsFor(item);

  // H-UX-1: name the assigned approver, not just their role, so the submitter
  // knows exactly who each step is headed to before they confirm.
  const roleNames = [...new Set(steps.map((s) => s.assignedRole).filter(Boolean))] as string[];
  const byRole = await resolveRoleHolders(roleNames, user.tenantId, item.departmentId);
  const stepsWithHolders = steps.map((s) =>
    s.assignedRole ? { ...s, roleHolders: byRole.get(s.assignedRole) ?? [] } : s,
  );

  return { templateId: template?.id ?? null, templateName: template?.name ?? null, steps: stepsWithHolders };
}

// ─── Submit (D1) ──────────────────────────────────────────────────────────────

/**
 * Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #8: approvals never called
 * enqueueWebsocketEvent/emitDomainEvent at all — the frontend's
 * EVENT_TYPE_TO_QUERY_KEYS map (RealtimeBridge.tsx) has no entry for
 * ['approval-chain', ...] query keys either, so a second approver or the
 * submitter watching a chain saw no live update on submit/decide/reassign/
 * cancel until a remount or the 30s staleTime lapsed — the newest,
 * most business-critical feature area was also the one with the weakest
 * realtime support. Routed by departmentId when the item has one (documents/
 * form instances are department-scoped), falling back to the tenant admin
 * room otherwise (form templates have no department).
 */
export async function emitApprovalChainUpdated(
  itemType: ApprovalItemType,
  itemId: string,
  tenantId: string,
  departmentId: string | null | undefined,
  change: string,
  recipientUserIds?: string[],
) {
  try {
    const dedupedRecipients = recipientUserIds?.length
      ? Array.from(new Set(recipientUserIds))
      : undefined;
    await enqueueWebsocketEvent("APPROVAL_CHAIN.UPDATED", {
      documentId: itemType === "DOCUMENT" ? itemId : undefined,
      itemType,
      itemId,
      change,
      departmentId: departmentId ?? null,
      tenantId,
      recipientUserIds: dedupedRecipients,
    });
  } catch (e) {
    logger.error({ e }, "websocket enqueue failed");
  }
}

export async function submitForApproval(
  itemType: ApprovalItemType,
  itemId: string,
  input: unknown,
  user: CurrentUser,
) {
  const { steps: authorSteps } = submitSchema.parse(input ?? {});
  const item = await loadItem(itemType, itemId, user);

  // Self-service: the author submits their own item; approval:admin may submit any.
  if (item.ownerId && item.ownerId !== user.userId && !hasPermission(user, PERMISSIONS.APPROVAL_ADMIN))
    throw new AppError(403, "ERR-NOT-ITEM-OWNER", "Only the item's author (or an approval admin) can submit it");

  // approval:admin is a per-tenant permission held by every department manager, and loadItem only proves the item
  // is in the caller's tenant. Without this a manager of one department could submit ANOTHER department's draft by
  // id, name themselves as the approver, and be granted read access to it (grantChainParticipantAcl below).
  // getSubmitPrefill (the submit dialog's own first call) already applies the same read-ACL requirement.
  await assertItemAclReadable(itemType, itemId, user);

  const template = await findActiveTemplate(item, user.tenantId);
  const templateSteps: ApprovalTemplateStep[] = template?.steps ?? [];
  const lockedSteps = templateSteps.filter((s) => s.locked);

  // Author completion: they may swap/add/reorder UNLOCKED steps, but every
  // locked step must appear, unmodified, in its template-relative order (D1).
  const finalSteps = (authorSteps && authorSteps.length > 0)
    ? authorSteps
    : templateSteps.length > 0
      ? templateSteps.map((s) => ({
          stepType: s.stepType,
          assignedUserId: s.assignedUserId ?? undefined,
          assignedRole: s.assignedRole ?? undefined,
          slaHours: s.slaHours ?? undefined,
        }))
      : defaultStepsFor(item).map((s) => ({
          stepType: s.stepType,
          assignedRole: s.assignedRole ?? undefined,
          assignedUserId: undefined as string | undefined,
          slaHours: undefined as number | undefined,
        }));

  if (finalSteps[finalSteps.length - 1]!.stepType !== "APPROVE")
    throw new AppError(422, "ERR-CHAIN-FINAL-STEP", "The final step must be an APPROVE step");

  // Locked-step enforcement: match each locked template step to a submitted
  // step with the same type + assignee; order among locked steps must hold.
  let cursor = -1;
  for (const locked of lockedSteps) {
    const idx = finalSteps.findIndex(
      (s, i) =>
        i > cursor &&
        s.stepType === locked.stepType &&
        (s.assignedUserId ?? null) === (locked.assignedUserId ?? null) &&
        (s.assignedRole ?? null) === (locked.assignedRole ?? null),
    );
    if (idx === -1)
      throw new AppError(
        422,
        "ERR-CHAIN-LOCKED-STEP",
        `Mandatory step "${locked.stepType} → ${locked.assignedRole ?? locked.assignedUserId}" cannot be removed, changed, or reordered`,
      );
    cursor = idx;
  }

  // A named step addressed to the submitter or the item's author can never be
  // decided (decideStep refuses self-approval) — refuse it up front instead of
  // creating a chain that is stuck from the first step.
  for (const step of finalSteps) {
    if (step.assignedUserId && isAuthorOrSubmitter(step.assignedUserId, user.userId, item.ownerId))
      throw new AppError(422, "ERR-STEP-SELF-APPROVAL", "You cannot assign an approval step to the item's author or submitter");
  }

  for (const step of finalSteps)
    await assertStepIsActionable(step, user.tenantId, item.departmentId, ENGINE_STEP_RULES);

  const lockedKeys = new Set(
    lockedSteps.map((s) => `${s.stepType}|${s.assignedUserId ?? ""}|${s.assignedRole ?? ""}`),
  );

  const chain = await runSubmitTransaction();

  async function runSubmitTransaction() {
   try {
    return await runInTransaction(async (tx) => {
    // A live chain (IN_REVIEW) blocks resubmit; a suspended one (CHANGES_REQUESTED)
    // is superseded by cancelling it and starting fresh steps.
    const live = await ApprovalChain.findOne({
      where: { itemType, itemId, status: { [Op.in]: ["IN_REVIEW", "CHANGES_REQUESTED"] } },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (live?.status === "IN_REVIEW")
      throw new AppError(409, "ERR-CHAIN-ALREADY-RUNNING", "This item is already in review");
    if (live) await live.update({ status: "CANCELLED", completedAt: new Date() }, { transaction: tx });

    const created = await ApprovalChain.create(
      { tenantId: user.tenantId, itemType, itemId, status: "IN_REVIEW", submittedBy: user.userId },
      { transaction: tx },
    );
    for (let i = 0; i < finalSteps.length; i++) {
      const s = finalSteps[i]!;
      const dueAt = s.slaHours ? new Date(Date.now() + s.slaHours * 3_600_000) : null;
      await ApprovalStep.create(
        {
          tenantId: user.tenantId,
          chainId: created.id,
          stepOrder: i + 1,
          stepType: s.stepType,
          assignedUserId: s.assignedUserId ?? null,
          assignedRole: s.assignedRole ?? null,
          locked: lockedKeys.has(`${s.stepType}|${s.assignedUserId ?? ""}|${s.assignedRole ?? ""}`),
          slaHours: s.slaHours ?? null,
          dueAt: i === 0 ? dueAt : null,
          status: i === 0 ? "PENDING" : "WAITING",
        },
        { transaction: tx },
      );
    }
    // Every named assignee (and every assigned role) must be able to open the
    // item they have been routed, including from outside its department.
    await grantChainParticipantAcl(item.documentId, user.tenantId, user.userId, finalSteps, tx);

    await setItemStateOnSubmit(item, tx);
    return created;
    });
   } catch (err) {
     // M9: two concurrent submits (or a resubmit double-click) both observe
     // live=null under READ COMMITTED and both INSERT; the partial unique index
     // approval_chains_live_uniq blocks the loser. Map that raw DB violation to
     // the intended 409 instead of surfacing an unhandled 500.
     if (err instanceof UniqueConstraintError) {
       throw new AppError(409, "ERR-CHAIN-ALREADY-RUNNING", "This item is already in review");
     }
     throw err;
   }
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_CHAIN_SUBMITTED,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: { chainId: chain.id, ...itemRefs(item), steps: finalSteps.length, recipeId: template?.id ?? null },
  });
  const submitPendingRecipients = await notifyPendingStep(chain.id, user.tenantId, item.title, item.departmentId, item.documentId).catch(() => []);
  await emitApprovalChainUpdated(itemType, itemId, user.tenantId, item.departmentId, "submitted", [user.userId, ...submitPendingRecipients]);
  return getChain(itemType, itemId, user);
}

// ─── Decide (D3) ──────────────────────────────────────────────────────────────

export function isAuthorOrSubmitter(userId: string, submittedBy: string | null | undefined, ownerId: string | null | undefined): boolean {
  return userId === submittedBy || (!!ownerId && userId === ownerId);
}

/** Escalatees are department heads (or approval admins who read across departments); at decide time they must still be inside
 *  the item's department unless they read across departments. */
async function assertEscalateeInScope(item: LoadedItem, user: CurrentUser): Promise<void> {
  if (hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL)) return;
  const scopeDeptId = await normalizeApprovalDepartmentId(user.tenantId, item.departmentId);
  if (!scopeDeptId) return;
  const deptIds = await getUserDepartmentIds(user.tenantId, user.userId);
  if (!deptIds.includes(scopeDeptId))
    throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "This item belongs to a department you are not a member of");
}

async function lockChainInReview(chainId: string, tenantId: string, tx: SequelizeTransaction) {
  const locked = await ApprovalChain.findOne({
    where: { id: chainId, tenantId, status: "IN_REVIEW" },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!locked) throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "This chain is not in review");
  return locked;
}

/** Status-guarded step decision: the WHERE clause carries status='PENDING', so
 *  of two simultaneous deciders exactly one row-update wins; the loser 409s. */
async function guardedStepDecision(
  stepId: string,
  chainId: string,
  patch: Record<string, unknown>,
  tx: SequelizeTransaction,
) {
  const [updated] = await ApprovalStep.update(patch, {
    where: { id: stepId, chainId, status: "PENDING" },
    transaction: tx,
  });
  if (updated !== 1)
    throw new AppError(409, "ERR-STEP-ALREADY-DECIDED", "This step has already been decided");
}

export async function decideStep(chainId: string, stepId: string, input: unknown, user: CurrentUser) {
  const { decision, comment, auditorUserId } = decisionSchema.parse(input);

  const chain = await ApprovalChain.findOne({ where: { id: chainId, tenantId: user.tenantId } });
  if (!chain) throw new AppError(404, "ERR-CHAIN-NOT-FOUND", "Approval chain not found");
  if (chain.status !== "IN_REVIEW")
    throw new AppError(409, "ERR-CHAIN-STATE-INVALID", `Chain is not awaiting review (status ${chain.status})`);

  const step = await ApprovalStep.findOne({ where: { id: stepId, chainId } });
  if (!step) throw new AppError(404, "ERR-STEP-NOT-FOUND", "Approval step not found");
  if (step.status !== "PENDING")
    throw new AppError(409, "ERR-STEP-NOT-PENDING", "This step is not awaiting a decision");
  // An overdue step that escalated (escalation.service.ts) may also be decided by the people it escalated to.
  const assignedToUser = stepIsAssignedTo(step, user);
  const escalatedToUser = !assignedToUser && (step.escalatedToUserIds ?? []).includes(user.userId);
  if (!assignedToUser && !escalatedToUser)
    throw new AppError(403, "ERR-STEP-NOT-ASSIGNED", "This step is not assigned to you");
  if (!hasPermission(user, PERMISSIONS.APPROVAL_DECIDE))
    throw new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${PERMISSIONS.APPROVAL_DECIDE}`);

  const item = await loadItem(chain.itemType as ApprovalItemType, chain.itemId, user);

  // Separation of duties: whoever authored or submitted an item cannot approve
  // it. Nothing here enforced this — a department manager could upload, submit
  // (the default chain is a single APPROVE to DEPT_MANAGER) and approve their
  // own document, which makes the whole chain decorative. Requesting changes or
  // declining your own item stays allowed (it only sends it back to you). If
  // the author is the only qualified approver, an approval admin reassigns the
  // step to someone else (reassignStep) — that is the intended escape, not self-approval.
  if (decision === "APPROVE" && isAuthorOrSubmitter(user.userId, chain.submittedBy, item.ownerId)) {
    throw new AppError(
      403,
      "ERR-SELF-APPROVAL",
      `You submitted or authored this ${item.itemType === "DOCUMENT" ? "document" : "item"} and cannot approve it yourself — ask an approval admin to assign another approver`,
    );
  }

  // AUDIT-FINDINGS-2026-08-11 lifecycle sweep #2: legal hold blocked direct
  // edits (checkout, version upload, rollback, archive, publish, delete —
  // all via requireLegalHoldClear) but not approval-chain progression, so a
  // document could be placed on hold mid-review and still approve/decline
  // straight through — including into a signing ceremony that files a new
  // version, silently defeating the hold's purpose of freezing content.
  const itemDoc = await documentForItem(item);
  if (itemDoc) requireLegalHoldClear(itemDoc);

  // Role-assigned steps are department-scoped for document-backed items —
  // a Finance DEPT_MANAGER must not approve HR's document. Shared with
  // letters via stepRules.ts (R-08), which also normalizes UNCAT.
  await assertRoleStepDepartmentScope(step, user, user.tenantId, item.departmentId, ENGINE_STEP_RULES);
  // An escalatee is never wider than the item's own department (named steps are otherwise exempt from the scope check).
  if (escalatedToUser) await assertEscalateeInScope(item, user);

  if (decision === "REQUEST_CHANGES" || decision === "DECLINE") {
    // DECLINE requires a written reason (D3).
    if (decision === "DECLINE" && !comment?.trim())
      throw new AppError(422, "ERR-DECLINE-COMMENT-REQUIRED", "Declining requires a comment explaining why");

    const bounceStatus = decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "DECLINED";
    await runInTransaction(async (tx) => {
      const locked = await lockChainInReview(chainId, user.tenantId, tx);
      await guardedStepDecision(stepId, chainId,
        { status: bounceStatus, comment: comment ?? null, decidedBy: user.userId, decidedAt: new Date() }, tx);
      await ApprovalStep.update(
        { status: "CANCELLED" },
        { where: { chainId, status: "WAITING" }, transaction: tx },
      );
      await locked.update(
        { status: bounceStatus, completedAt: decision === "DECLINE" ? new Date() : null },
        { transaction: tx },
      );
      await setItemStateOnBounce(item, bounceStatus, tx);
    });

    await writeAuditLog({
      eventType: decision === "REQUEST_CHANGES"
        ? AUDIT_EVENTS.APPROVAL_STEP_CHANGES_REQUESTED
        : AUDIT_EVENTS.APPROVAL_STEP_DECLINED,
      userId: user.userId,
      userRole: user.role,
      documentId: auditDocumentId(item),
      actionDetails: { chainId, stepId, comment: comment ?? null, ...itemRefs(item) },
    });
    // Perf: fanOut and emitApprovalChainUpdated are independent side effects
    // (neither's result feeds the other) — batching them halves this tail's
    // round-trip count vs awaiting each in turn. The audit write above stays
    // sequential and first: it takes a per-tenant advisory lock for
    // hash-chain integrity, so parallelizing it wouldn't reduce latency
    // (Postgres serializes it anyway) and could reorder the audit narrative.
    await Promise.all([
      fanOut({
        type: decision === "REQUEST_CHANGES" ? "APPROVAL_CHANGES_REQUESTED" : "APPROVAL_DECLINED",
        tenantId: user.tenantId,
        recipientIds: [chain.submittedBy],
        severity: "WARNING",
        payload: { itemType: chain.itemType, itemId: chain.itemId, documentId: item.documentId ?? undefined, title: item.title, comment: comment ?? null },
      }).catch(() => {}),
      emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, decision.toLowerCase(), [chain.submittedBy]),
    ]);
    return getChain(chain.itemType as ApprovalItemType, chain.itemId, user);
  }

  // APPROVE — one transaction covers guard, advance, and (if final) completion.
  const outcome = await runInTransaction(async (tx) => {
    const locked = await lockChainInReview(chainId, user.tenantId, tx);
    await guardedStepDecision(stepId, chainId,
      { status: "APPROVED", comment: comment ?? null, decidedBy: user.userId, decidedAt: new Date() }, tx);

    const next = await ApprovalStep.findOne({
      where: { chainId, status: "WAITING" },
      order: [["stepOrder", "ASC"]],
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (next) {
      await next.update(
        { status: "PENDING", dueAt: next.slaHours ? new Date(Date.now() + next.slaHours * 3_600_000) : null },
        { transaction: tx },
      );
      return { finalized: false as const };
    }

    if (step.stepType !== "APPROVE")
      throw new AppError(409, "ERR-CHAIN-INVALID", "Final step must be an APPROVE step");

    await locked.update({ status: "APPROVED", completedAt: new Date() }, { transaction: tx });
    const routing = await completeItemApproval(item, user, auditorUserId ?? null, tx);
    return { finalized: true as const, routing };
  });

  if (!outcome.finalized) {
    // Perf: notifyPendingStep doesn't read anything the audit write produces
    // (and vice versa) — run them concurrently instead of back-to-back.
    // emitApprovalChainUpdated DOES need notifyPendingStep's recipient list,
    // so it stays sequential after this pair.
    const [, advancePendingRecipients] = await Promise.all([
      writeAuditLog({
        eventType: AUDIT_EVENTS.APPROVAL_STEP_APPROVED,
        userId: user.userId,
        userRole: user.role,
        documentId: auditDocumentId(item),
        actionDetails: { chainId, stepId, comment: comment ?? null, ...itemRefs(item) },
      }),
      notifyPendingStep(chainId, user.tenantId, item.title, item.departmentId, item.documentId).catch(() => []),
    ]);
    await emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, "approved", [chain.submittedBy, ...advancePendingRecipients]);
    return getChain(chain.itemType as ApprovalItemType, chain.itemId, user);
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_CHAIN_COMPLETED,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: { chainId, ...itemRefs(item), routing: outcome.routing },
  });
  // Activating a template version deprecated the versions it replaced (same transaction); record each one.
  for (const deprecatedId of outcome.routing.deprecatedTemplateIds ?? []) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
      userId: user.userId,
      userRole: user.role,
      actionDetails: {
        action: "form_template_status_changed", templateId: deprecatedId, from: "active", status: "deprecated",
        reason: "superseded_by_new_version", supersededBy: chain.itemId, tenantId: user.tenantId,
      },
    });
  }
  // The two writeAuditLog calls stay sequential (chain-completed, then
  // audit-stage-assigned as its consequence) — same reasoning as above:
  // per-tenant advisory lock means parallelizing them buys nothing, and it
  // preserves the audit narrative's order. Everything below is notification
  // fan-out that depends on neither audit write's result, so it's batched.
  if (outcome.routing.auditReviewId) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.AUDIT_STAGE_ASSIGNED,
      userId: user.userId,
      userRole: user.role,
      documentId: auditDocumentId(item),
      actionDetails: { reviewId: outcome.routing.auditReviewId, auditorUserId },
    });
  }
  const sideEffects: Promise<unknown>[] = [
    fanOut({
      type: "APPROVAL_COMPLETED",
      tenantId: user.tenantId,
      recipientIds: [chain.submittedBy],
      severity: "INFO",
      payload: { itemType: chain.itemType, itemId: chain.itemId, documentId: item.documentId ?? undefined, title: item.title },
    }).catch(() => {}),
    emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, "completed", [
      chain.submittedBy,
      ...(outcome.routing.auditReviewId && auditorUserId ? [auditorUserId] : []),
    ]),
  ];
  if (outcome.routing.auditReviewId) {
    sideEffects.push(
      fanOut({
        type: "AUDIT_STAGE_ASSIGNED",
        tenantId: user.tenantId,
        recipientIds: [auditorUserId!],
        severity: "INFO",
        payload: { itemType: chain.itemType, itemId: chain.itemId, documentId: item.documentId ?? undefined, title: item.title },
      }).catch(() => {}),
    );
  }
  await Promise.all(sideEffects);
  return getChain(chain.itemType as ApprovalItemType, chain.itemId, user);
}

/** Post-approval routing (runs inside the deciding transaction):
 *  audit stage (D5–D7) and signing ceremony (D8) per the type's policies. */
async function completeItemApproval(
  item: LoadedItem,
  finalApprover: CurrentUser,
  auditorUserId: string | null,
  tx: SequelizeTransaction,
): Promise<{ state: string; auditReviewId: string | null; deprecatedTemplateIds?: string[] }> {
  // FORM_TEMPLATE: approval makes the template active; approvedBy is real now. The older active version(s) of the same
  // template (same tenant + name) are deprecated in the SAME transaction, so there is never a moment with two active
  // versions accepting submissions (audit E1). Only OLDER versions: a newer one that was approved first stays active.
  if (item.itemType === "FORM_TEMPLATE") {
    const tpl = await FormTemplate.findByPk(item.itemId, { transaction: tx });
    const deprecatedTemplateIds: string[] = [];
    if (tpl) {
      const older = await FormTemplate.findAll({
        where: { tenantId: tpl.tenantId, name: tpl.name, status: "active", version: { [Op.lt]: tpl.version } },
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
      for (const previous of older ?? []) {
        await previous.update({ status: "deprecated" }, { transaction: tx });
        deprecatedTemplateIds.push(previous.id);
      }
      await tpl.update({ status: "active", approvedBy: finalApprover.userId }, { transaction: tx });
    }
    return { state: "active", auditReviewId: null, deprecatedTemplateIds };
  }

  const doc = await documentForItem(item, tx);
  if (!doc) return { state: "APPROVED", auditReviewId: null };

  const docType = item.documentTypeId
    ? await DocumentType.findByPk(item.documentTypeId, { transaction: tx })
    : null;
  // A FORM_INSTANCE is governed by its OWN template's policies, not the
  // shared tenant-wide FORM document type — otherwise every form template
  // would be forced to share one audit/signing setting regardless of what
  // the form is for.
  const formTemplate = item.itemType === "FORM_INSTANCE" && item.formTemplateId
    ? await FormTemplate.findByPk(item.formTemplateId, { transaction: tx })
    : null;
  const auditPolicy = formTemplate?.auditPolicy ?? docType?.auditPolicy ?? "never";
  const signingPolicy = formTemplate?.signingPolicy ?? docType?.signingPolicy ?? "none";

  // D5/D6: required → auditor pick is mandatory; optional → approver decides
  // by supplying one (or not); never → auditorUserId is rejected.
  let auditReviewId: string | null = null;
  if (auditPolicy === "required" && !auditorUserId)
    throw new AppError(422, "ERR-AUDITOR-REQUIRED",
      "This document type requires an audit: pick an auditor to complete approval");
  if (auditPolicy === "never" && auditorUserId)
    throw new AppError(422, "ERR-AUDIT-NOT-ALLOWED", "This document type does not use the audit stage");
  if (auditorUserId) {
    await assertAuditorIndependent(auditorUserId, item, finalApprover, tx);
    const review = await AuditStageReview.create(
      {
        tenantId: finalApprover.tenantId,
        itemType: "DOCUMENT",
        itemId: doc.id,
        auditorUserId,
        assignedBy: finalApprover.userId,
        status: "PENDING",
      },
      { transaction: tx },
    );
    auditReviewId = review.id;

    // The auditor must be able to open what they are auditing. This is the
    // path most likely to need the grant: assertAuditorIndependent positively
    // requires the auditor NOT to be the approver, so an independent auditor
    // is routinely from another department and therefore not covered by the
    // department-member snapshot grantDefaultDocumentAcl took at upload.
    await grantChainParticipantAcl(
      doc.id,
      finalApprover.tenantId,
      finalApprover.userId,
      [{ assignedUserId: auditorUserId }],
      tx,
    );
  }

  validateTransition(doc.status, "APPROVED");
  await doc.update({ status: "APPROVED", approvalStatus: "APPROVED" }, { transaction: tx });

  // A FORM_INSTANCE earns its reference number here, at final approval — the
  // equivalent moment to a letter's signature. Numbering at submit instead
  // would burn a number on every declined or abandoned submission, so the
  // gap-free series would develop gaps in normal use.
  //
  // Inside this transaction on purpose: the number and the approval that
  // justifies it commit together, or neither does. Dynamic import because
  // forms.service imports this module for the form-instance lifecycle.
  if (item.itemType === "FORM_INSTANCE") {
    const { allocateFormReferenceNumber } = await import("../forms/forms.service.js");
    await allocateFormReferenceNumber(item.itemId, finalApprover.tenantId, tx);
  }

  // D8: ceremony types publish live and await their signature request; audit
  // (if routed) happens after signing completes (see esigning completion
  // hook). Otherwise audit runs now.
  let state = "APPROVED";
  if (signingPolicy === "ceremony") {
    // A document that still needs its signing ceremony sent/completed is not
    // done yet, so it goes live (ACTIVE) rather than straight to ARCHIVED —
    // the opposite of the no-signing-no-audit case below. ACTIVE is already
    // a valid pre-ceremony state (DocumentStateMachine.ts's ACTIVE ->
    // PENDING_SIGNATURE edge, and esigning.service.ts's createSignatureRequest
    // already treats ACTIVE as signable): sendSignatureRequest moves it into
    // PENDING_SIGNATURE once the ceremony is actually created and sent, and
    // completion archives it (esigning.service.ts's ceremony-completion hook).
    validateTransition("APPROVED", "ACTIVE");
    await doc.update({ status: "ACTIVE" }, { transaction: tx });
    state = "ACTIVE";
  } else if (auditReviewId) {
    validateTransition("APPROVED", "PENDING_AUDIT");
    await doc.update({ status: "PENDING_AUDIT" }, { transaction: tx });
    state = "PENDING_AUDIT";
  } else {
    // Nothing further required for this document's type — this IS the
    // terminal clearance stage, so it goes straight to ARCHIVED rather than
    // parking at ACTIVE waiting for a separate manual archive step (same
    // default esigning.service.ts's ceremony-completion path already uses).
    // A records officer can bring it back with the Activate action
    // (ARCHIVED -> ACTIVE, documents.service.ts's activateDocument) if it's
    // needed live again.
    validateTransition("APPROVED", "ARCHIVED");
    const now = new Date();
    await doc.update({ status: "ARCHIVED", archivedAt: now }, { transaction: tx });
    await applyRetention(doc.id, tx);
    state = "ARCHIVED";
  }
  return { state, auditReviewId };
}

/** D6/D7 independence: an auditor cannot audit an item they drafted or
 *  approved, and must be an active tenant member holding audit-stage:decide. */
async function assertAuditorIndependent(
  auditorUserId: string,
  item: LoadedItem,
  finalApprover: CurrentUser,
  tx: SequelizeTransaction,
) {
  // The hidden platform administrator holds audit-stage:decide but can never be picked (reads as an unknown user).
  await assertNotHiddenUser(auditorUserId, finalApprover.userId);
  if (auditorUserId === item.ownerId)
    throw new AppError(422, "ERR-AUDITOR-CONFLICT", "The auditor cannot be the item's author");
  if (auditorUserId === finalApprover.userId)
    throw new AppError(422, "ERR-AUDITOR-CONFLICT", "The auditor cannot be an approver of this item");
  const decided = await ApprovalStep.findOne({
    include: [{ model: ApprovalChain, as: "chain", where: { itemType: item.itemType, itemId: item.itemId }, attributes: [] }],
    where: { decidedBy: auditorUserId },
    transaction: tx,
  });
  if (decided)
    throw new AppError(422, "ERR-AUDITOR-CONFLICT", "The auditor already decided a step on this item");

  const membership = await UserTenant.findOne({ where: { userId: auditorUserId, tenantId: finalApprover.tenantId }, transaction: tx });
  if (!membership)
    throw new AppError(422, "ERR-AUDITOR-INVALID", "Auditor is not a member of this tenant");
  const roleRows = await sequelize.query<{ name: string }>(
    `SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId`,
    { replacements: { userId: auditorUserId }, type: QueryTypes.SELECT, transaction: tx },
  );
  const auditorRolePerms = await Promise.all(
    roleRows.map((r) => getResolvedRolePermissions(r.name, finalApprover.tenantId)),
  );
  const canAudit = auditorRolePerms.some((perms) => perms.includes(PERMISSIONS.AUDIT_STAGE_DECIDE as never));
  if (!canAudit)
    throw new AppError(422, "ERR-AUDITOR-INVALID", "Selected user does not hold audit-stage:decide");
}


// ─── Reassign / cancel (recovery, rec §1.7) ───────────────────────────────────

export async function reassignStep(chainId: string, stepId: string, input: unknown, user: CurrentUser) {
  const data = reassignSchema.parse(input);
  if (!hasPermission(user, PERMISSIONS.APPROVAL_ADMIN))
    throw new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${PERMISSIONS.APPROVAL_ADMIN}`);

  const chain = await ApprovalChain.findOne({ where: { id: chainId, tenantId: user.tenantId } });
  if (!chain) throw new AppError(404, "ERR-CHAIN-NOT-FOUND", "Approval chain not found");
  const item = await loadItem(chain.itemType as ApprovalItemType, chain.itemId, user);

  // Platform audit finding (2026-08-14, HIGH, follow-up): APPROVAL_ADMIN is a
  // plain per-tenant permission held by DEPT_MANAGER, an ordinary
  // per-department role — this action had no check that the acting user's
  // own department covers the item being reassigned, unlike decideStep's
  // equivalent role-assigned-step check just above ("mirrors letters"). A
  // Finance DEPT_MANAGER could otherwise hijack an HR chain's step assignee
  // purely by knowing/guessing the chainId/stepId.
  await assertCanAdministerItem(item, user);

  await assertStepIsActionable(data, user.tenantId, item.departmentId, ENGINE_STEP_RULES);

  await runInTransaction(async (tx) => {
    const [updated] = await ApprovalStep.update(
      {
        assignedUserId: data.assignedUserId ?? null,
        assignedRole: data.assignedRole ?? null,
        // A reassignment replaces whoever held the step, including any delegation or escalation on it.
        delegatedBy: null,
        delegatedFromRole: null,
        delegatedAt: null,
        delegationReason: null,
        escalatedToUserIds: [],
      },
      { where: { id: stepId, chainId, status: { [Op.in]: ["PENDING", "WAITING"] } }, transaction: tx },
    );
    if (updated !== 1)
      throw new AppError(409, "ERR-STEP-NOT-REASSIGNABLE", "Only pending or waiting steps can be reassigned");

    // The new assignee is, by the same design as submit, allowed to be outside
    // the item's department — so they need the same read grant. Without this
    // a reassignment reproduces the AUTHZ_ACL_NO_ENTRY dead end exactly.
    // The previous assignee's grant is deliberately left in place: it is
    // read-only, they may legitimately still need to see what they handled,
    // and revoking it here would race a concurrent reassign back to them.
    await grantChainParticipantAcl(item.documentId, user.tenantId, user.userId, [data], tx);
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_STEP_REASSIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: { chainId, stepId, ...data },
  });
  const reassignPendingRecipients = await notifyPendingStep(chainId, user.tenantId, item.title, item.departmentId, item.documentId).catch(() => []);
  await emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, "reassigned", [chain.submittedBy, ...reassignPendingRecipients]);
  return getChain(chain.itemType as ApprovalItemType, chain.itemId, user);
}

export async function cancelChain(chainId: string, reason: string | undefined, user: CurrentUser) {
  if (!hasPermission(user, PERMISSIONS.APPROVAL_ADMIN))
    throw new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${PERMISSIONS.APPROVAL_ADMIN}`);
  if (!reason || reason.trim().length < 10)
    throw new AppError(422, "ERR-CANCEL-REASON-REQUIRED", "Cancelling a running chain requires a reason (≥10 chars)");

  const chain = await ApprovalChain.findOne({ where: { id: chainId, tenantId: user.tenantId } });
  if (!chain) throw new AppError(404, "ERR-CHAIN-NOT-FOUND", "Approval chain not found");
  const item = await loadItem(chain.itemType as ApprovalItemType, chain.itemId, user);

  // Platform audit finding (2026-08-14, HIGH, follow-up): same gap as
  // reassignStep just above — APPROVAL_ADMIN is a plain per-tenant
  // permission, so without this a Finance DEPT_MANAGER could cancel an HR
  // chain outright (reverting the document to DRAFT) purely by knowing/
  // guessing the chainId.
  await assertCanAdministerItem(item, user);

  await runInTransaction(async (tx) => {
    const locked = await ApprovalChain.findOne({
      where: { id: chainId, tenantId: user.tenantId, status: { [Op.in]: ["IN_REVIEW", "CHANGES_REQUESTED"] } },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked) throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "Chain is not cancellable");
    await ApprovalStep.update(
      { status: "CANCELLED" },
      { where: { chainId, status: { [Op.in]: ["PENDING", "WAITING"] } }, transaction: tx },
    );
    await locked.update({ status: "CANCELLED", completedAt: new Date() }, { transaction: tx });
    const doc = await documentForItem(item, tx);
    if (doc && doc.status === "IN_REVIEW") {
      await doc.update({ status: "DRAFT", approvalStatus: "PENDING" }, { transaction: tx });
    } else if (item.itemType === "FORM_TEMPLATE") {
      const tpl = await FormTemplate.findByPk(item.itemId, { transaction: tx });
      if (tpl && tpl.status === "pending_approval") await tpl.update({ status: "draft" }, { transaction: tx });
    }
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_CHAIN_CANCELLED,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: { chainId, reason },
  });
  // L10: the submitter used to learn about an admin cancellation only by
  // noticing their item quietly vanish from My Work — tell them, with the reason.
  await fanOut({
    type: "APPROVAL_CANCELLED",
    tenantId: user.tenantId,
    recipientIds: [chain.submittedBy],
    severity: "WARNING",
    payload: { itemType: chain.itemType, itemId: chain.itemId, documentId: item.documentId ?? undefined, title: item.title, reason },
  }).catch(() => {});
  await emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, "cancelled", [chain.submittedBy]);
  return { success: true };
}

// ─── Read models ──────────────────────────────────────────────────────────────

export const userAttrs = ["id", "firstName", "lastName", "email"];

type UserSummary = { id: string; firstName: string; lastName: string; email: string };

/** Resolve current holders of each given role, scoped to tenant + active users
 *  and — when `departmentId` is given — to members of that department too.
 *  Shared by chain-step display (getChain) and submit-time name resolution
 *  (getSubmitPrefill / listRoleHolders) so a role-assigned step always shows
 *  who it's actually waiting on, not just a role label.
 *
 *  Department scoping matters for more than display: getChain also treats
 *  everyone in the returned list as a chain "participant" allowed to view it
 *  without a document:read ACL check (H1). Before this, that list was always
 *  tenant-wide, so any DEPT_MANAGER anywhere in the tenant could load and
 *  preview a chain/document belonging to a department they aren't a member
 *  of — the same tenant-wide role-holder gap decideStep already guards
 *  against at decision time (ERR-STEP-DEPT-SCOPE), just never applied on the
 *  read side (My Work, notifications, "current holders" display). */
export async function resolveRoleHolders(
  roleNames: string[],
  tenantId: string,
  departmentId: string | null = null,
): Promise<Map<string, UserSummary[]>> {
  const byRole = new Map<string, UserSummary[]>();
  if (roleNames.length === 0) return byRole;
  const deptScoped = Boolean(departmentId);
  const holders = await sequelize.query<{ role_name: string; id: string; first_name: string; last_name: string; email: string }>(
    `SELECT r.name AS role_name, u.id, u.first_name, u.last_name, u.email
     FROM user_roles ur
     INNER JOIN roles r ON r.id = ur.role_id AND r.name IN (:roleNames)
     INNER JOIN users u ON u.id = ur.user_id AND u.is_active = true
     INNER JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = :tenantId
     ${deptScoped ? "INNER JOIN user_departments ud ON ud.user_id = u.id AND ud.department_id = :departmentId" : ""}
     WHERE ${notPlatformAdminSql("u.id")}`,
    { replacements: { roleNames, tenantId, departmentId }, type: QueryTypes.SELECT },
  );
  for (const h of holders) {
    const list = byRole.get(h.role_name) ?? [];
    list.push({ id: h.id, firstName: h.first_name, lastName: h.last_name, email: h.email });
    byRole.set(h.role_name, list);
  }
  return byRole;
}

/** Named-approver lookup for the submit-for-approval UI (H-UX-1): before a
 *  submitter confirms who a role step is "waiting on", they see the actual
 *  current holders of that role, not just the role label.
 *
 *  `departmentId` is optional but strongly preferred, because a role step is
 *  department-scoped at DECIDE time (assertStepIsActionable /
 *  ERR-STEP-DEPT-SCOPE). Answering tenant-wide reports "currently held by …"
 *  for a role nobody holds in the item's own department — the forms fill dialog
 *  did exactly that, told the author every role was staffed everywhere, and the
 *  author only discovered otherwise when the engine refused the chain after the
 *  PDF had already been rendered and the instance filed. Narrowing only; it can
 *  never reveal a holder the tenant-wide answer would have hidden. */
export async function listRoleHolders(user: CurrentUser, roles: string[], departmentId?: string) {
  const uniqueRoles = [...new Set(roles.filter(Boolean))];
  const byRole = await resolveRoleHolders(uniqueRoles, user.tenantId, departmentId ?? null);
  const result: Record<string, UserSummary[]> = {};
  for (const r of uniqueRoles) result[r] = byRole.get(r) ?? [];
  return result;
}

/** Full chain view for an item — D1's named-person visibility: role steps also
 *  resolve the CURRENT active holders of the role, so the author always sees
 *  people, not just a role code. Visibility = item visibility (D9): loadItem
 *  performs the item's own access check. */
type ChainStepPlain = {
  assignedUserId?: string | null; assignedUser?: unknown; decidedBy?: string | null; decider?: unknown;
  delegatedBy?: string | null; escalatedToUserIds?: string[]; escalatedToUsers?: unknown; delegatedByUser?: unknown;
  assignedRole?: string | null;
};
type ChainPlain = { submittedBy?: string | null; submitter?: unknown; steps?: ChainStepPlain[] };

/** The hidden platform administrator never appears in a chain view (shared/platformAdmin.ts): wherever the account is
 *  the submitter, assignee, decider, delegator or an escalatee it reads as absent, never as a name (audit E4). */
export function redactChainUsers(plain: ChainPlain, hidden: Set<string>): void {
  if (hidden.size === 0) return;
  if (plain.submittedBy && hidden.has(plain.submittedBy)) { plain.submittedBy = null; plain.submitter = null; }
  for (const s of plain.steps ?? []) {
    if (s.assignedUserId && hidden.has(s.assignedUserId)) { s.assignedUserId = null; s.assignedUser = null; }
    if (s.decidedBy && hidden.has(s.decidedBy)) { s.decidedBy = null; s.decider = null; }
    if (s.delegatedBy && hidden.has(s.delegatedBy)) s.delegatedBy = null;
    if (Array.isArray(s.escalatedToUserIds)) s.escalatedToUserIds = s.escalatedToUserIds.filter((id) => !hidden.has(id));
  }
}

function redactAuditReview(r: Record<string, unknown>, hidden: Set<string>): Record<string, unknown> {
  if (hidden.size === 0) return r;
  const out = { ...r };
  if (typeof out.auditorUserId === "string" && hidden.has(out.auditorUserId)) { out.auditorUserId = null; out.auditor = null; }
  if (typeof out.assignedBy === "string" && hidden.has(out.assignedBy)) { out.assignedBy = null; out.assigner = null; }
  return out;
}

/** Name the people a step was delegated by / escalated to, so the chain view can show them. */
async function attachDelegationEscalationUsers(steps: ChainStepPlain[], hidden: Set<string>): Promise<void> {
  const ids = new Set<string>();
  for (const s of steps) {
    for (const id of s.escalatedToUserIds ?? []) ids.add(id);
    if (s.delegatedBy) ids.add(s.delegatedBy);
  }
  for (const id of hidden) ids.delete(id);
  if (ids.size === 0) return;
  const users = await User.findAll({ where: { id: { [Op.in]: [...ids] } }, attributes: userAttrs, raw: true });
  const byId = new Map((users as unknown as UserSummary[]).map((u) => [u.id, u]));
  for (const s of steps) {
    s.escalatedToUsers = (s.escalatedToUserIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (s.delegatedBy) s.delegatedByUser = byId.get(s.delegatedBy) ?? null;
  }
}

export async function getChain(itemType: ApprovalItemType, itemId: string, user: CurrentUser) {
  const item = await loadItem(itemType, itemId, user);
  const chain = await ApprovalChain.findOne({
    where: { itemType, itemId, tenantId: user.tenantId },
    order: [["createdAt", "DESC"]],
    include: [
      { model: User, as: "submitter", attributes: userAttrs },
      {
        model: ApprovalStep,
        as: "steps",
        separate: true,
        order: [["stepOrder", "ASC"]],
        include: [
          { model: User, as: "assignedUser", attributes: userAttrs },
          { model: User, as: "decider", attributes: userAttrs },
        ],
      },
    ],
  });
  if (!chain) return null;

  const plain = chain.get({ plain: true }) as Record<string, unknown> & {
    steps?: Array<Record<string, unknown> & { assignedRole: string | null }>;
  };
  const hidden = new Set(await hiddenUserIds(user.userId));
  redactChainUsers(plain as unknown as ChainPlain, hidden);
  await attachDelegationEscalationUsers((plain.steps ?? []) as unknown as ChainStepPlain[], hidden);
  // Resolve current role holders for role-assigned steps.
  const roleNames = [...new Set((plain.steps ?? []).map((s) => s.assignedRole).filter(Boolean))] as string[];
  const byRole = await resolveRoleHolders(roleNames, user.tenantId, item.departmentId);
  for (const s of plain.steps ?? []) {
    if (s.assignedRole) (s as Record<string, unknown>).roleHolders = byRole.get(s.assignedRole) ?? [];
  }

  const steps = plain.steps ?? [];

  // H1: chain visibility. A participant (submitter, any step assignee/decider,
  // a current holder of a role step, or the assigned auditor) may always view
  // the chain they are part of even without a document:read ACL. Everyone else
  // must pass the per-document ACL — tenant membership alone is not enough.
  const participantIds = new Set<string>();
  const submitter = (plain as { submitter?: { id?: string } }).submitter;
  if (submitter?.id) participantIds.add(submitter.id);
  for (const s of steps) {
    const assignedUser = (s as { assignedUser?: { id?: string } }).assignedUser;
    const decider = (s as { decider?: { id?: string } }).decider;
    if (assignedUser?.id) participantIds.add(assignedUser.id);
    if (decider?.id) participantIds.add(decider.id);
    for (const h of ((s as { roleHolders?: Array<{ id: string }> }).roleHolders ?? [])) participantIds.add(h.id);
    // Whoever a step was delegated by or escalated to stays a participant of the chain they acted in.
    for (const id of ((s as { escalatedToUserIds?: string[] }).escalatedToUserIds ?? [])) participantIds.add(id);
    const delegatedBy = (s as { delegatedBy?: string | null }).delegatedBy;
    if (delegatedBy) participantIds.add(delegatedBy);
  }
  // Full audit-stage history (not just the latest): a FLAG-then-resubmit
  // cycle creates a fresh row each time (resubmitToAudit), so the route view
  // needs every cycle, oldest first, each with the auditor/assigner's name.
  // Audit-stage reviews are keyed by the BACKING DOCUMENT (itemType DOCUMENT) for form instances as well: the audit
  // machinery (decide, resubmit, reassign, My Work) all works on document ids. They were looked up here by
  // FORM_INSTANCE, so a form's chain view never listed its audit reviews (audit E3).
  const auditItemType = itemType === "FORM_INSTANCE" ? "DOCUMENT" : itemType;
  const auditItemId = itemType === "FORM_INSTANCE" ? item.documentId ?? itemId : itemId;
  const auditReviews = await AuditStageReview.findAll({
    where: { itemType: auditItemType, itemId: auditItemId, tenantId: user.tenantId },
    order: [["createdAt", "ASC"]],
    include: [
      { model: User, as: "auditor", attributes: userAttrs },
      { model: User, as: "assigner", attributes: userAttrs },
    ],
  });
  for (const r of auditReviews) {
    if (r.auditorUserId) participantIds.add(r.auditorUserId);
    if (r.assignedBy) participantIds.add(r.assignedBy);
  }

  if (!participantIds.has(user.userId)) {
    await assertItemAclReadable(itemType, itemId, user);
    // Live-verified gap (2026-08-27 re-audit): assertItemAclReadable alone
    // isn't enough proof this caller belongs to the item's department —
    // grantDefaultDocumentAcl (documents.service.ts) grants document:read to
    // DEPT_MANAGER/APPROVER/AUDITOR/etc. TENANT-WIDE on every document, not
    // scoped to their own department. Without this, a DEPT_MANAGER outside
    // the item's department could still open its Workflow tab, see
    // themselves listed as a "current holder", and only discover they can't
    // act after clicking Approve — reproducing the exact confusing
    // ERR-STEP-DEPT-SCOPE round-trip the department-scoping fix (this same
    // file's resolveRoleHolders/listMyPendingSteps) was meant to close
    // everywhere. Mirrors decideStep's own department check; deliberately
    // does NOT touch document-content visibility (Browse/Search/download),
    // which is a separate, broader, pre-existing ACL decision out of scope
    // here — this only tightens who may see the approval WORKFLOW.
    if (item.departmentId && !hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL)) {
      const memberships = await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] });
      if (!memberships.some((m) => m.departmentId === item.departmentId)) {
        throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "This item belongs to a department you are not a member of");
      }
    }
  }

  const done = steps.filter((s) => s.status === "APPROVED").length;
  return {
    ...plain,
    progress: { done, total: steps.length },
    auditReviews: auditReviews.map((r) => redactAuditReview(r.get({ plain: true }) as Record<string, unknown>, hidden)),
  };
}

/** UX gap: getChain() only ever returns the single newest ApprovalChain row
 *  (findOne, createdAt DESC) — a CANCELLED chain, or one superseded by a
 *  fresh resubmission after DECLINE/CHANGES_REQUESTED, has no way to be seen
 *  again: no endpoint returned it, so the UI had nothing to render even
 *  though the row (who declined it, why, when) is still sitting in the DB.
 *  This returns every chain an item has ever had, oldest first, so
 *  "previous submissions" can render as history instead of silently
 *  vanishing. Simpler visibility rule than getChain's participant-bypass
 *  (H1): history is common enough, and superseded chains obscure enough,
 *  that requiring the item's own read ACL for all callers is the right
 *  tradeoff rather than re-deriving participant sets per historical chain. */
export async function getChainHistory(itemType: ApprovalItemType, itemId: string, user: CurrentUser) {
  await loadItem(itemType, itemId, user);
  await assertItemAclReadable(itemType, itemId, user);

  const chains = await ApprovalChain.findAll({
    where: { itemType, itemId, tenantId: user.tenantId },
    order: [["createdAt", "ASC"]],
    include: [
      { model: User, as: "submitter", attributes: userAttrs },
      {
        model: ApprovalStep,
        as: "steps",
        separate: true,
        order: [["stepOrder", "ASC"]],
        include: [
          { model: User, as: "assignedUser", attributes: userAttrs },
          { model: User, as: "decider", attributes: userAttrs },
        ],
      },
    ],
  });

  const hidden = new Set(await hiddenUserIds(user.userId));
  return chains.map((c) => {
    const plain = c.get({ plain: true }) as Record<string, unknown> & { steps?: Array<Record<string, unknown>> };
    redactChainUsers(plain as unknown as ChainPlain, hidden);
    const steps = plain.steps ?? [];
    const done = steps.filter((s) => s.status === "APPROVED").length;
    return { ...plain, progress: { done, total: steps.length } };
  });
}

/** Resolve who the chain is currently waiting on: the named assignee, or
 *  every current holder of the assigned role. Shared by notifyPendingStep
 *  (email/in-app notification) and emitApprovalChainUpdated (realtime room
 *  routing) so both reach the actual assignee, not just their department. */
async function resolvePendingStepRecipients(chainId: string, tenantId: string, departmentId: string | null): Promise<string[]> {
  const pending = await ApprovalStep.findOne({
    where: { chainId, status: "PENDING" },
    order: [["stepOrder", "ASC"]],
  });
  if (!pending) return [];
  if (pending.assignedUserId) return [pending.assignedUserId];
  if (pending.assignedRole) {
    const deptScoped = Boolean(departmentId);
    const holders = await sequelize.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id AND r.name = :roleName
       INNER JOIN users u ON u.id = ur.user_id AND u.is_active = true
       INNER JOIN user_tenants ut ON ut.user_id = ur.user_id AND ut.tenant_id = :tenantId
       ${deptScoped ? "INNER JOIN user_departments ud ON ud.user_id = ur.user_id AND ud.department_id = :departmentId" : ""}
       WHERE ${notPlatformAdminSql("ur.user_id")}`,
      { replacements: { roleName: pending.assignedRole, tenantId, departmentId }, type: QueryTypes.SELECT },
    );
    return holders.map((h) => h.user_id);
  }
  return [];
}

/** Notify whoever the chain is now waiting on. Returns the recipient ids so
 *  callers can also route a realtime event straight to them. Department-
 *  scoped (see resolveRoleHolders) so a role-assigned step for a
 *  department-owned item only notifies members of that department, not
 *  every tenant-wide holder of the role — the same gap that let a chain's
 *  "current holders" list and My Work queue surface work a user had no real
 *  access to. */
export async function notifyPendingStep(chainId: string, tenantId: string, title: string, departmentId: string | null, documentId?: string | null): Promise<string[]> {
  const recipientIds = await resolvePendingStepRecipients(chainId, tenantId, departmentId);
  if (recipientIds.length === 0) return [];

  const pending = await ApprovalStep.findOne({
    where: { chainId, status: "PENDING" },
    order: [["stepOrder", "ASC"]],
  });
  if (!pending) return recipientIds;

  const chain = await ApprovalChain.findByPk(chainId);
  await fanOut({
    type: "APPROVAL_STEP_PENDING",
    tenantId,
    recipientIds,
    severity: "INFO",
    payload: {
      chainId,
      stepId: pending.id,
      stepType: pending.stepType,
      itemType: chain?.itemType ?? null,
      itemId: chain?.itemId ?? null,
      title,
      // Explicit so a FORM_INSTANCE notification deep-links to its filed document, not just to My Work.
      documentId: documentId ?? undefined,
      dueAt: pending.dueAt?.toISOString() ?? null,
    },
  });
  return recipientIds;
}

/** Every PENDING step assigned to me (named or via my roles) — the Approvals
 *  queue of the My Work inbox. */
/**
 * Ceiling on every one of the four My Work queues. Not a page size — these
 * queues are deliberately unpaginated summary inboxes — just the point past
 * which "everything waiting on you" has stopped being actionable and starts
 * being a denial-of-service vector against the API process.
 */
export const MY_WORK_QUEUE_CAP = 200;

export async function listMyPendingSteps(user: CurrentUser) {
  const roles = user.roles ?? [user.role];

  // Department scoping (mirrors decideStep's ERR-STEP-DEPT-SCOPE check): a
  // role-assigned step for a department-owned item only belongs in this
  // user's queue if they're actually a member of that department. Before
  // this, a role match alone (e.g. any DEPT_MANAGER tenant-wide) was enough
  // to surface the task here — the user could see it and get notified about
  // it, then hit ERR-STEP-DEPT-SCOPE the moment they tried to act on it.
  // Fetched once per call, not per step, since it's the same acting user.
  const canBypassDeptScope = hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL);
  const myDepartmentIds = canBypassDeptScope
    ? null
    : new Set(
        (await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] })).map(
          (m) => m.departmentId,
        ),
      );

  const steps = await ApprovalStep.findAll({
    where: {
      status: "PENDING",
      [Op.or]: [
        { assignedUserId: user.userId },
        { assignedRole: { [Op.in]: roles } },
        // Overdue steps that escalated to me (escalation.service.ts).
        { escalatedToUserIds: { [Op.contains]: [user.userId] } },
      ],
    },
    include: [
      {
        model: ApprovalChain,
        as: "chain",
        where: { tenantId: user.tenantId, status: "IN_REVIEW" },
        include: [{ model: User, as: "submitter", attributes: userAttrs }],
      },
    ],
    // My Work is a queue people check repeatedly — newest-first surfaces
    // what just landed on them instead of burying it under everything older.
    order: [["createdAt", "DESC"]],
    // Bounded. This is the hottest query in the system: GET /approvals/my/work
    // wraps it, and EVERY signed-in user polls that endpoint (the sidebar
    // badge on a 30 s staleTime, the My Work page on a 60 s interval). It
    // used to be unbounded, so a broadly-held role in a busy tenant pulled
    // every pending step in the tenant into memory — and then did the
    // per-step title/department work below over all of them — once per user
    // per poll. The e-sign queue this is merged with in getMyWork has been
    // capped at 100 all along; MY_WORK_QUEUE_CAP is the same idea, and the
    // sidebar badge already renders anything over 99 as "99+", so the cap is
    // not even visible at the point where it starts to apply.
    limit: MY_WORK_QUEUE_CAP,
  });

  // Attach item titles (documents cover DOCUMENT + FORM_INSTANCE lifecycles).
  // FIX: this used to call loadItem() + documentForItem() per step — each a
  // fresh Document.findByPk (and, for FORM_INSTANCE, a FormInstance.findByPk
  // too) — sequentially, one step at a time (up to 4 round-trips/step).
  // Batch-load the backing rows for the two common item types up front.
  const chainsByStep = steps.map((step) => (step as ApprovalStep & { chain?: ApprovalChain }).chain!);
  const documentItemIds = chainsByStep.filter((c) => c.itemType === "DOCUMENT").map((c) => c.itemId);
  const formInstanceItemIds = chainsByStep.filter((c) => c.itemType === "FORM_INSTANCE").map((c) => c.itemId);

  const [directDocs, formInstances] = await Promise.all([
    documentItemIds.length ? Document.findAll({ where: { id: { [Op.in]: documentItemIds } } }) : Promise.resolve([] as Document[]),
    formInstanceItemIds.length ? FormInstance.findAll({ where: { id: { [Op.in]: formInstanceItemIds } } }) : Promise.resolve([] as FormInstance[]),
  ]);
  const docsById = new Map(directDocs.map((d) => [d.id, d]));
  const formInstanceDocIds = formInstances.map((fi) => fi.documentId).filter((id): id is string => Boolean(id));
  const formInstanceDocs = formInstanceDocIds.length
    ? await Document.findAll({ where: { id: { [Op.in]: formInstanceDocIds } } })
    : [];
  for (const d of formInstanceDocs) docsById.set(d.id, d);
  const formInstancesById = new Map(formInstances.map((fi) => [fi.id, fi]));

  // Batch the UNCAT-department check the loop below needs (was previously
  // an awaited normalizeApprovalDepartmentId() call PER STEP — a real N+1
  // regression on top of the batching this same function already does
  // above for its Document/FormInstance lookups; a user with many pending
  // steps across departments hit one Department.findOne per step instead of
  // one query total). Every department this call could possibly need to
  // normalize is already known from docsById at this point.
  const candidateDeptIds = [...new Set([...docsById.values()].map((d) => d.departmentId).filter((id): id is string => Boolean(id)))];
  const uncatDeptIds = candidateDeptIds.length
    ? new Set(
        (await Department.findAll({ where: { id: { [Op.in]: candidateDeptIds }, tenantId: user.tenantId, code: "UNCAT" }, attributes: ["id"] })).map(
          (d) => d.id,
        ),
      )
    : new Set<string>();

  const hiddenIds = new Set(await hiddenUserIds(user.userId));
  const results = [] as Array<Record<string, unknown>>;
  for (const step of steps) {
    const chain = (step as ApprovalStep & { chain?: ApprovalChain }).chain!;
    let title: string | null = null;
    let documentId: string | null = null;
    try {
      if (chain.itemType === "DOCUMENT") {
        const doc = docsById.get(chain.itemId);
        if (!doc || doc.deletedAt) throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
        requireDocumentAccess(doc, user);
        if (step.assignedRole && !step.assignedUserId && doc.departmentId && myDepartmentIds && !myDepartmentIds.has(doc.departmentId)) {
          const normalized = uncatDeptIds.has(doc.departmentId) ? null : doc.departmentId;
          if (normalized && !myDepartmentIds.has(normalized)) throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "Not a member of this item's department");
        }
        title = doc.title;
        documentId = doc.id;
      } else if (chain.itemType === "FORM_INSTANCE") {
        const instance = formInstancesById.get(chain.itemId);
        if (!instance) throw new AppError(404, "ERR-FORM-INSTANCE-NOT-FOUND", "Form instance not found");
        const doc = instance.documentId ? docsById.get(instance.documentId) : null;
        // Same trashed-document guard as the DOCUMENT branch above — a
        // trashed form instance's document must not keep surfacing as a
        // pending step in "My Work" (its chain is cancelled by trashService's
        // cascade fix, but a stale step row could otherwise still render).
        if (!doc || doc.tenantId !== user.tenantId || doc.deletedAt) throw new AppError(404, "ERR-FORM-INSTANCE-NOT-FOUND", "Form instance not found");
        if (step.assignedRole && !step.assignedUserId && doc.departmentId && myDepartmentIds && !myDepartmentIds.has(doc.departmentId)) {
          const normalized = uncatDeptIds.has(doc.departmentId) ? null : doc.departmentId;
          if (normalized && !myDepartmentIds.has(normalized)) throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "Not a member of this item's department");
        }
        title = doc.title;
        documentId = doc.id;
      } else {
        // FORM_TEMPLATE (rare, no backing document to batch) — original per-item lookup.
        const item = await loadItem(chain.itemType as ApprovalItemType, chain.itemId, user);
        title = item.title;
        const doc = await documentForItem(item);
        documentId = doc?.id ?? null;
      }
    } catch {
      continue; // items the user can't read don't appear in their queue
    }
    const plainStep = step.get({ plain: true }) as Record<string, unknown> & { chain?: ChainPlain };
    if (plainStep.chain?.submittedBy && hiddenIds.has(plainStep.chain.submittedBy)) {
      plainStep.chain = { ...plainStep.chain, submittedBy: null, submitter: null };
    }
    const heldByRoleOrName = step.assignedUserId === user.userId || (!!step.assignedRole && roles.includes(step.assignedRole));
    results.push({
      ...plainStep,
      title,
      documentId,
      itemType: chain.itemType,
      itemId: chain.itemId,
      escalatedToMe: !heldByRoleOrName && (step.escalatedToUserIds ?? []).includes(user.userId),
    });
  }
  return results;
}
