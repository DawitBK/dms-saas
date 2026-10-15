import { describe, expect, it } from 'vitest';
import { filerActionsFor } from './instanceActions';

const base = { instanceApproval: 'chain' as const, createdBy: 'me', currentUserId: 'me' };

describe('filerActionsFor', () => {
  it('lets the filer edit or cancel a form that is a draft, returned for changes, or declined', () => {
    for (const status of ['DRAFT', 'CHANGES_REQUESTED', 'DECLINED']) {
      expect(filerActionsFor({ ...base, status })).toEqual(['edit', 'cancel']);
    }
  });

  it('lets the filer only withdraw a form that is in review', () => {
    expect(filerActionsFor({ ...base, status: 'IN_REVIEW' })).toEqual(['withdraw']);
  });

  it('offers nothing once a form is past approval or already cancelled', () => {
    for (const status of ['ACTIVE', 'APPROVED', 'PENDING_SIGNATURE', 'PENDING_AUDIT', 'CANCELLED', 'ARCHIVED', '']) {
      expect(filerActionsFor({ ...base, status })).toEqual([]);
    }
    expect(filerActionsFor({ ...base, status: null })).toEqual([]);
  });

  it('never offers anything to someone who is not the filer', () => {
    expect(filerActionsFor({ ...base, status: 'DRAFT', currentUserId: 'someone-else' })).toEqual([]);
    expect(filerActionsFor({ ...base, status: 'IN_REVIEW', currentUserId: null })).toEqual([]);
    expect(filerActionsFor({ ...base, status: 'DRAFT', createdBy: undefined })).toEqual([]);
  });

  it('offers nothing for a template without approval, whatever the status', () => {
    expect(filerActionsFor({ ...base, instanceApproval: 'none', status: 'DRAFT' })).toEqual([]);
    expect(filerActionsFor({ ...base, instanceApproval: 'none', status: 'IN_REVIEW' })).toEqual([]);
  });

  it('decides by status alone when the template mode is not reported', () => {
    expect(filerActionsFor({ ...base, instanceApproval: undefined, status: 'DRAFT' })).toEqual(['edit', 'cancel']);
  });
});
