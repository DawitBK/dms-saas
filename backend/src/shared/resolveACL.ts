// SPRINT-3 (S3-03): ACL resolution middleware with DENY-first, inheritance, and expiry handling
// Implements TDD §3.5 & §5.3 — two-layer RBAC+ACL enforcement

import type { NextFunction, Request, Response } from "express";
import { Op, QueryTypes } from "sequelize";
import { AppError } from "../core/AppError.js";
import { logger } from "../core/logger.js";
import { sequelize } from "../infrastructure/database/sequelize.js";
import {
  AclEntry,
  AccessRule,
  Department,
  Document,
  DocumentBundle,
  DocumentBundleItem,
  FolderNode,
} from "../infrastructure/database/models/index.js";
import { PERMISSIONS, userHasPermission } from "../config/permissions.js";
import { getCachedResolution, cacheResolution, getCachedResolutionsBatch } from "../infrastructure/cache/aclCache.js";
import { getCachedUserDepartments, cacheUserDepartments, loadUserDepartmentIds } from "../infrastructure/cache/userDeptCache.js";
import { writeAuditLog } from "../modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../modules/audit/auditEvents.js";
import {
  CLASSIFIED_DENY_REASON,
  classifiedVerdict,
  hasDeliberateReadGrant,
  holdsDepartmentManage,
  isClassified,
  isDeliberateDocumentGrant,
  letterBackedDocumentIds,
  type ClassifiedVerdict,
} from "./classifiedAccess.js";

/** Cache-then-DB lookup of a user's own department memberships — needed so a
 *  DEPARTMENT-scoped role grant (e.g. "DEPT_MANAGER, scoped to Finance" —
 *  the Access Control Center's department scope picker) actually means what
 *  it says. See the "6. Ancestor department checks" role block below for
 *  why this exists. */
async function getUserDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const cached = await getCachedUserDepartments(tenantId, userId);
  if (cached) return cached;
  const departmentIds = await loadUserDepartmentIds(tenantId, userId);
  await cacheUserDepartments(tenantId, userId, departmentIds);
  return departmentIds;
}

export type AclResourceType = "document" | "folder" | "department" | "workflow" | "workflow_task" | "retention" | "legal_hold";
export type AclEffect = "ALLOW" | "DENY";

export interface AclCheckOptions {
  resourceType: AclResourceType;
  resourceId: string;
  permission: string;
  userId?: string;
  // `role` on AuthenticatedUser is the single highest-ranked role, display-only
  // (see auth.ts). Pass the FULL assigned-role set here (req.user.roles) so a
  // DENY targeting any one of a multi-role user's roles is actually evaluated
  // instead of being silently skipped because only the display role was
  // checked. `userRole` is kept for legacy/single-role callers and folded into
  // the role set below when `userRoles` is absent.
  userRole?: string;
  userRoles?: readonly string[];
  /** Effective permissions for the ACTIVE role/session. */
  userPermissions?: readonly string[];
  ancestorIds?: string[]; // For folder inheritance (from leaf to root)
  // Nearly every real caller already knows this (req.user.tenantId) — passing
  // it lets resolveACL check the cache BEFORE paying for the ancestor CTE
  // walk, since the cache key never actually depended on the ancestor ids.
  tenantId?: string;
}

export interface AclResolutionResult {
  allowed: boolean;
  effect?: AclEffect;
  principalType?: "user" | "role";
  principalId?: string;
  reason?: string;
}

interface AncestorResolution {
  folderAncestorIds: string[];
  departmentAncestorIds: string[];
  tenantId: string | null;
  ownerId: string | null;
  /** Documents only: the class that decides whether the classified-document rule (classifiedAccess.ts) applies. */
  securityClassification: string | null;
  /** Documents only: the document's OWN department (not its ancestors), for the department-head rule. */
  documentDepartmentId: string | null;
}

function isNotExpired(expiresAt: Date | null): boolean {
  return !expiresAt || new Date(expiresAt) > new Date();
}

/** A user ALLOW row that is a deliberate grant (not a creation-time department snapshot) and still valid. */
function isDeliberateGrant(entry: { origin?: string | null; expiresAt: Date | null }): boolean {
  return entry.origin !== "DEPT_SNAPSHOT" && isNotExpired(entry.expiresAt);
}

function dedupedRoles(userRole: string | undefined, userRoles: readonly string[] | undefined): string[] {
  return Array.from(new Set(userRoles && userRoles.length > 0 ? userRoles : userRole ? [userRole] : []));
}

function hasTenantWideDocumentRead(options: Pick<AclCheckOptions, 'userRole' | 'userPermissions'>): boolean {
  return options.userPermissions
    ? options.userPermissions.includes(PERMISSIONS.DOCUMENT_READ_ALL)
    : userHasPermission({ role: options.userRole ?? '', permissions: undefined }, PERMISSIONS.DOCUMENT_READ_ALL);
}

/**
 * A compiled bundle is a derivative of every item it contains. Its normal
 * document ACL controls who may discover/open the compiled record, but never
 * widens access beyond an item that was stitched into its bytes. This lookup
 * provides the second half of that intersection for both single-resource and
 * batched ACL resolution.
 *
 * Keep this at the ACL boundary instead of duplicating the rule in list,
 * detail, download, and preview routes: every document-read consumer then
 * gets the same current-source scope, including consumers added later.
 */
async function compiledBundleSources(
  documentIds: readonly string[],
  tenantId: string | undefined,
): Promise<Map<string, string[]>> {
  const output = new Map<string, string[]>();
  if (!tenantId || documentIds.length === 0) return output;

  const bundles = await DocumentBundle.findAll({
    where: { tenantId, compiledDocumentId: { [Op.in]: [...new Set(documentIds)] } },
    attributes: ["id", "compiledDocumentId"],
    raw: true,
  });
  if (bundles.length === 0) return output;

  const bundleIds = bundles.map((bundle) => bundle.id);
  const items = await DocumentBundleItem.findAll({
    where: { bundleId: { [Op.in]: bundleIds } },
    attributes: ["bundleId", "documentId"],
    order: [["position", "ASC"]],
    raw: true,
  });
  const itemIdsByBundle = new Map<string, string[]>();
  for (const item of items) {
    const ids = itemIdsByBundle.get(item.bundleId) ?? [];
    ids.push(item.documentId);
    itemIdsByBundle.set(item.bundleId, ids);
  }
  for (const bundle of bundles) {
    // The compiler never creates an empty compiled bundle, but a malformed
    // record must fail closed rather than become broadly readable.
    if (bundle.compiledDocumentId) {
      output.set(bundle.compiledDocumentId, itemIdsByBundle.get(bundle.id) ?? []);
    }
  }
  return output;
}

