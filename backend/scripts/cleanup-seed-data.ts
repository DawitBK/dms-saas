/**
 * Removes demo / seed / test data from a DMS database, and nothing else.
 *
 * What counts as seed data (and ONLY this):
 *  - users whose email ends in `@edams.local` (the accounts scripts/seed-core.ts creates);
 *  - any further users you name with --users=a@x,b@y;
 *  - the tenants you name with --tenants=demo-org,other (default: demo-org);
 *  - everything that depends on those: the documents they own, versions, ACL rows, workflow
 *    instances, letters, signing requests, notifications, memberships and so on, found by
 *    following the database's own foreign keys, not by a hand-maintained list.
 *
 * What is never touched: the platform administrator (the run REFUSES if one is in the
 * target set), the real tenant (DMS_DEFAULT_TENANT, `examplecorp`), reference data (roles,
 * departments, document types, retention policies), the SSO-provisioned legacy users,
 * and the audit trail (it is immutable and holds no foreign keys; rows that name a deleted
 * user keep naming it).
 *
 * Safe by construction: DRY RUN unless --execute. The whole thing is one transaction, so a
 * failure leaves the database exactly as it was. In mirror/production it additionally
 * demands I_UNDERSTAND_THIS_DELETES=<database name>.
 *
 * Usage (from DMS/backend; mirror/production MUST use the launcher or this targets DEV):
 *   npx tsx scripts/cleanup-seed-data.ts                          dry run, defaults
 *   npx tsx scripts/cleanup-seed-data.ts --tenants=demo-org,fsfds --users=ellu@gmail.com
 *   npx tsx scripts/cleanup-seed-data.ts --execute
 *   node scripts/run-with-env.cjs mirror npx tsx scripts/cleanup-seed-data.ts --execute
 *
 * Tenants that have the platform administrator as a member are SKIPPED and reported: removing
 * the tenant would remove that membership, and the database refuses to touch the platform
 * administrator without the owner's vault password (which this script never has).
 *
 * --personal-groups-file=<json> (written by SSO/backend/scripts/cleanup-seed-data.ts) names the
 * SSO personal groups of the accounts SSO removed; their role mappings live in this database
 * and are removed here too.
 *
 * --tenants-only: with --tenants, remove just those tenants and what depends on them; the `@edams.local` demo accounts are NOT swept in (they are by default).
 *
 * --org-units=CODE[,CODE] (with --org-unit-tenant=<tenant>, default the real tenant) starts instead from those organisation
 * units of the real tenant: their departments, folders, documents, letters, versions, access rows and so on go with them,
 * found the same way. In this mode no seed users and no tenants are targeted, and the run REFUSES if the closure would
 * remove any user account. Use it to remove test organisation units that hold test content; the audit trail stays.
 *
 * Afterwards the encrypted document FILES of the removed documents are orphaned on disk:
 * run `npx tsx scripts/sweep-orphaned-storage.ts` (dry run first) to reclaim them.
 */
import '../src/config/env.js';
import fs from 'node:fs';
import { Client } from 'pg';
import { config } from '../src/config/env.js';

const EXECUTE = process.argv.includes('--execute');
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (v: string | undefined, dflt: string[]): string[] =>
  v === undefined ? dflt : v.split(',').map((s) => s.trim()).filter(Boolean);

