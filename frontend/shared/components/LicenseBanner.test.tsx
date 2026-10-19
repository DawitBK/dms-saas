import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LicenseStatus } from '../lib/license';

const useLicenseStatus = vi.fn();
vi.mock('../hooks/useLicense', () => ({ useLicenseStatus: () => useLicenseStatus() }));

import { LicenseBanner } from './LicenseBanner';

const status = (over: Partial<LicenseStatus>): LicenseStatus => ({
  system: 'dms', state: 'active', customer: null, expiresAt: '2030-01-01T00:00:00.000Z', graceEndsAt: '2030-01-15T00:00:00.000Z',
  daysRemaining: 400, warnDays: 30, graceDays: 14, readOnly: false, maxUsers: null, seatsUsed: 1, modules: null, source: 'sso',
  fetchedAt: null, version: 1, enforcement: 'enforce', ...over,
});

beforeEach(() => {
  useLicenseStatus.mockReset();
});

describe('LicenseBanner', () => {
  it('renders nothing without a status', () => {
    useLicenseStatus.mockReturnValue({ data: undefined });
    const { container } = render(<LicenseBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when active', () => {
    useLicenseStatus.mockReturnValue({ data: status({ state: 'active' }) });
    const { container } = render(<LicenseBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the expiring warning to everyone', () => {
    useLicenseStatus.mockReturnValue({ data: status({ state: 'expiring', daysRemaining: 7 }) });
    render(<LicenseBanner />);
    expect(screen.getByTestId('license-banner')).toHaveTextContent('Licence expires in 7 days');
    expect(screen.getByTestId('license-banner')).toHaveAttribute('role', 'status');
  });

  it('shows the read-only banner as an alert, with no dismiss button', () => {
    useLicenseStatus.mockReturnValue({ data: status({ state: 'expired', readOnly: true }) });
    render(<LicenseBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent('DMS is read-only');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  describe('per-application entitlement (required and not licensed)', () => {
    const NOTICE = 'This system is not licensed. Contact your administrator.';
    const unlicensed = (over: Partial<LicenseStatus> = {}) =>
      status({ state: 'unconfigured', required: true, licensed: false, reason: 'NO_LICENSE', deployment: 'sso', ...over });

    it('shows a red alert with the fixed sentence', () => {
      useLicenseStatus.mockReturnValue({ data: unlicensed() });
      render(<LicenseBanner />);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-testid', 'license-banner');
      expect(alert).toHaveTextContent(NOTICE);
      expect(screen.getByText(NOTICE)).toBe(alert.querySelector('p'));
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    });

    it.each(['NO_LICENSE', 'MODE_NOT_LICENSED'] as const)('reason %s: the same notice, for everyone', (reason) => {
      useLicenseStatus.mockReturnValue({ data: unlicensed({ reason, state: reason === 'NO_LICENSE' ? 'unknown' : 'active' }) });
      render(<LicenseBanner />);
      expect(screen.getByRole('alert')).toHaveTextContent(NOTICE);
    });

    it('wins over every expiry state (an expired token of the wrong mode is not just "read-only")', () => {
      useLicenseStatus.mockReturnValue({ data: unlicensed({ state: 'expired', readOnly: true, reason: 'MODE_NOT_LICENSED' }) });
      render(<LicenseBanner />);
      expect(screen.getByRole('alert')).toHaveTextContent(NOTICE);
      expect(screen.getByRole('alert')).not.toHaveTextContent('read-only');
    });

    it('is shown whatever the enforcement mode (warn and off are still unlicensed)', () => {
      for (const enforcement of ['warn', 'off'] as const) {
        useLicenseStatus.mockReturnValue({ data: unlicensed({ enforcement }) });
        const { unmount } = render(<LicenseBanner />);
        expect(screen.getByRole('alert')).toHaveTextContent(NOTICE);
        unmount();
      }
    });

    it('shows nothing when required AND licensed, or when not required, or when an older backend sends neither field', () => {
      for (const over of [{ required: true, licensed: true, reason: null }, { required: false, licensed: true, reason: null }, {}] as Partial<LicenseStatus>[]) {
        useLicenseStatus.mockReturnValue({ data: status({ state: 'active', ...over }) });
        const { container, unmount } = render(<LicenseBanner />);
        expect(container).toBeEmptyDOMElement();
        unmount();
      }
    });

    it('not required and unconfigured stays silent, and the old wording exists nowhere', () => {
      useLicenseStatus.mockReturnValue({ data: status({ state: 'unconfigured', required: false, licensed: true }) });
      const { container } = render(<LicenseBanner />);
      expect(container).toBeEmptyDOMElement();
      expect(document.body.textContent?.toLowerCase()).not.toContain('no licence configured');
    });
  });

  it('unconfigured: never shows a message, to anyone', () => {
    useLicenseStatus.mockReturnValue({ data: status({ state: 'unconfigured' }) });
    const { container } = render(<LicenseBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
