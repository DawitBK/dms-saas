/**
 * Fixed, entity-keyed color assignments for the dashboard's identity charts
 * (status / classification donuts) — colors follow the *category value*,
 * never its rank in the current filtered result, so a slice never repaints
 * when a filter changes which statuses are present or how they're ordered.
 *
 * Extends the same status color set already shipped for the main dashboard's
 * CSS conic-gradient status pie (app/dashboard/page.tsx) rather than
 * inventing a second palette, plus the handful of extra lifecycle states the
 * reports dashboard can surface (audit stage / disposal / preservation).
 * Unknown/future status keys fall back to a deterministic hash color instead
 * of a shared gray, so they still stay visually distinct from each other.
 */

export const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#94a3b8',
  SCAN_PENDING: '#a1a1aa',
  PENDING_REVIEW: '#f59e0b',
  IN_REVIEW: '#3b82f6',
  ON_HOLD: '#fb923c',
  REJECTED: '#f43f5e',
  CHANGES_REQUESTED: '#fb7185',
  DECLINED: '#e11d48',
  APPROVED: '#10b981',
  PENDING_AUDIT: '#8b5cf6',
  AUDITED: '#7c3aed',
  AUDIT_FLAGGED: '#c026d3',
  PENDING_SIGNATURE: '#0ea5e9',
  SIGNING_DECLINED: '#ef4444',
  SIGNED: '#0284c7',
  ACTIVE: '#059669',
  SUPERSEDED: '#64748b',
  ARCHIVED: '#475569',
  LEGAL_HOLD: '#dc2626',
  DISPOSAL_PENDING: '#f97316',
  DISPOSED: '#6b7280',
  PRESERVED: '#14b8a6',
  CANCELLED: '#71717a',
  TRASHED: '#52525b',
  QUARANTINED: '#eab308',
};

// PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED — a small fixed enum, so it
// maps 1:1 onto the app's own 4-color categorical series (chartTheme.ts)
// rather than needing its own palette.
export const CLASSIFICATION_COLORS: Record<string, string> = {
  PUBLIC: '#059669',
  INTERNAL: '#6366f1',
  CONFIDENTIAL: '#d97706',
  RESTRICTED: '#f43f5e',
};

const FALLBACK_HUES = ['#6366f1', '#059669', '#d97706', '#f43f5e', '#0ea5e9', '#8b5cf6', '#f97316', '#14b8a6'];

/** Deterministic (hash-based, not rank-based) fallback color for a category
 * value not present in a fixed map above — stable across re-renders/filters. */
function hashColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length];
}

export function colorForStatus(status: string): string {
  return STATUS_COLORS[status] ?? hashColor(status);
}

export function colorForClassification(classification: string): string {
  return CLASSIFICATION_COLORS[classification] ?? hashColor(classification);
}
