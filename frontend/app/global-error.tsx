'use client';

// app/global-error.tsx — the ONE level above app/error.tsx: fires only when
// the root layout itself throws (so error.tsx, which renders inside that
// layout, can't). Must render its own <html>/<body> since there is no outer
// layout left to provide them. Before this file existed, that specific
// failure fell all the way through to the browser's/Next's bare unstyled
// error page with zero DMS branding and zero guidance.
import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0f172a', color: '#f1f5f9', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 9999,
                background: '#1c0606',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
              }}
            >
              <AlertTriangle style={{ width: 26, height: 26, color: '#f87171' }} />
            </div>
            <h1 style={{ marginTop: 16, fontSize: 18, fontWeight: 700 }}>DMS failed to start</h1>
            <p style={{ marginTop: 8, fontSize: 14, color: '#94a3b8', lineHeight: 1.5 }}>
              {error.message || 'A critical error prevented this application from loading.'}
            </p>
            {error.digest && (
              <p style={{ marginTop: 12, fontSize: 11, fontFamily: 'monospace', color: '#64748b' }}>
                Reference: {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: 24,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#4f46e5',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <RefreshCw style={{ width: 14, height: 14 }} />
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
