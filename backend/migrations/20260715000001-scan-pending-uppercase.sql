-- Gap register #2/#8: large async-scanned uploads were created with the rogue
-- lowercase status 'scan_pending' (not in the state enum), which ScanWorker
-- never promoted — clean large files were stuck forever. The code now uses
-- the proper SCAN_PENDING state; normalize any stuck rows so the worker's
-- guarded promotion (SCAN_PENDING -> DRAFT) and the state machine recognize
-- them.
UPDATE documents SET status = 'SCAN_PENDING' WHERE status = 'scan_pending';
