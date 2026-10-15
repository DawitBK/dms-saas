#!/usr/bin/env tsx
// BUG 1 AUDIT: Query for orphaned folder_nodes rows
// Finds folders with no ACL entries and no documents (potential orphans from failed transactions)

import { sequelize } from '../src/infrastructure/database/index.js';
import { logger } from '../src/core/logger.js';
import { QueryTypes } from 'sequelize';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';

interface OrphanedFolder {
  id: string;
  tenant_id: string;
  name: string;
  path: string;
  parent_id: string | null;
  is_active: boolean;
  created_at: Date;
  acl_count: number;
  doc_count: number;
}

async function findOrphanedFolders(): Promise<void> {
  console.log('\n=== Orphaned Folders Audit ===\n');
  console.log('Searching for folder_nodes rows with no ACL entries and no documents...\n');

  // FIX 2026-09-23: `folder_nodes` and `documents` both FORCE-enable RLS
  // (folder_nodes allows CURRENT_USER = 'postgres' too, documents doesn't
  // even have that) — this query ran with no app.current_tenant ever set, so
  // it always saw zero rows from both tables under the app's real
  // (non-superuser) DB role and unconditionally reported "Database is
  // clean," regardless of how many folders were actually orphaned. acl_entries
  // is fail-open-safe on its own, but that doesn't help once it's joined
  // against two strict tables in the same query. Loop the tenant registry
  // (tenant-agnostic, no RLS) and scope one query per tenant.
  const tenants = await sequelize.query<{ id: string }>('SELECT id FROM tenants', { type: QueryTypes.SELECT });
  let orphanedFolders: OrphanedFolder[] = [];
  for (const { id: tenantId } of tenants) {
    const rows = await withWorkerTenantContext(tenantId, () =>
      sequelize.query<OrphanedFolder>(
        `SELECT
           fn.id,
           fn.tenant_id,
           fn.name,
           fn.path,
           fn.parent_id,
           fn.is_active,
           fn.created_at,
           COUNT(DISTINCT ae.id) as acl_count,
           COUNT(DISTINCT d.id) as doc_count
         FROM folder_nodes fn
         LEFT JOIN acl_entries ae ON ae.resource_type = 'folder' AND ae.resource_id = fn.id
         LEFT JOIN documents d ON d.folder_id = fn.id AND d.deleted_at IS NULL
         WHERE fn.parent_id IS NOT NULL  -- Exclude root folders (they might legitimately have no ACLs)
         GROUP BY fn.id, fn.tenant_id, fn.name, fn.path, fn.parent_id, fn.is_active, fn.created_at
         HAVING COUNT(DISTINCT ae.id) = 0 AND COUNT(DISTINCT d.id) = 0
         ORDER BY fn.created_at DESC`,
        { type: QueryTypes.SELECT },
      ),
    );
    orphanedFolders = orphanedFolders.concat(rows);
  }

  console.log(`Found ${orphanedFolders.length} potentially orphaned folders\n`);

  if (orphanedFolders.length === 0) {
    console.log('✓ No orphaned folders found. Database is clean.');
    return;
  }

  // Group by tenant for better reporting
  const byTenant = orphanedFolders.reduce((acc, folder) => {
    if (!acc[folder.tenant_id]) {
      acc[folder.tenant_id] = [];
    }
    acc[folder.tenant_id].push(folder);
    return acc;
  }, {} as Record<string, OrphanedFolder[]>);

  for (const [tenantId, folders] of Object.entries(byTenant)) {
    console.log(`\n📁 Tenant: ${tenantId} (${folders.length} orphaned folders)`);
    console.log('─'.repeat(80));

    for (const folder of folders) {
      const status = folder.is_active ? 'ACTIVE' : 'INACTIVE';
      const age = Math.floor((Date.now() - new Date(folder.created_at).getTime()) / (1000 * 60 * 60 * 24));
      
      console.log(`  ID:      ${folder.id}`);
      console.log(`  Name:    ${folder.name}`);
      console.log(`  Path:    ${folder.path}`);
      console.log(`  Status:  ${status}`);
      console.log(`  Created: ${new Date(folder.created_at).toISOString()} (${age} days ago)`);
      console.log(`  Parent:  ${folder.parent_id || 'ROOT'}`);
      console.log('');
    }
  }

  console.log('\n=== Recommendations ===');
  console.log('These folders appear to be orphaned (created but never completed).');
  console.log('They likely resulted from failed transactions before the BUG 1 fix.');
  console.log('\nOptions:');
  console.log('1. Manually deactivate them (set is_active = false)');
  console.log('2. Delete them if confirmed as orphaned');
  console.log('3. Investigate specific folders if they might be legitimate');
  console.log('\nTo deactivate an orphaned folder:');
  console.log('  UPDATE folder_nodes SET is_active = false WHERE id = \'<folder-id>\';');
}

async function main() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established');

    await findOrphanedFolders();

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Orphaned folders audit failed');
    await sequelize.close();
    process.exit(1);
  }
}

main();
