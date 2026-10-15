-- Phase 3: incoming letters had no way to record that they were answered/closed
-- (RECEIVED → ARCHIVED was the whole lifecycle; due_date was write-only). Add
-- RESPONDED and CLOSED to the status CHECK so incoming correspondence can be
-- tracked to resolution and overdue items surfaced.

ALTER TABLE letters DROP CONSTRAINT IF EXISTS letters_status_check;
ALTER TABLE letters ADD CONSTRAINT letters_status_check CHECK (status IN (
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DISPATCHED',
  'RECEIVED', 'RESPONDED', 'CLOSED', 'ARCHIVED', 'CANCELLED'
));
