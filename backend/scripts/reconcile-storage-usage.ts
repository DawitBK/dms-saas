#!/usr/bin/env tsx
// BUG 4 FIX: Storage quota reconciliation script
// Compares actual file sizes from DocumentVersion against tenants.storageUsedBytes
// Reports drift without auto-correcting (unless --fix flag is provided)

import { sequelize, Tenant } from '../src/infrastructure/database/index.js';
import { logger } from '../src/core/logger.js';
import { QueryTypes } from 'sequelize';

interface TenantUsage {
  tenantId: string;
  tenantName: string;
  recordedUsedBytes: bigint;
  actualUsedBytes: bigint;
  driftBytes: bigint;
  driftPercent: number;
}

async function calculateActualUsage(tenantId: string): Promise<bigint> {
  // Sum file sizes from all active document versions (excluding soft-deleted documents)
  const [result] = await sequelize.query<{ total_bytes: string }>(
    `SELECT COALESCE(SUM(dv.file_size), 0) as total_bytes
     FROM document_versions dv
     INNER JOIN documents d ON dv.document_id = d.id
     WHERE d.tenant_id = :tenantId
       AND d.deleted_at IS NULL`,
    {
      replacements: { tenantId },
      type: QueryTypes.SELECT
    }
  );

  return BigInt(result.total_bytes || '0');
}

async function reconcileStorageUsage(fix: boolean = false): Promise<void> {
  console.log('\n=== Storage Quota Reconciliation ===\n');
  console.log(`Mode: ${fix ? 'FIX' : 'REPORT ONLY'}\n`);

  const tenants = await Tenant.findAll({ where: { isActive: true } });
  const drifts: TenantUsage[] = [];
  let totalDrift = BigInt(0);

  for (const tenant of tenants) {
    const recordedUsedBytes = BigInt(tenant.storageUsedBytes);
    const actualUsedBytes = await calculateActualUsage(tenant.id);
    const driftBytes = actualUsedBytes - recordedUsedBytes;
    const driftPercent = recordedUsedBytes > 0 
      ? Number((driftBytes * BigInt(10000)) / recordedUsedBytes) / 100
      : 0;

    const usage: TenantUsage = {
      tenantId: tenant.id,
      tenantName: tenant.name,
      recordedUsedBytes,
      actualUsedBytes,
      driftBytes,
      driftPercent
    };

    drifts.push(usage);
    totalDrift += driftBytes;

    // Print per-tenant report
    const driftStatus = driftBytes === BigInt(0) ? '✓' : '✗';
    console.log(`${driftStatus} Tenant: ${tenant.name} (${tenant.id})`);
    console.log(`   Recorded: ${recordedUsedBytes.toString().padStart(15)} bytes`);
    console.log(`   Actual:   ${actualUsedBytes.toString().padStart(15)} bytes`);
    console.log(`   Drift:    ${driftBytes.toString().padStart(15)} bytes (${driftPercent.toFixed(2)}%)`);
    console.log('');

    if (fix && driftBytes !== BigInt(0)) {
      await tenant.update({ storageUsedBytes: Number(actualUsedBytes) });
      console.log(`   ✓ Fixed: Updated storageUsedBytes to ${actualUsedBytes}\n`);
    }
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`Total tenants checked: ${tenants.length}`);
  console.log(`Tenants with drift: ${drifts.filter(d => d.driftBytes !== BigInt(0)).length}`);
  console.log(`Total drift: ${totalDrift.toString()} bytes`);

  if (!fix && drifts.some(d => d.driftBytes !== BigInt(0))) {
    console.log('\nTo fix the drift, run with --fix flag:');
    console.log('  npm run reconcile-storage -- --fix');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');

  try {
    await sequelize.authenticate();
    logger.info('Database connection established');

    await reconcileStorageUsage(fix);

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Reconciliation failed');
    await sequelize.close();
    process.exit(1);
  }
}

main();
