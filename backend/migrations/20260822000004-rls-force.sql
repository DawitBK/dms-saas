-- P1-15: FORCE ROW LEVEL SECURITY on every table that has RLS enabled.
--
-- THE GAP THIS CLOSES, precisely: in PostgreSQL a table's OWNER bypasses row-level
-- security entirely unless the table carries FORCE ROW LEVEL SECURITY. Not one
-- table in this database had it. So every tenant-isolation policy in the
-- *-rls-*.sql migrations is inert for whichever role owns the tables — and
-- DEPLOYMENT-GUIDE.md provisions the application role with
-- `GRANT CREATE ON SCHEMA public TO edams_app`, which means if the migrations are
-- run as edams_app (the documented path), edams_app OWNS every table and RLS has
-- never actually been filtering anything in production.
--
-- config/env.ts's existing guard only refuses the literal user name `postgres`, so
-- it cannot see this at all: the role name is right, the isolation is absent.
--
-- Two things now catch it. This migration removes the bypass, and
-- assertRlsIsEnforced() in infrastructure/database/sequelize.ts proves at boot
-- (production/staging only) that a tenant-scoped read really returns zero rows for
-- a tenant that cannot exist -- refusing to start rather than serving cross-tenant
-- data quietly.
--
-- APPLY THIS DELIBERATELY, not as part of an unattended deploy. If RLS has in fact
-- been bypassed until now, this is the moment it starts filtering, and any code
-- path that reads a tenant-scoped table WITHOUT app.current_tenant set will begin
-- returning zero rows silently instead of everything. The two known such paths
-- (user_tenants and user_permission_overrides, both read pre-tenant-context in the
-- auth flow) are deliberately excluded from RLS in
-- 20260822000003-rls-coverage-gaps.sql for exactly this reason -- see that file's
-- header. Run the DMS test suite and exercise login, browse, and the approval
-- flows against a non-superuser role before promoting this.
--
-- FORCE does NOT apply to superusers or BYPASSRLS roles; nothing can make it. That
-- is what the role-attribute half of the boot probe is for.

ALTER TABLE access_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE acl_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_chain_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_chains FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_stage_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE dept_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_approval_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_links FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE letter_sequences FORCE ROW LEVEL SECURITY;
ALTER TABLE letters FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE org_units FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
ALTER TABLE folder_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE document_types FORCE ROW LEVEL SECURITY;
ALTER TABLE document_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE document_comments FORCE ROW LEVEL SECURITY;
ALTER TABLE form_templates FORCE ROW LEVEL SECURITY;
