/**
 * AI Module — compliance chat assistant + semantic search.
 *
 * POST /ai/chat  — natural language queries over audit logs and documents.
 *   The LLM receives tool definitions that map to existing REST endpoints.
 *   Strict tenant scoping: every tool call injects req.user.tenantId.
 *   Provider-agnostic — see llmClient.ts for how GROQ_API_KEY / OPENAI_API_KEY /
 *   AI_API_KEY(+AI_BASE_URL) / ANTHROPIC_API_KEY are resolved.
 *
 * GET  /ai/documents/:id/summary     — return stored AI summary for a document.
 * GET  /ai/documents/:id/suggestions — return stored AI metadata suggestions.
 * POST /ai/documents/:id/summarize   — trigger on-demand summarization.
 * POST /ai/documents/:id/extract     — trigger on-demand metadata extraction.
 */
import { restrictAuditToVisibleActors } from '../../shared/platformAdmin.js';
import { Router } from 'express';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission, type AuthenticatedUser } from '../../shared/auth.js';
import { requireACL, assertACLAllow } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../core/AppError.js';
import { Document, AuditLog } from '../../infrastructure/database/index.js';
import { Queue } from 'bullmq';
import { getRedis } from '../../infrastructure/cache/redis.js';
import { Op } from 'sequelize';
import { z } from 'zod';
import { isEnabled } from '../feature-flags/featureFlags.service.js';
import {
  AI_CONSENT_FLAG,
  authorizeAiRequest,
  aiMayHandleDocument,
  type ChatPolicyFacts,
  explainAiBlock,
  getAiPolicy,
  getAiUsageSummary,
  recordAiUsage,
  setAiPolicy,
} from './aiPolicy.service.js';
import { llmChat, type LlmChatMessage, type LlmToolDef } from './llmClient.js';
import { filterDocsByDetailAcl } from '../documents/documents.service.js';
import { getCorrelationId } from '../../shared/requestContext.js';
import { attachErrorLogger } from '../../infrastructure/queue/queues.js';
import { hasAiOperationEverFailed } from '../../infrastructure/metrics.js';

export const aiRoutes = Router();

/** M13: tenant-level consent gate — no tenant data goes to the external AI
 *  provider unless an admin turned on the `ai_processing` feature flag. Kept
 *  for callers that only need the master switch; everything that actually
 *  sends content must use authorizeAiRequest() (aiPolicy.service.ts), which
 *  layers the feature switches, content rules and quotas on top. */
export async function assertAiConsent(tenantId: string): Promise<void> {
  if (!(await isEnabled(tenantId, AI_CONSENT_FLAG))) {
    throw new AppError(
      403,
      'ERR-AI-NOT-ENABLED',
      'AI processing is not enabled for this tenant. A tenant admin must enable the "ai_processing" feature flag first.',
    );
  }
}

// ─── Tool definitions for the compliance chat assistant ──────────────────────

