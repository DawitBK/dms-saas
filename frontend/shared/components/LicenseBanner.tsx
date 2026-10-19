'use client';

// shared/components/LicenseBanner.tsx
//
// The licence banner (docs/operations/PLATFORM-LICENSING.md section 6): a strip above every signed-in page for
// `expiring`, `grace` and `expired`, plus a quiet one-line notice for administrators when no licence is configured.
// Mounted once in app/layout.tsx. Renders nothing without a status, for `active`/`unknown`, or on pages with no session.
import { useState } from 'react';
import { AlertTriangle, Info, Lock } from 'lucide-react';
import { useLicenseStatus } from '../hooks/useLicense';
import { usePermissions } from '../hooks/usePermissions';
import { PERMISSIONS } from '../lib/permissions';
import { licenseBanner, type LicenseBannerModel } from '../lib/license';

const TONE: Record<LicenseBannerModel['tone'], { bg: string; border: string; text: string; Icon: typeof Info }> = {
  warning: { bg: 'var(--warning-bg)', border: 'var(--warning-border)', text: 'var(--warning-text)', Icon: AlertTriangle },
  danger: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger-text)', Icon: Lock },
  muted: { bg: 'var(--info-bg)', border: 'var(--info-border)', text: 'var(--info-text)', Icon: Info },
};

export function LicenseBanner() {
  const { data: status } = useLicenseStatus();
  const { can } = usePermissions();
  // The unconfigured notice can be dismissed for this page load; the states that matter (expiring, grace,
  // expired) cannot, they are not something to hide from the people affected.
  const [dismissedQuiet, setDismissedQuiet] = useState(false);

  const model = licenseBanner(status, { isAdmin: can(PERMISSIONS.OPERATIONS_MANAGE) });
  if (!model) return null;
  if (model.tone === 'muted' && dismissedQuiet) return null;

  const { bg, border, text, Icon } = TONE[model.tone];
  const quiet = model.tone === 'muted';

  return (
    <div
      role={model.tone === 'danger' ? 'alert' : 'status'}
      data-testid="license-banner"
      data-state={status?.state}
      className={quiet ? 'flex items-center gap-2 px-4 py-1.5 text-xs' : 'flex items-start gap-3 px-4 py-2.5 text-sm'}
      style={{ background: bg, color: text, borderBottom: `1px solid ${border}` }}
    >
      <Icon className={quiet ? 'h-3.5 w-3.5 shrink-0' : 'mt-0.5 h-4 w-4 shrink-0'} aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{model.title}.</span> {model.body}
      </p>
      {quiet && (
        <button
          type="button"
          onClick={() => setDismissedQuiet(true)}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs underline hover:no-underline"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
