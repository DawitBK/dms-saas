/**
 * A department snapshot row (written automatically at upload) is an inherited default, not a decision about
 * one document, so a DENY set on the folder or department above must still close it. A deliberate per-user
 * grant keeps its old rank (the more specific rule wins). Before 2026-10-09 the snapshot row was found first
 * and a folder DENY could not close a department's documents.
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
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue(['dept-1']),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue(['dept-1']),
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));

import { resolveACL } from '../src/shared/resolveACL.js';

const tenantId = 'tenant-1';
const docId = '00000000-0000-4000-8000-0000000000d1';
const folderId = '00000000-0000-4000-8000-0000000000f1';
const userId = 'member-1';

const row = (over: Record<string, unknown>) => ({
  tenantId, resourceType: 'document', resourceId: docId, principalType: 'user', principalId: userId,
  effect: 'ALLOW', permission: 'document:read', expiresAt: null, origin: null, ...over,
});
const folderDeny = row({ resourceType: 'folder', resourceId: folderId, effect: 'DENY' });

const opts = {
  resourceType: 'document' as const, resourceId: docId, permission: 'document:read', userId,
  userRole: 'EMPLOYEE', userRoles: ['EMPLOYEE'], userPermissions: ['document:read'], tenantId,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDocuments.findByPk.mockResolvedValue({ folderId, departmentId: 'dept-1', tenantId, ownerId: 'someone-else' });
  mockQuery.mockImplementation(async (sql: string) => (/folder_nodes/.test(sql) ? [{ id: folderId }] : [{ id: 'dept-1' }]));
});

describe('department snapshot vs a DENY on the folder above', () => {
  it('a folder DENY closes a document whose only access is the department snapshot', async () => {
    mockAclEntries.findAll.mockResolvedValue([row({ origin: 'DEPT_SNAPSHOT' }), folderDeny]);
    const r = await resolveACL(opts);
    expect(r.allowed).toBe(false);
    expect(r.effect).toBe('DENY');
  });

  it('with no DENY above, the snapshot row still opens the document', async () => {
    mockAclEntries.findAll.mockResolvedValue([row({ origin: 'DEPT_SNAPSHOT' })]);
    const r = await resolveACL(opts);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/department snapshot/);
  });

  it('a deliberate per-user grant on the document is more specific than the folder DENY and still wins', async () => {
    mockAclEntries.findAll.mockResolvedValue([row({}), folderDeny]);
    const r = await resolveACL(opts);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('Direct user ALLOW');
  });
});
