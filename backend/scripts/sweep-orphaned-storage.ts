#!/usr/bin/env tsx
// Phase 6 item 10: Orphaned storage sweeper
//
// documentCrypto.ts's encryptAndStore() writes the encrypted blob to storage
// (MinIO, or local disk when MinIO is unavailable — see
// src/infrastructure/storage/StorageAdapter.ts) BEFORE the enclosing DB
// transaction commits the DocumentVersion row that references it. If the
// process crashes/is killed between the storage write and the DB commit,
// the blob is orphaned: it consumes space, is never referenced by any
// DocumentVersion, and is never cleaned up by any other job.
//
// This script:
//   1. Lists every `*.enc` object actually present in the active storage
//      backend (via the same StorageAdapter used by documentCrypto.ts, so
//      it works whether STORAGE_DRIVER=minio or the local-disk fallback is
//      active).
//   2. Lists every storageKey referenced by a DocumentVersion row, across
//      ALL tenants (this is an ops/maintenance script, not tenant-scoped
//      like request-time app code).
//   3. Diffs the two sets to find storage objects with no matching
//      DocumentVersion row.
//   4. Filters candidates to those older than a configurable age threshold
//      (default 24h) so we never race an in-flight upload whose storage
//      write has landed but whose DB transaction hasn't committed yet.
//   5. By default only REPORTS candidates (mirrors reconcile-storage-usage.ts's
//      safe-by-default pattern). Deletion only happens with an explicit
//      --fix flag.
//
// Usage:
//   npm run sweep:orphaned-storage                       # report only
//   npm run sweep:orphaned-storage -- --fix               # delete orphans
//   npm run sweep:orphaned-storage -- --max-age-hours=48   # override threshold
//
// The age threshold can also be set via env var ORPHAN_SWEEP_MAX_AGE_HOURS.

import fs from 'node:fs/promises';
import path from 'node:path';
import { sequelize, DocumentVersion, initModels } from '../src/infrastructure/database/index.js';
import { config } from '../src/config/env.js';
import { logger } from '../src/core/logger.js';
import { getStorageAdapter } from '../src/infrastructure/storage/StorageAdapter.js';
import { minioClient } from '../src/infrastructure/storage/minio.js';

const ENC_SUFFIX = '.enc';

// Mirrors LOCAL_BASE in StorageAdapter.ts — must stay in sync with it since
// there is no shared export for the base directory.
const LOCAL_BASE = path.resolve(process.cwd(), 'storage', 'dms-documents');

interface StorageObject {
  /** storageKey with the .enc suffix stripped, forward-slash separated */
  key: string;
  sizeBytes: number;
  lastModified: Date;
}

async function listLocalObjects(): Promise<StorageObject[]> {
  const objects: StorageObject[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(ENC_SUFFIX)) {
        const stat = await fs.stat(fullPath);
        const relPath = path.relative(LOCAL_BASE, fullPath).split(path.sep).join('/');
        objects.push({
          key: relPath.slice(0, -ENC_SUFFIX.length),
          sizeBytes: stat.size,
          lastModified: stat.mtime
        });
      }
    }
  }

  await walk(LOCAL_BASE);
  return objects;
}

