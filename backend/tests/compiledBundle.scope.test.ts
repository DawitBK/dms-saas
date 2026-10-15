const mockAclEntries = { findAll: jest.fn() };
const mockDocuments = { findAll: jest.fn(), findByPk: jest.fn() };
const mockBundles = { findAll: jest.fn() };
const mockBundleItems = { findAll: jest.fn() };

jest.mock('../src/infrastructure/database/models/index.js', () => ({
  AclEntry: mockAclEntries,
  AccessRule: { findAll: jest.fn() },
  Department: {},
  Document: mockDocuments,
  DocumentBundle: mockBundles,
  DocumentBundleItem: mockBundleItems,
  FolderNode: { findByPk: jest.fn() },
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/infrastructure/cache/aclCache.js', () => ({
  getCachedResolution: jest.fn().mockResolvedValue(null),
  cacheResolution: jest.fn().mockResolvedValue(undefined),
  getCachedResolutionsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({
  getCachedUserDepartments: jest.fn().mockResolvedValue([]),
  cacheUserDepartments: jest.fn().mockResolvedValue(undefined),
  loadUserDepartmentIds: jest.fn().mockResolvedValue([]),
}));

import { resolveACL } from '../src/shared/resolveACL.js';

const outputId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const tenantId = 'tenant-1';
const userId = 'user-1';

function acl(resourceId: string, effect: 'ALLOW' | 'DENY') {
  return {
    tenantId,
    resourceType: 'document',
    resourceId,
    principalType: 'user',
    principalId: userId,
    effect,
    permission: 'document:read',
    expiresAt: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBundles.findAll.mockImplementation(async ({ where }: { where: { compiledDocumentId: object } }) => {
    const ids = Reflect.ownKeys(where.compiledDocumentId)
      .map((key) => (where.compiledDocumentId as Record<PropertyKey, string[]>)[key])
      .find(Array.isArray) ?? [];
    return ids.includes(outputId) ? [{ id: 'bundle-1', compiledDocumentId: outputId }] : [];
  });
  mockBundleItems.findAll.mockResolvedValue([{ bundleId: 'bundle-1', documentId: sourceId }]);
  mockDocuments.findAll.mockResolvedValue([{
    id: sourceId,
    folderId: null,
    departmentId: null,
    documentTypeId: null,
    ownerId: userId,
  }]);
});

describe('compiled bundle document scope', () => {
  it('denies a compiled PDF when any source document is no longer readable', async () => {
    mockAclEntries.findAll
      .mockResolvedValueOnce([acl(outputId, 'ALLOW')])
      .mockResolvedValueOnce([acl(sourceId, 'DENY')]);

    const result = await resolveACL({
      resourceType: 'document',
      resourceId: outputId,
      permission: 'document:read',
      userId,
      userRole: 'DPT_MANAGER',
      userRoles: ['DPT_MANAGER'],
      userPermissions: [],
      tenantId,
      ancestorIds: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/compiled bundle includes/i);
  });
});