interface Fk {
  child: string;
  parent: string;
  childCols: string[];
  parentCols: string[];
  rule: 'a' | 'r' | 'c' | 'n' | 'd';
  /** Every referencing column may be NULL, so the row can outlive what it points at. */
  nullable: boolean;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function loadForeignKeys(c: Client): Promise<Fk[]> {
  const { rows } = await c.query(`
    SELECT cl.relname AS child, pa.relname AS parent, con.confdeltype AS rule,
      (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS child_cols,
      (SELECT array_agg(att.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS parent_cols,
      NOT EXISTS (SELECT 1 FROM unnest(con.conkey) kk(attnum)
         JOIN pg_attribute a2 ON a2.attrelid = con.conrelid AND a2.attnum = kk.attnum WHERE a2.attnotnull) AS nullable
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pa ON pa.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'`);
  return rows.map((r) => ({ child: r.child, parent: r.parent, childCols: r.child_cols, parentCols: r.parent_cols, rule: r.rule, nullable: r.nullable }));
}

async function main() {
  const dbName = String(config.DB_NAME);
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (EXECUTE && (nodeEnv === 'production' || nodeEnv === 'mirror') && process.env.I_UNDERSTAND_THIS_DELETES !== dbName) {
    console.error(`\n  Refusing to DELETE from "${dbName}" (NODE_ENV=${nodeEnv}) without I_UNDERSTAND_THIS_DELETES=${dbName}.\n`);
    process.exit(2);
  }

  const orgUnitCodes = list(arg('org-units'), []);
  const orgUnitMode = orgUnitCodes.length > 0;
  const tenantsOnly = process.argv.includes('--tenants-only');
  const tenants = orgUnitMode ? [] : list(arg('tenants'), ['demo-org']);
  const extraUsers = orgUnitMode ? [] : list(arg('users'), []).map((e) => e.toLowerCase());
  const realTenant = String(process.env.DMS_DEFAULT_TENANT ?? 'examplecorp');
  if (tenants.includes(realTenant)) {
    console.error(`\n  "${realTenant}" is the real tenant and cannot be listed in --tenants.\n`);
    process.exit(2);
  }

  const c = new Client({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_MIGRATE_USER || config.DB_USER,
    password: (config.DB_MIGRATE_USER ? config.DB_MIGRATE_PASSWORD : config.DB_PASSWORD) || undefined,
  });
  await c.connect();
  console.log(`\n  database: ${dbName}   mode: ${EXECUTE ? 'EXECUTE' : 'dry run (nothing is changed)'}`);

  try {
    await c.query('BEGIN');
    // The mirror and production connect as the restricted application role, which row-level security limits to one tenant at a time: without this the
    // tool sees no rows at all and reports "nothing to remove". Scoped to this transaction only (set_config ... true).
    if (orgUnitMode) await c.query("SELECT set_config('app.current_tenant', $1, true)", [arg('org-unit-tenant') ?? realTenant]);

    // ---- the seed users, and the safety refusals
    const seedUsers = orgUnitMode ? [] : (await c.query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE (lower(email) LIKE '%@edams.local' AND NOT $2::boolean) OR lower(email) = ANY($1::text[])`,
      [extraUsers, tenantsOnly],
    )).rows;
    const orgUnitTenant = arg('org-unit-tenant') ?? realTenant;
    const orgUnitRows = orgUnitMode
      ? (await c.query<{ id: string; code: string }>(`SELECT id, code FROM org_units WHERE tenant_id = $1 AND code = ANY($2::text[])`, [orgUnitTenant, orgUnitCodes])).rows
      : [];
    if (orgUnitMode) {
      const missing = orgUnitCodes.filter((x) => !orgUnitRows.some((r) => r.code === x));
      if (missing.length) console.log(`  not found in "${orgUnitTenant}" (nothing to do for them): ${missing.join(', ')}`);
      console.log(`  org units:    ${orgUnitRows.length}  (${orgUnitRows.map((r) => r.code).join(', ') || '-'})`);
    }
    const protectedHit = (await c.query<{ email: string }>(
      `SELECT u.email FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'PLATFORM_ADMIN' AND u.id = ANY($1::uuid[])`,
      [seedUsers.map((u) => u.id)],
    )).rows;
    if (protectedHit.length > 0) {
      console.error('\n  REFUSING: the target set contains a platform administrator. Nothing was changed.\n');
      await c.query('ROLLBACK');
      process.exit(3);
    }

    const existingTenants = (await c.query<{ id: string }>(`SELECT id FROM tenants WHERE id = ANY($1::text[])`, [tenants])).rows.map((r) => r.id);
    const paTenants = new Set((await c.query<{ tenant_id: string }>(
      `SELECT DISTINCT ut.tenant_id FROM user_tenants ut
         JOIN user_roles ur ON ur.user_id = ut.user_id
         JOIN roles r ON r.id = ur.role_id AND r.name = 'PLATFORM_ADMIN'
        WHERE ut.tenant_id = ANY($1::text[])`,
      [existingTenants],
    )).rows.map((r) => r.tenant_id));
    for (const t of paTenants) {
      console.log(`  skipping tenant "${t}": the platform administrator is a member, and removing it would remove that membership (needs the vault).`);
    }
    const tenantRows = existingTenants.filter((t) => !paTenants.has(t));
    console.log(`  seed users:   ${seedUsers.length}  (${seedUsers.slice(0, 5).map((u) => u.email).join(', ')}${seedUsers.length > 5 ? ', …' : ''})`);
    console.log(`  seed tenants: ${tenantRows.length}  (${tenantRows.join(', ') || '-'})`);
    if (seedUsers.length === 0 && tenantRows.length === 0 && orgUnitRows.length === 0) {
      console.log('\n  Nothing to remove.\n');
      await c.query('ROLLBACK');
      return;
    }

    // ---- closure over the foreign keys, in temp tables of row ids (ctid)
    // The application role (mirror, production) cannot read some tables on purpose (the platform vault). A table it cannot read cannot be walked; if one of them did
    // depend on a row being deleted, the database would refuse the DELETE and the whole transaction would roll back, so skipping them is safe.
    const unreadable = new Set((await c.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT has_table_privilege(current_user, c.oid, 'SELECT')`,
    )).rows.map((r) => r.relname));
    if (unreadable.size > 0) console.log(`  not readable by this database role (skipped): ${[...unreadable].join(', ')}`);
    // In org-unit mode no user account is ever removed (the run refuses if one would be), so the users table is left out of the walk. This also matters on the mirror: a row-level policy on
    // users (users_hide_platform_admin) consults the vault, which the application role cannot read, so ANY read of users by that role fails.
    const fks = (await loadForeignKeys(c)).filter((f) => !unreadable.has(f.child) && !unreadable.has(f.parent) && !(orgUnitMode && (f.child === 'users' || f.parent === 'users')));
    if (orgUnitMode) {
      // A folder, form template, saved search, key or sequence carrying a doomed department or unit id belongs to it, even where the database only says
      // "set null" (folder_nodes.department_id) or has no foreign key (dept_keys): without this they would outlive their department as orphans.
      const owned = (await c.query<{ t: string; col: string }>(
        `SELECT c.table_name t, c.column_name col FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.column_name IN ('department_id', 'org_unit_id') AND c.table_name NOT IN ('departments', 'user_departments')`,
      )).rows;
      for (const o of owned) fks.push({ child: o.t, parent: o.col === 'department_id' ? 'departments' : 'org_units', childCols: [o.col], parentCols: ['id'], rule: 'c', nullable: false });
    }
    const tables = new Set<string>(['users', 'tenants']);
    for (const f of fks) { tables.add(f.child); tables.add(f.parent); }
    const tmp = new Map<string, string>();
    let n = 0;
    for (const t of tables) {
      const name = `del_${n++}`;
      tmp.set(t, name);
      await c.query(`CREATE TEMP TABLE ${name} (ct tid PRIMARY KEY) ON COMMIT DROP`);
    }
    const T = (t: string) => tmp.get(t)!;
    const ctOf = (t: string) => `SELECT ct FROM ${T(t)}`;

