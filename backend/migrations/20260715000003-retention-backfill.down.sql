-- Best-effort reversal: remove backfilled (never-notified, never-authorized)
-- application rows. disposal_eligible_date values are left in place — they are
-- recomputed idempotently by the retention engine and clearing them would also
-- clear legitimately computed dates.
DELETE FROM retention_applications
WHERE disposal_authorised_at IS NULL
  AND notified_90_days = FALSE
  AND notified_30_days = FALSE;