async function constrainCompiledBundleResult(
  result: AclResolutionResult,
  sourceIds: string[] | undefined,
  options: {
    permission: string;
    userId?: string;
    userRole?: string;
    userRoles?: readonly string[];
    userPermissions?: readonly string[];
    tenantId: string;
  },
  depth: number,
): Promise<AclResolutionResult> {
  if (!result.allowed || sourceIds === undefined) return result;
  if (sourceIds.length === 0 || depth >= 16) {
    return { allowed: false, reason: "Compiled bundle has no readable source scope" };
  }
  const sourceResults = await resolveACLBatch(sourceIds, options, depth + 1);
  const denied = sourceIds.map((id) => sourceResults.get(id)).find((candidate) => !candidate?.allowed);
  return denied
    ? {
      allowed: false,
      effect: denied.effect,
      reason: "Compiled bundle includes a document outside the active read scope",
    }
    : result;
}

async function getAncestorsForResource(
  resourceType: string,
  resourceId: string
): Promise<AncestorResolution> {
  const folderAncestorIds: string[] = [];
  const departmentAncestorIds: string[] = [];
  let currentFolderId: string | null = null;
  let currentDepartmentId: string | null = null;
  let tenantId: string | null = null;
  let ownerId: string | null = null;
  let securityClassification: string | null = null;
  let documentDepartmentId: string | null = null;

  try {
    if (resourceType === "document") {
      const doc = await Document.findByPk(resourceId, { attributes: ["folderId", "departmentId", "tenantId", "ownerId", "securityClassification"] });
      if (doc) {
        tenantId = doc.tenantId;
        ownerId = doc.ownerId;
        securityClassification = doc.securityClassification ?? null;
        documentDepartmentId = doc.departmentId ?? null;
        if (doc.folderId) {
          currentFolderId = doc.folderId;
        }
        if (doc.departmentId) {
          currentDepartmentId = doc.departmentId;
        }
      }
    } else if (resourceType === "folder") {
      const folder = await FolderNode.findByPk(resourceId, { attributes: ["parentId", "departmentId", "tenantId"] });
      if (folder) {
        tenantId = folder.tenantId;
        if (folder.parentId) {
          currentFolderId = folder.parentId;
        }
        if (folder.departmentId) {
          currentDepartmentId = folder.departmentId;
        }
      }
    } else if (resourceType === "department") {
      const dept = await Department.findByPk(resourceId, { attributes: ["tenantId"] });
      if (dept) {
        tenantId = dept.tenantId;
        currentDepartmentId = resourceId;
      }
    }

    if (currentFolderId) {
      // FIX: raised from 20 — a real hierarchy deeper than 20 levels would
      // silently truncate here with no error, dropping any DENY set on an
      // ancestor beyond that depth (DENY-first defeated with no signal at
      // all). 100 is still a hard bound (cycle-safe), just one no real
      // folder tree should ever approach; log if it's ever actually hit.
      const maxDepth = 100;
      const result = await sequelize.query<{ id: string }>(
        `WITH RECURSIVE folder_tree AS (
          SELECT id, parent_id, 1 as depth FROM folder_nodes WHERE id = :currentFolderId
          UNION ALL
          SELECT f.id, f.parent_id, ft.depth + 1 FROM folder_nodes f
          INNER JOIN folder_tree ft ON f.id = ft.parent_id
          WHERE ft.depth < :maxDepth
        )
        SELECT id FROM folder_tree ORDER BY depth ASC;`,
        {
          replacements: { currentFolderId, maxDepth },
          type: QueryTypes.SELECT
        }
      );
      if (result.length >= maxDepth) {
        logger.warn({ resourceType, resourceId, maxDepth }, "Folder ancestor depth cap reached — ancestry may be truncated");
      }
      folderAncestorIds.push(...result.map(row => row.id));
    }

    if (currentDepartmentId) {
      const maxDepth = 100;
      const deptResult = await sequelize.query<{ id: string }>(
        `WITH RECURSIVE dept_tree AS (
          SELECT id, parent_id, 1 as depth FROM departments WHERE id = :currentDepartmentId
          UNION ALL
          SELECT d.id, d.parent_id, dt.depth + 1 FROM departments d
          INNER JOIN dept_tree dt ON d.id = dt.parent_id
          WHERE dt.depth < :maxDepth
        )
        SELECT id FROM dept_tree ORDER BY depth ASC;`,
        {
          replacements: { currentDepartmentId, maxDepth },
          type: QueryTypes.SELECT
        }
      );
      if (deptResult.length >= maxDepth) {
        logger.warn({ resourceType, resourceId, maxDepth }, "Department ancestor depth cap reached — ancestry may be truncated");
      }
      departmentAncestorIds.push(...deptResult.map(row => row.id));
    }
  } catch (error) {
    // FIX: this used to log and swallow, returning EMPTY ancestor arrays —
    // which silently drops any ancestor DENY from the resolution (DENY-first
    // defeated by a transient query error instead of failing closed).
    // Rethrow so the caller fails the request instead of granting access
    // without ever having actually checked ancestry.
    logger.error({ error, resourceType, resourceId }, "Failed to resolve ancestors — failing closed");
    throw error;
  }

  return { folderAncestorIds, departmentAncestorIds, tenantId, ownerId, securityClassification, documentDepartmentId };
}

/**
 * Batched equivalent of getAncestorsForResource's folder/department CTE walk,
 * for multiple root ids at once (one query total instead of one per root).
 * Same semantics per root: includes the root itself at depth 1, walks up via
 * parent_id, hard-capped at maxDepth=100 (cycle-safe), logs if the cap is hit.
 * Only used by resolveACLBatch (document-resource batching) — table is always
 * an internal literal, never user input.
 */
async function getAncestorsBatch(
  table: "folder_nodes" | "departments",
  rootIds: string[]
): Promise<Map<string, string[]>> {
  const byRoot = new Map<string, string[]>();
  if (rootIds.length === 0) return byRoot;

  const maxDepth = 100;
  const rows = await sequelize.query<{ root_id: string; id: string; depth: number }>(
    `WITH RECURSIVE ancestor_tree AS (
      SELECT id AS root_id, id, parent_id, 1 as depth FROM ${table} WHERE id IN (:rootIds)
      UNION ALL
      SELECT at.root_id, t.id, t.parent_id, at.depth + 1 FROM ${table} t
      INNER JOIN ancestor_tree at ON t.id = at.parent_id
      WHERE at.depth < :maxDepth
    )
    SELECT root_id, id, depth FROM ancestor_tree ORDER BY root_id, depth ASC;`,
    { replacements: { rootIds, maxDepth }, type: QueryTypes.SELECT }
  );

  const maxDepthSeenByRoot = new Map<string, number>();
  for (const row of rows) {
    if (!byRoot.has(row.root_id)) byRoot.set(row.root_id, []);
    byRoot.get(row.root_id)!.push(row.id);
    maxDepthSeenByRoot.set(row.root_id, Math.max(maxDepthSeenByRoot.get(row.root_id) ?? 0, row.depth));
  }
  for (const [rootId, depth] of maxDepthSeenByRoot) {
    if (depth >= maxDepth) {
      logger.warn({ table, rootId, maxDepth }, "Ancestor depth cap reached — ancestry may be truncated");
    }
  }
  return byRoot;
}

/**
 * Pure DENY-first resolution ladder over an already-fetched entry set —
 * steps 1-6 of resolveACL's doc comment. Extracted so resolveACL (single
 * resource) and resolveACLBatch (many resources, one query per stage) share
 * the exact same evaluation logic instead of two copies that could drift.
 * Does NOT touch the DB or cache — entries must already be the relevant
 * subset for this exact resourceType/resourceId/ancestors/userId/roles.
 */
