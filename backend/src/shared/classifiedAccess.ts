// Classified documents: who may READ a CONFIDENTIAL or RESTRICTED document (owner decision 2026-10-10, "option B").
//
// Until then the classification of an ordinary document was a label: who could open it was decided only by department
// membership, folder and document grants. That made "Restricted" misleading, so it now closes the document the way it
// has always closed a letter (see letters/letterDocumentAcl.ts):
//
//   RESTRICTED   the owner; people the document was deliberately shared with (a per-document grant, which includes
//                everyone on its approval chain, its auditors and its signers); and the oversight roles.
//   CONFIDENTIAL the same, plus the HEAD of the document's own department.
//
// "Oversight roles" are the holders of `document:read_all` (records officer, executive, auditor, system administrator and
// the platform administrator). They are never restricted by classification: the rule below is only ever applied to
// someone who does NOT hold it, so a platform administrator reads every document regardless of its class.
//
// What does NOT open a classified document, because each is broad rather than a decision about this document: being a
// member of its department, the automatic department read rows written at upload (DEPT_SNAPSHOT), a grant on the folder
// or the department that contains it, and a tenant-wide or document-type access rule. An explicit DENY still wins over
// everything. The gate reads the classification live, so lowering a class reopens the document to its department at once
// and nothing has to be re-synchronised.
//
// "Head" means the same thing it means everywhere else in the platform: a DIRECT member of the document's department who
// holds `department:manage`. A letter's backing documents are excluded from the head rule, because the letters module
// already decides who may read a letter and the Documents module must not be wider than the letter itself.

import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../infrastructure/database/sequelize.js";
import { AclEntry } from "../infrastructure/database/models/index.js";
import { PERMISSIONS, userHasPermission } from "../config/permissions.js";

export const CLASSIFIED_LEVELS = ["CONFIDENTIAL", "RESTRICTED"] as const;

export const CLASSIFIED_DENY_REASON =
  "This document is classified: only its owner, people it was shared with, and oversight roles can open it";

export function isClassified(classification: string | null | undefined): boolean {
  return classification === "CONFIDENTIAL" || classification === "RESTRICTED";
}

/**
 * The title-case label kept in documents."sensitivityLabel" for a class. The database trigger (migration 20261011000010) sets the same value on every write;
 * the application sets it too so the row it holds in memory, and the index sidecar written beside the file, agree with what is stored.
 */
export function classificationLabel(classification: string): string {
  return classification.charAt(0).toUpperCase() + classification.slice(1).toLowerCase();
}

/** Does this person hold `department:manage` (the department head's permission)? Same fallback shape as the read-all check. */
export function holdsDepartmentManage(options: { userRole?: string; userPermissions?: readonly string[] }): boolean {
  return options.userPermissions
    ? options.userPermissions.includes(PERMISSIONS.DEPT_MANAGE)
    : userHasPermission({ role: options.userRole ?? "", permissions: undefined }, PERMISSIONS.DEPT_MANAGE);
}

export type ClassifiedVerdict = "open" | "head" | "closed";

/**
 * The pure decision for one classified document and one person who is NOT an oversight reader.
 *  - "open":   they own it or hold a deliberate per-document read grant (the normal ladder still applies, so a DENY wins);
 *  - "head":   a CONFIDENTIAL document whose department they head directly (and it is not a letter's document);
 *  - "closed": nobody opens it for them.
 */
export function classifiedVerdict(input: {
  classification: string | null | undefined;
  ownerId: string | null | undefined;
  userId: string;
  documentDepartmentId: string | null | undefined;
  memberDepartmentIds: ReadonlySet<string> | readonly string[];
  isDepartmentHead: boolean;
  hasDeliberateGrant: boolean;
  letterBacked: boolean;
}): ClassifiedVerdict {
  if (input.ownerId === input.userId || input.hasDeliberateGrant) return "open";
  const members = input.memberDepartmentIds instanceof Set ? input.memberDepartmentIds : new Set(input.memberDepartmentIds);
  if (
    input.classification === "CONFIDENTIAL" &&
    input.isDepartmentHead &&
    !input.letterBacked &&
    input.documentDepartmentId &&
    members.has(input.documentDepartmentId)
  ) {
    return "head";
  }
  return "closed";
}

/** A user ALLOW row that is a deliberate decision about THIS document (not an automatic department snapshot) and still valid. */
export function isDeliberateDocumentGrant(entry: {
  origin?: string | null;
  expiresAt?: Date | string | null;
  effect?: string;
  principalType?: string;
}): boolean {
  return (
    entry.effect === "ALLOW" &&
    entry.principalType === "user" &&
    entry.origin !== "DEPT_SNAPSHOT" &&
    (!entry.expiresAt || new Date(entry.expiresAt) > new Date())
  );
}

/** Single-document form: does this person hold a deliberate, unexpired read grant on the document itself? */
export async function hasDeliberateReadGrant(tenantId: string | undefined, documentId: string, userId: string): Promise<boolean> {
  const rows = await AclEntry.findAll({
    where: {
      ...(tenantId ? { tenantId } : {}),
      resourceType: "document",
      resourceId: documentId,
      principalType: "user",
      principalId: userId,
      permission: PERMISSIONS.DOCUMENT_READ,
      effect: "ALLOW",
      [Op.or]: [{ origin: null }, { origin: { [Op.ne]: "DEPT_SNAPSHOT" } }],
    },
    attributes: ["origin", "expiresAt", "effect", "principalType"],
    raw: true,
  });
  return rows.some((r) => isDeliberateDocumentGrant(r as never));
}

/** Which of these documents belong to a letter (its final PDF, signed draft, cover sheet or an attachment)? */
export async function letterBackedDocumentIds(documentIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return new Set();
  const rows = await sequelize.query<{ id: string }>(
    `SELECT document_id AS id FROM letters WHERE document_id IN (:ids)
     UNION SELECT signed_draft_document_id FROM letters WHERE signed_draft_document_id IN (:ids)
     UNION SELECT cover_sheet_document_id FROM letters WHERE cover_sheet_document_id IN (:ids)
     UNION SELECT document_id FROM letter_attachments WHERE document_id IN (:ids)`,
    { replacements: { ids }, type: QueryTypes.SELECT },
  );
  return new Set(rows.map((r) => r.id).filter(Boolean));
}
