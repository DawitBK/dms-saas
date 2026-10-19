import './globals.css';
import { Suspense } from 'react';
import { Providers } from '../providers/Providers';
import { Sidebar } from '../shared/components/Sidebar';
import { ErrorBoundary } from '../shared/components/ErrorBoundary';
import { GlobalErrorReporter } from '../shared/components/GlobalErrorReporter';
import { LicenseBanner } from '../shared/components/LicenseBanner';
import { API_BASE_URL } from '../shared/lib/apiConfig';
import { withBasePath } from '../shared/lib/basePath';

export const metadata = {
  title: 'DMS',
  description: 'Enterprise Document & Archive Management System',
  manifest: withBasePath('/manifest.json'),
  icons: {
    icon: [
      { url: withBasePath('/icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { url: withBasePath('/icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
    apple: withBasePath('/icons/apple-touch-icon.png'),
    shortcut: withBasePath('/icons/favicon.png'),
  },
};

// Tell the browser to open a connection to the API server immediately,
// so the first authenticated request doesn't pay connection setup cost.
// API_BASE_URL enforces the production build-time env contract.
const apiOrigin = new URL(API_BASE_URL).origin;

export function generateViewport() {
  return { width: 'device-width', initialScale: 1, themeColor: '#6366f1' };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href={apiOrigin} />
      </head>
      <body className="h-full bg-surface" suppressHydrationWarning>
        <Providers>
          <GlobalErrorReporter />
          <div className="flex h-full">
            <Suspense fallback={null}>
              <Sidebar />
            </Suspense>
            <main className="flex-1 flex flex-col overflow-hidden">
              <LicenseBanner />
              <ErrorBoundary>{children}</ErrorBoundary>
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
