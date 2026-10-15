/**
 * AI usage controls — the one place that decides whether an AI request may run.
 *
 * Every path that can send tenant content to the external AI provider calls
 * `authorizeAiRequest()` first: the compliance chat, per-document summary and
 * metadata extraction (on demand AND the upload pipeline), and form-from-photo.
 * The decision is made from four layers, cheapest first, and the first "no" wins:
 *
 *   1. consent      the tenant's master `ai_processing` flag (off by default)
 *   2. feature      this feature switched off in the tenant's policy
 *   3. content      the document is too confidential, or its type/department is
 *                   blocked, for any of its text to leave the building
 *   4. quota        the user or the tenant has used its rolling-24h allowance
 *
 * Who may ask at all (ai:use / ai:chat) is the RBAC layer and is checked by the
 * routes before this runs; per-user grants and revokes work through the normal
 * permission overrides, so no AI-specific per-user store exists.
 *
 * Every decision, allowed or refused, is written to `ai_usage_events`. Only
 * `allowed` rows count against a quota, so a refused request never uses one up.
 */
import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import { Document, Tenant, sequelize } from '../../infrastructure/database/index.js';
import { isEnabled } from '../feature-flags/featureFlags.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';

/** The master consent switch (tenants.feature_flags). Same name AIWorker has always used. */
export const AI_CONSENT_FLAG = 'ai_processing';

export const CONFIDENTIALITY_ORDER = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_ORDER)[number];

export const AI_FEATURES = ['chat', 'summarize', 'extract', 'form_extraction'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export type AiTrigger = 'user' | 'auto';

const featureSwitches = z.object({
  chat: z.boolean(),
  summarize: z.boolean(),
  extract: z.boolean(),
  form_extraction: z.boolean(),
}).strict();

export const aiPolicySchema = z.object({
  features: featureSwitches,
  /** Summarise / extract automatically when a document finishes OCR. */
  autoProcessOnUpload: z.boolean(),
  /** The most confidential class whose text may be sent. Anything above never is. */
  maxConfidentiality: z.enum(CONFIDENTIALITY_ORDER),
  blockedDocumentTypeIds: z.array(z.string().uuid()).max(200),
  blockedDepartmentIds: z.array(z.string().uuid()).max(200),
  /** Requests one user may make in any rolling 24 hours. null = no limit. */
  userLimitPer24h: z.number().int().min(1).max(100_000).nullable(),
  /** Requests the whole tenant may make in any rolling 24 hours. null = no limit. */
  tenantLimitPer24h: z.number().int().min(1).max(1_000_000).nullable(),
}).strict();

export type AiPolicy = z.infer<typeof aiPolicySchema>;

/** What a tenant that never opened the AI Controls screen gets. */
export const DEFAULT_AI_POLICY: AiPolicy = {
  features: { chat: true, summarize: true, extract: true, form_extraction: true },
  autoProcessOnUpload: true,
  maxConfidentiality: 'INTERNAL',
  blockedDocumentTypeIds: [],
  blockedDepartmentIds: [],
  userLimitPer24h: 100,
  tenantLimitPer24h: 2000,
};

export const aiPolicyPatchSchema = z.object({
  features: featureSwitches.partial().optional(),
  autoProcessOnUpload: z.boolean().optional(),
  maxConfidentiality: z.enum(CONFIDENTIALITY_ORDER).optional(),
  blockedDocumentTypeIds: z.array(z.string().uuid()).max(200).optional(),
  blockedDepartmentIds: z.array(z.string().uuid()).max(200).optional(),
  userLimitPer24h: z.number().int().min(1).max(100_000).nullable().optional(),
  tenantLimitPer24h: z.number().int().min(1).max(1_000_000).nullable().optional(),
}).strict();

/** Layer the stored (possibly partial, possibly stale) JSON over the defaults. */
export function resolveAiPolicy(stored: unknown): AiPolicy {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const merged = {
    ...DEFAULT_AI_POLICY,
    ...raw,
    features: { ...DEFAULT_AI_POLICY.features, ...((raw.features as object | undefined) ?? {}) },
  };
  const parsed = aiPolicySchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // A hand-edited row must fail CLOSED on the dimension that is broken, not
  // silently open: fall back to the defaults, which are the restrictive ones.
  logger.warn({ issues: parsed.error.issues }, 'stored ai_policy is invalid; using defaults');
  return DEFAULT_AI_POLICY;
}

export async function getAiPolicy(tenantId: string): Promise<AiPolicy> {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'aiPolicy'] });
  if (!tenant) throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');
  return resolveAiPolicy(tenant.aiPolicy);
}

