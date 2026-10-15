// createUser scope: who may create whom, into which departments.
//
// Before: any user:manage holder could create a user attached to ANY department
// id (not even checked to belong to their tenant), and the platform-admin role
// was only protected on the assign path, not the create path.

const mockRole = { findByPk: jest.fn() };
const mockUser = { findOne: jest.fn(), create: jest.fn() };
const mockUserTenant = { create: jest.fn() };
const mockUserRole = { bulkCreate: jest.fn() };
const mockUserDepartment = { bulkCreate: jest.fn() };
const mockDepartment = { findAll: jest.fn() };
const mockQuery = jest.fn();

jest.mock('../src/infrastructure/database/index.js', () => ({
  Department: mockDepartment, Role: mockRole, User: mockUser, UserDepartment: mockUserDepartment,
  UserRole: mockUserRole, UserTenant: mockUserTenant, Document: {}, AuthSession: {}, DocLock: {},
  DocumentCheckout: {}, ApprovalStep: {}, ApprovalChain: {}, AuditStageReview: {},
  LetterApprovalStep: {}, Letter: {}, WorkflowTask: {}, WorkflowInstance: {},
  SignatureRecipient: {}, SignatureRequest: {},
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('../src/modules/notifications/notifications.service.js', () => ({ fanOut: jest.fn() }));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({ invalidateUserDepartments: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/shared/auth.js', () => ({ revokeAllUserSessions: jest.fn() }));
jest.mock('../src/shared/transaction.js', () => ({
  runInSavepoint: jest.fn(),
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ afterCommit: jest.fn() }),
}));
jest.mock('../src/modules/roles/roles.service.js', () => ({
  getMaxRolePermissionsAcrossTenants: jest.fn(async (name: string) => {
    const { ROLE_PERMISSIONS } = jest.requireActual('../src/config/permissions.js');
    return ROLE_PERMISSIONS[name] ?? [];
  }),
  resolveUnionPermissions: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/shared/platformAdmin.js', () => {
  const { AppError } = jest.requireActual('../src/core/AppError.js');
  return {
    assertNotHiddenUser: jest.fn(),
    excludeHiddenWhere: jest.fn(() => ({})),
    hiddenUserIds: jest.fn().mockResolvedValue([]),
    isPlatformAdminRoleName: (n: string) => n === 'PLATFORM_ADMIN',
    userNotFound: () => new AppError(404, 'ERR-USER-NOT-FOUND', 'User not found'),
  };
});
jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { ROLE_PERMISSIONS } from '../src/config/permissions.js';

let createUser: typeof import('../src/modules/users/users.service.js').createUser;
let deactivateUser: typeof import('../src/modules/users/users.service.js').deactivateUser;
beforeAll(async () => {
  ({ createUser, deactivateUser } = await import('../src/modules/users/users.service.js'));
});

const TENANT = 'tenant-1';
const FIN = '550e8400-e29b-41d4-a716-446655440001';
const HR = '550e8400-e29b-41d4-a716-446655440002';
const ROLE_ID = '550e8400-e29b-41d4-a716-446655440010';

const input = (departmentIds?: string[]) => ({
  email: 'new.person@example.test', firstName: 'New', lastName: 'Person', roleIds: [ROLE_ID], departmentIds,
});
const deptManager = { userId: 'head-1', tenantId: TENANT, permissions: ROLE_PERMISSIONS.DEPT_MANAGER };
const sysAdmin = { userId: 'admin-1', tenantId: TENANT, permissions: ROLE_PERMISSIONS.SYSTEM_ADMIN };

beforeEach(() => {
  jest.clearAllMocks();
  mockRole.findByPk.mockResolvedValue({ id: ROLE_ID, name: 'EMPLOYEE' });
  mockUser.findOne.mockResolvedValue(null);
  mockUser.create.mockResolvedValue({ id: 'new-user', email: 'new.person@example.test', firstName: 'New', lastName: 'Person' });
  mockUserTenant.create.mockResolvedValue({});
  mockUserRole.bulkCreate.mockResolvedValue([]);
  mockUserDepartment.bulkCreate.mockResolvedValue([]);
  mockQuery.mockResolvedValue([{ id: FIN }]); // the head's managed subtree
  mockDepartment.findAll.mockImplementation(async ({ where }: { where: { id: string[] } }) => where.id.map((id) => ({ id })));
});

describe('users.service.createUser — scope', () => {
  it('a department manager creates a user into a department they head', async () => {
    await expect(createUser(input([FIN]), deptManager)).resolves.toMatchObject({ id: 'new-user' });
    expect(mockUserDepartment.bulkCreate).toHaveBeenCalledWith([{ userId: 'new-user', departmentId: FIN }], expect.anything());
  });

  it('must name a department — otherwise the new user would belong to nobody and be unmanageable', async () => {
    await expect(createUser(input(undefined), deptManager)).rejects.toMatchObject({ statusCode: 422, code: 'ERR-DEPARTMENT-REQUIRED' });
    expect(mockUser.create).not.toHaveBeenCalled();
  });

  it('cannot create a user into a department they do not head', async () => {
    await expect(createUser(input([HR]), deptManager)).rejects.toMatchObject({ statusCode: 403, code: 'ERR-DEPT-SCOPE' });
    expect(mockUser.create).not.toHaveBeenCalled();
    expect(mockUserTenant.create).not.toHaveBeenCalled();
  });

  it('refuses a department that is not in the caller\'s tenant, even for an administrator', async () => {
    mockDepartment.findAll.mockResolvedValue([]); // not found in this tenant
    await expect(createUser(input([HR]), sysAdmin)).rejects.toMatchObject({ statusCode: 404, code: 'ERR-DEPARTMENT-NOT-FOUND' });
    expect(mockUser.create).not.toHaveBeenCalled();
  });

  it('an administrator may create a user with no department', async () => {
    await expect(createUser(input(undefined), sysAdmin)).resolves.toMatchObject({ id: 'new-user' });
  });

  it('cannot mint a role above their own (C1 still applies)', async () => {
    mockRole.findByPk.mockResolvedValue({ id: ROLE_ID, name: 'SYSTEM_ADMIN' });
    await expect(createUser(input([FIN]), deptManager)).rejects.toMatchObject({ statusCode: 403, code: 'ERR-ASSIGN-EXCEEDS-ACTOR' });
    expect(mockUser.create).not.toHaveBeenCalled();
  });

  it('the platform-admin role cannot be handed out when creating a user — even by a holder of every permission', async () => {
    mockRole.findByPk.mockResolvedValue({ id: ROLE_ID, name: 'PLATFORM_ADMIN' });
    const platformAdmin = { userId: 'pa', tenantId: TENANT, permissions: ROLE_PERMISSIONS.PLATFORM_ADMIN };
    await expect(createUser(input(undefined), platformAdmin)).rejects.toMatchObject({ statusCode: 404, code: 'ERR-ROLE-NOT-FOUND' });
    expect(mockUser.create).not.toHaveBeenCalled();
  });
});

describe('deactivating oneself', () => {
  it('an administrator cannot deactivate their own account (SSO refuses the same)', async () => {
    await expect(deactivateUser('same-user', 'same-user')).rejects.toMatchObject({ statusCode: 409, code: 'ERR-SELF-DEACTIVATE' });
    expect(mockUser.findOne).not.toHaveBeenCalled();
  });
});
