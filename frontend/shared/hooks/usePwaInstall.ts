'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** True while the page is running as an installed app rather than in a tab. */
function subscribeDisplayMode(onChange: () => void) {
  const mql = window.matchMedia('(display-mode: standalone)');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
function getStandaloneSnapshot() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
function getIosSnapshot() {
  const nav = window.navigator as unknown as { standalone?: boolean };
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent) && !nav.standalone;
}
/** `useSyncExternalStore` subscribe for a value that never changes after mount. */
const SUBSCRIBE_NEVER = () => () => {};
const FALSE_ON_SERVER = () => false;

export function usePwaInstall() {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  // Set only by the `appinstalled` event. Installing does not always flip
  // display-mode in the current tab, so this is OR-ed with the media query
  // below rather than replacing it.
  const [sawInstallEvent, setSawInstallEvent] = useState(false);

  // Both of these are browser state read through useSyncExternalStore instead
  // of an effect that setStates them in. That is React's supported way to read
  // an external source with no value during SSR, it is what
  // react-hooks/set-state-in-effect (an error under eslint-config-next 16)
  // asks for, and it is strictly more correct: display-mode is a live media
  // query, so leaving a standalone window now updates `isInstalled` instead of
  // leaving it stuck at its mount value.
  const standalone = useSyncExternalStore(subscribeDisplayMode, getStandaloneSnapshot, FALSE_ON_SERVER);
  const isIos = useSyncExternalStore(SUBSCRIBE_NEVER, getIosSnapshot, FALSE_ON_SERVER);
  const isInstalled = standalone || sawInstallEvent;

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferredEvent(null);
      setSawInstallEvent(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    const choice = await deferredEvent.userChoice;
    if (choice.outcome === 'accepted') setDeferredEvent(null);
  }, [deferredEvent]);

  return {
    canInstall: !!deferredEvent && !isInstalled,
    isIos,
    isInstalled,
    promptInstall,
  };
}
