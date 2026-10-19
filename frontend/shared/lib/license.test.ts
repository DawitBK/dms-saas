import { describe, expect, it } from 'vitest';
import { ApiError } from './apiClient';
import { getErrorMessage } from './errorMessage';
import {
  LICENSE_ERROR,
  LICENSE_MODULES,
  NAV_MODULE_BY_HREF,
  isLicenseErrorCode,
  isNavHrefLicensed,
  isModuleEnabled,
  licenseBanner,
  licenseWording,
  type LicenseStatus,
} from './license';

const base: LicenseStatus = {
  system: 'dms',
  state: 'active',
  customer: 'Example Corp',
  expiresAt: '2027-06-15T12:00:00.000Z',
  graceEndsAt: '2027-06-29T12:00:00.000Z',
  daysRemaining: 100,
  warnDays: 30,
  graceDays: 14,
  readOnly: false,
  maxUsers: null,
  seatsUsed: 3,
  modules: null,
  source: 'sso',
  fetchedAt: '2026-10-19T00:00:00.000Z',
  version: 1,
  enforcement: 'enforce',
};
const st = (over: Partial<LicenseStatus>): LicenseStatus => ({ ...base, ...over });
const banner = (s: LicenseStatus | null | undefined, now = new Date('2027-06-20T12:00:00.000Z')) =>
  licenseBanner(s, { now, locale: 'en-US' });

describe('licenseBanner', () => {
  it('shows nothing without a status (loading, an older backend, the API down): the UI fails open', () => {
    expect(banner(undefined)).toBeNull();
    expect(banner(null)).toBeNull();
  });

  it('shows nothing for active and unknown, for anyone', () => {
    for (const state of ['active', 'unknown', 'unconfigured'] as const) {
      expect(banner(st({ state }))).toBeNull();
    }
  });

  it('expiring: a warning with the day count and the date', () => {
    const model = banner(st({ state: 'expiring', daysRemaining: 12 }));
    expect(model?.tone).toBe('warning');
    expect(model?.title).toBe('Licence expires in 12 days');
    expect(model?.body).toContain('Jun 15, 2027');
  });

  it('expiring: singular day, and "today" at zero', () => {
    expect(banner(st({ state: 'expiring', daysRemaining: 1 }))?.title).toBe('Licence expires in 1 day');
    expect(banner(st({ state: 'expiring', daysRemaining: 0 }))?.title).toBe('Licence expires today');
  });

  it('grace: a warning that says everything still works, until when, and how long is left', () => {
    const model = banner(st({ state: 'grace', daysRemaining: -5 }), new Date('2027-06-20T12:00:00.000Z'));
    expect(model?.tone).toBe('warning');
    expect(model?.title).toMatch(/grace/i);
    expect(model?.body).toContain('Everything keeps working');
    expect(model?.body).toContain('Jun 29, 2027');
    expect(model?.body).toContain('9 days left');
  });

  it('expired and read-only: a danger banner that says what still works and what does not', () => {
    const model = banner(st({ state: 'expired', readOnly: true }));
    expect(model?.tone).toBe('danger');
    expect(model?.title).toBe('Licence expired: DMS is read-only');
    expect(model?.body).toMatch(/open and download/);
  });

  it('expired but enforcement=warn: a warning only, and it does not claim to be read-only', () => {
    const model = banner(st({ state: 'expired', readOnly: false, enforcement: 'warn' }));
    expect(model?.tone).toBe('warning');
    expect(model?.title).toMatch(/warning only/);
    expect(model?.body).not.toMatch(/read-only/);
  });
});

describe('isModuleEnabled (menu hiding)', () => {
  it('everything is on with no status, unconfigured, unknown, enforcement off, or modules null', () => {
    for (const key of LICENSE_MODULES) {
      expect(isModuleEnabled(undefined, key)).toBe(true);
      expect(isModuleEnabled(st({ state: 'unconfigured', modules: [] }), key)).toBe(true);
      expect(isModuleEnabled(st({ state: 'unknown', modules: [] }), key)).toBe(true);
      expect(isModuleEnabled(st({ enforcement: 'off', modules: [] }), key)).toBe(true);
      expect(isModuleEnabled(st({ modules: null }), key)).toBe(true);
    }
  });
  it('a listed module is on, an unlisted one is off, in every enforced state', () => {
    for (const state of ['active', 'expiring', 'grace', 'expired'] as const) {
      const s = st({ state, modules: ['letters', 'search'] });
      expect(isModuleEnabled(s, 'letters')).toBe(true);
      expect(isModuleEnabled(s, 'search')).toBe(true);
      expect(isModuleEnabled(s, 'webhooks')).toBe(false);
    }
  });
  it('an empty list turns every module off', () => {
    for (const key of LICENSE_MODULES) expect(isModuleEnabled(st({ modules: [] }), key)).toBe(false);
  });
});

