// Boot-time production guards (config/env.ts assertProductionRuntimeRequirements).
// These are the last line of defense against shipping dev credentials, mock
// auth, the dev vault, or a superuser DB connection to production — each knob
// is knocked out individually from a known-good production baseline and the
// guard must refuse to boot.

import { config, assertProductionRuntimeRequirements, DEV_VAULT_MASTER_KEY_PLACEHOLDER } from "../src/config/env.js";

type ConfigShape = typeof config;
const originalConfig: ConfigShape = { ...config, DEV_VAULT_MASTER_KEYS: { ...config.DEV_VAULT_MASTER_KEYS } };

function applyProdBaseline() {
  Object.assign(config, {
    NODE_ENV: "production",
    DB_USER: "edams_app",
    DB_PASSWORD: "a-strong-rotated-password",
    DATABASE_URL_EXPLICIT: false,
    DATABASE_URL_TRUSTED: false,
    AUTH_ISSUER: "https://idp.example.com",
    AUTH_AUDIENCE: "dms-api",
    JWT_SECRET: "x".repeat(48),
    JWT_REFRESH_SECRET: "y".repeat(48),
    MEILISEARCH_MASTER_KEY: "a-real-meili-master-key",
    // Explicit so the Meilisearch guard below is exercised deliberately rather
    // than depending on whatever the ambient test config happens to leave here.
    SEARCH_ENGINE: "postgres",
    AUDIT_HMAC_SECRET: "a".repeat(40),
    STORAGE_DRIVER: "minio",
    MINIO_SECRET_KEY: "a-rotated-minio-secret",
    SMTP_HOST: "smtp.examplecorp.com",
    EMAIL_REDIRECT_TO: undefined,
    LOCAL_JWT_MOCK: false,
    // DMS signs and verifies its own session tokens with this pair (shared/auth.ts).
    DEV_RSA_PRIVATE_KEY: "a-production-private-key-base64",
    DEV_RSA_PUBLIC_KEY: "a-production-public-key-base64",
    DEV_JWT_ISSUER: undefined,
    DEV_JWT_AUDIENCE: undefined,
    ENABLE_API_DOCS: false,
    DEV_VAULT_MOCK: false,
    VAULT_BACKEND: "env",
    VAULT_ADDR: undefined,
    VAULT_TOKEN: undefined,
    DEV_VAULT_MASTER_KEY_CURRENT_VERSION: 1,
    DEV_VAULT_MASTER_KEYS: { 1: "a-production-master-key-32-characters!!" },
  });
}

