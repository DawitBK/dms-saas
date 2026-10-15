'use client';

// shared/components/GlobalErrorReporter.tsx
//
// ErrorBoundary.tsx only ever sees React RENDER-phase crashes — that is a
// hard limit of how React error boundaries work, not a choice made here. An
// error thrown inside an onClick handler, inside an async function in a
// useEffect, or a rejected promise nobody awaited never reaches a boundary at
// all; it used to just print to the browser console and vanish. This is the
// other half: window-level listeners that catch everything React's boundary
// structurally cannot, and report it through the same
// POST /operations/client-error -> infrastructure/alerting/adminAlerts.ts
// path, so it shows up in the same Slack/email alert and the same
// Operations -> System Errors panel as a render crash or a backend 500.
//
// Mounted once at the root layout. Renders nothing.
import { useEffect } from 'react';
import { apiClient } from '../lib/apiClient';

function reportClientError(message: string, stack: string | undefined, kind: string) {
  try {
    void apiClient('/operations/client-error', {
      method: 'POST',
      body: JSON.stringify({
        message,
        componentStack: stack ? `[${kind}]\n${stack}` : `[${kind}]`,
        route: typeof window !== 'undefined' ? window.location.pathname : undefined,
      }),
    }).catch(() => {});
  } catch {
    // Never let error reporting itself throw.
  }
}

export function GlobalErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportClientError(event.message || 'Unknown window error', event.error?.stack, 'window.onerror');
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled promise rejection');
      const stack = reason instanceof Error ? reason.stack : undefined;
      reportClientError(message, stack, 'unhandledrejection');
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
