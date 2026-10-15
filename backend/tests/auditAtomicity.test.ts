export {};

/**
 * Audit durability (ACID) regression — Session 10.
 *
 * Guards the contract established when the fire-and-forget `writeAuditLog(...)`
 * calls were converted to awaited calls: in services that rely on the request
 * CLS transaction (ACL, access-rules, roles, documents, ...), a FAILED audit
 * write must PROPAGATE and fail the operation — it must NOT be silently
 * swallowed the way `.catch(() => {})` used to swallow it.
 *
 * Why this matters: `authenticate`/`tenantContext` run each request inside a
 * CLS transaction (`Sequelize.useCLS()`), so an awaited audit insert joins that
 * transaction. When the audit write throws, the whole request errors out and
 * the transaction rolls back — the domain change never commits without its
 * audit row. This test pins the observable half of that guarantee (propagation,
 * not swallowing) without needing a live database; the rollback itself is the
 * CLS transaction's job and is exercised end-to-end by verify-cams.ts.
 *
 * Pre-fix, every assertion below would FAIL: the service resolved successfully
 * because the audit rejection was caught and discarded.
 */

const mockAclEntry = {
  create: jest.fn(),
  findOne: jest.fn(),
  destroy: jest.fn(),
};

const mockAccessRule = {
  // findOne is the tuple-upsert lookup createAccessRules now runs before
  // create/save (existence check + FOR UPDATE lock, see
  // access-rules.service.ts) — must resolve to null (no existing rule) so
  // the audit-durability path under test still reaches AccessRule.create.
  findOne: jest.fn(),
  create: jest.fn(),
};

// createAclEntry now validates that resourceId/principalId actually belong to
// the caller's own tenant (cross-tenant ACL write fix) before writing — these
// stand in for that lookup, resolving to the same tenant ('t1') the test's
// aclData/createAclEntry calls use, so that validation is a no-op here and
// the audit-durability behavior under test is unaffected.
const mockDocument = { findByPk: jest.fn().mockResolvedValue({ tenantId: 't1' }) };
const mockUserTenant = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }) };

jest.mock('../src/infrastructure/database/models/index.js', () => ({
  AclEntry: mockAclEntry,
  AccessRule: mockAccessRule,
  Document: mockDocument,
  FolderNode: { findByPk: jest.fn() },
  Department: { findByPk: jest.fn() },
  WorkflowInstance: { findByPk: jest.fn() },
  WorkflowTask: { findByPk: jest.fn() },
  UserTenant: mockUserTenant,
}));

// createAccessRules wraps its per-permission loop in sequelize.transaction —
// no real commit/rollback distinction needed here, just invoke the callback.
const mockSequelize = {
  transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    // createAccessRules now does a locked findOne (FOR UPDATE) as part of its
    // tuple-upsert existence check, so the fake transaction object needs a
    // LOCK.UPDATE token too, not just afterCommit.
    callback({ afterCommit: (fn: () => void) => fn(), LOCK: { UPDATE: 'UPDATE' } }),
  ),
};
jest.mock('../src/infrastructure/database/index.js', () => ({
  sequelize: mockSequelize,
}));

const mockInvalidateResourceACL = jest.fn();
jest.mock('../src/infrastructure/cache/aclCache.js', () => ({
  invalidateResourceACL: mockInvalidateResourceACL,
}));

// The unit under test: writeAuditLog is mocked so we can force it to reject.
// AUDIT_EVENTS is imported by the services from auditEvents.js (a plain const
// map), so it loads for real — no need to mock it.
const mockWriteAuditLog = jest.fn();
jest.mock('../src/modules/audit/audit.service.js', () => ({
  writeAuditLog: mockWriteAuditLog,
}));

jest.mock('../src/core/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let createAclEntry: typeof import('../src/modules/acl/acl.service.js').createAclEntry;
let deleteAclEntry: typeof import('../src/modules/acl/acl.service.js').deleteAclEntry;
let createAccessRules: typeof import('../src/modules/access-rules/access-rules.service.js').createAccessRules;

beforeAll(async () => {
  const acl = await import('../src/modules/acl/acl.service.js');
  createAclEntry = acl.createAclEntry;
  deleteAclEntry = acl.deleteAclEntry;
  const rules = await import('../src/modules/access-rules/access-rules.service.js');
  createAccessRules = rules.createAccessRules;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAclEntry.create.mockResolvedValue({ id: 'acl-1' });
  // Two different lookups share this mock: createAclEntry's own pre-existing-
  // grant check (queries by the full grant tuple, no `id` key — must resolve
  // null here so the audit-durability path under test still reaches
  // AclEntry.create) and deleteAclEntry's getAclEntry lookup (queries by
  // `id`, and needs a row back so there's something to delete/audit).
  mockAclEntry.findOne.mockImplementation((opts: any) => {
    if (opts?.where?.id) {
      return Promise.resolve({
        id: 'acl-1',
        resourceType: 'document',
        resourceId: 'doc-1',
        principalType: 'user',
        principalId: 'u1',
        permission: 'document:read',
        effect: 'ALLOW',
      });
    }
    return Promise.resolve(null);
  });
  mockAclEntry.destroy.mockResolvedValue(1);
  mockAccessRule.findOne.mockResolvedValue(null);
  mockAccessRule.create.mockResolvedValue({ id: 'rule-1' });
  mockInvalidateResourceACL.mockResolvedValue(undefined);
  mockWriteAuditLog.mockResolvedValue(undefined);
});

const aclData = {
  principalType: 'user' as const,
  principalId: 'u1',
  effect: 'ALLOW' as const,
  permission: 'document:read',
};

describe('Audit durability (ACID): failed audit write fails the operation', () => {
  describe('control — audit write is awaited on the happy path', () => {
    it('createAclEntry resolves and awaits exactly one audit write', async () => {
      const entry = await createAclEntry('document', 'doc-1', aclData, 'admin-1', 't1');
      expect(entry).toEqual({ id: 'acl-1' });
      expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('createAclEntry', () => {
    it('rejects (not swallows) when the audit write fails', async () => {
      mockAclEntry.create.mockResolvedValue({ id: 'acl-1' });
      mockWriteAuditLog.mockRejectedValue(new Error('audit chain write failed'));

      // Propagates the REAL error, not a wrapped generic one — acl.service.ts's
      // catch blocks only add logging context and rethrow, so errorHandler's
      // central classifiers (not a local catch-all) decide the eventual status
      // code for whatever the real failure turns out to be.
      await expect(
        createAclEntry('document', 'doc-1', aclData, 'admin-1', 't1'),
      ).rejects.toThrow('audit chain write failed');

      // The domain write was attempted, but the operation as a whole still fails —
      // it does not return a "success" while dropping the audit record.
      expect(mockAclEntry.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteAclEntry', () => {
    it('rejects (not swallows) when the audit write fails', async () => {
      mockWriteAuditLog.mockRejectedValue(new Error('audit chain write failed'));

      await expect(
        deleteAclEntry('acl-1', 't1', 'admin-1'),
      ).rejects.toThrow('audit chain write failed');

      expect(mockAclEntry.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('createAccessRules', () => {
    it('rejects (not swallows) when the audit write fails', async () => {
      mockWriteAuditLog.mockRejectedValue(new Error('audit chain write failed'));

      await expect(
        createAccessRules({ ...aclData, permissions: ['document:read'] }, 'admin-1', 't1'),
      ).rejects.toThrow('audit chain write failed');

      expect(mockAccessRule.create).toHaveBeenCalledTimes(1);
    });
  });
});
