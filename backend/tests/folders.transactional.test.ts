/**
 * BUG 1 Tests: Folder Transactional Integrity
 * 
 * Tests that verify:
 * 1. ACL-copy failure rolls back folder creation
 * 2. Audit-log failure rolls back folder creation
 * 3. UniqueConstraintError returns 409, not 500
 * 4. Concurrent folder creation returns exactly one 201 and one 409
 * 5. Deactivated folder path can be reused
 * 6. Update folder cascades path changes to descendants
 */

import { UniqueConstraintError } from 'sequelize';

const mockFolderNode = {
  findOne: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  count: jest.fn(),
};

const mockAclEntry = {
  findAll: jest.fn(),
  create: jest.fn(),
  // folders.service.ts's ACL-inheritance copy batches rows into one
  // bulkCreate instead of one create() per parent ACL row (Phase 7-9 review
  // fix for the N+1 it used to be).
  bulkCreate: jest.fn(),
};

const mockDepartment = {
  findOne: jest.fn(),
};

const mockDocument = {
  count: jest.fn(),
};

// folders.service.ts's tenant-root/org-unit folder bootstrap (getOrCreateTenantRootFolder,
// getOrCreateOrgUnitFolder) looks these up directly -- omitting them from the
// module mock below left `Tenant`/`OrgUnit` `undefined` inside the service,
// which only surfaced once a test's FolderNode.findOne mock didn't already
// short-circuit the bootstrap path (see Test 2, which used to fail with
// "Cannot read properties of undefined (reading 'findByPk')").
const mockTenant = {
  findByPk: jest.fn(),
};

const mockOrgUnit = {
  findOne: jest.fn(),
};

const mockUserDepartment = {
  findAll: jest.fn().mockResolvedValue([]),
};

// Real Sequelize transactions expose `afterCommit(fn)` — folders.service.ts's
// runInTransaction-converted callbacks call it (e.g. to defer ACL cache
// invalidation to the true commit point). The mock transaction handed to
// callbacks in these tests must support it too, so it invokes `fn` immediately
// (there's no real commit/rollback distinction in this in-memory mock — every
// `callback(...)` call that resolves is treated as "committed").
function fakeTx() {
  return { afterCommit: (fn: () => void) => fn() };
}

// createFolder() with no parentId/departmentId anchors under
// getOrCreateOrganisationFolder's synthetic tenant root ("DMS Repository")
// and org folder ("Example Corp") -- in real use these are created once,
// ever, per tenant (almost always already there by the time a user creates
// their own first folder, per the seeding tenants.service.ts does on tenant
// creation) and found via `findOne` from then on. Tests that exercise the
// ACTUAL target folder's own duplicate handling need that bootstrap lookup
// to resolve as already-existing, or the mocked `create()` throw meant for
// the target folder gets hit by the root/org bootstrap's own create() first
// instead (see folders.service.ts's getOrCreateOrganisationFolder).
function withOrgFolderAlreadyBootstrapped(rootId = 'org-root-1', orgId = 'org-folder-1') {
  return (opts: any) => {
    const where = opts?.where ?? {};
    if (where.level === 0 && where.parentId === null && where.departmentId === null) {
      return Promise.resolve({ id: rootId, path: '/', level: 0, parentId: null, departmentId: null, orgUnitId: null, tenantId: 'tenant-1', isActive: true });
    }
    // getOrCreateOrganisationFolder's tenant-wide "Global Folders" (genuinely
    // org-unit-less: departmentId AND orgUnitId both null) vs.
    // getOrCreateOrgUnitFolder's per-org-unit folder (orgUnitId set,
    // departmentId key simply absent from that query, not explicitly null) --
    // both are level 1 under the same root, so they're told apart by whether
    // `orgUnitId` was asked for at all.
    if (where.level === 1 && where.departmentId === null && where.orgUnitId === null) {
      return Promise.resolve({ id: orgId, path: '/global', level: 1, parentId: rootId, departmentId: null, orgUnitId: null, tenantId: 'tenant-1', isActive: true });
    }
    if (where.level === 1 && where.orgUnitId && !('departmentId' in where)) {
      return Promise.resolve({
        id: `org-unit-folder-${where.orgUnitId}`,
        path: `/${where.orgUnitId}`,
        level: 1,
        parentId: rootId,
        departmentId: null,
        orgUnitId: where.orgUnitId,
        tenantId: 'tenant-1',
        isActive: true,
      });
    }
    return Promise.resolve(null);
  };
}

