// SPRINT-4: folder lifecycle logic must later respect ACL, sensitivity, and rename-safe storage rules.
import { z } from "zod";
import { Op } from "sequelize";
import { FolderNode, Document, AclEntry, Department, OrgUnit, Tenant, UserDepartment } from "../../infrastructure/database/index.js";
import type { Transaction } from "sequelize";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS, userHasPermission } from "../../config/permissions.js";
import { assertACLAllow, resolveACL } from "../../shared/resolveACL.js";
import { getManagedDepartmentIds, hasTenantWideStructureAuthority } from "../../shared/orgScope.js";
import { UniqueConstraintError, ForeignKeyConstraintError } from "sequelize";
import { invalidateTenantACL } from "../../infrastructure/cache/aclCache.js";
import { getCachedReadableFolders, cacheReadableFolders } from "../../infrastructure/cache/readableFoldersCache.js";
import { runInTransaction } from "../../shared/transaction.js";
import { logger } from "../../core/logger.js";
import { filterDocsByDetailAcl } from "../documents/documents.service.js";
import type { AuthenticatedUser } from "../../shared/auth.js";
import { getCachedUserDepartments, cacheUserDepartments, loadUserDepartmentIds } from "../../infrastructure/cache/userDeptCache.js";

const folderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.union([z.string().uuid(), z.null()]).optional(),
  departmentId: z.union([z.string().uuid(), z.null()]).optional()
});

