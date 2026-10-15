-- Phase 3 Task 1: Add departmentId to document_types
-- NULL = global (available to all departments)
-- non-NULL = department-scoped (only available within that department hierarchy)

ALTER TABLE document_types
ADD COLUMN department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX idx_document_types_department_id ON document_types(department_id);

COMMENT ON COLUMN document_types.department_id IS 'NULL = global type, non-NULL = department-scoped type';