function resolveFromEntries(
  entries: AclEntry[],
  resourceType: string,
  resourceId: string,
  folderAncestorIds: string[],
  departmentAncestorIds: string[],
  userId: string | undefined,
  roles: string[],
  userDepartmentIds: Set<string> = new Set()
): AclResolutionResult {
  let result: AclResolutionResult = {
    allowed: false,
    reason: "No matching ACL entry"
  };
  let deferredSnapshotAllow: AclEntry | null = null;

  // 1. Direct user DENY
  if (userId) {
    const directUserDeny = entries.find(
      e => e.resourceType === resourceType &&
           e.resourceId === resourceId &&
           e.principalType === "user" &&
           e.principalId === userId &&
           e.effect === "DENY"
    );
    if (directUserDeny) {
      result = {
        allowed: false,
        effect: "DENY",
        principalType: "user",
        principalId: userId,
        reason: "Direct user DENY"
      };
    }
  }

  // 2. Direct user ALLOW
  if (!result.effect && userId) {
    const directUserAllow = entries.find(
      e => e.resourceType === resourceType &&
           e.resourceId === resourceId &&
           e.principalType === "user" &&
           e.principalId === userId &&
           e.effect === "ALLOW"
    );
    if (directUserAllow && isNotExpired(directUserAllow.expiresAt)) {
      if (directUserAllow.origin === "DEPT_SNAPSHOT") {
        // Written automatically at upload for the department's members of that moment: an inherited
        // default, not a decision about this document. It must not outrank a DENY set on the folder
        // or department above (that DENY is the person closing the area), so it only counts as a last
        // resort, after the folder and department checks below found nothing.
        deferredSnapshotAllow = directUserAllow;
      } else {
        result = {
          allowed: true,
          effect: "ALLOW",
          principalType: "user",
          principalId: userId,
          reason: "Direct user ALLOW"
        };
      }
    }
  }

  // 3. Direct role DENY (any of the user's assigned roles)
  if (!result.effect && roles.length > 0) {
    const directRoleDeny = entries.find(
      e => e.resourceType === resourceType &&
           e.resourceId === resourceId &&
           e.principalType === "role" &&
           roles.includes(e.principalId) &&
           e.effect === "DENY"
    );
    if (directRoleDeny) {
      result = {
        allowed: false,
        effect: "DENY",
        principalType: "role",
        principalId: directRoleDeny.principalId,
        reason: "Direct role DENY"
      };
    }
  }

  // 4. Direct role ALLOW (any of the user's assigned roles)
  if (!result.effect && roles.length > 0) {
    const directRoleAllow = entries.find(
      e => e.resourceType === resourceType &&
           e.resourceId === resourceId &&
           e.principalType === "role" &&
           roles.includes(e.principalId) &&
           e.effect === "ALLOW"
    );
    if (directRoleAllow && isNotExpired(directRoleAllow.expiresAt)) {
      result = {
        allowed: true,
        effect: "ALLOW",
        principalType: "role",
        principalId: directRoleAllow.principalId,
        reason: "Direct role ALLOW"
      };
    }
  }

  // 5. Ancestor folder checks (closest first)
  if (!result.effect && folderAncestorIds.length > 0) {
    // User level checks on ancestors
    if (userId) {
      for (const ancestorId of folderAncestorIds) {
        const ancestorUserDeny = entries.find(
          e => e.resourceType === "folder" &&
               e.resourceId === ancestorId &&
               e.principalType === "user" &&
               e.principalId === userId &&
               e.effect === "DENY"
        );
        if (ancestorUserDeny) {
          result = {
            allowed: false,
            effect: "DENY",
            principalType: "user",
            principalId: userId,
            reason: `Ancestor folder DENY at ${ancestorId}`
          };
          break;
        }

        const ancestorUserAllow = entries.find(
          e => e.resourceType === "folder" &&
               e.resourceId === ancestorId &&
               e.principalType === "user" &&
               e.principalId === userId &&
               e.effect === "ALLOW"
        );
        if (ancestorUserAllow && isNotExpired(ancestorUserAllow.expiresAt)) {
          result = {
            allowed: true,
            effect: "ALLOW",
            principalType: "user",
            principalId: userId,
            reason: `Ancestor folder ALLOW at ${ancestorId}`
          };
          break;
        }
      }
    }

    // Role level checks on ancestors (any of the user's assigned roles)
    if (!result.effect && roles.length > 0) {
      for (const ancestorId of folderAncestorIds) {
        const ancestorRoleDeny = entries.find(
          e => e.resourceType === "folder" &&
               e.resourceId === ancestorId &&
               e.principalType === "role" &&
               roles.includes(e.principalId) &&
               e.effect === "DENY"
        );
        if (ancestorRoleDeny) {
          result = {
            allowed: false,
            effect: "DENY",
            principalType: "role",
            principalId: ancestorRoleDeny.principalId,
            reason: `Ancestor folder role DENY at ${ancestorId}`
          };
          break;
        }

        const ancestorRoleAllow = entries.find(
          e => e.resourceType === "folder" &&
               e.resourceId === ancestorId &&
               e.principalType === "role" &&
               roles.includes(e.principalId) &&
               e.effect === "ALLOW"
        );
        if (ancestorRoleAllow && isNotExpired(ancestorRoleAllow.expiresAt)) {
          result = {
            allowed: true,
            effect: "ALLOW",
            principalType: "role",
            principalId: ancestorRoleAllow.principalId,
            reason: `Ancestor folder role ALLOW at ${ancestorId}`
          };
          break;
        }
      }
    }
  }

  // 6. Ancestor department checks (closest first)
  if (!result.effect && departmentAncestorIds.length > 0) {
    // User level checks on ancestors
    if (userId) {
      for (const ancestorId of departmentAncestorIds) {
        const ancestorUserDeny = entries.find(
          e => e.resourceType === "department" &&
               e.resourceId === ancestorId &&
               e.principalType === "user" &&
               e.principalId === userId &&
               e.effect === "DENY"
        );
        if (ancestorUserDeny) {
          result = {
            allowed: false,
            effect: "DENY",
            principalType: "user",
            principalId: userId,
            reason: `Ancestor department DENY at ${ancestorId}`
          };
          break;
        }

        const ancestorUserAllow = entries.find(
          e => e.resourceType === "department" &&
               e.resourceId === ancestorId &&
               e.principalType === "user" &&
               e.principalId === userId &&
               e.effect === "ALLOW"
        );
        if (ancestorUserAllow && isNotExpired(ancestorUserAllow.expiresAt)) {
          result = {
            allowed: true,
            effect: "ALLOW",
            principalType: "user",
            principalId: userId,
            reason: `Ancestor department ALLOW at ${ancestorId}`
          };
          break;
        }
      }
    }

    // Role level checks on ancestors (any of the user's assigned roles) —
    // FIX: a role ALLOW/DENY attached to a DEPARTMENT resource is exactly
    // what the Access Control Center's "scope to department" picker
    // creates (e.g. "DEPT_MANAGER, scoped to Finance"). Before this, the
    // match was on role name ALONE — `roles.includes(e.principalId)` — with
    // no check that the querying user is actually a member of THIS
    // department. That silently made every "department-scoped" role grant
    // tenant-wide in practice: granting DEPT_MANAGER read on Finance's
    // department resource gave every DEPT_MANAGER in the tenant read
    // access to every Finance document, not just Finance's own manager.
    // Caught live via documents.service.ts's grantDefaultDocumentAcl, which
    // hit this same class of bug from the document-resource side (fixed
    // there by granting per-user instead of per-role). This is the fix on
    // the resolution side: a department-ancestor role match additionally
    // requires the querying user to actually belong to that department.
    // Deliberately NOT applied to the direct-resource role check (steps 3–4)
    // or the folder-ancestor role check (step 5) — those cover distinct,
    // separately-reasoned-about grants (e.g. RECORDS_OFFICER's tenant-wide
    // purge, H8) that this fix isn't touching.
    if (!result.effect && roles.length > 0) {
      for (const ancestorId of departmentAncestorIds) {
        if (!userDepartmentIds.has(ancestorId)) continue;
        const ancestorRoleDeny = entries.find(
          e => e.resourceType === "department" &&
               e.resourceId === ancestorId &&
               e.principalType === "role" &&
               roles.includes(e.principalId) &&
               e.effect === "DENY"
        );
        if (ancestorRoleDeny) {
          result = {
            allowed: false,
            effect: "DENY",
            principalType: "role",
            principalId: ancestorRoleDeny.principalId,
            reason: `Ancestor department role DENY at ${ancestorId}`
          };
          break;
        }

        const ancestorRoleAllow = entries.find(
          e => e.resourceType === "department" &&
               e.resourceId === ancestorId &&
               e.principalType === "role" &&
               roles.includes(e.principalId) &&
               e.effect === "ALLOW"
        );
        if (ancestorRoleAllow && isNotExpired(ancestorRoleAllow.expiresAt)) {
          result = {
            allowed: true,
            effect: "ALLOW",
            principalType: "role",
            principalId: ancestorRoleAllow.principalId,
            reason: `Ancestor department role ALLOW at ${ancestorId}`
          };
          break;
        }
      }
    }
  }

  if (!result.effect && deferredSnapshotAllow && userId) {
    result = {
      allowed: true,
      effect: "ALLOW",
      principalType: "user",
      principalId: userId,
      reason: "Direct user ALLOW (department snapshot)"
    };
  }

  return result;
}