// Utility to validate UUID format
function isValidUUID(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

type FolderActor = { userId: string; role: string; tenantId: string; permissions?: readonly string[] };

/**
 * Who may SEE every folder in the tenant (browse tree, open any department's
 * folder), as opposed to only their own department subtree.
 *
 * acl:bypass_admin (SYSTEM_ADMIN/PLATFORM_ADMIN) always could. document:read_all
 * is the oversight grant held by RECORDS_OFFICER, AUDITOR and EXECUTIVE — those
 * roles already read every department's documents (documents.service.ts's
 * buildReadScope, departments.routes.ts, orgUnits.routes.ts all honour it), but
 * this tree used to ignore it, so an executive or auditor could search a
 * document yet not browse to the folder it sits in. This is read visibility
 * only: creating or changing folders still goes through
 * assertCanCreateInDepartment / folder ACLs and is NOT widened.
 */
function hasTenantWideFolderView(actor: Pick<FolderActor, "role" | "permissions">): boolean {
  const subject = { role: actor.role, permissions: actor.permissions as never };
  return userHasPermission(subject, PERMISSIONS.ACL_BYPASS_ADMIN)
    || userHasPermission(subject, PERMISSIONS.DOCUMENT_READ_ALL);
}

/**
 * H5: folder listing scoped to what the user may actually read. The tree/list
 * endpoints previously returned every active folder in the tenant (the service
 * even labelled it "isolation bypass"), leaking folder structure across
 * departments. Visible = folders in the user's department subtree, folders with
 * an explicit folder:read ALLOW (user/role), and the ancestor chain of those
 * (so the tree stays navigable) — minus any explicit folder:read DENY. Users
 * with acl:bypass_admin keep full visibility.
 */
export async function listReadableFolders(
  actor: FolderActor,
  opts: { parentId?: string | null; scoped: boolean } = { scoped: false },
): Promise<FolderNode[]> {
  const oversight = hasTenantWideFolderView(actor);

  // Perf: an oversight (acl:bypass_admin) user asking for one level doesn't
  // need the department/ACL/ancestor computation below at all, so skip
  // loading every active folder in the tenant just to filter it down to one
  // parentId in JS.
  if (oversight && opts.scoped) {
    return FolderNode.findAll({
      where: { isActive: true, tenantId: actor.tenantId, parentId: opts.parentId ?? null },
      order: [["level", "ASC"], ["name", "ASC"]],
    });
  }

  // Perf audit 2026-08-13: this is the hot path for every non-admin
  // navigation click (GET /folders/tree, hit by the Browse/Signing/
  // Operations pages' tree components) — the department-subtree CTE +
  // AclEntry lookup + ancestor walk below re-ran from scratch, uncached, on
  // every single call. Cache the resolved visible-folder list per
  // (userId, tenantId); see infrastructure/cache/readableFoldersCache.ts for
  // TTL/invalidation. Oversight users skip straight past this — they don't
  // do the expensive computation in the first place (see `visibleList = all`
  // below), so there's nothing worth caching for them.
  if (!oversight) {
    const cached = await getCachedReadableFolders(actor.userId, actor.tenantId);
    if (cached) {
      const visibleList = cached as FolderNode[];
      if (opts.scoped) {
        const parentId = opts.parentId ?? null;
        return visibleList.filter((f) => (f.parentId ?? null) === parentId);
      }
      return visibleList;
    }
  }

  const all = await FolderNode.findAll({
    where: { isActive: true, tenantId: actor.tenantId },
    order: [["level", "ASC"], ["name", "ASC"]],
  });

  let visibleList = all;
  if (!oversight) {
    // Department subtree the user belongs to.
    const memberDepts = await UserDepartment.findAll({
      where: { userId: actor.userId },
      attributes: ["departmentId"],
      raw: true,
    });
    const rootDeptIds = memberDepts.map((d) => d.departmentId).filter(Boolean) as string[];
    // Membership is DIRECT: belonging to a parent department does not open its sub-departments' folders (owner decision
    // 2026-10-09). A person who needs a sub-department is made a member of it.
    const deptIds: string[] = rootDeptIds;
    const deptSet = new Set(deptIds);

    // Explicit folder ACLs for this user or their roles.
    const roleNames = [...new Set([actor.role, ...(((actor as { roles?: string[] }).roles) ?? [])])].filter(Boolean);
    const principalOr: Record<string, unknown>[] = [{ principalType: "user", principalId: actor.userId }];
    if (roleNames.length > 0) principalOr.push({ principalType: "role", principalId: { [Op.in]: roleNames } });
    // 'department' included alongside 'folder': the Access Control Center's
    // "Department" scope (AccessControlCenter.tsx's GrantAccessForm) writes
    // exactly this resourceType, and resolveACL's detail-view check already
    // honors it for a single folder — without it here, a department-level
    // folder:read grant let a user open a folder by direct link/id but never
    // see it in the Browse tree at all, since this function alone decides
    // what the tree renders. Same fix as documents.service.ts's
    // buildReadScope for the department:document:read case.
    const acls = await AclEntry.findAll({
      where: { resourceType: { [Op.in]: ["folder", "department"] }, permission: PERMISSIONS.FOLDER_READ, [Op.or]: principalOr },
      attributes: ["resourceType", "resourceId", "effect", "expiresAt"],
      raw: true,
    });
    const notExpired = (e: { expiresAt: Date | null }) => !e.expiresAt || new Date(e.expiresAt) > new Date();
    const allowIds = new Set(acls.filter((a) => a.resourceType === "folder" && a.effect === "ALLOW" && notExpired(a)).map((a) => a.resourceId));
    const denyIds = new Set(acls.filter((a) => a.resourceType === "folder" && a.effect === "DENY").map((a) => a.resourceId));
    // Department-level DENY is deliberately not replicated here, same
    // reasoning as buildReadScope: resolveACL only applies a role-scoped
    // department DENY to actual members of that department and never
    // overrides a direct per-folder ALLOW, and isFolderReadable-adjacent
    // detail routes re-check the real resolveACL regardless of what this
    // tree pre-filter includes — this only needs to avoid under-fetching.
    const deptAclAllowIds = new Set(acls.filter((a) => a.resourceType === "department" && a.effect === "ALLOW" && notExpired(a)).map((a) => a.resourceId));

    const byId = new Map(all.map((f) => [f.id, f]));
    const visible = new Set<string>();
    for (const f of all) {
      if (denyIds.has(f.id)) continue;
      if ((f.departmentId && (deptSet.has(f.departmentId) || deptAclAllowIds.has(f.departmentId))) || allowIds.has(f.id)) visible.add(f.id);
    }
    // Pull in ancestors so the visible folders render in a tree.
    for (const id of [...visible]) {
      let cur = byId.get(id)?.parentId ?? null;
      while (cur && !visible.has(cur) && !denyIds.has(cur)) {
        visible.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
    }
    visibleList = all.filter((f) => visible.has(f.id));

    await cacheReadableFolders(
      actor.userId,
      actor.tenantId,
      visibleList.map((f) => f.get({ plain: true })),
    ).catch((err) => logger.warn({ err, userId: actor.userId, tenantId: actor.tenantId }, "Failed to cache readable folders"));
  }

  if (opts.scoped) {
    const parentId = opts.parentId ?? null;
    return visibleList.filter((f) => (f.parentId ?? null) === parentId);
  }
  return visibleList;
}

/**
 * Whether `departmentId` is one the actor
 * belongs to (directly), or the actor has oversight (acl:bypass_admin) — the same
 * department-subtree membership check listReadableFolders and
 * documents.service.ts's buildReadScope already use. Used to gate
 * getDepartmentFolderWithChildren, which previously had NO scoping at all
 * (any authenticated holder of the blanket folder:read permission could
 * query — and auto-provision a folder for — any department in the tenant by
 * guessing/enumerating its id). Checked directly against department
 * membership rather than via isFolderReadable/FolderNode, since the
 * department's bound folder may not exist yet at call time (this function
 * auto-provisions it) — this way the gate holds regardless of provisioning
 * state or read-committed visibility of a folder row created moments ago in
 * an as-yet-uncommitted transaction.
 */
async function isDepartmentReadable(departmentId: string, actor: FolderActor): Promise<boolean> {
  if (hasTenantWideFolderView(actor)) return true;

  // A department-level folder:read ACL ALLOW (the Access Control Center's
  // "Department" scope) grants exactly this, same as listReadableFolders and
  // buildReadScope's department-ACL fix — without it, a user granted that
  // grant but with no actual UserDepartment row could still be refused here.
  //
  // FIX 2026-09-23: also accept DOCUMENT_READ on the same department-scope
  // ACL entry, not just FOLDER_READ. Confirmed live: an admin granted a user
  // 'document:read' on a department via the Access Control Center — which
  // getAclGrantedDepartmentIds (the sidebar's own visibility check) and
  // buildReadScope (the document-listing scope, both in documents/
  // departments.service.ts) already treat as sufficient to show that
  // department and list its documents — yet this function, gating whether
  // the user can actually open/browse the department's folder at all, only
  // recognized FOLDER_READ specifically. The admin's grant UI doesn't
  // require picking both, and in this app's navigation model 'read
  // documents in this department' is meaningless without the ability to
  // browse into it to find them — there's no other route to a specific
  // document short of Search. The three checks now agree.
  const roleNames = [...new Set([actor.role, ...(((actor as { roles?: string[] }).roles) ?? [])])].filter(Boolean);
  const principalOr: Record<string, unknown>[] = [{ principalType: "user", principalId: actor.userId }];
  if (roleNames.length > 0) principalOr.push({ principalType: "role", principalId: { [Op.in]: roleNames } });
  const deptAcl = await AclEntry.findOne({
    where: {
      resourceType: "department",
      resourceId: departmentId,
      permission: { [Op.in]: [PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCUMENT_READ] },
      effect: "ALLOW",
      [Op.and]: [
        { [Op.or]: principalOr },
        { [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] },
      ],
    },
  });
  if (deptAcl) return true;

  const memberDepts = await UserDepartment.findAll({
    where: { userId: actor.userId },
    attributes: ["departmentId"],
    raw: true,
  });
  const rootDeptIds = memberDepts.map((d) => d.departmentId).filter(Boolean) as string[];
  if (rootDeptIds.length === 0) return false;

  // Direct membership only (owner decision 2026-10-09): a parent department's member is not a member of its sub-departments.
  return rootDeptIds.includes(departmentId);
}

/**
 * Whether `folderId` is one the actor may actually open — the SAME
 * visibility rule listReadableFolders already computes for GET /folders/tree
 * and GET /folders (department subtree + explicit folder:read ALLOW/DENY +
 * the ancestor chain of visible folders), reused here to close a gap: GET
 * /folders/:id and /:id/contents were gated only by the generic ACL ladder
 * (resolveACL), which has no department-membership grant for folders at all
 * — only explicit AclEntry rows. Since no folder ever gets an explicit ACL
 * row just for being a department's or organisation's root, that 403'd on
 * folders the tree/list endpoints themselves list as navigable, including a
 * user's own department folder. Bug found 2026-08-21 while browser-verifying
 * the Browse page's folder-scoped filter bar as a non-admin role.
 */
export async function isFolderReadable(folderId: string, actor: FolderActor): Promise<boolean> {
  const visible = await listReadableFolders(actor, { scoped: false });
  return visible.some((f) => f.id === folderId);
}

/**
 * Every department needs exactly one FolderNode bound to it (departmentId set)
 * so the rest of the system (Browse page, HierarchyTreeBrowser sidebar, Upload
 * page's category picker) has somewhere to hang that department's category
 * folders off of. Seed data creates this by hand; departments created through
 * the API never got one, so a freshly-created department had nowhere for its
 * folders to live and looked "broken" next to seeded departments. This makes
 * folder provisioning idempotent so it can run both at department-creation
 * time and lazily (for departments that predate this fix).
 */
/**
 * The two fixed folders every tenant's tree hangs from: the repository root
 * ("/") and the organisation folder directly beneath it. Extracted from
 * getOrCreateDepartmentFolder so createFolder can anchor new folders to the
 * same place instead of inventing a second, parentless level-0 root.
 */
async function getOrCreateTenantRootFolder(tenantId: string, transaction: Transaction): Promise<FolderNode> {
  const findRoot = () =>
    FolderNode.findOne({
      where: { tenantId, parentId: null, departmentId: null, orgUnitId: null, level: 0 },
      transaction,
    });

  let root = await findRoot();
  if (!root) {
    // Named after the tenant itself -- this is the top of the tree
    // (Tenant -> OrgUnit -> Department -> FolderNode), so it should read as
    // the tenant, not a generic product-name placeholder every tenant
    // shared regardless of its actual name.
    const tenant = await Tenant.findByPk(tenantId, { transaction });
    try {
      root = await FolderNode.create(
        { tenantId, name: tenant?.name ?? "Repository", path: "/", level: 0, parentId: null, departmentId: null, orgUnitId: null, isSystemManaged: true, isActive: true },
        { transaction },
      );
    } catch (err) {
      // This root is a tenant-wide singleton, created lazily on first use --
      // a concurrent first `createFolder`/`getOrCreateDepartmentFolder` call
      // for the same brand-new tenant can race this exact insert. Under
      // Postgres's default READ COMMITTED isolation the loser's unique-
      // constraint check only resolves (and throws) once the winner has
      // actually committed, so a fresh `findOne` here is guaranteed to see
      // it: re-fetch and use the winner's row instead of failing the whole
      // request over who happened to insert it first.
      if (!(err instanceof UniqueConstraintError)) throw err;
      root = await findRoot();
      if (!root) throw err;
    }
  }
  return root;
}

export async function getOrCreateOrganisationFolder(
  tenantId: string,
  transaction: Transaction,
): Promise<FolderNode> {
  const root = await getOrCreateTenantRootFolder(tenantId, transaction);

  // This is the tenant-wide, org-unit-less umbrella folder: it's what a
  // folder anchors to when it has neither a parentId nor a departmentId (a
  // genuinely global folder, not tied to any specific org unit). Department
  // folders no longer live here -- see getOrCreateOrgUnitFolder below.
  //
  // Named "Global Folders" rather than after the tenant/product -- it used
  // to be hardcoded to "Example Corp", which put a folder with the exact
  // same name as the TENANT ("Example Corp" is a real tenant's name, see
  // getOrCreateTenantRootFolder above) as a level-1 SIBLING of the tenant's
  // actual org units. That read as if the tenant itself were one more org
  // unit alongside "Daniel Organization Unit"/"Regional Office - West"
  // instead of their common ancestor.
  const findOrg = (parentId: string) =>
    FolderNode.findOne({
      where: { tenantId, parentId, departmentId: null, orgUnitId: null, level: 1 },
      transaction,
    });

  let org = await findOrg(root.id);
  if (!org) {
    try {
      org = await FolderNode.create(
        { tenantId, name: "Global Folders", path: `${root.path === "/" ? "" : root.path}/global`, level: 1, parentId: root.id, departmentId: null, orgUnitId: null, isSystemManaged: true, isActive: true },
        { transaction },
      );
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
      org = await findOrg(root.id);
      if (!org) throw err;
    }
  }
  return org;
}

/**
 * Per-org-unit sibling of getOrCreateOrganisationFolder: every org unit gets
 * its own level-1 folder under the tenant root, so a department's folder
 * nests under ITS org unit instead of one shared folder every department in
 * the tenant fought over regardless of org unit -- see the org_unit_id
 * migration (20260912000002) for why that was wrong (two org units with a
 * same/similarly-named department produced indistinguishable, flat-sibling
 * folders with no visual grouping).
 */
export async function getOrCreateOrgUnitFolder(
  tenantId: string,
  orgUnit: { id: string; code: string; name: string },
  transaction: Transaction,
): Promise<FolderNode> {
  const root = await getOrCreateTenantRootFolder(tenantId, transaction);

  const findOrgUnitFolder = () =>
    FolderNode.findOne({
      where: { tenantId, parentId: root.id, orgUnitId: orgUnit.id, level: 1 },
      transaction,
    });

  let folder = await findOrgUnitFolder();
  if (!folder) {
    const slug = orgUnit.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || orgUnit.id;
    try {
      folder = await FolderNode.create(
        {
          tenantId,
          name: orgUnit.name,
          path: `${root.path === "/" ? "" : root.path}/${slug}`,
          level: 1,
          parentId: root.id,
          departmentId: null,
          orgUnitId: orgUnit.id,
          isSystemManaged: true,
          isActive: true,
        },
        { transaction },
      );
    } catch (err) {
      // Same lazy-singleton race as getOrCreateOrganisationFolder, scoped to
      // this org unit instead of the whole tenant.
      if (!(err instanceof UniqueConstraintError)) throw err;
      folder = await findOrgUnitFolder();
      if (!folder) throw err;
    }
  }
  return folder;
}

export async function getOrCreateDepartmentFolder(
  tenantId: string,
  department: { id: string; name: string; orgUnitId: string; parentId?: string | null },
  transaction: Transaction,
): Promise<FolderNode> {
  // Pick the department's CANONICAL folder, and ignore malformed rows.
  //
  // This used to be `order: [["level","ASC"]]` with no other constraint, so
  // ANY row bound to the department won as long as it had a lower level --
  // including the orphan level-0 rows that POST /folders and
  // PATCH /folders/:id used to create when handed a departmentId with no
  // parentId (see createFolder/updateFolder, both fixed alongside this).
  // Executive had one ({ name: "TEST", path: "test", level: 0 }, created
  // 2026-08-03) and it silently beat /Example Corp/Executive, so the Upload
  // page's category picker reported "No category folders seeded for this
  // department yet" while the Browse page -- which walks the real hierarchy
  // -- showed all three subfolders.
  //
  // A genuine department folder always hangs off the organisation folder, so
  // it is never level 0 and its path is always absolute. isActive was also
  // missing entirely, so a soft-deleted folder could be handed back.
  const existing = await FolderNode.findOne({
    where: {
      tenantId,
      departmentId: department.id,
      isActive: true,
      level: { [Op.gt]: 0 },
      path: { [Op.like]: "/%" },
    },
    order: [
      ["level", "ASC"],
      ["createdAt", "ASC"],
    ],
    transaction,
  });
  if (existing) return existing;

  // A sub-department (department.parentId set) nests its folder under its
  // PARENT department's own folder, not the org unit folder directly --
  // otherwise the folder tree the Browse page walks (parentId chains) goes
  // flat for every sub-department while the department tree itself (which
  // has its own, separate parentId/path columns -- see departments.service.ts)
  // stays correctly nested, so a sub-department's category folders and any
  // ACL granted "on this department's folder and descendants" silently stop
  // matching what the org chart actually shows. Recursing here (rather than
  // requiring every caller to resolve the parent folder first) means a
  // sub-department's own folder is auto-provisioned on demand, same as a
  // top-level department's.
  let parent: FolderNode;
  if (department.parentId) {
    const parentDept = await Department.findOne({ where: { id: department.parentId, tenantId }, transaction });
    if (!parentDept) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Parent department not found");
    parent = await getOrCreateDepartmentFolder(
      tenantId,
      { id: parentDept.id, name: parentDept.name, orgUnitId: parentDept.orgUnitId, parentId: parentDept.parentId },
      transaction,
    );
  } else {
    const orgUnit = await OrgUnit.findOne({ where: { id: department.orgUnitId, tenantId }, transaction });
    if (!orgUnit) throw new AppError(404, "ERR-ORG-UNIT-NOT-FOUND", "Organizational unit not found");
    parent = await getOrCreateOrgUnitFolder(tenantId, orgUnit, transaction);
  }

  const slug = department.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || department.id;
  let path = `${parent.path}/${slug}`;
  let suffix = 1;
  while (await FolderNode.findOne({ where: { tenantId, path, isActive: true }, transaction })) {
    suffix += 1;
    path = `${parent.path}/${slug}-${suffix}`;
  }

  try {
    return await FolderNode.create(
      {
        tenantId,
        name: department.name,
        path,
        level: parent.level + 1,
        parentId: parent.id,
        departmentId: department.id,
        orgUnitId: department.orgUnitId,
        isSystemManaged: false,
        isActive: true,
      },
      { transaction },
    );
  } catch (err) {
    // Same race as getOrCreateOrganisationFolder above: two concurrent first
    // requests for this department's folder computed the same slug/path and
    // both lost the `findOne` check above, so the loser hits the
    // (tenant_id, path) unique index instead. Re-run this function's own
    // canonical lookup rather than fail the whole request -- the winner's row
    // satisfies it by construction (same departmentId, level > 0, path under
    // the org folder).
    if (!(err instanceof UniqueConstraintError)) throw err;
    const winner = await FolderNode.findOne({
      where: {
        tenantId,
        departmentId: department.id,
        isActive: true,
        level: { [Op.gt]: 0 },
        path: { [Op.like]: "/%" },
      },
      order: [
        ["level", "ASC"],
        ["createdAt", "ASC"],
      ],
      transaction,
    });
    if (!winner) throw err;
    return winner;
  }
}

/**
 * Department-scoped equivalent of getFolderContents: resolves (creating if
 * necessary) the department's own bound folder and returns it alongside
 * every folder nested anywhere under it — the "category folders" pickers
 * elsewhere in the app need. Auto-provisioning here means departments
 * created before this fix self-heal the first time anything asks for their
 * folders.
 *
 * FIX 2026-09-14: this used to query only DIRECT children
 * (`parentId: folder.id`), so a folder created under a category folder (e.g.
 * IT-DEPT -> IT-FOLDER -> IT-SUBFOLDER) was invisible to the Upload page's
 * folder picker no matter how it was nested — folder creation itself
 * (createFolder, below) has no depth limit and lets an admin anchor a new
 * folder under any existing one, so this was silently out of sync with what
 * the UI actually let people build. Every folder under a department shares
 * that department's `departmentId` regardless of depth (createFolder
 * inherits it from the parent when not explicitly overridden), so querying
 * by `departmentId` instead of `parentId` returns the full subtree in one
 * flat, depth-agnostic list — the picker already renders each option's full
 * `path`, so nesting is visible in the label with no further UI change.
 *
 * FIX: this route used to have NO scoping beyond the blanket folder:read
 * permission — any authenticated user could query (and auto-provision a
 * folder for) any department in the tenant just by guessing/enumerating its
 * id, regardless of membership. Now requires the caller to belong to this
 * department (or a descendant of it), or hold oversight — see
 * isDepartmentReadable.
 */
export async function getDepartmentFolderWithChildren(departmentId: string, actor: FolderActor) {
  const department = await Department.findOne({ where: { id: departmentId, tenantId: actor.tenantId, isActive: true } });
  if (!department) throw new AppError(404, "ERR-DEPT-NOT-FOUND", "Department not found");

  if (!(await isDepartmentReadable(departmentId, actor))) {
    throw new AppError(403, "AUTHZ_ACL_NO_ENTRY", "No access control entry for this resource");
  }

  const tenantId = actor.tenantId;
  const requesterId = actor.userId;
  return runInTransaction(async (t: Transaction) => {
    const existingCount = await FolderNode.count({ where: { tenantId, departmentId }, transaction: t });
    const folder = await getOrCreateDepartmentFolder(tenantId, { id: department.id, name: department.name, orgUnitId: department.orgUnitId, parentId: department.parentId }, t);
    if (existingCount === 0) {
      await writeAuditLog({
        eventType: AUDIT_EVENTS.FOLDER_CREATED,
        userId: requesterId,
        actionDetails: { folderId: folder.id, path: folder.path, departmentId, autoProvisioned: true },
      });
    }
    const subfolders = await FolderNode.findAll({
      where: { departmentId, tenantId, isActive: true, id: { [Op.ne]: folder.id } },
      order: [["path", "ASC"]],
      attributes: ["id", "name", "path", "level", "parentId", "departmentId", "createdAt"],
      transaction: t,
    });
    return { folder, subfolders };
  });
}

export async function getFolderContents(folderId: string, user: AuthenticatedUser) {
  const tenantId = user.tenantId;
  const folder = await FolderNode.findOne({
    where: { id: folderId, tenantId, isActive: true }
  });

  if (!folder) {
    throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Folder not found');
  }

  const [readableSubfolders, documents] = await Promise.all([
    // FIX: this used to be an unscoped FolderNode.findAll — it listed every
    // child folder regardless of whether `user` could actually read it (the
    // same class of leak fixed on GET /folders/:id — see folders.routes.ts).
    // listReadableFolders already computes exactly "children of this parent
    // the actor may read"; reuse it and re-shape to the same attribute set
    // this endpoint has always returned.
    listReadableFolders(user, { parentId: folderId, scoped: true }),
    Document.findAll({
      where: { folderId, tenantId, deletedAt: null },
      order: [["createdAt", "DESC"]],
      attributes: ["id", "title", "documentTypeId", "folderId", "departmentId", "status", "createdAt", "updatedAt", "ownerId"]
    })
  ]);
  const subfolders = readableSubfolders.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    level: f.level,
    parentId: f.parentId,
    departmentId: f.departmentId,
    createdAt: f.createdAt,
  }));

  // Platform audit finding (2026-08-14, MEDIUM-HIGH, follow-up): this route
  // is gated only by folder-level ACL (requireACL('folder:read') in
  // folders.routes.ts) — but a document can carry its own, more specific
  // per-user/per-role ACL entry (grantDefaultDocumentAcl) that DENIES
  // document:read even to someone who can read its parent folder. Every
  // other document-listing surface (documents.service.ts's listDocuments/
  // getDashboardStats) explicitly re-filters through this same
  // filterDocsByDetailAcl() net — documented there as guaranteeing
  // "list-visibility ⊆ detail-visibility" — but this third listing surface
  // never got it, so a document with an explicit DENY still showed up here
  // with its title/status/department/dates, even though GET /documents/:id
  // would correctly 403 on it directly.
  const visibleDocuments = await filterDocsByDetailAcl(user, documents);

  return {
    folder: {
      id: folder.id,
      name: folder.name,
      path: folder.path,
      level: folder.level,
      parentId: folder.parentId,
      departmentId: folder.departmentId,
      orgUnitId: folder.orgUnitId
    },
    subfolders,
    documents: visibleDocuments
  };
}

