/**
 * Seeds the DMS-side half of the platform owner's account: the `users` row, its
 * PLATFORM_ADMIN role, and a tenant seat so login lands somewhere concrete.
 *
 * Run it yourself, at a terminal (it refuses without one), AFTER the SSO half
 * (SSO/backend/scripts/seed-platform-admin.ts). It asks, with echo off, for the
 * VAULT password, which only you know and which is never written anywhere. The
 * database refuses to create or change a platform administrator without it
 * (migration 20261004000002-platform-admin-protection.sql); this script opens the
 * vault on one connection, does everything on that connection, and closes it.
 *
 * Identity at rest. The email stored here must be the SAME value SSO stored, since
 * DMS adopts the account at first sign-in by email. When SSO runs with a pepper
 * (PLATFORM_ADMIN_PEPPER), both store the keyed pseudonym of your real email;
 * give this script the same pepper (environment variable for this one run, or it
 * asks) and the same PLATFORM_ADMIN_EMAIL. DMS itself never needs the pepper at
 * runtime, so it stays out of DMS's env files.
 *
 * DMS has no local password storage: every real login is a verified SSO id_token.
 * The account's sign-in password lives in SSO only.
 *
 * Safe to re-run. Usage (from DMS/backend); mirror/production MUST use the launcher
 * or this silently targets the DEV database:
 *   Dev:    PLATFORM_ADMIN_EMAIL=you@example.com npx tsx scripts/seed-platform-admin.ts
 *   Mirror: PLATFORM_ADMIN_EMAIL=... node scripts/run-with-env.cjs mirror npx tsx scripts/seed-platform-admin.ts
 *   Prod:   PLATFORM_ADMIN_EMAIL=... node scripts/run-with-env.cjs production npx tsx scripts/seed-platform-admin.ts
 */
import '../src/config/env.js';
import crypto from 'node:crypto';
import { Client } from 'pg';
import { config } from '../src/config/env.js';

const DEFAULT_TENANT_ID = 'examplecorp';
const ROLE_NAME = 'PLATFORM_ADMIN';

// Same algorithm as SSO/backend/src/auth/platform-admin.ts (platformAdminPseudonym).
// Duplicated, not shared: DMS and SSO are separate repositories.
function pseudonym(realEmail: string, pepper: string): string {
  const mac = crypto.createHmac('sha256', pepper).update(realEmail.trim().toLowerCase()).digest('hex');
  return `pa-${mac.slice(0, 32)}@platform.invalid`;
}

function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('\n  This script needs an interactive terminal: the vault password is never accepted from a pipe, a file, an argument or an environment variable.\n');
    process.exit(2);
  }
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function askVisible(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim()); });
  });
}

async function main() {
  requireTerminal();

  const realEmail = (process.env.PLATFORM_ADMIN_EMAIL?.trim() || (await askVisible('  Platform administrator email: '))).toLowerCase();
  if (!realEmail.includes('@')) {
    console.error('\n  That is not an email address.\n');
    process.exit(1);
  }
  const pepper = process.env.PLATFORM_ADMIN_PEPPER?.trim() || (await askHidden('  Pepper (the same PLATFORM_ADMIN_PEPPER SSO uses; empty = store the real email): '));
  const storedEmail = pepper ? pseudonym(realEmail, pepper) : realEmail;
  const vaultPw = await askHidden('  Vault password: ');

  const client = new Client({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_MIGRATE_USER || config.DB_USER,
    password: (config.DB_MIGRATE_USER ? config.DB_MIGRATE_PASSWORD : config.DB_PASSWORD) || undefined,
  });
  await client.connect();
  try {
    const role = await client.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [ROLE_NAME]);
    if (role.rowCount === 0) {
      console.error(`\n  Role ${ROLE_NAME} not found: run the migrations first.\n`);
      process.exit(1);
    }
    const ok = (await client.query('SELECT platform_vault_unlock($1, 5) AS ok', [vaultPw])).rows[0].ok;
    if (!ok) {
      console.error('\n  Wrong vault password (counted). Nothing was changed.\n');
      process.exit(1);
    }
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, first_name, last_name, is_active, password_hash)
       VALUES ($1, 'Platform', 'Administrator', TRUE, NULL)
       ON CONFLICT (email) DO UPDATE SET is_active = TRUE, deleted_at = NULL, updated_at = NOW()
       RETURNING id`,
      [storedEmail],
    );
    const userId = user.rows[0].id;
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, role.rows[0].id],
    );
    await client.query(
      `INSERT INTO user_tenants (user_id, tenant_id, assigned_by) VALUES ($1, $2, $1)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [userId, DEFAULT_TENANT_ID],
    );
    await client.query('COMMIT');
    console.log(`\n  Done. The platform administrator holds ${ROLE_NAME} in DMS, seated at tenant ${DEFAULT_TENANT_ID}.`);
    console.log(`  Stored as: ${pepper ? 'a keyed pseudonym' : 'the real email'}. Running servers pick this up within about 15 seconds.\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query('SELECT platform_vault_lock()').catch(() => {});
    await client.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
