import { Worker, Job } from 'bullmq';
import { getRedis } from '../../cache/redis.js';
import { logger } from '../../../core/logger.js';
import { sendEmail } from '../../email/mailer.js';
import { renderEmail } from '../../email/templates.js';
import { DocumentVersion } from '../../database/index.js';
import { fetchAndDecrypt } from '../../../modules/documents/documentCrypto.js';
import { withWorkerTenantContext } from '../../../shared/workerTenantContext.js';
import { attachErrorLogger, reportJobFailure } from '../queues.js';

// PLATFORM-VERIFICATION-AUDIT-2026-09-19 §7.3: same fallback convention as
// SearchWorker/OCRWorker — wrap in tenant context whenever the job carries
// one; fall back unwrapped only for a legacy-shaped job enqueued before this
// field existed.
const inTenantCtx = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  tenantId ? withWorkerTenantContext(tenantId, fn) : fn();

/**
 * Generic outbound-email worker on the "EMAILS" BullMQ queue — retry/backoff
 * comes from createQueue()'s defaultJobOptions (3 attempts, exponential
 * backoff), the same as OCR/SEARCH_INDEX. Used for emails that need actual
 * file attachments (e.g. a dispatched letter sent to its external recipient
 * with the letter + QR cover sheet attached) — unlike the generic outbox
 * EMAIL channel (internal notifications, at most one small attachment,
 * fetched inline in the poller), this queue is for the higher-stakes,
 * externally-visible sends that deserve BullMQ's own retry/backoff/DLQ
 * bookkeeping and dashboard visibility instead of the outbox's DB-polled
 * backoff.
 */
export async function createEmailWorker() {
  const connection = getRedis();
  if (!connection) return;

  const worker = new Worker(
    'EMAILS',
    async (job: Job) => {
      const { to, type, payload, attachDocumentIds, tenantId } = job.data as {
        to: string;
        type: string;
        payload: Record<string, unknown>;
        attachDocumentIds?: string[];
        tenantId?: string;
      };

      const attachments: { filename: string; content: Buffer; contentType?: string }[] = await inTenantCtx(tenantId, async () => {
        const result: { filename: string; content: Buffer; contentType?: string }[] = [];
        for (const documentId of attachDocumentIds ?? []) {
          const version = await DocumentVersion.findOne({
            where: { documentId }, order: [['createdAt', 'DESC']],
          });
          if (!version) {
            logger.warn({ jobId: job.id, documentId }, '[email-worker] attachment document version not found, skipping it');
            continue;
          }
          const buffer = await fetchAndDecrypt(version.storageKey, version.id);
          result.push({ filename: version.originalFilename, content: buffer, contentType: version.mimeType });
        }
        return result;
      });

      const { subject, text, html } = renderEmail(type, payload);
      await sendEmail({ to, subject, text, html, attachments: attachments.length ? attachments : undefined });
      logger.info({ jobId: job.id, to, type, attachmentCount: attachments.length }, '[email-worker] sent');
    },
    { connection },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err, attemptsMade: job?.attemptsMade }, '[email-worker] job failed');
    reportJobFailure('EMAILS', err, job?.id);
  });
  attachErrorLogger(worker, 'EMAILS');

  return worker;
}