// Organisation-level folders (outside every department) need organisation-level
// authority; these older cases exercise transactional behaviour, not scope.
const ORG_ADMIN = ['acl:bypass_admin'];

const mockSequelize = {
  query: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    return callback(fakeTx());
  }),
};

const mockWriteAuditLog = jest.fn();

const mockGetCachedUserDepartments = jest.fn().mockResolvedValue(null);
const mockCacheUserDepartments = jest.fn().mockResolvedValue(undefined);
const mockLoadUserDepartmentIds = jest.fn().mockResolvedValue([]);

jest.mock('../src/infrastructure/database/index.js', () => ({
  FolderNode: mockFolderNode,
  AclEntry: mockAclEntry,
  Department: mockDepartment,
  Document: mockDocument,
  Tenant: mockTenant,
  OrgUnit: mockOrgUnit,
  UserDepartment: mockUserDepartment,
  sequelize: mockSequelize,
}));

// createFolder's own department-membership check (Test 9 below) goes through
// userDeptCache.ts's cache-then-DB helper, not UserDepartment.findAll directly
// (that model mock above is still exercised by folders.service.ts's separate
// ACL-inheritance path) — mock it here too, or a cache miss falls through to
// loadUserDepartmentIds's REAL raw sequelize.query and tries a live DB connection.
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({
  getCachedUserDepartments: (...args: unknown[]) => mockGetCachedUserDepartments(...args),
  cacheUserDepartments: (...args: unknown[]) => mockCacheUserDepartments(...args),
  loadUserDepartmentIds: (...args: unknown[]) => mockLoadUserDepartmentIds(...args),
}));

jest.mock('../src/modules/audit/audit.service.js', () => ({
  writeAuditLog: mockWriteAuditLog,
  AUDIT_EVENTS: {
    FOLDER_CREATED: 'FOLDER_CREATED',
    FOLDER_UPDATED: 'FOLDER_UPDATED',
    FOLDER_DEACTIVATED: 'FOLDER_DEACTIVATED',
  },
}));

let createFolder: typeof import('../src/modules/folders/folders.service.js').createFolder;
let updateFolder: typeof import('../src/modules/folders/folders.service.js').updateFolder;
let deactivateFolder: typeof import('../src/modules/folders/folders.service.js').deactivateFolder;

beforeAll(async () => {
  const service = await import('../src/modules/folders/folders.service.js');
  createFolder = service.createFolder;
  updateFolder = service.updateFolder;
  deactivateFolder = service.deactivateFolder;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDepartment.findOne.mockResolvedValue({ id: 'dept-1', isActive: true });
  mockFolderNode.findOne.mockResolvedValue(null);
  mockFolderNode.findAll.mockResolvedValue([]);
  mockAclEntry.findAll.mockResolvedValue([]);
  mockAclEntry.create.mockResolvedValue({});
  mockAclEntry.bulkCreate.mockResolvedValue([]);
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockDocument.count.mockResolvedValue(0);
  mockFolderNode.count.mockResolvedValue(0);
  mockUserDepartment.findAll.mockResolvedValue([]);
  // getOrCreateTenantRootFolder's fallback name when no root exists yet --
  // real code prefers the tenant's own name, so this exercises that path too.
  mockTenant.findByPk.mockResolvedValue({ id: 'tenant-1', name: 'Test Tenant' });
  mockOrgUnit.findOne.mockResolvedValue({ id: 'org-unit-1', code: 'HQ', name: 'Headquarters' });
});

