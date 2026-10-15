/**
 * The live department boundary on document:read must stop a user who LEFT the
 * department (their creation-time snapshot row is still in acl_entries) but must
 * NOT swallow a deliberate per-user grant — approval participants, auditors,
 * signatories and Access Control Center grants all reach people outside the
 * document's department by design (verify-approval-participant-access.ts).
 * Before migration 20261004000010 the two were indistinguishable and the
 * boundary denied both.
 */
const mockAclEntries = { findAll: jest.fn() };
const mockDocuments = { findAll: jest.fn(), findByPk: jest.fn() };
const mockQuery = jest.fn();

jest.mock('../src/infrastructure/database/models/index.js', () => ({
  AclEntry: mockAclEntries,
  AccessRule: { findAll: jest.fn().mockResolvedValue([]) },
  Department: {},
  Document: mockDocuments,
  DocumentBundle: { findAll: jest.fn().mockResolvedValue([]) },
  DocumentBundleItem: { findAll: jest.fn().mockResolvedValue([]) },
  FolderNode: { findByPk: jest.fn() },
}));
jest.mock('../src/infrastructure/database/sequelize.js', () => ({ sequelize: { query: mockQuery } }));
jest.mock('../src/infrastructure/cache/aclCache.js', () => ({
  getCachedResolution: jest.fn().mockResolvedValue(null),
  cacheResolution: jest.fn().mockResolvedValue(undefined),
  getCachedResolutionsBatch: jest.fn().mockResolvedValue(new Map()),
}));
const mockUserDepts = jest.fn();
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({
  getCachedUserDepartments: (...a: unknown[]) => mockUserDepts(...a),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));

import { resolveACL, resolveACLBatch } from '../src/shared/resolveACL.js';

const tenantId = 'tenant-1';
const docId = '00000000-0000-4000-8000-0000000000d1';
const deptId = '00000000-0000-4000-8000-0000000000e1';
const userId = 'user-outsider';

function readRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    resourceType: 'document',
    resourceId: docId,
    principalType: 'user',
    principalId: userId,
    effect: 'ALLOW',
    permission: 'document:read',
    expiresAt: null,
    origin: null,
    ...overrides,
  };
}

const opts = {
  resourceType: 'document' as const,
  resourceId: docId,
  permission: 'document:read',
  userId,
  userRole: 'EMPLOYEE',
  userRoles: ['EMPLOYEE'],
  userPermissions: ['document:read'],
  tenantId,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDepts.mockResolvedValue([]); // the user belongs to no department
  mockDocuments.findByPk.mockResolvedValue({ folderId: null, departmentId: deptId, tenantId, ownerId: 'someone-else' });
  mockDocuments.findAll.mockResolvedValue([
    { id: docId, folderId: null, departmentId: deptId, documentTypeId: null, ownerId: 'someone-else' },
  ]);
  // getAncestorsForResource (department walk) and getAncestorsBatch
  mockQuery.mockImplementation(async (sql: string) =>
    /root_id/.test(sql) ? [{ root_id: deptId, id: deptId, depth: 1 }] : [{ id: deptId }],
  );
});

describe('resolveACL outside the department', () => {
  it('denies a user whose only row is a department snapshot (they left the department)', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow({ origin: 'DEPT_SNAPSHOT' })]);
    const result = await resolveACL(opts);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside the active department scope/);
  });

  it('allows a deliberate per-user grant (approval participant / auditor / ACL center) outside the department', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow()]);
    const result = await resolveACL(opts);
    expect(result.allowed).toBe(true);
    expect(result.reason).toMatch(/Direct user ALLOW/);
  });

  it('does not honour an expired deliberate grant', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow({ expiresAt: new Date(Date.now() - 60_000) })]);
    const result = await resolveACL(opts);
    expect(result.allowed).toBe(false);
  });

  it('still lets an explicit DENY win over a deliberate grant', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow(), readRow({ effect: 'DENY' })]);
    const result = await resolveACL(opts);
    expect(result.allowed).toBe(false);
    expect(result.effect).toBe('DENY');
  });

  it('allows a current department member holding the snapshot row', async () => {
    mockUserDepts.mockResolvedValue([deptId]);
    mockAclEntries.findAll.mockResolvedValue([readRow({ origin: 'DEPT_SNAPSHOT' })]);
    const result = await resolveACL(opts);
    expect(result.allowed).toBe(true);
  });
});

describe('resolveACLBatch outside the department', () => {
  const batchOpts = { permission: 'document:read', userId, userRole: 'EMPLOYEE', userRoles: ['EMPLOYEE'], userPermissions: ['document:read'], tenantId };

  it('denies a snapshot-only user (list/detail parity with resolveACL)', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow({ origin: 'DEPT_SNAPSHOT' })]);
    const out = await resolveACLBatch([docId], batchOpts);
    expect(out.get(docId)?.allowed).toBe(false);
  });

  it('allows a deliberate grant (list/detail parity with resolveACL)', async () => {
    mockAclEntries.findAll.mockResolvedValue([readRow()]);
    const out = await resolveACLBatch([docId], batchOpts);
    expect(out.get(docId)?.allowed).toBe(true);
  });
});
