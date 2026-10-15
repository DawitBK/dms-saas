export {};

// TEST-3: tenant visibility is the multi-tenant boundary for the platform
// management UI. Test both the membership union and the intentional
// platform-admin bypass against the real service function.
const mockTenant = { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() };
const mockUserTenant = { findAll: jest.fn(), create: jest.fn() };

jest.mock('../src/infrastructure/database/index.js', () => ({
  Tenant: mockTenant,
  Document: { count: jest.fn() },
  OrgUnit: { create: jest.fn() },
  Department: { create: jest.fn() },
  DocumentType: { create: jest.fn() },
  RetentionPolicy: { findOrCreate: jest.fn() },
  DocumentStatusActionRole: { create: jest.fn() },
  UserTenant: mockUserTenant,
  User: { findByPk: jest.fn() },
  sequelize: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: jest.fn() }));

let listTenants: typeof import('../src/modules/tenants/tenants.service.js').listTenants;

beforeAll(async () => {
  ({ listTenants } = await import('../src/modules/tenants/tenants.service.js'));
});

beforeEach(() => jest.clearAllMocks());

describe('tenants.service.listTenants', () => {
  it('uses the caller memberships plus the active JWT tenant, with no duplicates', async () => {
    mockUserTenant.findAll.mockResolvedValue([{ tenantId: 'tenant-b' }, { tenantId: 'tenant-a' }]);
    mockTenant.findAll.mockResolvedValue([]);

    await listTenants('tenant-a', 'user-1');

    expect(mockUserTenant.findAll).toHaveBeenCalledWith({ where: { userId: 'user-1' }, attributes: ['tenantId'] });
    expect(mockTenant.findAll).toHaveBeenCalledWith({
      where: { id: ['tenant-a', 'tenant-b'] },
      order: [['name', 'ASC']],
    });
  });

  it('lets a platform admin see all tenants without consulting membership rows', async () => {
    mockTenant.findAll.mockResolvedValue([]);

    await listTenants('tenant-a', 'platform-admin', true);

    expect(mockUserTenant.findAll).not.toHaveBeenCalled();
    expect(mockTenant.findAll).toHaveBeenCalledWith({ order: [['name', 'ASC']] });
  });
});
