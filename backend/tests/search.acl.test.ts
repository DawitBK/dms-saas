// Search result visibility: what comes back is only what the caller may read,
// including the Restricted-label rule and the facet counts.

const mockDocument = { findAll: jest.fn() };
const mockDepartment = { findAll: jest.fn() };
const mockSearch = jest.fn();

jest.mock('../src/infrastructure/database/index.js', () => ({
  Department: mockDepartment,
  Document: mockDocument,
  DocumentMetadata: {},
  DocumentType: {},
  SavedSearch: {},
}));
jest.mock('../src/infrastructure/search/meilisearch.js', () => ({
  meili: { index: () => ({ search: (...a: unknown[]) => mockSearch(...a) }) },
}));
const mockResolveACL = jest.fn();
jest.mock('../src/shared/resolveACL.js', () => ({ resolveACL: (...a: unknown[]) => mockResolveACL(...a) }));
jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { ROLE_PERMISSIONS } from '../src/config/permissions.js';

let searchDocuments: typeof import('../src/modules/search/search.service.js').searchDocuments;
beforeAll(async () => {
  ({ searchDocuments } = await import('../src/modules/search/search.service.js'));
});

const employee = { userId: 'u1', role: 'EMPLOYEE', roles: ['EMPLOYEE'], tenantId: 't1', permissions: ROLE_PERMISSIONS.EMPLOYEE as string[] };
const executive = { userId: 'x1', role: 'EXECUTIVE', roles: ['EXECUTIVE'], tenantId: 't1', permissions: ROLE_PERMISSIONS.EXECUTIVE as string[] };
const sysAdmin = { userId: 'a1', role: 'SYSTEM_ADMIN', roles: ['SYSTEM_ADMIN'], tenantId: 't1', permissions: ROLE_PERMISSIONS.SYSTEM_ADMIN as string[] };

const hit = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, departmentId: 'd1', documentTypeCode: 'GEN', status: 'ACTIVE',
  securityClassification: 'INTERNAL', sensitivityLabel: 'Internal', retentionClass: 'R', ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('search — ACL filtering of hits', () => {
  it('drops hits the caller cannot read (Meilisearch path)', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('a'), hit('b')] });
    mockResolveACL.mockImplementation(async ({ resourceId }: { resourceId: string }) => ({ allowed: resourceId === 'a', principalType: 'user', effect: 'ALLOW' }));
    const result = await searchDocuments(employee, 'contract');
    expect(result.hits.map((h: { id: string }) => h.id)).toEqual(['a']);
    expect(result.totalHits).toBe(1);
  });

  it('a Restricted-label document (stored title-case) needs a user-specific ALLOW to appear', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('r1', { sensitivityLabel: 'Restricted' })] });
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'role', effect: 'ALLOW', principalId: 'EMPLOYEE' });
    expect((await searchDocuments(employee, 'x')).hits).toEqual([]);
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'user', effect: 'ALLOW', principalId: 'u1' });
    expect((await searchDocuments(employee, 'x')).hits.map((h: { id: string }) => h.id)).toEqual(['r1']);
  });

  it('...and so does one classified RESTRICTED while its label says Internal', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('r2', { securityClassification: 'RESTRICTED' })] });
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'role', effect: 'ALLOW' });
    expect((await searchDocuments(employee, 'x')).hits).toEqual([]);
  });

  it('an ordinary Internal document is not affected by the Restricted rule', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('i1')] });
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'role', effect: 'ALLOW' });
    expect((await searchDocuments(employee, 'x')).hits.map((h: { id: string }) => h.id)).toEqual(['i1']);
  });

  it('an oversight role with tenant-wide read (Executive) finds Restricted documents; an explicit DENY still wins', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('r4', { sensitivityLabel: 'Restricted' })] });
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'role', effect: 'ALLOW', principalId: 'EXECUTIVE' });
    expect((await searchDocuments(executive, 'x')).hits.map((h: { id: string }) => h.id)).toEqual(['r4']);
    mockResolveACL.mockResolvedValue({ allowed: false, principalType: 'user', effect: 'DENY', principalId: 'x1' });
    expect((await searchDocuments(executive, 'x')).hits).toEqual([]);
  });

  it('ACL_BYPASS_ADMIN sees Restricted documents too (unchanged)', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('r3', { sensitivityLabel: 'Restricted' })] });
    expect((await searchDocuments(sysAdmin, 'x')).hits.map((h: { id: string }) => h.id)).toEqual(['r3']);
    expect(mockResolveACL).not.toHaveBeenCalled();
  });
});

describe('search — facet counts do not disclose documents the caller cannot read', () => {
  it('rebuilds facetDistribution from the permitted hits, ignoring the index-wide counts', async () => {
    mockSearch.mockResolvedValue({
      hits: [hit('a', { departmentId: 'd1' }), hit('b', { departmentId: 'd2' }), hit('c', { departmentId: 'd2' })],
      facetDistribution: { departmentId: { d1: 1, d2: 2, 'secret-dept': 40 }, status: { ACTIVE: 43 } },
    });
    mockResolveACL.mockImplementation(async ({ resourceId }: { resourceId: string }) => ({ allowed: resourceId !== 'c', principalType: 'user', effect: 'ALLOW' }));
    const result = (await searchDocuments(employee, 'x', { facets: true })) as { facetDistribution?: unknown };
    expect(result.facetDistribution).toEqual({
      departmentId: { d1: 1, d2: 1 },
      documentTypeCode: { GEN: 2 },
      status: { ACTIVE: 2 },
      securityClassification: { INTERNAL: 2 },
      retentionClass: { R: 2 },
    });
    expect(JSON.stringify(result.facetDistribution)).not.toContain('secret-dept');
  });

  it('returns no facets when none were requested', async () => {
    mockSearch.mockResolvedValue({ hits: [hit('a')], facetDistribution: { status: { ACTIVE: 99 } } });
    mockResolveACL.mockResolvedValue({ allowed: true, principalType: 'user', effect: 'ALLOW' });
    expect(((await searchDocuments(employee, 'x')) as { facetDistribution?: unknown }).facetDistribution).toBeUndefined();
  });
});

describe('search — filter values cannot break out of their quotes', () => {
  it('quotes caller-supplied filter values as escaped literals', async () => {
    mockSearch.mockResolvedValue({ hits: [] });
    await searchDocuments(employee, 'x', { documentTypeCode: 'A" OR status != "Z', status: 'ACTIVE' });
    const { filter } = mockSearch.mock.calls[0][1];
    expect(filter).toContain('documentTypeCode = "A\\" OR status != \\"Z"');
    expect(filter).toContain('status = "ACTIVE"');
  });
});
