// shared/hooks/useKeyboardShortcuts.ts
// Registers global keyboard shortcuts. Shortcuts that trigger navigation or
// gated actions are only active when the user holds the relevant permission.
'use client';

import { useEffect } from 'react';

export interface KeyboardShortcut {
  key: string;            // e.g. 'k', '/'
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (e: KeyboardEvent) => void;
  /** Ignore when focus is inside an input/textarea/select */
  ignoreInInputs?: boolean;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const keyMatch = e.key != null && e.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = !shortcut.ctrl || (e.ctrlKey || e.metaKey);
        const metaMatch = !shortcut.meta || e.metaKey;
        const shiftMatch = !shortcut.shift || e.shiftKey;

        if (!keyMatch || !ctrlMatch || !metaMatch || !shiftMatch) continue;

        if (shortcut.ignoreInInputs) {
          const target = e.target as HTMLElement;
          const tag = target.tagName.toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) continue;
        }

        e.preventDefault();
        shortcut.handler(e);
        break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}