    if (seedUsers.length > 0) {
      await c.query(`INSERT INTO ${T('users')} SELECT ctid FROM users WHERE id = ANY($1::uuid[])`, [seedUsers.map((u) => u.id)]);
    }
    if (orgUnitRows.length > 0) {
      await c.query(`INSERT INTO ${T('org_units')} SELECT ctid FROM org_units WHERE id = ANY($1::uuid[])`, [orgUnitRows.map((r) => r.id)]);
    }
    if (tenantRows.length > 0) {
      await c.query(`INSERT INTO ${T('tenants')} SELECT ctid FROM tenants WHERE id = ANY($1::text[])`, [tenantRows]);
      // Tenant-scoped tables often carry tenant_id without a declared foreign key; seed them directly.
      const withTenant = (await c.query<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name <> 'audit_logs'`,
      )).rows.map((r) => r.table_name);
      for (const t of withTenant) {
        if (!tmp.has(t)) { const name = `del_${n++}`; tmp.set(t, name); tables.add(t); await c.query(`CREATE TEMP TABLE ${name} (ct tid PRIMARY KEY) ON COMMIT DROP`); }
        await c.query(`INSERT INTO ${T(t)} SELECT ctid FROM ${q(t)} WHERE tenant_id = ANY($1::text[]) ON CONFLICT DO NOTHING`, [tenantRows]);
      }
    }

    // Fixed point: whatever cannot exist without a doomed row is doomed too. That is a CASCADE
    // reference, or a NO ACTION / RESTRICT reference through a column that cannot be NULL
    // (a document's owner). A reference through a nullable column (assigned_by, approved_by,
    // created_by ...) is only an attribution: the row survives and the reference is cleared below.
    const dependents = fks.filter((f) => f.rule === 'c' || ((f.rule === 'a' || f.rule === 'r') && !f.nullable));
    const detach = fks.filter((f) => f.rule === 'n' || ((f.rule === 'a' || f.rule === 'r') && f.nullable));
    for (let pass = 0; pass < 50; pass++) {
      let grew = false;
      for (const f of dependents) {
        const cc = f.childCols.map((x) => `c.${q(x)}`).join(', ');
        const pc = f.parentCols.map((x) => `p.${q(x)}`).join(', ');
        const res = await c.query(
          `INSERT INTO ${T(f.child)}
             SELECT c.ctid FROM ${q(f.child)} c
              WHERE (${cc}) IN (SELECT ${pc} FROM ${q(f.parent)} p WHERE p.ctid IN (${ctOf(f.parent)}))
             ON CONFLICT DO NOTHING`,
        );
        if ((res.rowCount ?? 0) > 0) grew = true;
      }
      if (!grew) break;
    }

    // Polymorphic references that no foreign key can express.
    const doomedDocIds = (await c.query<{ id: string }>(`SELECT id FROM documents WHERE ctid IN (${ctOf('documents')})`)).rows.map((r) => r.id);
    const doomedFolderIds = (await c.query<{ id: string }>(`SELECT id FROM folder_nodes WHERE ctid IN (${ctOf('folder_nodes')})`)).rows.map((r) => r.id);
    const doomedUserIds = seedUsers.map((u) => u.id);
    const idsOf = async (t: string) => (tmp.has(t) ? (await c.query<{ id: string }>(`SELECT id FROM ${q(t)} WHERE ctid IN (${ctOf(t)})`)).rows.map((r) => r.id) : []);
    const doomedTaskIds = await idsOf('workflow_tasks');
    const doomedDeptIds = await idsOf('departments');
    const polymorphic: { table: string; where: string; params: unknown[] }[] = [
      { table: 'acl_entries', where: `(principal_type = 'user' AND principal_id = ANY($1::text[])) OR (resource_type = 'document' AND resource_id = ANY($2::uuid[])) OR (resource_type = 'folder' AND resource_id = ANY($3::uuid[])) OR (resource_type = 'workflow_task' AND resource_id = ANY($4::uuid[])) OR (resource_type = 'department' AND resource_id = ANY($5::uuid[]))`, params: [doomedUserIds, doomedDocIds, doomedFolderIds, doomedTaskIds, doomedDeptIds] },
      { table: 'access_rules', where: `principal_type = 'user' AND principal_id = ANY($1::text[])`, params: [doomedUserIds] },
    ];
    for (const p of polymorphic) {
      if (!tmp.has(p.table)) { const name = `del_${n++}`; tmp.set(p.table, name); tables.add(p.table); await c.query(`CREATE TEMP TABLE ${name} (ct tid PRIMARY KEY) ON COMMIT DROP`); }
      await c.query(`INSERT INTO ${T(p.table)} SELECT ctid FROM ${q(p.table)} WHERE ${p.where} ON CONFLICT DO NOTHING`, p.params);
    }
    // SSO's role mapping for a deleted user's personal group lives in this database too. The group
    // is named by the SSO account id (not this database's user id), so SSO hands us the list.
    const personalGroupsFile = arg('personal-groups-file');
    const removedPersonalGroups: string[] = personalGroupsFile
      ? (JSON.parse(fs.readFileSync(personalGroupsFile, 'utf8')) as { personalGroupDns?: string[] }).personalGroupDns ?? []
      : [];
    if (removedPersonalGroups.length > 0) {
      const dns = removedPersonalGroups;
      if (!tmp.has('idp_role_mappings')) { const name = `del_${n++}`; tmp.set('idp_role_mappings', name); tables.add('idp_role_mappings'); await c.query(`CREATE TEMP TABLE ${name} (ct tid PRIMARY KEY) ON COMMIT DROP`); }
      await c.query(`INSERT INTO ${T('idp_role_mappings')} SELECT ctid FROM idp_role_mappings WHERE ad_group_dn = ANY($1::text[]) ON CONFLICT DO NOTHING`, [dns]);
    }

    if (orgUnitMode) {
      const doomedUsers = Number((await c.query<{ n: string }>(`SELECT count(*)::text n FROM ${T('users')}`)).rows[0]!.n);
      if (doomedUsers > 0) {
        console.error(`
  REFUSING: removing these organisation units would also remove ${doomedUsers} user account(s). Nothing was changed.
`);
        await c.query('ROLLBACK');
        process.exit(3);
      }
    }

    // Report.
    const report: { table: string; rows: number }[] = [];
    for (const t of tables) {
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text n FROM ${T(t)}`);
      if (Number(rows[0].n) > 0) report.push({ table: t, rows: Number(rows[0].n) });
    }
    report.sort((a, b) => b.rows - a.rows);
    console.log('\n  rows that would be removed:');
    for (const r of report) console.log(`    ${r.table.padEnd(36)} ${r.rows}`);
    console.log(`    ${'TOTAL'.padEnd(36)} ${report.reduce((s, r) => s + r.rows, 0)}`);

