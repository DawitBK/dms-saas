'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Menu, LogOut, Settings, Download, ChevronRight } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../state/auth.store';
import { useUIStore } from '../../state/ui.store';
import { Avatar } from './Avatar';
import { apiClient } from '../lib/apiClient';
import { usePwaInstall } from '../hooks/usePwaInstall';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface TopBarProps {
  title?: string;
  breadcrumbs?: Breadcrumb[];
  onMobileMenuToggle?: () => void;
}

export const TopBar = ({ title, breadcrumbs, onMobileMenuToggle }: TopBarProps) => {
  const { firstName, lastName, email, role, clearSession, accessToken } = useAuthStore();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const router = useRouter();
  const { canInstall, isIos, isInstalled, promptInstall } = usePwaInstall();
  const [showIosHint, setShowIosHint] = useState(false);
  const showInstallItem = !isInstalled && (canInstall || isIos);

  const { data: notifData } = useQuery({
    queryKey: ['notifications-count'],
    queryFn: () => apiClient<{ count: number }>('/notifications/unread-count'),
    staleTime: 60_000,
    gcTime: 120_000,
    retry: false,
    enabled: !!accessToken,
  });
  const unreadCount = notifData?.count ?? 0;

  const displayName =
    firstName || lastName ? `${firstName ?? ''} ${lastName ?? ''}`.trim() : (email ?? 'User');

  const handleSignOut = () => {
    clearSession();
    router.push('/login');
  };

  return (
    <header
      className="sticky top-0 z-40 flex items-center justify-between px-6"
      style={{
        height: 'var(--topbar-height)',
        background: 'var(--surface-card)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Left: hamburger + breadcrumbs / title */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          className="ui-btn ui-btn-ghost ui-btn-icon lg:hidden"
          onClick={onMobileMenuToggle ?? toggleSidebar}
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>

        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav className="flex items-center gap-1 text-[13px] min-w-0">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                )}
                {crumb.href && i < breadcrumbs.length - 1 ? (
                  <Link
                    href={crumb.href}
                    className="topbar-breadcrumb-link truncate transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        ) : title ? (
          <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {title}
          </h2>
        ) : null}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Notification bell */}
        <Link
          href="/dashboard/notifications"
          className="relative ui-btn ui-btn-ghost ui-btn-icon"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full text-[9px] font-bold text-white flex items-center justify-center"
              style={{ background: 'var(--brand-600)', lineHeight: 1 }}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Link>

        {/* Divider */}
        <div className="w-px h-5 mx-1" style={{ background: 'var(--border)' }} />

        {/* User menu */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="topbar-user-trigger flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-lg transition-colors focus:outline-none">
              <Avatar
                firstName={firstName ?? undefined}
                lastName={lastName ?? undefined}
                email={email ?? undefined}
                size="sm"
              />
              <span
                className="hidden md:block text-[13px] font-medium max-w-[120px] truncate"
                style={{ color: 'var(--text-primary)' }}
              >
                {displayName}
              </span>
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-50 min-w-[220px] p-1.5 animate-scale-in"
              style={{
                background: 'var(--surface-card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              {/* User info header */}
              <div
                className="px-3 py-2.5 mb-1"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <div className="flex items-center gap-2.5">
                  <Avatar
                    firstName={firstName ?? undefined}
                    lastName={lastName ?? undefined}
                    email={email ?? undefined}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
                      {displayName}
                    </p>
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                      {email}
                    </p>
                  </div>
                </div>
                {role && (
                  <span
                    className="inline-block mt-2 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                    style={{
                      color: 'var(--brand-600)',
                      background: 'var(--brand-50)',
                      border: '1px solid var(--brand-200)',
                    }}
                  >
                    {role}
                  </span>
                )}
              </div>

              <DropdownMenu.Item asChild>
                <Link
                  href="/settings"
                  className="topbar-menu-item flex items-center gap-2.5 text-[13px] px-3 py-2 rounded-md cursor-pointer outline-none transition-colors"
                >
                  <Settings className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                  Settings
                </Link>
              </DropdownMenu.Item>

              {showInstallItem && (
                <div className="relative">
                  <DropdownMenu.Item
                    onSelect={(e) => {
                      if (canInstall) {
                        void promptInstall();
                      } else {
                        e.preventDefault();
                        setShowIosHint((v) => !v);
                      }
                    }}
                    className="topbar-menu-item flex items-center gap-2.5 text-[13px] px-3 py-2 rounded-md cursor-pointer outline-none transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                    Install App
                  </DropdownMenu.Item>
                  {showIosHint && (
                    <div
                      className="absolute right-full top-0 z-10 mr-2 w-56 rounded-lg p-3 text-[11px] shadow-lg"
                      style={{ background: 'var(--surface-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                    >
                      Tap the Share icon, then &quot;Add to Home Screen&quot;.
                    </div>
                  )}
                </div>
              )}

              <DropdownMenu.Separator className="my-1" style={{ height: 1, background: 'var(--border)' }} />

              <DropdownMenu.Item
                onSelect={handleSignOut}
                className="topbar-signout-item flex items-center gap-2.5 text-[13px] px-3 py-2 rounded-md cursor-pointer outline-none transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
};