/**
 * Pure step 7 (access rules) — tenant-wide and document-type-wide rules,
 * ordered document-type-specific > tenant-wide, user > role, DENY > ALLOW.
 * `accessRules` must already be filtered to rules whose documentTypeId is
 * either null or equal to this resource's documentTypeId. Returns null when
 * no rule applies (caller keeps whatever result steps 1-6 already produced).
 */
function resolveFromAccessRules(accessRules: AccessRule[]): AclResolutionResult | null {
  const orderedRules = [...accessRules].sort((a, b) => {
    // First: document-type-specific comes before tenant-wide
    const aDocType = a.documentTypeId ? 0 : 1;
    const bDocType = b.documentTypeId ? 0 : 1;
    if (aDocType !== bDocType) return aDocType - bDocType;

    // Second: user comes before role
    const aIsUser = a.principalType === "user" ? 0 : 1;
    const bIsUser = b.principalType === "user" ? 0 : 1;
    if (aIsUser !== bIsUser) return aIsUser - bIsUser;

    // Third: DENY comes before ALLOW
    const aIsDeny = a.effect === "DENY" ? 0 : 1;
    const bIsDeny = b.effect === "DENY" ? 0 : 1;
    return aIsDeny - bIsDeny;
  });

  for (const rule of orderedRules) {
    if (!isNotExpired(rule.expiresAt)) continue;

    if (rule.effect === "DENY") {
      return {
        allowed: false,
        effect: "DENY",
        principalType: rule.principalType as "user" | "role",
        principalId: rule.principalId,
        reason: rule.documentTypeId
          ? `Document-type access rule DENY (type ${rule.documentTypeId})`
          : "Tenant-wide access rule DENY"
      };
    } else if (rule.effect === "ALLOW") {
      return {
        allowed: true,
        effect: "ALLOW",
        principalType: rule.principalType as "user" | "role",
        principalId: rule.principalId,
        reason: rule.documentTypeId
          ? `Document-type access rule ALLOW (type ${rule.documentTypeId})`
          : "Tenant-wide access rule ALLOW"
      };
    }
  }
  return null;
}

/**
 * Resolve ACL for a user and resource.
 * DENY-first: any DENY entry blocks access, regardless of ALLOW entries.
 * Expired ALLOW entries are treated as implicit deny (missing ACL).
 * Resolution order:
 *  1. Direct user DENY → forbidden
 *  2. Direct user ALLOW (not expired) → allowed
 *  3. Role DENY → forbidden
 *  4. Role ALLOW (not expired) → allowed
 *  5. Ancestor folder ACL recursion (user → role)
 *  6. No entry found → implicit deny (AUTHZ_ACL_NO_ENTRY)
 */
