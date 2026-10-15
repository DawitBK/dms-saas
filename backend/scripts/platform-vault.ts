/**
 * The platform owner's tool for the platform-admin vault (migration
 * 20261004000002-platform-admin-protection.sql). Run it yourself, at a terminal.
 *
 *   npx tsx scripts/platform-vault.ts status
 *   npx tsx scripts/platform-vault.ts set          choose or change the vault password
 *   npx tsx scripts/platform-vault.ts sql "<SQL>"  run one statement with the vault open
 *   npx tsx scripts/platform-vault.ts reset-lockout  clear the failed-attempt lockout
 *   npx tsx scripts/platform-vault.ts forget       owner lost the password: clear it, then `set` again
 *
 * Production / mirror: prefix with the launcher so the right env file is read:
 *   node scripts/run-with-env.cjs production npx tsx scripts/platform-vault.ts status
 *
 * THE PASSWORD IS NEVER AN ARGUMENT, AN ENVIRONMENT VARIABLE, A FILE OR PIPED
 * INPUT. It is read from the terminal with echo off, sent to the database once,
 * and only a bcrypt hash is stored. This tool refuses to run without a real
 * terminal, so nothing automated (a script, a CI job, an AI agent) can drive it.
 * Nobody but the person at the keyboard can supply it — including whoever wrote
 * this tool.
 *
 * Connects with the migration/owner credentials (DB_MIGRATE_USER, else DB_USER),
 * the same ones scripts/migrate.ts uses.
 */
import '../src/config/env.js';
import { Client } from 'pg';
import { config } from '../src/config/env.js';

function requireTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('\n  This tool needs an interactive terminal. The vault password is never accepted from a pipe, a file or an argument.\n');
    process.exit(2);
  }
}

/** Read a line with echo off. */
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
        if (c === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
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
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

async function connect(): Promise<Client> {
  const client = new Client({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_MIGRATE_USER || config.DB_USER,
    password: (config.DB_MIGRATE_USER ? config.DB_MIGRATE_PASSWORD : config.DB_PASSWORD) || undefined,
  });
  await client.connect();
  return client;
}

async function status(c: Client) {
  const set = await c.query(`SELECT set_at FROM platform_vault WHERE id = 1`);
  const fails = await c.query(`SELECT platform_vault_failure_count()::int AS n`);
  const open = await c.query(`SELECT count(*)::int AS n FROM platform_vault_unlocked WHERE expires_at > now()`);
  const log = await c.query(`SELECT at, event, db_user FROM platform_vault_log ORDER BY id DESC LIMIT 10`);
  console.log(`\n  database:         ${config.DB_NAME}`);
  console.log(`  password set:     ${set.rowCount ? `yes (${new Date(set.rows[0].set_at).toISOString()})` : 'NO — run `set`'}`);
  console.log(`  failed attempts:  ${fails.rows[0].n} of 10 before lockout${fails.rows[0].n >= 10 ? '  *** LOCKED ***' : ''}`);
  console.log(`  open sessions:    ${open.rows[0].n}`);
  console.log('  recent events:');
  for (const r of log.rows) console.log(`    ${new Date(r.at).toISOString()}  ${r.event}  (${r.db_user})`);
  console.log('');
}

async function setPassword(c: Client) {
  const exists = (await c.query(`SELECT 1 FROM platform_vault WHERE id = 1`)).rowCount;
  if (exists) {
    const old = await askHidden('  Current vault password: ');
    const ok = (await c.query(`SELECT platform_vault_unlock($1) AS ok`, [old])).rows[0].ok;
    if (!ok) {
      console.error('\n  That is not the current vault password. Nothing was changed.\n');
      process.exit(1);
    }
  }
  const a = await askHidden('  New vault password (16+ characters; a passphrase is best): ');
  if (a.length < 16) {
    console.error('\n  Too short. Use at least 16 characters. Nothing was changed.\n');
    process.exit(1);
  }
  const b = await askHidden('  Type it again: ');
  if (a !== b) {
    console.error('\n  The two entries differ. Nothing was changed.\n');
    process.exit(1);
  }
  // cost 12: each guess costs ~250 ms even to someone who somehow has the hash.
  await c.query(
    `INSERT INTO platform_vault (id, secret_hash, set_at) VALUES (1, crypt($1, gen_salt('bf', 12)), now())
     ON CONFLICT (id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, set_at = now()`,
    [a],
  );
  await c.query(`INSERT INTO platform_vault_log (event) VALUES ('set')`);
  await c.query(`SELECT setval('platform_vault_failures', 1, false)`);
  console.log('\n  Vault password saved (only its hash is stored). Keep the password somewhere only you can reach: it cannot be recovered.\n');
}

async function runSql(c: Client, sql: string) {
  if (!sql) {
    console.error('\n  Usage: platform-vault.ts sql "<one SQL statement>"\n');
    process.exit(2);
  }
  const pw = await askHidden('  Vault password: ');
  const ok = (await c.query(`SELECT platform_vault_unlock($1, 5) AS ok`, [pw])).rows[0].ok;
  if (!ok) {
    console.error('\n  Wrong password (counted). Nothing was run.\n');
    process.exit(1);
  }
  try {
    const res = await c.query(sql);
    if (res.rows?.length) console.table(res.rows);
    else console.log(`\n  OK${res.rowCount != null ? ` (${res.rowCount} rows)` : ''}\n`);
  } finally {
    await c.query(`SELECT platform_vault_lock()`);
  }
}

async function resetLockout(c: Client) {
  const confirm = await askVisible('  Type RESET to clear the failed-attempt counter: ');
  if (confirm !== 'RESET') { console.log('  Cancelled.'); return; }
  await c.query(`SELECT setval('platform_vault_failures', 1, false)`);
  await c.query(`INSERT INTO platform_vault_log (event) VALUES ('reset')`);
  console.log('\n  Lockout cleared. The password itself is unchanged.\n');
}

async function forget(c: Client) {
  console.log('\n  This deletes the stored password hash. Until you run `set` again NO ONE can open the vault,');
  console.log('  and the protected account stays protected (it simply cannot be changed). Only do this if the password is lost.');
  const confirm = await askVisible('  Type FORGET to continue: ');
  if (confirm !== 'FORGET') { console.log('  Cancelled.'); return; }
  await c.query(`DELETE FROM platform_vault WHERE id = 1`);
  await c.query(`SELECT setval('platform_vault_failures', 1, false)`);
  await c.query(`INSERT INTO platform_vault_log (event) VALUES ('reset')`);
  console.log('\n  Cleared. Run `set` now.\n');
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || !['status', 'set', 'sql', 'reset-lockout', 'forget'].includes(cmd)) {
    console.log('Usage: platform-vault.ts <status | set | sql "<SQL>" | reset-lockout | forget>');
    process.exit(2);
  }
  requireTerminal();
  const c = await connect();
  try {
    if (cmd === 'status') await status(c);
    else if (cmd === 'set') await setPassword(c);
    else if (cmd === 'sql') await runSql(c, process.argv.slice(3).join(' ').trim());
    else if (cmd === 'reset-lockout') await resetLockout(c);
    else if (cmd === 'forget') await forget(c);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
