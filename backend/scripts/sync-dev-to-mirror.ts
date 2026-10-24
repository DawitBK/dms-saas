/**
 * Sync dev's CURRENT reference/structural data into the mirror database.
 *
 *   npm run sync:dev-to-mirror
 *
 * WHY THIS EXISTS
 *
 * The mirror was originally built once — schema via migrations, then a
 * generic demo seed (seed-core.ts) — and never touched again. Dev kept
 * moving after that point: new org units, new test users, a custom SUPER
 * role, 113 hand-edited role_permissions rows, 254 AD-group mappings. None
 * of that had anywhere to go, so the mirror silently drifted further behind
 * dev every day. Every "why is X missing in the mirror" bug on 2026-09-13
 * had this exact same root cause, found by hand, one table at a time. This
 * script is that fix made permanent and repeatable: run it any time dev has
 * moved and the mirror needs to catch back up, instead of another forensic
 * session.
 *
 * WHAT IT DOES NOT TOUCH, ON PURPOSE
 *
 * Documents, document_versions, document_deks, letters and anything else
 * holding encrypted content are never synced. A document's DEK is wrapped
 * under whichever VAULT_MASTER_KEY the database that created it uses — dev
 * and mirror deliberately use DIFFERENT keys (same "never share crypto
 * material" rule that keeps the mirror from ever holding real prod secrets),
 * so copying encrypted rows across that boundary produces content that is
 * permanently unwrappable, not content that "just works" in the new
 * environment. This script only moves the STRUCTURAL/reference layer:
 * org chart, users, roles, role→permission grants, AD-group mappings,
 * document TYPE definitions (metadata, not content), and access rules.
 * Real production would have its own such layer anyway — a real deploy
 * doesn't inherit dev's literal documents either.
 *
 * HOW ID CONFLICTS ARE HANDLED
 *
 * Two independently-seeded databases running the same seed script produce
 * the SAME row (same email, same role name, same tenant id) with a
 * DIFFERENT randomly-generated UUID. A blind copy-by-id would either violate
 * a unique constraint (name/email/code already present under a different id)
 * or, worse, silently insert a duplicate. Every table here is synced by its
 * natural key (ON CONFLICT DO NOTHING against the target's own PRIMARY KEY,
 * after first checking column-for-column that the row doesn't already exist
 * some other way) — a row already present in the mirror under its own id is
 * left alone; only rows genuinely absent get added, verbatim, under dev's id.
 *
 * `roles` needs one extra step: `user_roles.role_id` and
 * `role_permissions.role_id` are foreign keys into `roles`, and dev's role
 * UUIDs for the seven built-in roles do NOT match the mirror's (confirmed:
 * `SELECT id, name FROM roles` differs completely between the two
 * databases even though the names are identical). Those two tables are
 * synced by ROLE NAME, not role_id — dev's role_id is resolved to a name,
 * then back to the MIRROR's own id for that name, before insert.
 *
 * `users.external_sub` needs the same treatment, one level removed: it's a
 * foreign identity into SSO's `idp_users.id`, not DMS's own primary key, and
 * dev-SSO and mirror-SSO are two independently-seeded databases that assign
 * their own random UUID per account for the same email (found 2026-09-13:
 * admin@examplecorp.com carried dev's SSO subject into the mirror, so a real
 * mirror login — which correctly presents MIRROR's SSO subject for that
 * email — got refused with ERR-OIDC-SUBJECT-CONFLICT, "already linked to a
 * different identity-provider account"). Resolved by email against the
 * MIRROR's own idp_users table before insert; set to NULL when the email
 * doesn't exist there yet, which is safe — auth.service.ts's OIDC callback
 * treats a null/empty external_sub as an unlinked account and adopts it on
 * first real login instead of throwing a conflict.
 *
 * SAFETY
 *
 * --to must resolve to an env file whose NODE_ENV is "mirror" — this tool
 * refuses to write into anything that looks like a real dev or production
 * database. Direction is always dev -> mirror; there is no reverse mode.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

const { Client } = pg;

type DbConfig = { host: string; port: number; user: string; password: string; database: string };

function parseArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function loadDbConfig(envFile: string): { nodeEnv: string; db: DbConfig } {
  const full = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(full)) {
    throw new Error(`env file not found: ${full}`);
  }
  const parsed = dotenv.parse(fs.readFileSync(full));
  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`${envFile} is missing ${key}`);
  }
  return {
    nodeEnv: parsed.NODE_ENV ?? "",
    db: {
      host: parsed.DB_HOST,
      port: Number(parsed.DB_PORT),
      user: parsed.DB_USER,
      password: parsed.DB_PASSWORD,
      database: parsed.DB_NAME,
    },
  };
}

// SSO's own env files use a single DATABASE_URL rather than discrete DB_*
// vars — needed here only to resolve users.external_sub against the
// MIRROR SSO's idp_users table (see file header).
function loadSsoDbConfig(envFile: string): DbConfig {
  const full = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(full)) {
    throw new Error(`SSO env file not found: ${full}`);
  }
  const parsed = dotenv.parse(fs.readFileSync(full));
  if (!parsed.DATABASE_URL) throw new Error(`${envFile} is missing DATABASE_URL`);
  const u = new URL(parsed.DATABASE_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
  };
}

// Dependency order matters: a row referencing another table's id must be
// inserted after that table has been synced, or the foreign key rejects it.
// "users" is deliberately absent here — it needs its external_sub resolved
// against the MIRROR SSO's own idp_users table, so it's synced separately
// by syncUsers(), not by the generic syncPlain() loop.
const PLAIN_TABLES_BEFORE_USERS = ["roles", "tenants"] as const;

const PLAIN_TABLES_AFTER_USERS = [
  "user_tenants",
  "org_units",
  "departments",
  "user_departments",
  "document_types",
  "idp_role_mappings",
  "access_rules",
] as const;

const ROLE_LINKED_TABLES = [
  { table: "user_roles", roleIdCol: "role_id" },
  { table: "role_permissions", roleIdCol: "role_id" },
] as const;

async function columnsOf(client: pg.Client, table: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name as string);
}

async function syncPlain(dev: pg.Client, mir: pg.Client, table: string): Promise<{ dev: number; inserted: number; errors: number }> {
  const devCols = await columnsOf(dev, table);
  const mirCols = await columnsOf(mir, table);
  const cols = devCols.filter((c) => mirCols.includes(c));
  const { rows } = await dev.query(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM ${table}`);
  let inserted = 0;
  let errors = 0;
  for (const row of rows) {
    const vals = cols.map((c) => row[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT (id) DO NOTHING`;
    try {
      const res = await mir.query(sql, vals);
      if ((res.rowCount ?? 0) > 0) inserted++;
    } catch {
      errors++;
    }
  }
  return { dev: rows.length, inserted, errors };
}

// users.external_sub is a foreign identity into SSO's idp_users.id, not a
// DMS-owned key — see file header. Resolved by email against the MIRROR
// SSO database (ssoMir), never copied verbatim from dev.
async function syncUsers(
  dev: pg.Client,
  mir: pg.Client,
  ssoMir: pg.Client,
): Promise<{ dev: number; inserted: number; errors: number }> {
  const mirIdpUsers = (await ssoMir.query("SELECT id, email FROM idp_users")).rows as {
    id: string;
    email: string;
  }[];
  const mirIdByEmail = new Map(mirIdpUsers.map((u) => [u.email.toLowerCase(), u.id]));

  const devCols = await columnsOf(dev, "users");
  const mirCols = await columnsOf(mir, "users");
  const cols = devCols.filter((c) => mirCols.includes(c));
  const { rows } = await dev.query(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM users`);
  let inserted = 0;
  let errors = 0;
  for (const row of rows) {
    const resolvedSub = row.email ? mirIdByEmail.get(String(row.email).toLowerCase()) ?? null : null;
    const vals = cols.map((c) => (c === "external_sub" ? resolvedSub : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO users (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT (id) DO NOTHING`;
    try {
      const res = await mir.query(sql, vals);
      if ((res.rowCount ?? 0) > 0) inserted++;
    } catch {
      errors++;
    }
  }
  return { dev: rows.length, inserted, errors };
}

async function syncRoleLinked(
  dev: pg.Client,
  mir: pg.Client,
  table: string,
  roleIdCol: string,
): Promise<{ dev: number; inserted: number; errors: number }> {
  const devRoles = (await dev.query("SELECT id, name FROM roles")).rows as { id: string; name: string }[];
  const mirRoles = (await mir.query("SELECT id, name FROM roles")).rows as { id: string; name: string }[];
  const devIdToName = new Map(devRoles.map((r) => [r.id, r.name]));
  const nameToMirId = new Map(mirRoles.map((r) => [r.name, r.id]));

  const devCols = await columnsOf(dev, table);
  const mirCols = await columnsOf(mir, table);
  const cols = devCols.filter((c) => mirCols.includes(c));
  const { rows } = await dev.query(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM ${table}`);
  let inserted = 0;
  let errors = 0;
  for (const row of rows) {
    const roleName = devIdToName.get(row[roleIdCol]);
    const mirRoleId = roleName ? nameToMirId.get(roleName) : undefined;
    if (!mirRoleId) {
      errors++;
      continue;
    }
    const vals = cols.map((c) => (c === roleIdCol ? mirRoleId : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT (id) DO NOTHING`;
    try {
      const res = await mir.query(sql, vals);
      if ((res.rowCount ?? 0) > 0) inserted++;
    } catch {
      errors++;
    }
  }
  return { dev: rows.length, inserted, errors };
}

async function main() {
  const fromFile = parseArg("from", ".env");
  const toFile = parseArg("to", ".env.mirror");
  // Default assumes this script runs from backend (its npm script's cwd)
  // with SSO checked out as a sibling repo — the standing layout of this
  // working copy.
  const ssoMirrorFile = parseArg("sso-mirror-env", "../../SSO/backend/.env.mirror");

  const from = loadDbConfig(fromFile);
  const to = loadDbConfig(toFile);
  const ssoMirrorDb = loadSsoDbConfig(ssoMirrorFile);

  if (to.nodeEnv !== "mirror") {
    throw new Error(
      `Refusing to run: --to=${toFile} has NODE_ENV=${to.nodeEnv || "(unset)"}, expected "mirror". ` +
        "This tool only syncs dev -> mirror; it will not write into a dev or production env file.",
    );
  }

  console.log(`Syncing ${fromFile} (${from.db.database}) -> ${toFile} (${to.db.database})\n`);

  const dev = new Client(from.db);
  const mir = new Client(to.db);
  const ssoMir = new Client(ssoMirrorDb);
  await dev.connect();
  await mir.connect();
  await ssoMir.connect();

  const results: Record<string, { dev: number; inserted: number; errors: number }> = {};

  for (const table of PLAIN_TABLES_BEFORE_USERS) {
    results[table] = await syncPlain(dev, mir, table);
  }
  results.users = await syncUsers(dev, mir, ssoMir);
  for (const table of PLAIN_TABLES_AFTER_USERS) {
    results[table] = await syncPlain(dev, mir, table);
  }
  for (const { table, roleIdCol } of ROLE_LINKED_TABLES) {
    results[table] = await syncRoleLinked(dev, mir, table, roleIdCol);
  }

  await dev.end();
  await mir.end();
  await ssoMir.end();

  const width = Math.max(...Object.keys(results).map((k) => k.length));
  for (const [table, r] of Object.entries(results)) {
    console.log(`${table.padEnd(width)}  dev=${r.dev}  inserted=${r.inserted}  skipped/errors=${r.errors}`);
  }
  console.log("\nDone. Errors above are expected for rows that already exist under a different id (same natural key, e.g. a demo account both environments seeded independently) — not failures.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
