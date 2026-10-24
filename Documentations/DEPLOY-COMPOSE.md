# DMS Deployment — VPS + Docker Compose

One of three paths. Use this when you want DMS to bring its own infrastructure
(Postgres, Redis, MinIO, Meilisearch, ClamAV, Prometheus/Grafana) on a Linux host.
For DMS alongside GMS and SSO behind one shared Apache proxy, DMS's own part is in
`DEPLOY-WINDOWS-MANUAL.md`; the proxy configuration is site-specific and is not part of this
repository. For a standalone Windows install without Docker, see `DEPLOY-WINDOWS-MANUAL.md`.

The production stack is `docker-compose.prod.yml` at the repo root: Caddy
(TLS, the only published ports) → frontend (Next standalone) + backend API,
plus worker, Postgres 16, Redis 7, MinIO (versioned buckets), Meilisearch,
ClamAV, Prometheus/Grafana, a `migrate` one-shot, and a nightly `db-backup`
sidecar. Secrets live only in a server-side `.env.prod`.

## 1. Server prep (Ubuntu 24.04, 8 GB+ RAM, 100 GB+ disk)

```bash
apt update && apt install -y docker.io docker-compose-v2 git ufw fail2ban
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
# DNS: point APP_DOMAIN and API_DOMAIN A-records at this server first —
# Caddy needs them resolving to issue Let's Encrypt certificates.
```

## 2. Clone + configure

```bash
git clone https://github.com/DawitBK/dms-saas dms && cd dms
cp .env.prod.example .env.prod && chmod 600 .env.prod
```

Fill **every** value in `.env.prod`:

- Secrets: `openssl rand -base64 48` for `POSTGRES_PASSWORD`,
  `DMS_APP_DB_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `AUDIT_HMAC_SECRET`, `VAULT_MASTER_KEY`, `MINIO_ROOT_PASSWORD`,
  `MEILI_MASTER_KEY`, `GRAFANA_ADMIN_PASSWORD`.
- RSA keys: `node backend/scripts/generate-rsa-keys.js` →
  `RSA_PRIVATE_KEY_B64` / `RSA_PUBLIC_KEY_B64`.
- E-sign cert: `node backend/scripts/generate-esign-cert.js` →
  `ESIGN_P12_B64` / `ESIGN_P12_PASSPHRASE`.
- Real SMTP relay (the boot guard refuses localhost).

**Escrow the filled `.env.prod` off-server immediately** (password manager /
sealed envelope) — losing `VAULT_MASTER_KEY` loses every encrypted document.
See `DR-RUNBOOK.md`.

## 3. First launch

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f migrate backend
```

Order of events: postgres init creates the `edams_app` role
(`deploy/postgres-init`) → `migrate` one-shot applies all migrations as the
superuser → API + worker boot as `edams_app` (RLS enforced; the boot guards
refuse dev credentials) → Caddy issues TLS.

Bootstrap the first tenant/admin (one-time, from the backend container):

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec backend \
  node dist/scripts/seed-core.js   # review scripts/seed-core.ts first — seed only on an EMPTY prod DB
```

## 4. Verify (gate — do not go live without all green)

```bash
curl -fsS https://$API_DOMAIN/health                         # liveness
# no token needed. /ready answers 503 when db, redis or the workers have failed (use this for monitors):
curl -fsS https://$API_DOMAIN/api/v1/operations/ready
# /health always answers 200 with the detail: db/redis/minio/meili/outbox/workers/antivirus
curl -fsS https://$API_DOMAIN/api/v1/operations/health
```

Then from a workstation against the prod URL: upload → download round-trip
(MinIO + DEK unwrap), a search hit (Meilisearch, not ILIKE — check logs), a
letter through approval (reference allocated, PDF renders — Amharic body
included), the public QR verify page from a phone, and an email to a real
inbox. The full verifier suite can run against staging:
`API_URL=https://staging-api/api/v1 npx tsx test-scripts/verify-cams.ts`.

Negative checks (each must refuse to boot): set `LOCAL_JWT_MOCK=true`,
`DEV_VAULT_MOCK=true`, `DB_USER=postgres`, or empty `DB_PASSWORD` in an
override and confirm the container exits with the guard error, then revert.

## 5. Updating a deployment

```bash
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
# migrate re-runs first (no-op when nothing new); api/worker restart after it.
```

Rollback: `git checkout <previous-sha>` + same command. Migrations are
expand/contract (Documentations/rollout.md) so the previous app version keeps working
against the newer schema; a DB restore is the last resort (DR-RUNBOOK.md).

## 6. Operations

- **Backups**: nightly dumps land in the `db_backups` volume; add the
  off-server rclone cron + MinIO mirror from `DR-RUNBOOK.md`, then rehearse
  one restore before go-live (the runbook has the drill table).
- **Monitoring**: Prometheus scrapes the internal `/metrics`; Grafana at
  `https://$APP_DOMAIN/grafana` (admin password from `.env.prod`).
- **KEK rotation**: set `VAULT_MASTER_KEY_V2` + bump
  `DEV_VAULT_MASTER_KEY_CURRENT_VERSION=2`, restart, then
  `node dist/scripts/rewrap-deks.js --execute` in the backend container.
  Moving to HashiCorp Vault later: set `VAULT_BACKEND=hashicorp` +
  `VAULT_ADDR`/`VAULT_TOKEN` and run the same rewrap (env→Transit migration
  is built in).
- **Logs**: `docker compose ... logs -f backend worker` (Pino JSON).
