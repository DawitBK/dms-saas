/**
 * Adds newly-granted static-default permissions to any EXISTING per-tenant
 * `role_permissions` override rows that would otherwise silently shadow them.
 *
 * WHY THIS EXISTS
 *
 * `getRolePermissionsByRoleId` (roles.service.ts) resolves a role's
 * permissions from the `role_permissions` table for that (roleId, tenantId)
 * ONLY IF at least one row exists there — if a tenant has ever customized a
 * role via the Roles admin screen, that tenant's stored rows become the
 * complete, final answer for that role, and the static `ROLE_PERMISSIONS`
 * default in config/permissions.ts is never consulted again, not even for
 * permissions added to the default after the override was saved.
 *
 * This bit us directly: SIGNING_MANAGE and FORM_TEMPLATE_MANAGE were added to
 * DEPT_MANAGER/APPROVER/EMPLOYEE's static defaults, but `examplecorp` already
 * had explicit override rows for DEPT_MANAGER and APPROVER from earlier admin
 * customization — those tenants kept the old, narrower permission set until
 * the override rows were manually patched via the Roles admin API. This
 * script does that patch generically, for every tenant/role combination that
 * has override rows, instead of one tenant at a time by hand.
 *
 * This script ONLY adds rows for permissions a role newly gained in its
 * static ROLE_PERMISSIONS default (config/permissions.ts) — it never removes
 * a row, and never touches a (role, tenant) pair with zero override rows
 * (those already resolve to the static default with no fix needed).
 *
 * Usage:
 *   npx tsx scripts/backfill-role-permission-overrides.ts            # dry run
 *   npx tsx scripts/backfill-role-permission-overrides.ts --execute  # apply
 */

// The env loader, NOT `dotenv/config`: production must read .env.production
// only (root CLAUDE.md, "Env files"); dotenv/config would read the dev `.env`,
// so `NODE_ENV=production` runs of this script would have hit the dev database.
import "../src/config/env.js";
import { connectDB, initModels, sequelize, UserRole } from "../src/infrastructure/database/index.js";
import { QueryTypes } from "sequelize";
import { ROLE_PERMISSIONS, type Permission } from "../src/config/permissions.js";
import { invalidateRolePermissions } from "../src/infrastructure/cache/roleCache.js";
import { runInTransaction } from "../src/shared/transaction.js";
import { writeAuditLog } from "../src/modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../src/modules/audit/auditEvents.js";
import { revokeAllUserSessions } from "../src/shared/auth.js";

const EXECUTE = process.argv.includes("--execute");

async function main() {
  initModels();
  await connectDB();

  const overriddenRoles = await sequelize.query<{ tenant_id: string; role_id: string; role_name: string }>(
    `SELECT DISTINCT rp.tenant_id, rp.role_id, r.name AS role_name
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     ORDER BY rp.tenant_id, r.name`,
    { type: QueryTypes.SELECT },
  );

  console.log(`\n  ${overriddenRoles.length} (tenant, role) pairs have stored permission overrides.\n`);

  let totalMissing = 0;
  const toInsert: { tenantId: string; roleId: string; permission: Permission }[] = [];
  const roleNameById = new Map<string, string>();

  for (const { tenant_id, role_id, role_name } of overriddenRoles) {
    roleNameById.set(role_id, role_name);
    const staticDefault = (ROLE_PERMISSIONS[role_name] ?? []) as Permission[];
    if (staticDefault.length === 0) continue;

    const existing = await sequelize.query<{ permission: string }>(
      `SELECT permission FROM role_permissions WHERE tenant_id = :tenantId AND role_id = :roleId`,
      { replacements: { tenantId: tenant_id, roleId: role_id }, type: QueryTypes.SELECT },
    );
    const existingSet = new Set(existing.map((r) => r.permission));
    const missing = staticDefault.filter((p) => !existingSet.has(p));

    if (missing.length > 0) {
      console.log(`  tenant=${tenant_id} role=${role_name}: missing ${missing.join(", ")}`);
      totalMissing += missing.length;
      for (const permission of missing) {
        toInsert.push({ tenantId: tenant_id, roleId: role_id, permission });
      }
    }
  }

  if (totalMissing === 0) {
    console.log("  Nothing to backfill — every override already has its full static-default permission set.\n");
    return;
  }

  console.log(`\n  ${totalMissing} row(s) would be inserted across ${new Set(toInsert.map((r) => `${r.tenantId}:${r.roleId}`)).size} role override(s).`);

  if (!EXECUTE) {
    console.log("\n  Dry run only — re-run with --execute to apply.\n");
    return;
  }

  const affectedPairs = new Set(toInsert.map((r) => `${r.tenantId}:${r.roleId}`));

  // RBAC-4/COMP-3: every *route-driven* writer of role_permissions
  // (replaceRolePermissions) audit-logs the change and revokes every
  // affected holder's live sessions in the same transaction as the write —
  // this script used to do neither, leaving no historical record that a
  // permission grant happened here, and leaving every already-issued JWT for
  // an affected role carrying the OLD (narrower) permission set until it
  // naturally expired. Mirrors replaceRolePermissions's exact shape: one
  // audit row per (tenant, role) pair actually changed, and one session
  // revocation per distinct role holder (Role is a global entity — not
  // tenant-scoped — so a permission change to one tenant's override of a
  // role is deliberately treated the same as replaceRolePermissions treats
  // it: revoke every holder of that role name, not just holders in the
  // tenant whose override changed, since UserRole itself carries no
  // tenantId to filter by, and over-revoking a session is safe).
  await runInTransaction(async (t) => {
    for (const row of toInsert) {
      await sequelize.query(
        `INSERT INTO role_permissions (id, tenant_id, role_id, permission, created_at)
         VALUES (gen_random_uuid(), :tenantId, :roleId, :permission, now())
         ON CONFLICT (tenant_id, role_id, permission) DO NOTHING`,
        { replacements: row, transaction: t },
      );
    }

    for (const pair of affectedPairs) {
      const [tenantId, roleId] = pair.split(":");
      const missingForPair = toInsert.filter((r) => r.tenantId === tenantId && r.roleId === roleId);
      await writeAuditLog(
        {
          eventType: AUDIT_EVENTS.ROLE_PERMISSIONS_UPDATED,
          userId: null,
          tenantId,
          actionDetails: {
            roleId,
            roleName: roleNameById.get(roleId) ?? null,
            tenantId,
            source: "backfill-role-permission-overrides.ts",
            addedPermissions: missingForPair.map((r) => r.permission),
          },
        },
        t,
      );
    }

    const affectedRoleIds = new Set(toInsert.map((r) => r.roleId));
    const holders = await UserRole.findAll({
      where: { roleId: Array.from(affectedRoleIds) },
      attributes: ["userId"],
      raw: true,
      transaction: t,
    });
    for (const holderId of new Set(holders.map((h) => h.userId))) {
      // Sequential, not Promise.all — same reasoning as replaceRolePermissions:
      // these are upserts onto the same table inside one transaction, and
      // concurrent writes there would contend on row locks for no gain.
      await revokeAllUserSessions(holderId, {
        transaction: t,
        reason: "role-permission-backfill",
      });
    }

    t.afterCommit(() => {
      for (const pair of affectedPairs) {
        const [tenantId, roleId] = pair.split(":");
        void invalidateRolePermissions(tenantId, roleId).catch((err) => {
          console.error(`  Failed to invalidate role-permission cache for ${pair}:`, err);
        });
      }
    });
  });

  console.log(`\n  Applied. ${affectedPairs.size} role override(s) updated, audit-logged, and their holders' sessions revoked.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
