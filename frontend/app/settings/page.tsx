'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { useThemeStore } from '../../state/theme.store';
import { TopBar } from '../../shared/components/TopBar';
import { PageHeader } from '../../shared/components/PageHeader';
import { ThemeSwitcher } from '../../shared/components/ThemeSwitcher';
import { DataTable } from '../../shared/components/DataTable';
import { Badge } from '../../shared/components/Badge';
import { EmptyState } from '../../shared/components/EmptyState';
import { useUIStore } from '../../state/ui.store';
import { UsersManagementPanel } from '../../features/users/UsersManagementPanel';
import { ProfileSettingsPanel } from '../../features/settings/ProfileSettingsPanel';
import { DocumentTypesCrudPanel } from '../../features/admin/crudPanels';
import { RetentionConsole } from '../../features/retention/RetentionConsole';
import {
  useDocumentTypes,
  useRetentionClasses,
  useSystemHealth,
} from '../../features/settings/hooks';
import { cn } from '../../shared/lib/cn';
import {
  Palette,
  Users,
  FileType,
  Archive,
  Bell,
  ShieldCheck,
  Database,
  SlidersHorizontal,
  Shield,
  CheckCircle2,
  XCircle,
  QrCode,
  Copy,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../shared/lib/apiClient';

// No Role enum â€” settings tabs are gated by permissions, not role names

type SettingsTab =
  | 'appearance'
  | 'profile'
  | 'users'
  | 'document-types'
  | 'retention'
  | 'notifications'
  | 'security'
  | 'system';

const TABS: {
  key: SettingsTab;
  label: string;
  icon: React.ElementType;
  permission?: string;
}[] = [
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'profile', label: 'Profile & Signature', icon: SlidersHorizontal },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  {
    key: 'users',
    label: 'Users & Access',
    icon: Users,
    permission: 'user:manage',
  },
  {
    key: 'document-types',
    label: 'Document Types',
    icon: FileType,
    permission: 'doctype:manage',
  },
  {
    key: 'retention',
    label: 'Retention',
    icon: Archive,
    permission: 'retention:manage',
  },
  { key: 'security', label: 'Security', icon: Shield },
  {
    key: 'system',
    label: 'System',
    icon: ShieldCheck,
    permission: 'operations:manage',
  },
];

