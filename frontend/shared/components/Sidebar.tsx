'use client';

import { useMemo, useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  FolderOpen,
  Files,
  Search,
  UploadCloud,
  Settings2,
  LogOut,
  Bell,
  Bot,
  ChevronRight,
  ChevronDown,
  Shield,
  Database,
  FileText,
  FileSignature,
  Mail,
  Paperclip,
  Trash2,
  CheckSquare,
  FileStack,
  Users,
  Activity,
  Globe,
  Building2,
  FolderTree,
  ClipboardList,
  Archive,
  Gavel,
  BarChart3,
  KeyRound,
  Cpu,
  Play,
  ListChecks,
  Send,
  Plus,
  AlertTriangle,
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useAuthStore } from '../../state/auth.store';
import { fallbackPollInterval, useRealtimeStore } from '../../state/realtime.store';
import { useUIStore } from '../../state/ui.store';
import { usePermissions } from '../hooks/usePermissions';
import { useLicenseModules } from '../hooks/useLicense';
import { isNavHrefLicensed } from '../lib/license';
import { PERMISSIONS } from '../lib/permissions';
import { Avatar } from './Avatar';
import { ThemeSwitcher } from './ThemeSwitcher';
import { InstallAppButton } from './InstallAppButton';
import { TenantSwitcher } from './TenantSwitcher';
import { cn } from '../lib/cn';
import { apiClient } from '../lib/apiClient';

type NavItem = {
  name: string;
  href: string;
  icon: React.ElementType;
  permission: string;
  badge?: number;
  /** Category label rendered above this item when shown inside an expanded dropdown. */
  section?: string;
};

/** A collapsible nav entry: click toggles an inline dropdown of sub-links instead of navigating. */
type NavParent = {
  name: string;
  icon: React.ElementType;
  children: NavItem[];
};

type NavEntry = NavItem | NavParent;

function isParent(entry: NavEntry): entry is NavParent {
  return 'children' in entry;
}

type NavGroup = {
  name: string;
  items: NavEntry[];
};

