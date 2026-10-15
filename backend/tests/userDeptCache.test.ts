export {};

const mockInvalidateFolders = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.mock('../src/infrastructure/cache/redis.js', () => ({ getCacheRedis: jest.fn(() => null) }));
jest.mock('../src/infrastructure/cache/readableFoldersCache.js', () => ({
  invalidateReadableFoldersForUser: mockInvalidateFolders,
}));
jest.mock('../src/infrastructure/database/sequelize.js', () => ({ sequelize: { query: jest.fn() } }));

let cacheUserDepartments: typeof import('../src/infrastructure/cache/userDeptCache.js').cacheUserDepartments;
let getCachedUserDepartments: typeof import('../src/infrastructure/cache/userDeptCache.js').getCachedUserDepartments;
let invalidateUserDepartments: typeof import('../src/infrastructure/cache/userDeptCache.js').invalidateUserDepartments;

beforeAll(async () => {
  ({ cacheUserDepartments, getCachedUserDepartments, invalidateUserDepartments } =
    await import('../src/infrastructure/cache/userDeptCache.js'));
});

describe('user department cache tenant isolation', () => {
  it('never reads or invalidates another tenant’s cache entry for the same user', async () => {
    const userId = 'user-shared-across-tenants';
    await cacheUserDepartments('tenant-a', userId, ['department-a']);
    await cacheUserDepartments('tenant-b', userId, ['department-b']);

    await expect(getCachedUserDepartments('tenant-a', userId)).resolves.toEqual(['department-a']);
    await expect(getCachedUserDepartments('tenant-b', userId)).resolves.toEqual(['department-b']);

    await invalidateUserDepartments('tenant-a', userId);

    await expect(getCachedUserDepartments('tenant-a', userId)).resolves.toBeNull();
    await expect(getCachedUserDepartments('tenant-b', userId)).resolves.toEqual(['department-b']);
    expect(mockInvalidateFolders).toHaveBeenCalledWith('tenant-a', userId);
  });
});
