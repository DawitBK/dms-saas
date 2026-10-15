'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, lazy, Suspense } from 'react';
import { RealtimeBridge } from './RealtimeBridge';
import { AuthGuard } from '../shared/components/AuthGuard';
import { ServiceWorkerRegistration } from '../shared/components/ServiceWorkerRegistration';
import { Toaster } from 'react-hot-toast';
import { useThemeStore } from '../state/theme.store';
import { queryClient } from '../shared/lib/queryClient';

// Lazy-load the command palette — it's never needed at initial page load
const CommandPalette = lazy(() =>
  import('../shared/components/CommandPalette').then((m) => ({
    default: m.CommandPalette,
  })),
);

const ThemeSync = () => {
  const { theme } = useThemeStore();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(
      'dark',
      'theme-light',
      'theme-dark-black',
      'theme-dark-blue',
    );
    if (theme === 'light') {
      root.classList.add('theme-light');
    } else if (theme === 'dark-black') {
      root.classList.add('dark', 'theme-dark-black');
    } else if (theme === 'dark-blue') {
      root.classList.add('dark', 'theme-dark-blue');
    }
  }, [theme]);

  return null;
};

export function Providers({ children }: { children: React.ReactNode }) {
  // queryClient is the shared/lib/queryClient.ts singleton, not a per-mount
  // instance — see that file's comment: auth.store.ts's clearSession() needs
  // to reach this exact instance to clear it on sign-out.
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <ServiceWorkerRegistration />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            fontFamily: 'Inter',
            fontSize: '14px',
            borderRadius: '10px',
          },
          success: { iconTheme: { primary: '#059669', secondary: '#d1fae5' } },
          error: { iconTheme: { primary: '#dc2626', secondary: '#fee2e2' } },
        }}
      />
      <AuthGuard>
        <RealtimeBridge />
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
        {children}
      </AuthGuard>
    </QueryClientProvider>
  );
}
