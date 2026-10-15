'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { usePwaInstall } from '../hooks/usePwaInstall';

export function InstallAppButton() {
  const { canInstall, isIos, isInstalled, promptInstall } = usePwaInstall();
  const [showIosHint, setShowIosHint] = useState(false);

  if (isInstalled || (!canInstall && !isIos)) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (canInstall ? void promptInstall() : setShowIosHint((v) => !v))}
        className="sidebar-nav-item flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors"
      >
        <Download className="h-4 w-4 shrink-0" />
        Install App
      </button>
      {showIosHint && (
        <div
          className="absolute bottom-full left-0 z-10 mb-2 w-56 rounded-lg p-3 text-[11px] shadow-lg"
          style={{ background: 'var(--surface-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          Tap the Share icon, then &quot;Add to Home Screen&quot;.
        </div>
      )}
    </div>
  );
}
