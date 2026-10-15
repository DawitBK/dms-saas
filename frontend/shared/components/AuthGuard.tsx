"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "../../state/auth.store";

// /select-tenant is reachable mid-login: the user has a userId + preTenantToken
// but no accessToken yet (multi-tenant accounts). It must be public or the guard
// bounces multi-tenant users (e.g. admin) back to /login before they can pick a tenant.
// The page self-guards by requiring a preTenantToken.
// /select-role is the same shape one step later in the sequence: a multi-role
// user has a userId + preRoleToken but no accessToken yet. Omitted here
// originally (only /select-tenant was added), which meant this guard bounced
// every multi-role user straight back to /login before the role picker ever
// rendered — never actually broken for single-role users, so it went
// unnoticed until an account with >1 role tried to sign in. The page
// self-guards by requiring a preRoleToken, same as /select-tenant.
// /auth/callback is the OIDC/SSO return URL: the user arrives with a code but no
// accessToken yet, so it must be public or the guard bounces them to /login
// before the code can be exchanged.
const PUBLIC_PATHS = ["/login", "/select-tenant", "/select-role", "/verify", "/auth/callback"];

// Public pages that stay accessible even when logged in (no bounce to /dashboard):
// /verify is the CAMS letter QR-verification page — anyone scanning a printed
// letter lands here, signed in or not.
const NO_REDIRECT_WHEN_AUTHED = ["/verify"];

// FIX: the render-time guard below used to check membership with a bare
// `pathname.startsWith(p)` — no path-boundary check, unlike this same file's
// redirect-effect check just above it. A future route that merely shares a
// prefix with a public one (e.g. a hypothetical /verify-report) would match
// here and render `children` (protected content) for one frame before the
// effect's boundary-aware check redirects it away. One shared helper now
// backs every membership check in this file.
function matchesPublicPath(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { accessToken, userId, hydrated } = useAuthStore();

  useEffect(() => {
    if (!hydrated) return;

    const isPublic = matchesPublicPath(pathname, PUBLIC_PATHS);

    if (!accessToken || !userId) {
      if (!isPublic) router.replace("/login");
      return;
    }

    const stayPut = matchesPublicPath(pathname, NO_REDIRECT_WHEN_AUTHED);
    if (isPublic && accessToken && !stayPut) {
      router.replace("/dashboard");
    }
  }, [hydrated, accessToken, userId, pathname, router]);

  if (!hydrated) {
    return (
      <div className="flex flex-1 items-center justify-center min-h-screen">
        <div className="h-10 w-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if ((!accessToken || !userId) && !matchesPublicPath(pathname, PUBLIC_PATHS)) {
    return (
      <div className="flex flex-1 items-center justify-center min-h-screen text-slate-500 text-sm">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}
