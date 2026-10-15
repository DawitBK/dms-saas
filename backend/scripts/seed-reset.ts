/**
 * seed-reset.ts — Wipes all seeded data (DB + storage) for a clean re-seed.
 * DANGER: destroys all documents, users, roles, and encrypted files. Dev only.
 */
import '../src/config/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sequelize, initModels } from '../src/infrastructure/database/index.js';

async function main() {
  // The production-parity mirror runs with NODE_ENV=mirror: it holds real-shaped data and this script
  // truncates tables and wipes the storage folders, so it is refused there as well.
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'mirror') {
    console.error(`❌ seed:reset is forbidden when NODE_ENV=${process.env.NODE_ENV} (development databases only)`);
    process.exit(1);
  }

  await initModels();
  console.log('⚠️  Resetting database seed data...');

  // Truncate in dependency order (children first)
  // §0 FIX: Added document_deks, document_legal_holds, signature_records, archive_records
  const tables = [
    'audit_logs', 'notifications', 'workflow_tasks', 'workflow_instances',
    'signature_records', 'document_legal_holds', 'legal_holds',
    'document_metadata', 'document_deks', 'document_versions', 'doc_locks', 'document_checkouts',
    'acl_entries', 'retention_applications', 'purge_pending', 'archive_records',
    'documents', 'folder_nodes', 'user_departments', 'user_roles',
    'users', 'workflow_definitions', 'retention_policies', 'document_types',
    'departments', 'roles',
  ];

  for (const table of tables) {
    try {
      await sequelize.query(`TRUNCATE TABLE "${table}" CASCADE`);
      console.log(`  Cleared: ${table}`);
    } catch (err) {
      console.warn(`  Skipped: ${table} (${(err as any).message})`);
    }
  }

  // §0 FIX: Wipe storage directories so stale plaintext/encrypted files don't linger
  console.log('⚠️  Wiping storage directories...');
  const storageDirs = [
    path.resolve(process.cwd(), 'storage', 'dms-documents'),
    path.resolve(process.cwd(), 'storage', 'documents'),
    path.resolve(process.cwd(), 'storage', 'previews'),
  ];
  for (const dir of storageDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      console.log(`  Wiped: ${dir}`);
    } catch (err) {
      console.warn(`  Skipped: ${dir} (${(err as any).message})`);
    }
  }

  console.log('✅ Reset complete. Run npm run seed:core to reseed.');
}

// Always close the pool and exit with a correct code — otherwise the open DB
// connection keeps the event loop alive and the script hangs (esp. on the error
// path, where the previous `main().catch(console.error)` never closed/exited).
main()
  .then(async () => { await sequelize.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => { console.error(err); await sequelize.close().catch(() => {}); process.exit(1); });
