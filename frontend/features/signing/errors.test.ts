import { describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/lib/apiClient';
import { SigningApiError } from './api';
import { SIGNING_ERROR_MESSAGES, signingAuditActionLabel, signingErrorMessage } from './errors';

describe('signingErrorMessage', () => {
  it('uses the readable wording for a known code from the authenticated API', () => {
    const e = new ApiError('raw server text', { code: 'ERR-SIGNING-VERSION-STALE', status: 409 });
    expect(signingErrorMessage(e)).toBe(SIGNING_ERROR_MESSAGES['ERR-SIGNING-VERSION-STALE']);
    expect(signingErrorMessage(e)).toMatch(/Cancel this request/);
  });

  it('also understands the public (token) client error type', () => {
    expect(signingErrorMessage(new SigningApiError('x', 410, 'ERR-SIGNING-EXPIRED'))).toBe(SIGNING_ERROR_MESSAGES['ERR-SIGNING-EXPIRED']);
  });

  it('covers every code the e-signing API can answer with', () => {
    for (const code of [
      'ERR-SIGNATURE-REQUIRED', 'ERR-SIGNATURE-INVALID', 'ERR-SIGNING-IN-PROGRESS', 'ERR-RECIPIENT-INVALID',
      'ERR-FIELD-INVALID', 'ERR-EXPIRY-INVALID', 'ERR-FOLDER-INVALID', 'ERR-DOCUMENT-NOT-SIGNABLE',
      'ERR-SIGNING-NOT-PERMITTED', 'ERR-SIGNING-VERSION-STALE', 'ERR-SIGNING-EXPIRED', 'ERR-SIGNING-OUT-OF-ORDER',
    ]) {
      expect(SIGNING_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('falls back to the server message for an unknown code, then to the fallback', () => {
    expect(signingErrorMessage(new ApiError('Some server reason', { code: 'ERR-OTHER', status: 400 }))).toBe('Some server reason');
    expect(signingErrorMessage('not an error', 'fallback text')).toBe('fallback text');
  });
});

describe('signingAuditActionLabel', () => {
  it('labels known actions and humanises unknown ones', () => {
    expect(signingAuditActionLabel('signature_token_rejected')).toMatch(/Refused/);
    expect(signingAuditActionLabel('some_new_action')).toBe('some new action');
  });
});
