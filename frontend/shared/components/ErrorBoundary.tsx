// shared/components/ErrorBoundary.tsx
// React error boundary for catching rendering errors in major page sections.
// Shows a user-friendly error card with a retry button.
'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiClient } from '../lib/apiClient';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
    // A render crash never reaches the backend's own error handler, so
    // without this it was invisible to both the admin Slack/email alerts and
    // the Operations -> System Errors panel (infrastructure/alerting/
    // adminAlerts.ts) despite this exact comment once promising it went "to
    // an error tracking service" in production — it didn't. Best-effort:
    // swallow any failure, since a reporting call must never compound a
    // render crash the user is already looking at a fallback for.
    void apiClient('/operations/client-error', {
      method: 'POST',
      body: JSON.stringify({
        message: error.message,
        componentStack: info.componentStack,
        route: typeof window !== 'undefined' ? window.location.pathname : undefined,
      }),
    }).catch(() => {});
  }

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center min-h-[200px] p-6">
          <div className="text-center max-w-sm">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 dark:bg-red-900/20 mb-4">
              <AlertTriangle className="h-6 w-6 text-red-500" />
            </div>
            <h3 className="text-base font-bold text-text-primary mb-1">Something went wrong</h3>
            <p className="text-sm text-text-muted mb-4">
              {this.state.error?.message ?? 'An unexpected error occurred in this section.'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