export async function resolveACL(options: AclCheckOptions): Promise<AclResolutionResult> {
  const { resourceType, resourceId, permission, userId, userRole } = options;
  // De-duped full role set for this user. Every DENY/ALLOW lookup below checks
  // ALL of these, not just the single display role, so a DENY targeting a
  // secondary role is never silently skipped (see AclCheckOptions.userRoles).
  const roles = dedupedRoles(userRole, options.userRoles);
  const tenantWideDocumentRead = permission === PERMISSIONS.DOCUMENT_READ && hasTenantWideDocumentRead(options);
  const bundleSources = resourceType === "document" && permission === PERMISSIONS.DOCUMENT_READ
    ? await compiledBundleSources([resourceId], options.tenantId)
    : new Map<string, string[]>();
  const sourceIds = bundleSources.get(resourceId);
  const applyBundleSourceScope = (result: AclResolutionResult) => sourceIds === undefined
    ? Promise.resolve(result)
    : constrainCompiledBundleResult(result, sourceIds, {
      permission,
      userId,
      userRole,
      userRoles: options.userRoles,
      userPermissions: options.userPermissions,
      tenantId: options.tenantId ?? "",
    }, 0);
  let preloadedAncestors: AncestorResolution | undefined;
  // Set only for a CLASSIFIED document read by someone who is not an oversight reader (classifiedAccess.ts). Such a
  // document is never served from, or written to, the ACL cache: its class is read live on every check.
  let classifiedGate: ClassifiedVerdict | null = null;

  // Department scope is a hard boundary for ordinary document readers. Do
  // this check before the ACL cache: a cached ALLOW must never survive a
  // user's department membership being removed. Owners retain access to
  // their own documents; oversight roles use DOCUMENT_READ_ALL explicitly.
  // `ancestorIds` is an internal test/advanced-call escape hatch where the
  // caller has already resolved ancestry and therefore cannot provide owner
  // metadata to this guard.
  if (
    resourceType === "document" &&
    permission === PERMISSIONS.DOCUMENT_READ &&
    userId &&
    !tenantWideDocumentRead &&
    options.ancestorIds === undefined
  ) {
    preloadedAncestors = await getAncestorsForResource(resourceType, resourceId);
    const effectiveTenantId = options.tenantId ?? preloadedAncestors.tenantId ?? "";
    const memberDepartmentIds = await getUserDepartmentIds(effectiveTenantId, userId);
    const inActiveDepartment = preloadedAncestors.departmentAncestorIds.some((id) => memberDepartmentIds.includes(id));
    if (preloadedAncestors.ownerId !== userId && !inActiveDepartment) {
      // Outside the department the only way in is a DELIBERATE per-user grant
      // (approval participant, auditor, signatory, Access Control Center). The
      // department snapshot rows written at upload are bound by this boundary —
      // that is what makes leaving a department end access.
      const grants = await AclEntry.findAll({
        where: {
          permission,
          effect: "ALLOW",
          principalType: "user",
          principalId: userId,
          ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
          [Op.or]: [
            { resourceType: "document", resourceId },
            ...(preloadedAncestors.folderAncestorIds.length > 0
              ? [{ resourceType: "folder", resourceId: { [Op.in]: preloadedAncestors.folderAncestorIds } }]
              : []),
            ...(preloadedAncestors.departmentAncestorIds.length > 0
              ? [{ resourceType: "department", resourceId: { [Op.in]: preloadedAncestors.departmentAncestorIds } }]
              : []),
          ],
        },
        raw: true,
      });
      if (!grants.some(isDeliberateGrant)) {
        return { allowed: false, reason: "Document is outside the active department scope" };
      }
    }

    // Classified documents (CONFIDENTIAL / RESTRICTED): membership of the department is not enough. See classifiedAccess.ts.
    if (isClassified(preloadedAncestors.securityClassification)) {
      const hasGrant = await hasDeliberateReadGrant(effectiveTenantId, resourceId, userId);
      const headCandidate =
        !hasGrant &&
        preloadedAncestors.ownerId !== userId &&
        preloadedAncestors.securityClassification === "CONFIDENTIAL" &&
        holdsDepartmentManage(options) &&
        Boolean(preloadedAncestors.documentDepartmentId) &&
        memberDepartmentIds.includes(preloadedAncestors.documentDepartmentId!);
      const letterBacked = headCandidate ? (await letterBackedDocumentIds([resourceId])).has(resourceId) : false;
      classifiedGate = classifiedVerdict({
        classification: preloadedAncestors.securityClassification,
        ownerId: preloadedAncestors.ownerId,
        userId,
        documentDepartmentId: preloadedAncestors.documentDepartmentId,
        memberDepartmentIds,
        isDepartmentHead: holdsDepartmentManage(options),
        hasDeliberateGrant: hasGrant,
        letterBacked,
      });
      if (classifiedGate === "closed") return { allowed: false, reason: CLASSIFIED_DENY_REASON };
    }
  }

  const tryCache = (tid: string) =>
    getCachedResolution(tid, resourceType, resourceId, userId, roles, permission);

  // FIX: the cache key never actually depended on the resolved ancestor id
  // lists — only on tenantId/resourceType/resourceId/userId/userRole/
  // permission. Previously the ancestor CTE walk (a Document/Folder/
  // Department lookup plus up to two recursive queries) ran unconditionally
  // BEFORE this cache check, so a "cache hit" still cost 1-3 DB round-trips.
  // When the caller already knows the tenantId (true for nearly every real
  // caller — it's on req.user.tenantId), check the cache immediately and
  // skip the ancestor walk entirely on a hit.
  if (options.tenantId && !classifiedGate) {
    const cached = await tryCache(options.tenantId);
    if (cached) return applyBundleSourceScope(cached);
  }

  let folderAncestorIds: string[];
  let departmentAncestorIds: string[];
  let tenantId: string | null;

  if (options.ancestorIds !== undefined) {
    folderAncestorIds = options.ancestorIds;
    departmentAncestorIds = [];
    tenantId = options.tenantId ?? null;
  } else {
    const ancestorRes = preloadedAncestors ?? await getAncestorsForResource(resourceType, resourceId);
    folderAncestorIds = ancestorRes.folderAncestorIds;
    departmentAncestorIds = ancestorRes.departmentAncestorIds;
    tenantId = options.tenantId ?? ancestorRes.tenantId;
  }

  // Fallback: caller didn't pass tenantId up front, so the cache couldn't be
  // checked until the ancestor resolution above produced one. Same cache,
  // same key — just the first opportunity to check it for this caller.
  if (!options.tenantId && tenantId && !classifiedGate) {
    const cached = await tryCache(tenantId);
    if (cached) return applyBundleSourceScope(cached);
  }

  // Batch load all matching ACL entries in a single query
  //
  // SECURITY FIX: previously had no tenantId predicate at all — an ACL row
  // written against another tenant's resourceId (see acl.service.ts's
  // assertResourceInTenant fix for the write-side of this same gap) would
  // still be found and honored here. Defense in depth: even if a stray
  // cross-tenant row exists (e.g. from before that fix, or a future bug),
  // it's excluded from evaluation once tenantId is known.
  const entries = await AclEntry.findAll({
    where: {
      permission,
      ...(tenantId ? { tenantId } : {}),
      [Op.or]: [
        // Direct user
        ...(userId ? [{
          resourceType,
          resourceId,
          principalType: "user" as const,
          principalId: userId
        }] : []),
        // Direct role (any of the user's assigned roles)
        ...(roles.length > 0 ? [{
          resourceType,
          resourceId,
          principalType: "role" as const,
          principalId: { [Op.in]: roles }
        }] : []),
        // Ancestor folder user
        ...(userId && folderAncestorIds.length > 0 ? [{
          resourceType: "folder" as const,
          resourceId: { [Op.in]: folderAncestorIds },
          principalType: "user" as const,
          principalId: userId
        }] : []),
        // Ancestor folder role (any of the user's assigned roles)
        ...(roles.length > 0 && folderAncestorIds.length > 0 ? [{
          resourceType: "folder" as const,
          resourceId: { [Op.in]: folderAncestorIds },
          principalType: "role" as const,
          principalId: { [Op.in]: roles }
        }] : []),
        // Ancestor department user
        ...(userId && departmentAncestorIds.length > 0 ? [{
          resourceType: "department" as const,
          resourceId: { [Op.in]: departmentAncestorIds },
          principalType: "user" as const,
          principalId: userId
        }] : []),
        // Ancestor department role (any of the user's assigned roles)
        ...(roles.length > 0 && departmentAncestorIds.length > 0 ? [{
          resourceType: "department" as const,
          resourceId: { [Op.in]: departmentAncestorIds },
          principalType: "role" as const,
          principalId: { [Op.in]: roles }
        }] : [])
      ]
    },
    raw: true
  });

  // A document/folder role ALLOW has no department dimension. For an ordinary
  // active role it must never widen the hard department scope above. Keep role
  // DENYs (they remain useful inside an allowed department), and keep all role
  // grants for the explicit DOCUMENT_READ_ALL oversight permission.
  const scopedEntries = tenantWideDocumentRead
    ? entries
    : entries.filter((entry) => !(
      permission === PERMISSIONS.DOCUMENT_READ &&
      entry.principalType === "role" &&
      entry.effect === "ALLOW" &&
      (entry.resourceType === "document" || entry.resourceType === "folder")
    ));

  // Only needed by the department-ancestor role check — skip the lookup
  // entirely when there's nothing for it to gate (no roles, or the resource
  // has no department ancestry at all, e.g. a folder outside any department).
  const userDepartmentIds = userId && roles.length > 0 && departmentAncestorIds.length > 0
    ? new Set(await getUserDepartmentIds(tenantId ?? "", userId))
    : new Set<string>();

  let result = resolveFromEntries(scopedEntries, resourceType, resourceId, folderAncestorIds, departmentAncestorIds, userId, roles, userDepartmentIds);

  // 7. Access rules check (tenant-wide and document-type-wide)
  if (!result.effect && tenantId) {
    // Get document type id if resource is document
    let documentTypeId: string | null = null;
    if (resourceType === "document") {
      const doc = await Document.findByPk(resourceId, { attributes: ["documentTypeId"] });
      if (doc) {
        documentTypeId = doc.documentTypeId;
      }
    }

    // Load all relevant access rules
    const accessRules = await AccessRule.findAll({
      where: {
        tenantId,
        permission,
        [Op.and]: [
          {
            [Op.or]: [
              ...(userId ? [
                { principalType: "user", principalId: userId },
              ] : []),
              ...(roles.length > 0 && (tenantWideDocumentRead || permission !== PERMISSIONS.DOCUMENT_READ) ? [
                { principalType: "role", principalId: { [Op.in]: roles } },
              ] : [])
            ]
          },
          {
            [Op.or]: [
              { documentTypeId: null },
              ...(documentTypeId ? [{ documentTypeId }] : [])
            ]
          }
        ]
      },
      raw: true
    });

    const rulesResult = resolveFromAccessRules(
      tenantWideDocumentRead || permission !== PERMISSIONS.DOCUMENT_READ
        ? accessRules
        : accessRules.filter((rule) => !(rule.principalType === "role" && rule.effect === "ALLOW")),
    );
    if (rulesResult) result = rulesResult;
  }

  // The head of the document's department reads its CONFIDENTIAL documents (never RESTRICTED ones, never a letter's). An explicit
  // DENY found above still wins.
  if (classifiedGate === "head" && userId && result.effect !== "DENY") {
    result = {
      allowed: true,
      effect: "ALLOW",
      principalType: "user",
      principalId: userId,
      reason: "Department head reads a CONFIDENTIAL document of the department",
    };
  }

  // DOCUMENT_READ_ALL is an explicit active-role capability, not a legacy
  // role ACL row. Once DENY rules/entries have had their chance above, an
  // oversight reader is allowed even when the historical blanket ALLOW rows
  // have been removed by the cleanup migration.
  if (!result.effect && tenantWideDocumentRead) {
    result = {
      allowed: true,
      effect: "ALLOW",
      principalType: "role",
      principalId: userRole,
      reason: "Active role has DOCUMENT_READ_ALL",
    };
  }

  result = await applyBundleSourceScope(result);

  // A compiled bundle's effective result also depends on every source row, so
  // caching it under only the compiled id could outlive a source ACL change.
  if (tenantId && sourceIds === undefined && !classifiedGate) {
    await cacheResolution(
      tenantId,
      resourceType,
      resourceId,
      userId,
      roles,
      permission,
      result
    ).catch(err => logger.warn({ err }, "Failed to cache ACL resolution"));
  }

  return result;
}