async function listMinioObjects(): Promise<StorageObject[]> {
  const bucket = config.MINIO_BUCKET_DOCUMENTS;
  const objects: StorageObject[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = minioClient.listObjectsV2(bucket, '', true);
    stream.on('data', (obj) => {
      if (!obj.name || !obj.name.endsWith(ENC_SUFFIX)) return;
      objects.push({
        key: obj.name.slice(0, -ENC_SUFFIX.length),
        sizeBytes: obj.size ?? 0,
        lastModified: obj.lastModified ?? new Date(0)
      });
    });
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  return objects;
}

/** List all `.enc` storage objects present in the currently-configured backend. */
async function listStorageObjects(): Promise<{ driver: 'local' | 'minio'; objects: StorageObject[] }> {
  // Match the same driver selection logic as getStorageAdapter() so the
  // sweep always walks the backend that documentCrypto.ts actually writes to.
  const driver = config.STORAGE_DRIVER ?? 'local';
  // Touch the adapter factory so any driver-selection logging/side effects
  // (and a fail-fast if misconfigured) happen exactly as they do in prod code.
  getStorageAdapter();

  if (driver === 'minio') {
    return { driver, objects: await listMinioObjects() };
  }
  return { driver, objects: await listLocalObjects() };
}

/** Load every storageKey referenced by a DocumentVersion row, across all tenants. */
async function loadReferencedKeys(): Promise<Set<string>> {
  const rows = await DocumentVersion.findAll({ attributes: ['storageKey'], raw: true });
  const keys = new Set<string>();
  for (const row of rows as unknown as Array<{ storageKey: string }>) {
    if (row.storageKey) keys.add(row.storageKey);
  }
  return keys;
}

interface OrphanCandidate extends StorageObject {
  ageHours: number;
}

async function findOrphans(maxAgeHours: number): Promise<{
  driver: string;
  totalObjects: number;
  totalReferencedKeys: number;
  candidates: OrphanCandidate[];
}> {
  const [{ driver, objects }, referencedKeys] = await Promise.all([
    listStorageObjects(),
    loadReferencedKeys()
  ]);

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  const candidates: OrphanCandidate[] = [];
  for (const obj of objects) {
    if (referencedKeys.has(obj.key)) continue;
    const ageMs = now - obj.lastModified.getTime();
    if (ageMs < maxAgeMs) continue; // too young — possibly an in-flight upload
    candidates.push({ ...obj, ageHours: ageMs / (60 * 60 * 1000) });
  }

  // Oldest first, since those are the least likely to be a false positive.
  candidates.sort((a, b) => b.ageHours - a.ageHours);

  return { driver, totalObjects: objects.length, totalReferencedKeys: referencedKeys.size, candidates };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

async function sweepOrphanedStorage(fix: boolean, maxAgeHours: number): Promise<void> {
  console.log('\n=== Orphaned Storage Sweep ===\n');
  console.log(`Mode:            ${fix ? 'FIX (will delete)' : 'REPORT ONLY'}`);
  console.log(`Age threshold:   ${maxAgeHours}h (objects newer than this are skipped)\n`);

  const { driver, totalObjects, totalReferencedKeys, candidates } = await findOrphans(maxAgeHours);

  console.log(`Storage driver:            ${driver}`);
  console.log(`Storage objects scanned:   ${totalObjects}`);
  console.log(`DocumentVersion keys (all tenants): ${totalReferencedKeys}`);
  console.log(`Orphan candidates (older than ${maxAgeHours}h): ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('✓ No orphaned storage objects found.');
    return;
  }

  let totalOrphanBytes = 0;
  for (const candidate of candidates) {
    totalOrphanBytes += candidate.sizeBytes;
    console.log(
      `  ${fix ? '✗ deleting' : '! orphan  '} ${candidate.key}` +
        `  (${formatBytes(candidate.sizeBytes)}, age ${candidate.ageHours.toFixed(1)}h)`
    );

    if (fix) {
      try {
        const storage = getStorageAdapter();
        await storage.delete(candidate.key + ENC_SUFFIX);
        logger.info({ key: candidate.key }, 'Deleted orphaned storage object');
      } catch (error) {
        logger.error({ error, key: candidate.key }, 'Failed to delete orphaned storage object');
      }
    }
  }

  console.log(`\nTotal orphaned bytes: ${totalOrphanBytes} (${formatBytes(totalOrphanBytes)})`);

  if (!fix) {
    console.log('\nTo delete these objects, run with --fix:');
    console.log('  npm run sweep:orphaned-storage -- --fix');
  } else {
    console.log('\n✓ Fix complete: orphaned objects removed.');
  }
}

function parseMaxAgeHours(args: string[]): number {
  const flag = args.find((a) => a.startsWith('--max-age-hours='));
  if (flag) {
    const value = Number(flag.split('=')[1]);
    if (Number.isFinite(value) && value >= 0) return value;
    throw new Error(`Invalid --max-age-hours value: ${flag}`);
  }
  const fromEnv = process.env.ORPHAN_SWEEP_MAX_AGE_HOURS;
  if (fromEnv) {
    const value = Number(fromEnv);
    if (Number.isFinite(value) && value >= 0) return value;
    throw new Error(`Invalid ORPHAN_SWEEP_MAX_AGE_HOURS env value: ${fromEnv}`);
  }
  return 24;
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const maxAgeHours = parseMaxAgeHours(args);

  try {
    await sequelize.authenticate();
    logger.info('Database connection established');
    // Model classes are only `.init()`-ed (rawAttributes populated etc.) via
    // initModels(); it's normally called once at server/worker boot. Standalone
    // scripts must call it themselves before issuing any ORM queries.
    initModels();

    await sweepOrphanedStorage(fix, maxAgeHours);

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Orphaned storage sweep failed');
    await sequelize.close();
    process.exit(1);
  }
}

main();
