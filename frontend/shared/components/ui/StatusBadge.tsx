// shared/components/ui/StatusBadge.tsx

const STATUS_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  DRAFT:            { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', text: '#64748b', dot: '#94a3b8' },
  SCAN_PENDING:     { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)', text: '#64748b', dot: '#f59e0b' },
  PENDING_REVIEW:   { bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.3)', text: '#92400e', dot: '#f59e0b' },
  IN_REVIEW:        { bg: 'rgba(59,130,246,0.1)',   border: 'rgba(59,130,246,0.3)', text: '#1e40af', dot: '#3b82f6' },
  ON_HOLD:          { bg: 'rgba(249,115,22,0.1)',   border: 'rgba(249,115,22,0.3)', text: '#9a3412', dot: '#f97316' },
  REJECTED:         { bg: 'rgba(244,63,94,0.1)',    border: 'rgba(244,63,94,0.3)',  text: '#9f1239', dot: '#f43f5e' },
  // Unified approval engine (D1–D7) — author-revisable and audit-stage states
  CHANGES_REQUESTED:{ bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)',text: '#92400e', dot: '#f59e0b' },
  DECLINED:         { bg: 'rgba(244,63,94,0.1)',    border: 'rgba(244,63,94,0.3)',  text: '#9f1239', dot: '#f43f5e' },
  PENDING_AUDIT:    { bg: 'rgba(139,92,246,0.1)',   border: 'rgba(139,92,246,0.3)', text: '#4c1d95', dot: '#8b5cf6' },
  AUDITED:          { bg: 'rgba(16,185,129,0.1)',   border: 'rgba(16,185,129,0.3)', text: '#065f46', dot: '#10b981' },
  AUDIT_FLAGGED:    { bg: 'rgba(220,38,38,0.12)',   border: 'rgba(220,38,38,0.35)', text: '#991b1b', dot: '#dc2626' },
  APPROVED:         { bg: 'rgba(16,185,129,0.1)',   border: 'rgba(16,185,129,0.3)', text: '#065f46', dot: '#10b981' },
  PENDING_SIGNATURE:{ bg: 'rgba(139,92,246,0.1)',   border: 'rgba(139,92,246,0.3)', text: '#4c1d95', dot: '#8b5cf6' },
  SIGNING_DECLINED: { bg: 'rgba(220,38,38,0.1)',    border: 'rgba(220,38,38,0.3)',  text: '#991b1b', dot: '#dc2626' },
  SIGNED:           { bg: 'rgba(109,40,217,0.1)',   border: 'rgba(109,40,217,0.3)', text: '#4c1d95', dot: '#7c3aed' },
  ACTIVE:           { bg: 'rgba(5,150,105,0.1)',    border: 'rgba(5,150,105,0.3)',  text: '#065f46', dot: '#059669' },
  PUBLISHED:        { bg: 'rgba(99,102,241,0.1)',   border: 'rgba(99,102,241,0.3)', text: '#3730a3', dot: '#6366f1' },
  SUPERSEDED:       { bg: 'rgba(100,116,139,0.1)', border: 'rgba(100,116,139,0.25)', text: '#475569', dot: '#64748b' },
  ARCHIVED:         { bg: 'rgba(100,116,139,0.1)', border: 'rgba(100,116,139,0.25)', text: '#475569', dot: '#94a3b8' },
  LEGAL_HOLD:       { bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.35)',  text: '#991b1b', dot: '#ef4444' },
  DISPOSAL_PENDING: { bg: 'rgba(249,115,22,0.12)',  border: 'rgba(249,115,22,0.35)', text: '#7c2d12', dot: '#f97316' },
  DISPOSED:         { bg: 'rgba(107,114,128,0.1)',  border: 'rgba(107,114,128,0.25)', text: '#4b5563', dot: '#6b7280' },
  PRESERVED:        { bg: 'rgba(20,184,166,0.1)',   border: 'rgba(20,184,166,0.3)',  text: '#0f766e', dot: '#14b8a6' },
  CANCELLED:        { bg: 'rgba(107,114,128,0.1)',  border: 'rgba(107,114,128,0.2)', text: '#6b7280', dot: '#9ca3af' },
  // CAMS letter statuses
  DISPATCHED:       { bg: 'rgba(6,182,212,0.1)',    border: 'rgba(6,182,212,0.3)',  text: '#155e75', dot: '#06b6d4' },
  RECEIVED:         { bg: 'rgba(59,130,246,0.1)',   border: 'rgba(59,130,246,0.3)', text: '#1e40af', dot: '#3b82f6' },
  RETURNED:         { bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)',text: '#92400e', dot: '#f59e0b' },
  RESPONDED:        { bg: 'rgba(16,185,129,0.1)',   border: 'rgba(16,185,129,0.3)', text: '#065f46', dot: '#10b981' },
  CLOSED:           { bg: 'rgba(100,116,139,0.1)',  border: 'rgba(100,116,139,0.25)',text: '#475569', dot: '#64748b' },
  OVERDUE:          { bg: 'rgba(220,38,38,0.12)',   border: 'rgba(220,38,38,0.35)',  text: '#991b1b', dot: '#dc2626' },
  // Approval step statuses
  PENDING:          { bg: 'rgba(245,158,11,0.1)',   border: 'rgba(245,158,11,0.3)', text: '#92400e', dot: '#f59e0b' },
  WAITING:          { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)',text: '#64748b', dot: '#94a3b8' },
  // Document trash/quarantine
  TRASHED:          { bg: 'rgba(107,114,128,0.1)',  border: 'rgba(107,114,128,0.2)',text: '#6b7280', dot: '#9ca3af' },
  QUARANTINED:      { bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.35)', text: '#991b1b', dot: '#ef4444' },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const s = STATUS_STYLES[status] ?? {
    bg: 'rgba(107,114,128,0.1)',
    border: 'rgba(107,114,128,0.2)',
    text: '#6b7280',
    dot: '#9ca3af',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${className}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: s.dot }} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