const navGroups: NavGroup[] = [
  {
    name: 'Documents',
    items: [
      {
        // audit 2026-08-11 UI/UX sweep #1: the home page is gated on
        // NOTIFICATION_READ, which every role holds (including SYSTEM_ADMIN's
        // full grant), not on DOCUMENT_READ — a custom role without document
        // access still needs a link back to /dashboard. (EXECUTIVE used to be
        // that role; since 2026-10-04 it reads every module tenant-wide, but the
        // gate stays because custom roles can still lack DOCUMENT_READ.) Same
        // choice already used for "My Work"/"Notifications" below.
        name: 'Dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        permission: PERMISSIONS.NOTIFICATION_READ,
      },
      {
        name: 'My Work',
        href: '/dashboard/mywork',
        icon: CheckSquare,
        permission: PERMISSIONS.NOTIFICATION_READ,
      },
      {
        name: 'Reports & Analytics',
        href: '/dashboard/reports',
        icon: BarChart3,
        permission: PERMISSIONS.DOCUMENT_READ_ALL,
      },
      {
        name: 'Browse',
        href: '/dashboard/browse',
        icon: FolderOpen,
        permission: PERMISSIONS.FOLDER_READ,
      },
      {
        name: 'My Files',
        href: '/dashboard/files',
        icon: Files,
        permission: PERMISSIONS.DOCUMENT_READ,
      },
      {
        name: 'Search',
        href: '/dashboard/search',
        icon: Search,
        permission: PERMISSIONS.SEARCH_READ,
      },
      {
        name: 'AI Assistant',
        href: '/dashboard/ai',
        icon: Bot,
        permission: PERMISSIONS.AI_CHAT,
      },
      {
        name: 'Upload',
        href: '/dashboard/upload',
        icon: UploadCloud,
        permission: PERMISSIONS.DOCUMENT_UPLOAD,
      },
      {
        name: 'Notifications',
        href: '/dashboard/notifications',
        icon: Bell,
        permission: PERMISSIONS.NOTIFICATION_READ,
      },
      {
        name: 'Forms',
        icon: FileText,
        children: [
          {
            name: 'Templates',
            href: '/dashboard/forms/templates',
            icon: FileText,
            permission: PERMISSIONS.DOCUMENT_READ,
          },
          {
            name: 'Fill a Form',
            href: '/dashboard/forms/fill',
            icon: Play,
            permission: PERMISSIONS.DOCUMENT_UPLOAD,
          },
          {
            name: 'My Submissions',
            href: '/dashboard/forms/submissions',
            icon: ListChecks,
            permission: PERMISSIONS.DOCUMENT_READ,
          },
        ],
      },
      {
        name: 'E-Signing',
        icon: FileSignature,
        children: [
          {
            name: 'Pending My Signature',
            href: '/dashboard/signing/pending',
            icon: FileSignature,
            permission: PERMISSIONS.SIGNING_READ,
          },
          {
            name: 'Sent for Signature',
            href: '/dashboard/signing/sent',
            icon: Send,
            permission: PERMISSIONS.SIGNING_READ,
          },
          {
            name: 'Completed',
            href: '/dashboard/signing/completed',
            icon: CheckSquare,
            permission: PERMISSIONS.SIGNING_READ,
          },
          {
            // Tenant-wide, read-only oversight (executive, auditor, records officer, administrator).
            name: 'All Requests',
            href: '/dashboard/signing/overview',
            icon: ListChecks,
            permission: PERMISSIONS.DOCUMENT_READ_ALL,
          },
          {
            name: 'New Request',
            href: '/dashboard/signing',
            icon: Plus,
            permission: PERMISSIONS.SIGNING_MANAGE,
          },
        ],
      },
      {
        name: 'Letters',
        href: '/dashboard/letters',
        icon: Mail,
        permission: PERMISSIONS.LETTER_READ,
      },
      {
        name: 'Bundles',
        href: '/dashboard/bundles',
        icon: Paperclip,
        permission: PERMISSIONS.DOCUMENT_READ,
      },
      {
        name: 'Recycle Bin',
        href: '/dashboard/trash',
        icon: Trash2,
        permission: PERMISSIONS.DOCUMENT_READ,
      },
    ],
  },
  {
    name: 'System',
    items: [
      {
        name: 'Operations',
        icon: Shield,
        children: [
          {
            name: 'Manager Hub',
            href: '/operations?panel=manager',
            icon: LayoutDashboard,
            permission: PERMISSIONS.DEPT_MANAGE,
            section: 'Department Management',
          },
          {
            name: 'Compliance Reports',
            href: '/operations?panel=reports',
            icon: BarChart3,
            permission: PERMISSIONS.AUDIT_READ,
            section: 'Compliance Reporting',
          },
          {
            name: 'Audit Logs',
            href: '/operations?panel=audit',
            icon: Shield,
            permission: PERMISSIONS.AUDIT_READ,
            section: 'Audit & Security',
          },
          {
            name: 'Chain Integrity',
            href: '/operations?panel=integrity',
            icon: Shield,
            permission: PERMISSIONS.AUDIT_READ,
          },
          {
            name: 'Users',
            href: '/operations?panel=users',
            icon: Users,
            permission: PERMISSIONS.USER_MANAGE,
            section: 'User & Access Management',
          },
          {
            name: 'Role Editor',
            href: '/operations?panel=roles',
            icon: Shield,
            permission: PERMISSIONS.ROLE_MANAGE,
          },
          {
            name: 'Access Control',
            href: '/operations?panel=accessControl',
            icon: Shield,
            permission: PERMISSIONS.ACL_MANAGE,
          },
          {
            name: 'Tenants',
            href: '/operations?panel=tenants',
            icon: Globe,
            permission: PERMISSIONS.TENANT_READ,
            section: 'Configuration & Settings',
          },
          {
            name: 'Organization',
            href: '/operations?panel=orgUnits',
            icon: Building2,
            permission: PERMISSIONS.ORG_UNIT_READ,
          },
          {
            name: 'Departments',
            href: '/operations?panel=departments',
            icon: Building2,
            permission: PERMISSIONS.DEPT_READ,
          },
          {
            name: 'Hierarchy Browser',
            href: '/operations?panel=hierarchy',
            icon: FolderTree,
            permission: PERMISSIONS.DEPT_READ,
          },
          {
            name: 'Folders',
            href: '/operations?panel=folders',
            icon: FolderTree,
            permission: PERMISSIONS.FOLDER_READ,
          },
          {
            name: 'Document Types',
            href: '/operations?panel=docTypes',
            icon: FileStack,
            permission: PERMISSIONS.DOCTYPE_READ,
          },
          {
            name: 'Workflow Queue',
            href: '/operations?panel=workflows',
            icon: ClipboardList,
            permission: PERMISSIONS.WORKFLOW_APPROVE,
            section: 'Workflow & Approvals',
          },
          {
            name: 'Workflow Definitions',
            href: '/operations?panel=workflowDefs',
            icon: ClipboardList,
            permission: PERMISSIONS.WORKFLOW_MANAGE,
          },
          {
            name: 'Approval Chains',
            href: '/operations?panel=approvalChains',
            icon: ClipboardList,
            permission: PERMISSIONS.WORKFLOW_MANAGE,
          },
          {
            name: 'Lifecycle Queue',
            href: '/operations?panel=lifecycle',
            icon: Archive,
            permission: PERMISSIONS.RETENTION_MANAGE,
            section: 'Records Management',
          },
          {
            name: 'Retention Policies',
            href: '/operations?panel=retentionPolicies',
            icon: Archive,
            permission: PERMISSIONS.RETENTION_MANAGE,
          },
          {
            name: 'Legal Holds',
            href: '/operations?panel=legalHold',
            icon: Gavel,
            permission: PERMISSIONS.LEGAL_HOLD_MANAGE,
          },
          {
            name: 'OCR Review',
            href: '/operations?panel=ocr',
            icon: Activity,
            permission: PERMISSIONS.RETENTION_MANAGE,
          },
          {
            name: 'System Health',
            href: '/operations?panel=health',
            icon: Activity,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
            section: 'System Operations',
          },
          {
            name: 'Pipeline Observability',
            href: '/operations?panel=pipeline',
            icon: BarChart3,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'System Errors',
            href: '/operations?panel=systemErrors',
            icon: AlertTriangle,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'AI Controls',
            href: '/operations?panel=aiControls',
            icon: Bot,
            permission: PERMISSIONS.AI_MANAGE,
          },
          {
            name: 'Outbox Queue',
            href: '/operations?panel=outbox',
            icon: Database,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'Webhooks',
            href: '/operations?panel=webhooks',
            icon: Globe,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'Antivirus / Scanning',
            href: '/operations?panel=antivirus',
            icon: Shield,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'Crypto / KEK Status',
            href: '/operations?panel=cryptoStatus',
            icon: KeyRound,
            permission: PERMISSIONS.OPERATIONS_MANAGE,
          },
          {
            name: 'Feature Flags',
            href: '/operations?panel=featureFlags',
            icon: Cpu,
            permission: PERMISSIONS.TENANT_MANAGE,
          },
        ],
      },
      {
        name: 'Storage',
        href: '/dashboard/storage',
        icon: Database,
        permission: PERMISSIONS.DOCUMENT_READ_ALL,
      },
      {
        // Settings' own tabs (appearance/profile) require no permission at
        // all (app/settings/page.tsx's TABS array) — gating the nav link on
        // DOCUMENT_READ was copy-pasted from the document-nav items above
        // rather than a deliberate choice, and made Settings unreachable for
        // any custom role without DOCUMENT_READ.
        name: 'Settings',
        href: '/settings',
        icon: Settings2,
        permission: PERMISSIONS.NOTIFICATION_READ,
      },
    ],
  },
];

