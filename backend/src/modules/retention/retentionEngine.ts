// Retention engine activation (gap register #1 / SYSTEM-DECISIONS.md D11).
//
// This is the ONE place disposal eligibility is computed. Before it existed,
// `disposalEligibleDate` was only ever set inside legal-hold release — never at
// creation or archive — so the nightly disposal sweep matched nothing and the
// 90/30-day warning job iterated an empty retention_applications table. Every
// point where a retention clock starts or changes now funnels through
// applyRetention(): document creation (buffered + tus), archive, retention
// policy updates, and legal-hold release.

import type { Transaction } from "sequelize";
import { Op } from "sequelize";
import {
  Document,
  RetentionApplication,
  RetentionPolicy,
} from "../../infrastructure/database/index.js";

/** Resolve the date a policy's retention clock starts from, per its
 *  triggerEvent (D11: creation, archive, and document-date triggers are live;
 *  case/matter-closed awaits a case concept):
 *  - ARCHIVE-based events → archivedAt (null until the document is archived,
 *    which correctly leaves the clock unstarted);
 *  - DOCUMENT_DATE → the date on the document itself;
 *  - everything else (CREATION, TRANSACTION_DATE, CONTRACT_COMPLETION,
 *    EMPLOYEE_TERMINATION, AUDIT_COMPLETION, …) → the uploader-supplied
 *    retentionTriggerDate ("when the trigger event happened"), falling back
 *    to system creation time. */
function retentionBaseDate(policy: RetentionPolicy, doc: Document): Date | null {
  const trigger = (policy.triggerEvent ?? "").toUpperCase();
  if (trigger.includes("ARCHIVE")) return doc.archivedAt ?? null;
  if (trigger === "DOCUMENT_DATE") {
    return doc.documentDate ?? doc.retentionTriggerDate ?? doc.createdAt;
  }
  return doc.retentionTriggerDate ?? doc.createdAt;
}

/** Compute and persist `disposalEligibleDate` for a document from its
 *  retention class, and keep its pending RetentionApplication row (the data
 *  the 90/30-day warning worker reads) in sync. Safe to call repeatedly —
 *  idempotent for an unchanged document/policy pair. */
export async function applyRetention(documentId: string, transaction?: Transaction) {
  const doc = await Document.findByPk(documentId, { transaction });
  if (!doc) return;

  const policy = doc.retentionClass
    ? await RetentionPolicy.findOne({
        where: { code: doc.retentionClass, isActive: true },
        transaction,
      })
    : null;

  // No usable clock: permanent retention, no policy, or an archive-triggered
  // policy on a not-yet-archived document. Clear the eligibility date and any
  // stale un-authorized warning rows.
  const base = policy && !policy.isPermanent && policy.retentionYears
    ? retentionBaseDate(policy, doc)
    : null;
  if (!policy || policy.isPermanent || !policy.retentionYears || !base) {
    if (doc.disposalEligibleDate !== null) {
      await doc.update({ disposalEligibleDate: null }, { transaction });
    }
    await RetentionApplication.destroy({
      where: { documentId, disposalAuthorisedAt: null },
      transaction,
    });
    return;
  }

  const eligibleAt = new Date(base);
  eligibleAt.setFullYear(eligibleAt.getFullYear() + policy.retentionYears);

  if (doc.disposalEligibleDate?.getTime() !== eligibleAt.getTime()) {
    await doc.update({ disposalEligibleDate: eligibleAt }, { transaction });
  }

  // Stale pending applications for a *different* policy (retention class was
  // changed) must not keep firing warnings for the old schedule.
  await RetentionApplication.destroy({
    where: { documentId, disposalAuthorisedAt: null, policyId: { [Op.ne]: policy.id } },
    transaction,
  });

  const existing = await RetentionApplication.findOne({
    where: { documentId, policyId: policy.id, disposalAuthorisedAt: null },
    transaction,
  });
  if (existing) {
    if (existing.eligibleAt.getTime() !== eligibleAt.getTime()) {
      // The clock moved (e.g. document archived, policy years changed):
      // re-arm the 90/30-day warnings against the new date.
      await existing.update(
        { eligibleAt, notified90Days: false, notified30Days: false },
        { transaction },
      );
    }
  } else {
    await RetentionApplication.create(
      { documentId, policyId: policy.id, triggeredAt: new Date(), eligibleAt },
      { transaction },
    );
  }
}

/** Recompute every non-deleted document carrying the given retention class —
 *  used when a retention policy's years/trigger change. Batched to keep memory
 *  flat on large tenants. */
export async function reapplyRetentionForPolicyCode(code: string) {
  const BATCH = 200;
  let offset = 0;
  for (;;) {
    const docs = await Document.findAll({
      where: { retentionClass: code, deletedAt: null },
      attributes: ["id"],
      order: [["id", "ASC"]],
      offset,
      limit: BATCH,
    });
    if (docs.length === 0) break;
    for (const doc of docs) {
      await applyRetention(doc.id);
    }
    offset += docs.length;
  }
}
