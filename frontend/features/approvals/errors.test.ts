import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/lib/apiClient';
import { APPROVAL_ERROR_WORDING, approvalErrorMessage } from './errors';

const api = (code: string, message = 'raw backend message') => new ApiError(message, { code, status: 422 });

const EXPECTED_CODES = [
  'ERR-DELEGATE-OUT-OF-SCOPE', 'ERR-DELEGATE-SELF', 'ERR-STEP-LOCKED', 'ERR-STEP-ALREADY-DELEGATED',
  'ERR-DELEGATION-DISABLED', 'ERR-STEP-NOT-ASSIGNED', 'ERR-STEP-NOT-PENDING', 'ERR-STEP-SELF-APPROVAL',
  'ERR-SELF-APPROVAL', 'ERR-STEP-DEPT-SCOPE', 'ERR-FORM-TEMPLATE-ORG-SCOPE', 'ERR-FORM-TEMPLATE-SCOPE',
  'ERR-FORM-SCOPE-REQUIRED', 'ERR-FORM-SCOPE', 'ERR-FORM-SCOPE-INVALID', 'ERR-TEMPLATE-SCOPE',
  'ERR-TEMPLATE-TARGET', 'ERR-NOT-FORM-FILER', 'ERR-FORM-IN-REVIEW', 'ERR-FORM-NOT-EDITABLE',
  'ERR-FORM-DRAFT-NOT-USED', 'ERR-TEMPLATE-INACTIVE', 'ERR-TEMPLATE-SUPERSEDED', 'ERR-NOT-ITEM-OWNER',
  'ERR-CHAIN-STATE-INVALID', 'ERR-USER-NOT-FOUND',
];

describe('approvalErrorMessage', () => {
  it('has wording for every code the delegation, scope and form-lifecycle features can raise', () => {
    for (const code of EXPECTED_CODES) expect(APPROVAL_ERROR_WORDING[code], code).toBeTruthy();
  });

  it('words each known code in plain language instead of echoing the raw message', () => {
    for (const code of EXPECTED_CODES) {
      const text = approvalErrorMessage(api(code), 'fallback');
      expect(text).toBe(APPROVAL_ERROR_WORDING[code]);
      expect(text).not.toContain('raw backend message');
    }
  });

  it('says what to do next for the cases a person can fix', () => {
    expect(approvalErrorMessage(api('ERR-FORM-IN-REVIEW'), 'x')).toMatch(/withdraw it from review first/i);
    expect(approvalErrorMessage(api('ERR-TEMPLATE-SUPERSEDED'), 'x')).toMatch(/file the form again/i);
    expect(approvalErrorMessage(api('ERR-STEP-LOCKED'), 'x')).toMatch(/decide it yourself/i);
    expect(approvalErrorMessage(api('ERR-FORM-SCOPE-REQUIRED'), 'x')).toMatch(/pick a department/i);
  });

  it('falls back to the server message for an unknown code, and to the fallback for a non-error', () => {
    expect(approvalErrorMessage(api('ERR-SOMETHING-NEW', 'Server says no'), 'fallback')).toBe('Server says no');
    expect(approvalErrorMessage('boom', 'Decision failed')).toBe('Decision failed');
  });
});
