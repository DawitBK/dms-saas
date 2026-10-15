// Test-only configuration required by src/config/env.ts.
//
// Do not load developer or production secrets here. Jest starts each test file
// in an isolated module registry, and some storage tests temporarily change
// process.cwd(); relying on a cwd-relative .env file made unrelated suites
// fail depending on execution order.
process.env.NODE_ENV = 'test';
process.env.AUDIT_HMAC_SECRET = 'dms-test-audit-hmac-secret-0123456789';
process.env.JWT_SECRET = 'dms-test-jwt-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'dms-test-refresh-jwt-secret-0123456789';
process.env.MINIO_ACCESS_KEY = 'dms-test-minio';
process.env.MINIO_SECRET_KEY = 'dms-test-minio-secret';
process.env.STORAGE_DRIVER = 'local';
process.env.CLAMAV_ENABLED = 'false';
process.env.ENABLE_QUEUE_WORKERS = 'false';
process.env.ENABLE_OUTBOX_POLLING = 'false';
