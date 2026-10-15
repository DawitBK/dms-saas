// Dev mock auth — calls POST /auth/login which issues an RS256 JWT with the same
// claim shape the backend's authenticate() middleware expects: user_id, role, tenant_id.
// In production this page is replaced by the external identity provider redirect.
'use client';

import { Files, AlertTriangle, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuthStore } from '../../../state/auth.store';
import { API_BASE_URL } from '../../../shared/lib/apiConfig';

// Build-time switch (inlined by Next). Dev machines only; see the note at the form.
const SHOW_DEV_LOGIN = process.env.NEXT_PUBLIC_DEV_LOGIN === 'true';

const DEMO_ACCOUNTS = [
  { email: 'admin@edams.local', label: 'System Admin', role: 'Full access' },
  { email: 'manager@edams.local', label: 'Dept Manager', role: 'Dept management' },
  { email: 'officer@edams.local', label: 'Records Officer', role: 'Records & retention' },
  { email: 'approver@edams.local', label: 'Approver', role: 'Workflow approvals' },
  { email: 'employee@edams.local', label: 'Employee', role: 'Read & upload' },
  { email: 'auditor@edams.local', label: 'Auditor', role: 'Audit log access' },
  { email: 'chief@edams.local', label: 'Chief Executive', role: 'Organisation-wide oversight' },
];

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);

  const [email, setEmail] = useState('admin@edams.local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // L4: two-factor step. When the backend answers { mfaRequired: true,
  // mfaPendingToken }, the page used to fall through to `data.accessToken`
  // (undefined) and silently produce a broken session — an MFA-enabled user
  // simply could not log in. Holding the pending token here switches the form
  // to a TOTP-code step that exchanges it via /auth/totp/validate.
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  function completeSession(data: any) {
    const { accessToken, user } = data;
    setSession({
      accessToken,
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      roles: user.roles ?? [user.role],
      tenantId: user.tenantId,
      availableTenants: [user.tenantId],
      tenantSelectionRequired: false,
      preTenantToken: null,
      // availableRoles falls back to roles so a single-role user's switcher
      // UI correctly sees "only one role" rather than an empty list.
      availableRoles: user.availableRoles ?? user.roles ?? [user.role],
      roleSelectionRequired: false,
      preRoleToken: null,
      permissions: user.permissions ?? [],
      mfaStatus: 'verified',
    });
    router.push('/dashboard');
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/auth/totp/validate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ mfaPendingToken, code: mfaCode }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Invalid verification code');
      }
      completeSession(await res.json());
    } catch (err: any) {
      setError(err?.message ?? 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Login failed');
      }

      const data = await res.json();

      if (data.mfaRequired) {
        setMfaPendingToken(data.mfaPendingToken);
        setMfaCode('');
        return;
      }

      if (data.tenantSelectionRequired) {
        setSession({
          userId: data.user.id,
          email: data.user.email,
          firstName: data.user.firstName,
          lastName: data.user.lastName,
          roles: data.user.roles ?? [data.user.role],
          availableTenants: data.availableTenants ?? [],
          tenantSelectionRequired: true,
          preTenantToken: data.preTenantToken,
          mfaStatus: 'verified',
        });
        router.push('/select-tenant');
        return;
      }

      // Multi-role user: tenant is already resolved (or there was only ever
      // one), but which role to act as isn't. Mirrors tenantSelectionRequired
      // above one step later in the sequence.
      if (data.roleSelectionRequired) {
        setSession({
          userId: data.user.id,
          email: data.user.email,
          firstName: data.user.firstName,
          lastName: data.user.lastName,
          roles: data.user.roles,
          tenantId: data.user.tenantId,
          availableTenants: [data.user.tenantId],
          tenantSelectionRequired: false,
          availableRoles: data.availableRoles ?? [],
          roleSelectionRequired: true,
          preRoleToken: data.preRoleToken,
          mfaStatus: 'verified',
        });
        router.push('/select-role');
        return;
      }

      completeSession(data);
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="h-full flex"
      style={{ background: 'var(--surface)' }}
    >
      {/* Left panel — branding */}
      <div
        className="hidden lg:flex flex-col justify-between w-[420px] shrink-0 p-10 overflow-y-auto"
        style={{ background: '#0d0f1a', borderRight: '1px solid rgba(255,255,255,0.06)' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center rounded-lg"
            style={{ width: 36, height: 36, background: 'var(--brand-600)' }}
          >
            <Files className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-white tracking-tight leading-none">DMS</p>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-none">Enterprise DMS</p>
          </div>
        </div>

        {/* Middle copy */}
        <div>
          <h2
            className="text-2xl font-bold leading-snug mb-3"
            style={{ color: '#e2e8f0', letterSpacing: '-0.03em' }}
          >
            Document management<br />built for enterprise scale.
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: '#475569' }}>
            Secure multi-tenant document control with full audit trails,
            automated retention policies, legal holds, and role-based access control.
          </p>
          <div className="mt-8 space-y-3">
            {[
              'DENY-first ACL with folder & department ancestry',
              'Immutable hash-chained audit log',
              'Retention lifecycle & certified disposal',
              'Electronic & PKI document signing',
            ].map((feat) => (
              <div key={feat} className="flex items-center gap-2.5">
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ background: 'var(--brand-500)' }}
                />
                <span className="text-[13px]" style={{ color: '#64748b' }}>{feat}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <p className="text-[11px]" style={{ color: '#1e293b' }}>
          © 2026 DMS Enterprise. Confidential system.
        </p>
      </div>

      {/* Right panel — login form */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="min-h-full flex items-center justify-center">
        <div className="w-full max-w-[400px]">
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{ width: 36, height: 36, background: 'var(--brand-600)' }}
            >
              <Files className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>DMS</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Enterprise DMS</p>
            </div>
          </div>

          {/* Heading */}
          <div className="mb-8">
            <h1
              className="text-2xl font-bold mb-1"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.025em' }}
            >
              {mfaPendingToken ? 'Two-factor verification' : 'Sign in'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {mfaPendingToken
                ? 'Enter the 6-digit code from your authenticator app'
                : "Access your organization's document management system"}
            </p>
          </div>

          {mfaPendingToken ? (
            <form onSubmit={submitMfa}>
              <div className="mb-4">
                <label className="ui-label">Verification code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="ui-input text-center tracking-[0.5em] font-mono text-lg"
                  style={{ height: 48 }}
                  autoFocus
                />
              </div>

              {error && (
                <div
                  className="flex gap-2 p-3 mb-4 rounded-lg text-[13px]"
                  style={{
                    background: 'var(--danger-bg)',
                    border: '1px solid var(--danger-border)',
                    color: 'var(--danger-text)',
                  }}
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || mfaCode.length !== 6}
                className="ui-btn ui-btn-primary ui-btn-lg w-full justify-center"
              >
                {busy ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    Verifying…
                  </span>
                ) : (
                  <>
                    Verify & sign in
                    <ChevronRight className="h-4 w-4" />
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => { setMfaPendingToken(null); setMfaCode(''); setError(null); }}
                className="w-full mt-3 text-[13px] font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Back to sign in
              </button>
            </form>
          ) : (
          <>
          {/* SSO — Example Corp Identity Provider (production sign-in path) */}
          <button
            type="button"
            onClick={() => {
              // Resolved to an absolute URL before assigning. API_BASE_URL is
              // whatever NEXT_PUBLIC_API_BASE_URL was at build time and may be
              // a bare path, and assigning a possibly-relative destination to
              // window.location is what @next/next/no-location-assign-relative
              // -destination warns about — resolving against this page's own
              // origin makes the target explicit and same-origin by construction.
              window.location.href = new URL(
                `${API_BASE_URL}/auth/oidc/authorize`,
                window.location.origin,
              ).toString();
            }}
            className="ui-btn ui-btn-lg w-full justify-center mb-5"
            style={{ background: 'var(--brand-600)', color: '#fff' }}
          >
            Sign in with Example Corp SSO
            <ChevronRight className="h-4 w-4" />
          </button>

          {/* The passwordless dev login and the demo-account list exist only for a developer
              machine: NEXT_PUBLIC_DEV_LOGIN is set in .env.development and nowhere else. A
              production or mirror build shows the SSO button alone. (The backend refuses the
              endpoint too once LOCAL_JWT_MOCK=false; hiding the form just stops the page
              advertising seeded demo emails.) */}
          {SHOW_DEV_LOGIN && (
            <>
            <div className="flex items-center gap-3 mb-5">
              <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
              <span className="text-[11px] uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>or dev login</span>
              <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
            </div>

            <form onSubmit={submitLogin}>
              {/* Dev notice */}
              <div
                className="flex gap-2.5 p-3.5 mb-5 rounded-lg"
                style={{
                  background: 'var(--warning-bg)',
                  border: '1px solid var(--warning-border)',
                }}
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
                <p className="text-[12px] leading-relaxed" style={{ color: 'var(--warning-text)' }}>
                  <strong>Development mode</strong> — enter any seeded email to authenticate.
                  No password required in dev. Production uses an external identity provider.
                </p>
              </div>

              {/* Email field */}
              <div className="mb-4">
                <label className="ui-label">Email address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@organization.com"
                  className="ui-input"
                  style={{ height: 40 }}
                  autoFocus
                />
              </div>

              {/* Error */}
              {error && (
                <div
                  className="flex gap-2 p-3 mb-4 rounded-lg text-[13px]"
                  style={{
                    background: 'var(--danger-bg)',
                    border: '1px solid var(--danger-border)',
                    color: 'var(--danger-text)',
                  }}
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={busy}
                className="ui-btn ui-btn-primary ui-btn-lg w-full justify-center"
              >
                {busy ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    Signing in…
                  </span>
                ) : (
                  <>
                    Sign in
                    <ChevronRight className="h-4 w-4" />
                  </>
                )}
              </button>

              {/* Demo accounts */}
              <div className="mt-6 pt-5" style={{ borderTop: '1px solid var(--border)' }}>
                <p
                  className="text-[11px] font-bold uppercase tracking-widest mb-3"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Demo accounts
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {DEMO_ACCOUNTS.map(({ email: acc, label, role }) => (
                    <button
                      key={acc}
                      type="button"
                      onClick={() => setEmail(acc)}
                      className="text-left px-3 py-2.5 rounded-lg transition-colors"
                      style={{
                        background: email === acc ? 'rgba(99,102,241,0.06)' : 'var(--surface-raised)',
                        border: `1px solid ${email === acc ? 'var(--brand-200)' : 'var(--border)'}`,
                      }}
                      onMouseEnter={(e) => {
                        if (email !== acc) {
                          (e.currentTarget as HTMLElement).style.background = 'var(--surface-card)';
                          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-strong)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (email !== acc) {
                          (e.currentTarget as HTMLElement).style.background = 'var(--surface-raised)';
                          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                        }
                      }}
                    >
                      <p className="text-[12px] font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
                        {label}
                      </p>
                      <p className="text-[11px] mt-1 leading-none" style={{ color: 'var(--text-muted)' }}>
                        {role}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </form>
            </>
          )}
          </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
