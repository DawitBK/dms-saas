-- S6-09: Create tenants table for multi-tenant quota management.

CREATE TABLE IF NOT EXISTS tenants (
  id            VARCHAR(100) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  "storageQuotaBytes" BIGINT NOT NULL DEFAULT 10737418240,   -- 10 GB
  "storageUsedBytes"  BIGINT NOT NULL DEFAULT 0,
  "maxUsers"          INT    NOT NULL DEFAULT 50,
  "maxDocuments"      INT    NOT NULL DEFAULT 100000,
  "isActive"          BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the dev tenant (matches auth.routes.ts dev token issuer & seed-core TENANT_ID)
INSERT INTO tenants (id, name, "storageQuotaBytes", "storageUsedBytes", "maxUsers", "maxDocuments")
VALUES ('examplecorp', 'Example Corp', 10737418240, 0, 50, 100000)
ON CONFLICT (id) DO NOTHING;
