DROP POLICY IF EXISTS legal_holds_tenant_isolation ON legal_holds;
ALTER TABLE legal_holds DISABLE ROW LEVEL SECURITY;