describe("assertProductionRuntimeRequirements", () => {
  beforeEach(applyProdBaseline);

  afterAll(() => {
    Object.assign(config, originalConfig);
  });

  it("passes on a fully-hardened production baseline (env vault backend)", () => {
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
  });

  it("passes with the hashicorp backend when VAULT_ADDR + VAULT_TOKEN are set", () => {
    Object.assign(config, { VAULT_BACKEND: "hashicorp", VAULT_ADDR: "https://vault.internal:8200", VAULT_TOKEN: "s.token" });
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
  });

  it("is a no-op outside production/mirror", () => {
    Object.assign(config, { NODE_ENV: "development", DB_USER: "postgres", DB_PASSWORD: "" });
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
  });

  it("refuses an empty DB password", () => {
    config.DB_PASSWORD = "";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/database password/i);
  });

  it("refuses the postgres superuser as DB user (RLS bypass)", () => {
    config.DB_USER = "postgres";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/superuser/i);
  });

  it("applies the same DB rules to an explicit, trusted DATABASE_URL", () => {
    Object.assign(config, {
      DATABASE_URL_EXPLICIT: true,
      DATABASE_URL_TRUSTED: true,
      DATABASE_URL: "postgresql://postgres:secret@db.internal:5432/edams",
    });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/superuser/i);

    Object.assign(config, { DATABASE_URL: "postgresql://edams_app@db.internal:5432/edams" });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/database password/i);

    Object.assign(config, { DATABASE_URL: "postgresql://edams_app:secret@db.internal:5432/edams" });
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
  });

  // FIX: an ambient DATABASE_URL (e.g. a stray leftover Railway/Render URL
  // from an unrelated project) used to be trusted purely because its
  // credentials happened to pass the checks above — indistinguishable from
  // real prod config by that test alone. DATABASE_URL_TRUSTED is the
  // explicit, separate acknowledgment that closes that gap.
  it("refuses an explicit DATABASE_URL that isn't marked trusted, even with valid-looking credentials", () => {
    Object.assign(config, {
      DATABASE_URL_EXPLICIT: true,
      DATABASE_URL_TRUSTED: false,
      DATABASE_URL: "postgresql://edams_app:secret@db.internal:5432/edams",
    });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DATABASE_URL_TRUSTED/);
  });

  // LOCAL_JWT_MOCK was relaxed from a refusal to a warning on 2026-07-31 and
  // superseded on 2026-10-04: production and mirror now run with it OFF. It stays a
  // warning (not a refusal) so a deploy whose env file has not been updated yet is
  // loud rather than an outage. Asserted so that stays deliberate.
  it("warns but does not refuse LOCAL_JWT_MOCK", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      config.LOCAL_JWT_MOCK = true;
      expect(() => assertProductionRuntimeRequirements()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/LOCAL_JWT_MOCK/));
    } finally {
      warn.mockRestore();
    }
  });

  // DMS's own session tokens are signed and verified with this key pair, so a
  // production without it cannot complete a single login (and, with the mock off,
  // that used to be hidden until the first request).
  it("refuses to boot without the session signing key pair", () => {
    Object.assign(config, { DEV_RSA_PRIVATE_KEY: undefined });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DEV_RSA_PRIVATE_KEY and DEV_RSA_PUBLIC_KEY/);
    Object.assign(config, { DEV_RSA_PRIVATE_KEY: "k", DEV_RSA_PUBLIC_KEY: undefined });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DEV_RSA_PRIVATE_KEY and DEV_RSA_PUBLIC_KEY/);
  });

  it("refuses short JWT secrets", () => {
    config.JWT_SECRET = "short";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/JWT secrets/);
  });

  // 2026-08-07: a real prod-issued token's `iss` claim once read
  // http://localhost:7300 because DEV_JWT_ISSUER leaked into prod and every
  // jwt.sign() call in auth.routes.ts prefers it via `??` over
  // AUTH_ISSUER/AUTH_AUDIENCE. Fixed that time by blanking the env vars;
  // this guard makes a repeat loud at boot instead of silent in issued
  // tokens.
  it("refuses DEV_JWT_ISSUER or DEV_JWT_AUDIENCE set in production/mirror", () => {
    config.DEV_JWT_ISSUER = "http://localhost:7300";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DEV_JWT_ISSUER/);
    applyProdBaseline();
    config.DEV_JWT_AUDIENCE = "dms-api-dev";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DEV_JWT_ISSUER/);
  });

  // The dev safety valve that sends every outbound email to one address. It is
  // set in backend/.env so that testing the mail path against the real Gmail
  // relay cannot mail seeded users and real colleagues — which means it is
  // present in the environment of anyone who copies .env forward to a server,
  // and a production deploy that inherited it would divert every approval
  // request and dispatched letter with no symptom other than mail not arriving.
  it("refuses EMAIL_REDIRECT_TO in production/mirror (silently diverts all outbound mail)", () => {
    config.EMAIL_REDIRECT_TO = "someone@example.com";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/EMAIL_REDIRECT_TO/);
  });

  it("refuses ENABLE_API_DOCS in production/mirror (disables CSP, serves unauthenticated Swagger UI)", () => {
    config.ENABLE_API_DOCS = true;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/ENABLE_API_DOCS/);
  });

  it("refuses DEV_VAULT_MOCK", () => {
    config.DEV_VAULT_MOCK = true;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/DEV_VAULT_MOCK/);
  });

  it("refuses a missing/dev vault backend", () => {
    config.VAULT_BACKEND = undefined;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/VAULT_BACKEND/);
    config.VAULT_BACKEND = "dev" as ConfigShape["VAULT_BACKEND"];
    expect(() => assertProductionRuntimeRequirements()).toThrow(/VAULT_BACKEND/);
  });

  it("refuses the env backend when the current master key is missing, the placeholder, or too short", () => {
    config.DEV_VAULT_MASTER_KEYS = {};
    expect(() => assertProductionRuntimeRequirements()).toThrow(/unset or still the default placeholder/);

    config.DEV_VAULT_MASTER_KEYS = { 1: DEV_VAULT_MASTER_KEY_PLACEHOLDER };
    expect(() => assertProductionRuntimeRequirements()).toThrow(/unset or still the default placeholder/);

    config.DEV_VAULT_MASTER_KEYS = { 1: "too-short" };
    expect(() => assertProductionRuntimeRequirements()).toThrow(/at least 32 characters/);

    // Rotated deployments must validate the CURRENT version, not just v1.
    config.DEV_VAULT_MASTER_KEYS = { 1: "a-production-master-key-32-characters!!" };
    config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION = 2;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/VAULT_MASTER_KEY_V2/);
  });

  it("refuses the hashicorp backend without VAULT_ADDR or VAULT_TOKEN", () => {
    Object.assign(config, { VAULT_BACKEND: "hashicorp", VAULT_ADDR: undefined, VAULT_TOKEN: "s.token" });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/VAULT_ADDR/);
    Object.assign(config, { VAULT_ADDR: "https://vault.internal:8200", VAULT_TOKEN: undefined });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/VAULT_TOKEN/);
  });

  it("refuses lingering dev credentials: audit-HMAC placeholder, minioadmin, mailhog SMTP", () => {
    config.AUDIT_HMAC_SECRET = "change-this-to-a-32-character-minimum-secret-key-here";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/AUDIT_HMAC_SECRET/);
    applyProdBaseline();
    config.MINIO_SECRET_KEY = "minioadmin";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/MINIO_SECRET_KEY/);
    applyProdBaseline();
    // local storage driver doesn't need MinIO creds — the guard is minio-only
    Object.assign(config, { STORAGE_DRIVER: "local", MINIO_SECRET_KEY: "minioadmin" });
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
    applyProdBaseline();
    config.SMTP_HOST = "localhost";
    expect(() => assertProductionRuntimeRequirements()).toThrow(/SMTP_HOST/);
  });

  it("refuses missing AUTH_ISSUER / AUTH_AUDIENCE", () => {
    config.AUTH_ISSUER = undefined as unknown as string;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/AUTH_ISSUER/);
    applyProdBaseline();
    config.AUTH_AUDIENCE = undefined as unknown as string;
    expect(() => assertProductionRuntimeRequirements()).toThrow(/AUTH_AUDIENCE/);
  });

  it("requires MEILISEARCH_MASTER_KEY only when Meilisearch is the selected search engine", () => {
    // Same rule as the MinIO credentials above: a subsystem's key is required
    // when that subsystem is actually in use, and not otherwise. This guard was
    // unconditional until 2026-09-05, which meant this server — which runs
    // SEARCH_ENGINE=postgres with no Meilisearch installed at all — had to carry
    // a 64-character key for a service that does not exist, purely to boot.
    // Tidying that unused key out of .env.production would have taken DMS down
    // at the next restart.
    Object.assign(config, { SEARCH_ENGINE: "meilisearch", MEILISEARCH_MASTER_KEY: undefined });
    expect(() => assertProductionRuntimeRequirements()).toThrow(/MEILISEARCH_MASTER_KEY/);
    applyProdBaseline();
    Object.assign(config, { SEARCH_ENGINE: "postgres", MEILISEARCH_MASTER_KEY: undefined });
    expect(() => assertProductionRuntimeRequirements()).not.toThrow();
  });
});
