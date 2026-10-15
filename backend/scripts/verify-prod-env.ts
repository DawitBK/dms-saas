/**
 * Pre-deploy check: resolve DMS's PRODUCTION configuration exactly the way the
 * real service does, print a secret-safe summary, and run every production
 * boot guard — WITHOUT starting the server, binding port 7100, or touching the
 * database.
 *
 *   npm run env:verify:prod
 *
 * Why this exists as a separate command:
 *
 *   1. Until now the only way to find out whether production configuration was
 *      being read correctly was to start DMS and read its logs. That is a poor
 *      trade on a live box — you learn about a misconfiguration by inflicting
 *      it. On 2026-09-05 a production launch was measured resolving the DEV
 *      database with a personal Gmail address intercepting every outbound
 *      notification, and it logged nothing at all, because with NODE_ENV
 *      clobbered back to "development" every guard returned early. This script
 *      makes that state visible in one command.
 *
 *   2. GMS already had an equivalent (`npm run env:check:prod`) and DMS did
 *      not. GMS's is a static file check that never loads the app; this one
 *      goes through the real loader, so it also proves WHICH FILE won.
 *
 * It never prints a secret. Sensitive values are reported as set/unset with a
 * length, so the output is safe to paste into a deployment log or a chat.
 *
 * Exit status: 0 = safe to start. 1 = do not start; the reason is printed.
 */
import { config, assertProductionRuntimeRequirements, resolveVaultBackend } from "../src/config/env.js";

const shown = (value: unknown) =>
  value === undefined || value === null || value === "" ? "(unset)" : String(value);

/** For secrets: prove presence and length without disclosing the value. */
const secret = (value: unknown) =>
  value === undefined || value === null || value === "" ? "(unset)" : `set, ${String(value).length} chars`;

const line = (label: string, value: string) => console.log(`  ${label.padEnd(26)} ${value}`);

console.log("");
console.log("DMS production environment verification");
console.log("=======================================");
console.log("");

if (config.NODE_ENV !== "production") {
  console.error(
    `REFUSING TO REPORT: NODE_ENV resolved to "${config.NODE_ENV}", not "production".\n` +
      "Run this through the production launcher so the right env file is loaded:\n" +
      "    npm run env:verify:prod\n" +
      "Running the underlying script directly (tsx scripts/verify-prod-env.ts) loads the\n" +
      "DEVELOPMENT .env and would tell you nothing about the production configuration.",
  );
  process.exit(1);
}

console.log("Identity and routing");
line("NODE_ENV", config.NODE_ENV);
line("HOST : PORT", `${config.HOST} : ${config.PORT}`);
line("PUBLIC_BASE_PATH", shown(config.PUBLIC_BASE_PATH));
line("API_BASE_PATH", shown(config.API_BASE_PATH));
line("TRUST_PROXY", shown(config.TRUST_PROXY));
line("CLIENT_URL", shown(config.CLIENT_URL));
console.log("");

console.log("Database (the value that mattered most in the 2026-09-05 incident)");
line("DB_NAME", shown(config.DB_NAME));
line("DB_USER", shown(config.DB_USER));
line("DB_HOST : DB_PORT", `${config.DB_HOST} : ${config.DB_PORT}`);
line("DB_PASSWORD", secret(config.DB_PASSWORD));
line("DATABASE_URL supplied?", config.DATABASE_URL_EXPLICIT ? "YES (explicit)" : "no (built from DB_* parts)");
console.log("");

console.log("Storage and search");
line("STORAGE_DRIVER", shown(config.STORAGE_DRIVER));
line("STORAGE_LOCAL_PATH", shown(config.STORAGE_LOCAL_PATH));
line("SEARCH_ENGINE", shown(config.SEARCH_ENGINE));
line("MINIO_ACCESS_KEY", config.STORAGE_DRIVER === "minio" ? secret(config.MINIO_ACCESS_KEY) : "(not required: driver is not minio)");
console.log("");

console.log("Document encryption — without the right KEK, stored documents cannot be read");
line("VAULT_BACKEND", shown(resolveVaultBackend()));
line("DEV_VAULT_MOCK", String(config.DEV_VAULT_MOCK));
line("KEK version in use", String(config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION));
line("KEK present?", secret(config.DEV_VAULT_MASTER_KEYS[config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION]));
console.log("");

console.log("Mail — EMAIL_REDIRECT_TO must be unset or every notification is diverted");
line("SMTP_HOST : SMTP_PORT", `${config.SMTP_HOST} : ${config.SMTP_PORT}`);
line("EMAIL_FROM", shown(config.EMAIL_FROM));
line("EMAIL_REDIRECT_TO", config.EMAIL_REDIRECT_TO ? `SET -> ${config.EMAIL_REDIRECT_TO}` : "(unset, correct)");
console.log("");

console.log("Authentication");
line("AUTH_ISSUER", shown(config.AUTH_ISSUER));
line("AUTH_AUDIENCE", shown(config.AUTH_AUDIENCE));
line("AUTH_JWKS_URI", shown(config.AUTH_JWKS_URI));
line("OIDC_CLIENT_ID", shown(config.OIDC_CLIENT_ID));
line("LOCAL_JWT_MOCK", config.LOCAL_JWT_MOCK ? "true  <- passwordless login is reachable" : "false");
console.log("");

console.log("Process roles and exposure");
line("ENABLE_QUEUE_WORKERS", String(config.ENABLE_QUEUE_WORKERS));
line("ENABLE_OUTBOX_POLLING", String(config.ENABLE_OUTBOX_POLLING));
line("ENABLE_API_DOCS", String(config.ENABLE_API_DOCS));
line("ENABLE_PUBLIC_METRICS", String(config.ENABLE_PUBLIC_METRICS_ROUTE));
line("CLAMAV_ENABLED", String(config.CLAMAV_ENABLED));
console.log("");

try {
  assertProductionRuntimeRequirements();
} catch (error) {
  console.error("PRODUCTION GUARD FAILED — do not start DMS:");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log("All production guards passed.");
console.log("");
console.log("Note: this checks CONFIGURATION only. It does not prove Postgres, Redis or");
console.log("clamd are reachable — those are verified by the health checks in");
console.log("DEPLOYMENT-GUIDE.md after the service starts.");
