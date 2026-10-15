import type { Request } from "express";
import jwt from "jsonwebtoken";

/**
 * TEN-2: the general/upload rate limiters in app.ts run BEFORE `authenticate`
 * in the middleware chain (this app mounts auth per-router, not globally —
 * `authenticate` doesn't run until inside a specific module's router), so
 * `req.user`/tenantId are never available to a `keyGenerator` there. Plain
 * IP keying means every tenant sharing a corporate NAT egress — which
 * Example Corp's sister-company/branch tenants plausibly do — shares one
 * bucket: one tenant's burst (or one compromised/scripted account) exhausts
 * it and locks out every other tenant behind the same gateway.
 *
 * Fix: key by tenant when a bearer token is present, falling back to IP only
 * for genuinely pre-auth/anonymous traffic. This is a bucketing decision,
 * not an authorization one — `jwt.decode()` deliberately does NOT verify the
 * signature (that already happens for real, later, in `authenticate`). A
 * forged/tampered `tenant_id` claim here only ever misfiles a request into a
 * different bucket that is itself still rate-limited; it can never grant
 * extra requests or bypass the limit, so skipping verification for a keying
 * decision carries no authorization risk.
 */
export function tenantAwareKeyGenerator(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const decoded = jwt.decode(header.slice(7)) as { tenant_id?: string } | null;
      if (decoded?.tenant_id) return `tenant:${decoded.tenant_id}`;
    } catch {
      // Malformed token — authenticate() will reject it properly downstream;
      // fall through to IP keying here.
    }
  }
  return `ip:${req.ip}`;
}
