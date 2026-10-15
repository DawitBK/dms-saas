// §2: Tenant CRUD service for multi-tenant quota management.
import { z } from "zod";
import { Tenant, Document, OrgUnit, Department, DocumentType, RetentionPolicy, DocumentStatusActionRole, UserTenant, User, sequelize } from "../../infrastructure/database/index.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { AppError } from "../../core/AppError.js";

// Document types/retention policies that filing code looks up by hardcoded
// `code` (forms.service.ts, letters.service.ts, bundles.service.ts, the
// e-signing uncategorized-upload fallback). These used to be backfilled only
// onto tenants that existed when each feature's migration ran (see
// migrations/20260728000001-tenant-system-defaults.sql) — seed them here too
// so every tenant created from now on has them from day one.
const SYSTEM_RETENTION_POLICIES = [
  { code: "RET-FORM-5Y", name: "Forms — 5 years", authority: "Forms Governance Policy" },
  { code: "RET-CORR-5Y", name: "Correspondence — 5 years", authority: "CAMS Correspondence Policy" },
  { code: "RET-BUNDLE-5Y", name: "Compiled bundles - 5 years", authority: "Document Bundle Policy" },
  { code: "RET-UNCAT-5Y", name: "Uncategorized signed documents — 5 years", authority: "E-Signing Uncategorized Bucket Policy" },
] as const;

const SYSTEM_DOCUMENT_TYPES = [
  { code: "FORM", name: "Generated Form", retentionClass: "RET-FORM-5Y" },
  { code: "CORR", name: "Correspondence", retentionClass: "RET-CORR-5Y" },
  { code: "BUNDLE", name: "Compiled Document Bundle", retentionClass: "RET-BUNDLE-5Y" },
  // FIX 2026-09-14: this is the fallback type e-signing uploads land on when
  // no type is picked (esigning.service.ts) — it existed with
  // requiresSignature defaulting to false, the same "does this type need a
  // signing ceremony" flag every other e-sign-eligible type is filtered on
  // (see signing/page.tsx's document-type picker). A tenant's very own
  // uncategorized e-sign bucket not being flagged as requiring a signature
  // was backwards; requiresSignature: true here also derives
  // signingPolicy: "ceremony" (documentTypes.service.ts).
  { code: "SIGN-UNCAT", name: "Uncategorized Signed Document", retentionClass: "RET-UNCAT-5Y", requiresSignature: true },
] as const;

const tenantSchema = z.object({
  id: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, "Must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1).max(255),
  storageQuotaBytes: z.number().int().min(0).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxDocuments: z.number().int().min(1).optional(),
  isActive: z.boolean().optional()
});

// Create-only: who this new tenant's first member/admin should be. Separate
// from tenantSchema (which updateTenant also uses via .partial()) since it
// names a USER, not a tenant field.
const createTenantSchema = tenantSchema.extend({
  initialAdminUserId: z.string().uuid().optional(),
});

// SECURITY FIX (kept): previously returned every tenant on the platform to
// any tenant:read holder — that hole is NOT reopened here. Visibility is
// still gated to tenants the caller actually belongs to, same as every
// other :id route's assertOwnTenant check.
//
// FIX 2026-09-14: "belongs to" used to mean ONLY req.user.tenantId — the ONE
// tenant baked into the caller's current JWT by the login/select-tenant flow
// (auth.service.ts). That is the caller's currently ACTIVE tenant, not the
// full set of tenants they hold a user_tenants row for — the two are the
// same for almost every account, but diverge for exactly the case that broke:
// createTenant() grants TENANT_MANAGE holders an unscoped "create a brand
// new tenant" operation (there's no existing tenant to scope a POST /
// against), so a caller could create tenant B while their token stayed
// scoped to tenant A — and then satisfy no version of "list tenants I can
// see" that only ever looked at A. Membership (user_tenants) is the same
// backing store the login flow already re-derives `available_tenants` from
// (auth.service.ts's tenantRows query) — this is that same set, not a new
// concept. createTenant() below enrolls the tenant's real initial admin (if
// named) as a member of what's created, so it shows up here for THEM
// immediately; to actually operate inside it (PATCH, deactivate, add other
// members) they select into it via the existing two-phase select-tenant
// login, same as any multi-tenant user.
//
// The caller's current JWT tenant is unioned in defensively (not just the
// membership query) so this can never show LESS than today for an account
// whose user_tenants row predates this fix or was never backfilled — the
// same backward-compatibility fallback auth.service.ts's own login query
// already applies (DEFAULT_TENANT_ID when tenantRows is empty).
//
// FIX 2026-09-14: a platform:admin holder isn't scoped to their own
// membership at all — they operate the platform, so they see every tenant
// regardless of which ones they personally belong to (see tenants.routes.ts's
// assertOwnTenant comment). Everyone else keeps the membership-union behavior
// above, unchanged.
export async function listTenants(activeTenantId: string, requesterId: string, isPlatformAdmin = false) {
  if (isPlatformAdmin) {
    return Tenant.findAll({ order: [["name", "ASC"]] });
  }
  const memberships = await UserTenant.findAll({ where: { userId: requesterId }, attributes: ["tenantId"] });
  const tenantIds = Array.from(new Set([activeTenantId, ...memberships.map((m) => m.tenantId)]));
  return Tenant.findAll({ where: { id: tenantIds }, order: [["name", "ASC"]] });
}

