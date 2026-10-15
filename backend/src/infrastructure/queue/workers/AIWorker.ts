/**
 * AIWorker — handles AI_SUMMARIZE and AI_EXTRACT_METADATA outbox events.
 *
 * Provider-agnostic — goes through llmClient.ts, so whichever of
 * GROQ_API_KEY / OPENAI_API_KEY / AI_API_KEY(+AI_BASE_URL) / ANTHROPIC_API_KEY
 * is configured is what actually runs these jobs (see llmClient.ts).
 * Every AI action writes to AuditLog with eventType AI_OPERATION.
 * Gated per tenant by tenants.feature_flags.ai_processing (consent) and tenants.ai_policy (AI Controls),
 * checked in checkAiRequest below; a job with no provider configured is recorded as skipped_no_provider.
 * API key stored in environment — never plaintext DB.
 */
import { Worker, type Job } from 'bullmq';
import { getRedis } from '../../cache/redis.js';
import { Document, DocumentVersion } from '../../database/index.js';
import { logger } from '../../../core/logger.js';
import { enqueueWebsocketEvent } from '../outbox.js';
import { writeAuditLog } from '../../../modules/audit/audit.service.js';
import { AUDIT_EVENTS } from '../../../modules/audit/auditEvents.js';
import { AI_CONSENT_FLAG, checkAiRequest, loadAiDocumentFacts, recordAiUsage, type AiFeature } from '../../../modules/ai/aiPolicy.service.js';
import { isAiConfigured, llmComplete } from '../../../modules/ai/llmClient.js';
import { withWorkerTenantContext } from '../../../shared/workerTenantContext.js';
import { attachErrorLogger, reportJobFailure } from '../queues.js';
import { fanOut } from '../../../modules/notifications/notifications.service.js';
import { aiProcessingDuration, recordAiOutcome } from '../../metrics.js';

// M13: the tenant consent flag (`AI_CONSENT_FLAG`, 'ai_processing') now lives in
// modules/ai/aiPolicy.service.ts next to the rest of the AI rules. Re-exported so
// existing imports keep working.
export { AI_CONSENT_FLAG };

const AI_QUEUE = 'AI_PROCESSING';

async function summarizeDocument(documentId: string, extractedText: string, tenantId: string): Promise<void> {
  if (!isAiConfigured()) {
    logger.warn({ documentId }, 'no AI provider configured — skipping summarization');
    return;
  }

  const text = extractedText.slice(0, 8000); // keep well within a small/cheap model's context
  const { text: summaryRaw, model, usage } = await llmComplete(
    `Summarize the following document in 3-5 concise sentences suitable for an executive summary. Focus on the main purpose, key decisions or findings, and any critical dates or parties involved. Do not add preamble or sign-off text.

Document text:
${text}`,
    512,
  );

  const summary = summaryRaw.trim();
  if (!summary) return;

  // documents has RLS with no unset-GUC escape valve — a bare write here would
  // silently touch 0 rows once the DB role is switched away from superuser.
  await withWorkerTenantContext(tenantId, () => Document.update({ aiSummary: summary } as any, { where: { id: documentId } }));

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId,
    actionDetails: {
      aiOperation: 'summarize',
      model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    },
  });
}

async function extractMetadata(documentId: string, extractedText: string, tenantId: string): Promise<void> {
  if (!isAiConfigured()) {
    logger.warn({ documentId }, 'no AI provider configured — skipping metadata extraction');
    return;
  }

  const text = extractedText.slice(0, 6000);
  const { text: raw, model, usage } = await llmComplete(
    `Analyze the following document and extract metadata. Return ONLY a JSON object with these exact keys (use null for unknowns):
{
  "suggestedClassification": one of "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
  "suggestedKeywords": array of up to 8 relevant keyword strings,
  "suggestedDocumentDate": ISO date string YYYY-MM-DD or null,
  "suggestedLanguage": ISO 639-1 code e.g. "en" or null,
  "summary": one sentence description
}

Document text:
${text}`,
    512,
  );

  let metadata: Record<string, unknown> = {};
  try {
    // Strip markdown code fences if present
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    metadata = JSON.parse(cleaned);
  } catch {
    logger.warn({ documentId, raw }, 'AI metadata extraction returned non-JSON');
    return;
  }

  await withWorkerTenantContext(tenantId, () => Document.update({ aiSuggestedMetadata: metadata } as any, { where: { id: documentId } }));

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId,
    actionDetails: {
      aiOperation: 'extract_metadata',
      model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    },
  });
}

