'use client';

// shared/components/ErrorState.tsx
//
// The one component for "this failed to load" — full-panel (a page/tab whose
// only content is the failed query) and inline (a section within a page that
// has other content) variants. Replaces the dominant anti-pattern the error-
// handling audit found repeated across OrgUnitsPanel, the Files/Documents/
// Bundles/Letters/Storage/Reports pages, ManagerHubPanel and RecordsPanels:
// destructuring `isError` from a TanStack Query hook, then showing one fixed
// sentence ("X failed to load. Please refresh and try again.") regardless of
// what actually went wrong, with the real `error` silently discarded.
//
// Visually mirrors EmptyState.tsx's shape (icon circle + title + description
// + optional action) on the --danger palette instead of --text-muted, so an
// error reads as "something broke" rather than "nothing here yet" while
// still looking like the same design system, not a bolted-on alert box.
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { getErrorCode, getErrorMessage, getErrorReference, isNetworkError } from '../lib/errorMessage';
import { licenseWording } from '../lib/license';

interface ErrorStateProps {
  /** Whatever a catch block or a TanStack Query `error` field handed you —
   *  pass it straight through, don't pre-format it. */
  error: unknown;
  /** Defaults to "Connection problem" for a network failure, "Something went
   *  wrong" otherwise. */
  title?: string;
  /** Overrides the message derived from `error` (rarely needed — the derived
   *  one is already the backend's own precise message in the common case). */
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ error, title, message, onRetry, className = '' }: ErrorStateProps) {
  const offline = isNetworkError(error);
  const Icon = offline ? WifiOff : AlertTriangle;
  const resolvedMessage = message ?? getErrorMessage(error, offline ? 'Cannot reach the server. Check your connection and try again.' : 'This could not be loaded.');
  const reference = getErrorReference(error);

  return (
    <div className={`ui-error ${className}`} role="alert">
      <div className="ui-error-icon-wrap">
        <Icon className="ui-error-icon" />
      </div>
      <p className="ui-error-title">{title ?? licenseWording(getErrorCode(error))?.title ?? (offline ? 'Connection problem' : 'Something went wrong')}</p>
      <p className="ui-error-desc">{resolvedMessage}</p>
      {reference && <p className="ui-error-ref">Reference: {reference}</p>}
      {onRetry && (
        <button onClick={onRetry} className="ui-btn ui-btn-secondary">
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </button>
      )}
    </div>
  );
}

/** Compact single-row variant for a spot that already has its own heading —
 *  a form's top-level submit error, a modal's failed-action banner, a
 *  section inside a page that otherwise loaded fine. */
export function InlineError({ error, message, className = '' }: { error: unknown; message?: string; className?: string }) {
  if (!error && !message) return null;
  const offline = isNetworkError(error);
  const Icon = offline ? WifiOff : AlertTriangle;
  const resolvedMessage = message ?? getErrorMessage(error, offline ? 'Cannot reach the server. Check your connection and try again.' : 'Something went wrong. Please try again.');

  return (
    <div className={`ui-error-inline ${className}`} role="alert">
      <Icon className="ui-error-inline-icon" />
      <span className="ui-error-inline-text">{resolvedMessage}</span>
    </div>
  );
}

/** Per-field validation message — pass the result of `getFieldError(err, name)`
 *  straight in; renders nothing when there's no message for that field. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="ui-field-error">{message}</p>;
}