export async function setAiPolicy(
  tenantId: string,
  patchInput: unknown,
  actor: { userId: string; role: string },
): Promise<AiPolicy> {
  const patch = aiPolicyPatchSchema.parse(patchInput);
  const current = await getAiPolicy(tenantId);
  const next = aiPolicySchema.parse({
    ...current,
    ...patch,
    features: { ...current.features, ...(patch.features ?? {}) },
  });
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');
  await tenant.update({ aiPolicy: next as unknown as Record<string, unknown> });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.AI_POLICY_UPDATED,
    userId: actor.userId,
    userRole: actor.role,
    tenantId,
    actionDetails: { before: current, after: next },
  });
  return next;
}

export interface AiDocumentFacts {
  id: string;
  securityClassification: string | null;
  documentTypeId: string | null;
  departmentId: string | null;
}

export async function loadAiDocumentFacts(tenantId: string, documentId: string): Promise<AiDocumentFacts | null> {
  const doc = await Document.findOne({
    where: { id: documentId, tenantId },
    attributes: ['id', 'securityClassification', 'documentTypeId', 'departmentId'],
    raw: true,
  });
  return (doc as AiDocumentFacts | null) ?? null;
}

export interface AiDecision {
  allowed: boolean;
  code?: string;
  message?: string;
}

function rank(c: string | null | undefined): number {
  const i = CONFIDENTIALITY_ORDER.indexOf((c ?? '') as Confidentiality);
  // An unknown/missing class is treated as the MOST confidential: fail closed.
  return i === -1 ? CONFIDENTIALITY_ORDER.length - 1 : i;
}

/** Pure content/feature rules — no I/O, so they are unit-testable. */
export function evaluateStaticRules(
  policy: AiPolicy,
  req: { feature: AiFeature; trigger: AiTrigger; document?: AiDocumentFacts | null },
): AiDecision {
  if (!policy.features[req.feature]) {
    return { allowed: false, code: 'ERR-AI-FEATURE-OFF', message: `The "${req.feature.replace('_', ' ')}" AI feature is turned off for this organisation.` };
  }
  if (req.trigger === 'auto' && !policy.autoProcessOnUpload) {
    return { allowed: false, code: 'ERR-AI-AUTO-OFF', message: 'Automatic AI processing of uploads is turned off for this organisation.' };
  }
  const doc = req.document;
  if (doc) {
    if (rank(doc.securityClassification) > rank(policy.maxConfidentiality)) {
      return { allowed: false, code: 'ERR-AI-CLASSIFICATION', message: `This document is classified ${doc.securityClassification ?? 'UNKNOWN'}, above the highest class (${policy.maxConfidentiality}) allowed to be sent to AI.` };
    }
    if (doc.documentTypeId && policy.blockedDocumentTypeIds.includes(doc.documentTypeId)) {
      return { allowed: false, code: 'ERR-AI-DOCTYPE-BLOCKED', message: 'AI processing is blocked for this document type.' };
    }
    if (doc.departmentId && policy.blockedDepartmentIds.includes(doc.departmentId)) {
      return { allowed: false, code: 'ERR-AI-DEPARTMENT-BLOCKED', message: 'AI processing is blocked for this department.' };
    }
  }
  return { allowed: true };
}

/** What a chat tool needs to know about a document before it describes it to the model. */
export type ChatPolicyFacts = { id?: string; securityClassification?: string | null; documentTypeId?: string | null; departmentId?: string | null };

/**
 * May the compliance chat hand this document (its classification, metadata, history) to the model? Same ceiling and blocked
 * lists as summaries and suggestions; a missing classification counts as the most confidential (fail closed).
 */
export function aiMayHandleDocument(policy: AiPolicy, doc: ChatPolicyFacts): boolean {
  return evaluateStaticRules(policy, {
    feature: 'chat',
    trigger: 'user',
    document: {
      id: doc.id ?? '',
      securityClassification: doc.securityClassification ?? null,
      documentTypeId: doc.documentTypeId ?? null,
      departmentId: doc.departmentId ?? null,
    },
  }).allowed;
}