const CHAT_TOOLS: LlmToolDef[] = [
  {
    name: 'search_documents',
    description: 'Search documents in the system by keyword, status, department, or date range.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for' },
        status: { type: 'string', description: 'Document status filter e.g. ACTIVE, ARCHIVED, DISPOSED' },
        departmentCode: { type: 'string', description: 'Department code filter' },
        dateFrom: { type: 'string', description: 'ISO date string — created on or after this date' },
        dateTo: { type: 'string', description: 'ISO date string — created on or before this date' },
        limit: { type: 'number', description: 'Max results, default 20' },
      },
      required: [],
    },
  },
  {
    name: 'get_audit_events',
    description: 'Retrieve audit log entries for compliance review. Can filter by event type, user, document, or date range.',
    parameters: {
      type: 'object',
      properties: {
        eventType: { type: 'string', description: 'Specific audit event type e.g. AUTH_LOGIN, DOCUMENT_DOWNLOADED' },
        userId: { type: 'string', description: 'Filter by user ID' },
        documentId: { type: 'string', description: 'Filter by document ID' },
        dateFrom: { type: 'string', description: 'ISO date string' },
        dateTo: { type: 'string', description: 'ISO date string' },
        limit: { type: 'number', description: 'Max results, default 20' },
      },
      required: [],
    },
  },
  {
    name: 'get_document_details',
    description: 'Get full metadata for a specific document by its ID.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Document UUID' },
      },
      required: ['documentId'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

// Platform audit finding (2026-08-14, MEDIUM, follow-up): all three tools
// below filtered only by tenantId — the same gap the four /documents/:id/...
// routes further down were already fixed for ("Platform audit finding 4.2"),
// just never applied here. AUDIT_READ (the permission gating /ai/chat) is
// held by RECORDS_OFFICER and AUDITOR, both of which already carry
// DOCUMENT_READ_ALL — but this codebase explicitly relies on per-document ACL
// DENY entries to still restrict even those oversight roles from specific
// hyper-sensitive documents (documents.service.ts's own listDocuments has the
// same comment). Bypassing ACL here let the chat assistant read/search past
// that DENY layer. Fixed using the same filterDocsByDetailAcl()/assertACLAllow
// calls the rest of the codebase already relies on for this — silently
// dropping a denied document from search/list results (matching this file's
// existing "not found" convention for a single lookup), consistent with how
// a tool result is meant to degrade gracefully rather than crash the chat
// loop with a thrown error.
// AI Controls (confidentiality ceiling, blocked document types and departments) apply to what a chat
// tool hands the model too: a document the policy keeps away from AI is not described to it either.
// Those fields were not consulted here before, so the chat could report the classification and metadata of
// documents the same person's summaries and suggestions would have refused to send.
type PolicyFacts = ChatPolicyFacts;

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  user: AuthenticatedUser,
): Promise<string> {
  const tenantId = user.tenantId;
  const policy = await getAiPolicy(tenantId);
  if (toolName === 'search_documents') {
    const where: Record<string, unknown> = { tenantId, deletedAt: null };
    if (input.status) where.status = input.status;
    const limit = Math.min(Number(input.limit ?? 20), 50);
    if (input.dateFrom || input.dateTo) {
      const range: Record<string, Date> = {};
      if (input.dateFrom) range[Op.gte as unknown as string] = new Date(input.dateFrom as string);
      if (input.dateTo) range[Op.lte as unknown as string] = new Date(input.dateTo as string);
      where.createdAt = range;
    }
    if (input.query && typeof input.query === 'string') {
      where[Op.or as unknown as string] = [
        { title: { [Op.iLike]: `%${input.query}%` } },
        { documentName: { [Op.iLike]: `%${input.query}%` } },
      ];
    }
    const docs = await Document.findAll({
      where,
      attributes: ['id', 'documentName', 'title', 'status', 'securityClassification', 'documentTypeId', 'departmentId', 'createdAt'],
      limit,
      order: [['updatedAt', 'DESC']],
      raw: true,
    });
    const readable = await filterDocsByDetailAcl(user, docs as Array<{ id: string }>);
    const visible = (readable as PolicyFacts[]).filter((d) => aiMayHandleDocument(policy, d));
    const withheld = readable.length - visible.length;
    return JSON.stringify({
      count: visible.length,
      documents: visible,
      ...(withheld > 0 ? { withheldByAiPolicy: withheld, note: 'Some matching documents are not shown because AI Controls keep them away from AI.' } : {}),
    });
  }

  if (toolName === 'get_audit_events') {
    const where: Record<string, unknown> = { tenantId };
    if (input.eventType) where.eventType = input.eventType;
    if (input.userId) where.userId = input.userId;
    if (input.documentId) {
      // Same document:read ACL check as the equivalent, already-fixed
      // GET /audit/document/:documentId route.
      try {
        await assertACLAllow(
          user.userId,
          user.roles,
          user.tenantId,
          { resourceType: 'document', resourceId: input.documentId as string, permission: PERMISSIONS.DOCUMENT_READ },
          user.permissions,
        );
      } catch {
        return JSON.stringify({ error: 'Access denied to audit events for that document' });
      }
      const facts = await Document.findOne({ where: { id: input.documentId as string, tenantId }, attributes: ['id', 'securityClassification', 'documentTypeId', 'departmentId'], raw: true });
      if (facts && !aiMayHandleDocument(policy, facts as PolicyFacts)) {
        return JSON.stringify({ error: 'AI Controls keep that document away from AI' });
      }
      where.documentId = input.documentId;
    }
    if (input.dateFrom || input.dateTo) {
      const range: Record<string, Date> = {};
      if (input.dateFrom) range[Op.gte as unknown as string] = new Date(input.dateFrom as string);
      if (input.dateTo) range[Op.lte as unknown as string] = new Date(input.dateTo as string);
      where.timestamp = range;
    }
    const limit = Math.min(Number(input.limit ?? 20), 100);
    const logs = await AuditLog.findAll({
      where: await restrictAuditToVisibleActors(where, user.userId),
      order: [['sequenceNumber', 'DESC']],
      limit,
      raw: true,
    });
    const safe = logs.map((l: any) => ({ ...l, sequenceNumber: String(l.sequenceNumber) }));
    return JSON.stringify({ count: safe.length, events: safe });
  }

  if (toolName === 'get_document_details') {
    const doc = await Document.findOne({
      where: { id: input.documentId as string, tenantId },
      raw: true,
    });
    if (!doc) return JSON.stringify({ error: 'Document not found' });
    const [visible] = await filterDocsByDetailAcl(user, [doc as { id: string }]);
    if (!visible) return JSON.stringify({ error: 'Document not found' });
    if (!aiMayHandleDocument(policy, doc as PolicyFacts)) return JSON.stringify({ error: 'AI Controls keep that document away from AI' });
    return JSON.stringify(doc);
  }

  return JSON.stringify({ error: `Unknown tool: ${toolName}` });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** POST /ai/chat — compliance chat assistant */
aiRoutes.post(
  '/chat',
  requirePermission(PERMISSIONS.AUDIT_READ),
  requirePermission(PERMISSIONS.AI_CHAT),
  asyncHandler(async (req, res) => {
    const { message, history = [] } = req.body as {
      message?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };
    if (!message) throw new AppError(400, 'ERR-INVALID-INPUT', 'message is required');

    await authorizeAiRequest({ tenantId: req.user!.tenantId, userId: req.user!.userId, feature: 'chat' });
    const tenantId = req.user!.tenantId;

    const SYSTEM = `You are DMS Compliance Assistant — an AI that helps administrators understand \
document activity, access patterns, and audit trail data for the ${tenantId} tenant.

You have access to tools that query the live system. Use them to answer the user's question accurately.
IMPORTANT: All data you retrieve is scoped to tenant "${tenantId}" — never reveal data from other tenants.
Be concise and professional. When presenting document or audit data, summarize it clearly.`;

    // Agentic loop: let the model use tools until it produces a final text
    // response. llmChat() is one provider-agnostic round-trip; the loop
    // (execute tool -> feed result back -> call again) lives here since tool
    // execution is app-specific and shouldn't live inside the LLM client.
    let loopMessages: LlmChatMessage[] = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    let iterations = 1;
    let result = await llmChat({ system: SYSTEM, messages: loopMessages, tools: CHAT_TOOLS, maxTokens: 1024 });

    while (result.toolCalls.length > 0 && iterations < 5) {
      loopMessages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        const toolResult = await executeTool(call.name, call.arguments, req.user!);
        loopMessages.push({ role: 'tool', toolCallId: call.id, content: toolResult });
      }
      iterations++;
      result = await llmChat({ system: SYSTEM, messages: loopMessages, tools: CHAT_TOOLS, maxTokens: 1024 });
    }

    await recordAiUsage({
      tenantId, userId: req.user!.userId, feature: 'chat', trigger: 'user', outcome: 'completed',
      inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null,
    });
    res.json({ response: result.text, model: result.model, usage: result.usage });
  }),
);