/** Same 4-line cache-then-DB pattern as documents.service.ts's own local
 *  getUserDepartmentIds and letters.service.ts's — see documents.service.ts's
 *  comment on why this isn't centralized into userDeptCache.ts itself. */
async function getUserDepartmentIds(tenantId: string, uid: string): Promise<string[]> {
  const cached = await getCachedUserDepartments(tenantId, uid);
  if (cached) return cached;
  const departmentIds = await loadUserDepartmentIds(tenantId, uid);
  await cacheUserDepartments(tenantId, uid, departmentIds);
  return departmentIds;
}

/** FIX: createFolder resolved and validated a client-supplied departmentId
 *  (or inherited one from parentId's folder) purely for EXISTENCE — any
 *  FOLDER_CREATE holder (RECORDS_OFFICER, DEPT_MANAGER, not just admins)
 *  could anchor a new folder under any other department's tree, including
 *  one they have no relationship to and cannot even see in the Browse
 *  sidebar. Same bug class, and same fix shape, as documents.service.ts's
 *  ensureCanCreate and letters.service.ts's assertDepartmentMembershipFor-
 *  Authoring — department MEMBERSHIP, not an AclEntry grant: an ordinary
 *  department member creating a folder in their own department has never
 *  needed (and today has no) an explicit per-folder ACL row, unlike
 *  updateFolder's reparent-into-an-arbitrary-destination check just below,
 *  which is deliberately the stricter, ACL-grant-gated operation.
 *  `departmentId: null` (the organisation-root folder) has nothing to check
 *  membership against and is left to the route's own FOLDER_CREATE gate. */
