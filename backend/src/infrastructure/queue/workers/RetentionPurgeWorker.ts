// S5-02: Retention CRON (02:00) — cold storage tiering, skip legal hold
// S5-12: Two-stage purge CRON (03:00) — trash -> PurgePending -> 7-day cooling
import { Worker, Job, Queue } from 'bullmq';
import { Op } from 'sequelize';
import { logger } from '../../../core/logger.js';
import { getRedis } from '../../cache/redis.js';
import {
  Document,
  ArchiveRecord,
  PurgePending,
  RetentionApplication,
  OutboxEvent,
  Tenant,
} from '../../database/index.js';
import { writeAuditLog } from '../../../modules/audit/audit.service.js';
import { AUDIT_EVENTS } from '../../../modules/audit/auditEvents.js';
import { executePurge } from '../../../modules/documents/trashService.js';
import { withWorkerTenantContext } from '../../../shared/workerTenantContext.js';
import { attachErrorLogger, reportJobFailure } from '../queues.js';

const RETENTION_CRON_QUEUE = 'retention-cold-tiering';
const PURGE_CRON_QUEUE = 'purge-cooling';

// ─── Cold Storage Tiering (S5-02) ─────────────────────────────────────────────

async function runColdStorageTiering() {
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 2); // 730 days inactive

  // Iterate per tenant so the `documents` SELECT runs inside that tenant's
  // app.current_tenant GUC. `documents` is RLS-protected and lost its superuser
  // escape valve, so a single un-scoped findAll returns zero rows under the
  // intended non-superuser DB role and cold-tiering silently stops (same class
  // as the ApprovalSlaWorker S19 fix). Per-tenant try/catch isolates failures.
  const tenants = await Tenant.findAll({ attributes: ['id'], raw: true });
  let moved = 0;
  for (const t of tenants) {
    try {
      moved += await withWorkerTenantContext(t.id, async () => {
        const docsForCold = await Document.findAll({
          where: {
            tenantId: t.id,
            status: 'ARCHIVED',
            isOnLegalHold: false,
            updatedAt: { [Op.lte]: cutoffDate },
          },
        });
        let localMoved = 0;
        for (const doc of docsForCold) {
          const [archive, created] = await ArchiveRecord.findOrCreate({
            where: { documentId: doc.id },
            defaults: {
              documentId: doc.id,
              status: 'ARCHIVED',
              archiveStorageTier: 'COLD',
            },
          });

          if (!created && archive.archiveStorageTier !== 'COLD') {
            await archive.update({ archiveStorageTier: 'COLD' });
            await writeAuditLog({
              eventType: AUDIT_EVENTS.RETENTION_COLD_TIER,
              documentId: doc.id,
              actionDetails: { documentName: doc.documentName, reason: 'inactive_730_days' },
            });
            localMoved++;
          } else if (created) {
            await writeAuditLog({
              eventType: AUDIT_EVENTS.RETENTION_COLD_TIER,
              documentId: doc.id,
              actionDetails: { documentName: doc.documentName, reason: 'inactive_730_days' },
            });
            localMoved++;
          }
        }
        return localMoved;
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'cold-tiering failed for tenant');
    }
  }

  logger.info({ moved }, 'Cold storage tiering complete');
  return { moved };
}

// ─── Two-Stage Purge CRON (S5-12) ─────────────────────────────────────────────

