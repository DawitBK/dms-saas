import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import type { Transaction } from "sequelize";
import { Department, OrgUnit, UserDepartment, Document, AclEntry, FolderNode } from "../../infrastructure/database/index.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { AppError } from "../../core/AppError.js";
import { invalidateTenantACL } from "../../infrastructure/cache/aclCache.js";
import { runInTransaction } from "../../shared/transaction.js";
import { logger } from "../../core/logger.js";
import { getOrCreateDepartmentFolder } from "../folders/folders.service.js";
import { getCachedUserDepartments, cacheUserDepartments, loadUserDepartmentIds } from "../../infrastructure/cache/userDeptCache.js";

const departmentSchema = z.object({
  orgUnitId: z.string().uuid(),
  code: z.string().min(2).max(10),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  parentId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional()
});

const departmentMoveSchema = z.object({
  parentId: z.string().uuid().nullable()
});

type DepartmentTreeItem = {
  id: string;
  tenantId: string;
  orgUnitId: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  path: string | null;
  level: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DepartmentNode = DepartmentTreeItem & {
  children: DepartmentNode[];
};

function toLtreeLabel(id: string) {
  return `d_${id.replace(/-/g, "_")}`;
}

function buildDepartmentPath(parentPath: string | null | undefined, id: string) {
  const segment = toLtreeLabel(id);
  return parentPath ? `${parentPath}.${segment}` : segment;
}

function getDepartmentLevel(parentLevel: number | null | undefined) {
  return parentLevel == null ? 0 : parentLevel + 1;
}

async function getDepartmentOrThrow(id: string, tenantId: string, transaction?: Transaction) {
  const dept = await Department.findOne({ where: { id, tenantId }, transaction });
  if (!dept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  return dept;
}

async function getOrgUnitOrThrow(id: string, tenantId: string, transaction?: Transaction) {
  const unit = await OrgUnit.findOne({ where: { id, tenantId }, transaction });
  if (!unit) throw new AppError(422, "ERR-ORG-UNIT-INVALID", "Organizational unit not found");
  if (!unit.isActive) throw new AppError(409, "ERR-ORG-UNIT-INACTIVE", "Organizational unit is inactive");
  return unit;
}

async function recomputeSubtreePaths(
  tenantId: string,
  rootId: string,
  transaction: Transaction
) {
  const departments = await Department.findAll({
    where: { tenantId },
    order: [["createdAt", "ASC"]],
    transaction
  });

  const byId = new Map(departments.map((dept) => [dept.id, dept]));
  const childrenByParent = new Map<string | null, typeof departments>();
  for (const dept of departments) {
    const key = dept.parentId ?? null;
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(dept);
    childrenByParent.set(key, siblings);
  }

  const root = byId.get(rootId);
  if (!root) {
    throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  }

  const parent = root.parentId ? byId.get(root.parentId) : null;
  const rootPath = buildDepartmentPath(parent?.path ?? null, root.id);
  const rootLevel = getDepartmentLevel(parent?.level ?? null);

  const queue: Array<{ id: string; path: string; level: number }> = [
    { id: root.id, path: rootPath, level: rootLevel }
  ];

  // FIX (Finding 16): `queue.shift()` is O(n) per call (every remaining
  // element shifts down one index), making the whole BFS O(n^2) on subtree
  // size. An index cursor walks the same array left-to-right in O(1) per
  // step instead of mutating it.
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    await Department.update(
      { path: current.path, level: current.level },
      { where: { id: current.id, tenantId }, transaction }
    );

    const children = childrenByParent.get(current.id) ?? [];
    for (const child of children) {
      queue.push({
        id: child.id,
        path: buildDepartmentPath(current.path, child.id),
        level: current.level + 1
      });
    }
  }
}

// Hierarchy-tree scoping (2026-09-12 fix): GET /departments and GET /org-units
// stay unfiltered by default on purpose (see departments.routes.ts's own
// comment — they're the shared navigational picker Browse, the ACL admin
// panel, and Upload/Signing's own client-side-filtered dropdowns all read
// from). This is an OPT-IN narrowing, applied only when a caller explicitly
// asks for it via `?scope=mine` — today that's exactly and only
// HierarchyTreeBrowser's Browse-sidebar usage (`scopeToViewer` prop), so the
// Operations "Hierarchy Browser" full-CRUD usage and every other consumer of
// these two endpoints is unaffected without passing anything.
//
// "Visible" means: a department the user actually belongs to (UserDepartment),
// one they hold an explicit ACL grant on (an AclEntry ALLOW targeting that
// department resource directly, or a folder inside it), or an ancestor of
// either — so the tree renders an unbroken path down to what the user can
// actually see instead of a dangling orphan node with no visible parent.
// ACL_BYPASS_ADMIN holders never get here (route layer returns everything).

/** Same cache-then-DB pattern as resolveACL.ts / documents.service.ts's own
 *  local copies — not centralized further, per that established convention. */
async function getUserDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const cached = await getCachedUserDepartments(tenantId, userId);
  if (cached) return cached;
  const departmentIds = await loadUserDepartmentIds(tenantId, userId);
  await cacheUserDepartments(tenantId, userId, departmentIds);
  return departmentIds;
}

