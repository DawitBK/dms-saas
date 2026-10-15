'use client';

import { useEffect } from 'react';
import { withBasePath } from '../lib/basePath';

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      // NEVER register the PWA service worker outside a production build.
      // Its cache-first strategy for _next/static/* is only safe against
      // prod's content-hashed, immutable chunk filenames — in `next dev`,
      // page/layout chunks are served at STABLE urls whose content changes
      // on every save, so once cached they're served stale forever
      // (independent of the browser's own HTTP cache, and unaffected by a
      // normal hard reload). Actively unregister anything left over from
      // earlier testing so dev self-heals without a manual DevTools trip.
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => void reg.unregister());
      });
      if ('caches' in window) {
        caches.keys().then((keys) => keys.forEach((key) => void caches.delete(key)));
      }
      return;
    }

    navigator.serviceWorker.register(withBasePath('/sw.js')).catch(() => undefined);
  }, []);

  return null;
}
