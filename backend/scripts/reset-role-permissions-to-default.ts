/**
 * Puts a role back on its built-in default permission set, for one tenant or all.
 *
 * WHY THIS EXISTS
 *
 * A role's permissions come from `role_permissions` rows for that
 * (role, tenant) if ANY exist, and only otherwise from the static
 * `ROLE_PERMISSIONS` default in config/permissions.ts (roles.service.ts,
 * getRolePermissionsByRoleId). A tenant that ever saved a role through the
 * Roles screen therefore never sees a later change to that role's default.
 * `backfill-role-permission-overrides.ts` only ADDS permissions the default
 * gained; it cannot remove one, so it cannot bring a role back down to a
 * default that is narrower than what was stored.
 *
 * This is the other half: it deletes the stored rows so the role resolves to
 * the static default again. Typical use is after a default is revised (the
 * 2026-10-04 EXECUTIVE / AUDITOR revision) and a tenant should adopt it.
 *
 * It DESTROYS a deliberate customisation if there is one, so:
 *  - `--role` is mandatory (there is no "all roles" mode),
 *  - the default is a dry run that prints, per tenant, what would be added
 *    and what would be REMOVED relative to the stored set,
 *  - `--execute` is required to change anything,
 *  - PLATFORM_ADMIN is refused outright.
 *
 * Writers of role_permissions audit-log the change and revoke every holder's
 * sessions in the same transaction (an already-issued JWT carries the old
 * permission set until it expires). This does the same.
 *
 * Usage:
 *   npx tsx scripts/reset-role-permissions-to-default.ts --role=EXECUTIVE
 *   npx tsx scripts/reset-role-permissions-to-default.ts --role=EXECUTIVE --tenant=examplecorp
 *   npx tsx scripts/reset-role-permissions-to-default.ts --role=EXECUTIVE --execute
 *
 * npm entry points (these pick the right env file via run-with-env.cjs):
 *   npm run roles:reset-default -- --role=EXECUTIVE           (dev)
 *   npm run roles:reset-default:mirror -- --role=EXECUTIVE
 *   npm run roles:reset-default:prod -- --role=EXECUTIVE
 */

// The env loader, NOT `dotenv/config`: production must read .env.production
// only; dotenv/config would read the dev `.env`.
import "../src/config/env.js";
import { connectDB, initModels, sequelize, UserRole } from "../src/infrastructure/database/index.js";
import { QueryTypes } from "sequelize";
import { ROLE_PERMISSIONS, PERMISSIONS, type Permission } from "../src/config/permissions.js";
import { invalidateRolePermissions } from "../src/infrastructure/cache/roleCache.js";
import { runInTransaction } from "../src/shared/transaction.js";
import { writeAuditLog } from "../src/modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../src/modules/audit/auditEvents.js";
import { revokeAllUserSessions } from "../src/shared/auth.js";

const EXECUTE = process.argv.includes("--execute");
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const roleName = arg("role")?.trim().toUpperCase();
  const onlyTenant = arg("tenant")?.trim();

  if (!roleName) {
    console.error("\n  --role=<ROLE_NAME> is required (there is deliberately no 'all roles' mode).\n");
    process.exit(2);
  }
  if (roleName === "PLATFORM_ADMIN") {
    console.error("\n  PLATFORM_ADMIN is not resettable from here.\n");
    process.exit(2);
  }
  const defaults = ROLE_PERMISSIONS[roleName] as Permission[] | undefined;
  if (!defaults) {
    console.error(`\n  ${roleName} has no built-in default (it is a custom role), so there is nothing to reset to.\n`);
    process.exit(2);
  }
  const defaultSet = new Set<string>(defaults);

  initModels();
  await connectDB();

  const roleRows = await sequelize.query<{ id: string }>(
    `SELECT id FROM roles WHERE name = :roleName`,
    { replacements: { roleName }, type: QueryTypes.SELECT },
  );
  if (roleRows.length === 0) {
    console.log(`\n  No ${roleName} role row exists in this database; it already resolves to the built-in default.\n`);
    return;
  }
  const roleId = roleRows[0].id;

  const stored = await sequelize.query<{ tenant_id: string; permission: string }>(
    `SELECT tenant_id, permission FROM role_permissions
     WHERE role_id = :roleId ${onlyTenant ? "AND tenant_id = :onlyTenant" : ""}
     ORDER BY tenant_id, permission`,
    { replacements: { roleId, onlyTenant }, type: QueryTypes.SELECT },
  );

  const byTenant = new Map<string, Set<string>>();
  for (const row of stored) {
    if (!byTenant.has(row.tenant_id)) byTenant.set(row.tenant_id, new Set());
    byTenant.get(row.tenant_id)!.add(row.permission);
  }

  if (byTenant.size === 0) {
    console.log(`\n  ${roleName}${onlyTenant ? ` in ${onlyTenant}` : ""} has no stored override: it already resolves to the built-in default (${defaults.length} permissions).\n`);
    return;
  }

  console.log(`\n  ${roleName}: built-in default is ${defaults.length} permissions. ${byTenant.size} tenant(s) have a stored override.\n`);
  for (const [tenantId, set] of byTenant) {
    const removed = [...set].filter((p) => !defaultSet.has(p)).sort();
    const added = defaults.filter((p) => !set.has(p)).sort();
    console.log(`  tenant=${tenantId}: stored ${set.size}, default ${defaults.length}`);
    console.log(`    would LOSE   (${removed.length}): ${removed.join(", ") || "-"}`);
    console.log(`    would GAIN   (${added.length}): ${added.join(", ") || "-"}`);
    if (removed.includes(PERMISSIONS.ACL_BYPASS_ADMIN) || removed.includes(PERMISSIONS.USER_MANAGE)) {
      console.log(`    note: this stored set carries admin-level grants; resetting takes them away.`);
    }
  }

  if (!EXECUTE) {
    console.log("\n  Dry run only. Re-run with --execute to apply.\n");
    return;
  }

  await runInTransaction(async (t) => {
    for (const [tenantId, set] of byTenant) {
      await sequelize.query(
        `DELETE FROM role_permissions WHERE role_id = :roleId AND tenant_id = :tenantId`,
        { replacements: { roleId, tenantId }, transaction: t },
      );
      await writeAuditLog(
        {
          eventType: AUDIT_EVENTS.ROLE_PERMISSIONS_UPDATED,
          userId: null,
          tenantId,
          actionDetails: {
            roleId,
            roleName,
            tenantId,
            source: "reset-role-permissions-to-default.ts",
            resetToDefault: true,
            removedPermissions: [...set].filter((p) => !defaultSet.has(p)).sort(),
            addedPermissions: defaults.filter((p) => !set.has(p)).sort(),
          },
        },
        t,
      );
    }

    const holders = await UserRole.findAll({ where: { roleId }, attributes: ["userId"], raw: true, transaction: t });
    for (const holderId of new Set(holders.map((h) => h.userId))) {
      // Sequential, same reasoning as replaceRolePermissions.
      await revokeAllUserSessions(holderId, { transaction: t, reason: "role-permission-reset-to-default" });
    }

    t.afterCommit(() => {
      for (const tenantId of byTenant.keys()) {
        void invalidateRolePermissions(tenantId, roleId).catch((err) => {
          console.error(`  Failed to invalidate role-permission cache for ${tenantId}:${roleId}:`, err);
        });
      }
    });
  });

  console.log(`\n  Applied. ${roleName} now resolves to the built-in default in ${byTenant.size} tenant(s); holders' sessions were revoked and the change is audit-logged.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