export default function SettingsPage() {
  const { can } = usePermissions();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  const visibleTabs = TABS.filter((t) => !t.permission || can(t.permission));

  return (
    <>
      <TopBar
        title="Settings"
        breadcrumbs={[{ label: 'Settings' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6 animate-fade-up">
        <div className="page-header">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage your preferences and system configuration</p>
        </div>

        <div className="flex gap-6 mt-6 flex-col sm:flex-row">
          {/* Sidebar tabs — its own card so it reads as a real navigation
              panel alongside the content card, not a bare list floating next
              to one. Active state is a left accent bar (rather than a full
              border box) so it stays legible without competing with the
              content card's own border. */}
          <aside className="w-full sm:w-52 shrink-0">
            <nav className="ui-card p-2 space-y-0.5 sm:sticky sm:top-6">
              {visibleTabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className="w-full flex items-center gap-2.5 pl-3 pr-3 py-2.5 rounded-lg text-[13px] font-medium transition-colors text-left border-l-2"
                  style={{
                    color: tab === key ? 'var(--brand-700)' : 'var(--text-secondary)',
                    background: tab === key ? 'rgba(99,102,241,0.08)' : 'transparent',
                    borderLeftColor: tab === key ? 'var(--brand-600)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (tab !== key) (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)';
                  }}
                  onMouseLeave={(e) => {
                    if (tab !== key) (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Tab content */}
          <div className="flex-1 min-w-0">
            <div className="ui-card p-6 sm:p-7">
              {tab === 'appearance' && <AppearanceTab />}
              {tab === 'profile' && <ProfileSettingsPanel />}
              {tab === 'notifications' && <NotificationsTab />}
              {tab === 'users' && <UsersTab />}
              {tab === 'document-types' && <DocumentTypesTab />}
              {tab === 'retention' && <RetentionTab />}
              {tab === 'security' && <SecurityTab />}
              {tab === 'system' && <SystemTab />}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="text-[15px] font-semibold mb-5 pb-3"
      style={{
        color: 'var(--text-primary)',
        letterSpacing: '-0.01em',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {children}
    </h3>
  );
}

function AppearanceTab() {
  const { theme } = useThemeStore();
  return (
    <div className="space-y-6">
      <SectionTitle>Appearance</SectionTitle>
      <div
        className="flex items-center justify-between p-4 rounded-xl"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
      >
        <div>
          <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Interface theme
          </p>
          <p className="text-[12px] mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>
            Current: {theme.replace(/-/g, ' ')}
          </p>
        </div>
        <ThemeSwitcher showLabel={false} />
      </div>
    </div>
  );
}

function NotificationsTab() {
  // L3: these toggles used to be local component state only — reset on every
  // mount, never sent anywhere, never consulted by any email. They now load
  // from and persist to /users/me/notification-prefs, which the backend's
  // outbox email dispatcher actually honors for work-reminder emails.
  const qc = useQueryClient();
  type Prefs = { emailOnWorkflow: boolean; emailOnLegalHold: boolean; emailOnSystem: boolean };

  const { data: prefs, isLoading } = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => apiClient<Prefs>('/users/me/notification-prefs'),
  });

  const { mutate: savePref, isPending } = useMutation({
    mutationFn: (patch: Partial<Prefs>) =>
      apiClient<Prefs>('/users/me/notification-prefs', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: (updated) => qc.setQueryData(['notification-prefs'], updated),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save preference'),
  });

  const toggle = (key: keyof Prefs) => {
    if (!prefs) return;
    savePref({ [key]: !prefs[key] });
  };

  if (isLoading || !prefs) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="ui-skeleton h-12 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionTitle>Notification Preferences</SectionTitle>
      {/*
        Only toggles that actually suppress an email are shown — each key here
        must have a matching entry in the backend outbox's PREF_SUPPRESSIBLE
        map or it suppresses nothing. Overdue-approval (SLA) escalations are
        compliance notices and are always sent.
      */}
      {(
        [
          {
            key: 'emailOnWorkflow' as const,
            label: 'Email me on approval & letter reminders',
            desc: 'Routine "your step is pending" reminders. Overdue-approval (SLA) escalations are always sent.',
          },
          {
            key: 'emailOnLegalHold' as const,
            label: 'Email me when my documents go under legal hold',
            desc: 'Informational notice when a hold freezes a document you own. The hold applies either way.',
          },
          {
            key: 'emailOnSystem' as const,
            label: 'Email me critical system alerts',
            desc: 'Operator alerts (storage, key management, queue failures). Shown in-app regardless; only relevant to administrators.',
          },
        ] as const
      ).map(({ key, label, desc }) => (
        <div key={key} className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">{label}</p>
            <p className="text-xs text-text-muted">{desc}</p>
          </div>
          <button
            onClick={() => toggle(key)}
            disabled={isPending}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
              prefs[key] ? 'bg-brand-600' : 'bg-border',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5',
                prefs[key] ? 'translate-x-4 ml-0.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      ))}
      <p className="text-xs text-text-muted italic">
        Compliance notices (retention disposal warnings, trash purge notices)
        are always delivered and cannot be turned off.
      </p>
    </div>
  );
}

function UsersTab() {
  return (
    <div>
      <SectionTitle>Users &amp; Access</SectionTitle>
      <UsersManagementPanel />
    </div>
  );
}

function DocumentTypesTab() {
  // One source of truth: reuse the full Operations CRUD panel (create, edit â€”
  // including the governance policies â€” and deactivate) instead of the old
  // read-only listing, so Settings and Operations never drift apart.
  return (
    <div>
      <SectionTitle>Document Types</SectionTitle>
      <DocumentTypesCrudPanel />
    </div>
  );
}

function RetentionTab() {
  // Reuse the full Operations console (create/update/deactivate policies)
  // instead of a read-only duplicate that drifts out of date.
  return (
    <div>
      <SectionTitle>Retention Policies</SectionTitle>
      <RetentionConsole />
    </div>
  );
}

function SecurityTab() {
  const [step, setStep] = useState<'idle' | 'setup' | 'confirm' | 'disable'>('idle');
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const { mutate: startSetup, isPending: settingUp } = useMutation({
    mutationFn: () => apiClient<{ secret: string; otpauthUrl: string }>('/auth/totp/setup', { method: 'POST' }),
    onSuccess: (data) => { setSetupData(data); setStep('setup'); setError(''); },
    onError: () => setError('Failed to start 2FA setup. Please try again.'),
  });

  const { mutate: confirmSetup, isPending: confirming } = useMutation({
    mutationFn: () => apiClient('/auth/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
    onSuccess: () => { setMfaEnabled(true); setStep('idle'); setCode(''); setSetupData(null); setError(''); },
    onError: () => setError('Invalid code â€” please try again.'),
  });

  const { mutate: disableMfa, isPending: disabling } = useMutation({
    mutationFn: () => apiClient('/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }),
    onSuccess: () => { setMfaEnabled(false); setStep('idle'); setCode(''); setError(''); },
    onError: () => setError('Invalid code â€” please try again.'),
  });

  const copySecret = () => {
    if (setupData?.secret) {
      navigator.clipboard.writeText(setupData.secret).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle>Security &amp; Two-Factor Authentication</SectionTitle>

      <div className="rounded-xl border p-5 space-y-4" style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}>
        <div className="flex items-start gap-3">
          <Shield className="h-5 w-5 mt-0.5 shrink-0" style={{ color: 'var(--brand-600)' }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Two-Factor Authentication (TOTP)
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Add an extra layer of security by requiring a time-based one-time code from an
              authenticator app (Google Authenticator, Authy, etc.) on every login.
            </p>
          </div>
          {mfaEnabled === true && (
            <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-600">
              <CheckCircle2 className="h-4 w-4" /> Enabled
            </span>
          )}
          {mfaEnabled === false && (
            <span className="ml-auto flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <XCircle className="h-4 w-4" /> Disabled
            </span>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">{error}</p>
        )}

        {step === 'idle' && (
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => startSetup()}
              disabled={settingUp}
              className="btn-primary text-sm"
            >
              {settingUp ? 'Startingâ€¦' : 'Set up 2FA'}
            </button>
            {mfaEnabled !== false && (
              <button
                onClick={() => { setStep('disable'); setError(''); }}
                className="btn-secondary text-sm"
              >
                Disable 2FA
              </button>
            )}
          </div>
        )}

        {step === 'setup' && setupData && (
          <div className="space-y-4">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              1. Scan the QR code with your authenticator app, or enter the secret manually:
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-black/5 dark:bg-white/10 px-3 py-2 rounded-lg flex-1 break-all" style={{ color: 'var(--text-primary)' }}>
                {setupData.secret}
              </code>
              <button onClick={copySecret} className="btn-secondary p-2" title="Copy secret">
                {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <QrCode className="h-4 w-4 shrink-0" />
              <span>Use <strong>otpauth://</strong> URI: <span className="font-mono break-all">{setupData.otpauthUrl}</span></span>
            </div>
            <div>
              <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                2. Enter the 6-digit code from your app to confirm:
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="ui-input w-36 text-center font-mono text-lg tracking-[0.4em]"
                />
                <button onClick={() => confirmSetup()} disabled={confirming || code.length !== 6} className="btn-primary">
                  {confirming ? 'Verifyingâ€¦' : 'Confirm'}
                </button>
                <button onClick={() => { setStep('idle'); setCode(''); setSetupData(null); setError(''); }} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'disable' && (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Enter your current 2FA code to disable two-factor authentication:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="ui-input w-36 text-center font-mono text-lg tracking-[0.4em]"
              />
              <button onClick={() => disableMfa()} disabled={disabling || code.length !== 6} className="btn-primary bg-red-600 hover:bg-red-700">
                {disabling ? 'Disablingâ€¦' : 'Disable 2FA'}
              </button>
              <button onClick={() => { setStep('idle'); setCode(''); setError(''); }} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SystemTab() {
  const { data, isLoading } = useSystemHealth();
  const checks = data && typeof data === 'object' ? Object.entries(data) : [];

  return (
    <div className="space-y-4">
      <SectionTitle>System Health</SectionTitle>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12 rounded-xl" />
          ))}
        </div>
      ) : data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {checks.map(([key, value]) => {
              const normalized = String(value).toLowerCase();
              const isHealthy = normalized === 'ok' || normalized === '0';
              return (
                <div
                  key={key}
                  className="rounded-xl border border-border bg-surface-raised p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary capitalize">
                        {key}
                      </p>
                      <p className="text-xs text-text-muted">
                        Runtime subsystem status
                      </p>
                    </div>
                    <Badge type={isHealthy ? 'ACTIVE' : 'ARCHIVED'}>
                      {String(value)}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
          <details className="rounded-xl border border-border bg-surface-raised">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-text-primary">
              Raw health payload
            </summary>
            <pre className="overflow-x-auto border-t border-border p-4 text-xs font-mono text-text-primary">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </div>
      ) : (
        <p className="text-sm text-text-muted">
          System health data unavailable.
        </p>
      )}
    </div>
  );
}
