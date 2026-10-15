export {};

// TEST-3 / COMP-2 regression: department membership affects ACL resolution,
// so the grant must be atomic with its audit trail and invalidate cached
// department membership only after the transaction commits.
const mockDepartment = { findOne: jest.fn() };
const mockUserDepartment = { findOrCreate: jest.fn(), destroy: jest.fn() };
const mockWriteAuditLog = jest.fn();
const mockInvalidateDepartments = jest.fn();
const mockRunInTransaction = jest.fn();
const mockAfterCommit = jest.fn();

jest.mock('../src/infrastructure/database/index.js', () => ({
  Department: mockDepartment, Role: {}, User: {}, UserDepartment: mockUserDepartment,
  UserRole: {}, UserTenant: {}, Document: {}, AuthSession: {}, DocLock: {},
  DocumentCheckout: {}, ApprovalStep: {}, ApprovalChain: {}, AuditStageReview: {},
  LetterApprovalStep: {}, Letter: {}, WorkflowTask: {}, WorkflowInstance: {},
  SignatureRecipient: {}, SignatureRequest: {},
}));
jest.mock('../src/modules/notifications/notifications.service.js', () => ({ fanOut: jest.fn() }));
jest.mock('../src/modules/audit/audit.service.js', () => ({ writeAuditLog: mockWriteAuditLog }));
jest.mock('../src/infrastructure/cache/userDeptCache.js', () => ({ invalidateUserDepartments: mockInvalidateDepartments }));
jest.mock('../src/shared/auth.js', () => ({ revokeAllUserSessions: jest.fn() }));
jest.mock('../src/shared/transaction.js', () => ({ runInSavepoint: jest.fn(), runInTransaction: mockRunInTransaction }));
jest.mock('../src/modules/roles/roles.service.js', () => ({ getMaxRolePermissionsAcrossTenants: jest.fn() }));
jest.mock('../src/core/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

let assignDepartment: typeof import('../src/modules/users/users.service.js').assignDepartment;

beforeAll(async () => {
  ({ assignDepartment } = await import('../src/modules/users/users.service.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockInvalidateDepartments.mockResolvedValue(undefined);
  mockDepartment.findOne.mockResolvedValue({ id: 'department-1', tenantId: 'tenant-1' });
  mockUserDepartment.findOrCreate.mockResolvedValue([{ id: 'membership-1' }]);
  mockRunInTransaction.mockImplementation(async (callback: (tx: { afterCommit: typeof mockAfterCommit }) => unknown) =>
    callback({ afterCommit: mockAfterCommit }),
  );
});

describe('users.service.assignDepartment', () => {
  it('creates and audit-records the grant inside the same transaction', async () => {
    await expect(assignDepartment('user-1', 'department-1', 'tenant-1', 'admin-1')).resolves.toEqual({ id: 'membership-1' });

    expect(mockUserDepartment.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', departmentId: 'department-1' },
      defaults: { userId: 'user-1', departmentId: 'department-1' },
    }));
    expect(mockWriteAuditLog).toHaveBeenCalledWith({
      eventType: 'USER_DEPT_ASSIGNED',
      userId: 'admin-1',
      actionDetails: { targetUserId: 'user-1', departmentId: 'department-1' },
    });
  });

  it('defers cache invalidation until after the transaction commits', async () => {
    await assignDepartment('user-1', 'department-1', 'tenant-1', 'admin-1');

    expect(mockAfterCommit).toHaveBeenCalledTimes(1);
    expect(mockInvalidateDepartments).not.toHaveBeenCalled();
    const callback = mockAfterCommit.mock.calls[0][0] as () => void;
    callback();
    await Promise.resolve();
    expect(mockInvalidateDepartments).toHaveBeenCalledWith('tenant-1', 'user-1');
  });
});
