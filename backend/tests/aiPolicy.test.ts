/**
 * AI usage controls: the pure rules and the policy resolution.
 * The database-touching parts (quota counting, the ledger) are exercised by
 * test-scripts against a live DB; what must never regress silently is the
 * decision logic itself, so that is what is pinned here.
 */

jest.mock('../src/infrastructure/database/index.js', () => ({
  Document: {}, Tenant: {}, sequelize: { query: jest.fn() },
}));
jest.mock('../src/modules/feature-flags/featureFlags.service.js', () => ({ isEnabled: jest.fn() }));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn() }));

import {
  DEFAULT_AI_POLICY,
  aiMayHandleDocument,
  aiPolicyPatchSchema,
  evaluateStaticRules,
  resolveAiPolicy,
  type AiDocumentFacts,
} from '../src/modules/ai/aiPolicy.service.js';

const DOC = (over: Partial<AiDocumentFacts> = {}): AiDocumentFacts => ({
  id: 'd1', securityClassification: 'INTERNAL', documentTypeId: null, departmentId: null, ...over,
});

describe('resolveAiPolicy', () => {
  it('gives the documented restrictive defaults for an empty row', () => {
    const p = resolveAiPolicy({});
    expect(p).toEqual(DEFAULT_AI_POLICY);
    expect(p.maxConfidentiality).toBe('INTERNAL');
  });

  it('layers a partial stored policy over the defaults, including nested features', () => {
    const p = resolveAiPolicy({ features: { chat: false }, userLimitPer24h: 5 });
    expect(p.features).toEqual({ chat: false, summarize: true, extract: true, form_extraction: true });
    expect(p.userLimitPer24h).toBe(5);
    expect(p.tenantLimitPer24h).toBe(DEFAULT_AI_POLICY.tenantLimitPer24h);
  });

  it('falls back to the restrictive defaults when the stored row is corrupt', () => {
    expect(resolveAiPolicy({ maxConfidentiality: 'TOP_SECRET' })).toEqual(DEFAULT_AI_POLICY);
    expect(resolveAiPolicy('garbage')).toEqual(DEFAULT_AI_POLICY);
    expect(resolveAiPolicy(null)).toEqual(DEFAULT_AI_POLICY);
  });
});

describe('aiPolicyPatchSchema', () => {
  it('rejects unknown keys and out-of-range numbers', () => {
    expect(aiPolicyPatchSchema.safeParse({ nope: true }).success).toBe(false);
    expect(aiPolicyPatchSchema.safeParse({ userLimitPer24h: 0 }).success).toBe(false);
    expect(aiPolicyPatchSchema.safeParse({ blockedDepartmentIds: ['not-a-uuid'] }).success).toBe(false);
  });
  it('accepts null as "no limit"', () => {
    expect(aiPolicyPatchSchema.safeParse({ userLimitPer24h: null, tenantLimitPer24h: null }).success).toBe(true);
  });
});

