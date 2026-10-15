/**
 * Verification: compliance reporting (service + live DB).
 * Runs every registered report against a real tenant, asserts the uniform
 * shape, exercises CSV rendering and the unknown-report 404.
 * Run:  npx tsx test-scripts/verify-reports.ts
 */
import { sequelize } from "../src/infrastructure/database/index.js";
import { listReports, runReport, getReportDef, reportToCsv } from "../src/modules/reports/reports.service.js";

let ok = true;
const pass = (m: string) => console.log("  ✅", m);
const fail = (m: string) => { ok = false; console.log("  ❌", m); };

async function main() {
  await sequelize.authenticate();

  const [t] = await sequelize.query(`SELECT tenant_id FROM documents LIMIT 1`);
  const tenantId = (t as any[])[0]?.tenant_id ?? "test-tenant-1";
  console.log("tenant:", tenantId);

  const reports = listReports();
  reports.length >= 8 ? pass(`registry exposes ${reports.length} reports`) : fail(`expected >=8, got ${reports.length}`);

  for (const meta of reports) {
    try {
      const r = await runReport(meta.key, tenantId, {});
      const shapeOk =
        Array.isArray(r.columns) && r.columns.length > 0 &&
        Array.isArray(r.rows) &&
        r.summary && typeof r.summary === "object";
      const csv = reportToCsv(r);
      const csvOk = typeof csv === "string" && csv.split(/\r?\n/)[0] === r.columns.map((c) => c.label).join(",");
      shapeOk && csvOk
        ? pass(`${meta.key} — ${r.rows.length} row(s), CSV ok`)
        : fail(`${meta.key} — bad shape/csv`);
    } catch (e: any) {
      fail(`${meta.key} threw: ${e?.message}`);
    }
  }

  // Date-range report accepts a range without throwing
  try {
    await runReport("audit-activity", tenantId, { from: "2026-01-01", to: "2026-12-31" });
    pass("audit-activity honours a date range");
  } catch (e: any) { fail(`date-range run threw: ${e?.message}`); }

  // Unknown report → 404
  try { getReportDef("does-not-exist"); fail("unknown report did not throw"); }
  catch (e: any) { e?.statusCode === 404 ? pass("unknown report → 404") : fail(`expected 404, got ${e?.statusCode}`); }

  await sequelize.close();
  console.log(ok ? "\n✅ COMPLIANCE REPORTS VERIFIED" : "\n❌ COMPLIANCE REPORTS FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
