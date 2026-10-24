# DMS Deployment — Windows Server, no Docker

**This page covers DMS itself.** When DMS is deployed alongside GMS and SSO behind one
shared Apache reverse proxy, the proxy configuration, the path prefixes and the ordering
between the three systems are site-specific and are not covered here or anywhere in this
repository. This file is the DMS-standalone version: everything DMS itself needs, and
nothing about its neighbours.

The other two supported paths are `DEPLOY-COMPOSE.md` (Docker Compose, which brings
its own Postgres/Redis/MinIO/Meilisearch/ClamAV) and, for recovery,
`DR-RUNBOOK.md`. There is no Linux + pm2 path any more; use Compose on Linux.

No Docker, no pm2, no systemd here. You install the dependencies, build, migrate,
and start the compiled output in a console window — the same shape as `npm run dev`,
against the production build and production configuration.

---

## 1. Prerequisites

- **Node.js 22.x**
- **PostgreSQL 16+**
- **Redis 6.2 or newer.** The backend checks the version at boot and refuses to
  start on anything older. Redis is not optional: BullMQ, the ACL/role caches, the
  rate-limit store and — critically — token revocation all depend on it. In
  production, revocation **fails closed**: with Redis down, every authenticated
  request gets `503 ERR-AUTH-REVOCATION-UNAVAILABLE`.
- **MinIO and Meilisearch are optional.** DMS runs on local-disk storage
  (`STORAGE_DRIVER=local`) and PostgreSQL `ILIKE` search (`SEARCH_ENGINE=postgres`)
  when they are absent. That is how the Example Corp server runs it. Install them only
  if you actually want object storage and full-text search.
- **ClamAV** is recommended. With `CLAMAV_ENABLED=false` every upload is recorded as
  unscanned; the backend says so once at boot.

## 2. Get the code onto the server

```powershell
git clone https://github.com/DawitBK/dms-saas C:\apps\dms
cd C:\apps\dms
```

Or copy the folder across (robocopy, zip, shared drive). Either works; later deploys
repeat whichever you chose.

## 3. Configure

**Production reads `backend\.env.production` and nothing else.** The development
file (`backend\.env.development` when it exists, otherwise `backend\.env`) is never
read when `NODE_ENV=production`. A missing
`.env.production` is a hard refusal to start, naming the file — not a silent
fallback onto defaults. Do not create a layered arrangement where one file
supplements the other; that was the previous behaviour and it silently ran DMS on
the development database.

`.env.production` is gitignored because it holds real secrets, so it is in neither a
clone nor a file copy. **It has to be placed on the server by hand.**
`backend\.env.example` is the authoritative key list, with the reasoning for each
value. For production you must set at minimum:

```dotenv
NODE_ENV=production
PORT=7100
HOST=127.0.0.1              # loopback only; the reverse proxy is the way in
DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
REDIS_URL
JWT_SECRET / JWT_REFRESH_SECRET / AUDIT_HMAC_SECRET   # >= 32 chars each
VAULT_BACKEND=env
VAULT_MASTER_KEY            # >= 32 chars — see the warning below
STORAGE_DRIVER=local
STORAGE_LOCAL_PATH          # absolute path; see below
SEARCH_ENGINE=postgres
CLIENT_URL / CAMS_VERIFY_BASE_URL
TRUST_PROXY=loopback
ENABLE_API_DOCS=false       # refused at boot if true in production
```

Three of these bite if you get them wrong:

- **`VAULT_MASTER_KEY` is the key that every document encryption key is wrapped
  with.** Lose it and both your database backups and your file backups are
  worthless — the wrapped DEKs cannot be unwrapped. Store it somewhere separate
  from the backups themselves.
- **`STORAGE_LOCAL_PATH` must be absolute.** It defaults to `<cwd>/storage/…`, and
  cwd depends on how you launched the process. A wrong cwd silently creates a new,
  empty store instead of failing.
- **`EMAIL_REDIRECT_TO` must not be set.** It redirects every outbound email to one
  address. Production refuses to boot with it — the fix is to delete the line, never
  to weaken the guard.

Verify what production config actually resolves to, before starting anything:

```powershell
cd C:\apps\dms\backend
npm run env:verify:prod
```

It prints the resolved database, issuer and settings (secrets shown only as
lengths), runs every boot guard, and binds no port and opens no connection. If it
names a development database, stop — the wrong file is being read.

### Frontend build-time configuration

Next.js bakes `NEXT_PUBLIC_*` values into the client bundle at **build** time, not
at start time. Put them in `frontend\.env.production`:

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://<your-domain>/dms/api/v1
NEXT_PUBLIC_SOCKET_URL=https://<your-domain>
NEXT_PUBLIC_BASE_PATH=/dms
```

Drop `NEXT_PUBLIC_BASE_PATH` (and the `/dms` prefix in the API URL) if DMS is served
at the root of its own domain rather than under a path.

**`frontend\.env.local` must not exist on this machine.** Next loads `.env.local`
in production builds too, *on top of* `.env.production`, and it wins — which bakes
`http://localhost:7100` into every bundle and points every user's browser at their
own computer. The build refuses outright when it detects this, but the file should
not be there in the first place. Development values live in `.env.development`,
which Next reads only when `NODE_ENV=development`, precisely so this cannot happen.

## 4. Install, database, build