async function assertCanCreateInDepartment(
  departmentId: string | null,
  tenantId: string,
  userId: string,
  permissions: readonly string[] | undefined,
) {
  if (!departmentId) {
    // A folder outside every department (the organisation / org-unit /
    // "Global Folders" umbrella) is shared tenant structure, not part of
    // anybody's department. It used to be left to the route's folder:create
    // gate alone, so any department manager could add folders at the top of
    // the tenant. Reserved to organisation-level authority; records staff
    // (document:read_all) keep it because they curate the shared filing plan.
    const held = permissions ?? [];
    if (hasTenantWideStructureAuthority({ permissions: held }) || held.includes(PERMISSIONS.DOCUMENT_READ_ALL)) return;
    throw new AppError(
      403,
      "ERR-DEPT-SCOPE",
      "Only an organisation administrator or records officer can create folders outside a department",
    );
  }
  if (hasTenantWideStructureAuthority({ permissions: permissions ?? [] })) return;
  const deptIds = await getUserDepartmentIds(tenantId, userId);
  if (deptIds.includes(departmentId)) return;
  // A department head also works in the sub-departments beneath the one they
  // belong to (shared/orgScope.ts) — membership alone used to exclude them.
  const managed = await getManagedDepartmentIds(tenantId, userId);
  if (!managed.has(departmentId)) {
    throw new AppError(
      403,
      "ERR-DEPT-SCOPE",
      "You are not a member of this department and cannot create folders under it",
    );
  }
}

