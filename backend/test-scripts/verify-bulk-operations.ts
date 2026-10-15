/**
 * Verification: bulk document operations (service + live DB).
 * Covers validation, the operation-level permission gate, partial-failure
 * reporting, de-duplication, and a real reversible success path (trash → restore).
 * Run:  npx tsx test-scripts/verify-bulk-operations.ts
 */
import { sequelize, initModels } from "../src/infrastructure/database/index.js";
import { bulkDocumentOperation } from "../src/modules/documents/bulkService.js";
import { PERMISSIONS } from "../src/config/permissions.js";

const BOGUS_A = "00000000-0000-0000-0000-0000000000aa";
const BOGUS_B = "00000000-0000-0000-0000-0000000000bb";

let ok = true;
const pass = (m: string) => console.log("  ✅", m);
const fail = (m: string) => { ok = false; console.log("  ❌", m); };

async function expectStatus(fn: () => Promise<unknown>, status: number, label: string) {
  try {
    await fn();
    fail(`${label}: expected ${status} but call succeeded`);
  } catch (err: any) {
    err?.statusCode === status ? pass(`${label} → ${status}`) : fail(`${label}: expected ${status}, got ${err?.statusCode} (${err?.message})`);
  }
}

async function main() {
  await sequelize.authenticate();
  initModels();

  const [docs] = await sequelize.query(
    `SELECT id, tenant_id, owner_id FROM documents WHERE status = 'ACTIVE' AND is_on_legal_hold = false LIMIT 1`,
  );
  const doc = (docs as any[])[0];
  const [users] = await sequelize.query(`SELECT id FROM users LIMIT 1`);
  const actorId = doc?.owner_id ?? (users as any[])[0]?.id;

  const admin: any = {
    userId: actorId,
    role: "SYSTEM_ADMIN",
    roles: ["SYSTEM_ADMIN"],
    tenantId: doc?.tenant_id ?? "test-tenant-1",
    permissions: Object.values(PERMISSIONS),
  };
  const employee: any = {
    userId: actorId,
    role: "EMPLOYEE",
    roles: ["EMPLOYEE"],
    tenantId: admin.tenantId,
    permissions: [PERMISSIONS.DOCUMENT_READ],
  };

  // Validation
  await expectStatus(() => bulkDocumentOperation(admin, "archive", []), 400, "empty documentIds");
  await expectStatus(() => bulkDocumentOperation(admin, "frobnicate" as any, [BOGUS_A]), 400, "unknown operation");

  // Permission gate (no DOCUMENT_ARCHIVE)
  await expectStatus(() => bulkDocumentOperation(employee, "archive", [BOGUS_A]), 403, "permission gate");

  // Partial failure over bogus ids — batch never throws, reports per-doc
  const r1 = await bulkDocumentOperation(admin, "archive", [BOGUS_A, BOGUS_B]);
  r1.summary.total === 2 && r1.summary.failed === 2 && r1.summary.succeeded === 0
    ? pass("partial-failure summary correct (0/2)") : fail(`bad summary ${JSON.stringify(r1.summary)}`);
  r1.results.every((x) => !x.success && x.code)
    ? pass("each failed item carries an error code") : fail("missing per-item error codes");

  // De-duplication
  const r2 = await bulkDocumentOperation(admin, "archive", [BOGUS_A, BOGUS_A]);
  r2.summary.total === 1 ? pass("duplicate ids de-duplicated") : fail(`expected total 1, got ${r2.summary.total}`);

  // Real reversible success path: trash a live ACTIVE doc alongside a bogus id, then restore
  if (doc) {
    const r3 = await bulkDocumentOperation(admin, "trash", [doc.id, BOGUS_A]);
    r3.summary.succeeded === 1 && r3.summary.failed === 1
      ? pass("mixed batch: 1 real success + 1 failure") : fail(`bad mixed summary ${JSON.stringify(r3.summary)}`);

    const r4 = await bulkDocumentOperation(admin, "restore", [doc.id]);
    r4.summary.succeeded === 1 ? pass("restore (cleanup) succeeded") : fail(`restore failed ${JSON.stringify(r4.results)}`);

    // restore yields DRAFT — reset to original ACTIVE so the run is side-effect-free
    await sequelize.query(`UPDATE documents SET status='ACTIVE', deleted_at=NULL WHERE id=:id`, { replacements: { id: doc.id } });
  } else {
    console.log("  ⚠ no ACTIVE non-held document found — skipped real trash/restore path");
  }

  await sequelize.close();
  console.log(ok ? "\n✅ BULK OPERATIONS VERIFIED" : "\n❌ BULK OPERATIONS FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
