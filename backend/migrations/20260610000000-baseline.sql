-- S6-08: Baseline migration — all core EDAMS tables
-- Run before all sprint-specific migrations on a fresh database.

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret VARCHAR(255),
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  password_changed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID,
  UNIQUE(user_id, role_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token VARCHAR(500) NOT NULL,
  csrf_token VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, department_id)
);

CREATE TABLE IF NOT EXISTS folder_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  path VARCHAR(2000) NOT NULL UNIQUE,
  level INT NOT NULL,
  parent_id UUID REFERENCES folder_nodes(id) ON DELETE SET NULL,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  is_system_managed BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  default_retention_class VARCHAR(50) NOT NULL,
  requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
  signatory_role VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  retention_years INT,
  is_permanent BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_event VARCHAR(100) NOT NULL,
  disposal_action VARCHAR(100) NOT NULL,
  authority VARCHAR(500) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  document_name VARCHAR(255) NOT NULL UNIQUE,
  title VARCHAR(255) NOT NULL,
  department_id UUID NOT NULL REFERENCES departments(id),
  document_type_id UUID NOT NULL REFERENCES document_types(id),
  folder_id UUID REFERENCES folder_nodes(id) ON DELETE SET NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  organisation_unit VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,
  approval_status VARCHAR(50) NOT NULL DEFAULT 'NOT_REQUIRED',
  security_classification VARCHAR(20) NOT NULL,
  sensitivity_label VARCHAR(30) NOT NULL DEFAULT 'Internal',
  retention_class VARCHAR(50) NOT NULL,
  retention_trigger_date TIMESTAMPTZ,
  disposal_eligible_date TIMESTAMPTZ,
  current_version VARCHAR(10) NOT NULL DEFAULT '1.0',
  latest_version_id UUID,
  source VARCHAR(50) NOT NULL,
  is_on_legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  ocr_status VARCHAR(50),
  ocr_confidence_score DOUBLE PRECISION,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_tenant_idx ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS documents_dept_idx ON documents(department_id);
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);
CREATE INDEX IF NOT EXISTS documents_hold_idx ON documents(is_on_legal_hold);
CREATE INDEX IF NOT EXISTS documents_deleted_idx ON documents(deleted_at);

CREATE TABLE IF NOT EXISTS document_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dept_code VARCHAR(10) NOT NULL,
  doc_type_code VARCHAR(10) NOT NULL,
  date_key VARCHAR(8) NOT NULL,
  last_seq INT NOT NULL DEFAULT 0,
  UNIQUE(dept_code, doc_type_code, date_key)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number VARCHAR(10) NOT NULL,
  is_major_version BOOLEAN NOT NULL DEFAULT FALSE,
  storage_key VARCHAR(1000) NOT NULL,
  storage_bucket VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  extracted_text TEXT,
  author_id UUID NOT NULL REFERENCES users(id),
  change_summary VARCHAR(2000) NOT NULL,
  is_migration_import BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS doc_versions_document_idx ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS doc_versions_hash_idx ON document_versions(sha256_hash);

CREATE TABLE IF NOT EXISTS document_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  keywords TEXT,
  description TEXT,
  tags TEXT,
  related_document_ids TEXT,
  external_reference VARCHAR(200),
  originating_system VARCHAR(100),
  physical_record_ref VARCHAR(100),
  language VARCHAR(10),
  geographic_scope VARCHAR(100),
  confidentiality_notice VARCHAR(500),
  legal_hold_flag BOOLEAN NOT NULL DEFAULT FALSE,
  legal_hold_case_ref VARCHAR(100),
  archive_date TIMESTAMPTZ,
  disposal_authorised_by UUID,
  disposal_authorised_at TIMESTAMPTZ,
  certificate_of_destruction_ref VARCHAR(100),
  custom_fields TEXT
);

