// SPRINT-2/4: folder routes need permission middleware first, then ACL and lifecycle guard alignment.
import { Router } from "express";
import { QueryTypes } from "sequelize";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { requireACL } from "../../shared/resolveACL.js";
import { getManagedDepartmentIds } from "../../shared/orgScope.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { FolderNode, sequelize } from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import {
  createFolder,
  updateFolder,
  deactivateFolder,
  listInactiveFolders,
  reactivateFolder,
  getFolderContents,
  getDepartmentFolderWithChildren,
  listReadableFolders,
  isFolderReadable
} from "./folders.service.js";

// GET /:id and /:id/contents used to be gated by requireACL({ resourceType:
// "folder", permission: "folder:read" }), which only ever grants on an
// EXPLICIT AclEntry row (or its ACL_BYPASS_ADMIN bypass) — it has no
// department-membership grant for folders. No folder ever gets an explicit
// ACL row just for being a department's or organisation's root, so this
// 403'd on folders GET /folders/tree and GET /folders themselves list as
// navigable (via listReadableFolders's department-subtree + ancestor-pull-in
// rules) — including a user's OWN department folder. Reusing
// isFolderReadable (built on the exact same listReadableFolders visibility
// set, so DENY entries are still respected) keeps "what's listed as
// clickable" and "what's actually enterable" consistent.
function requireFolderReadable() {
  return asyncHandler(async (req, _res, next) => {
    const folderId = String(req.params.id);
    const readable = await isFolderReadable(folderId, req.user!);
    if (!readable) {
      writeAuditLog({
        eventType: AUDIT_EVENTS.AUTHZ_ACL_NO_ENTRY,
        userId: req.user!.userId,
        userRole: req.user!.role,
        tenantId: req.user!.tenantId,
        sourceIp: req.ip ?? null,
        actionDetails: { resourceType: "folder", resourceId: folderId, permission: "folder:read", method: req.method, path: req.originalUrl },
        isSuccess: false,
        errorCode: "AUTHZ_ACL_NO_ENTRY",
      }).catch(() => {});
      throw new AppError(403, "AUTHZ_ACL_NO_ENTRY", "No access control entry for this resource");
    }
    next();
  });
}

// Renaming/moving a folder: the folder's own ACL (folder:update) as always, OR
// being a department head over the folder's department. Folder ACL rows are only
// ever written by an administrator (or copied down from a parent that has them),
// so without the second path a department manager could CREATE folders in their
// department but never fix a typo in one. department:manage + membership of the
// folder's department (or one above it) is the same authority that lets them
// create it. updateFolder still checks the destination department on a move.
function requireFolderUpdateAccess() {
  const aclGate = requireACL({ resourceType: "folder", permission: "folder:update" });
  return asyncHandler(async (req, res, next) => {
    if (req.user!.permissions.includes(PERMISSIONS.DEPT_MANAGE)) {
      const folder = await FolderNode.findOne({
        where: { id: String(req.params.id), tenantId: req.user!.tenantId, isActive: true },
        attributes: ["departmentId"],
      });
      if (folder?.departmentId) {
        const managed = await getManagedDepartmentIds(req.user!.tenantId, req.user!.userId);
        if (managed.has(folder.departmentId)) {
          next();
          return;
        }
      }
    }
    await aclGate(req, res, next);
  });
}

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Middleware to validate UUID format in route parameters
function validateUUIDParam(paramName: string) {
  return (req: any, _res: any, next: any) => {
    const id = req.params[paramName];
    if (id && !UUID_REGEX.test(id)) {
      throw new AppError(400, 'ERR-INVALID-ID-FORMAT', `Invalid ${paramName} format. Must be a valid UUID.`);
    }
    next();
  };
}

export const folderRoutes = Router();

// Access Control (ACL_MANAGE) needs this as a lookup for its folder picker —
// same "admin permission shouldn't block a legitimate picker use case"
// rationale as departments.routes.ts's GET / fix.
folderRoutes.get("/tree", requireAnyPermission(PERMISSIONS.FOLDER_READ, PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  // H5: scoped to folders the user may read (dept subtree + explicit grants +
  // navigational ancestors), not every folder in the tenant.
  const folders = await listReadableFolders(req.user!);
  res.json({ data: folders });
}));

