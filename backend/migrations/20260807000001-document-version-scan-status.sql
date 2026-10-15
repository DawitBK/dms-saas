-- Antivirus scan visibility: a scan that errored (ClamAV timeout/crash/
-- protocol error) is fail-open (the upload is allowed through), but must be
-- distinguishable from a scan that actually ran and found nothing. Defaults
-- to 'clean' so every already-existing row (all of which predate this
-- column, scanned or not under the prior silent-fail-open behavior) doesn't
-- retroactively read as flagged.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS av_scan_status VARCHAR(20) NOT NULL DEFAULT 'clean'
    CHECK (av_scan_status IN ('clean', 'unscanned'));

CREATE INDEX IF NOT EXISTS document_versions_unscanned_idx
  ON document_versions (document_id)
  WHERE av_scan_status = 'unscanned';
