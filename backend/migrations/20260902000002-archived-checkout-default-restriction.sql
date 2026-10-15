-- Default-deny "checkout" on an ARCHIVED document to SYSTEM_ADMIN only.
--
-- document_status_action_roles (20260901000001) ships with no rows at all,
-- which its own enforcement (statusPermissions.service.ts's
-- assertStatusPermission) treats as fully unrestricted — anyone who could
-- otherwise check out a document could also check out an archived one,
-- re-opening filed/immutable records for editing with no extra gate. That's
-- not a safe default for a records-management system, so every existing
-- tenant gets a starting rule restricting ARCHIVED/checkout to SYSTEM_ADMIN,
-- matching the default tenants.service.ts's createTenant now seeds for every
-- NEW tenant from this point on. Admins can broaden this per-tenant from the
-- Access Control Center's Status Rules tab (PATCH /documents/status-permissions)
-- exactly like any other status/action rule — this migration only backfills
-- the same starting point new tenants get, it doesn't hardcode the
-- restriction outside the existing configurable mechanism.
INSERT INTO document_status_action_roles (tenant_id, status, action, role_name)
SELECT id, 'ARCHIVED', 'checkout', 'SYSTEM_ADMIN'
FROM tenants
ON CONFLICT (tenant_id, status, action, role_name) DO NOTHING;
