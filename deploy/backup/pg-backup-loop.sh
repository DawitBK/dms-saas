#!/bin/sh
# Nightly pg_dump loop for the db-backup sidecar (docker-compose.prod.yml).
# Custom-format dumps (pg_restore-able, compressed) into /backups, pruned
# after $BACKUP_RETENTION_DAYS days. Mirror /backups OFF-SERVER — a backup on
# the same disk as the database is not disaster recovery (see
# Documentations/DR-RUNBOOK.md for the rclone recipe and the restore drill).
set -eu

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

echo "[db-backup] starting — nightly pg_dump of ${PGDATABASE}, retention ${RETENTION_DAYS}d"

while true; do
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  OUT="/backups/edams-${STAMP}.dump"
  if pg_dump --format=custom --compress=6 --file="${OUT}.part" && mv "${OUT}.part" "${OUT}"; then
    echo "[db-backup] wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
  else
    rm -f "${OUT}.part"
    echo "[db-backup] pg_dump FAILED at ${STAMP}" >&2
  fi

  find /backups -name 'edams-*.dump' -mtime "+${RETENTION_DAYS}" -delete

  # Sleep until the next 02:00 UTC.
  NOW=$(date -u +%s)
  NEXT=$(( (NOW / 86400 + 1) * 86400 + 2 * 3600 ))
  sleep $(( NEXT - NOW ))
done