export async function createAIWorker() {
  const connection = getRedis();
  if (!connection) return;

  const worker = new Worker(
    AI_QUEUE,
    async (job: Job) => {
      const { documentId, versionId, tenantId: jobTenantId, operation, correlationId, requestedByUserId } = job.data as {
        documentId: string;
        versionId?: string;
        tenantId?: string;
        operation: 'AI_SUMMARIZE' | 'AI_EXTRACT_METADATA';
        correlationId?: string;
        requestedByUserId?: string;
      };
      const logCtx = { documentId, operation, correlationId };

      logger.info(logCtx, 'ai worker processing');
      const stopTimer = aiProcessingDuration.startTimer({ operation });

      // F-06 follow-up (2026-09-03): DOCUMENT.AI_COMPLETED used to be pushed
      // on the SUCCESS path only. The three other ways a job ends —
      // insufficient extracted text, tenant consent not granted, and an
      // outright job failure — emitted nothing, so the document-detail AI card
      // sat on "queued" with no event ever arriving. That is precisely why its
      // 4s poll could not simply be deleted: for every non-success outcome the
      // poll was the ONLY thing that ever resolved the card.
      //
      // Emitting on every terminal outcome makes the socket the real signal,
      // which is what lets the interval become a socket-down fallback. The
      // `outcome` field is informational; the frontend only needs the
      // invalidation, and re-reads the authoritative status from the API.
      const pushTerminalEvent = async (outcome: string, departmentId?: string | null, eventTenantId?: string) => {
        try {
          await enqueueWebsocketEvent('DOCUMENT.AI_COMPLETED', {
            documentId,
            operation,
            outcome,
            departmentId: departmentId ?? null,
            tenantId: eventTenantId,
            recipientUserIds: requestedByUserId ? [requestedByUserId] : undefined,
          });
        } catch (err) {
          logger.error({ err, ...logCtx, outcome }, 'failed to enqueue AI_COMPLETED websocket event');
        }
      };

      // Prefer the tenantId carried on the job (set by whoever enqueued it)
      // over a bare Document.findByPk: documents has RLS with no unset-GUC
      // escape valve, so an unscoped read here would return null the day the
      // DB role is switched away from superuser — permanently collapsing the
      // consent gate below to its fail-closed 'unknown' branch and silently
      // stopping ALL AI processing, not just misattributing one document.
      // Resolved before the text-length check below (not just before the
      // consent check) because a skipped-for-insufficient-text job now also
      // needs a tenantId + title to notify the requester via fanOut().
      const doc = jobTenantId
        ? await withWorkerTenantContext(jobTenantId, () => Document.findByPk(documentId, { attributes: ['id', 'tenantId', 'departmentId', 'title'] }))
        : await Document.findByPk(documentId, { attributes: ['id', 'tenantId', 'departmentId', 'title'] });
      const tenantId = jobTenantId ?? (doc as any)?.tenantId ?? 'unknown';

      // Load extracted text from the latest version (document_versions carries
      // no RLS, so this read needs no tenant context either way).
      const version = versionId
        ? await DocumentVersion.findByPk(versionId)
        : await DocumentVersion.findOne({
            where: { documentId },
            order: [['createdAt', 'DESC']],
          });

      const text = version?.extractedText ?? '';
      if (!text || text.trim().length < 50) {
        // FIX (observability follow-up): this used to just log a warning and
        // return — the on-demand /summarize and /extract routes (unlike the
        // OCR auto-enqueue path, which only enqueues once text.length >= 50)
        // have no way to know a job will hit this before enqueueing it, so a
        // user clicking "Summarize" on a document with no OCR text got a
        // "queued" toast and then silence forever, with zero signal anywhere
        // of why. Now: metric + an in-app notification pointing back at the
        // document, same pattern as OUTBOX_DEAD_LETTER.
        await recordAiOutcome(operation, 'skipped_insufficient_text');
        logger.warn({ ...logCtx, textLength: text.length }, 'insufficient extracted text for AI processing — skipping');
        if (tenantId !== 'unknown') {
          await fanOut({
            type: 'AI_PROCESSING_SKIPPED',
            tenantId,
            severity: 'INFO',
            payload: {
              documentId,
              operation,
              documentTitle: (doc as any)?.title,
              reason: 'no usable text was extracted from this document (OCR found none, or the file type has no OCR support)',
            },
          }).catch((err) => logger.error({ err, ...logCtx }, 'failed to notify of AI_PROCESSING_SKIPPED'));
        }
        await pushTerminalEvent('skipped_insufficient_text', (doc as any)?.departmentId ?? null, tenantId !== 'unknown' ? tenantId : undefined);
        stopTimer();
        return;
      }

      // No provider configured: say so, instead of recording a "completed" job that produced nothing
      // (the AI card would then read "no summary yet" for ever with no error anywhere) and before the
      // policy check debits the tenant's quota for work that cannot happen.
      if (!isAiConfigured()) {
        await recordAiOutcome(operation, 'skipped_no_provider');
        logger.warn({ ...logCtx }, 'no AI provider configured (GROQ_API_KEY, OPENAI_API_KEY, AI_API_KEY[+AI_BASE_URL] or ANTHROPIC_API_KEY) — AI job skipped');
        await pushTerminalEvent('skipped_no_provider', (doc as any)?.departmentId ?? null, tenantId !== 'unknown' ? tenantId : undefined);
        stopTimer();
        return;
      }

      // M13 + AI usage controls: the single choke point every AI job flows
      // through (OCR auto-enqueue AND the on-demand routes), so it fails closed
      // even if a new enqueue path forgets to check. Beyond the tenant's consent
      // flag this now applies the AI policy: feature switches, the document's
      // classification / type / department, and (for the upload pipeline) the
      // auto-process switch and the tenant quota. A job a person asked for was
      // already counted by the route, so it is only verified here, not debited.
      const feature: AiFeature = operation === 'AI_SUMMARIZE' ? 'summarize' : 'extract';
      const isAuto = !requestedByUserId;
      const decision = tenantId === 'unknown'
        ? { allowed: false, code: 'ERR-AI-NOT-ENABLED' }
        : await withWorkerTenantContext(tenantId, async () => {
            const facts = await loadAiDocumentFacts(tenantId, documentId);
            return checkAiRequest({
              tenantId,
              userId: requestedByUserId ?? null,
              feature,
              trigger: isAuto ? 'auto' : 'user',
              document: facts,
              documentId,
              mode: isAuto ? 'debit' : 'verify',
            });
          });
      if (!decision.allowed) {
        // Expected steady-state for a tenant that has not opted in (or has
        // deliberately restricted AI) — a notification per job would be noise,
        // unlike the insufficient-text case above.
        const outcome = decision.code === 'ERR-AI-NOT-ENABLED' ? 'skipped_no_consent' : 'skipped_policy';
        await recordAiOutcome(operation, outcome);
        logger.info({ ...logCtx, code: decision.code }, 'ai processing skipped by policy');
        await pushTerminalEvent(outcome, (doc as any)?.departmentId ?? null, tenantId !== 'unknown' ? tenantId : undefined);
        stopTimer();
        return;
      }

      if (operation === 'AI_SUMMARIZE') {
        await summarizeDocument(documentId, text, tenantId);
      } else if (operation === 'AI_EXTRACT_METADATA') {
        await extractMetadata(documentId, text, tenantId);
      }
      await recordAiOutcome(operation, 'completed');
      await withWorkerTenantContext(tenantId, () => recordAiUsage({
        tenantId, userId: requestedByUserId ?? null, feature, trigger: isAuto ? 'auto' : 'user',
        documentId, outcome: 'completed',
      }));
      stopTimer();

      // Push a real-time completion event so the UI refreshes without polling.
      // Written as a WEBSOCKET outbox row (worker process has no Socket.IO
      // instance; the API-process outbox poller performs the emit).
      await pushTerminalEvent('completed', (doc as any)?.departmentId ?? null, tenantId);
    },
    { connection },
  );

  worker.on('failed', (job, err) => {
    const operation = job?.data?.operation as string | undefined;
    if (operation) recordAiOutcome(operation, 'failed').catch(() => {});
    logger.error({ jobId: job?.id, err, correlationId: job?.data?.correlationId }, 'ai worker job failed');
    reportJobFailure('AI_PROCESSING', err, job?.id);

    // The fourth terminal outcome, and the one that most needs an event: a
    // failed job leaves the AI card on "queued" with nothing else ever
    // arriving to correct it. Fires only after BullMQ has exhausted retries.
    // departmentId is not on job.data, so this routes by requester +
    // tenant admin room rather than by department.
    const documentId = job?.data?.documentId as string | undefined;
    const requestedByUserId = job?.data?.requestedByUserId as string | undefined;
    if (!documentId || !operation) return;
    enqueueWebsocketEvent('DOCUMENT.AI_COMPLETED', {
      documentId,
      operation,
      outcome: 'failed',
      tenantId: job?.data?.tenantId as string | undefined,
      recipientUserIds: requestedByUserId ? [requestedByUserId] : undefined,
    }).catch((enqueueErr) =>
      logger.error({ err: enqueueErr, documentId, operation }, 'failed to enqueue AI failure websocket event'),
    );
  });
  attachErrorLogger(worker, 'AI_PROCESSING');

  return worker;
}
