#!/bin/sh
# One-shot MinIO hardening (minio-init service): create the document buckets
# if missing and turn on object versioning, so overwritten/deleted encrypted
# blobs stay recoverable. Idempotent — safe on every `compose up`.
set -eu

mc alias set edams http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"

for BUCKET in edams-documents edams-archive; do
  mc mb --ignore-existing "edams/${BUCKET}"
  mc version enable "edams/${BUCKET}"
  echo "[minio-init] ${BUCKET}: versioning enabled"
done
