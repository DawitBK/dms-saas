// Per-user permission overrides: the escalation rules and the tenant boundary.
//
// "Special members" get an individual GRANT/REVOKE on top of their role. The
// guard must hold: nobody grants a permission they do not hold, platform:admin
// is never grantable, and the target must be a member of the actor's tenant.

const mockUser = { findByPk: jest.fn() };
const mockUserTenant = { findOne: jest.fn() };
const mockUserPermissionOverride = { findAll: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn() };

jest.mock('../src/infrastructure/database/index.js', () => ({
  Role: { findOne: jest.fn(), findByPk: jest.fn() },
  RolePermission: { findAll: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn() },
  UserPermissionOverride: mockUserPermissionOverride,
  UserRole: { findAll: jest.fn() },
  UserTenant: mockUserTenant,
  User: mockUser,
  sequelize: { query: jest.fn() },
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/infrastructure/cache/roleCache.js', () => ({
  getCachedRolePermissions: jest.fn(), cacheRolePermissions: jest.fn(), invalidateRolePermissions: jest.fn(),
  getCachedUserPermissionOverrides: jest.fn().mockResolvedValue(null),
  cacheUserPermissionOverrides: jest.fn().mockResolvedValue(undefined),
  invalidateUserPermissionOverrides: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/shared/transaction.js', () => ({
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ afterCommit: jest.fn() }),
}));
jest.mock('../src/shared/auth.js', () => ({ revokeAllUserSessions: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/shared/platformAdmin.js', () => ({
  assertNotHiddenUser: jest.fn().mockResolvedValue(undefined),
  isPlatformAdminRoleName: (n: string) => n === 'PLATFORM_ADMIN',
}));
jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/config/permissions.js';

let replaceUserPermissionOverrides: typeof import('../src/modules/roles/roles.service.js').replaceUserPermissionOverrides;
beforeAll(async () => {
  ({ replaceUserPermissionOverrides } = await import('../src/modules/roles/roles.service.js'));
});

const dm = ROLE_PERMISSIONS.DEPT_MANAGER;

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.findByPk.mockResolvedValue({ id: 'target' });
  mockUserTenant.findOne.mockResolvedValue({ userId: 'target' });
  mockUserPermissionOverride.findAll.mockResolvedValue([]);
  mockUserPermissionOverride.destroy.mockResolvedValue(0);
  mockUserPermissionOverride.bulkCreate.mockResolvedValue([]);
});

describe('replaceUserPermissionOverrides', () => {
  it('grants a permission the actor holds', async () => {
    const result = await replaceUserPermissionOverrides('target', 't1', [PERMISSIONS.FOLDER_CREATE], [], 'actor', dm);
    expect(result.grants).toEqual([PERMISSIONS.FOLDER_CREATE]);
  });

  it('refuses a GRANT of a permission the actor does not hold (no escalation)', async () => {
    await expect(
      replaceUserPermissionOverrides('target', 't1', [PERMISSIONS.DOCUMENT_PURGE], [], 'actor', dm),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ERR-GRANT-EXCEEDS-ACTOR' });
    expect(mockUserPermissionOverride.bulkCreate).not.toHaveBeenCalled();
  });

  it('platform:admin can never be granted — not even by someone who holds it', async () => {
    await expect(
      replaceUserPermissionOverrides('target', 't1', [PERMISSIONS.PLATFORM_ADMIN], [], 'actor', ROLE_PERMISSIONS.PLATFORM_ADMIN),
    ).rejects.toMatchObject({ statusCode: 400, code: 'ERR-PERMISSION-RESERVED' });
  });

  it('a REVOKE needs no escalation check (it only narrows)', async () => {
    const result = await replaceUserPermissionOverrides('target', 't1', [], [PERMISSIONS.DOCUMENT_UPLOAD], 'actor', dm);
    expect(result.revokes).toEqual([PERMISSIONS.DOCUMENT_UPLOAD]);
  });

  it('refuses a user who is not a member of the actor\'s tenant (no cross-tenant writes or sign-outs)', async () => {
    mockUserTenant.findOne.mockResolvedValue(null);
    await expect(
      replaceUserPermissionOverrides('target', 't1', [], [PERMISSIONS.DOCUMENT_UPLOAD], 'actor', dm),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ERR-USER-NOT-FOUND' });
    expect(mockUserPermissionOverride.destroy).not.toHaveBeenCalled();
    expect(mockUserPermissionOverride.bulkCreate).not.toHaveBeenCalled();
  });

  it('refuses a permission listed as both granted and revoked', async () => {
    await expect(
      replaceUserPermissionOverrides('target', 't1', [PERMISSIONS.FOLDER_CREATE], [PERMISSIONS.FOLDER_CREATE], 'actor', dm),
    ).rejects.toMatchObject({ code: 'ERR-CONFLICTING-OVERRIDE' });
  });
});