describe('BUG 1: Folder Transactional Integrity', () => {
  const userId = 'user-1';
  const tenantId = 'tenant-1';
  
  describe('Test 1: ACL-copy failure rolls back folder creation', () => {
    it('should roll back folder creation when ACL copy fails', async () => {
      // Setup: Parent folder with ACL entries
      const parentId = '550e8400-e29b-41d4-a716-446655440001';
      const parentFolder = {
        id: parentId,
        path: 'parent',
        level: 0,
        tenantId,
        isActive: true,
        departmentId: null,
      };
      
      mockFolderNode.findOne.mockImplementation((opts: any) => {
        if (opts.where?.id === parentId) return Promise.resolve(parentFolder);
        if (opts.where?.path === 'parent/subfolder') return Promise.resolve(null);
        return Promise.resolve(null);
      });
      
      mockFolderNode.create.mockResolvedValue({
        id: 'new-folder-1',
        name: 'SubFolder',
        path: 'parent/subfolder',
        level: 1,
        parentId: parentId,
        departmentId: null,
        tenantId,
        isActive: true,
      });
      
      mockAclEntry.findAll.mockResolvedValue([
        {
          tenantId,
          resourceType: 'folder',
          resourceId: parentId,
          principalType: 'user',
          principalId: 'user-2',
          permission: 'read',
          effect: 'allow',
          grantedById: 'admin-1',
          expiresAt: null,
        },
      ]);
      
      // Simulate ACL creation failure
      mockAclEntry.bulkCreate.mockRejectedValue(new Error('ACL creation failed'));
      
      // Mock sequelize.transaction to actually roll back on error
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        try {
          return await callback(fakeTx());
        } catch (error) {
          // Transaction would roll back here
          throw error;
        }
      });
      
      // Execute and expect error
      await expect(
        createFolder({ name: 'SubFolder', parentId: parentId }, userId, tenantId, ORG_ADMIN)
      ).rejects.toThrow('ACL creation failed');
      
      // Verify transaction was called
      expect(mockSequelize.transaction).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('Test 2: Audit-log failure rolls back folder creation', () => {
    it('should roll back folder creation when audit log fails', async () => {
      mockFolderNode.findOne.mockResolvedValue(null);
      mockFolderNode.create.mockResolvedValue({
        id: 'new-folder-1',
        name: 'TestFolder',
        path: 'testfolder',
        level: 0,
        parentId: null,
        departmentId: null,
        tenantId,
        isActive: true,
      });
      
      // Simulate audit log failure
      mockWriteAuditLog.mockRejectedValue(new Error('Audit log write failed'));
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        try {
          return await callback(fakeTx());
        } catch (error) {
          throw error;
        }
      });
      
      await expect(
        createFolder({ name: 'TestFolder' }, userId, tenantId, ORG_ADMIN)
      ).rejects.toThrow('Audit log write failed');
      
      expect(mockSequelize.transaction).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('Test 3: UniqueConstraintError returns 409, not 500', () => {
    it('should catch UniqueConstraintError and return 409', async () => {
      // Root/org bootstrap folders already exist (the common case); only the
      // actual target-folder duplicate-path lookup resolves null, so the
      // app-level check passes and the DB-level UniqueConstraintError this
      // test simulates is the one createFolder's own catch is meant to
      // translate to 409 -- not an incidental one from the bootstrap path.
      mockFolderNode.findOne.mockImplementation(withOrgFolderAlreadyBootstrapped());
      
      // Simulate database unique constraint violation
      const uniqueError = new UniqueConstraintError({
        message: 'Unique constraint violation',
      });
      mockFolderNode.create.mockRejectedValue(uniqueError);
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback(fakeTx());
      });
      
      try {
        await createFolder({ name: 'DuplicateFolder' }, userId, tenantId, ORG_ADMIN);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.statusCode).toBe(409);
        expect(error.code).toBe('ERR-FOLDER-DUPLICATE');
        expect(error.message).toBe('A folder with this name already exists in this location');
      }
    });
  });
  
  describe('Test 4: Concurrent folder creation returns one 201 and one 409', () => {
    it('should handle concurrent creation with database constraint', async () => {
      // Both requests pass app-level check; root/org bootstrap already exists
      // (see withOrgFolderAlreadyBootstrapped) so both requests' own target-
      // folder create() is what actually races here, matching what "two
      // concurrent requests for the same new folder" means in production.
      mockFolderNode.findOne.mockImplementation(withOrgFolderAlreadyBootstrapped());
      
      let firstCall = true;
      mockFolderNode.create.mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return Promise.resolve({
            id: 'folder-1',
            name: 'ConcurrentFolder',
            path: 'concurrentfolder',
            level: 0,
            parentId: null,
            departmentId: null,
            tenantId,
            isActive: true,
          });
        } else {
          // Second call hits unique constraint
          throw new UniqueConstraintError({
            message: 'Unique constraint violation',
          });
        }
      });
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback(fakeTx());
      });
      
      // First request succeeds
      const result1 = await createFolder({ name: 'ConcurrentFolder' }, userId, tenantId, ORG_ADMIN);
      expect(result1.id).toBe('folder-1');
      
      // Second request gets 409
      try {
        await createFolder({ name: 'ConcurrentFolder' }, userId, tenantId, ORG_ADMIN);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.statusCode).toBe(409);
        expect(error.code).toBe('ERR-FOLDER-DUPLICATE');
      }
    });
  });
  
  describe('Test 5: Deactivated folder path can be reused', () => {
    it('should allow creating folder with same path as deactivated folder', async () => {
      // First, simulate a deactivated folder exists
      const deactivatedFolder = {
        id: 'old-folder-1',
        name: 'ReusablePath',
        path: 'reusablepath',
        level: 0,
        parentId: null,
        departmentId: null,
        tenantId,
        isActive: false, // Deactivated
      };
      
      // App-level check looks for isActive: true, so deactivated folder is ignored
      mockFolderNode.findOne.mockImplementation((opts: any) => {
        if (opts.where?.isActive === true) {
          return Promise.resolve(null); // No active folder with this path
        }
        return Promise.resolve(deactivatedFolder);
      });
      
      mockFolderNode.create.mockResolvedValue({
        id: 'new-folder-1',
        name: 'ReusablePath',
        path: 'reusablepath',
        level: 0,
        parentId: null,
        departmentId: null,
        tenantId,
        isActive: true,
      });
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback(fakeTx());
      });
      
      const result = await createFolder({ name: 'ReusablePath' }, userId, tenantId, ORG_ADMIN);
      expect(result.id).toBe('new-folder-1');
      expect(result.isActive).toBe(true);
    });
  });
  
  describe('Test 6: Update folder cascades path changes to descendants', () => {
    it('should update all descendant paths when parent path changes', async () => {
      const folderId = '550e8400-e29b-41d4-a716-446655440002';
      const folder = {
        id: folderId,
        name: 'OldName',
        path: 'oldname',
        level: 0,
        parentId: null,
        departmentId: null,
        tenantId,
        isActive: true,
        update: jest.fn().mockImplementation(function(this: any, updates: any) {
          Object.assign(this, updates);
          return Promise.resolve(this);
        }),
      };
      
      const descendant1 = {
        id: 'folder-2',
        path: 'oldname/child1',
        level: 1,
        update: jest.fn().mockResolvedValue(undefined),
      };
      
      const descendant2 = {
        id: 'folder-3',
        path: 'oldname/child1/grandchild',
        level: 2,
        update: jest.fn().mockResolvedValue(undefined),
      };
      
      mockFolderNode.findOne.mockImplementation((opts: any) => {
        if (opts.where?.id === folderId) return Promise.resolve(folder);
        if (opts.where?.path === 'newname') return Promise.resolve(null);
        return Promise.resolve(null);
      });
      
      mockFolderNode.findAll.mockResolvedValue([descendant1, descendant2]);
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback(fakeTx());
      });
      
      await updateFolder(folderId, { name: 'NewName' }, { userId, role: 'SYSTEM_ADMIN', tenantId, permissions: ['acl:bypass_admin'] });
      
      // Verify descendants were updated
      expect(mockFolderNode.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            path: expect.anything(),
          }),
        })
      );
      
      expect(descendant1.update).toHaveBeenCalled();
      expect(descendant2.update).toHaveBeenCalled();
    });
  });
  
  describe('Test 7: PATCH /api/v1/folders/null returns 400, not 500', () => {
    it('should return 400 for invalid folder ID format', async () => {
      // The service validates UUID format before querying
      try {
        await updateFolder('null', { name: 'NewName' }, { userId, role: 'SYSTEM_ADMIN', tenantId, permissions: ['acl:bypass_admin'] });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe('ERR-INVALID-FOLDER-ID');
        expect(error.message).toBe('Invalid folder ID format');
      }
    });
  });
  
  describe('Test 8: Folder deactivation is transactional', () => {
    it('should wrap deactivation in transaction', async () => {
      const folder = {
        id: 'folder-1',
        path: 'testfolder',
        isActive: true,
        update: jest.fn().mockResolvedValue({
          id: 'folder-1',
          isActive: false,
        }),
      };
      
      mockFolderNode.findOne.mockResolvedValue(folder);
      mockFolderNode.count.mockResolvedValue(0); // No children
      mockDocument.count.mockResolvedValue(0); // No documents
      
      mockSequelize.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        return callback(fakeTx());
      });
      
      await deactivateFolder('folder-1', { userId, role: 'admin', tenantId });

      expect(mockSequelize.transaction).toHaveBeenCalledTimes(1);
      expect(folder.update).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
        expect.anything()
      );
    });
  });

  // Regression: createFolder used to validate a client-supplied departmentId
  // (or a parentId's inherited one) purely for EXISTENCE, never for whether
  // the caller actually belongs to it — any FOLDER_CREATE holder could
  // anchor a new folder under any other department's tree.
  describe('Test 9: createFolder enforces department membership', () => {
    const DEPT_UUID = '550e8400-e29b-41d4-a716-446655440099';

    // Distinct userId per case, not the shared `userId` const: getUserDepartmentIds
    // caches through userDeptCache.ts's module-level LRU fallback (real Redis is
    // unavailable in this test run) keyed only by userId, with no per-test reset —
    // reusing one id across these cases would let the first case's cached `[]`
    // silently leak into the next case's assertions.
    it('rejects departmentId when the caller is not a member of it', async () => {
      mockDepartment.findOne.mockResolvedValue({ id: DEPT_UUID, name: 'Finance', orgUnitId: 'ou-1', isActive: true });
      mockLoadUserDepartmentIds.mockResolvedValue([]); // caller belongs to nothing

      await expect(
        createFolder({ name: 'NewFolder', departmentId: DEPT_UUID }, 'user-901', tenantId)
      ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });

      expect(mockFolderNode.create).not.toHaveBeenCalled();
    });

    it('allows departmentId when the caller is a member of it', async () => {
      mockDepartment.findOne.mockResolvedValue({ id: DEPT_UUID, name: 'Finance', orgUnitId: 'ou-1', isActive: true });
      mockLoadUserDepartmentIds.mockResolvedValue([DEPT_UUID]);
      mockFolderNode.findOne.mockResolvedValue(null); // no existing dept-bound folder, no duplicate at target path
      mockFolderNode.create.mockImplementation((attrs: any) => Promise.resolve({ id: 'new-folder-1', ...attrs }));

      const result = await createFolder({ name: 'NewFolder', departmentId: DEPT_UUID }, 'user-902', tenantId);
      expect(result.id).toBeDefined();
      expect(mockFolderNode.create).toHaveBeenCalled();
    });

    it('bypasses the membership check for an ACL_BYPASS_ADMIN holder', async () => {
      mockDepartment.findOne.mockResolvedValue({ id: DEPT_UUID, name: 'Finance', orgUnitId: 'ou-1', isActive: true });
      mockLoadUserDepartmentIds.mockResolvedValue([]); // not a member
      mockFolderNode.findOne.mockResolvedValue(null);
      mockFolderNode.create.mockImplementation((attrs: any) => Promise.resolve({ id: 'new-folder-1', ...attrs }));

      const result = await createFolder(
        { name: 'NewFolder', departmentId: DEPT_UUID },
        'user-903',
        tenantId,
        ['acl:bypass_admin'],
      );
      expect(result.id).toBeDefined();
      expect(mockLoadUserDepartmentIds).not.toHaveBeenCalled();
    });
  });
});

