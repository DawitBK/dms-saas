/**
 * The platform administrator is invisible and untouchable (shared/platformAdmin.ts).
 * These pin the application-layer rule; the database layer is proved against a
 * real database by test-scripts/verify-platform-admin.ts.
 */

const PA = '00000000-0000-0000-0000-00000000aaaa';
const OTHER_PA = '00000000-0000-0000-0000-00000000aaab';
const USER = '00000000-0000-0000-0000-00000000bbbb';

const mockQuery = jest.fn();
jest.mock('../src/infrastructure/database/sequelize.js', () => ({
  sequelize: { query: (...a: unknown[]) => mockQuery(...a) },
}));

import { Op } from 'sequelize';
import {
  PLATFORM_ADMIN_ROLE,
  actorIsPlatformAdmin,
  assertNotHiddenUser,
  excludeHiddenWhere,
  getPlatformAdminUserIds,
  guardPlatformAdminTarget,
  hiddenUserIds,
  invalidatePlatformAdminCache,
  isHiddenUser,
  isPlatformAdminRoleName,
  maskHiddenUsersDeep,
  notPlatformAdminSql,
  restrictAuditToVisibleActors,
  withoutHiddenIds,
  withoutPlatformAdminRole,
} from '../src/shared/platformAdmin.js';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([{ user_id: PA }, { user_id: OTHER_PA }]);
  invalidatePlatformAdminCache();
});

