import { describe, expect, it } from 'vitest';
import {
  allowedScopeKinds, hasOrgLevelAuthority, initialScope, scopeBadgeText, scopePayload, scopeProblem,
} from './templateScope';

const can = (...granted: string[]) => (p: string) => granted.includes(p);

describe('hasOrgLevelAuthority', () => {
  it('is true for any of acl:bypass_admin, orgunit:manage, document:read_all', () => {
    expect(hasOrgLevelAuthority(can('acl:bypass_admin'))).toBe(true);
    expect(hasOrgLevelAuthority(can('orgunit:manage'))).toBe(true);
    expect(hasOrgLevelAuthority(can('document:read_all'))).toBe(true);
  });
  it('is false for an ordinary form author', () => {
    expect(hasOrgLevelAuthority(can('formtemplate:manage', 'document:read'))).toBe(false);
  });
});

describe('allowedScopeKinds', () => {
  it('offers only Department without organisation-level authority', () => {
    expect(allowedScopeKinds(false)).toEqual(['department']);
    expect(allowedScopeKinds(true)).toEqual(['organisation', 'orgunit', 'department']);
  });
});

describe('scopePayload / scopeProblem', () => {
  it('sends both ids null for the whole organisation, and only the chosen one otherwise', () => {
    expect(scopePayload({ kind: 'organisation', orgUnitId: 'u', departmentId: 'd' })).toEqual({ departmentId: null, orgUnitId: null });
    expect(scopePayload({ kind: 'orgunit', orgUnitId: 'u', departmentId: 'd' })).toEqual({ departmentId: null, orgUnitId: 'u' });
    expect(scopePayload({ kind: 'department', orgUnitId: 'u', departmentId: 'd' })).toEqual({ departmentId: 'd', orgUnitId: null });
  });
  it('flags a department or unit scope with nothing chosen', () => {
    expect(scopeProblem({ kind: 'department', orgUnitId: '', departmentId: '' })).toMatch(/department/i);
    expect(scopeProblem({ kind: 'orgunit', orgUnitId: '', departmentId: '' })).toMatch(/unit/i);
    expect(scopeProblem({ kind: 'organisation', orgUnitId: '', departmentId: '' })).toBeNull();
  });
});

describe('initialScope', () => {
  it('defaults an organisation-level author to the whole organisation and anyone else to a department', () => {
    expect(initialScope(undefined, true).kind).toBe('organisation');
    expect(initialScope(undefined, false, 'only-dept')).toEqual({ kind: 'department', orgUnitId: '', departmentId: 'only-dept' });
  });
  it('re-opens a saved scope, but never an organisation scope for a department-only author', () => {
    expect(initialScope({ departmentId: 'd1', orgUnitId: null }, false).departmentId).toBe('d1');
    expect(initialScope({ departmentId: null, orgUnitId: null }, false).kind).toBe('department');
    expect(initialScope({ departmentId: null, orgUnitId: 'u1' }, true)).toEqual({ kind: 'orgunit', orgUnitId: 'u1', departmentId: '' });
  });
});

describe('scopeBadgeText', () => {
  const depts = [{ id: 'd1', code: 'HR', name: 'Human Resources' }];
  const units = [{ id: 'u1', code: 'HQ', name: 'Head Office' }];
  it('names the scope', () => {
    expect(scopeBadgeText({ departmentId: null, orgUnitId: null }, depts, units)).toBe('Whole organisation');
    expect(scopeBadgeText({ departmentId: 'd1' }, depts, units)).toBe('Dept: HR - Human Resources');
    expect(scopeBadgeText({ orgUnitId: 'u1' }, depts, units)).toBe('Unit: Head Office');
  });
  it('degrades gracefully when the department or unit is not in the lists', () => {
    expect(scopeBadgeText({ departmentId: 'gone' }, depts, units)).toBe('Department');
    expect(scopeBadgeText({ orgUnitId: 'gone' }, depts, units)).toBe('Organisation unit');
  });
});