async function runPurgeCooling() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Both stages read the RLS-protected `documents` table, so iterate per tenant
  // under the tenant GUC (see runColdStorageTiering). `purge_pending` itself is
  // NOT RLS-protected, but executePurge reads `documents` internally, so each
  // purge must also run inside the owning tenant's context.
  const tenants = await Tenant.findAll({ attributes: ['id'], raw: true });
  let pendingCreated = 0;
  let purged = 0;

  for (const t of tenants) {
    // Stage 1: promote 30-day-old trashed docs to PurgePending (7-day cooling).
    try {
      pendingCreated += await withWorkerTenantContext(t.id, async () => {
        const trashedDocs = await Document.findAll({
          where: {
            tenantId: t.id,
            status: 'TRASHED',
            deletedAt: { [Op.lte]: thirtyDaysAgo },
            isOnLegalHold: false,
          },
        });
        let n = 0;
        for (const doc of trashedDocs) {
          const existing = await PurgePending.findOne({ where: { documentId: doc.id } });
          if (!existing) {
            await PurgePending.create({
              documentId: doc.id,
              purgeAfter: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
              status: 'PENDING',
            });
            await writeAuditLog({
              eventType: AUDIT_EVENTS.PURGE_PENDING_CREATED,
              documentId: doc.id,
              actionDetails: { documentName: doc.documentName },
            });
            n++;
          }
        }
        return n;
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'purge stage-1 (promote to pending) failed for tenant');
    }

    // Stage 2: collect ready-to-purge document ids for this tenant (the required
    // inner join to `documents` scopes them via RLS + the explicit tenant filter),
    // then purge each in its OWN tenant-scoped transaction so one failure doesn't
    // roll back the others.
    let readyDocumentIds: string[] = [];
    try {
      await withWorkerTenantContext(t.id, async () => {
        const rows = await PurgePending.findAll({
          where: { purgeAfter: { [Op.lte]: now }, status: 'PENDING' },
          include: [{ model: Document, required: true, attributes: ['id'], where: { tenantId: t.id } }],
        });
        readyDocumentIds = rows.map((r) => r.documentId);
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'purge stage-2 (collect ready) failed for tenant');
    }

    for (const documentId of readyDocumentIds) {
      try {
        // Real destruction: deletes ciphertext + rows, de-indexes, issues a
        // Certificate of Destruction. authorisedById=null → automated cooling job.
        await withWorkerTenantContext(t.id, () => executePurge(documentId, null));
        purged++;
      } catch (err) {
        logger.error({ err, documentId }, 'purge execution failed');
      }
    }
  }

  logger.info({ pendingCreated, purged }, 'Purge cooling cycle complete');
  return { pendingCreated, purged };
}

// ─── Disposal Eligibility Notifications (S6-04) ───────────────────────────────

async function runDisposalEligibilityNotifications() {
  const now = new Date();
  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Iterate per tenant: the include of the RLS-protected `documents` table (as a
  // required inner join, scoped to this tenant) needs the tenant GUC, else it
  // returns no rows and disposal warnings silently stop under the non-superuser
  // role. Read AND writes run in ONE per-tenant transaction — the flag update +
  // outbox row stay atomic (the original intent), and the notified* flags gate
  // re-sending so a rolled-back tenant simply retries next run.
  const tenants = await Tenant.findAll({ attributes: ['id'], raw: true });
  let notified90 = 0;
  let notified30 = 0;

  for (const t of tenants) {
    try {
      const res = await withWorkerTenantContext(t.id, async () => {
        const applications = await RetentionApplication.findAll({
          where: { disposalAuthorisedAt: null },
          include: [{ model: Document, as: 'document', required: true, where: { tenantId: t.id, isOnLegalHold: false } }],
        });
        let n90 = 0;
        let n30 = 0;
        for (const app of applications) {
          const doc = (app as any).document;
          if (!doc) continue;

          if (!app.notified90Days && app.eligibleAt <= in90Days && app.eligibleAt > in30Days) {
            await app.update({ notified90Days: true });
            await OutboxEvent.create({
              documentId: app.documentId,
              type: 'RETENTION.DISPOSAL_WARNING_90',
              channel: 'EMAIL',
              payload: JSON.stringify({
                documentId: app.documentId,
                documentName: doc.documentName,
                eligibleAt: app.eligibleAt.toISOString(),
                daysRemaining: 90,
                tenantId: t.id,
              }),
            });
            await writeAuditLog({
              eventType: AUDIT_EVENTS.RETENTION_APPLIED,
              documentId: app.documentId,
              actionDetails: { action: 'DISPOSAL_NOTIFICATION_90_DAYS', eligibleAt: app.eligibleAt.toISOString() },
            });
            n90++;
          }

          if (!app.notified30Days && app.eligibleAt <= in30Days) {
            await app.update({ notified30Days: true });
            await OutboxEvent.create({
              documentId: app.documentId,
              type: 'RETENTION.DISPOSAL_WARNING_30',
              channel: 'EMAIL',
              payload: JSON.stringify({
                documentId: app.documentId,
                documentName: doc.documentName,
                eligibleAt: app.eligibleAt.toISOString(),
                daysRemaining: 30,
                tenantId: t.id,
              }),
            });
            await writeAuditLog({
              eventType: AUDIT_EVENTS.RETENTION_APPLIED,
              documentId: app.documentId,
              actionDetails: { action: 'DISPOSAL_NOTIFICATION_30_DAYS', eligibleAt: app.eligibleAt.toISOString() },
            });
            n30++;
          }
        }
        return { n90, n30 };
      });
      notified90 += res.n90;
      notified30 += res.n30;
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'disposal eligibility notifications failed for tenant');
    }
  }

  logger.info(
    { notified90, notified30 },
    'Disposal eligibility notifications sent',
  );
  return { notified90, notified30 };
}

export function startDisposalNotificationWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn(
      'Redis not configured; disposal notification worker will not start',
    );
    return null;
  }

  const QUEUE_NAME = 'disposal-notifications';
  const queue = new Queue(QUEUE_NAME, { connection: redis });
  attachErrorLogger(queue, QUEUE_NAME);

  queue
    .add(
      'disposal-notify',
      { type: 'disposal-notify' },
      {
        repeat: { pattern: '0 6 * * *' }, // Daily at 06:00
        jobId: 'disposal-notifications-daily',
      },
    )
    .catch((e) =>
      logger.error({ e }, 'Failed to schedule disposal notification job'),
    );

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.data.type === 'disposal-notify') {
        logger.info('Running disposal eligibility notifications');
        return runDisposalEligibilityNotifications();
      }
      throw new Error(`Unknown job type: ${job.data.type}`);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      'Disposal notification job failed',
    );
    reportJobFailure(QUEUE_NAME, err, job?.id);
  });
  attachErrorLogger(worker, QUEUE_NAME);

  logger.info('Disposal notification worker started (daily 06:00)');
  return worker;
}

