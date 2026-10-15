'use client';

// app/error.tsx — Next's route-segment error boundary. Catches a render or
// data-fetch throw anywhere under a route segment that ISN'T already inside
// one of shared/components/ErrorBoundary.tsx's boundaries (that component
// only catches what a page deliberately wraps in it — this is Next's own
// mechanism and was entirely absent before, so an uncaught exception outside
// any ErrorBoundary fell all the way to Next's default, unbranded error
// screen). Runs inside the root layout (Sidebar/Providers stay mounted), so
// it only needs its own content, not a full <html>/<body> — that's what
// global-error.tsx (the layout-itself-threw case) is for.
import { useEffect } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import Link from 'next/link';

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[RouteError]', error);
  }, [error]);

  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="ui-error-icon-wrap mx-auto" style={{ width: 56, height: 56 }}>
          <AlertTriangle className="ui-error-icon" style={{ width: 26, height: 26 }} />
        </div>
        <h1 className="mt-4 text-lg font-bold text-text-primary">This page ran into a problem</h1>
        <p className="mt-2 text-sm text-text-muted">
          {error.message || 'An unexpected error occurred while rendering this page.'}
        </p>
        {error.digest && <p className="ui-error-ref mx-auto mt-3 inline-block">Reference: {error.digest}</p>}
        {isDev && error.stack && (
          <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-surface-raised border border-border p-3 text-left text-[11px] leading-relaxed text-text-muted">
            {error.stack}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button onClick={reset} className="ui-btn ui-btn-primary">
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </button>
          <Link href="/dashboard" className="ui-btn ui-btn-secondary">
            <Home className="h-3.5 w-3.5" />
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