// Platform audit finding 4.2: all four /documents/:id/... routes below had
// no ACL check, letting any DOCUMENT_READ holder read/queue AI processing
// for a document their folder ACL would otherwise hide — fixed to match
// documents.routes.ts's document:read gate on every other document route.

/** GET /ai/documents/:id/summary — return stored AI summary */
aiRoutes.get(
  '/documents/:id/summary',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const doc = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      attributes: ['id', 'aiSummary'],
    });
    if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');
    const aiSummary = (doc as any).aiSummary as string | null;
    // Distinguish *why* aiSummary is null instead of leaving the frontend to
    // show one undifferentiated blank state for three different real causes:
    // the tenant never opted into AI processing (most common — off by
    // default), a job simply hasn't run yet, or the last attempt failed.
    let status: 'ready' | 'disabled' | 'blocked' | 'pending' | 'failed' = 'ready';
    let blockedReason: string | null = null;
    if (!aiSummary) {
      const consented = await isEnabled(req.user!.tenantId, AI_CONSENT_FLAG);
      if (!consented) {
        status = 'disabled';
      } else {
        // The tenant's AI policy can refuse this particular document (too
        // confidential, blocked type/department, summaries switched off). Say
        // so, instead of leaving the card on "pending" for a job that the
        // worker will skip.
        const why = await explainAiBlock({
          tenantId: req.user!.tenantId, feature: 'summarize', documentId: String(req.params.id),
        });
        if (!why.allowed) {
          status = 'blocked';
          blockedReason = why.message ?? null;
        } else {
          // Cross-process check (Redis-backed) — AIWorker.ts runs in a
          // separate process from this API route, so an in-process registry
          // read here would never see the worker's own failures.
          const everFailed = await hasAiOperationEverFailed('AI_SUMMARIZE');
          status = everFailed ? 'failed' : 'pending';
        }
      }
    }
    res.json({ data: { aiSummary, status, blockedReason } });
  }),
);

/** GET /ai/documents/:id/suggestions — return AI metadata suggestions */
aiRoutes.get(
  '/documents/:id/suggestions',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const doc = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      attributes: ['id', 'aiSuggestedMetadata'],
    });
    if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');
    res.json({ data: { aiSuggestedMetadata: (doc as any).aiSuggestedMetadata } });
  }),
);

