import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LicenseModuleKey } from '../lib/license';

const push = vi.fn();
const isModuleOn = vi.fn<(key: LicenseModuleKey) => boolean>();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../hooks/usePermissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../hooks/useLicense', () => ({ useLicenseModules: () => ({ isModuleOn }) }));

import { CommandPalette } from './CommandPalette';

const openPalette = () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
};
const labels = () => screen.getAllByRole('button').map((b) => b.textContent ?? '').join(' | ');

beforeEach(() => {
  push.mockReset();
  isModuleOn.mockReset().mockReturnValue(true);
});

describe('CommandPalette licence filter', () => {
  it('offers every link when every module is licensed (no licence / no status behaves the same)', () => {
    openPalette();
    const text = labels();
    for (const l of ['Search Documents', 'Approval Queue', 'Records Console', 'Dashboard', 'Settings']) expect(text).toContain(l);
  });

  it('hides the links into modules the licence switches off, and keeps core links', () => {
    isModuleOn.mockImplementation((key) => key !== 'search' && key !== 'workflow' && key !== 'retention');
    openPalette();
    const text = labels();
    expect(text).not.toContain('Search Documents');
    expect(text).not.toContain('Approval Queue');
    expect(text).not.toContain('Records Console');
    for (const l of ['Dashboard', 'Upload Document', 'Browse Files', 'My Files', 'Notifications', 'Audit Log', 'Administration', 'Settings']) {
      expect(text).toContain(l);
    }
  });

  it('a hidden link cannot be reached by typing its name either', () => {
    isModuleOn.mockImplementation((key) => key !== 'search');
    openPalette();
    fireEvent.change(screen.getByPlaceholderText('Search commands…'), { target: { value: 'search' } });
    expect(screen.queryByText('Search Documents')).toBeNull();
  });

  it('selecting a visible entry navigates to its href', () => {
    openPalette();
    fireEvent.click(screen.getByText('My Files'));
    expect(push).toHaveBeenCalledWith('/dashboard/files');
  });
});
