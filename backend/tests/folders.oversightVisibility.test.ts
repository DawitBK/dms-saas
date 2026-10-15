/**
 * Folder tree visibility for oversight roles.
 *
 * RECORDS_OFFICER, AUDITOR and EXECUTIVE hold document:read_all and already read
 * every department's documents, but listReadableFolders used to treat only
 * acl:bypass_admin as "sees every folder" — so they could search a document yet
 * not browse to its folder. document:read_all must now widen read visibility,
 * and an ordinary member must still see only their own department subtree.
 */

const mockFolderNode = { findAll: jest.fn() };
const mockUserDepartment = { findAll: jest.fn() };
const mockAclEntry = { findAll: jest.fn().mockResolvedValue([]) };
const mockSequelize = { query: jest.fn() };

jest.mock('../src/infrastructure/database/index.js', () => ({
  FolderNode: mockFolderNode,
  UserDepartment: mockUserDepartment,
  AclEntry: mockAclEntry,
  Department: {},
  Document: {},
  Tenant: {},
  OrgUnit: {},
  sequelize: mockSequelize,
}));

jest.mock('../src/infrastructure/cache/readableFoldersCache.js', () => ({
  getCachedReadableFolders: jest.fn().mockResolvedValue(null),
  cacheReadableFolders: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/infrastructure/cache/aclCache.js', () => ({ invalidateTenantACL: jest.fn() }));
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({
  getCachedUserDepartments: jest.fn(),
  cacheUserDepartments: jest.fn(),
  loadUserDepartmentIds: jest.fn(),
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn() }));
jest.mock('../src/modules/documents/documents.service.js', () => ({ filterDocsByDetailAcl: jest.fn() }));

import { listReadableFolders } from '../src/modules/folders/folders.service.js';
import { PERMISSIONS } from '../src/config/permissions.js';

const folder = (id: string, departmentId: string | null, parentId: string | null = null) => ({
  id, departmentId, parentId, isActive: true, tenantId: 't1', level: 1, name: id,
  get: () => ({ id, departmentId, parentId }),
});

const FOLDERS = [
  folder('finance', 'dept-finance'),
  folder('hr', 'dept-hr'),
  folder('legal', 'dept-legal'),
];

describe('listReadableFolders: tenant-wide view for oversight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAclEntry.findAll.mockResolvedValue([]);
    mockFolderNode.findAll.mockResolvedValue(FOLDERS);
    mockUserDepartment.findAll.mockResolvedValue([{ departmentId: 'dept-hr' }]);
    // The department-subtree CTE: a department contains only itself here.
    mockSequelize.query.mockImplementation(async (_sql: string, opts: any) =>
      (opts.replacements.rootDeptIds as string[]).map((id) => ({ id })));
  });

  it('document:read_all holder sees every department folder, with no membership lookup', async () => {
    const out = await listReadableFolders(
      { userId: 'exec', role: 'EXECUTIVE', tenantId: 't1', permissions: [PERMISSIONS.DOCUMENT_READ_ALL, PERMISSIONS.FOLDER_READ] },
      { scoped: false },
    );
    expect(out.map((f) => f.id).sort()).toEqual(['finance', 'hr', 'legal']);
    expect(mockUserDepartment.findAll).not.toHaveBeenCalled();
  });

  it('a one-level (scoped) request for an oversight user is served straight from the folder table', async () => {
    mockFolderNode.findAll.mockResolvedValue([FOLDERS[0]]);
    const out = await listReadableFolders(
      { userId: 'aud', role: 'AUDITOR', tenantId: 't1', permissions: [PERMISSIONS.DOCUMENT_READ_ALL] },
      { scoped: true, parentId: null },
    );
    expect(out).toHaveLength(1);
    expect(mockFolderNode.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', parentId: null });
    expect(mockUserDepartment.findAll).not.toHaveBeenCalled();
  });

  it('acl:bypass_admin still sees everything', async () => {
    const out = await listReadableFolders(
      { userId: 'adm', role: 'SYSTEM_ADMIN', tenantId: 't1', permissions: [PERMISSIONS.ACL_BYPASS_ADMIN] },
      { scoped: false },
    );
    expect(out).toHaveLength(3);
  });

  it('an ordinary member still sees only their own department', async () => {
    const out = await listReadableFolders(
      { userId: 'emp', role: 'EMPLOYEE', tenantId: 't1', permissions: [PERMISSIONS.FOLDER_READ, PERMISSIONS.DOCUMENT_READ] },
      { scoped: false },
    );
    expect(out.map((f) => f.id)).toEqual(['hr']);
    expect(mockUserDepartment.findAll).toHaveBeenCalled();
  });
});
