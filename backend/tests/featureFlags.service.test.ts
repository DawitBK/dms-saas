export {};

// TEST-3: flags are a tenant-scoped production rollout control. Cover cache
// behavior, default-deny, input validation, transactional update and audit.
const mockTenant = { findByPk: jest.fn() };
const mockGetCached = jest.fn();
const mockCache = jest.fn();
const mockInvalidate = jest.fn();
const mockAudit = jest.fn();
const mockRunInTransaction = jest.fn();
const mockAfterCommit = jest.fn();

jest.mock('../src/infrastructure/database/index.js', () => ({ Tenant: mockTenant }));
jest.mock('../src/infrastructure/cache/featureFlagCache.js', () => ({
  getCachedFeatureFlags: mockGetCached,
  cacheFeatureFlags: mockCache,
  invalidateFeatureFlags: mockInvalidate,
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: mockAudit }));
jest.mock('../src/shared/transaction.js', () => ({ runInTransaction: mockRunInTransaction }));

let isEnabled: typeof import('../src/modules/feature-flags/featureFlags.service.js').isEnabled;
let getFlags: typeof import('../src/modules/feature-flags/featureFlags.service.js').getFlags;
let setFlag: typeof import('../src/modules/feature-flags/featureFlags.service.js').setFlag;

beforeAll(async () => {
  ({ isEnabled, getFlags, setFlag } = await import('../src/modules/feature-flags/featureFlags.service.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCache.mockResolvedValue(undefined);
  mockInvalidate.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockRunInTransaction.mockImplementation(async (callback: (tx: { LOCK: { UPDATE: string }; afterCommit: typeof mockAfterCommit }) => unknown) =>
    callback({ LOCK: { UPDATE: 'UPDATE' }, afterCommit: mockAfterCommit }),
  );
});

describe('featureFlags.service', () => {
  it('uses cached values and defaults absent flags to false', async () => {
    mockGetCached.mockResolvedValue({ enabled_feature: true });

    await expect(isEnabled('tenant-a', 'enabled_feature')).resolves.toBe(true);
    await expect(isEnabled('tenant-a', 'unlisted_feature')).resolves.toBe(false);
    expect(mockTenant.findByPk).not.toHaveBeenCalled();
  });

  it('loads and caches tenant flags when no cache entry exists', async () => {
    mockGetCached.mockResolvedValue(null);
    mockTenant.findByPk.mockResolvedValue({ featureFlags: { beta_mode: true } });

    await expect(getFlags('tenant-a')).resolves.toEqual({ beta_mode: true });
    expect(mockTenant.findByPk).toHaveBeenCalledWith('tenant-a', { attributes: ['id', 'featureFlags'] });
    expect(mockCache).toHaveBeenCalledWith('tenant-a', { beta_mode: true });
  });

  it('rejects a missing tenant instead of treating it as an all-disabled tenant', async () => {
    mockGetCached.mockResolvedValue(null);
    mockTenant.findByPk.mockResolvedValue(null);

    await expect(getFlags('missing')).rejects.toMatchObject({ code: 'ERR-TENANT-NOT-FOUND' });
  });

  it('validates flag names before opening a transaction', async () => {
    await expect(setFlag('tenant-a', 'Bad Flag', true, { userId: 'admin-1', role: 'SYSTEM_ADMIN' }))
      .rejects.toBeDefined();
    expect(mockRunInTransaction).not.toHaveBeenCalled();
  });

  it('updates, audits and invalidates cache only after commit', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    mockTenant.findByPk.mockResolvedValue({ featureFlags: { old_feature: true }, update });

    await expect(setFlag('tenant-a', 'new_feature', true, { userId: 'admin-1', role: 'SYSTEM_ADMIN' }))
      .resolves.toEqual({ old_feature: true, new_feature: true });

    expect(update).toHaveBeenCalledWith(
      { featureFlags: { old_feature: true, new_feature: true } },
      expect.objectContaining({ transaction: expect.anything() }),
    );
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'FEATURE_FLAG_UPDATED', tenantId: 'tenant-a', userId: 'admin-1',
      actionDetails: { tenantId: 'tenant-a', flagName: 'new_feature', enabled: true },
    }));
    expect(mockInvalidate).not.toHaveBeenCalled();
    (mockAfterCommit.mock.calls[0][0] as () => void)();
    await Promise.resolve();
    expect(mockInvalidate).toHaveBeenCalledWith('tenant-a');
  });
});