export async function getTenant(id: string) {
  const tenant = await Tenant.findByPk(id);
  if (!tenant) throw new AppError(404, "ERR-TENANT-NOT-FOUND", "Tenant not found");

  const docCount = await Document.count({ where: { tenantId: id, deletedAt: null } });

  return {
    ...tenant.toJSON(),
    docCount
  };
}

// FIX 2026-09-14: every row this used to write below (org_units,
// document_types, departments, document_status_action_roles) has RLS keyed
// on `app.current_tenant` (see requestContext.ts / tenants.service.ts's
// listTenants comment above) — tenantContext middleware (shared/middleware.ts)
// sets that GUC to the CALLER's own active tenant for the whole request, via
// `SET LOCAL` inside one transaction that every query in the request
// automatically joins (Sequelize CLS). createTenant writes rows tagged with
// the BRAND-NEW tenant's id, which never equals the caller's own tenant —
// under a real (non-superuser) DB role that's an RLS policy violation on the
// very first such insert (org_units), which poisons that whole ambient
// transaction (Postgres error 25P02: every later statement in it — the next
// insert, the final response — fails too), so the request 500s and NOTHING
// persists, not even the Tenant row itself (same transaction, same rollback).
// It only ever appeared to work in dev because dev's DB_USER (postgres) is a
// real superuser and always bypasses RLS regardless — so this would have
// broken tenant creation in real production too, the moment prod's DB role
// (also non-superuser, same as mirror's) tried it. Same class of bug as
// seed-core.ts's pre-fix RLS gap, different call site.
//
// Fix: provision the new tenant in its OWN transaction — `{ transaction:
// null }` explicitly opts out of Sequelize's CLS auto-nesting so this does
// NOT become a savepoint of the caller's ambient transaction — and set
// `app.current_tenant` to the NEW tenant's id for just that transaction's
// lifetime. That keeps the caller's own request transaction (and the GUC it
// carries) completely untouched, so the writeAuditLog call after this still
// runs correctly scoped to the ACTING tenant, not the tenant being created.
export async function createTenant(input: unknown, requesterId: string) {
  const data = createTenantSchema.parse(input);

  const existing = await Tenant.findByPk(data.id);
  if (existing) throw new AppError(409, "ERR-TENANT-EXISTS", "Tenant with this ID already exists");

  if (data.initialAdminUserId) {
    const admin = await User.findByPk(data.initialAdminUserId);
    if (!admin || !admin.isActive) {
      throw new AppError(404, "ERR-USER-NOT-FOUND", "initialAdminUserId does not refer to an existing, active user");
    }
  }

  const tenant = await sequelize.transaction({ transaction: null }, async (t) => {
    await sequelize.query("SET LOCAL app.current_tenant = :tenantId", {
      transaction: t,
      replacements: { tenantId: data.id },
    });

    const tenant = await Tenant.create({
      id: data.id,
      name: data.name,
      storageQuotaBytes: data.storageQuotaBytes ?? 10737418240,
      maxUsers: data.maxUsers ?? 50,
      maxDocuments: data.maxDocuments ?? 100000,
      isActive: data.isActive ?? true
    }, { transaction: t });

    // Every tenant needs at least one org unit for departments to attach to —
    // mirrors the default HQ unit the CAMS foundation migration creates for
    // pre-existing tenants (backend/migrations/20260702000001-cams-foundation.sql).
    const hq = await OrgUnit.create({
      tenantId: tenant.id,
      code: "HQ",
      name: `${tenant.name} — Head Office`,
      unitType: "HQ",
    }, { transaction: t });

    // Retention policies are global (unique by code); document types are
    // per-tenant. Seed both for every system doc type filing code depends on —
    // see SYSTEM_RETENTION_POLICIES/SYSTEM_DOCUMENT_TYPES above.
    for (const policy of SYSTEM_RETENTION_POLICIES) {
      await RetentionPolicy.findOrCreate({
        where: { code: policy.code },
        defaults: {
          code: policy.code,
          name: policy.name,
          retentionYears: 5,
          triggerEvent: "DOCUMENT_DATE",
          disposalAction: "CERTIFIED_DELETION",
          authority: policy.authority,
        },
        transaction: t,
      });
    }
    for (const docType of SYSTEM_DOCUMENT_TYPES) {
      const requiresSignature = "requiresSignature" in docType ? docType.requiresSignature : false;
      await DocumentType.create({
        tenantId: tenant.id,
        code: docType.code,
        name: docType.name,
        defaultRetentionClass: docType.retentionClass,
        requiresSignature,
        signingPolicy: requiresSignature ? "ceremony" : "none",
      }, { transaction: t });
    }

    // Fixed fallback bucket for e-signing's direct-upload path when the
    // optional department/type/folder fields are skipped.
    await Department.create({
      tenantId: tenant.id,
      orgUnitId: hq.id,
      code: "UNCAT",
      name: "Uncategorized",
      description: "Fallback department for e-signing uploads that skip department/type/folder selection",
      parentId: null,
      path: "",
      level: 0,
    }, { transaction: t });

    // Archived records are meant to be immutable filed history — checking one
    // out re-opens it for editing, which shouldn't be routine even for staff
    // who could check out an ACTIVE document. Default-deny except SYSTEM_ADMIN,
    // same as statusPermissions.service.ts's assertStatusPermission enforces
    // (absence of a rule row means unrestricted, so this row is what actually
    // makes the restriction exist) — an admin can broaden it from the Access
    // Control Center's Status Rules tab exactly like any other status/action
    // rule, this is only the shipped default for a fresh tenant.
    await DocumentStatusActionRole.create({
      tenantId: tenant.id,
      status: "ARCHIVED",
      action: "checkout",
      roleName: "SYSTEM_ADMIN",
      createdById: requesterId,
    }, { transaction: t });

    // FIX 2026-09-14: createTenant is now a platform:admin-gated operation
    // (tenants.routes.ts) — the requester is the platform admin provisioning
    // this tenant FOR a customer, not that customer's own future admin, so
    // auto-enrolling the requester here (as an earlier version of this fix
    // did) is no longer right: it would leave the platform admin a standing
    // member of every tenant they've ever provisioned, which is more
    // standing access than provisioning requires (they can already reach any
    // tenant via the assertOwnTenant/switchTenant PLATFORM_ADMIN bypasses,
    // without needing a membership row). Instead, enroll the ACTUAL admin
    // this tenant is being created for, if named — same mechanism POST
    // /:id/members already uses. If no initialAdminUserId is given, the
    // tenant is created with zero members; the platform admin (unblocked by
    // the assertOwnTenant bypass) follows up with POST /:id/members once
    // they know who the real admin is.
    if (data.initialAdminUserId) {
      await UserTenant.create({
        userId: data.initialAdminUserId,
        tenantId: tenant.id,
        assignedBy: requesterId,
      }, { transaction: t });
    }

    return tenant;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.TENANT_CREATED,
    userId: requesterId,
    actionDetails: { tenantId: tenant.id, name: tenant.name }
  });

  return tenant;
}