    if (!EXECUTE) {
      await c.query('ROLLBACK');
      console.log('\n  Dry run only. Re-run with --execute to apply.\n');
      return;
    }

    // Detach (SET NULL) references from rows that survive.
    for (const f of detach) {
      if (!tmp.has(f.parent) || !tmp.has(f.child)) continue;
      const sets = f.childCols.map((x) => `${q(x)} = NULL`).join(', ');
      const cc = f.childCols.map((x) => `c.${q(x)}`).join(', ');
      const pc = f.parentCols.map((x) => `p.${q(x)}`).join(', ');
      await c.query(
        `UPDATE ${q(f.child)} c SET ${sets}
          WHERE (${cc}) IN (SELECT ${pc} FROM ${q(f.parent)} p WHERE p.ctid IN (${ctOf(f.parent)}))
            AND c.ctid NOT IN (${ctOf(f.child)})`,
      );
    }

    // Delete children before parents. The order must respect EVERY reference between two tables that
    // are both being deleted from, including nullable ones: a document whose folder column can be NULL
    // still has to go before its folder if the document is being deleted too. (A table that references
    // itself is deleted in one statement, which PostgreSQL checks at the end of the statement.)
    // If that full ordering has a cycle, fall back to the references that are mandatory.
    const orderFor = (edges: Fk[]): string[] | null => {
      const out: string[] = [];
      const left = new Set(report.map((r) => r.table));
      while (left.size > 0) {
        const ready = [...left].filter((t) => !edges.some((f) => f.parent === t && f.child !== t && left.has(f.child)));
        if (ready.length === 0) return null;
        for (const t of ready) { out.push(t); left.delete(t); }
      }
      return out;
    };
    const everyReference = fks.filter((f) => f.rule === 'a' || f.rule === 'r' || f.rule === 'c');
    const order = orderFor(everyReference) ?? orderFor(dependents);
    if (!order) throw new Error('cyclic dependency between the tables being cleaned; refusing to guess an order');
    let total = 0;
    for (const t of order) {
      const res = await c.query(`DELETE FROM ${q(t)} WHERE ctid IN (${ctOf(t)})`);
      total += res.rowCount ?? 0;
    }
    await c.query('COMMIT');
    console.log(`\n  Removed ${total} rows in one transaction. The audit trail was not touched.`);
    console.log('  Next: `npx tsx scripts/sweep-orphaned-storage.ts` (dry run first) to reclaim the removed documents\' encrypted files.\n');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? (process.env.DEBUG_CLEANUP ? e.stack : e.message) : e); process.exit(1); });