CREATE TABLE IF NOT EXISTS document_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  checked_out_by UUID NOT NULL REFERENCES users(id),
  checked_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS doc_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  locked_by UUID NOT NULL REFERENCES users(id),
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  document_type_id UUID REFERENCES document_types(id),
  version VARCHAR(20) NOT NULL,
  definition TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workflow_definition_id UUID NOT NULL REFERENCES workflow_definitions(id),
  current_stage INT NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL,
  initiated_by_id UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  workflow_instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  stage_name VARCHAR(100) NOT NULL,
  stage_number INT NOT NULL,
  assigned_to_user_id UUID REFERENCES users(id),
  assigned_to_role VARCHAR(50),
  delegated_to_user_id UUID,
  sla_deadline_at TIMESTAMPTZ NOT NULL,
  sla_warning_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(50) NOT NULL,
  decision VARCHAR(20),
  decision_reason VARCHAR(2000),
  decided_at TIMESTAMPTZ,
  sla_breached_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  is_sla_breach BOOLEAN NOT NULL DEFAULT FALSE,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegating_user_id UUID NOT NULL REFERENCES users(id),
  delegate_user_id UUID NOT NULL REFERENCES users(id),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  reason VARCHAR(500),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signature_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id UUID REFERENCES document_versions(id),
  signatory_user_id UUID NOT NULL REFERENCES users(id),
  signing_type VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL,
  certificate_subject VARCHAR(500),
  certificate_issuer VARCHAR(500),
  certificate_serial VARCHAR(100),
  cert_not_before TIMESTAMPTZ,
  cert_not_after TIMESTAMPTZ,
  signature_algorithm VARCHAR(100),
  document_hash_at_sign VARCHAR(64),
  signature_data TEXT,
  timestamp_token TEXT,
  ltv_embedded BOOLEAN NOT NULL DEFAULT FALSE,
  sig_storage_key VARCHAR(1000),
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  consent_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  signed_at TIMESTAMPTZ,
  decline_reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_reference VARCHAR(100) NOT NULL,
  description VARCHAR(2000) NOT NULL,
  custodian_name VARCHAR(255) NOT NULL,
  legal_basis VARCHAR(1000) NOT NULL,
  expected_duration VARCHAR(255),
  status VARCHAR(20) NOT NULL,
  applied_by_id UUID NOT NULL REFERENCES users(id),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  released_by_id UUID,
  release_closure_ref VARCHAR(100),
  release_reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  legal_hold_id UUID NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  UNIQUE(document_id, legal_hold_id)
);

CREATE TABLE IF NOT EXISTS archive_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id),
  archive_package_ref VARCHAR(255),
  archive_storage_path VARCHAR(1000),
  archive_storage_tier VARCHAR(50) NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by_id UUID,
  status VARCHAR(30) NOT NULL,
  disposal_eligible_at TIMESTAMPTZ,
  disposal_authorised_at TIMESTAMPTZ,
  disposed_at TIMESTAMPTZ,
  cod_reference VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificates_of_destruction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference VARCHAR(100) NOT NULL UNIQUE,
  document_ids TEXT NOT NULL,
  disposal_method VARCHAR(100) NOT NULL,
  authorised_by_id UUID NOT NULL REFERENCES users(id),
  authorised_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pdf_storage_key VARCHAR(1000)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_number BIGSERIAL NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type VARCHAR(100) NOT NULL,
  user_id UUID,
  user_role VARCHAR(50),
  source_ip VARCHAR(45),
  session_id VARCHAR(100),
  document_id UUID,
  document_version VARCHAR(10),
  action_details TEXT NOT NULL,
  previous_state VARCHAR(50),
  new_state VARCHAR(50),
  is_success BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(100),
  previous_hash VARCHAR(64),
  entry_hash VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS audit_logs_sequence_idx ON audit_logs(sequence_number);
CREATE INDEX IF NOT EXISTS audit_logs_event_type_idx ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS audit_logs_document_idx ON audit_logs(document_id);
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs(timestamp);