const SIDEBAR_STORAGE_KEY = 'dms-sidebar-width';
const SIDEBAR_MIN_WIDTH = 60; // px - collapsed icon mode
const SIDEBAR_MAX_WIDTH_PERCENT = 0.3; // 30% of viewport
const SIDEBAR_DEFAULT_WIDTH = 302; // px - 252 * 1.2

const SIDEBAR_KEYBOARD_STEP = 20; // px per arrow-key press

/** Largest width the sidebar may take, given the current viewport. */
function maxSidebarWidth(): number {
  return window.innerWidth * SIDEBAR_MAX_WIDTH_PERCENT;
}

// The persisted width is browser state with no value during SSR, so it is read
// through useSyncExternalStore rather than an effect that setStates it in on
// mount. That is React's supported way to express exactly this — the server
// snapshot renders the default, hydration matches it, and the stored width
// applies on the first client render — and it is what
// react-hooks/set-state-in-effect (an error under eslint-config-next 16) asks
// for. `storage` covers another tab changing it; writes from THIS tab notify
// through `widthListeners`, because the storage event does not fire in the tab
// that performed the write.
const widthListeners = new Set<() => void>();

function subscribeSidebarWidth(onChange: () => void) {
  widthListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    widthListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSavedSidebarWidth(): number {
  try {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH) return parsed;
    }
  } catch {}
  return SIDEBAR_DEFAULT_WIDTH;
}