describe('sidebar mapping', () => {
  it('only names real module keys', () => {
    for (const key of Object.values(NAV_MODULE_BY_HREF)) expect(LICENSE_MODULES).toContain(key);
  });
  it('never maps a core page (dashboard, browse, files, upload, notifications, trash, settings, users, roles, audit...)', () => {
    for (const href of ['/dashboard', '/dashboard/browse', '/dashboard/files', '/dashboard/upload', '/dashboard/notifications', '/dashboard/trash', '/settings', '/operations?panel=users', '/operations?panel=roles', '/operations?panel=audit', '/operations?panel=departments', '/operations?panel=docTypes', '/operations?panel=health', '/operations?panel=featureFlags']) {
      expect(NAV_MODULE_BY_HREF[href]).toBeUndefined();
    }
  });
});

describe('licenseBanner: required and not licensed', () => {
  it('is one fixed sentence, danger tone, for any state', () => {
    for (const state of ['unconfigured', 'unknown', 'active', 'expiring', 'grace', 'expired'] as const) {
      const model = banner(st({ state, required: true, licensed: false, reason: 'NO_LICENSE' }));
      expect(model).toMatchObject({ tone: 'danger', message: 'This system is not licensed. Contact your administrator.' });
    }
  });
  it('is not shown when licensed, not required, or the fields are absent (older backend: fail open)', () => {
    expect(banner(st({ required: true, licensed: true }))).toBeNull();
    expect(banner(st({ required: false, licensed: false }))).toBeNull();
    expect(banner(st({}))).toBeNull();
  });
});

describe('licence error wording', () => {
  it('has plain wording for exactly the four codes', () => {
    for (const code of Object.values(LICENSE_ERROR)) {
      expect(isLicenseErrorCode(code)).toBe(true);
      expect(licenseWording(code)?.message.length).toBeGreaterThan(40);
    }
    expect(isLicenseErrorCode('ERR-VALIDATION')).toBe(false);
    expect(isLicenseErrorCode('constructor')).toBe(false); // not an object-prototype lookup
    expect(licenseWording(undefined)).toBeUndefined();
  });
  it('getErrorMessage words an ApiError with a licence code in plain language, whatever the server text', () => {
    const err = new ApiError('raw server text', { code: LICENSE_ERROR.EXPIRED, status: 403 });
    expect(getErrorMessage(err)).toBe(licenseWording(LICENSE_ERROR.EXPIRED)!.message);
    expect(getErrorMessage(new ApiError('seat', { code: LICENSE_ERROR.SEAT_LIMIT, status: 403 }))).toMatch(/user limit/i);
    expect(getErrorMessage(new ApiError('mod', { code: LICENSE_ERROR.MODULE_DISABLED, status: 403 }))).toMatch(/not included/i);
    expect(getErrorMessage(new ApiError('req', { code: LICENSE_ERROR.REQUIRED, status: 403 }))).toBe('This system is not licensed. Contact your administrator.');
  });
  it('leaves every other error alone', () => {
    expect(getErrorMessage(new ApiError('Department code already exists', { code: 'ERR-DEPT-CODE-EXISTS', status: 409 }))).toBe('Department code already exists');
  });
});

describe('isNavHrefLicensed (shared by the sidebar and the command palette)', () => {
  const off = (...keys: string[]) => (k: string) => !keys.includes(k);
  it('hides a mapped href only when its module is off', () => {
    expect(isNavHrefLicensed('/dashboard/search', off('search'))).toBe(false);
    expect(isNavHrefLicensed('/dashboard/search', off('ai'))).toBe(true);
    expect(isNavHrefLicensed('/approver', off('workflow'))).toBe(false);
    expect(isNavHrefLicensed('/records-officer', off('retention'))).toBe(false);
  });
  it('never hides an unmapped (core) href', () => {
    for (const href of ['/dashboard', '/dashboard/upload', '/settings', '/auditor', '/admin']) {
      expect(isNavHrefLicensed(href, () => false)).toBe(true);
    }
  });
});
