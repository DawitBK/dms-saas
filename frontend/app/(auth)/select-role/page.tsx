// Real login-flow step (replaces the old SPRINT-1 dev-only demo page): shown
// when a user holds more than one role and login/select-tenant deferred
// which one to act as (auth.service.ts's selectRole/switchRole).
// Mirrors select-tenant/page.tsx's shape.
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ShieldQuestion, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../../../state/auth.store';
import { API_BASE_URL } from '../../../shared/lib/apiConfig';

function formatRoleName(role: string): string {
  return role
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export default function SelectRolePage() {
  const router = useRouter();
  const { availableRoles, preRoleToken, setSession, clearSession } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // MFA can still be required after picking a role (see auth.service.ts's
  // selectRole) — same two-step shape the login page's own dev-login form uses.
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (!preRoleToken || !availableRoles || availableRoles.length === 0) {
      router.push('/login');
    }
  }, [preRoleToken, availableRoles, router]);

  function completeSession(data: any) {
    const { accessToken, user } = data;
    setSession({
      accessToken,
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      roles: user.roles,
      availableRoles: user.availableRoles ?? availableRoles,
      roleSelectionRequired: false,
      preRoleToken: null,
      tenantId: user.tenantId,
      permissions: user.permissions ?? [],
      mfaStatus: 'verified',
    });
    router.push('/dashboard');
  }

  async function selectRole(roleName: string) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/select-role`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${preRoleToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({ roleName }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Role selection failed');
      }

      const data = await res.json();

      if (data.mfaRequired) {
        setMfaPendingToken(data.mfaPendingToken);
        setMfaCode('');
        setBusy(false);
        return;
      }

      completeSession(data);
    } catch (err: any) {
      setError(err?.message ?? 'Role selection failed');
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/totp/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mfaPendingToken, code: mfaCode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Invalid verification code');
      }
      completeSession(await res.json());
    } catch (err: any) {
      setError(err?.message ?? 'Verification failed');
      setBusy(false);
    }
  }

  const handleCancel = () => {
    clearSession();
    router.push('/login');
  };

  if (!availableRoles || availableRoles.length === 0) {
    return null;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <section className="w-full max-w-md bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 bg-indigo-600 rounded-xl">
            <ShieldQuestion className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {mfaPendingToken ? 'Two-factor verification' : 'Select your role'}
            </h1>
            <p className="text-xs text-slate-500">
              {mfaPendingToken
                ? 'Enter the 6-digit code from your authenticator app'
                : 'Choose which role to sign in as'}
            </p>
          </div>
        </div>

        {!mfaPendingToken && (
          <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl mb-6">
            <p className="text-xs text-blue-800 leading-relaxed">
              You hold more than one role. What you can see and do is scoped to the
              role you pick — you can switch to another role you hold anytime from
              Settings once signed in.
            </p>
          </div>
        )}

        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
            {error}
          </div>
        )}

        {mfaPendingToken ? (
          <form onSubmit={submitMfa}>
            <div className="mb-4">
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
                className="w-full text-center tracking-[0.5em] font-mono text-lg rounded-xl border-2 border-slate-200 px-4 py-3 focus:border-indigo-400 focus:outline-none"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={busy || mfaCode.length !== 6}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 text-white font-semibold py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setMfaPendingToken(null); setMfaCode(''); setError(null); }}
              className="w-full mt-3 text-sm text-slate-600 hover:text-slate-900 font-medium"
            >
              Back to role selection
            </button>
          </form>
        ) : (
          <>
            <div className="space-y-2 mb-6">
              {availableRoles.map((roleName) => (
                <button
                  key={roleName}
                  onClick={() => selectRole(roleName)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-left"
                >
                  <div className="p-2 bg-slate-100 rounded-lg">
                    <ShieldCheck className="h-5 w-5 text-slate-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-900">{formatRoleName(roleName)}</p>
                    <p className="text-xs text-slate-500">{roleName}</p>
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={handleCancel}
              disabled={busy}
              className="w-full text-sm text-slate-600 hover:text-slate-900 font-medium disabled:opacity-50"
            >
              Cancel and sign out
            </button>
          </>
        )}
      </section>
    </div>
  );
}
