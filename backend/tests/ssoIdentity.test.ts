/**
 * SSO -> DMS identity and role reconciliation (modules/auth/ssoIdentity.ts).
 * Every case here is one row of Documentations/SSO-DMS-SYNC-AND-CONFLICT-RULES.md.
 * The database is mocked; the shape of each query is asserted where it matters.
 */

const PA_ID = '00000000-0000-0000-0000-00000000aaaa';

const mockFindOne = jest.fn();
const mockFindAll = jest.fn();
const mockCreate = jest.fn();
const mockTenantCreate = jest.fn();
const mockQuery = jest.fn();
const mockAudit = jest.fn();
const mockPaIds = jest.fn();

jest.mock('../src/infrastructure/database/index.js', () => ({
  User: {
    findOne: (...a: unknown[]) => mockFindOne(...a),
    findAll: (...a: unknown[]) => mockFindAll(...a),
    create: (...a: unknown[]) => mockCreate(...a),
  },
  UserTenant: { create: (...a: unknown[]) => mockTenantCreate(...a) },
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('../src/shared/transaction.js', () => ({
  runInTransaction: async (fn: (t: unknown) => unknown) => fn({}),
}));
jest.mock('../src/modules/audit/audit.service.js', () => ({
  writeAuditLog: (...a: unknown[]) => mockAudit(...a),
}));
jest.mock('../src/shared/platformAdmin.js', () => ({
  PLATFORM_ADMIN_ROLE: 'PLATFORM_ADMIN',
  getPlatformAdminUserIds: () => mockPaIds(),
}));

import { UniqueConstraintError } from 'sequelize';
import {
  assertMappableRoleNames,
  filterToKnownRoles,
  resolveEffectiveRoles,
  resolveOidcUser,
  sameRoleSet,
} from '../src/modules/auth/ssoIdentity.js';

const TENANT = 'examplecorp';
const identity = { externalSub: 'sub-1', email: 'Alice@ExampleCorp.com', givenName: 'Alice', familyName: 'A' };

function row(over: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = {
    id: 'u-1',
    email: 'alice@examplecorp.com',
    externalSub: null,
    isActive: true,
    ...over,
  };
  r.update = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(r, patch);
    return r;
  });
  return r as any;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockPaIds.mockResolvedValue([]);
  mockAudit.mockResolvedValue(undefined);
  mockTenantCreate.mockResolvedValue(undefined);
});