// ─── Worker Factories ──────────────────────────────────────────────────────────

export function startRetentionColdWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn(
      'Redis not configured; retention cold-tiering worker will not start',
    );
    return null;
  }

  const queue = new Queue(RETENTION_CRON_QUEUE, { connection: redis });
  attachErrorLogger(queue, RETENTION_CRON_QUEUE);

  queue
    .add(
      'cold-tier',
      { type: 'cold-tier' },
      {
        repeat: { pattern: '0 2 * * *' }, // Daily 02:00
        jobId: 'retention-cold-daily',
      },
    )
    .catch((e) => logger.error({ e }, 'Failed to schedule cold-tier job'));

  const worker = new Worker(
    RETENTION_CRON_QUEUE,
    async (job: Job) => {
      if (job.data.type === 'cold-tier') {
        logger.info('Running cold storage tiering job');
        return runColdStorageTiering();
      }
      throw new Error(`Unknown job type: ${job.data.type}`);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Cold-tier job failed');
    reportJobFailure(RETENTION_CRON_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, RETENTION_CRON_QUEUE);

  logger.info('Retention cold-tiering worker started (daily 02:00)');
  return worker;
}

export function startPurgeCoolingWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn('Redis not configured; purge cooling worker will not start');
    return null;
  }

  const queue = new Queue(PURGE_CRON_QUEUE, { connection: redis });
  attachErrorLogger(queue, PURGE_CRON_QUEUE);

  queue
    .add(
      'purge-cooling',
      { type: 'purge-cooling' },
      {
        repeat: { pattern: '0 3 * * *' }, // Daily 03:00
        jobId: 'purge-cooling-daily',
      },
    )
    .catch((e) => logger.error({ e }, 'Failed to schedule purge-cooling job'));

  const worker = new Worker(
    PURGE_CRON_QUEUE,
    async (job: Job) => {
      if (job.data.type === 'purge-cooling') {
        logger.info('Running purge cooling cycle job');
        return runPurgeCooling();
      }
      throw new Error(`Unknown job type: ${job.data.type}`);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      'Purge cooling job failed',
    );
    reportJobFailure(PURGE_CRON_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, PURGE_CRON_QUEUE);

  logger.info('Purge cooling worker started (daily 03:00)');
  return worker;
}

export const RETENTION_COLD_QUEUE_NAME = RETENTION_CRON_QUEUE;
export const PURGE_COOLING_QUEUE_NAME = PURGE_CRON_QUEUE;