folderRoutes.get("/", requirePermission(PERMISSIONS.FOLDER_READ), asyncHandler(async (req, res) => {
  const rawParentId = req.query.parentId;
  const parentId = rawParentId === "null" || rawParentId === undefined ? null : String(rawParentId);

  // Validate parentId if provided
  if (parentId && !UUID_REGEX.test(parentId)) {
    throw new AppError(400, 'ERR-INVALID-PARENT-ID', 'Invalid parentId format. Must be a valid UUID.');
  }

  const folders = await listReadableFolders(req.user!, { parentId, scoped: true });
  res.json({ data: folders });
}));

folderRoutes.post("/", requirePermission(PERMISSIONS.FOLDER_CREATE), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await createFolder(req.body, req.user!.userId, req.user!.tenantId, req.user!.permissions) });
}));

// Resolves (auto-provisioning if missing) the folder bound to a department and
// its direct category-folder children. Departments created before folder
// auto-provisioning existed self-heal the first time this is called.
folderRoutes.get("/department/:departmentId", validateUUIDParam('departmentId'), requirePermission(PERMISSIONS.FOLDER_READ), asyncHandler(async (req, res) => {
  const data = await getDepartmentFolderWithChildren(String(req.params.departmentId), req.user!);
  res.json({ data });
}));

folderRoutes.get("/:id", validateUUIDParam('id'), requirePermission(PERMISSIONS.FOLDER_READ), requireFolderReadable(), asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const folder = await FolderNode.findOne({ where: { id, tenantId: req.user!.tenantId } });
  if (!folder) {
    res.status(404).json({ error: { code: "ERR-FOLDER-NOT-FOUND", message: "Folder not found" } });
    return;
  }
  // Perf audit 2026-08-13: was one FolderNode.findOne per ancestor level,
  // awaited sequentially — a folder N levels deep cost N serial round trips.
  // Single recursive CTE instead, matching the department-tree CTE pattern
  // already used in folders.service.ts's listReadableFolders.
  const ancestorRows = await sequelize.query<{ id: string; name: string; path: string; level: number }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, name, path, level, parent_id
       FROM folder_nodes
       WHERE id = :parentId AND tenant_id = :tenantId
       UNION ALL
       SELECT f.id, f.name, f.path, f.level, f.parent_id
       FROM folder_nodes f
       JOIN ancestors a ON f.id = a.parent_id
     )
     SELECT id, name, path, level FROM ancestors ORDER BY level ASC`,
    {
      replacements: { parentId: folder.parentId, tenantId: req.user!.tenantId },
      type: QueryTypes.SELECT,
    },
  );
  const ancestors = ancestorRows;
  // FIX: this used to be an unscoped FolderNode.findAll — it listed every
  // child folder's name/path regardless of whether the caller could actually
  // open it (e.g. a Dept Manager saw all 9 department names under the
  // organisation folder, not just their own). listReadableFolders already
  // computes exactly "children of this parent the actor may read" for the
  // tree/list endpoints; reusing it here keeps what's shown consistent with
  // what's actually enterable. Oversight (ACL_BYPASS_ADMIN) users see
  // everything, same as before.
  const children = await listReadableFolders(req.user!, { parentId: id, scoped: true });
  res.json({ data: { folder, ancestors, children } });
}));

folderRoutes.get("/:id/contents", validateUUIDParam('id'), requirePermission(PERMISSIONS.FOLDER_READ), requireFolderReadable(), asyncHandler(async (req, res) => {
  const contents = await getFolderContents(String(req.params.id), req.user!);
  res.json({ data: contents });
}));

folderRoutes.patch("/:id", validateUUIDParam('id'), requirePermission(PERMISSIONS.FOLDER_CREATE), requireFolderUpdateAccess(), asyncHandler(async (req, res) => {
  res.json({ data: await updateFolder(String(req.params.id), req.body, req.user!) });
}));

// Deactivated folders and bringing one back (same FOLDER_DELETE right as deactivating; scope is checked in the service).
folderRoutes.get("/inactive", requirePermission(PERMISSIONS.FOLDER_DELETE), asyncHandler(async (req, res) => {
  res.json({ data: await listInactiveFolders(req.user!) });
}));

folderRoutes.post("/:id/activate", validateUUIDParam('id'), requirePermission(PERMISSIONS.FOLDER_DELETE), asyncHandler(async (req, res) => {
  res.json({ data: await reactivateFolder(String(req.params.id), req.user!) });
}));

folderRoutes.delete("/:id", validateUUIDParam('id'), requirePermission(PERMISSIONS.FOLDER_DELETE), requireACL({ resourceType: "folder", permission: "folder:delete" }), asyncHandler(async (req, res) => {
  res.json({ data: await deactivateFolder(String(req.params.id), req.user!) });
}));