/**
 * Batched equivalent of resolveACL for many `document` resources at once
 * against the SAME user/permission/tenant — built for list endpoints like
 * filterDocsByDetailAcl, which previously called resolveACL() once per row
 * (a real N+1: on a cold cache, a 100-row page could issue 400-500 queries —
 * ancestor CTEs + AclEntry.findAll + AccessRule.findAll + a Document lookup,
 * each repeated per row).
 *
 * Produces IDENTICAL per-document results to calling resolveACL(...) once
 * per id (same DENY-first ladder via resolveFromEntries/resolveFromAccessRules,
 * same cache keys/TTL) — only the fetching is batched: one cache batch-read,
 * then (for cache misses only) one Document lookup, one ancestor CTE per
 * ancestor table, one AclEntry query, and one AccessRule query covering ALL
 * missing ids, instead of one round-trip per id per stage. See
 * test-scripts/test-acl-batch-equivalence.ts for the equivalence check against
 * resolveACL (every DENY-first branch, cold + warm cache, two users/roles).
 *
 * Only supports resourceType "document" — the only real caller. Not a
 * general n-resource-type batcher; add that only if another list endpoint
 * actually needs it.
 */
export async function resolveACLBatch(
  documentIds: string[],
  options: {
    permission: string;
    userId?: string;
    userRole?: string;
    userRoles?: readonly string[];
    userPermissions?: readonly string[];
    tenantId: string;
  },
  depth = 0,
): Promise<Map<string, AclResolutionResult>> {
  const resultMap = new Map<string, AclResolutionResult>();
  if (documentIds.length === 0) return resultMap;

  const roles = dedupedRoles(options.userRole, options.userRoles);
  const { permission, userId, tenantId } = options;
  const tenantWideDocumentRead = permission === PERMISSIONS.DOCUMENT_READ && hasTenantWideDocumentRead(options);

  const uniqueIds = Array.from(new Set(documentIds));
  const compiledSources = permission === PERMISSIONS.DOCUMENT_READ
    ? await compiledBundleSources(uniqueIds, tenantId)
    : new Map<string, string[]>();
  // Ordinary document reads are membership-sensitive. Skip cached ALLOW
  // results for them so a department removal cannot leave a stale detail ACL
  // usable until the normal ACL TTL expires. Oversight/non-read operations keep
  // the existing batch cache path.
  const cacheHits = permission === PERMISSIONS.DOCUMENT_READ && userId && !tenantWideDocumentRead
    ? new Map<string, AclResolutionResult>()
    : await getCachedResolutionsBatch(tenantId, "document", uniqueIds, userId, roles, permission);
  for (const [id, hit] of cacheHits) resultMap.set(id, hit);

  const missingIds = uniqueIds.filter(id => !cacheHits.has(id));
  if (missingIds.length > 0) {

  const docs = await Document.findAll({
    // Keep the tenant predicate explicit even though PostgreSQL RLS is the
    // final isolation boundary. This makes the batch resolver safe under
    // privileged connections and prevents a future policy change from turning
    // an ACL lookup into a cross-tenant metadata read.
    where: { tenantId, id: { [Op.in]: missingIds } },
    attributes: ["id", "folderId", "departmentId", "documentTypeId", "ownerId", "securityClassification"],
    raw: true,
  });
  const docById = new Map(docs.map(d => [d.id, d]));

  const folderRootIds = Array.from(new Set(docs.map(d => d.folderId).filter((v): v is string => Boolean(v))));
  const departmentRootIds = Array.from(new Set(docs.map(d => d.departmentId).filter((v): v is string => Boolean(v))));

  const [folderAncestorsByRoot, departmentAncestorsByRoot] = await Promise.all([
    getAncestorsBatch("folder_nodes", folderRootIds),
    getAncestorsBatch("departments", departmentRootIds),
  ]);

  const allFolderAncestorIds = Array.from(new Set([...folderAncestorsByRoot.values()].flat()));
  const allDepartmentAncestorIds = Array.from(new Set([...departmentAncestorsByRoot.values()].flat()));

  // Same predicate shape as resolveACL's single-resource query, just IN'd
  // over the whole missing-id set (plus their combined ancestor sets) instead
  // of one id at a time — a strict superset, filtered back down per-document below.
  const entries = await AclEntry.findAll({
    where: {
      permission,
      tenantId,
      [Op.or]: [
        ...(userId ? [{
          resourceType: "document" as const,
          resourceId: { [Op.in]: missingIds },
          principalType: "user" as const,
          principalId: userId,
        }] : []),
        ...(roles.length > 0 ? [{
          resourceType: "document" as const,
          resourceId: { [Op.in]: missingIds },
          principalType: "role" as const,
          principalId: { [Op.in]: roles },
        }] : []),
        ...(userId && allFolderAncestorIds.length > 0 ? [{
          resourceType: "folder" as const,
          resourceId: { [Op.in]: allFolderAncestorIds },
          principalType: "user" as const,
          principalId: userId,
        }] : []),
        ...(roles.length > 0 && allFolderAncestorIds.length > 0 ? [{
          resourceType: "folder" as const,
          resourceId: { [Op.in]: allFolderAncestorIds },
          principalType: "role" as const,
          principalId: { [Op.in]: roles },
        }] : []),
        ...(userId && allDepartmentAncestorIds.length > 0 ? [{
          resourceType: "department" as const,
          resourceId: { [Op.in]: allDepartmentAncestorIds },
          principalType: "user" as const,
          principalId: userId,
        }] : []),
        ...(roles.length > 0 && allDepartmentAncestorIds.length > 0 ? [{
          resourceType: "department" as const,
          resourceId: { [Op.in]: allDepartmentAncestorIds },
          principalType: "role" as const,
          principalId: { [Op.in]: roles },
        }] : []),
      ],
    },
    raw: true,
  });

  // Single user, many documents — one fetch, reused for every row's
  // department-ancestor role check below (see resolveFromEntries).
  const userDepartmentIds = userId && !tenantWideDocumentRead && allDepartmentAncestorIds.length > 0
    ? new Set(await getUserDepartmentIds(tenantId, userId))
    : new Set<string>();

  // Classified-document rule (classifiedAccess.ts), prepared once for the whole page. Only someone who is not an oversight reader
  // is subject to it; the letter-backed lookup is needed only for a department head looking at CONFIDENTIAL documents.
  const subjectToClassifiedRule = permission === PERMISSIONS.DOCUMENT_READ && Boolean(userId) && !tenantWideDocumentRead;
  const isHead = subjectToClassifiedRule && holdsDepartmentManage(options);
  const memberDepartmentIdsForRule = subjectToClassifiedRule && userId && docs.some((d) => isClassified(d.securityClassification))
    ? new Set(await getUserDepartmentIds(tenantId, userId))
    : new Set<string>();
  const letterBackedForRule = isHead
    ? await letterBackedDocumentIds(docs.filter((d) => d.securityClassification === "CONFIDENTIAL").map((d) => d.id))
    : new Set<string>();

  const documentTypeIds = Array.from(new Set(docs.map(d => d.documentTypeId).filter((v): v is string => Boolean(v))));
  const accessRules = await AccessRule.findAll({
    where: {
      tenantId,
      permission,
      [Op.and]: [
        {
          [Op.or]: [
            ...(userId ? [{ principalType: "user", principalId: userId }] : []),
            ...(roles.length > 0 ? [{ principalType: "role", principalId: { [Op.in]: roles } }] : []),
          ],
        },
        {
          [Op.or]: [
            { documentTypeId: null },
            ...(documentTypeIds.length > 0 ? [{ documentTypeId: { [Op.in]: documentTypeIds } }] : []),
          ],
        },
      ],
    },
    raw: true,
  });

  for (const id of missingIds) {
    const doc = docById.get(id);
    if (!doc) {
      // Row vanished between the caller's own query and this one (deleted
      // concurrently) — fail closed, same posture as "no matching ACL entry".
      resultMap.set(id, { allowed: false, reason: "No matching ACL entry" });
      continue;
    }

    const folderAncestorIds = doc.folderId ? (folderAncestorsByRoot.get(doc.folderId) ?? []) : [];
    const departmentAncestorIds = doc.departmentId ? (departmentAncestorsByRoot.get(doc.departmentId) ?? []) : [];

    if (
      permission === PERMISSIONS.DOCUMENT_READ &&
      userId &&
      !tenantWideDocumentRead &&
      doc.ownerId !== userId &&
      !departmentAncestorIds.some((departmentId) => userDepartmentIds.has(departmentId)) &&
      // Same rule as resolveACL: only a deliberate per-user grant opens a document outside the department.
      !entries.some((e) =>
        e.principalType === "user" && e.principalId === userId && e.effect === "ALLOW" && isDeliberateGrant(e) &&
        ((e.resourceType === "document" && e.resourceId === id) ||
          (e.resourceType === "folder" && folderAncestorIds.includes(e.resourceId)) ||
          (e.resourceType === "department" && departmentAncestorIds.includes(e.resourceId))))
    ) {
      resultMap.set(id, { allowed: false, reason: "Document is outside the active department scope" });
      continue;
    }

    let classifiedGate: ClassifiedVerdict | null = null;
    if (subjectToClassifiedRule && userId && isClassified(doc.securityClassification)) {
      classifiedGate = classifiedVerdict({
        classification: doc.securityClassification,
        ownerId: doc.ownerId,
        userId,
        documentDepartmentId: doc.departmentId,
        memberDepartmentIds: memberDepartmentIdsForRule,
        isDepartmentHead: isHead,
        hasDeliberateGrant: entries.some((e) =>
          e.resourceType === "document" && e.resourceId === id && e.principalId === userId && isDeliberateDocumentGrant(e)),
        letterBacked: letterBackedForRule.has(id),
      });
      if (classifiedGate === "closed") {
        resultMap.set(id, { allowed: false, reason: CLASSIFIED_DENY_REASON });
        continue;
      }
    }

    const relevantEntries = entries.filter(e =>
      (e.resourceType === "document" && e.resourceId === id) ||
      (e.resourceType === "folder" && folderAncestorIds.includes(e.resourceId)) ||
      (e.resourceType === "department" && departmentAncestorIds.includes(e.resourceId))
    );

    const scopedEntries = tenantWideDocumentRead
      ? relevantEntries
      : relevantEntries.filter((entry) => !(
        permission === PERMISSIONS.DOCUMENT_READ &&
        entry.principalType === "role" &&
        entry.effect === "ALLOW" &&
        (entry.resourceType === "document" || entry.resourceType === "folder")
      ));
    let result = resolveFromEntries(scopedEntries, "document", id, folderAncestorIds, departmentAncestorIds, userId, roles, userDepartmentIds);

    if (!result.effect) {
      const relevantRules = accessRules.filter(r => !r.documentTypeId || r.documentTypeId === doc.documentTypeId);
      const rulesResult = resolveFromAccessRules(
        tenantWideDocumentRead || permission !== PERMISSIONS.DOCUMENT_READ
          ? relevantRules
          : relevantRules.filter((rule) => !(rule.principalType === "role" && rule.effect === "ALLOW")),
      );
      if (rulesResult) result = rulesResult;
    }

    if (classifiedGate === "head" && userId && result.effect !== "DENY") {
      result = {
        allowed: true,
        effect: "ALLOW",
        principalType: "user",
        principalId: userId,
        reason: "Department head reads a CONFIDENTIAL document of the department",
      };
    }

    if (!result.effect && tenantWideDocumentRead) {
      result = {
        allowed: true,
        effect: "ALLOW",
        principalType: "role",
        principalId: options.userRole,
        reason: "Active role has DOCUMENT_READ_ALL",
      };
    }

    resultMap.set(id, result);
    // A classified document's result is never cached: its class is read live (classifiedAccess.ts).
    if (!classifiedGate) {
      cacheResolution(tenantId, "document", id, userId, roles, permission, result).catch(
        err => logger.warn({ err }, "Failed to cache ACL resolution")
      );
    }
  }

  }

  // The output document must pass its own ACL and the ACL of every source
  // document. This is deliberately post-cache so a cached output allow cannot
  // bypass a source ACL change.
  for (const [compiledId, sourceIds] of compiledSources) {
    const constrained = await constrainCompiledBundleResult(
      resultMap.get(compiledId) ?? { allowed: false, reason: "No matching ACL entry" },
      sourceIds,
      options,
      depth,
    );
    resultMap.set(compiledId, constrained);
  }

  return resultMap;
}

