<#
.SYNOPSIS
  Registers a Scheduled Task that runs DMS's new `npm run db:backup:prod`
  (scripts/db-backup.ts) nightly. DMS's docker-compose.prod.yml has its own
  backup sidecar, but the live production server runs DMS as a bare `node`
  process with no Docker at all  -  so
  that sidecar isn't protecting the real dmsprod. This is the Windows-native
  equivalent. RUN THIS ON THE LIVE SERVER.
#>

param(
  # Default corrected 2026-09-09 (was B:\Company_Systems, two roots out
  # of date -- running this unedited registered a task against a stale
  # checkout, whose .env.production may not even exist).
  [string]$BackendPath = "B:\COMPANY_SYSTEMS\DMS\backend",
  [string]$TaskName = "ExampleCorp-DMS-DB-Backup",
  # Staggered against GMS (02:20) and SSO (02:40) so three pg_dump processes do
  # not hit the same Postgres instance and the same physical disk at once.
  [string]$At = "02:00"
)

if (-not (Test-Path (Join-Path $BackendPath "package.json"))) {
  Write-Error "DMS backend not found at $BackendPath  -  pass -BackendPath to point at the real location on this box."
  exit 1
}

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npmCmd) {
  Write-Error "npm.cmd not found on PATH for this session  -  specify the full path if npm isn't globally on PATH for the account this task will run as."
  exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "A task named '$TaskName' already exists (State: $($existing.State))."
  Write-Host "Unregister it first if you want to re-register: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  exit 0
}

$action  = New-ScheduledTaskAction -Execute $npmCmd.Source -Argument "run db:backup:prod" -WorkingDirectory $BackendPath
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Nightly dmsprod backup via scripts/db-backup.ts. See Documentations/DEPLOY-WINDOWS-MANUAL.md." `
  -RunLevel Highest

Write-Host "Registered '$TaskName' (daily at $At). Verify with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Test immediately: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then check DMS\backups\ for a new .dump file."