-- Immutability: block UPDATE and DELETE on audit_logs
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID,
  type VARCHAR(100) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  payload TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  error_msg VARCHAR(2000),
  process_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox_events(status, process_after);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id UUID,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  query VARCHAR(1000) NOT NULL,
  filters VARCHAR(2000),
  is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  department_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  response_body TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_deks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  encrypted_dek TEXT NOT NULL,
  kek_id VARCHAR(255) NOT NULL,
  algorithm VARCHAR(50) NOT NULL DEFAULT 'AES-256-GCM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dept_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL UNIQUE REFERENCES departments(id),
  tenant_id VARCHAR(100) NOT NULL,
  kek_reference VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purge_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL UNIQUE REFERENCES documents(id),
  staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL,
  approved_by_id UUID,
  approved_at TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS purge_pending_status_idx ON purge_pending(status, purge_after);

CREATE TABLE IF NOT EXISTS retention_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES retention_policies(id),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  eligible_at TIMESTAMPTZ NOT NULL,
  notified_90_days BOOLEAN NOT NULL DEFAULT FALSE,
  notified_30_days BOOLEAN NOT NULL DEFAULT FALSE,
  disposal_authorised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retention_app_document_idx ON retention_applications(document_id);
CREATE INDEX IF NOT EXISTS retention_app_eligible_idx ON retention_applications(eligible_at);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  url VARCHAR(2000) NOT NULL,
  secret VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sequelize Meta (migration tracking) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
  name VARCHAR(255) NOT NULL PRIMARY KEY
);

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP TABLE IF EXISTS webhook_subscriptions CASCADE;
-- DROP TABLE IF EXISTS retention_applications CASCADE;
-- DROP TABLE IF EXISTS purge_pending CASCADE;
-- DROP TABLE IF EXISTS dept_keys CASCADE;
-- DROP TABLE IF EXISTS document_deks CASCADE;
-- DROP TABLE IF EXISTS idempotency_keys CASCADE;
-- DROP TABLE IF EXISTS saved_searches CASCADE;
-- DROP TABLE IF EXISTS notifications CASCADE;
-- DROP TABLE IF EXISTS outbox_events CASCADE;
-- DROP TABLE IF EXISTS audit_logs CASCADE;
-- DROP TABLE IF EXISTS certificates_of_destruction CASCADE;
-- DROP TABLE IF EXISTS archive_records CASCADE;
-- DROP TABLE IF EXISTS document_legal_holds CASCADE;
-- DROP TABLE IF EXISTS legal_holds CASCADE;
-- DROP TABLE IF EXISTS signature_records CASCADE;
-- DROP TABLE IF EXISTS workflow_delegations CASCADE;
-- DROP TABLE IF EXISTS workflow_tasks CASCADE;
-- DROP TABLE IF EXISTS workflow_instances CASCADE;
-- DROP TABLE IF EXISTS workflow_definitions CASCADE;
-- DROP TABLE IF EXISTS doc_locks CASCADE;
-- DROP TABLE IF EXISTS document_checkouts CASCADE;
-- DROP TABLE IF EXISTS document_metadata CASCADE;
-- DROP TABLE IF EXISTS document_versions CASCADE;
-- DROP TABLE IF EXISTS document_sequences CASCADE;
-- DROP TABLE IF EXISTS documents CASCADE;
-- DROP TABLE IF EXISTS retention_policies CASCADE;
-- DROP TABLE IF EXISTS document_types CASCADE;
-- DROP TABLE IF EXISTS folder_nodes CASCADE;
-- DROP TABLE IF EXISTS user_departments CASCADE;
-- DROP TABLE IF EXISTS departments CASCADE;
-- DROP TABLE IF EXISTS auth_sessions CASCADE;
-- DROP TABLE IF EXISTS user_roles CASCADE;
-- DROP TABLE IF EXISTS roles CASCADE;
-- DROP TABLE IF EXISTS users CASCADE;
-- DROP TABLE IF EXISTS "SequelizeMeta";
-- DROP EXTENSION IF EXISTS "pgcrypto";
