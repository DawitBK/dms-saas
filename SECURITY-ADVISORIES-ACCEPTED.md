# Dependency advisories that remain, and why

Checked with `npm audit --omit=dev` on 2026-10-10 after `npm audit fix` (all three frontends are now on Next 16.4.0, which cleared the critical advisory).
Re-run `npm audit --omit=dev` in `DMS/`, `SSO/backend`, `GMS/backend` and `GMS/frontend` after any dependency change and update this list.

| Package (where) | Severity | Why it is still here | Why it is acceptable now |
|---|---|---|---|
| `node-forge` via `@signpdf/signer-p12` (DMS backend) | high | Advisory: RSA PKCS#1 v1.5 **signature verification** accepts extra nested digest elements. No fixed release exists. | DMS uses forge to **sign** with its own certificate and to generate keys, never to verify an RSA signature from outside (`modules/signing/signing.service.ts`, `app.ts`; no `verify` call). Re-check if verification of external signatures is ever added. |
| `uuid` <11.1.1 via `exceljs` and `sequelize` (DMS backend) | moderate | Missing buffer bounds check in v3/v5/v6 **when a buffer is passed**. The only automatic fix is a major downgrade. | Neither library passes a buffer to uuid v3/v5/v6; DMS uses v4 ids. |
| `query-string` via `minio` (DMS backend) | moderate | Decode-URI-component denial of service. Fix is a breaking minio major. | Parses URLs DMS itself builds for its own storage endpoint; the live server uses local-disk storage. |
| `@rushstack/ts-command-line` via `umzug` (DMS backend) | moderate | `argparse` advisory; the fix is a breaking umzug major. | Used only by the migration command line run by an administrator. |
| `braces` / `micromatch` / `http-proxy-middleware` (SSO backend, the GMS gateway) | high | Stack exhaustion on deeply nested glob patterns. No fixed release. | The patterns are fixed strings in our own configuration; no user input reaches them. |
| `braces` / `chokidar` / `tailwindcss` / `fast-glob` (GMS frontend) | high | Same `braces` advisory, reached through the build tooling. | Build-time only; nothing from a visitor is matched. |

Fixed on 2026-10-10: `next` (critical) in all three frontends, `axios`, `compression`, `moment`, `sharp`, `undici`, `nodemailer` (GMS moved from 9 to 10).
