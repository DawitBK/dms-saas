-- Per-type opt-out of the approval chain: when false, a document of this
-- type can be published/discarded directly from DRAFT by its owner instead
-- of always falling back to a hardcoded single-step DEPT_MANAGER chain.
-- Defaults to true so every existing document type keeps today's behavior.
ALTER TABLE document_types
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT true;