describe('resolveOidcUser: which DMS account is this identity?', () => {
  it('matches on sub first and touches nothing when the email is unchanged (case-insensitively)', async () => {
    const u = row({ externalSub: 'sub-1', email: 'alice@examplecorp.com' });
    mockFindOne.mockResolvedValueOnce(u);
    const out = await resolveOidcUser(identity, TENANT);
    expect(out).toBe(u);
    expect(u.update).not.toHaveBeenCalled();
    expect(mockFindAll).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('adopts a legacy account whose email differs only by case, once, and audits the link', async () => {
    const legacy = row({ id: 'legacy', email: 'Alice@EXAMPLECORP.com', externalSub: null });
    mockFindOne.mockResolvedValueOnce(null);
    mockFindAll.mockResolvedValueOnce([legacy]);
    const out = await resolveOidcUser(identity, TENANT);
    expect(out).toBe(legacy);
    expect(legacy.update).toHaveBeenCalledWith({ externalSub: 'sub-1' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SSO_ACCOUNT_LINKED', userId: 'legacy', tenantId: TENANT }));
  });

  it('refuses (409) when the email is already bound to a DIFFERENT IdP subject', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockFindAll.mockResolvedValueOnce([row({ externalSub: 'someone-else' })]);
    await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 409, code: 'ERR-OIDC-SUBJECT-CONFLICT' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses (409) when two DMS rows match the email ignoring case - it will not guess', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockFindAll.mockResolvedValueOnce([row({ id: 'a', email: 'alice@examplecorp.com' }), row({ id: 'b', email: 'ALICE@examplecorp.com' })]);
    await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 409, code: 'ERR-OIDC-EMAIL-AMBIGUOUS' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('adoption that loses a race to a concurrent callback returns the winner instead of a 500', async () => {
    const legacy = row({ externalSub: null });
    legacy.update.mockRejectedValueOnce(new UniqueConstraintError({}));
    const winner = row({ id: 'winner', externalSub: 'sub-1' });
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mockFindAll.mockResolvedValueOnce([legacy]);
    expect(await resolveOidcUser(identity, TENANT)).toBe(winner);
  });

  describe('the IdP changed the address of a known sub', () => {
    it('follows it (lower-cased) and audits old and new value', async () => {
      const u = row({ externalSub: 'sub-1', email: 'old.name@examplecorp.com' });
      mockFindOne.mockResolvedValueOnce(u);
      mockFindAll.mockResolvedValueOnce([u]); // the CI lookup finds only the user itself
      await resolveOidcUser(identity, TENANT);
      expect(u.update).toHaveBeenCalledWith({ email: 'alice@examplecorp.com' });
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SSO_EMAIL_UPDATED', previousState: 'old.name@examplecorp.com', newState: 'alice@examplecorp.com' }),
      );
    });

    it('refuses (409) instead of crashing on the unique index when another account already holds the new address', async () => {
      const u = row({ id: 'me', externalSub: 'sub-1', email: 'old@examplecorp.com' });
      mockFindOne.mockResolvedValueOnce(u);
      mockFindAll.mockResolvedValueOnce([row({ id: 'other', email: 'ALICE@examplecorp.com' })]);
      await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 409, code: 'ERR-OIDC-EMAIL-CONFLICT' });
      expect(u.update).not.toHaveBeenCalled();
    });

    it('maps a unique violation that slips past the pre-check to the same 409', async () => {
      const u = row({ id: 'me', externalSub: 'sub-1', email: 'old@examplecorp.com' });
      u.update.mockRejectedValueOnce(new UniqueConstraintError({}));
      mockFindOne.mockResolvedValueOnce(u);
      mockFindAll.mockResolvedValueOnce([]);
      await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 409, code: 'ERR-OIDC-EMAIL-CONFLICT' });
    });

    it('never renames the platform admin (the database would refuse and the login would 500)', async () => {
      const u = row({ id: PA_ID, externalSub: 'sub-1', email: 'pseudonym@platform.invalid' });
      mockPaIds.mockResolvedValue([PA_ID]);
      mockFindOne.mockResolvedValueOnce(u);
      const out = await resolveOidcUser(identity, TENANT);
      expect(out).toBe(u);
      expect(u.update).not.toHaveBeenCalled();
      expect(mockFindAll).not.toHaveBeenCalled();
    });
  });

  describe('first sign-in with no matching account (JIT provisioning)', () => {
    it('creates a lower-cased, unlinked-password, tenant-member account and audits it', async () => {
      const created = row({ id: 'new' });
      mockFindOne.mockResolvedValueOnce(null);
      mockFindAll.mockResolvedValueOnce([]);
      mockCreate.mockResolvedValueOnce(created);
      const out = await resolveOidcUser(identity, TENANT);
      expect(out).toBe(created);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'alice@examplecorp.com', externalSub: 'sub-1', isActive: true, firstName: 'Alice', lastName: 'A' }),
      );
      const arg = mockCreate.mock.calls[0][0];
      expect(typeof arg.passwordHash).toBe('string');
      expect(mockTenantCreate).toHaveBeenCalledWith({ userId: 'new', tenantId: TENANT, assignedBy: null });
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SSO_USER_PROVISIONED', userId: 'new' }));
    });

    it('two concurrent first logins: the loser reuses the winner row rather than failing', async () => {
      const winner = row({ id: 'winner', externalSub: 'sub-1' });
      mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      mockFindAll.mockResolvedValueOnce([]);
      mockCreate.mockRejectedValueOnce(new UniqueConstraintError({}));
      expect(await resolveOidcUser(identity, TENANT)).toBe(winner);
      expect(mockAudit).not.toHaveBeenCalled();
    });

    it('a unique violation on EMAIL (no row with this sub) is a 409, not a 500 and not a takeover', async () => {
      mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockFindAll.mockResolvedValueOnce([]);
      mockCreate.mockRejectedValueOnce(new UniqueConstraintError({}));
      await expect(resolveOidcUser(identity, TENANT)).rejects.toMatchObject({ statusCode: 409, code: 'ERR-OIDC-EMAIL-CONFLICT' });
    });

    it('lets any non-unique database error through unchanged', async () => {
      mockFindOne.mockResolvedValueOnce(null);
      mockFindAll.mockResolvedValueOnce([]);
      mockCreate.mockRejectedValueOnce(new Error('connection lost'));
      await expect(resolveOidcUser(identity, TENANT)).rejects.toThrow('connection lost');
    });
  });
});

