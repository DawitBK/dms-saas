// SPRINT-2: convert document type routes from role checks to permission middleware and ACL-aware guards.
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { AppError } from "../../core/AppError.js";
import { DocumentType } from "../../infrastructure/database/index.js";
import { assertCanManageDepartment, hasTenantWideStructureAuthority, type ScopeActor } from "../../shared/orgScope.js";
import { getVisibleDepartmentIds, getVisibleOrgUnitIds } from "../departments/departments.service.js";
import {
  createDocumentType,
  deactivateDocumentType,
  getDocumentType,
  listDocumentTypes,
  listDocumentTypesForDepartment,
  updateDocumentType
} from "./documentTypes.service.js";

export const documentTypeRoutes = Router();
// Access Control (ACL_MANAGE) needs this as a lookup for its document-type
// picker — same "admin permission shouldn't block a legitimate picker use
// case" rationale as departments.routes.ts's GET / fix.
//
// FIX 2026-09-23: scoping used to be OPT-IN via `?scope=mine`, defaulting to
// the full tenant-wide list for any caller that didn't pass it — same class
// of bug as departments.routes.ts's GET / (see its FIX comment for the live
// confirmation). Scoping is now the DEFAULT; `?scope=mine` is still accepted
// as a harmless no-op for existing callers. ACL_BYPASS_ADMIN or
// DOCUMENT_READ_ALL (RECORDS_OFFICER/AUDITOR oversight) still get the
// unfiltered list.
documentTypeRoutes.get("/", requireAnyPermission(PERMISSIONS.DOCTYPE_READ, PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const perms = req.user!.permissions;
  const scoped = !(perms.includes(PERMISSIONS.ACL_BYPASS_ADMIN) || perms.includes(PERMISSIONS.DOCUMENT_READ_ALL));
  // Org-unit-scoped types (see the tri-level DocumentType.orgUnitId scope)
  // need the caller's visible ORG UNITS too, not just their departments — a
  // type scoped to "all of ELLENI" should show up for anyone who can see any
  // department under ELLENI, even one who isn't a member of every one of them.
  const [visibleDepartmentIds, visibleOrgUnitIds] = scoped
    ? await Promise.all([
        getVisibleDepartmentIds(req.user!.tenantId, req.user!.userId),
        getVisibleOrgUnitIds(req.user!.tenantId, req.user!.userId),
      ])
    : [undefined, undefined];
  // ?includeInactive=true is honoured only for someone who may manage types (the re-activate list).
  const includeInactive = req.query.includeInactive === 'true' && perms.includes(PERMISSIONS.DOCTYPE_MANAGE);
  const data = await listDocumentTypes(req.user!.tenantId, visibleDepartmentIds, visibleOrgUnitIds, includeInactive);
  res.json({ data });
}));

// Phase 3: Get document types for specific department (query param: ?departmentId=xxx)
documentTypeRoutes.get("/for-department", requirePermission(PERMISSIONS.DOCTYPE_READ), asyncHandler(async (req, res) => {
  const departmentId = req.query.departmentId as string | undefined;
  const data = await listDocumentTypesForDepartment(req.user!.tenantId, departmentId || null);
  res.json({ data });
}));

// WRITE scope. doctype:manage lets a caller define the classification taxonomy;
// WHERE a type applies is part of that. Organisation administrators and records
// staff (document:read_all — the filing-plan owners, RECORDS_OFFICER by default)
// may define tenant-wide, org-unit and department types. Anyone else who has been
// granted doctype:manage (a department manager in a tenant that chose to) is
// limited to types scoped to a department they head: a department-scoped type
// can never reach another department's documents, and cannot be widened.
function isTenantWideDocTypeAuthority(actor: ScopeActor): boolean {
  return hasTenantWideStructureAuthority(actor) || (actor.permissions ?? []).includes(PERMISSIONS.DOCUMENT_READ_ALL);
}

async function assertDocTypeScopeAllowed(
  actor: ScopeActor,
  scope: { departmentId?: string | null; orgUnitId?: string | null },
) {
  if (isTenantWideDocTypeAuthority(actor)) return;
  if (!scope.departmentId || scope.orgUnitId) {
    throw new AppError(403, "ERR-DOCTYPE-SCOPE", "You can only manage document types scoped to a department you manage");
  }
  await assertCanManageDepartment(actor, scope.departmentId);
}

documentTypeRoutes.post("/", requirePermission(PERMISSIONS.DOCTYPE_MANAGE), asyncHandler(async (req, res) => {
  await assertDocTypeScopeAllowed(req.user!, { departmentId: req.body?.departmentId, orgUnitId: req.body?.orgUnitId });
  res.status(201).json(await createDocumentType(req.body, req.user!.userId, req.user!.tenantId));
}));
documentTypeRoutes.get("/:id", requirePermission(PERMISSIONS.DOCTYPE_READ), asyncHandler(async (req, res) => res.json(await getDocumentType(String(req.params.id), req.user!.tenantId))));
documentTypeRoutes.patch("/:id", requirePermission(PERMISSIONS.DOCTYPE_MANAGE), asyncHandler(async (req, res) => {
  if (!isTenantWideDocTypeAuthority(req.user!)) {
    const row = await DocumentType.findOne({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } });
    if (!row) throw new AppError(404, "ERR-DOCTYPE-NOT-FOUND", "Document type not found");
    await assertDocTypeScopeAllowed(req.user!, { departmentId: row.departmentId, orgUnitId: row.orgUnitId });
    // The scope this edit would leave behind must also be inside the caller's departments.
    await assertDocTypeScopeAllowed(req.user!, {
      departmentId: req.body?.departmentId !== undefined ? req.body.departmentId : row.departmentId,
      orgUnitId: req.body?.orgUnitId !== undefined ? req.body.orgUnitId : row.orgUnitId,
    });
  }
  res.json(await updateDocumentType(String(req.params.id), req.body, req.user!.userId, req.user!.tenantId));
}));
documentTypeRoutes.delete("/:id", requirePermission(PERMISSIONS.DOCTYPE_MANAGE), asyncHandler(async (req, res) => {
  if (!isTenantWideDocTypeAuthority(req.user!)) {
    const row = await DocumentType.findOne({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } });
    if (!row) throw new AppError(404, "ERR-DOCTYPE-NOT-FOUND", "Document type not found");
    await assertDocTypeScopeAllowed(req.user!, { departmentId: row.departmentId, orgUnitId: row.orgUnitId });
  }
  res.json(await deactivateDocumentType(String(req.params.id), req.user!.userId, req.user!.tenantId));
}));
