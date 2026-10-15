import '@testing-library/jest-dom/vitest';
import React from 'react';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// next/link renders fine standalone in most cases, but relies on
// AppRouterContext for prefetch/active-state behaviour this suite never
// exercises — stub it to a plain anchor so component tests don't need a
// full Next app router mounted around them.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: { href: string | { pathname?: string }; children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement(
      'a',
      { href: typeof href === 'string' ? href : (href?.pathname ?? '#'), ...rest },
      children,
    ),
}));

// next/navigation hooks throw outside an App Router tree — most component
// tests in this suite render a leaf component directly, not a full page, so
// give them an inert default any test can override with vi.mocked(...).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
