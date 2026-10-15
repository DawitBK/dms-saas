-- Reverts users_tenant_isolation to its pre-fix definition (no self-row
-- exemption) -- see the up migration's comment for why that exemption
-- exists; reverting reintroduces the "User not found" 404 for any account
-- reading its own /users/me while active in a tenant it has no
-- user_tenants row for.
ALTER POLICY users_tenant_isolation ON users
USING (
  (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
  OR (EXISTS (
    SELECT 1 FROM user_tenants ut
    WHERE ut.user_id = users.id
      AND ut.tenant_id::text = NULLIF(current_setting('app.current_tenant', true), '')
  ))
);
