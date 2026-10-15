// shared/components/CommandPalette.tsx
// Ctrl+K command palette. Items are filtered by can(permission) so only
// actions the current principal holds appear. Never shows role-gated items.
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Search, UploadCloud, FolderOpen, Files, Bell,
  ClipboardCheck, Archive, ShieldCheck, Settings2, X,
} from 'lucide-react';
import { usePermissions } from '../hooks/usePermissions';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { PERMISSIONS } from '../lib/permissions';
import { useResetOnChange } from '../hooks/useResetOnChange';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  action: () => void;
  permission?: string;
  keywords?: string[];
}

export function CommandPalette() {
  const router = useRouter();
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const ALL_ITEMS: CommandItem[] = [
    {
      id: 'dashboard', label: 'Dashboard', icon: Files,
      action: () => router.push('/dashboard'),
      permission: PERMISSIONS.DOCUMENT_READ,
      keywords: ['home', 'overview'],
    },
    {
      id: 'upload', label: 'Upload Document', icon: UploadCloud,
      description: 'Upload a new document',
      action: () => router.push('/dashboard/upload'),
      permission: PERMISSIONS.DOCUMENT_UPLOAD,
      keywords: ['new', 'create', 'add'],
    },
    {
      id: 'browse', label: 'Browse Files', icon: FolderOpen,
      action: () => router.push('/dashboard/browse'),
      permission: PERMISSIONS.FOLDER_READ,
      keywords: ['explore', 'folders'],
    },
    {
      id: 'files', label: 'My Files', icon: Files,
      action: () => router.push('/dashboard/files'),
      permission: PERMISSIONS.DOCUMENT_READ,
      keywords: ['my documents', 'owned'],
    },
    {
      id: 'search', label: 'Search Documents', icon: Search,
      action: () => router.push('/dashboard/search'),
      permission: PERMISSIONS.SEARCH_READ,
      keywords: ['find', 'query', 'lookup'],
    },
    {
      id: 'notifications', label: 'Notifications', icon: Bell,
      action: () => router.push('/dashboard/notifications'),
      permission: PERMISSIONS.NOTIFICATION_READ,
      keywords: ['alerts', 'messages'],
    },
    {
      id: 'approvals', label: 'Approval Queue', icon: ClipboardCheck,
      description: 'Review pending workflow tasks',
      action: () => router.push('/approver'),
      permission: PERMISSIONS.WORKFLOW_APPROVE,
      keywords: ['approve', 'review', 'tasks'],
    },
    {
      id: 'records', label: 'Records Console', icon: Archive,
      description: 'Manage retention and legal holds',
      action: () => router.push('/records-officer'),
      permission: PERMISSIONS.RETENTION_MANAGE,
      keywords: ['retention', 'archive', 'disposal'],
    },
    {
      id: 'audit', label: 'Audit Log', icon: ShieldCheck,
      description: 'View the immutable audit trail',
      action: () => router.push('/auditor'),
      permission: PERMISSIONS.AUDIT_READ,
      keywords: ['logs', 'history', 'events'],
    },
    {
      id: 'admin', label: 'Administration', icon: Settings2,
      description: 'System configuration and users',
      action: () => router.push('/admin'),
      permission: PERMISSIONS.USER_MANAGE,
      keywords: ['users', 'config', 'system'],
    },
    {
      id: 'settings', label: 'Settings', icon: Settings2,
      action: () => router.push('/settings'),
      keywords: ['preferences', 'theme'],
    },
  ];

  // Filter by permission + search query
  const visibleItems = ALL_ITEMS.filter((item) => {
    if (item.permission && !can(item.permission)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      item.keywords?.some((k) => k.includes(q))
    );
  });

  const handleSelect = useCallback((item: CommandItem) => {
    setOpen(false);
    setQuery('');
    item.action();
  }, []);

  // Ctrl+K to open
  useKeyboardShortcuts([
    {
      key: 'k',
      ctrl: true,
      handler: () => setOpen((v) => !v),
    },
    {
      key: 'Escape',
      handler: () => setOpen(false),
    },
  ]);

  // Reset query on close. Done during render rather than in an effect: the
  // palette briefly re-rendered with the old query still in the box on the way
  // out, and react-hooks/set-state-in-effect rejects the effect form.
  useResetOnChange([open], () => {
    if (!open) setQuery('');
  });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 animate-fade-up" />
        <Dialog.Content
          className="fixed left-1/2 top-[20vh] z-50 w-full max-w-xl -translate-x-1/2 rounded-2xl bg-surface-card border border-border shadow-2xl overflow-hidden"
          aria-label="Command palette"
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <Search className="h-4 w-4 text-text-muted shrink-0" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands…"
              className="flex-1 bg-transparent text-text-primary placeholder:text-text-muted outline-none text-sm"
            />
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-lg hover:bg-surface-raised text-text-muted"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-80 overflow-y-auto ui-scrollbar py-2">
            {visibleItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-text-muted text-center">No commands match &quot;{query}&quot;</p>
            ) : (
              visibleItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleSelect(item)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-raised transition-colors"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-raised shrink-0">
                      <Icon className="h-4 w-4 text-text-secondary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{item.label}</p>
                      {item.description && (
                        <p className="text-xs text-text-muted">{item.description}</p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-[11px] text-text-muted">
            <span><kbd className="font-mono bg-surface-raised px-1 rounded">↵</kbd> Select</span>
            <span><kbd className="font-mono bg-surface-raised px-1 rounded">Esc</kbd> Close</span>
            <span className="ml-auto"><kbd className="font-mono bg-surface-raised px-1 rounded">Ctrl K</kbd> Toggle</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
