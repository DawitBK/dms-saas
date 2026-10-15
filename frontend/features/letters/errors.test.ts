import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/lib/apiClient';
import { LETTER_ERROR_WORDING, letterErrorMessage } from './errors';

const api = (code: string, message = 'raw backend message') => new ApiError(message, { code, status: 422 });

describe('letterErrorMessage', () => {
  it('words the new letters codes in plain language instead of echoing the raw message', () => {
    for (const code of [
      'ERR-DEPT-ORG-UNIT-MISMATCH',
      'ERR-SELF-APPROVAL',
      'ERR-STEP-SELF-APPROVAL',
      'ERR-LETTER-NOT-FINALIZED',
      'ERR-LETTER-NOT-CANCELLABLE',
      'ERR-BODY-IMAGE-FORBIDDEN',
      'ERR-DEPT-SCOPE',
    ]) {
      const text = letterErrorMessage(api(code), 'fallback');
      expect(text).toBe(LETTER_ERROR_WORDING[code]);
      expect(text).not.toContain('raw backend message');
    }
  });

  it('tells the drafter what to do about a self-approval refusal', () => {
    expect(letterErrorMessage(api('ERR-SELF-APPROVAL'), 'x')).toMatch(/ask your department head/i);
  });

  it('falls back to the server message for an unknown code, and to the fallback for a non-error', () => {
    expect(letterErrorMessage(api('ERR-SOMETHING-NEW', 'Server says no'), 'fallback')).toBe('Server says no');
    expect(letterErrorMessage('boom', 'Decision failed')).toBe('Decision failed');
  });
});
