// OIDC/SSO callback. The Example Corp IdP redirects here with ?code&state after a
// successful login. We POST them to the backend /auth/callback, which verifies
// the id_token against the IdP JWKS, JIT-provisions the user, and returns an
// DMS session (mirroring the dev mock login + two-phase tenant selection).
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../../state/auth.store';
import { API_BASE_URL } from '../../../shared/lib/apiConfig';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const code = params.get('code');
  const state = params.get('state');
  const oidcError = params.get('error');

  // The two failures the URL itself already describes are DERIVED, not
  // fetched — computing them during render rather than setState-ing them from
  // the mount effect means the error page is the first thing painted instead
  // of a flash of the "Signing you in…" spinner. react-hooks/set-state-in-effect
  // (an error under eslint-config-next 16) rejects the effect form too.
  const paramError = oidcError
    ? params.get('error_description') || oidcError
    : !code || !state
      ? 'Missing authorization code.'
      : null;
  // Only the code-for-session exchange below can fail asynchronously.
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  const error = paramError ?? exchangeError;
  const ran = useRef(false); // guard against React strict-mode double invoke

  useEffect(() => {
    if (paramError) return;
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/callback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ code, state }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message ?? 'SSO sign-in failed');

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
          router.replace('/select-tenant');
          return;
        }

        // Multi-role SSO user: tenant is already resolved, but which role to
        // act as isn't. Mirrors the dev-login page's roleSelectionRequired
        // branch — see auth.store's availableRoles/preRoleToken fields.
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
          router.replace('/select-role');
          return;
        }

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
          permissions: user.permissions ?? [],
          mfaStatus: 'verified',
        });
        router.replace('/dashboard');
      } catch (err: any) {
        setExchangeError(err?.message ?? 'SSO sign-in failed');
      }
    })();
  }, [paramError, code, state, router, setSession]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--surface)' }}>
      <div className="text-center">
        {error ? (
          <>
            <p className="text-sm font-semibold mb-2" style={{ color: 'var(--danger-text)' }}>Sign-in failed</p>
            <p className="text-[13px] mb-4" style={{ color: 'var(--text-muted)' }}>{error}</p>
            <button className="ui-btn ui-btn-primary" onClick={() => router.replace('/login')}>Back to sign in</button>
          </>
        ) : (
          <>
            <div className="h-10 w-10 mx-auto mb-4 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Completing single sign-on…</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function SsoCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackInner />
    </Suspense>
  );
}