describe('filterToKnownRoles: a role DMS does not have never reaches the token', () => {
  it('keeps known names, drops unknown ones, de-duplicates, preserves order', async () => {
    mockQuery.mockResolvedValueOnce([{ name: 'SYSTEM_ADMIN' }, { name: 'EMPLOYEE' }]);
    expect(await filterToKnownRoles(['SYSTEM_ADMIN', 'GHOST', 'EMPLOYEE', 'SYSTEM_ADMIN'])).toEqual(['SYSTEM_ADMIN', 'EMPLOYEE']);
    expect(mockQuery.mock.calls[0][1].bind).toEqual([['SYSTEM_ADMIN', 'GHOST', 'EMPLOYEE']]);
  });

  it('asks the database nothing for an empty assertion', async () => {
    expect(await filterToKnownRoles([])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns [] when nothing is known, so the caller falls back to the local roles', async () => {
    mockQuery.mockResolvedValueOnce([]);
    expect(await filterToKnownRoles(['GHOST'])).toEqual([]);
  });
});

describe('resolveEffectiveRoles: SSO assertion versus a local DMS edit', () => {
  const base = { idpRoles: ['APPROVER'], localRoles: ['EMPLOYEE'], rolesManagedLocally: false, ssoRolesSnapshot: null };

  it('SSO wins by default and is mirrored into user_roles', () => {
    expect(resolveEffectiveRoles(base)).toMatchObject({ allRoles: ['APPROVER'], action: 'sync-idp', localOverrideActive: false });
  });

  it('a local edit stands while the SSO assertion is unchanged since the last time it won', () => {
    const r = resolveEffectiveRoles({ ...base, localRoles: ['SYSTEM_ADMIN'], rolesManagedLocally: true, ssoRolesSnapshot: ['APPROVER'] });
    expect(r).toMatchObject({ allRoles: ['SYSTEM_ADMIN'], action: 'keep-local', localOverrideActive: true, recordSnapshot: false });
  });

  it('a genuine SSO change wins over the local edit', () => {
    const r = resolveEffectiveRoles({ ...base, idpRoles: ['AUDITOR'], localRoles: ['SYSTEM_ADMIN'], rolesManagedLocally: true, ssoRolesSnapshot: ['APPROVER'] });
    expect(r).toMatchObject({ allRoles: ['AUDITOR'], action: 'sync-idp', localOverrideActive: false });
  });

  it('a local edit with no recorded baseline stands and records the baseline (it used to be wiped at the next login)', () => {
    const r = resolveEffectiveRoles({ ...base, localRoles: ['SYSTEM_ADMIN'], rolesManagedLocally: true, ssoRolesSnapshot: null });
    expect(r).toMatchObject({ allRoles: ['SYSTEM_ADMIN'], action: 'keep-local', localOverrideActive: true, recordSnapshot: true });
  });

  it('does not try to record a baseline when SSO asserted nothing', () => {
    const r = resolveEffectiveRoles({ ...base, idpRoles: [], localRoles: ['SYSTEM_ADMIN'], rolesManagedLocally: true, ssoRolesSnapshot: null });
    expect(r.recordSnapshot).toBe(false);
  });

  it('no SSO assertion (SSO down, claim omitted, or every name unknown) keeps the local roles - never strips', () => {
    expect(resolveEffectiveRoles({ ...base, idpRoles: [], localRoles: ['SYSTEM_ADMIN'] })).toMatchObject({ allRoles: ['SYSTEM_ADMIN'], action: 'keep-local' });
  });

  it('nothing anywhere: first provision gets EMPLOYEE and it is written', () => {
    expect(resolveEffectiveRoles({ ...base, idpRoles: [], localRoles: [] })).toMatchObject({ allRoles: ['EMPLOYEE'], action: 'seed-default' });
  });

  it('a managed flag with no local rows does not pin an empty role set', () => {
    expect(resolveEffectiveRoles({ ...base, localRoles: [], rolesManagedLocally: true, ssoRolesSnapshot: ['APPROVER'] })).toMatchObject({
      allRoles: ['APPROVER'],
      action: 'sync-idp',
    });
  });

  describe('platform admin is outside the exchange in both directions', () => {
    it('a claim naming PLATFORM_ADMIN cannot grant it to anyone else', () => {
      const r = resolveEffectiveRoles({ ...base, idpRoles: ['PLATFORM_ADMIN', 'APPROVER'] });
      expect(r.allRoles).toEqual(['APPROVER']);
      expect(r.allRoles).not.toContain('PLATFORM_ADMIN');
    });

    it('a claim naming ONLY PLATFORM_ADMIN grants nothing (falls back to local roles)', () => {
      const r = resolveEffectiveRoles({ ...base, idpRoles: ['PLATFORM_ADMIN'] });
      expect(r).toMatchObject({ allRoles: ['EMPLOYEE'], action: 'keep-local' });
    });

    it('an account that holds it keeps it when the claim says nothing about it', () => {
      const r = resolveEffectiveRoles({ ...base, idpRoles: ['APPROVER'], localRoles: ['PLATFORM_ADMIN'] });
      expect(r.allRoles).toEqual(['PLATFORM_ADMIN', 'APPROVER']);
    });

    it('an account that holds it keeps it when the claim is empty', () => {
      const r = resolveEffectiveRoles({ ...base, idpRoles: [], localRoles: ['PLATFORM_ADMIN'] });
      expect(r.allRoles).toEqual(['PLATFORM_ADMIN']);
    });

    it('a downgraded claim for the holder still cannot remove it from the issued set', () => {
      const r = resolveEffectiveRoles({ ...base, idpRoles: ['EMPLOYEE'], localRoles: ['PLATFORM_ADMIN', 'SYSTEM_ADMIN'], rolesManagedLocally: true, ssoRolesSnapshot: ['SYSTEM_ADMIN'] });
      expect(r.allRoles).toContain('PLATFORM_ADMIN');
    });
  });
});

describe('sameRoleSet', () => {
  it('is order-independent and null-safe', () => {
    expect(sameRoleSet(['A', 'B'], ['B', 'A'])).toBe(true);
    expect(sameRoleSet(['A'], ['A', 'B'])).toBe(false);
    expect(sameRoleSet([], null)).toBe(false);
  });
});

describe('assertMappableRoleNames: what a group -> role mapping may name', () => {
  it('accepts existing roles and collapses duplicates', async () => {
    mockQuery.mockResolvedValueOnce([{ name: 'APPROVER' }, { name: 'AUDITOR' }]);
    expect(await assertMappableRoleNames(['APPROVER', 'AUDITOR', 'APPROVER'])).toEqual(['APPROVER', 'AUDITOR']);
  });

  it('rejects a role DMS does not have (422 ERR-ROLE-NOT-FOUND) instead of storing a dead mapping', async () => {
    mockQuery.mockResolvedValueOnce([{ name: 'APPROVER' }]);
    await expect(assertMappableRoleNames(['APPROVER', 'GHOST'])).rejects.toMatchObject({
      statusCode: 422,
      code: 'ERR-ROLE-NOT-FOUND',
      message: expect.stringContaining('GHOST'),
    });
  });

  it('an empty list unmaps the group and costs no query', async () => {
    expect(await assertMappableRoleNames([])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('PLATFORM_ADMIN can never be mapped, whatever else is in the list, and the answer is generic', async () => {
    await expect(assertMappableRoleNames(['APPROVER', 'PLATFORM_ADMIN'])).rejects.toMatchObject({
      statusCode: 422,
      code: 'ERR-ROLE-INVALID',
      message: 'One or more roles are not valid',
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
