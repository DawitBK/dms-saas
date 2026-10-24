<#
.SYNOPSIS
  Registers a Scheduled Task that runs DMS's `npm run storage:backup:prod`
  (scripts/storage-backup.ts) nightly, mirroring the encrypted document store
  with robocopy /MIR and verifying by file count rather than exit code.

  THIS IS THE HALF OF THE BACKUP THAT CANNOT BE REBUILT FROM ANYTHING ELSE.
  register-backup-task.ps1 protects `dmsprod` -- the catalogue, the ACLs, the
  audit chain and the wrapped per-document keys. It does NOT protect the
  document bytes, which live on disk at STORAGE_LOCAL_PATH. Restoring only the
  database gives you a complete catalogue in which every document is a 404.

  Runs at 03:00, AFTER the 02:00 database dump, on purpose: the storage
  snapshot must be at least as new as the dump, or the restored catalogue
  references files the mirror does not have. Never schedule this before it.

  RUN THIS ON THE LIVE SERVER.

.NOTES
  Added 2026-09-09. The repo shipped register-backup-task.ps1 for all three
  databases but nothing equivalent for the document store, so the file half was
  the one piece of the backup story with no scheduling path at all.

  Two things this does NOT solve:

    1. BACKUP_STORAGE_PATH is on the same physical disk as the source. This
       server's B: and C: are two partitions of one 450 GB virtual disk, so
       the mirror survives a deleted folder, not a failed disk.
    2. VAULT_MASTER_KEY is in neither backup. The mirrored tree is ciphertext
       and document_deks holds each key wrapped by the KEK. Without that key
       both backups restore cleanly and decrypt nothing.
#>

param(
  [string]$BackendPath = "B:\COMPANY_SYSTEMS\DMS\backend",
  [string]$TaskName = "ExampleCorp-DMS-Storage-Backup",
  # After the 02:00 dmsprod dump. See the ordering note above.
  [string]$At = "03:00"
)

if (-not (Test-Path (Join-Path $BackendPath "package.json"))) {
  Write-Error "DMS backend not found at $BackendPath - pass -BackendPath to point at the real location on this box."
  exit 1
}

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npmCmd) {
  Write-Error "npm.cmd not found on PATH for this session - specify the full path if npm isn't globally on PATH for the account this task will run as."
  exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "A task named '$TaskName' already exists (State: $($existing.State))."
  Write-Host "Unregister it first if you want to re-register: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  exit 0
}

$action  = New-ScheduledTaskAction -Execute $npmCmd.Source -Argument "run storage:backup:prod" -WorkingDirectory $BackendPath
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Nightly robocopy /MIR of the DMS document store to BACKUP_STORAGE_PATH, verified by file count. Runs after the dmsprod dump so the file snapshot is never older than the catalogue." `
  -RunLevel Highest

Write-Host "Registered '$TaskName' (daily at $At). Verify with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Test immediately: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then check BACKUP_STORAGE_PATH for a mirrored tree."