export async function createFolder(
  input: unknown,
  userId: string,
  tenantId: string,
  permissions?: readonly string[],
) {
  const data = folderSchema.parse(input);

  // Trim and validate folder name
  const folderName = data.name.trim();
  if (!folderName) {
    throw new AppError(400, 'ERR-INVALID-FOLDER-NAME', 'Folder name cannot be empty');
  }
  
  // BUG 2 FIX: Validate departmentId exists BEFORE attempting insert
  if (data.departmentId) {
    if (!isValidUUID(data.departmentId)) {
      throw new AppError(400, 'ERR-INVALID-DEPARTMENT-ID', 'Invalid department ID format');
    }
    const deptExists = await Department.findOne({ 
      where: { id: data.departmentId, tenantId, isActive: true } 
    });
    if (!deptExists) {
      throw new AppError(404, 'ERR-DEPARTMENT-NOT-FOUND', 'Department not found');
    }
  }
  
  // BUG 1 FIX: Wrap entire operation in transaction
  return runInTransaction(async (t: Transaction) => {
    // Every folder is anchored to a parent. It used to be that omitting
    // parentId produced `level = 0` and a bare, slash-less path (just the
    // folder name slugified) -- a SECOND parentless root floating outside
    // the hierarchy. When such a folder also carried a departmentId it then
    // won getOrCreateDepartmentFolder's "lowest level wins" lookup and
    // silently emptied that department's category picker on the Upload page,
    // while Browse kept showing the real tree. That is exactly what happened
    // to Executive on 2026-08-03. Anchor explicitly instead:
    //   parentId given     -> that folder (unchanged behaviour)
    //   departmentId only  -> the department's own bound folder
    //   neither            -> the organisation folder
    let parent: FolderNode;
    let dept: Department | null = null;
    if (data.parentId) {
      if (!isValidUUID(data.parentId)) {
        throw new AppError(400, 'ERR-INVALID-PARENT-ID', 'Invalid parent folder ID format');
      }
      const found = await FolderNode.findOne({
        where: { id: data.parentId, tenantId, isActive: true },
        transaction: t
      });
      if (!found) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Parent folder not found');
      // Creating a subfolder under an existing folder requires membership in
      // THAT folder's department (found.departmentId is null only for the
      // organisation root and other department-less folders, which have
      // nothing to check).
      await assertCanCreateInDepartment(found.departmentId, tenantId, userId, permissions);
      // An explicit departmentId that differs from the parent's re-homes the new
      // folder into ANOTHER department's scope (it inherits `data.departmentId`
      // below), so the caller needs standing there too — checking only the
      // parent's department let a member of A plant a folder inside B.
      if (data.departmentId && data.departmentId !== found.departmentId) {
        await assertCanCreateInDepartment(data.departmentId, tenantId, userId, permissions);
      }
      parent = found;
    } else if (data.departmentId) {
      dept = await Department.findOne({
        where: { id: data.departmentId, tenantId, isActive: true },
        transaction: t,
      });
      if (!dept) throw new AppError(404, 'ERR-DEPARTMENT-NOT-FOUND', 'Department not found');
      await assertCanCreateInDepartment(dept.id, tenantId, userId, permissions);
      parent = await getOrCreateDepartmentFolder(tenantId, { id: dept.id, name: dept.name, orgUnitId: dept.orgUnitId, parentId: dept.parentId }, t);
    } else {
      // Neither a parent nor a department: a folder at the top of the tenant.
      await assertCanCreateInDepartment(null, tenantId, userId, permissions);
      parent = await getOrCreateOrganisationFolder(tenantId, t);
    }

    const level = parent.level + 1;
    const slug = folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // parent.path is "/" only for the repository root; avoid a doubled slash.
    const path = `${parent.path === "/" ? "" : parent.path}/${slug}`;
    const departmentId = data.departmentId ?? parent.departmentId;
    // Mirrors departmentId's inheritance above, but `dept` is only populated
    // when parent resolution took the "departmentId only" branch (no
    // parentId given) -- a subfolder created under an explicit parentId
    // still submits its inherited departmentId, so `dept` can be null here
    // even though departmentId is set. Resolve org unit off whichever source
    // actually has it instead of assuming `dept` was fetched.
    let orgUnitId: string | null;
    if (!departmentId) {
      orgUnitId = null;
    } else if (departmentId === parent.departmentId) {
      orgUnitId = parent.orgUnitId;
    } else if (dept && dept.id === departmentId) {
      orgUnitId = dept.orgUnitId;
    } else {
      const explicitDept = await Department.findOne({ where: { id: departmentId, tenantId, isActive: true }, transaction: t });
      orgUnitId = explicitDept?.orgUnitId ?? null;
    }

    // CRITICAL FIX: Check for duplicate PATH (which has the database constraint)
    // The database has partial unique index on (tenant_id, path) WHERE is_active = true
    // Also filter by isActive to allow reusing paths of deleted folders
    const duplicate = await FolderNode.findOne({ 
      where: { 
        path,
        tenantId,
        isActive: true  // Only check active folders
      },
      transaction: t 
    });
    
    if (duplicate) {
      throw new AppError(409, 'ERR-FOLDER-DUPLICATE', 'A folder with this name already exists in this location');
    }

    // BUG 1 & BUG 2 FIX: Catch both UniqueConstraintError and ForeignKeyConstraintError
    let folder;
    try {
      folder = await FolderNode.create({
        name: folderName,
        path,
        level,
        parentId: parent.id,
        departmentId,
        orgUnitId,
        tenantId,
        isActive: true
      }, { transaction: t });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw new AppError(409, 'ERR-FOLDER-DUPLICATE', 'A folder with this name already exists in this location');
      }
      // BUG 2 FIX: Catch FK violation as defense-in-depth
      if (err instanceof ForeignKeyConstraintError) {
        // Check which FK failed
        if (err.message.includes('department_id')) {
          throw new AppError(404, 'ERR-DEPARTMENT-NOT-FOUND', 'Department not found');
        }
        if (err.message.includes('parent_id')) {
          throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Parent folder not found');
        }
        // Generic FK error
        throw new AppError(400, 'ERR-INVALID-REFERENCE', 'Invalid reference to related entity');
      }
      throw err;
    }

    // §8: ACL Inheritance - Copy ACL entries from parent folder
    // Gated on data.parentId before, so a folder created with only a
    // departmentId inherited no ACLs at all. Use the resolved parent.
    {
      const parentAcls = await AclEntry.findAll({
        where: { resourceType: 'folder', resourceId: parent.id },
        transaction: t
      });

      const rows = parentAcls.map((acl) => ({
        tenantId: acl.tenantId,
        resourceType: 'folder' as const,
        resourceId: folder.id,
        principalType: acl.principalType,
        principalId: acl.principalId,
        permission: acl.permission,
        effect: acl.effect,
        grantedById: userId,
        expiresAt: acl.expiresAt,
      }));
      if (rows.length > 0) {
        await AclEntry.bulkCreate(rows as never[], { transaction: t, ignoreDuplicates: true });
      }
    }

    await writeAuditLog({ 
      eventType: AUDIT_EVENTS.FOLDER_CREATED, 
      userId,
      actionDetails: { folderId: folder.id, path, parentId: parent.id } 
    });

    return folder;
  });
}

