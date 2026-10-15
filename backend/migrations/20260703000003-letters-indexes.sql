-- Phase 3: letters shipped without indexes matching its real query predicates.
-- listLetters filters by department_id / created_by / assigned_to_user_id and
-- orders by updated_at; the archive search does leading-wildcard ILIKE on four
-- text columns. Add the covering btree indexes + trigram GIN indexes (pg_trgm
-- is already enabled by migration 20260622000001).

CREATE INDEX IF NOT EXISTS letters_tenant_dept_updated_idx ON letters (tenant_id, department_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS letters_tenant_created_by_idx  ON letters (tenant_id, created_by);
CREATE INDEX IF NOT EXISTS letters_tenant_assigned_idx    ON letters (tenant_id, assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS letters_tenant_updated_idx      ON letters (tenant_id, updated_at DESC);
-- Overdue incoming lookup (due_date in the past, still open)
CREATE INDEX IF NOT EXISTS letters_due_date_idx ON letters (tenant_id, due_date) WHERE due_date IS NOT NULL AND direction = 'INCOMING';

-- Trigram indexes for the archive full-text ILIKE search
CREATE INDEX IF NOT EXISTS letters_subject_trgm_idx       ON letters USING gin (subject gin_trgm_ops);
CREATE INDEX IF NOT EXISTS letters_reference_trgm_idx      ON letters USING gin (reference_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS letters_correspondent_trgm_idx  ON letters USING gin (correspondent gin_trgm_ops);
