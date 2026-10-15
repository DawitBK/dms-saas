import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';
import { config } from '../src/config/env.js';
import { logger } from '../src/core/logger.js';
import fs from 'fs/promises';

// A dedicated connection, not the app's shared `sequelize` (src/infrastructure/
// database/sequelize.ts) — see DB_MIGRATE_USER's comment in src/config/env.ts.
// Migrations need owner-level DDL rights; the app's own DB_USER (edams_app in
// production/mirror) deliberately does not have them.
const sequelize = new Sequelize({
  database: config.DB_NAME,
  username: config.DB_MIGRATE_USER || config.DB_USER,
  password: (config.DB_MIGRATE_USER ? config.DB_MIGRATE_PASSWORD : config.DB_PASSWORD) || undefined,
  host: config.DB_HOST,
  port: config.DB_PORT,
  dialect: 'postgres',
  logging: false,
});

// Rollback convention: a migration `NNNN-name.sql` may ship a sibling
// `NNNN-name.down.sql` with the exact SQL to undo it (e.g. DROP the columns/
// tables it just ADDed). If that file exists, `down` actually reverts the
// migration for real. If it doesn't, `down` refuses and says so explicitly —
// this is deliberately NOT a silent no-op, because that would let someone
// think a rollback happened when it didn't.
//
// This only covers migrations that ship a `.down.sql` going forward. Older
// migrations (before this convention existed) still have no rollback path —
// see Documentations/rollout.md §3 for why forward-only + expand/contract discipline is the
// real safety net, not `migrate down`.
function downPathFor(upPath: string): string {
  return upPath.replace(/\.sql$/, '.down.sql');
}

const umzug = new Umzug({
  migrations: {
    // Exclude `*.down.sql` companions — they're read directly by `down()`
    // above via downPathFor(), never run as their own "up" migration.
    glob: ['migrations/*.sql', { ignore: 'migrations/*.down.sql' }],
    resolve: ({ name, path }) => {
      // For SQL migrations
      return {
        name,
        up: async () => {
          const sql = await fs.readFile(path!, 'utf8');
          await sequelize.query(sql);
        },
        down: async () => {
          const downPath = downPathFor(path!);
          const downSql = await fs.readFile(downPath, 'utf8').catch(() => null);
          if (downSql === null) {
            throw new Error(
              `Down migration is not implemented for ${name} (no ${downPath.split(/[\\/]/).pop()} file). ` +
                `Refusing to mark it reverted in SequelizeMeta.`,
            );
          }
          await sequelize.query(downSql);
        },
      };
    }
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: 'SequelizeMeta' }),
  logger: {
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
    debug: (msg) => logger.debug(msg),
  },
});

// Define commands
const command = process.argv[2];

// The open Sequelize connection pool keeps the event loop alive, so the process
// hangs after the work is done unless we close it and exit explicitly. Wrapping
// the command in a runner lets us always close the pool and set a correct exit
// code (non-zero on failure so CI/`&&` chains actually stop). (S19 hygiene #9.)
async function run() {
  if (command === 'up') {
    await umzug.up();
  } else if (command === 'down') {
    const to = process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : undefined;
    await umzug.down({ to });
  } else if (command === 'status') {
    const pending = await umzug.pending();
    const executed = await umzug.executed();

    logger.info('Migration Status:');
    logger.info({ executed: executed.map(m => m.name) }, 'Executed migrations');
    logger.info({ pending: pending.map(m => m.name) }, 'Pending migrations');
  } else {
    console.log('Usage: npx tsx scripts/migrate.ts [up|down|status]');
    console.log('  up          - Run pending migrations');
    console.log('  down --to X - Rollback to migration X');
    console.log('  status      - Show migration status');
  }
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  logger.error({ err }, 'Migration command failed');
  exitCode = 1;
} finally {
  await sequelize.close().catch(() => { /* already closing/closed */ });
}
process.exit(exitCode);

