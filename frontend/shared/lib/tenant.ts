/**
 * Tenant ids are slugs (e.g. "examplecorp", "test-tenant-1"). The UI shows the
 * tenant as the root of the folder hierarchy (tenant → org unit → department →
 * folder), so turn the slug into a readable title.
 */
export function formatTenantName(tenantId: string | null | undefined): string {
  if (!tenantId) return 'Organization';
  return tenantId
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
