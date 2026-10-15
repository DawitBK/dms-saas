#!/usr/bin/env tsx
// BUG 2 FIX: Backfill plaintextSha256 for existing DocumentVersion rows
// Decrypts each version and computes the plaintext hash
// Batches operations for performance and is idempotent/resumable

import crypto from 'node:crypto';
import { sequelize, DocumentVersion } from '../src/infrastructure/database/index.js';
import { fetchAndDecrypt } from '../src/modules/documents/documentCrypto.js';
import { logger } from '../src/core/logger.js';
import { Op } from 'sequelize';

const BATCH_SIZE = 50; // Process 50 versions at a time

async function backfillPlaintextHashes(dryRun: boolean = true): Promise<void> {
  console.log('\n=== Plaintext SHA256 Backfill ===\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN (report only)' : 'LIVE (will update database)'}\n`);

  // Count versions needing backfill
  const totalCount = await DocumentVersion.count({
    where: {
      plaintextSha256: { [Op.is]: null }
    }
  });

  console.log(`Found ${totalCount} document versions needing plaintext hash backfill\n`);

  if (totalCount === 0) {
    console.log('✓ All document versions already have plaintext hashes');
    return;
  }

  if (dryRun) {
    console.log('To perform the backfill, run with --execute flag:');
    console.log('  npm run backfill-plaintext-hash -- --execute');
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  while (processed < totalCount) {
    // Fetch batch of versions needing backfill
    const versions = await DocumentVersion.findAll({
      where: {
        plaintextSha256: { [Op.is]: null }
      },
      limit: BATCH_SIZE,
      order: [['createdAt', 'ASC']]
    });

    if (versions.length === 0) break;

    console.log(`Processing batch ${Math.floor(processed / BATCH_SIZE) + 1} (${versions.length} versions)...`);

    for (const version of versions) {
      try {
        // Decrypt the document to get plaintext
        const plaintextBuffer = await fetchAndDecrypt(version.storageKey, version.documentId);
        
        // Compute plaintext hash
        const plaintextHash = crypto
          .createHash('sha256')
          .update(plaintextBuffer)
          .digest('hex');

        // Update the version with plaintext hash
        await version.update({ plaintextSha256: plaintextHash });

        succeeded++;
        
        if (succeeded % 10 === 0) {
          console.log(`  ✓ Processed ${succeeded} versions...`);
        }
      } catch (error) {
        failed++;
        logger.error(
          { 
            versionId: version.id, 
            documentId: version.documentId,
            storageKey: version.storageKey,
            error 
          }, 
          'Failed to backfill plaintext hash for version'
        );
        console.log(`  ✗ Failed version ${version.id}: ${error instanceof Error ? error.message : String(error)}`);
      }

      processed++;
    }
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\n⚠ Some versions failed to backfill. Check logs for details.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');

  try {
    await sequelize.authenticate();
    logger.info('Database connection established');

    await backfillPlaintextHashes(!execute);

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Backfill failed');
    await sequelize.close();
    process.exit(1);
  }
}

main();
