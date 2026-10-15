-- Drop five indexes that duplicate another index on the same table and
-- columns. Every INSERT and UPDATE on these tables has been maintaining both
-- B-trees for nothing.
--
-- Same class of finding as 20260811000002-documents-composite-indexes.sql's
-- part #11, which already de-duplicated the four `documents` columns that
-- 20260610000000-baseline.sql and 20260615000010-perf-indexes.sql had each
-- independently indexed under different names five days apart. That pass only
-- covered `documents`; the same two migrations (plus 20260626/27's two
-- back-to-back access_rules migrations) left the pairs below behind.
--
-- This matters most on `audit_logs`, which is the highest-write table in the
-- system by construction: writeAuditLog inserts a row for essentially every
-- mutating request, inside that request's own transaction and under the
-- per-tenant advisory lock (audit.service.ts), so index maintenance here sits
-- directly on the critical path of every write the application performs.
--
-- Convention follows the earlier dedupe: where two names describe the same
-- index, keep the one from the older migration and drop the newer, purely to
-- minimise churn.

-- audit_logs(document_id) — baseline's audit_logs_document_idx is identical.
-- (audit_logs_tenant_doc_idx is a different, composite index; it stays.)
DROP INDEX IF EXISTS idx_audit_logs_document_id;

-- audit_logs(timestamp) — baseline's audit_logs_timestamp_idx is ASC and this
-- one DESC, but a single-column B-tree is scannable in both directions, so
-- Postgres can satisfy `ORDER BY timestamp DESC` from either. Genuinely
-- redundant, not a differently-useful ordering.
DROP INDEX IF EXISTS idx_audit_logs_timestamp;

-- document_versions(document_id) — baseline's doc_versions_document_idx is
-- identical.
DROP INDEX IF EXISTS idx_document_versions_document_id;

-- access_rules(tenant_id, principal_type, principal_id) — 20260626000002's
-- access_rules_principal_idx is identical. The two access_rules migrations
-- landed one day apart and neither knew about the other.
DROP INDEX IF EXISTS idx_access_rules_principal;

-- notifications(user_id, read_at) — not a duplicate by columns, but dead:
-- nothing reads or orders by `read_at`. The unread badge queries
-- `{ userId, isRead: false }` and mark-as-read WRITES `readAt` (see
-- notifications.routes.ts), both of which are served by baseline's
-- notifications_user_idx (user_id, is_read). This index has only ever added
-- write cost to a table that takes a row per fanOut recipient.
DROP INDEX IF EXISTS idx_notifications_user_id;