export async function updateTenant(id: string, input: unknown, requesterId: string) {
  const data = tenantSchema.partial().parse(input);
  const tenant = await Tenant.findByPk(id);
  if (!tenant) throw new AppError(404, "ERR-TENANT-NOT-FOUND", "Tenant not found");

  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.storageQuotaBytes !== undefined) updates.storageQuotaBytes = data.storageQuotaBytes;
  if (data.maxUsers !== undefined) updates.maxUsers = data.maxUsers;
  if (data.maxDocuments !== undefined) updates.maxDocuments = data.maxDocuments;
  if (data.isActive !== undefined) updates.isActive = data.isActive;

  await tenant.update(updates);

  await writeAuditLog({
    eventType: AUDIT_EVENTS.TENANT_UPDATED,
    userId: requesterId,
    actionDetails: { tenantId: id, updates }
  });

  return tenant;
}

export async function deactivateTenant(id: string, requesterId: string) {
  const tenant = await Tenant.findByPk(id);
  if (!tenant) throw new AppError(404, "ERR-TENANT-NOT-FOUND", "Tenant not found");

  await tenant.update({ isActive: false });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.TENANT_DEACTIVATED,
    userId: requesterId,
    actionDetails: { tenantId: id, name: tenant.name }
  });

  return tenant;
}
