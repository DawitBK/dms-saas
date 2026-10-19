'use client';

// shared/components/LicenseBanner.tsx
//
// The licence banner (docs/operations/PLATFORM-LICENSING.md section 6): a strip above every signed-in page for
// `expiring`, `grace` and `expired`. Mounted once in app/layout.tsx. Renders nothing without a status, for
// `active`/`unknown`/`unconfigured`, or on pages with no session.
import { AlertTriangle, Lock } from 'lucide-react';
import { useLicenseStatus } from '../hooks/useLicense';
import { licenseBanner, type LicenseBannerModel } from '../lib/license';

const TONE: Record<LicenseBannerModel['tone'], { bg: string; border: string; text: string; Icon: typeof Lock }> = {
  warning: { bg: 'var(--warning-bg)', border: 'var(--warning-border)', text: 'var(--warning-text)', Icon: AlertTriangle },
  danger: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger-text)', Icon: Lock },
};

export function LicenseBanner() {
  const { data: status } = useLicenseStatus();

  const model = licenseBanner(status);
  if (!model) return null;

  const { bg, border, text, Icon } = TONE[model.tone];

  return (
    <div
      role={model.tone === 'danger' ? 'alert' : 'status'}
      data-testid="license-banner"
      data-state={status?.state}
      className="flex items-start gap-3 px-4 py-2.5 text-sm"
      style={{ background: bg, color: text, borderBottom: `1px solid ${border}` }}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{model.title}.</span> {model.body}
      </p>
    </div>
  );
}