async function getAclGrantedDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const now = new Date();
  const [deptGrants, folderGrants] = await Promise.all([
    AclEntry.findAll({
      where: { tenantId, resourceType: "department", principalType: "user", principalId: userId, effect: "ALLOW" },
      attributes: ["resourceId", "expiresAt"],
    }),
    AclEntry.findAll({
      where: { tenantId, resourceType: "folder", principalType: "user", principalId: userId, effect: "ALLOW" },
      attributes: ["resourceId", "expiresAt"],
    }),
  ]);
  const notExpired = (e: { expiresAt: Date | null }) => !e.expiresAt || new Date(e.expiresAt) > now;
  const directDeptIds = deptGrants.filter(notExpired).map((e) => e.resourceId);

  const folderIds = folderGrants.filter(notExpired).map((e) => e.resourceId);
  const folderDeptIds = folderIds.length
    ? (await FolderNode.findAll({ where: { id: { [Op.in]: folderIds } }, attributes: ["departmentId"] }))
        .map((f) => f.departmentId)
        .filter((id): id is string => Boolean(id))
    : [];

  return [...directDeptIds, ...folderDeptIds];
}

/** Walks parentId chains upward (in-memory over the tenant's department set —
 *  a few hundred rows at most, same order of magnitude resolveACL's own dept
 *  CTE walks) so a granted/member department deep in the tree still renders
 *  with its full ancestor path, not as an orphaned root. */
async function withDepartmentAncestors(tenantId: string, departmentIds: string[]): Promise<Set<string>> {
  const result = new Set(departmentIds);
  if (departmentIds.length === 0) return result;
  const all = await Department.findAll({ where: { tenantId }, attributes: ["id", "parentId"] });
  const parentById = new Map(all.map((d) => [d.id, d.parentId]));
  for (const id of departmentIds) {
    let current = parentById.get(id) ?? null;
    let guard = 0;
    while (current && !result.has(current) && guard++ < 100) {
      result.add(current);
      current = parentById.get(current) ?? null;
    }
  }
  return result;
}

/** Full visible-department set for `?scope=mine` — membership ∪ ACL grants
 *  (direct department or via a folder inside one) ∪ ancestors of either.
 *  Empty set means "hide the whole tree" — the user belongs to nothing and
 *  holds no grant, which is the correct default per the platform's decision
 *  that this tree hides anything the viewer has no relationship to. */
export async function getVisibleDepartmentIds(tenantId: string, userId: string): Promise<Set<string>> {
  const [memberIds, aclIds] = await Promise.all([
    getUserDepartmentIds(tenantId, userId),
    getAclGrantedDepartmentIds(tenantId, userId),
  ]);
  const direct = Array.from(new Set([...memberIds, ...aclIds]));
  return withDepartmentAncestors(tenantId, direct);
}

/** Org units are flat siblings with no ACL resource type of their own (see
 *  AclResourceType) — an org unit is "visible" purely because it contains at
 *  least one visible department. */
