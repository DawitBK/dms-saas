import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LicenseStatus } from '../lib/license';

const useLicenseStatus = vi.fn();
const can = vi.fn();
vi.mock('../hooks/useLicense', () => ({ useLicenseStatus: () => useLicenseStatus() }));
vi.mock('../hooks/usePermissions', () => ({ usePermissions: () => ({ can }) }));

import { LicenseBanner } from './LicenseBanner';

const status = (over: Partial<LicenseStatus>): LicenseStatus => ({
  system: 'dms', state: 'active', customer: null, expiresAt: '2030-01-01T00:00:00.000Z', graceEndsAt: '2030-01-15T00:00:00.000Z',
  daysRemaining: 400, warnDays: 30, graceDays: 14, readOnly: false, maxUsers: null, seatsUsed: 1, modules: null, source: 'sso',
  fetchedAt: null, version: 1, enforcement: 'enforce', ...over,
});

beforeEach(() => {
  useLicenseStatus.mockReset();
  can.mockReset().mockReturnValue(false);
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

  it('unconfigured: hidden from ordinary users', () => {
    useLicenseStatus.mockReturnValue({ data: status({ state: 'unconfigured' }) });
    const { container } = render(<LicenseBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('unconfigured: a quiet, dismissible notice for administrators', () => {
    can.mockReturnValue(true);
    useLicenseStatus.mockReturnValue({ data: status({ state: 'unconfigured' }) });
    render(<LicenseBanner />);
    expect(screen.getByTestId('license-banner')).toHaveTextContent('No licence configured');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('license-banner')).toBeNull();
  });
});