describe('who is hidden', () => {
  it('lists every platform admin, and caches the answer briefly', async () => {
    expect(await getPlatformAdminUserIds()).toEqual([PA, OTHER_PA]);
    await getPlatformAdminUserIds();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    invalidatePlatformAdminCache();
    await getPlatformAdminUserIds();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('hides every platform admin from an ordinary user', async () => {
    expect(await hiddenUserIds(USER)).toEqual([PA, OTHER_PA]);
    expect(await isHiddenUser(PA, USER)).toBe(true);
    expect(await isHiddenUser(USER, USER)).toBe(false);
  });

  it('lets a platform admin see only itself, never another platform admin', async () => {
    expect(await isHiddenUser(PA, PA)).toBe(false);
    expect(await isHiddenUser(OTHER_PA, PA)).toBe(true);
  });

  it('with no viewer, everything is hidden', async () => {
    expect(await hiddenUserIds()).toEqual([PA, OTHER_PA]);
  });

  it('assertNotHiddenUser answers 404 "User not found", the same as a missing id', async () => {
    await expect(assertNotHiddenUser(PA, USER)).rejects.toMatchObject({ statusCode: 404, code: 'ERR-USER-NOT-FOUND', message: 'User not found' });
    await expect(assertNotHiddenUser(USER, USER)).resolves.toBeUndefined();
    await expect(assertNotHiddenUser(PA, PA)).resolves.toBeUndefined();
  });

  it('removes hidden ids from a candidate list', async () => {
    expect(await withoutHiddenIds([USER, PA, OTHER_PA], USER)).toEqual([USER]);
    expect(await withoutHiddenIds([USER, PA], PA)).toEqual([USER, PA]);
    expect(await withoutHiddenIds([], USER)).toEqual([]);
  });
});

describe('query fragments', () => {
  it('builds a notIn where-clause, or nothing when nobody is hidden', () => {
    expect(excludeHiddenWhere([PA])).toEqual({ id: { [Op.notIn]: [PA] } });
    expect(excludeHiddenWhere([PA], 'userId')).toEqual({ userId: { [Op.notIn]: [PA] } });
    expect(excludeHiddenWhere([])).toEqual({});
  });

  it('builds a SQL predicate that refers to the role by name, not by a value a caller supplies', () => {
    const sql = notPlatformAdminSql('u.id');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('u.id');
    expect(sql).toContain(`'${PLATFORM_ADMIN_ROLE}'`);
  });

  it('narrows an audit where-clause to visible actors, keeping rows with no actor', async () => {
    const where: Record<string | symbol, unknown> = { tenantId: 't1', [Op.and]: [{ eventType: 'X' }] };
    await restrictAuditToVisibleActors(where, USER);
    const and = where[Op.and] as unknown[];
    expect(and).toHaveLength(2);
    expect(and[1]).toEqual({ [Op.or]: [{ userId: null }, { userId: { [Op.notIn]: [PA, OTHER_PA] } }] });
  });

  it('leaves an audit where-clause alone when nobody is hidden', async () => {
    mockQuery.mockResolvedValue([]);
    invalidatePlatformAdminCache();
    const where: Record<string | symbol, unknown> = { tenantId: 't1' };
    await restrictAuditToVisibleActors(where, USER);
    expect(Object.getOwnPropertySymbols(where)).toHaveLength(0);
  });
});

describe('the role', () => {
  it('is recognised by name and filtered out of every role list', () => {
    expect(isPlatformAdminRoleName('PLATFORM_ADMIN')).toBe(true);
    expect(isPlatformAdminRoleName('SYSTEM_ADMIN')).toBe(false);
    expect(isPlatformAdminRoleName(null)).toBe(false);
    const roles = [{ name: 'SYSTEM_ADMIN' }, { name: 'PLATFORM_ADMIN' }, { name: 'EMPLOYEE' }];
    expect(withoutPlatformAdminRole(roles).map((r) => r.name)).toEqual(['SYSTEM_ADMIN', 'EMPLOYEE']);
  });

  it('actorIsPlatformAdmin reads the permission, not a role name', () => {
    expect(actorIsPlatformAdmin({ permissions: ['platform:admin'] })).toBe(true);
    expect(actorIsPlatformAdmin({ permissions: ['user:manage'] })).toBe(false);
    expect(actorIsPlatformAdmin(undefined)).toBe(false);
  });
});

describe('guardPlatformAdminTarget (route middleware)', () => {
  const run = async (targetId: string, viewerId: string) => {
    const req: any = { params: { id: targetId }, user: { userId: viewerId } };
    const next = jest.fn();
    await guardPlatformAdminTarget()(req, {} as never, next);
    return next.mock.calls[0]?.[0];
  };

  it('refuses a request that targets a platform admin, as "not found"', async () => {
    expect(await run(PA, USER)).toMatchObject({ statusCode: 404, code: 'ERR-USER-NOT-FOUND' });
  });
  it('lets ordinary targets through', async () => {
    expect(await run(USER, USER)).toBeUndefined();
  });
  it('lets a platform admin act on its own account', async () => {
    expect(await run(PA, PA)).toBeUndefined();
  });
  it('still refuses a platform admin targeting a different platform admin', async () => {
    expect(await run(OTHER_PA, PA)).toMatchObject({ statusCode: 404 });
  });
});

describe('maskHiddenUsersDeep (a record that a platform admin touched must not name them)', () => {
  const fakeModel = (v: Record<string, unknown>) => ({ dataValues: v });

  it('replaces a hidden user record anywhere in the tree, instances and plain objects alike, and blanks bare id columns', async () => {
    const letter = fakeModel({
      id: 'L1',
      creatorId: PA,
      creator: fakeModel({ id: PA, firstName: 'Real', lastName: 'Owner', email: 'owner@example.com' }),
      signatory: { id: USER, firstName: 'Sam', lastName: 'Signer', email: 's@example.com' },
      approvalSteps: [fakeModel({ id: 's1', decidedBy: PA, decidedByUser: fakeModel({ id: PA, firstName: 'Real', lastName: 'Owner', email: 'owner@example.com' }) })],
    });
    await maskHiddenUsersDeep(letter, USER);
    const dv = letter.dataValues as Record<string, any>;
    expect(dv.creatorId).toBeNull();
    expect(dv.creator).toEqual({ id: null, firstName: 'Former', lastName: 'user', email: null });
    expect(dv.signatory.email).toBe('s@example.com');
    expect(dv.approvalSteps[0].dataValues.decidedBy).toBeNull();
    expect(dv.approvalSteps[0].dataValues.decidedByUser.email).toBeNull();
  });

  it('never masks the platform admin from themselves', async () => {
    const letter = fakeModel({ creatorId: PA, creator: { id: PA, firstName: 'Real', lastName: 'Owner', email: 'owner@example.com' } });
    await maskHiddenUsersDeep(letter, PA);
    expect((letter.dataValues as any).creator.email).toBe('owner@example.com');
    expect((letter.dataValues as any).creatorId).toBe(PA);
  });
});
