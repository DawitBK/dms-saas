# Native Windows / Apache deployment automation

A native Windows deployment runs Node processes behind Apache. A platform-wide start
script (the kind a shared server runs at boot) is a boot/start tool for every system on
that server; it is not a DMS release tool and must not be used to redeploy only DMS
because it would also touch unrelated systems.

## Release runner (platform tooling, not part of this repository)

The platform's deployment tooling has a controlled release runner for DMS: a PowerShell
script with a double-click/Task-Scheduler batch wrapper. Neither file is in this
repository; this section records what the runner does, so that it can be rebuilt or
checked against.

The batch file is safe by default: without `-Apply`, it only validates the
staged checkout and prints a plan. With `-Apply`, it does the following in
order:

1. Requires a clean, expected Git revision and the two production env files.
2. Requires a recent production database dump (unless an explicitly recorded
   `-SkipBackupCheck` override is supplied). The gate looks for a
   `*_production_*.dump` file no older than `-MaxBackupAgeHours` (26) **directly
   inside** `-BackupPath` (default `<repo>\backups`, no sub-folders). A platform-level
   scheduled backup writes its dump to
   `<backup folder>\daily\<yyyy-MM-dd>\dms\`, so pass
   `-BackupPath <backup folder>\daily\<newest date>\dms` (or run
   `npm run db:backup:prod` first); otherwise the gate reports no dump.
3. Runs `npm ci`, production-env verification, type-checking, the coverage
   gate, production build, migration-safety check, and production migrations.
4. Only after all of those pass, restarts DMS API (`7100`), DMS worker, and
   DMS frontend (`7101`) — never SSO, GMS, Redis, PostgreSQL, or other apps.
5. Waits for the DMS API (`/api/v1/operations/health`, which always answers 200 once
   the process is up; `/api/v1/operations/ready` is the stricter check that fails on a
   dead database, Redis or worker) and frontend health URLs. Apache is validated and
   restarted only when the explicit `-RestartApache` option is supplied.

The runner does **not** pull, reset, or check out Git code. Selecting the
release commit and transferring it to the server are separate approval steps;
this prevents an automation tool from silently changing the version it is
about to build and migrate.

Example, on the server after staging a reviewed release into the canonical
checkout:

```powershell
cd <platform deploy folder>
.\dms-release.bat -ExpectedCommit <full-commit-sha>
.\dms-release.bat -Apply -ExpectedCommit <full-commit-sha>
```

If Apache configuration is part of the same approved release, add
`-RestartApache -ApacheHttpd C:\xampp1\apache\bin\httpd.exe`. The runner runs
`httpd -t` before the graceful restart.

## Automation choices

| Option | When to choose it | Remaining server work |
| --- | --- | --- |
| Operator-run release batch | Best immediate option for the internal server. Review and stage a commit, then run the implemented batch through RDP. | Copy the two release-runner files to the canonical server root and perform the first supervised release. |
| Scheduled Task | Suitable for a controlled maintenance window or an isolated network. Configure a task to invoke the batch with a fixed approved commit. | Create the task under a dedicated least-privilege deployment account; do not schedule an unreviewed `git pull`. |
| GitHub Actions self-hosted Windows runner | Recommended once releases are protected by review. Use a manual `workflow_dispatch` release with an environment approval and a dedicated runner account. | Server administrator must install/register the runner, protect the production environment, provide a stable checkout, and allow its service account to restart only DMS processes. |
| NSSM services + runner | Best long-term availability. NSSM keeps API, worker, and frontend alive after a crash; the release runner restarts those services after a verified build/migration. | Server administrator must install NSSM, create three named services, grant log-directory permissions, and test recovery/rollback. |

Do not use a generic startup task as a crash supervisor. The existing startup
task launches the platform start script after a reboot; it intentionally starts
the entire platform, while DMS deployment must be isolated to its three
processes.

## Server-access requirements

These cannot be completed from this checkout:

- Copy the release artifacts to the server and set the canonical server-root
  path.
- Create/verify the backup role and a successful DMS dump (`db:backup:prod`, or the
  platform's scheduled backup once installed on the server). The
  release runner will correctly refuse a state-changing deployment otherwise.
- Grant the deployment account only the rights needed to run Node/npm, write
  DMS logs, connect for migrations, and restart DMS/Apache — not broad local
  administrator access where avoidable.
- Perform the first deployment while observing `C:\ProgramData\Example Corp\DMS\logs`
  and verify both public Apache paths after the runner reports healthy.