const getServerSidebarWidth = () => SIDEBAR_DEFAULT_WIDTH;

function saveSidebarWidth(width: number) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  } catch {}
  widthListeners.forEach((cb) => cb());
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  // Licence module gate: entries whose module is not licensed are hidden (the API refuses them anyway, 403
  // LICENSE_MODULE_DISABLED). No status yet, or an unlicensed-nothing install, shows everything.
  const { isModuleOn } = useLicenseModules();
  const {
    userId,
    email,
    firstName,
    lastName,
    clearSession,
    hydrated,
    accessToken,
  } = useAuthStore();
  const { sidebarOpen, setSidebarOpen } = useUIStore();

  // Resizable sidebar width. The committed value lives in localStorage and is
  // read through the store above; `dragWidth` is the uncommitted width during
  // an active drag, so the sidebar still tracks the pointer live without
  // writing to localStorage on every mousemove.
  const storedWidth = useSyncExternalStore(
    subscribeSidebarWidth,
    getSavedSidebarWidth,
    getServerSidebarWidth,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const sidebarWidth = dragWidth ?? storedWidth;
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  // Update CSS variable and spacer when width changes
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    if (spacerRef.current) {
      spacerRef.current.style.width = `${sidebarWidth}px`;
    }
  }, [sidebarWidth]);

  // Handle mouse drag for resizing
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(e.clientX, maxSidebarWidth()));
      setDragWidth(newWidth);
    },
    [isResizing],
  );

  const handleMouseUp = useCallback(() => {
    if (isResizing) {
      setIsResizing(false);
      // Commit the dragged width, then drop back to reading it from the store.
      if (dragWidth !== null) saveSidebarWidth(dragWidth);
      setDragWidth(null);
    }
  }, [isResizing, dragWidth]);

  // Keyboard equivalent of the drag (WAI-ARIA's "window splitter" pattern:
  // role="separator" + arrow-key resize). The handle was mouse-only, which is
  // what jsx-a11y/no-static-element-interactions was pointing at — a control
  // with no keyboard path at all, not merely a missing role.
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -SIDEBAR_KEYBOARD_STEP;
      else if (e.key === 'ArrowRight') delta = SIDEBAR_KEYBOARD_STEP;
      else return;
      e.preventDefault();
      saveSidebarWidth(
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarWidth + delta, maxSidebarWidth())),
      );
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const socketConnected = useRealtimeStore((s) => s.connected);

  // Unread notification count. Driven by the real-time pipeline, not polling:
  // the `NOTIFICATION.CREATED` socket event (RealtimeBridge) invalidates the
  // ["notifications"] key, which prefix-matches this query and forces a refetch.
  // Fetches once on mount and on window refocus; no interval.
  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiClient<{ count: number }>('/notifications/unread-count'),
    enabled: !!accessToken && !!userId,
    staleTime: 20_000,
  });
  const unreadCount = unreadData?.count ?? 0;

  // Pending-action count for the My Work badge — same aggregate the My Work
  // page itself renders (approvals + audits + signatures + letters), so this
  // number and that page's list are always in sync.
  //
  // F-06 (audit 2026-09-03): the comment here used to claim this
  // was "realtime-invalidated the same way" as the notification count. It was
  // not. TanStack invalidation is prefix matching over key ARRAY ELEMENTS, and
  // RealtimeBridge invalidated ["my-work"], which does not match this query's
  // ["my-work-count"] — the strings differ at position 0. So the badge got no
  // realtime updates at all and moved only on mount, refocus, or once its
  // staleTime lapsed. ["my-work-count"] is now in the RealtimeBridge map.
  // The interval below is a fallback for a socket that is down, nothing more.
  const { data: myWorkData } = useQuery({
    queryKey: ['my-work-count'],
    queryFn: () => apiClient<{ approvals?: unknown[]; signatures?: unknown[]; audits?: unknown[]; letters?: unknown[] }>('/approvals/my/work'),
    enabled: !!accessToken && !!userId && isModuleOn('workflow'), // /approvals is the workflow module
    staleTime: 30_000,
    refetchInterval: fallbackPollInterval(socketConnected),
  });
  const myWorkCount =
    (myWorkData?.approvals?.length ?? 0) +
    (myWorkData?.signatures?.length ?? 0) +
    (myWorkData?.audits?.length ?? 0) +
    (myWorkData?.letters?.length ?? 0);

  // Kept in sync with AuthGuard.tsx's PUBLIC_PATHS/NO_REDIRECT_WHEN_AUTHED —
  // /auth/callback was missing here (AuthGuard already treated it as public),
  // so once the SSO exchange set userId but before router.replace('/dashboard')
  // took effect, `!userId` stopped short-circuiting and this briefly rendered
  // the full authenticated sidebar over the callback page's spinner.
  const isAuthPage =
    !userId ||
    pathname.startsWith('/login') ||
    pathname === '/' ||
    pathname === '/select-role' ||
    pathname === '/select-tenant' ||
    pathname === '/auth/callback';

  // Memoize so nav items don't recompute on every render
  const filteredGroups = useMemo(
    () => {
      const moduleOn = (href: string) => isNavHrefLicensed(href, isModuleOn);
      return navGroups
        .map((g) => ({
          ...g,
          items: g.items
            .map((entry): NavEntry | null => {
              if (isParent(entry)) {
                const children = entry.children.filter((child) =>
                  can(child.permission) && moduleOn(child.href),
                );
                return children.length > 0 ? { ...entry, children } : null;
              }
              return can(entry.permission) && moduleOn(entry.href) ? entry : null;
            })
            .filter((entry): entry is NavEntry => entry !== null),
        }))
        .filter((g) => g.items.length > 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, can, isModuleOn],
  );

  if (!hydrated || isAuthPage) return null;

  const onSignOut = () => {
    clearSession();
    router.push('/login');
  };

  return (
    <Tooltip.Provider delayDuration={200}>
      <>
        {/* Mobile overlay */}
        {sidebarOpen && (
          // role="presentation" is accurate rather than a lint dodge: this
          // layer is a mouse convenience for closing the drawer, and the
          // drawer's own navigation and controls are the keyboard path.
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm lg:hidden z-40"
            onClick={() => setSidebarOpen(false)}
            role="presentation"
          />
        )}

        {/* Mobile drawer */}
        <div
          className={cn(
            'fixed inset-y-0 left-0 z-50 lg:hidden transition-transform duration-300 ease-in-out will-change-transform',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          style={{ width: sidebarWidth }}
        >
          <SidebarContent
            groups={filteredGroups}
            pathname={pathname}
            searchParams={searchParams}
            onSignOut={onSignOut}
            user={{ firstName, lastName, email }}
            notificationCount={unreadCount}
            myWorkCount={myWorkCount}
          />
        </div>

        {/* Desktop sidebar */}
        <div className="hidden lg:block" ref={sidebarRef}>
          <div
            className="fixed inset-y-0 left-0 z-40"
            style={{ width: sidebarWidth }}
          >
            <SidebarContent
              groups={filteredGroups}
              pathname={pathname}
              searchParams={searchParams}
              onSignOut={onSignOut}
              user={{ firstName, lastName, email }}
              notificationCount={unreadCount}
              myWorkCount={myWorkCount}
            />
            {/* Drag handle — WAI-ARIA window splitter, keyboard-resizable with
                the arrow keys as well as draggable. */}
            <div
              className="absolute top-0 right-0 bottom-0 z-50 w-1.5 cursor-col-resize group"
              onMouseDown={handleMouseDown}
              onKeyDown={handleResizeKeyDown}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              tabIndex={0}
            >
              <div className="absolute inset-y-0 right-0 w-0.5 bg-transparent group-hover:bg-brand-500/50 transition-colors" />
            </div>
          </div>
          <div ref={spacerRef} style={{ width: sidebarWidth, flexShrink: 0 }} />
        </div>
      </>
    </Tooltip.Provider>
  );
}

function splitHref(href: string): {
  path: string;
  params: URLSearchParams | null;
} {
  const qIndex = href.indexOf('?');
  if (qIndex === -1) return { path: href, params: null };
  return {
    path: href.slice(0, qIndex),
    params: new URLSearchParams(href.slice(qIndex + 1)),
  };
}

function isItemActive(
  href: string,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
): boolean {
  const { path, params } = splitHref(href);
  const pathMatches =
    pathname === path ||
    (path !== '/dashboard' && pathname.startsWith(path + '/'));
  if (!pathMatches) return false;
  if (!params) return true;
  for (const [key, value] of params.entries()) {
    if (searchParams.get(key) !== value) return false;
  }
  return true;
}

interface SidebarContentProps {
  groups: NavGroup[];
  pathname: string;
  searchParams: ReturnType<typeof useSearchParams>;
  onSignOut: () => void;
  user: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
  };
  notificationCount?: number;
  myWorkCount?: number;
}

function SidebarContent({
  groups,
  pathname,
  searchParams,
  onSignOut,
  user,
  notificationCount = 0,
  myWorkCount = 0,
}: SidebarContentProps) {
  const [expandedOverride, setExpandedOverride] = useState<
    Record<string, boolean>
  >({});
  const displayName =
    user.firstName || user.lastName
      ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
      : (user.email ?? 'User');

  return (
    <div
      className="flex h-full flex-col"
      style={{
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
        width: 'var(--sidebar-width)',
      }}
    >
      {/* Logo */}
      <div
        className="flex h-[var(--topbar-height)] shrink-0 items-center gap-3 px-4"
        style={{ borderBottom: '1px solid var(--sidebar-border)' }}
      >
        <div
          className="flex items-center justify-center rounded-lg"
          style={{
            width: 32,
            height: 32,
            background: 'var(--brand-600)',
            flexShrink: 0,
          }}
        >
          <Files className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <p
            className="text-sm font-bold tracking-tight leading-none"
            style={{ color: 'var(--sidebar-logo-text)' }}
          >
            DMS
          </p>
          <p
            className="text-[10px] mt-0.5 leading-none"
            style={{ color: 'var(--sidebar-logo-sub)' }}
          >
            Enterprise DMS
          </p>
        </div>
      </div>

      {/* Tenant switcher */}
      <div
        className="px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--sidebar-border)' }}
      >
        <TenantSwitcher />
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 min-h-0 overflow-y-auto py-3 px-2 ui-scrollbar"
        aria-label="Main navigation"
      >
        {groups.map((group) => (
          <div
            key={group.name}
            style={{ marginBottom: 'var(--sidebar-group-mb)' }}
          >
            <p
              className="px-3 mb-1 text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{
                color: 'var(--sidebar-section-text)',
                letterSpacing: '0.1em',
              }}
            >
              {group.name}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((entry) => {
                if (isParent(entry)) {
                  const childActive = entry.children.map((child) =>
                    isItemActive(child.href, pathname, searchParams),
                  );
                  const hasActiveChild = childActive.some(Boolean);
                  const isOpen = expandedOverride[entry.name] ?? hasActiveChild;
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpandedOverride((prev) => ({
                            ...prev,
                            [entry.name]: !isOpen,
                          }))
                        }
                        className={cn(
                          'sidebar-nav-item group flex w-full items-center rounded-md px-3 font-medium transition-colors relative',
                          hasActiveChild ? 'sidebar-nav-item--active' : '',
                        )}
                        style={{
                          gap: 'var(--sidebar-item-gap)',
                          paddingBlock: 'var(--sidebar-item-py)',
                          fontSize: 'var(--sidebar-item-font)',
                        }}
                      >
                        {hasActiveChild && (
                          <span
                            className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                            style={{
                              background: 'var(--sidebar-active-border)',
                            }}
                          />
                        )}
                        <entry.icon className="h-4 w-4 shrink-0" />
                        <span className="truncate flex-1 text-left">
                          {entry.name}
                        </span>
                        <ChevronDown
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                            !isOpen && '-rotate-90',
                          )}
                          style={{ opacity: 0.6 }}
                        />
                      </button>
                      {isOpen && (
                        <ul
                          className="mt-0.5 mb-1 ml-4 space-y-0.5 border-l pl-2"
                          style={{ borderColor: 'var(--sidebar-border)' }}
                        >
                          {entry.children.map((child, idx) => (
                            <li key={child.href}>
                              {child.section && (
                                <p
                                  className="px-2 pt-2 pb-0.5 text-[9px] font-bold uppercase tracking-[0.08em]"
                                  style={{
                                    color: 'var(--sidebar-section-text)',
                                  }}
                                >
                                  {child.section}
                                </p>
                              )}
                              <Link
                                href={child.href}
                                aria-current={
                                  childActive[idx] ? 'page' : undefined
                                }
                                className={cn(
                                  'sidebar-nav-item group flex items-center rounded-md px-2.5 font-medium transition-colors relative',
                                  childActive[idx]
                                    ? 'sidebar-nav-item--active'
                                    : '',
                                )}
                                style={{
                                  gap: 'var(--sidebar-item-gap)',
                                  paddingBlock: 'var(--sidebar-child-py)',
                                  fontSize: 'var(--sidebar-child-font)',
                                }}
                              >
                                <child.icon className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{child.name}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                }

                const item = entry;
                const isActive = isItemActive(
                  item.href,
                  pathname,
                  searchParams,
                );
                return (
                  <li key={item.href}>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <Link
                          href={item.href}
                          aria-current={isActive ? 'page' : undefined}
                          className={cn(
                            'sidebar-nav-item group flex items-center rounded-md px-3 font-medium transition-colors relative',
                            isActive ? 'sidebar-nav-item--active' : '',
                          )}
                          style={{
                            gap: 'var(--sidebar-item-gap)',
                            paddingBlock: 'var(--sidebar-item-py)',
                            fontSize: 'var(--sidebar-item-font)',
                          }}
                        >
                          {isActive && (
                            <span
                              className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                              style={{
                                background: 'var(--sidebar-active-border)',
                              }}
                            />
                          )}
                          <span className="relative shrink-0">
                            <item.icon className="h-4 w-4" />
                            {/* Unread notification badge — only shown on the Bell (Notifications) item */}
                            {item.href === '/dashboard/notifications' &&
                              notificationCount > 0 && (
                                <span
                                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full text-white font-bold"
                                  style={{
                                    minWidth: 14,
                                    height: 14,
                                    fontSize: 9,
                                    lineHeight: '14px',
                                    background: 'var(--brand-600)',
                                    padding: '0 3px',
                                  }}
                                  aria-label={`${notificationCount} unread notifications`}
                                >
                                  {notificationCount > 99
                                    ? '99+'
                                    : notificationCount}
                                </span>
                              )}
                            {/* Pending-action badge on My Work — otherwise the only way to
                                learn "3 approvals waiting on you" was to already be on that page. */}
                            {item.href === '/dashboard/mywork' &&
                              myWorkCount > 0 && (
                                <span
                                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full text-white font-bold"
                                  style={{
                                    minWidth: 14,
                                    height: 14,
                                    fontSize: 9,
                                    lineHeight: '14px',
                                    background: 'var(--brand-600)',
                                    padding: '0 3px',
                                  }}
                                  aria-label={`${myWorkCount} items waiting on you`}
                                >
                                  {myWorkCount > 99 ? '99+' : myWorkCount}
                                </span>
                              )}
                          </span>
                          <span className="truncate">{item.name}</span>
                          {isActive && (
                            <ChevronRight className="h-3 w-3 ml-auto opacity-50 shrink-0" />
                          )}
                        </Link>
                      </Tooltip.Trigger>
                    </Tooltip.Root>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom section */}
      <div style={{ borderTop: '1px solid var(--sidebar-border)' }}>
        {/* Install app + theme switcher */}
        <div
          className="px-2 py-2 space-y-1"
          style={{ borderBottom: '1px solid var(--sidebar-border)' }}
        >
          <InstallAppButton />
          <div className="px-1">
            <ThemeSwitcher showLabel />
          </div>
        </div>

        {/* User profile */}
        <div className="p-2">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-md mb-0.5">
            <Avatar
              firstName={user.firstName || undefined}
              lastName={user.lastName || undefined}
              email={user.email || undefined}
              size="sm"
            />
            <div className="flex-1 min-w-0">
              <p
                className="text-[13px] font-semibold leading-none truncate"
                style={{ color: 'var(--sidebar-text-active)' }}
              >
                {displayName}
              </p>
              {user.email && (
                <p
                  className="text-[11px] mt-0.5 truncate"
                  style={{ color: 'var(--sidebar-text)' }}
                >
                  {user.email}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onSignOut}
            className="sidebar-signout-btn flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
