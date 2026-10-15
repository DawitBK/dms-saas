-- Retention engine activation backfill (gap register #1, SYSTEM-DECISIONS.md D11).
-- disposal_eligible_date was never computed at creation/archive, so it is NULL
-- on virtually every document and the nightly disposition sweep matched
-- nothing; retention_applications was never populated, so the 90/30-day
-- warning job iterated an empty set. Compute both for existing documents,
-- mirroring src/modules/retention/retentionEngine.ts:
--   * archive-based trigger events  -> archived_at + years (only if archived)
--   * DOCUMENT_DATE                 -> COALESCE(document_date, retention_trigger_date, created_at) + years
--   * everything else               -> COALESCE(retention_trigger_date, created_at) + years
-- Permanent / inactive / yearless policies leave the date NULL.

UPDATE documents d
SET disposal_eligible_date =
  CASE
    WHEN UPPER(p.trigger_event) LIKE '%ARCHIVE%' THEN
      d.archived_at + make_interval(years => p.retention_years)
    WHEN UPPER(p.trigger_event) = 'DOCUMENT_DATE' THEN
      COALESCE(d.document_date, d.retention_trigger_date, d.created_at) + make_interval(years => p.retention_years)
    ELSE
      COALESCE(d.retention_trigger_date, d.created_at) + make_interval(years => p.retention_years)
  END
FROM retention_policies p
WHERE p.code = d.retention_class
  AND p.is_active = TRUE
  AND p.is_permanent = FALSE
  AND p.retention_years IS NOT NULL
  AND d.deleted_at IS NULL
  AND d.disposal_eligible_date IS NULL
  AND (UPPER(p.trigger_event) NOT LIKE '%ARCHIVE%' OR d.archived_at IS NOT NULL);

-- Seed the warning table for every document that now has an eligibility date
-- and no pending application yet.
INSERT INTO retention_applications (id, document_id, policy_id, triggered_at, eligible_at, notified_90_days, notified_30_days)
SELECT gen_random_uuid(), d.id, p.id, NOW(), d.disposal_eligible_date, FALSE, FALSE
FROM documents d
JOIN retention_policies p ON p.code = d.retention_class
WHERE d.disposal_eligible_date IS NOT NULL
  AND d.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM retention_applications ra
    WHERE ra.document_id = d.id
      AND ra.policy_id = p.id
      AND ra.disposal_authorised_at IS NULL
  );
