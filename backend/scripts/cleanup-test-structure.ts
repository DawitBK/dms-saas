/**
 * cleanup-test-structure.ts: removes the empty "Test Root / Child / Grandchild Dept <number>" departments (and their auto-created folders) that old automated test runs left in a
 * tenant, and nothing else.
 *
 * Those tests created a department tree under a scratch organisation unit and never removed it. They hold no people, documents, document types or letters, but they show up in
 * every department picker and tree. `cleanup-seed-data.ts` cannot help: it removes demo tenants and users and deliberately never touches departments.
 *
 * Safe by construction:
 *  - DRY RUN unless --execute; one transaction, so a failure leaves the database as it was.
 *  - A department is a candidate only if its NAME matches the test pattern (default `^Test (Root|Child|Grandchild) Dept [0-9]+`), and the whole run REFUSES if anything outside the
 *    candidate set refers to a candidate department or to one of their folders (a person, a document, a document type, a letter, a form, a bundle...), found by following the
 *    database's own foreign keys, not a hand-kept list.
 *  - The only things deleted are the access-control rows on those folders, the folders, the departments, and (with --unit=CODE) the organisation unit if it is left with no
 *    departments. The audit trail is never touched.
 *  - mirror/production additionally demand I_UNDERSTAND_THIS_DELETES=<database name>.
 *
 * Three opt-in switches, for structure that is not named like a test but is known to be one:
 *  --department=CODE[,CODE]  also remove these departments, but only inside the organisation units named with --unit
 *  --detach-members          take the people out of those departments first (their accounts stay; only the membership row goes)
 *  --drop-sequences          drop the letter and form numbering counters of a unit being removed (a counter is not a letter: a unit that has letters or forms is still refused)
 *
 *   npx tsx scripts/cleanup-test-structure.ts                       dry run (development)
 *   npx tsx scripts/cleanup-test-structure.ts --execute --unit=DANIEL,TEST-BR-CAMS      (also remove these organisation units if they end up with no departments)
 *   node scripts/run-with-env.cjs mirror npx tsx scripts/cleanup-test-structure.ts --execute    (needs I_UNDERSTAND_THIS_DELETES)
 */
import '../src/config/env.js';
import { Client } from 'pg';
import { config } from '../src/config/env.js';

const EXECUTE = process.argv.includes('--execute');
const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const TENANT = arg('tenant') ?? process.env.DMS_DEFAULT_TENANT ?? 'examplecorp';
const PATTERN = arg('pattern') ?? '^Test (Root|Child|Grandchild) Dept [0-9]+';
const UNITS = (arg('unit') ?? '').split(',').map((u) => u.trim()).filter(Boolean);
const DEPT_CODES = (arg('department') ?? '').split(',').map((u) => u.trim()).filter(Boolean);
const DETACH = process.argv.includes('--detach-members');
const DROP_SEQUENCES = process.argv.includes('--drop-sequences');
const SEQUENCE_TABLES = new Set(['letter_sequences', 'form_sequences']);

