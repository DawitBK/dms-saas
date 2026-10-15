// SPRINT-2: convert department routes from role checks to permission middleware and ACL-aware guards.
import { Router, type Request } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { AppError } from "../../core/AppError.js";
import { Department } from "../../infrastructure/database/index.js";
import {
  assertCanManageDepartment,
  assertCanRestructureDepartment,
  assertTenantWideStructureAuthority,
  hasTenantWideStructureAuthority,
} from "../../shared/orgScope.js";
import {
  createDepartment,
  deactivateDepartment,
  getDepartment,
  getVisibleDepartmentIds,
  listDepartmentTree,
  listDepartments,
  moveDepartment,
  updateDepartment
} from "./departments.service.js";

export const departmentRoutes = Router();

// Department LISTING is navigational: the hierarchy is Tenant -> OrgUnit ->
// Department -> Folder, so anyone who can read folders or documents must be able
// to see the department containers they sit in, even without department:read
// (which is the department *admin* permission). Same "don't let a strict admin
// permission block a legitimate navigation/picker use case" fix pattern as the
// approvals/e-signing assignable-users endpoints. The DEPT_MANAGE writes below
// are unchanged.
//
// FIX 2026-09-23: scoping used to be OPT-IN via `?scope=mine` (added
// 2026-09-12), defaulting to the full tenant-wide list for any caller that
// didn't explicitly pass it — meaning a plain DEPT_MANAGER hitting this route
// with no query param (or any caller that simply forgot the param) saw every
// department name in the tenant regardless of membership. Confirmed live:
// a genuine DEPT_MANAGER-only token (no ACL_BYPASS_ADMIN, no DOCUMENT_READ_ALL)
// got back all 11 departments from plain GET /departments. Scoping is now the
// DEFAULT for everyone; `?scope=mine` is kept accepted (harmless no-op) only
// so existing callers that still pass it keep working unchanged. Only
// ACL_BYPASS_ADMIN — real oversight — gets the unfiltered list, same bypass
// every other picker in this app already honors.
async function resolveVisibleIds(req: Request): Promise<Set<string> | undefined> {
  // DOCUMENT_READ_ALL (RECORDS_OFFICER/AUDITOR oversight, see
  // documents.service.ts's buildReadScope) is included alongside
  // ACL_BYPASS_ADMIN so records/audit staff who can already see every
  // document tenant-wide aren't newly blind to the department names those
  // documents sit under.
  const perms = req.user!.permissions;
  if (perms.includes(PERMISSIONS.ACL_BYPASS_ADMIN) || perms.includes(PERMISSIONS.DOCUMENT_READ_ALL)) return undefined;
  return getVisibleDepartmentIds(req.user!.tenantId, req.user!.userId);
}

departmentRoutes.get("/", requireAnyPermission(PERMISSIONS.DEPT_READ, PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const visibleIds = await resolveVisibleIds(req);
  // ?includeInactive=true (the re-activate list) is honoured only for someone who may manage departments.
  const includeInactive = req.query.includeInactive === "true" && req.user!.permissions.includes(PERMISSIONS.DEPT_MANAGE);
  const data = await listDepartments(req.user!.tenantId, req.query.orgUnitId as string | undefined, visibleIds, includeInactive);
  res.json({ data });
}));
departmentRoutes.get("/tree", requireAnyPermission(PERMISSIONS.DEPT_READ, PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const visibleIds = await resolveVisibleIds(req);
  const data = await listDepartmentTree(req.user!.tenantId, req.query.orgUnitId as string | undefined, visibleIds);
  res.json({ data });
}));
// WRITES are scoped (shared/orgScope.ts): department:manage says the caller may
// administer departments at all, not WHICH. A department manager works inside
// the departments they belong to and everything beneath them — they can add
// sub-departments, edit their own department and its sub-departments, and
// restructure (move/deactivate) the sub-departments below them. They cannot
// touch a sibling or a parent, and cannot create a top-level department; that
// is organisation-level authority (acl:bypass_admin or orgunit:manage).
async function loadDepartmentInTenant(req: Request) {
  const dept = await Department.findOne({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } });
  if (!dept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  return dept;
}

departmentRoutes.post("/", requirePermission(PERMISSIONS.DEPT_MANAGE), asyncHandler(async (req, res) => {
  const parentId = typeof req.body?.parentId === "string" ? req.body.parentId : null;
  if (parentId) await assertCanManageDepartment(req.user!, parentId);
  else assertTenantWideStructureAuthority(req.user!, "creating a top-level department");
  res.status(201).json(await createDepartment(req.body, req.user!.userId, req.user!.tenantId));
}));
departmentRoutes.get("/:id", requirePermission(PERMISSIONS.DEPT_READ), asyncHandler(async (req, res) => {
  // Same visibility the list endpoints apply: a reader sees the departments they
  // belong to / hold a grant on (and their ancestors), not any id they can guess.
  const visibleIds = await resolveVisibleIds(req);
  if (visibleIds && !visibleIds.has(String(req.params.id))) {
    throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");
  }
  res.json(await getDepartment(String(req.params.id), req.user!.tenantId));
}));
departmentRoutes.patch("/:id", requirePermission(PERMISSIONS.DEPT_MANAGE), asyncHandler(async (req, res) => {
  const dept = await loadDepartmentInTenant(req);
  await assertCanManageDepartment(req.user!, String(req.params.id));
  // Taking a department out of service (or bringing it back) is a restructure
  // decision for its parent, exactly like DELETE — not a field a head edits.
  if (req.body?.isActive !== undefined) await assertCanRestructureDepartment(req.user!, dept);
  // Re-homing a department under another org unit is an organisation-level change.
  // Sending the unchanged value is not a move (the edit form always sends the whole form).
  if (req.body?.orgUnitId !== undefined && req.body.orgUnitId === dept.orgUnitId) delete req.body.orgUnitId;
  if (req.body?.orgUnitId !== undefined && !hasTenantWideStructureAuthority(req.user!)) {
    assertTenantWideStructureAuthority(req.user!, "moving a department to another organisational unit");
  }
  res.json(await updateDepartment(String(req.params.id), req.body, req.user!.userId, req.user!.tenantId));
}));
departmentRoutes.patch("/:id/move", requirePermission(PERMISSIONS.DEPT_MANAGE), asyncHandler(async (req, res) => {
  const dept = await loadDepartmentInTenant(req);
  await assertCanRestructureDepartment(req.user!, dept);
  const destination = typeof req.body?.parentId === "string" ? req.body.parentId : null;
  if (destination) await assertCanManageDepartment(req.user!, destination);
  else assertTenantWideStructureAuthority(req.user!, "making a department top-level");
  res.json(await moveDepartment(String(req.params.id), req.body, req.user!.userId, req.user!.tenantId));
}));
departmentRoutes.delete("/:id", requirePermission(PERMISSIONS.DEPT_MANAGE), asyncHandler(async (req, res) => {
  const dept = await loadDepartmentInTenant(req);
  await assertCanRestructureDepartment(req.user!, dept);
  res.json(await deactivateDepartment(String(req.params.id), req.user!.userId, req.user!.tenantId));
}));
