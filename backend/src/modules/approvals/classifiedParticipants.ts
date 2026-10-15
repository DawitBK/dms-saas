// Chain participants and CLASSIFIED documents (shared/classifiedAccess.ts).
//
// A CONFIDENTIAL or RESTRICTED document is opened only by its owner, people it was deliberately shared with, the department head
// (CONFIDENTIAL only) and the oversight roles. The people an approval chain asks to act on it must therefore hold a DELIBERATE,
// per-person read grant, not the automatic department row and not a role name:
//
//   - grantChainParticipantAcl wrote its rows with "insert, ignore duplicates", so a department member who already had the automatic
//     department row got no deliberate row at all, and a role step wrote a ROLE row that never opens a document for an ordinary role.
//     That was harmless while department membership opened every document; it would lock an approver out of what they must decide
//     the moment the document became classified.
//   - This helper gives such a document real per-person grants: a role step is expanded to the people who hold the role in the
//     document's department right now, an existing automatic row is PROMOTED to a deliberate one, and the same is done for a chain that
//     was already running when the document was reclassified.
//
// Only classified documents are touched, so every ordinary document behaves exactly as before. Honest limit: a person who is
// appointed to a role AFTER the chain was submitted does not gain the document until it is shared with them (or, for a CONFIDENTIAL
// document, until they are the department head). For a RESTRICTED document, name the approvers as people.

import { Op, QueryTypes, type Transaction } from "sequelize";
import { AclEntry, Document, sequelize } from "../../infrastructure/database/index.js";
import { isClassified } from "../../shared/classifiedAccess.js";
import { resolveRoleUserIds } from "../../shared/assignmentAdvisory.js";
import { invalidateResourceACL } from "../../infrastructure/cache/aclCache.js";
import { logger } from "../../core/logger.js";

export type ChainParticipant = { assignedUserId?: string | null; assignedRole?: string | null };

/** Write (or promote to) a deliberate read grant for each user on each of the documents. Idempotent. */
async function ensureDeliberateReads(
  tenantId: string,
  documentIds: string[],
  userIds: string[],
  grantedById: string,
  tx: Transaction,
): Promise<void> {
  if (documentIds.length === 0 || userIds.length === 0) return;
  const rows = documentIds.flatMap((resourceId) =>
    userIds.map((principalId) => ({
      tenantId, resourceType: "document", resourceId, principalType: "user", principalId,
      effect: "ALLOW", permission: "document:read", grantedById,
    })),
  );
  await AclEntry.bulkCreate(rows as never[], { transaction: tx, ignoreDuplicates: true });
  await AclEntry.update(
    { origin: null } as never,
    {
      where: {
        tenantId, resourceType: "document", resourceId: { [Op.in]: documentIds }, principalType: "user",
        principalId: { [Op.in]: userIds }, permission: "document:read", effect: "ALLOW", origin: "DEPT_SNAPSHOT",
      },
      transaction: tx,
    },
  );
  tx.afterCommit(async () => {
    try {
      for (const id of documentIds) await invalidateResourceACL(tenantId, "document", id);
    } catch (error) {
      logger.warn({ error, tenantId }, "granted participants read of a classified document but could not clear the ACL cache");
    }
  });
}

/** The people behind a list of participants: named users as they are, role steps as the current holders in the document's department. */
async function expandParticipants(
  participants: ChainParticipant[],
  tenantId: string,
  departmentId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const p of participants) {
    if (p.assignedUserId) ids.add(p.assignedUserId);
    else if (p.assignedRole) for (const id of await resolveRoleUserIds(p.assignedRole, tenantId, departmentId)) ids.add(id);
  }
  return [...ids];
}

/** Called by grantChainParticipantAcl: classified documents among `documentIds` get per-person deliberate grants for the participants. */
export async function grantClassifiedReadsToParticipants(
  documentIds: string[],
  tenantId: string,
  grantedById: string,
  participants: ChainParticipant[],
  tx: Transaction,
): Promise<void> {
  const docs = await Document.findAll({
    where: { id: { [Op.in]: documentIds }, tenantId },
    attributes: ["id", "securityClassification", "departmentId"],
    transaction: tx,
    raw: true,
  });
  const classified = docs.filter((d) => isClassified(d.securityClassification));
  if (classified.length === 0) return;
  // Expand per department (a role step is department-scoped); documents of one chain normally share it.
  const byDepartment = new Map<string | null, string[]>();
  for (const d of classified) byDepartment.set(d.departmentId ?? null, [...(byDepartment.get(d.departmentId ?? null) ?? []), d.id]);
  for (const [departmentId, ids] of byDepartment) {
    const userIds = await expandParticipants(participants, tenantId, departmentId);
    await ensureDeliberateReads(tenantId, ids, userIds, grantedById, tx);
  }
}

/**
 * Called when a document BECOMES classified: everyone already on its approval chain, audit review or escalation keeps reading it.
 * (Signature recipients are not affected: they act through their own signing link, not through the Documents module.)
 */
export async function grantExistingParticipantsRead(
  documentId: string,
  tenantId: string,
  grantedById: string,
  tx: Transaction,
): Promise<void> {
  const doc = await Document.findOne({ where: { id: documentId, tenantId }, attributes: ["id", "departmentId"], transaction: tx, raw: true });
  if (!doc) return;
  const steps = await sequelize.query<{ assigned_user_id: string | null; assigned_role: string | null; decided_by: string | null; escalated: string[] | null; status: string }>(
    `SELECT s.assigned_user_id, s.assigned_role, s.decided_by, s.escalated_to_user_ids AS escalated, s.status
       FROM approval_steps s JOIN approval_chains c ON c.id = s.chain_id
      WHERE c.tenant_id = :tenantId AND s.status <> 'CANCELLED'
        AND ((c.item_type = 'DOCUMENT' AND c.item_id = :documentId)
          OR (c.item_type = 'FORM_INSTANCE' AND c.item_id IN (SELECT id FROM form_instances WHERE document_id = :documentId)))`,
    { replacements: { tenantId, documentId }, type: QueryTypes.SELECT, transaction: tx },
  );
  const reviews = await sequelize.query<{ auditor_user_id: string }>(
    `SELECT auditor_user_id FROM audit_stage_reviews WHERE tenant_id = :tenantId AND item_type = 'DOCUMENT' AND item_id = :documentId`,
    { replacements: { tenantId, documentId }, type: QueryTypes.SELECT, transaction: tx },
  );
  const participants: ChainParticipant[] = [];
  for (const s of steps) {
    if (s.assigned_user_id) participants.push({ assignedUserId: s.assigned_user_id });
    else if (s.assigned_role && (s.status === "PENDING" || s.status === "WAITING")) participants.push({ assignedRole: s.assigned_role });
    if (s.decided_by) participants.push({ assignedUserId: s.decided_by });
    for (const id of s.escalated ?? []) participants.push({ assignedUserId: id });
  }
  for (const r of reviews) participants.push({ assignedUserId: r.auditor_user_id });
  const userIds = await expandParticipants(participants, tenantId, doc.departmentId ?? null);
  await ensureDeliberateReads(tenantId, [documentId], userIds, grantedById, tx);
}