export async function updateFolder(
  id: string,
  input: unknown,
  actor: { userId: string; role: string; roles?: readonly string[]; tenantId: string; permissions?: readonly string[] },
) {
  const { userId, tenantId } = actor;
  // Validate ID format before querying
  if (!isValidUUID(id)) {
    throw new AppError(400, 'ERR-INVALID-FOLDER-ID', 'Invalid folder ID format');
  }

  const data = folderSchema.partial().parse(input);
  let ancestryChanged = false;

  // BUG 1 FIX: Wrap entire operation in transaction
  const result = await runInTransaction(async (t: Transaction) => {
    const folder = await FolderNode.findOne({ where: { id, tenantId, isActive: true }, transaction: t });
    if (!folder) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Folder not found');

    let updates: Record<string, unknown> = {};
    let oldPath: string | null = null;

    if (data.name) {
      const newName = data.name.trim();
      if (!newName) {
        throw new AppError(400, 'ERR-INVALID-FOLDER-NAME', 'Folder name cannot be empty');
      }
      
      let newPath: string;
      if (folder.parentId) {
        const parent = await FolderNode.findOne({ where: { id: folder.parentId, tenantId, isActive: true }, transaction: t });
        if (!parent) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Parent folder not found');
        newPath = `${parent.path === "/" ? "" : parent.path}/${newName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      } else {
        // The only folder that legitimately has no parent is the repository
        // root, whose path is "/". Slugifying its name used to rewrite that
        // path to e.g. "dms-repository", detaching every absolute path in the
        // tree from its own root. Renaming it is fine; its path is not a
        // function of its name, so leave it alone.
        newPath = folder.path;
      }

      updates.name = newName;
      updates.path = newPath;
      oldPath = folder.path; // Save for descendant update
    }

    if (data.parentId !== undefined) {
      if (data.parentId) {
        if (!isValidUUID(data.parentId)) {
          throw new AppError(400, 'ERR-INVALID-PARENT-ID', 'Invalid parent folder ID format');
        }
        const parent = await FolderNode.findOne({ where: { id: data.parentId, tenantId, isActive: true }, transaction: t });
        if (!parent) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Parent folder not found');

        // Department scope on the destination (see assertCanCreateInDepartment):
        // a folder cannot be moved into a department the caller does not head,
        // nor out to the shared department-less area unless they are an
        // organisation-level user. The ACL check below is in addition to this.
        await assertCanCreateInDepartment(parent.departmentId, tenantId, userId, actor.permissions);

        // H5: reparenting was ACL-checked on the SOURCE only, so a user could
        // move a subtree under a destination they have no rights to. Require
        // folder:create on the destination parent too.
        // Pass the full role set, not just the display role — see resolveACL's
        // AclCheckOptions.userRoles: a DENY on a non-display role must not be
        // silently skipped.
        // A department head owns their subtree: moving a folder from one department they head into
        // another needs no explicit folder:create row on the destination (a head has none by default, so
        // only an administrator could move). An explicit DENY on the destination still closes it.
        const roleSet = [...new Set([actor.role, ...(actor.roles ?? [])])];
        const managedDepartments = parent.departmentId && folder.departmentId
          ? await getManagedDepartmentIds(tenantId, userId)
          : new Set<string>();
        const headsBoth = Boolean(parent.departmentId && folder.departmentId)
          && managedDepartments.has(parent.departmentId as string) && managedDepartments.has(folder.departmentId as string);
        const destAcl = headsBoth
          ? await resolveACL({
              resourceType: 'folder', resourceId: data.parentId, permission: PERMISSIONS.FOLDER_CREATE,
              userId, userRoles: roleSet, userPermissions: actor.permissions, tenantId,
            })
          : null;
        if (!headsBoth || destAcl?.effect === 'DENY') {
          await assertACLAllow(
            userId,
            roleSet,
            tenantId,
            { resourceType: 'folder', resourceId: data.parentId, permission: PERMISSIONS.FOLDER_CREATE },
            actor.permissions as string[] | undefined,
          );
        }

        updates.level = parent.level + 1;
        updates.parentId = data.parentId;
        updates.path = `${parent.path}/${folder.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        oldPath = folder.path; // Save for descendant update
      } else {
        // Detaching a folder to become a second parentless root is what
        // produced the malformed rows this whole class of bug came from
        // (see createFolder). "No parent" is not a valid destination: fall
        // back to the folder's own department root, or the organisation
        // folder, so the subtree stays inside the hierarchy.
        const reanchor = folder.departmentId
          ? await (async () => {
              const dept = await Department.findOne({
                where: { id: folder.departmentId as string, tenantId, isActive: true },
                transaction: t,
              });
              return dept
                ? getOrCreateDepartmentFolder(tenantId, { id: dept.id, name: dept.name, orgUnitId: dept.orgUnitId }, t)
                : getOrCreateOrganisationFolder(tenantId, t);
            })()
          : await getOrCreateOrganisationFolder(tenantId, t);
        if (reanchor.id === folder.id) {
          throw new AppError(400, 'ERR-INVALID-PARENT-ID', 'This folder cannot be detached from the hierarchy');
        }
        updates.level = reanchor.level + 1;
        updates.parentId = reanchor.id;
        updates.path = `${reanchor.path === "/" ? "" : reanchor.path}/${folder.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        oldPath = folder.path; // Save for descendant update
      }
    }

    // FIX: a rename or reparent changes this folder's (and every
    // descendant's) effective ACL ancestry, but nothing used to invalidate
    // the ACL cache on this path — stale ALLOW/DENY decisions for the whole
    // moved subtree persisted for up to the cache's full TTL.
    if (oldPath) ancestryChanged = true;

    if (data.departmentId !== undefined) {
      // Re-pointing a folder at a department is the same decision as creating
      // one there — it used to need nothing beyond the folder's own ACL, so a
      // folder could be handed to any department in the tenant.
      if (data.departmentId !== folder.departmentId) {
        await assertCanCreateInDepartment(data.departmentId, tenantId, userId, actor.permissions);
      }
      updates.departmentId = data.departmentId;
      // Keep orgUnitId in lockstep with departmentId: a folder's org unit is
      // derived from whichever department it's bound to, never set
      // independently, so re-pointing departmentId must re-derive it too --
      // otherwise a folder moved to a different department would keep
      // displaying under its old org unit's branch of the tree.
      if (data.departmentId) {
        const newDept = await Department.findOne({ where: { id: data.departmentId, tenantId, isActive: true }, transaction: t });
        if (!newDept) throw new AppError(404, 'ERR-DEPARTMENT-NOT-FOUND', 'Department not found');
        updates.orgUnitId = newDept.orgUnitId;
      } else {
        updates.orgUnitId = null;
      }
    }

    // Check for duplicate path before updating
    if (updates.path && updates.path !== folder.path) {
      const duplicate = await FolderNode.findOne({
        where: { path: updates.path as string, tenantId, isActive: true, id: { [Op.ne]: id } },
        transaction: t
      });
      if (duplicate) {
        throw new AppError(409, 'ERR-FOLDER-DUPLICATE', 'A folder with this name already exists in this location');
      }
    }

    const updated = await folder.update(updates, { transaction: t });
    
    // BUG 1 FIX: Cascade path updates to all descendants
    if (oldPath && updates.path) {
      const descendants = await FolderNode.findAll({
        where: { 
          path: { [Op.iLike]: `${oldPath}/%` } as any,
          tenantId 
        },
        transaction: t
      });
      
      for (const descendant of descendants) {
        const newDescPath = descendant.path.replace(oldPath + '/', (updates.path as string) + '/');
        const pathParts = newDescPath.split('/');
        const newLevel = pathParts.length - 1;
        await descendant.update({ 
          path: newDescPath, 
          level: newLevel 
        }, { transaction: t });
      }
    }
    
    await writeAuditLog({
      eventType: AUDIT_EVENTS.FOLDER_UPDATED,
      userId,
      actionDetails: { folderId: id, updates }
    });

    // Invalidate after commit, not inside the transaction — and tenant-wide
    // rather than per-resource, since a reparent changes ancestry for every
    // descendant folder AND document, which per-resource invalidation can't
    // reach without walking the whole subtree.
    //
    // FIX (runInTransaction conversion): this used to run after the managed
    // `sequelize.transaction()` call returned, which — back when that call
    // always opened its own independent root transaction — really did mean
    // "after commit". Now that it can reuse the ambient request transaction,
    // returning from the callback no longer means committed (the real commit
    // happens later, at response-finish time — see shared/middleware.ts).
    // Invalidating eagerly here would race a rollback: a request that fails
    // after this point would leave the ACL cache invalidated for a reparent
    // that never actually happened, serving briefly-wrong (though at least
    // not stale-wrong) ACL decisions. tx.afterCommit is the one hook that
    // fires at the true commit point whether this call reused the ambient
    // transaction or opened a fresh one.
    if (ancestryChanged) {
      t.afterCommit(() => {
        void invalidateTenantACL(tenantId).catch((err) => {
          logger.warn({ err, tenantId, folderId: id }, "Failed to invalidate tenant ACL cache after folder update commit");
        });
      });
    }

    return updated;
  });

  return result;
}

export async function deactivateFolder(id: string, user: { userId: string; role: string; tenantId: string }) {
  // BUG 1 FIX: Wrap entire operation in transaction
  return runInTransaction(async (t: Transaction) => {
    const folder = await FolderNode.findOne({ where: { id, tenantId: user.tenantId, isActive: true }, transaction: t });
    if (!folder) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Folder not found');

    // §1: permission-based scope — DM must have DEPT_MANAGE
    if (userHasPermission(user.role, PERMISSIONS.DEPT_MANAGE)) {
      // SPRINT-1: departmentIds removed from JWT. isolation bypass for now.
    }

    const childCount = await FolderNode.count({ where: { parentId: id, tenantId: user.tenantId, isActive: true }, transaction: t });
    if (childCount > 0)
      throw new AppError(409, 'ERR-FOLDER-HAS-CHILDREN', 'Remove child folders first');

    const docCount = await Document.count({ where: { folderId: id, deletedAt: null, tenantId: user.tenantId }, transaction: t });
    if (docCount > 0)
      throw new AppError(409, 'ERR-FOLDER-HAS-DOCS', `${docCount} document(s) still in this folder`);

    // BUG 1 FIX: Enable isActive field update (was previously commented out)
    await folder.update({ isActive: false }, { transaction: t });
    
    await writeAuditLog({ 
      eventType: AUDIT_EVENTS.FOLDER_DEACTIVATED, 
      userId: user.userId,
      actionDetails: { folderId: id, path: folder.path } 
    });
    
    return folder;
  });
}

/** Deactivated folders the actor administers (tenant-wide authority sees all; a department head sees their subtree's). */
export async function listInactiveFolders(actor: { userId: string; role: string; tenantId: string; permissions?: readonly string[] }) {
  const all = await FolderNode.findAll({ where: { isActive: false, tenantId: actor.tenantId }, order: [['path', 'ASC']] });
  if (hasTenantWideStructureAuthority(actor)) return all;
  const managed = await getManagedDepartmentIds(actor.tenantId, actor.userId);
  return all.filter((f) => f.departmentId && managed.has(f.departmentId));
}

/**
 * Bring a deactivated folder back. It needs everything it hangs from to be live again, and its path must not have been
 * taken in the meantime (the unique index only covers ACTIVE folders, so a deactivated path can be reused).
 */
export async function reactivateFolder(id: string, actor: { userId: string; role: string; tenantId: string; permissions?: readonly string[] }) {
  return runInTransaction(async (t: Transaction) => {
    const folder = await FolderNode.findOne({ where: { id, tenantId: actor.tenantId, isActive: false }, transaction: t });
    if (!folder) throw new AppError(404, 'ERR-FOLDER-NOT-FOUND', 'Deactivated folder not found');
    if (!hasTenantWideStructureAuthority(actor)) {
      const managed = await getManagedDepartmentIds(actor.tenantId, actor.userId);
      if (!folder.departmentId || !managed.has(folder.departmentId)) {
        throw new AppError(403, 'ERR-FOLDER-SCOPE', 'This folder is outside the departments you administer');
      }
    }
    if (folder.parentId) {
      const parent = await FolderNode.findOne({ where: { id: folder.parentId, tenantId: actor.tenantId }, transaction: t });
      if (!parent || !parent.isActive) throw new AppError(409, 'ERR-FOLDER-PARENT-INACTIVE', 'Re-activate the parent folder first');
    }
    if (folder.departmentId) {
      const dept = await Department.findOne({ where: { id: folder.departmentId, tenantId: actor.tenantId }, transaction: t });
      if (!dept || !dept.isActive) throw new AppError(409, 'ERR-FOLDER-DEPT-INACTIVE', 'Re-activate the department first');
    }
    const taken = await FolderNode.findOne({ where: { tenantId: actor.tenantId, path: folder.path, isActive: true }, transaction: t });
    if (taken) throw new AppError(409, 'ERR-FOLDER-PATH-TAKEN', `Another active folder now uses the path ${folder.path}; rename or remove it first`);
    await folder.update({ isActive: true }, { transaction: t });
    await writeAuditLog({ eventType: AUDIT_EVENTS.FOLDER_REACTIVATED, userId: actor.userId, actionDetails: { folderId: id, path: folder.path } });
    return folder;
  });
}