/** POST /ai/documents/:id/summarize — trigger on-demand AI summarization */
aiRoutes.post(
  '/documents/:id/summarize',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requirePermission(PERMISSIONS.AI_USE),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    await authorizeAiRequest({
      tenantId: req.user!.tenantId, userId: req.user!.userId, feature: 'summarize', documentId: String(req.params.id),
    });
    const doc = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');

    const redis = getRedis();
    if (!redis) throw new AppError(503, 'ERR-QUEUE-UNAVAILABLE', 'Queue not available');

    const aiQueue = new Queue('AI_PROCESSING', { connection: redis });
    attachErrorLogger(aiQueue, 'AI_PROCESSING');
    await aiQueue.add('summarize', {
      documentId: doc.id,
      tenantId: req.user!.tenantId,
      // Carried so AIWorker's terminal DOCUMENT.AI_COMPLETED event can be
      // routed to the person who asked for it. WEBSOCKET outbox rows route by
      // department room unless recipientUserIds names users explicitly, and
      // the requester is not necessarily in the document's department — the
      // one user certainly watching the AI card would have been the one user
      // the event missed.
      requestedByUserId: req.user!.userId,
      correlationId: getCorrelationId(),
      operation: 'AI_SUMMARIZE',
    });

    res.status(202).json({ queued: true, operation: 'AI_SUMMARIZE' });
  }),
);

/** POST /ai/documents/:id/extract — trigger on-demand metadata extraction */
aiRoutes.post(
  '/documents/:id/extract',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requirePermission(PERMISSIONS.AI_USE),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    await authorizeAiRequest({
      tenantId: req.user!.tenantId, userId: req.user!.userId, feature: 'extract', documentId: String(req.params.id),
    });
    const doc = await Document.findOne({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');

    const redis = getRedis();
    if (!redis) throw new AppError(503, 'ERR-QUEUE-UNAVAILABLE', 'Queue not available');

    const aiQueue = new Queue('AI_PROCESSING', { connection: redis });
    attachErrorLogger(aiQueue, 'AI_PROCESSING');
    await aiQueue.add('extract', {
      documentId: doc.id,
      tenantId: req.user!.tenantId,
      requestedByUserId: req.user!.userId,
      correlationId: getCorrelationId(),
      operation: 'AI_EXTRACT_METADATA',
    });

    res.status(202).json({ queued: true, operation: 'AI_EXTRACT_METADATA' });
  }),
);


// ─── AI controls ─────────────────────────────────────────────────────────────

/** GET /ai/status — can I use AI right now, and if not, why? (any signed-in user; the UI uses it to
 *  show a plain reason instead of a button that fails.) Does not debit the quota or write a usage row. */
aiRoutes.get(
  '/status',
  asyncHandler(async (req, res) => {
    const u = req.user!;
    const consented = await isEnabled(u.tenantId, AI_CONSENT_FLAG);
    const policy = await getAiPolicy(u.tenantId);
    res.json({
      data: {
        enabledForTenant: consented,
        canUse: u.permissions.includes(PERMISSIONS.AI_USE),
        canChat: u.permissions.includes(PERMISSIONS.AI_CHAT) && u.permissions.includes(PERMISSIONS.AUDIT_READ),
        canManage: u.permissions.includes(PERMISSIONS.AI_MANAGE),
        features: policy.features,
        autoProcessOnUpload: policy.autoProcessOnUpload,
        maxConfidentiality: policy.maxConfidentiality,
      },
    });
  }),
);

/** GET /ai/policy — the tenant's AI rules plus the master consent switch. */
aiRoutes.get(
  '/policy',
  requirePermission(PERMISSIONS.AI_MANAGE),
  asyncHandler(async (req, res) => {
    const tenantId = req.user!.tenantId;
    res.json({ data: { enabled: await isEnabled(tenantId, AI_CONSENT_FLAG), policy: await getAiPolicy(tenantId) } });
  }),
);

/** PUT /ai/policy — change any subset of the rules (validated, audited). */
aiRoutes.put(
  '/policy',
  requirePermission(PERMISSIONS.AI_MANAGE),
  asyncHandler(async (req, res) => {
    const tenantId = req.user!.tenantId;
    const policy = await setAiPolicy(tenantId, req.body, { userId: req.user!.userId, role: req.user!.role });
    res.json({ data: { enabled: await isEnabled(tenantId, AI_CONSENT_FLAG), policy } });
  }),
);

const usageQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7) });

/** GET /ai/usage — the usage ledger summarised by feature and user, plus recent decisions. */
aiRoutes.get(
  '/usage',
  requirePermission(PERMISSIONS.AI_MANAGE),
  asyncHandler(async (req, res) => {
    const { hours } = usageQuery.parse(req.query);
    res.json({ data: await getAiUsageSummary(req.user!.tenantId, req.user!.userId, hours) });
  }),
);