```powershell
cd C:\apps\dms
npm install                 # from the repo ROOT — this is an npm workspaces repo
```

Create the database and the application role once. The app connects as a
non-superuser so that row-level security actually applies to it:

```sql
CREATE DATABASE dmsprod;
CREATE ROLE edams_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<DMS_APP_DB_PASSWORD>';
GRANT CONNECT ON DATABASE dmsprod TO edams_app;
\c dmsprod
GRANT USAGE ON SCHEMA public TO edams_app;
```

Then build, migrate and seed:

```powershell
cd C:\apps\dms
npm run build                          # backend dist/ + frontend .next/standalone

cd backend
npm run db:migrate:prod                # connects as DB_MIGRATE_USER if set, else DB_USER
npm run db:seed:reference:prod         # tenant, roles, org units, departments,
                                       # document types, retention, workflow
```

Use `db:seed:reference:prod`, **not** `db:seed:core:prod`. The latter also creates
17 demo `@edams.local` accounts with well-known credentials and a fake `demo-org`
tenant. It refuses to run in production or mirror unless
`I_UNDERSTAND_THIS_SEEDS_DEMO_DATA=<database name>` is set; do not set it on a real deployment.

Migrations run as `DB_MIGRATE_USER` when `.env.production` sets it (a role allowed to run DDL, for
example the Postgres superuser, because `edams_app` is deliberately not) and otherwise as `DB_USER`
(`scripts/migrate.ts`) — see the least-privilege section of `ARCHITECTURE.md`.

## 5. Start it

Two console windows. The API process also runs the queue workers and the outbox
poller unless you split them out.

```powershell
# Window 1 — API  (loads .env.production)
cd C:\apps\dms\backend
npm run start:prod
```

```powershell
# Window 2 — frontend
cd C:\apps\dms\frontend
npm run start
```

`npm run start:prod` is what sets `NODE_ENV=production` *before* the process starts,
which is what makes the backend read `.env.production` at all. Running
`node dist\src\main.js` directly starts DMS in development mode against the
development database, with every production boot guard skipped.

`npm run start` on the frontend runs `scripts/start-standalone.cjs`, which exists
because a `output: "standalone"` build cannot be served by `next start`, its real
entry point is a *nested* `server.js` whose depth depends on where Next inferred the
workspace root, and `next build` does not copy `.next/static` or `public/` into the
standalone folder. Starting `server.js` by hand gets you an app that boots and then
404s every stylesheet.

If you want a separate worker process, set `ENABLE_QUEUE_WORKERS=false` and
`ENABLE_OUTBOX_POLLING=false` in `.env.production` and add a third window:

```powershell
cd C:\apps\dms\backend
npm run worker:prod
```

Check it is up with the readiness endpoint, which needs no sign-in:
`GET http://127.0.0.1:7100/api/v1/operations/ready` answers `200 {"ok":true}`, or
`503` naming the failing component (`db`, `redis` or `workers`; an unreachable
antivirus scanner is only listed under `degraded`). The detailed
`/api/v1/operations/health` always answers 200 and is for the Operations screen, so
an uptime monitor must use `/ready`.

Closing a console window stops that process. To survive a reboot, wrap the same
commands in Windows Task Scheduler ("run at startup") or NSSM. That is an optional
addition, not a requirement.

## 6. Reverse proxy and TLS

Put IIS, nginx-for-Windows, Caddy or Apache in front of both processes:
`https://<domain>/dms` → `127.0.0.1:7101` and `https://<domain>/dms/api` →
`127.0.0.1:7100`. Three things must be right or something breaks quietly:

- Forward the `Upgrade` and `Connection` headers on the API location, or Socket.IO
  silently degrades to polling.
- Socket.IO is mounted at `/dms/socket.io/`, not `/socket.io/`. On the shared
  Example Corp proxy an unprefixed `/socket.io/` belongs to GMS.
- Raise the request body limit (nginx `client_max_body_size`, IIS
  `maxAllowedContentLength`) for document uploads.

Keep `TRUST_PROXY=loopback` — never `true`. `true` trusts every hop, which lets any
client set `X-Forwarded-For` and so bypass the per-IP rate limits and forge the
`source_ip` recorded in the audit log.

## 7. Updating

```powershell
cd C:\apps\dms
git pull
npm install
npm run build
cd backend
npm run db:migrate:prod
```

Then restart the console windows from §5. `.env.production` is not in the repo, so
`git pull` never touches it — but check `backend\.env.example` for keys added since
your last deploy, because nothing is inherited by accident any more.

## 8. Backups

A scheduled `pg_dump` plus a copy of the document store, shipped off-server.
`backend\scripts\register-backup-task.ps1` registers the Windows scheduled task;
`npm run db:backup:prod` is the backup itself. Point `BACKUP_STORAGE_PATH` at a
different physical disk from the live store — a backup on the same disk protects you
from exactly one failure mode, and not the common one.

**Back up `VAULT_MASTER_KEY` separately from the data.** Both the database dump and
the document blobs are undecryptable without it.

Where a platform-level scheduled backup already covers DMS (one task that dumps every
system, with its own restore tool; neither is part of this repository), this task is
**not** registered: do not run `register-backup-task.ps1` there, because it would add a
second, competing 02:00 backup task.

`DR-RUNBOOK.md` has the restore drill. The restore procedure does not depend on how
the app was deployed.