export async function getVisibleOrgUnitIds(tenantId: string, userId: string): Promise<Set<string>> {
  const deptIds = await getVisibleDepartmentIds(tenantId, userId);
  if (deptIds.size === 0) return new Set();
  const depts = await Department.findAll({ where: { id: { [Op.in]: Array.from(deptIds) } }, attributes: ["orgUnitId"] });
  return new Set(depts.map((d) => d.orgUnitId));
}

export async function listDepartments(tenantId: string, orgUnitId?: string, visibleIds?: Set<string>, includeInactive = false) {
  if (visibleIds && visibleIds.size === 0) return [];
  return Department.findAll({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      tenantId,
      ...(orgUnitId ? { orgUnitId } : {}),
      ...(visibleIds ? { id: { [Op.in]: Array.from(visibleIds) } } : {}),
    },
    order: [["level", "ASC"], ["code", "ASC"]]
  });
}

export async function listDepartmentTree(tenantId: string, orgUnitId?: string, visibleIds?: Set<string>): Promise<DepartmentNode[]> {
  const departments = await listDepartments(tenantId, orgUnitId, visibleIds);
  const nodes: DepartmentNode[] = departments.map((dept) => ({
    ...(dept.get({ plain: true }) as DepartmentTreeItem),
    children: [] as DepartmentNode[]
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots: DepartmentNode[] = [];

  for (const node of nodes) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}

export async function createDepartment(input: unknown, requesterId: string, tenantId: string) {
  const data = departmentSchema.parse(input);

  return runInTransaction(async (transaction) => {
    await getOrgUnitOrThrow(data.orgUnitId, tenantId, transaction);

    let parent: Department | null = null;
    if (data.parentId) {
      parent = await getDepartmentOrThrow(data.parentId, tenantId, transaction);
      if (!parent.isActive) {
        throw new AppError(409, "ERR-DEPT-PARENT-INACTIVE", "Parent department is inactive");
      }
      // Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #6: the ltree parent/path/level tree and
      // the required org_unit_id FK are two independent mechanisms nothing
      // previously cross-checked — a department could nest under a parent
      // from a DIFFERENT org unit while keeping its own org_unit_id, so
      // branch-scoped queries (CAMS letterhead, per-branch dashboards) and
      // tree-scoped queries (folder ACL ancestry, recomputeSubtreePaths)
      // would silently disagree about which OrgUnit it belongs to.
      if (parent.orgUnitId !== data.orgUnitId) {
        throw new AppError(422, "ERR-DEPT-ORG-UNIT-MISMATCH", "A department must belong to the same organizational unit as its parent department");
      }
    }

    // Pre-check for a clean 409 instead of letting the DB's unique
    // (tenant_id, org_unit_id, code) constraint (20260912000001) surface as an
    // unhandled 500 -- this is exactly what happened creating a department
    // under a newly created org unit whose code collided with a
    // same-tenant-but-different-org-unit department (codes are scoped per org
    // unit, not tenant-wide, so this only blocks a real collision within the
    // same org unit).
    const code = data.code.toUpperCase();
    const duplicate = await Department.findOne({
      where: { tenantId, orgUnitId: data.orgUnitId, code },
      transaction
    });
    if (duplicate) {
      throw new AppError(409, "ERR-DEPT-CODE-EXISTS", `A department with code "${code}" already exists in this organizational unit`);
    }

    let dept: Department;
    try {
      dept = await Department.create(
        {
          orgUnitId: data.orgUnitId,
          code,
          name: data.name,
          description: data.description,
          parentId: data.parentId ?? null,
          path: "",
          level: 0,
          isActive: data.isActive ?? true,
          tenantId
        },
        { transaction }
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw new AppError(409, "ERR-DEPT-CODE-EXISTS", `A department with code "${code}" already exists in this organizational unit`);
      }
      throw err;
    }

    await dept.update(
      {
        path: buildDepartmentPath(parent?.path ?? null, dept.id),
        level: getDepartmentLevel(parent?.level ?? null)
      },
      { transaction }
    );

    // Every department needs a bound FolderNode for its category folders to
    // live under (see folders.service.getOrCreateDepartmentFolder) — without
    // this, a newly-created department has no container folder, so the
    // Browse page and the Upload page's folder picker can never find
    // anything for it, and there is nowhere to attach a "New Folder" action.
    await getOrCreateDepartmentFolder(tenantId, { id: dept.id, name: dept.name, orgUnitId: dept.orgUnitId }, transaction);

    await writeAuditLog({
      eventType: AUDIT_EVENTS.DEPARTMENT_CREATED,
      userId: requesterId,
      actionDetails: {
        deptId: dept.id,
        code: dept.code,
        name: dept.name,
        parentId: dept.parentId
      }
    });

    return dept.reload({ transaction });
  });
}

export async function updateDepartment(id: string, input: unknown, requesterId: string, tenantId: string) {
  const data = departmentSchema.omit({ parentId: true }).partial().parse(input);
  const dept = await Department.findOne({ where: { id, tenantId } });
  if (!dept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  if (data.orgUnitId) {
    await getOrgUnitOrThrow(data.orgUnitId, tenantId);
    // Same dual-hierarchy invariant as createDepartment/moveDepartment
    // (Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #6): re-pointing orgUnitId here would
    // otherwise be an equally valid way to desync it from the ltree parent.
    if (dept.parentId) {
      const parent = await getDepartmentOrThrow(dept.parentId, tenantId);
      if (parent.orgUnitId !== data.orgUnitId) {
        throw new AppError(422, "ERR-DEPT-ORG-UNIT-MISMATCH", "A department must belong to the same organizational unit as its parent department");
      }
    }
    const hasChildren = await Department.count({ where: { tenantId, parentId: id } });
    if (hasChildren > 0) {
      throw new AppError(422, "ERR-DEPT-ORG-UNIT-MISMATCH", "Cannot change the organizational unit of a department that has sub-departments");
    }
  }
  if (data.isActive === false && dept.isActive) {
    await assertDepartmentDeactivatable(id, tenantId);
  }
  if (data.isActive === true && !dept.isActive) {
    // Bringing a department back needs a live home: its organisational unit and its parent.
    await getOrgUnitOrThrow(dept.orgUnitId, tenantId);
    if (dept.parentId) {
      const parent = await getDepartmentOrThrow(dept.parentId, tenantId);
      if (!parent.isActive) throw new AppError(409, "ERR-DEPT-PARENT-INACTIVE", "Re-activate the parent department first");
    }
  }
  const code = data.code?.toUpperCase();
  if (code) {
    const duplicate = await Department.findOne({
      where: { tenantId, orgUnitId: data.orgUnitId ?? dept.orgUnitId, code, id: { [Op.ne]: id } }
    });
    if (duplicate) {
      throw new AppError(409, "ERR-DEPT-CODE-EXISTS", `A department with code "${code}" already exists in this organizational unit`);
    }
  }

  let updated: Department;
  try {
    updated = await dept.update({ ...data, code });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new AppError(409, "ERR-DEPT-CODE-EXISTS", `A department with code "${code}" already exists in this organizational unit`);
    }
    throw err;
  }
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DEPARTMENT_UPDATED,
    userId: requesterId,
    actionDetails: { deptId: id, updates: data },
  });
  return updated;
}

export async function moveDepartment(id: string, input: unknown, requesterId: string, tenantId: string) {
  const data = departmentMoveSchema.parse(input);

  const result = await runInTransaction(async (transaction) => {
    const dept = await getDepartmentOrThrow(id, tenantId, transaction);
    const allDepartments = await Department.findAll({ where: { tenantId }, transaction });
    const descendants = allDepartments.filter((candidate) =>
      candidate.path && dept.path && candidate.path.startsWith(`${dept.path}.`)
    );

    if (data.parentId === id) {
      throw new AppError(400, "ERR-DEPT-CYCLE", "Department cannot be its own parent");
    }

    if (data.parentId && descendants.some((candidate) => candidate.id === data.parentId)) {
      throw new AppError(400, "ERR-DEPT-CYCLE", "Department cannot be moved under one of its descendants");
    }

    let parent: Department | null = null;
    if (data.parentId) {
      parent = await getDepartmentOrThrow(data.parentId, tenantId, transaction);
      if (!parent.isActive) {
        throw new AppError(409, "ERR-DEPT-PARENT-INACTIVE", "Parent department is inactive");
      }
      // Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #6: same invariant as createDepartment —
      // reparenting must not move a department (and, transitively, its
      // descendants, which all share its org_unit_id under this invariant)
      // under a destination belonging to a different organizational unit.
      if (parent.orgUnitId !== dept.orgUnitId) {
        throw new AppError(422, "ERR-DEPT-ORG-UNIT-MISMATCH", "Cannot move a department under a parent from a different organizational unit");
      }
    }

    await dept.update({ parentId: data.parentId ?? null }, { transaction });
    await recomputeSubtreePaths(tenantId, id, transaction);

    await writeAuditLog({
      eventType: AUDIT_EVENTS.DEPARTMENT_UPDATED,
      userId: requesterId,
      actionDetails: {
        deptId: id,
        move: true,
        parentId: data.parentId ?? null
      }
    });

    // FIX: reparenting a department changes ACL ancestry for every folder and
    // document underneath it, but nothing used to invalidate the ACL cache
    // here — stale ALLOW/DENY decisions for the whole moved subtree persisted
    // for up to the cache's full TTL. Invalidate after commit, tenant-wide
    // (per-resource invalidation can't reach the whole subtree without walking
    // it, which recomputeSubtreePaths already has to do once as it is).
    //
    // FIX (runInTransaction conversion): this must run via tx.afterCommit, not
    // right after this callback returns — when this reuses the ambient
    // request transaction, the callback resolving no longer means committed
    // (the real commit happens later, at response-finish time — see
    // shared/middleware.ts). afterCommit is the one hook that fires at the
    // true commit point in both the ambient-reuse case and the fresh
    // transaction fallback.
    transaction.afterCommit(() => {
      void invalidateTenantACL(tenantId).catch((err) => {
        logger.warn({ err, tenantId, deptId: id }, "Failed to invalidate tenant ACL cache after department move commit");
      });
    });

    return getDepartment(id, tenantId, transaction);
  });

  return result;
}

export async function getDepartment(id: string, tenantId: string, transaction?: Transaction) {
  const dept = await Department.findOne({ where: { id, tenantId }, transaction });
  if (!dept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  const [userCount, docCount] = await Promise.all([
    UserDepartment.count({ where: { departmentId: id }, transaction }),
    Document.count({ where: { departmentId: id, deletedAt: null, tenantId }, transaction })
  ]);
  return { ...dept.toJSON(), userCount, docCount };
}

/** The preconditions for taking a department out of service: no live
 *  sub-departments and no live documents. Shared by DELETE /departments/:id and
 *  by PATCH { isActive: false } — the PATCH path used to skip them entirely, so
 *  the guard could be sidestepped by editing the flag instead of deleting. */
async function assertDepartmentDeactivatable(id: string, tenantId: string) {
  const activeChildCount = await Department.count({
    where: {
      tenantId,
      parentId: id,
      isActive: true
    }
  });
  if (activeChildCount > 0) {
    throw new AppError(409, "ERR-DEPT-HAS-CHILDREN", "Cannot deactivate a department that still has active sub-departments");
  }

  const activeDocCount = await Document.count({
    where: {
      departmentId: id,
      tenantId,
      deletedAt: null,
      status: { [Op.notIn]: ["CANCELLED", "DISPOSED", "ARCHIVED"] }
    }
  });
  if (activeDocCount > 0)
    throw new AppError(409, "ERR-DEPT-HAS-ACTIVE-DOCS",
      `Cannot deactivate: ${activeDocCount} active document(s) exist in this department`);
}

export async function deactivateDepartment(id: string, requesterId: string, tenantId: string) {
  const dept = await Department.findOne({ where: { id, tenantId } });
  if (!dept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  await assertDepartmentDeactivatable(id, tenantId);

  await dept.update({ isActive: false });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DEPARTMENT_DEACTIVATED,
    userId: requesterId,
    actionDetails: { deptId: id, code: dept.code }
  });
  return dept;
}
