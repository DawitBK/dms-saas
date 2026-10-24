# DMS Disaster Recovery Runbook

**What must survive a dead server:** the Postgres database (documents metadata,
letters, audit chain, wrapped DEKs), the MinIO object store (encrypted document
blobs), and the **KEK master keys** (`.env.prod` / Vault). Losing the DB or the
blobs loses records; losing the master keys loses *everything* — wrapped DEKs
are undecryptable without them. Meilisearch and Redis are rebuildable state
(reindex / queues drain) and are not part of DR.

> **Which path applies.** This runbook describes the **Docker Compose** stack. A native
> deployment (no Docker, no MinIO) that is backed up by a platform-level scheduled backup
> restores with that backup's own restore tool, which is not part of this repository; the
> drill and the checks below still apply to it.

## What the prod compose already does

| Concern | Mechanism | Where |
| --- | --- | --- |
| Nightly DB dumps | `db-backup` sidecar, `pg_dump --format=custom` at 02:00 UTC, `BACKUP_RETENTION_DAYS` (default 14) pruning | `deploy/backup/pg-backup-loop.sh` → `db_backups` volume |
| Blob overwrite/delete protection | Object versioning on `dms-documents` + `dms-archive` | `deploy/backup/minio-init.sh` (one-shot, idempotent) |
| Secrets | `.env.prod` on the server (never in git) | `.env.prod.example` documents every key |

## What YOU must add per environment (not automatable from the repo)

1. **Off-server copy of the dumps.** A backup on the same disk as the database
   is not disaster recovery. Nightly cron on the host (not in compose):

   ```bash
   # /etc/cron.d/dms-offsite  (03:30 UTC, after the 02:00 dump)
   30 3 * * * root rclone sync \
     "$(docker volume inspect -f '{{.Mountpoint}}' dms10_db_backups)" \
     remote:dms-backups/db --max-age 48h --log-file /var/log/dms-offsite.log
   ```

   `remote:` = any rclone backend (Backblaze B2, S3, Google Drive, a second
   server over SFTP). Configure once with `rclone config`.

2. **Off-server copy of the blobs.** Either point rclone at the MinIO volume
   the same way, or (better, uses versioning-aware copy) run `mc mirror
   --watch` from a second machine against the MinIO API, or schedule:

   ```bash
   0 4 * * * root docker run --rm --network dms10_default \
     -e MC_HOST_dms="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000" \
     minio/mc mirror --overwrite dms/dms-documents /mnt/offsite/dms-documents
   ```

3. **Escrow the KEK master keys.** Print/store `VAULT_MASTER_KEY` (and every
   `VAULT_MASTER_KEY_V{n}`), `AUDIT_HMAC_SECRET`, and the RSA keypair in a
   password manager / sealed envelope **separate from the server**. For
   `VAULT_BACKEND=hashicorp`: escrow the Vault unseal keys + a periodic Vault
   storage snapshot instead.

## Restore procedure (rehearse this — see the drill below)

On a fresh server with Docker + the repo cloned + `.env.prod` restored from
escrow:

```bash
# 1. Bring up ONLY the datastores (no migrate/api yet — the DB must be
#    restored before migrations stamp a fresh SequelizeMeta):
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres minio

# 2. Restore the newest dump (pg_restore drops/recreates objects):
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U postgres -d dms --clean --if-exists --no-owner < dms-<STAMP>.dump
  # This is the Docker stack's restore. On the NATIVE server (the live one) restore WITHOUT --no-owner and then check
  # pg_tables.tableowner is edams_app.

# 3. Restore blobs into the minio volume (rclone/mc from the offsite copy),
#    then re-run the versioning one-shot:
docker compose --env-file .env.prod -f docker-compose.prod.yml up minio-init

# 4. Full stack. migrate is a no-op when the restored SequelizeMeta is
#    current; otherwise it applies only the missing migrations forward:
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# 5. Rebuild derived state:
#    - Meilisearch reindex: happens lazily via the SEARCH_INDEX outbox; for a
#      full rebuild use the operations reindex endpoint or reseed the index.
#    - Redis: nothing to restore (queues repopulate; BullMQ repeatables
#      re-register at worker boot).
```

**Verification after any restore** (do not skip):

```bash
curl -fsS https://<API_DOMAIN>/api/v1/operations/ready    # no token: 200 {"ok":true} = db, redis and workers up
curl -fsS https://<API_DOMAIN>/api/v1/operations/health   # no token, always 200; JSON: db/redis/minio/meili/workers all ok
cd backend && npx tsx test-scripts/verify-audit-atomicity.ts  # audit hash chain still valid
# Download one known document + one letter PDF end-to-end (proves DEK unwrap
# with the escrowed master keys against restored blobs).
```

## The drill (acceptance test for this runbook)

Once before go-live and after any major storage change: on a scratch machine
(or a scratch compose project name), restore last night's dump + a blob copy
per the procedure above and run the verification block. Record date + outcome
here:

A restore-drill script (platform tooling, not part of this repository) automates the
database half of this: it creates a disposable scratch database (refuses any name containing
"prod" as a safety backstop), restores a given dump into it, spot-checks row
counts on a few key tables, then drops the scratch database. It does not
cover the MinIO blob restore or DEK-unwrap verification steps above — run
those manually against a scratch compose stack periodically (at minimum
quarterly) in addition to running the script.

| Date | Operator | Dump restored | Outcome |
| --- | --- | --- | --- |
| _pending first drill_ | | | |

## Failure modes this covers / does not cover

- **Covers:** dead disk/server, ransomware on the host (offsite copies +
  MinIO versioning), fat-fingered delete (versioning + dumps), bad deploy
  (dumps predate it; migrations are expand/contract per `Documentations/rollout.md`).
- **Does NOT cover:** a compromised `.env.prod` (rotate every secret + rewrap
  DEKs via `scripts/rewrap-deks.ts` after bumping the master-key version),
  or silent data corruption older than the retention window — raise
  `BACKUP_RETENTION_DAYS` if 14 days of history is not enough for the
  archival-compliance requirement.