/**
 * Middleware to enforce ACL check on a protected route.
 * Must follow requirePermission middleware.
 * Usage: router.get("/documents/:id", authenticate, tenantContext, requirePermission(PERMISSIONS.DOCUMENT_READ), requireACL(...), handler)
 */
export function requireACL(options: Omit<AclCheckOptions, 'resourceId'> & { resourceId?: string; paramName?: string }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError(401, "ERR-AUTH-REQUIRED", "Authentication required");
    }

    // §1: permission-based super-admin bypass via ACL_BYPASS_ADMIN
    // Check if the user has ACL_BYPASS_ADMIN in their effective permission set
    if (req.user.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) {
      next();
      return;
    }

    try {
      const paramKey = options.paramName ?? "id";
      const resourceId = options.resourceId || String(req.params[paramKey]);

      const result = await resolveACL({
        ...options,
        userId: req.user.userId,
        userRole: req.user.role,
        userRoles: req.user.roles,
        userPermissions: req.user.permissions,
        tenantId: req.user.tenantId,
        resourceId
      });

      if (result.allowed) {
        next();
      } else {
        const errCode = result.effect === "DENY" ? "AUTHZ_ACL_DENIED" : "AUTHZ_ACL_NO_ENTRY";
        const errMessage = result.effect === "DENY" ? "Access denied by ACL" : "No access control entry for this resource";
        // audit 2026-08-11 data-flow sweep #3: requirePermission's
        // RBAC denial writes AUTHZ_ROLE_DENIED (auth.ts) — this ACL DENY-first
        // path, the more security-critical mechanism per the prior audit's
        // finding #2 on this exact code, never audited a denial at all.
        writeAuditLog({
          eventType: errCode === "AUTHZ_ACL_DENIED" ? AUDIT_EVENTS.AUTHZ_ACL_DENIED : AUDIT_EVENTS.AUTHZ_ACL_NO_ENTRY,
          userId: req.user.userId,
          userRole: req.user.role,
          tenantId: req.user.tenantId,
          documentId: options.resourceType === "document" ? resourceId : null,
          sourceIp: req.ip ?? null,
          actionDetails: { resourceType: options.resourceType, resourceId, permission: options.permission, method: req.method, path: req.originalUrl },
          isSuccess: false,
          errorCode: errCode,
        }).catch((err) => logger.warn({ err }, "Failed to write ACL denial audit log"));
        throw new AppError(403, errCode, errMessage);
      }
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        logger.error({ error, resourceType: options.resourceType, resourceId: options.resourceId }, "ACL resolution error");
        next(new AppError(500, "ERR-ACL-RESOLUTION", "Failed to resolve access control"));
      }
    }
  };
}