describe('evaluateStaticRules', () => {
  const rules = (policy = DEFAULT_AI_POLICY, over: Partial<Parameters<typeof evaluateStaticRules>[1]> = {}) =>
    evaluateStaticRules(policy, { feature: 'summarize', trigger: 'user', document: DOC(), ...over });

  it('allows an INTERNAL document under the default policy', () => {
    expect(rules().allowed).toBe(true);
  });

  it('refuses a feature the tenant switched off', () => {
    const p = resolveAiPolicy({ features: { summarize: false } });
    expect(rules(p)).toMatchObject({ allowed: false, code: 'ERR-AI-FEATURE-OFF' });
    expect(rules(p, { feature: 'extract' }).allowed).toBe(true);
  });

  it('keeps CONFIDENTIAL and RESTRICTED documents away from AI by default', () => {
    expect(rules(DEFAULT_AI_POLICY, { document: DOC({ securityClassification: 'CONFIDENTIAL' }) }))
      .toMatchObject({ allowed: false, code: 'ERR-AI-CLASSIFICATION' });
    expect(rules(DEFAULT_AI_POLICY, { document: DOC({ securityClassification: 'RESTRICTED' }) }).allowed).toBe(false);
  });

  it('lets an administrator raise the ceiling, and lowering it excludes INTERNAL', () => {
    const raised = resolveAiPolicy({ maxConfidentiality: 'CONFIDENTIAL' });
    expect(rules(raised, { document: DOC({ securityClassification: 'CONFIDENTIAL' }) }).allowed).toBe(true);
    expect(rules(raised, { document: DOC({ securityClassification: 'RESTRICTED' }) }).allowed).toBe(false);
    const lowered = resolveAiPolicy({ maxConfidentiality: 'PUBLIC' });
    expect(rules(lowered).allowed).toBe(false);
  });

  it('treats an unknown or missing classification as the most confidential (fail closed)', () => {
    expect(rules(DEFAULT_AI_POLICY, { document: DOC({ securityClassification: null }) }).allowed).toBe(false);
    expect(rules(DEFAULT_AI_POLICY, { document: DOC({ securityClassification: 'WEIRD' }) }).allowed).toBe(false);
  });

  it('blocks listed document types and departments', () => {
    const t = '11111111-1111-4111-8111-111111111111';
    const d = '22222222-2222-4222-8222-222222222222';
    const p = resolveAiPolicy({ blockedDocumentTypeIds: [t], blockedDepartmentIds: [d] });
    expect(rules(p, { document: DOC({ documentTypeId: t }) })).toMatchObject({ code: 'ERR-AI-DOCTYPE-BLOCKED' });
    expect(rules(p, { document: DOC({ departmentId: d }) })).toMatchObject({ code: 'ERR-AI-DEPARTMENT-BLOCKED' });
    expect(rules(p, { document: DOC({ departmentId: '33333333-3333-4333-8333-333333333333' }) }).allowed).toBe(true);
  });

  it('only the upload pipeline is affected by the auto-process switch', () => {
    const p = resolveAiPolicy({ autoProcessOnUpload: false });
    expect(rules(p, { trigger: 'auto' })).toMatchObject({ allowed: false, code: 'ERR-AI-AUTO-OFF' });
    expect(rules(p, { trigger: 'user' }).allowed).toBe(true);
  });

  it('a request with no document (chat) is not subject to the content rules', () => {
    expect(rules(DEFAULT_AI_POLICY, { feature: 'chat', document: null }).allowed).toBe(true);
  });
});

describe('aiMayHandleDocument (what the compliance chat tools may describe to the model)', () => {
  const policy = (over = {}) => ({ ...DEFAULT_AI_POLICY, features: { ...DEFAULT_AI_POLICY.features, chat: true }, ...over });
  it('describes an INTERNAL document under the defaults', () => {
    expect(aiMayHandleDocument(policy(), { id: 'd', securityClassification: 'INTERNAL' })).toBe(true);
  });
  it('withholds CONFIDENTIAL and RESTRICTED documents by default, and a missing class (fail closed)', () => {
    expect(aiMayHandleDocument(policy(), { securityClassification: 'CONFIDENTIAL' })).toBe(false);
    expect(aiMayHandleDocument(policy(), { securityClassification: 'RESTRICTED' })).toBe(false);
    expect(aiMayHandleDocument(policy(), {})).toBe(false);
  });
  it('honours blocked document types and departments', () => {
    const p = policy({ blockedDocumentTypeIds: ['type-x'], blockedDepartmentIds: ['dept-y'] });
    expect(aiMayHandleDocument(p, { securityClassification: 'PUBLIC', documentTypeId: 'type-x' })).toBe(false);
    expect(aiMayHandleDocument(p, { securityClassification: 'PUBLIC', departmentId: 'dept-y' })).toBe(false);
    expect(aiMayHandleDocument(p, { securityClassification: 'PUBLIC', documentTypeId: 'other', departmentId: 'other' })).toBe(true);
  });
  it('is closed entirely when the chat feature is switched off', () => {
    const off = policy({ features: { ...DEFAULT_AI_POLICY.features, chat: false } });
    expect(aiMayHandleDocument(off, { securityClassification: 'PUBLIC' })).toBe(false);
  });
  it('a raised ceiling opens CONFIDENTIAL but still never RESTRICTED above it', () => {
    const p = policy({ maxConfidentiality: 'CONFIDENTIAL' });
    expect(aiMayHandleDocument(p, { securityClassification: 'CONFIDENTIAL' })).toBe(true);
    expect(aiMayHandleDocument(p, { securityClassification: 'RESTRICTED' })).toBe(false);
  });
});
