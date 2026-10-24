// SPRINT-6: keep syncDatabase out of the production startup path; migrations must own schema changes.
import { QueryTypes, Sequelize } from 'sequelize';
import { config } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { sequelizeClsNamespace } from '../../shared/requestContext.js';

// S6-RLS: register the CLS adapter BEFORE instantiating Sequelize so that
// every query issued anywhere (including ones made through models required
// after this module) is eligible to auto-join the current request's
// transaction. See shared/requestContext.ts for what this adapter does and
// shared/middleware.ts (tenantContext) for how the transaction gets set.
Sequelize.useCLS(sequelizeClsNamespace);

export const sequelize = new Sequelize({
  database: config.DB_NAME,
  username: config.DB_USER,
  password: config.DB_PASSWORD || undefined, // Use undefined if password is empty
  host: config.DB_HOST,
  port: config.DB_PORT,
  dialect: 'postgres',
  logging:
    config.NODE_ENV === 'development' ? (msg) => logger.debug(msg) : false,
  pool: {
    max: config.DB_POOL_MAX,
    min: config.DB_POOL_MIN,
    acquire: config.DB_POOL_ACQUIRE_MS,
    idle: config.DB_POOL_IDLE_MS,
  },
  define: {
    underscored: true,
  },
});

/**
 * P1-15: prove RLS is actually enforced for the role we connected as, rather than
 * inferring it from the role's NAME.
 *
 * config/env.ts already refuses to boot in production when the DB user is
 * literally `postgres`, which stops the most likely mistake. But it proves
 * nothing about the role in use: `edams_app` could hold SUPERUSER or BYPASSRLS,
 * or could OWN the tables — and a table owner bypasses row-level security
 * entirely unless the table carries FORCE ROW LEVEL SECURITY. In any of those
 * cases every policy in migrations/*-rls-*.sql is inert, tenant isolation does
 * not exist, and absolutely nothing anywhere says so. A multi-tenant document
 * system silently serving cross-tenant rows is the worst possible failure here,
 * and it is invisible by construction.
 *
 * Two checks, in order of increasing strength:
 *
 *  1. Role attributes. Cheap, catches SUPERUSER/BYPASSRLS directly.
 *  2. An empirical probe. Inside a transaction that is always rolled back, claim
 *     a tenant id that cannot exist and confirm a tenant-scoped table returns
 *     zero rows. This is the one that catches table ownership, a missing FORCE
 *     ROW LEVEL SECURITY, and a policy that was never applied to a table —
 *     none of which any amount of role-name checking can see.
 *
 * Production/mirror only. Dev and the test suite connect as `postgres` (see
 * .env), so running this there would fail every local boot — which is itself the
 * finding's other half: no automated test on this platform currently exercises
 * RLS at all, because nothing runs as a restricted role.
 */
async function assertRlsIsEnforced(): Promise<void> {
  const roleRows = (await sequelize.query(
    `SELECT current_user AS role_name, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    { type: QueryTypes.SELECT },
  )) as Array<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>;

  const role = roleRows[0];
  if (!role) {
    throw new Error('RLS guard: could not read the current role from pg_roles — refusing to start without confirming tenant isolation');
  }
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `RLS guard: the application connects as "${role.role_name}", which has ` +
      `${role.rolsuper ? 'SUPERUSER' : ''}${role.rolsuper && role.rolbypassrls ? ' and ' : ''}${role.rolbypassrls ? 'BYPASSRLS' : ''}. ` +
      'Row-level security does not apply to it, so every tenant-isolation policy in the migrations is inert and tenants can read each ' +
      "other's documents. Grant the application a NOSUPERUSER NOBYPASSRLS role (the edams_app role) and restart.",
    );
  }

  // Empirical probe. Rolled back unconditionally — it must never leave a
  // transaction open or a GUC set on a pooled connection.
  const probeTenant = '__rls_probe_this_tenant_cannot_exist__';
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query(`SET LOCAL app.current_tenant = '${probeTenant}'`, { transaction });
    const probeRows = (await sequelize.query(
      'SELECT COUNT(*)::int AS visible FROM documents',
      { type: QueryTypes.SELECT, transaction },
    )) as Array<{ visible: number }>;
    const visible = probeRows[0]?.visible ?? 0;
    if (visible > 0) {
      throw new Error(
        `RLS guard: with app.current_tenant set to a tenant that cannot exist, ${visible} row(s) of "documents" were still visible ` +
        `to "${role.role_name}". Row-level security is NOT filtering. The usual causes, in order of likelihood: the role OWNS the ` +
        'table (an owner bypasses RLS unless the table has FORCE ROW LEVEL SECURITY), the table has RLS enabled but no policy that ' +
        'restricts SELECT, or the *-rls-*.sql migrations were never applied to this database. Refusing to start — tenant isolation ' +
        'is not in effect.',
      );
    }
    logger.info({ role: role.role_name }, 'RLS enforcement verified: tenant-scoped read returned no rows for a non-existent tenant');
  } finally {
    await transaction.rollback();
  }
}

export async function connectDB() {
  try {
    await sequelize.authenticate();
    logger.info('database connected');
  } catch (error) {
    logger.fatal({ error }, 'database connection failed');
    process.exit(1);
  }

  // After connect, so the probe runs on a live connection; production/mirror
  // only, because dev and the test suite deliberately connect as postgres.
  if (config.NODE_ENV === 'production' || config.NODE_ENV === 'mirror') {
    try {
      await assertRlsIsEnforced();
    } catch (error) {
      logger.fatal({ error }, 'RLS enforcement check failed — refusing to start');
      process.exit(1);
    }
  }
}

export async function syncDatabase(options?: { force?: boolean }) {
  const { initModels } = await import('./models/index.js');
  initModels();
  const force = options?.force ?? false;
  // Use alter: false so sync only CREATES missing tables â€” it never alters
  // existing columns. Schema changes must go through SQL migrations.
  // alter: true was causing destructive ALTER TABLE attempts when Sequelize
  // tried to reconcile camelCase model fields with snake_case DB columns.
  await sequelize.sync({ force, alter: false });
  logger.info({ force }, 'database schema synced (create-only mode)');
}