// Department scope on folder creation and movement (shared/orgScope.ts).
describe('Test 10: folder scope follows the department subtree', () => {
  const tenantId = 'tenant-1';
  const PARENT_DEPT = '550e8400-e29b-41d4-a716-4466554400a1';
  const SUB_DEPT = '550e8400-e29b-41d4-a716-4466554400a2';
  const OTHER_DEPT = '550e8400-e29b-41d4-a716-4466554400a3';
  const DEPT_MANAGER = ['folder:create', 'department:manage', 'user:manage'];
  const RECORDS = ['folder:create', 'document:read_all'];

  const deptRow = (id: string) => ({ id, name: id, orgUnitId: 'ou-1', isActive: true, parentId: null });

  function createsFolderIn(deptId: string) {
    mockDepartment.findOne.mockImplementation(({ where }: any) => Promise.resolve(deptRow(where.id ?? deptId)));
    mockFolderNode.findOne.mockResolvedValue(null);
    mockFolderNode.create.mockImplementation((attrs: any) => Promise.resolve({ id: 'new-folder', ...attrs }));
  }

  it('lets a head of the parent department create a folder in a SUB-department they are not a member of', async () => {
    createsFolderIn(SUB_DEPT);
    mockLoadUserDepartmentIds.mockResolvedValue([PARENT_DEPT]); // member of the parent only
    mockSequelize.query.mockResolvedValue([{ id: PARENT_DEPT }, { id: SUB_DEPT }]); // managed subtree
    const result = await createFolder({ name: 'Invoices', departmentId: SUB_DEPT }, 'user-1001', tenantId, DEPT_MANAGER);
    expect(result.id).toBeDefined();
  });

  it('still refuses a sibling department outside that subtree', async () => {
    createsFolderIn(OTHER_DEPT);
    mockLoadUserDepartmentIds.mockResolvedValue([PARENT_DEPT]);
    mockSequelize.query.mockResolvedValue([{ id: PARENT_DEPT }, { id: SUB_DEPT }]);
    await expect(
      createFolder({ name: 'Nope', departmentId: OTHER_DEPT }, 'user-1002', tenantId, DEPT_MANAGER),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
    expect(mockFolderNode.create).not.toHaveBeenCalled();
  });

  it('does not let a member of department A plant a folder in department B by naming B alongside an A parent', async () => {
    const parentId = '550e8400-e29b-41d4-a716-4466554400b1';
    mockDepartment.findOne.mockImplementation(({ where }: any) => Promise.resolve(deptRow(where.id)));
    mockFolderNode.findOne.mockImplementation((opts: any) =>
      Promise.resolve(opts.where?.id === parentId ? { id: parentId, path: '/a', level: 2, tenantId, isActive: true, departmentId: SUB_DEPT, orgUnitId: 'ou-1' } : null));
    mockLoadUserDepartmentIds.mockResolvedValue([SUB_DEPT]);
    mockSequelize.query.mockResolvedValue([{ id: SUB_DEPT }]);
    await expect(
      createFolder({ name: 'Sneaky', parentId, departmentId: OTHER_DEPT }, 'user-1003', tenantId, DEPT_MANAGER),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
    expect(mockFolderNode.create).not.toHaveBeenCalled();
  });

  it('refuses a department manager a folder outside every department (tenant top level)', async () => {
    mockFolderNode.findOne.mockImplementation(withOrgFolderAlreadyBootstrapped());
    await expect(
      createFolder({ name: 'TopLevel' }, 'user-1004', tenantId, DEPT_MANAGER),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
    expect(mockFolderNode.create).not.toHaveBeenCalled();
  });

  it('refuses creating under a department-less parent (the org folder) for a department manager', async () => {
    const orgFolderId = '550e8400-e29b-41d4-a716-4466554400c1';
    mockFolderNode.findOne.mockImplementation((opts: any) =>
      Promise.resolve(opts.where?.id === orgFolderId ? { id: orgFolderId, path: '/org', level: 1, tenantId, isActive: true, departmentId: null } : null));
    await expect(
      createFolder({ name: 'UnderOrg', parentId: orgFolderId }, 'user-1005', tenantId, DEPT_MANAGER),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
  });

  it('allows records staff (document:read_all) to curate department-less folders', async () => {
    mockFolderNode.findOne.mockImplementation(withOrgFolderAlreadyBootstrapped());
    mockFolderNode.create.mockImplementation((attrs: any) => Promise.resolve({ id: 'new-folder', ...attrs }));
    const result = await createFolder({ name: 'Filing plan' }, 'user-1006', tenantId, RECORDS);
    expect(result.id).toBeDefined();
  });

  it('updateFolder refuses to move a folder into a department the caller does not head', async () => {
    const folderId = '550e8400-e29b-41d4-a716-4466554400d1';
    const destId = '550e8400-e29b-41d4-a716-4466554400d2';
    mockFolderNode.findOne.mockImplementation((opts: any) => {
      if (opts.where?.id === folderId) return Promise.resolve({ id: folderId, name: 'f', path: '/a/f', level: 2, tenantId, isActive: true, departmentId: SUB_DEPT, parentId: 'p', update: jest.fn() });
      if (opts.where?.id === destId) return Promise.resolve({ id: destId, name: 'd', path: '/b/d', level: 2, tenantId, isActive: true, departmentId: OTHER_DEPT });
      return Promise.resolve(null);
    });
    mockLoadUserDepartmentIds.mockResolvedValue([SUB_DEPT]);
    mockSequelize.query.mockResolvedValue([{ id: SUB_DEPT }]);
    await expect(
      updateFolder(folderId, { parentId: destId }, { userId: 'user-1007', role: 'DEPT_MANAGER', roles: ['DEPT_MANAGER'], tenantId, permissions: DEPT_MANAGER }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
  });

  it('updateFolder refuses to re-point a folder at another department', async () => {
    const folderId = '550e8400-e29b-41d4-a716-4466554400e1';
    mockFolderNode.findOne.mockImplementation((opts: any) =>
      Promise.resolve(opts.where?.id === folderId
        ? { id: folderId, name: 'f', path: '/a/f', level: 2, tenantId, isActive: true, departmentId: SUB_DEPT, parentId: 'p', update: jest.fn() }
        : null));
    mockDepartment.findOne.mockResolvedValue(deptRow(OTHER_DEPT));
    mockLoadUserDepartmentIds.mockResolvedValue([SUB_DEPT]);
    mockSequelize.query.mockResolvedValue([{ id: SUB_DEPT }]);
    await expect(
      updateFolder(folderId, { departmentId: OTHER_DEPT }, { userId: 'user-1008', role: 'DEPT_MANAGER', roles: ['DEPT_MANAGER'], tenantId, permissions: DEPT_MANAGER }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
  });
});