export interface AiUsageRecord {
  tenantId: string;
  userId?: string | null;
  feature: AiFeature;
  trigger: AiTrigger;
  documentId?: string | null;
  outcome: string;
  reason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export async function recordAiUsage(r: AiUsageRecord): Promise<void> {
  try {
    await sequelize.query(
      `INSERT INTO ai_usage_events
         (tenant_id, user_id, feature, trigger, document_id, outcome, reason, input_tokens, output_tokens)
       VALUES (:tenantId, :userId, :feature, :trigger, :documentId, :outcome, :reason, :inputTokens, :outputTokens)`,
      {
        replacements: {
          tenantId: r.tenantId,
          userId: r.userId ?? null,
          feature: r.feature,
          trigger: r.trigger,
          documentId: r.documentId ?? null,
          outcome: r.outcome,
          reason: r.reason ?? null,
          inputTokens: r.inputTokens ?? null,
          outputTokens: r.outputTokens ?? null,
        },
        type: QueryTypes.INSERT,
      },
    );
  } catch (err) {
    // The meter must never take the feature down with it.
    logger.error({ err, tenantId: r.tenantId, feature: r.feature }, 'failed to record ai usage event');
  }
}

async function countAllowedLast24h(tenantId: string, userId?: string | null): Promise<number> {
  const rows = await sequelize.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_usage_events
      WHERE tenant_id = :tenantId AND outcome = 'allowed'
        AND created_at > now() - interval '24 hours'
        ${userId ? 'AND user_id = :userId' : ''}`,
    { replacements: { tenantId, userId: userId ?? null }, type: QueryTypes.SELECT },
  );
  return Number(rows[0]?.n ?? 0);
}

export interface AuthorizeAiRequest {
  tenantId: string;
  userId?: string | null;
  feature: AiFeature;
  trigger?: AiTrigger;
  /** Pass the document (or its id) whenever the request will send its content. */
  document?: AiDocumentFacts | null;
  documentId?: string | null;
  /**
   * 'debit' (default): full decision, and an `allowed` row that counts against
   * the quota. 'verify': the consent, feature and content rules only, with no
   * quota check and no debit — for the worker re-checking a job the route
   * already counted, so one user request is never charged twice. Refusals are
   * still recorded in both modes.
   */
  mode?: 'debit' | 'verify';
}

/**
 * Decide, record, and either return or throw. Throws AppError 403 with a code the
 * UI maps to a plain message. On success an `allowed` event is already written
 * (that is the quota debit); call `recordAiUsage` later with `completed` and the
 * token counts when they are known.
 */
export async function authorizeAiRequest(req: AuthorizeAiRequest): Promise<AiPolicy> {
  const trigger = req.trigger ?? 'user';
  const deny = async (code: string, message: string, documentId?: string | null): Promise<never> => {
    await recordAiUsage({
      tenantId: req.tenantId, userId: req.userId, feature: req.feature, trigger,
      documentId: documentId ?? req.documentId ?? null,
      outcome: `denied_${code.replace('ERR-AI-', '').toLowerCase().replace(/-/g, '_')}`,
      reason: message,
    });
    throw new AppError(403, code, message);
  };

  if (!(await isEnabled(req.tenantId, AI_CONSENT_FLAG))) {
    return deny(
      'ERR-AI-NOT-ENABLED',
      'AI processing is not enabled for this tenant. A tenant admin must enable the "ai_processing" feature flag first.',
    );
  }

  const policy = await getAiPolicy(req.tenantId);

  let document = req.document ?? null;
  if (!document && req.documentId) {
    document = await loadAiDocumentFacts(req.tenantId, req.documentId);
    // A document that cannot be loaded cannot be classified: refuse rather than guess.
    if (!document) return deny('ERR-AI-DOCUMENT-UNKNOWN', 'The document could not be found, so it cannot be checked against the AI policy.');
  }

  const rules = evaluateStaticRules(policy, { feature: req.feature, trigger, document });
  if (!rules.allowed) return deny(rules.code!, rules.message!, document?.id);

  if (req.mode === 'verify') return policy;

  if (policy.userLimitPer24h !== null && req.userId) {
    const used = await countAllowedLast24h(req.tenantId, req.userId);
    if (used >= policy.userLimitPer24h) {
      return deny('ERR-AI-USER-LIMIT', `You have used your ${policy.userLimitPer24h} AI requests for the last 24 hours. Try again later.`, document?.id);
    }
  }
  if (policy.tenantLimitPer24h !== null) {
    const used = await countAllowedLast24h(req.tenantId);
    if (used >= policy.tenantLimitPer24h) {
      return deny('ERR-AI-TENANT-LIMIT', 'This organisation has used its AI allowance for the last 24 hours. Try again later or ask an administrator to raise it.', document?.id);
    }
  }

  await recordAiUsage({
    tenantId: req.tenantId, userId: req.userId, feature: req.feature, trigger,
    documentId: document?.id ?? req.documentId ?? null, outcome: 'allowed',
  });
  return policy;
}

/**
 * Read-only "would this be refused, and why?" for UI hints (the AI card on a
 * document). Evaluates consent, feature and content rules only: it writes
 * nothing to the usage ledger (a card polls) and ignores quotas (those are
 * about the moment of asking, not about the document).
 */
export async function explainAiBlock(req: {
  tenantId: string;
  feature: AiFeature;
  documentId: string;
  trigger?: AiTrigger;
}): Promise<AiDecision> {
  if (!(await isEnabled(req.tenantId, AI_CONSENT_FLAG))) {
    return { allowed: false, code: 'ERR-AI-NOT-ENABLED', message: 'AI processing is not enabled for this tenant.' };
  }
  const policy = await getAiPolicy(req.tenantId);
  const document = await loadAiDocumentFacts(req.tenantId, req.documentId);
  if (!document) return { allowed: false, code: 'ERR-AI-DOCUMENT-UNKNOWN', message: 'The document could not be found.' };
  return evaluateStaticRules(policy, { feature: req.feature, trigger: req.trigger ?? 'user', document });
}

/** Non-throwing variant for places that want to skip quietly (workers, status hints). */
export async function checkAiRequest(req: AuthorizeAiRequest): Promise<AiDecision> {
  try {
    await authorizeAiRequest(req);
    return { allowed: true };
  } catch (err) {
    if (err instanceof AppError) return { allowed: false, code: err.code, message: err.message };
    throw err;
  }
}

export interface AiUsageSummary {
  windowHours: number;
  totals: { allowed: number; denied: number; completed: number; failed: number; inputTokens: number; outputTokens: number };
  byFeature: Array<{ feature: string; allowed: number; denied: number }>;
  byUser: Array<{ userId: string | null; email: string | null; name: string | null; allowed: number; denied: number; inputTokens: number; outputTokens: number }>;
  recent: Array<{ id: string; createdAt: string; userId: string | null; email: string | null; feature: string; trigger: string; documentId: string | null; outcome: string; reason: string | null }>;
  yourUsage: { allowedLast24h: number; limit: number | null };
  tenantUsage: { allowedLast24h: number; limit: number | null };
}

export async function getAiUsageSummary(tenantId: string, viewerUserId: string, windowHours = 24 * 7): Promise<AiUsageSummary> {
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 24 * 90);
  const policy = await getAiPolicy(tenantId);
  const repl = { tenantId, hours: String(hours) };
  const where = `e.tenant_id = :tenantId AND e.created_at > now() - (:hours || ' hours')::interval`;

  const [totals] = await sequelize.query<AiUsageSummary['totals']>(
    `SELECT count(*) FILTER (WHERE outcome='allowed')::int AS allowed,
            count(*) FILTER (WHERE outcome LIKE 'denied%')::int AS denied,
            count(*) FILTER (WHERE outcome='completed')::int AS completed,
            count(*) FILTER (WHERE outcome='failed')::int AS failed,
            coalesce(sum(input_tokens),0)::int AS "inputTokens",
            coalesce(sum(output_tokens),0)::int AS "outputTokens"
       FROM ai_usage_events e WHERE ${where}`,
    { replacements: repl, type: QueryTypes.SELECT },
  );
  const byFeature = await sequelize.query<AiUsageSummary['byFeature'][number]>(
    `SELECT feature, count(*) FILTER (WHERE outcome='allowed')::int AS allowed,
            count(*) FILTER (WHERE outcome LIKE 'denied%')::int AS denied
       FROM ai_usage_events e WHERE ${where} GROUP BY feature ORDER BY feature`,
    { replacements: repl, type: QueryTypes.SELECT },
  );
  const byUser = await sequelize.query<AiUsageSummary['byUser'][number]>(
    `SELECT e.user_id AS "userId", u.email,
            nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name,
            count(*) FILTER (WHERE e.outcome='allowed')::int AS allowed,
            count(*) FILTER (WHERE e.outcome LIKE 'denied%')::int AS denied,
            coalesce(sum(e.input_tokens),0)::int AS "inputTokens",
            coalesce(sum(e.output_tokens),0)::int AS "outputTokens"
       FROM ai_usage_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where} GROUP BY e.user_id, u.email, u.first_name, u.last_name
      ORDER BY allowed DESC, denied DESC LIMIT 50`,
    { replacements: repl, type: QueryTypes.SELECT },
  );
  const recent = await sequelize.query<AiUsageSummary['recent'][number]>(
    `SELECT e.id, e.created_at AS "createdAt", e.user_id AS "userId", u.email, e.feature, e.trigger,
            e.document_id AS "documentId", e.outcome, e.reason
       FROM ai_usage_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where} ORDER BY e.created_at DESC LIMIT 100`,
    { replacements: repl, type: QueryTypes.SELECT },
  );
  const yourUsed = await countAllowedLast24h(tenantId, viewerUserId);
  const tenantUsed = await countAllowedLast24h(tenantId);
  return {
    windowHours: hours,
    totals: totals ?? { allowed: 0, denied: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
    byFeature,
    byUser,
    recent,
    yourUsage: { allowedLast24h: yourUsed, limit: policy.userLimitPer24h },
    tenantUsage: { allowedLast24h: tenantUsed, limit: policy.tenantLimitPer24h },
  };
}