/**
 * Helper to resolve ACL for a user (for non-middleware contexts like service layers).
 * Throws AppError on denial, returns void on allow.
 *
 * Delegates to resolveACL so service-layer checks apply the SAME semantics as
 * the route middleware: folder/department ancestry (an inherited parent DENY
 * beats a local ALLOW), access_rules, and expiry. A previous implementation
 * checked direct entries only, silently bypassing inherited DENYs
 * (gap register / recommendations §10.1).
 *
 * @param userRoleOrRoles - The user's display role (legacy single-role callers) OR their
 *   full assigned-role array (req.user.roles) — pass the array so a DENY on a
 *   non-display role is actually evaluated (see AclCheckOptions.userRoles).
 * @param userPermissions - The user's effective permission set (pre-computed union of all roles)
 */
export async function assertACLAllow(
  userId: string,
  userRoleOrRoles: string | string[],
  tenantId: string,
  options: AclCheckOptions,
  userPermissions?: string[]
): Promise<void> {
  // §1: permission-based super-admin bypass via ACL_BYPASS_ADMIN
  if (userPermissions && userPermissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) {
    return;
  }

  const userRoles = Array.isArray(userRoleOrRoles) ? userRoleOrRoles : [userRoleOrRoles];
  const result = await resolveACL({
    ...options,
    userRole: userRoles[0],
    userRoles,
    userPermissions,
    tenantId,
    userId,
  });
  if (!result.allowed) {
    const errCode = result.effect === "DENY" ? "AUTHZ_ACL_DENIED" : "AUTHZ_ACL_NO_ENTRY";
    // Same denial-audit gap as requireACL above, for the service-layer variant.
    writeAuditLog({
      eventType: errCode === "AUTHZ_ACL_DENIED" ? AUDIT_EVENTS.AUTHZ_ACL_DENIED : AUDIT_EVENTS.AUTHZ_ACL_NO_ENTRY,
      userId,
      userRole: userRoles[0],
      tenantId,
      documentId: options.resourceType === "document" ? options.resourceId : null,
      actionDetails: { resourceType: options.resourceType, resourceId: options.resourceId, permission: options.permission },
      isSuccess: false,
      errorCode: errCode,
    }).catch((err) => logger.warn({ err }, "Failed to write ACL denial audit log"));
    if (result.effect === "DENY") {
      throw new AppError(403, "AUTHZ_ACL_DENIED", "Access denied by ACL");
    }
    throw new AppError(403, "AUTHZ_ACL_NO_ENTRY", "No access control entry for this resource");
  }
}