async function main(): Promise<void> {
  const dbName = String(config.DB_NAME);
  if ((process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'mirror') && EXECUTE && process.env.I_UNDERSTAND_THIS_DELETES !== dbName) {
    console.error(`Refusing to delete from "${dbName}" (NODE_ENV=${process.env.NODE_ENV}). Set I_UNDERSTAND_THIS_DELETES=${dbName} if you mean it.`);
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
  console.log(`database: ${dbName}   tenant: ${TENANT}   mode: ${EXECUTE ? 'EXECUTE' : 'dry run (nothing is changed)'}`);
  try {
    await c.query('BEGIN');
    const depts = (await c.query<{ id: string; code: string }>(
      `SELECT d.id, d.code FROM departments d JOIN org_units o ON o.id = d.org_unit_id
        WHERE d.tenant_id = $1 AND (d.name ~ $2 OR (o.code = ANY($3::text[]) AND d.code = ANY($4::text[])))`, [TENANT, PATTERN, UNITS, DEPT_CODES])).rows;
    const deptIds = depts.map((d) => d.id);
    console.log(`candidate departments: ${deptIds.length}`);
    if (deptIds.length === 0 && UNITS.length === 0) { await c.query('ROLLBACK'); await c.end(); return; }

    const folders = (await c.query<{ id: string }>(`SELECT id FROM folder_nodes WHERE department_id = ANY($1::uuid[])`, [deptIds])).rows.map((r) => r.id);
    console.log(`their folders: ${folders.length}`);
    if (DETACH && deptIds.length) {
      const memberships = (await c.query(`DELETE FROM user_departments WHERE department_id = ANY($1::uuid[])`, [deptIds])).rowCount;
      console.log(`people taken out of these departments (accounts stay): ${memberships}`);
    }

    // Anything else that points at a candidate department or folder stops the run.
    const refusals: string[] = [];
    const fks = async (parent: string) =>
      (await c.query<{ t: string; col: string }>(
        `SELECT conrelid::regclass::text AS t, a.attname AS col FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
          WHERE k.contype = 'f' AND k.confrelid = $1::regclass`, [parent])).rows;
    for (const f of await fks('departments')) {
      if ((f.t === 'departments' && f.col === 'parent_id') || (f.t === 'folder_nodes' && f.col === 'department_id')) continue;
      if (deptIds.length === 0) continue;
      const n = Number((await c.query(`SELECT count(*) AS n FROM ${f.t} WHERE "${f.col}" = ANY($1::uuid[])`, [deptIds])).rows[0]!.n);
      if (n > 0) refusals.push(`${f.t}.${f.col}: ${n} row(s) refer to a candidate department`);
    }
    if (folders.length > 0) {
      for (const f of await fks('folder_nodes')) {
        if (f.t === 'folder_nodes' && f.col === 'parent_id') continue;
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${f.t} WHERE "${f.col}" = ANY($1::uuid[])`, [folders])).rows[0]!.n);
        if (n > 0) refusals.push(`${f.t}.${f.col}: ${n} row(s) refer to a candidate folder`);
      }
      const outside = Number((await c.query(`SELECT count(*) AS n FROM folder_nodes WHERE parent_id = ANY($1::uuid[]) AND id <> ALL($1::uuid[])`, [folders])).rows[0]!.n);
      if (outside > 0) refusals.push(`folder_nodes.parent_id: ${outside} folder(s) outside the candidates sit under a candidate folder`);
    }
    const outsideKids = Number((await c.query(`SELECT count(*) AS n FROM departments WHERE parent_id = ANY($1::uuid[]) AND id <> ALL($1::uuid[])`, [deptIds])).rows[0]!.n);
    if (outsideKids > 0) refusals.push(`departments.parent_id: ${outsideKids} department(s) outside the candidates sit under a candidate`);
    if (refusals.length) {
      console.error('REFUSING: something real depends on these departments:\n  ' + refusals.join('\n  '));
      await c.query('ROLLBACK');
      process.exit(1);
    }

    const acl = (folders.length ? (await c.query(`DELETE FROM acl_entries WHERE resource_type = 'folder' AND resource_id = ANY($1::uuid[])`, [folders])).rowCount ?? 0 : 0)
      + ((await c.query(`DELETE FROM acl_entries WHERE resource_type = 'department' AND resource_id = ANY($1::uuid[])`, [deptIds])).rowCount ?? 0);
    const f = folders.length ? (await c.query(`DELETE FROM folder_nodes WHERE id = ANY($1::uuid[])`, [folders])).rowCount : 0;
    const d = (await c.query(`DELETE FROM departments WHERE id = ANY($1::uuid[])`, [deptIds])).rowCount;
    console.log(`removed: ${acl} access rows, ${f} folders, ${d} departments`);

    for (const UNIT of UNITS) {
      const unit = (await c.query<{ id: string }>(`SELECT id FROM org_units WHERE tenant_id = $1 AND code = $2`, [TENANT, UNIT])).rows[0];
      if (!unit) { console.log(`organisation unit ${UNIT}: not found`); continue; }
      const left = Number((await c.query(`SELECT count(*) AS n FROM departments WHERE org_unit_id = $1`, [unit.id])).rows[0]!.n);
      if (left > 0) { console.log(`organisation unit ${UNIT} still has ${left} department(s): left in place`); continue; }
      // the unit's own auto-created folders go with it, but only if nothing else depends on them or on the unit
      await c.query('SAVEPOINT unit_step');
      const unitFolders = (await c.query<{ id: string }>(`SELECT id FROM folder_nodes WHERE org_unit_id = $1`, [unit.id])).rows.map((r) => r.id);
      const blockers: string[] = [];
      for (const fk of await fks('org_units')) {
        if (fk.t === 'folder_nodes' && fk.col === 'org_unit_id') continue;
        if (DROP_SEQUENCES && SEQUENCE_TABLES.has(fk.t)) continue; // counters are dropped below
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${fk.t} WHERE "${fk.col}" = $1`, [unit.id])).rows[0]!.n);
        if (n > 0) blockers.push(`${fk.t}.${fk.col}: ${n}`);
      }
      if (unitFolders.length > 0) {
        for (const fk of await fks('folder_nodes')) {
          if (fk.t === 'folder_nodes' && fk.col === 'parent_id') continue;
          const n = Number((await c.query(`SELECT count(*) AS n FROM ${fk.t} WHERE "${fk.col}" = ANY($1::uuid[])`, [unitFolders])).rows[0]!.n);
          if (n > 0) blockers.push(`${fk.t}.${fk.col}: ${n} (on its folders)`);
        }
        const kids = Number((await c.query(`SELECT count(*) AS n FROM folder_nodes WHERE parent_id = ANY($1::uuid[]) AND id <> ALL($1::uuid[])`, [unitFolders])).rows[0]!.n);
        if (kids > 0) blockers.push(`folder_nodes.parent_id: ${kids} folder(s) outside the unit sit under its folders`);
      }
      if (blockers.length) { await c.query('ROLLBACK TO SAVEPOINT unit_step'); console.log(`organisation unit ${UNIT}: left in place, in use (${blockers.join('; ')})`); continue; }
      if (unitFolders.length > 0) {
        await c.query(`DELETE FROM acl_entries WHERE resource_type = 'folder' AND resource_id = ANY($1::uuid[])`, [unitFolders]);
        await c.query(`DELETE FROM folder_nodes WHERE id = ANY($1::uuid[])`, [unitFolders]);
      }
      let counters = 0;
      if (DROP_SEQUENCES) for (const t of SEQUENCE_TABLES) counters += (await c.query(`DELETE FROM ${t} WHERE org_unit_id = $1`, [unit.id])).rowCount ?? 0;
      const gone = (await c.query(`DELETE FROM org_units WHERE id = $1`, [unit.id])).rowCount;
      await c.query('RELEASE SAVEPOINT unit_step');
      console.log(`removed organisation unit ${UNIT} (${unitFolders.length} folder(s) of its own${counters ? `, ${counters} numbering counter(s)` : ''}): ${gone}`);
    }
    if (UNITS.length === 0) {
      const units = (await c.query<{ code: string }>(`SELECT o.code FROM org_units o WHERE o.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.org_unit_id = o.id)`, [TENANT])).rows;
      if (units.length) console.log(`organisation unit(s) now empty: ${units.map((u) => u.code).join(', ')} (add --unit=CODE to remove one)`);
    }
    await c.query(EXECUTE ? 'COMMIT' : 'ROLLBACK');
    console.log(EXECUTE ? 'committed.' : 'dry run: rolled back. Add --execute to apply.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
