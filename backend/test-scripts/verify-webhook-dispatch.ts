/**
 * Verification: end-to-end webhook event dispatch.
 *
 * Exercises the real running server's outbox poller:
 *   1. Stands up a local HTTP receiver.
 *   2. Seeds a tenant-scoped webhook subscription pointing at it.
 *   3. Inserts a domain outbox event (DOCUMENT.STATUS_CHANGED).
 *   4. Asserts the server fans out a WEBHOOK row and delivers it with the
 *      correct HMAC signature + dedupe headers, scoped to the tenant.
 *
 * Seeds via raw SQL; the running backend (with outbox polling) performs the
 * actual ORM-driven fan-out and HTTP delivery. Requires the dev server up.
 * Run:  npx tsx test-scripts/verify-webhook-dispatch.ts
 */
import http from "node:http";
import crypto from "node:crypto";
import { sequelize } from "../src/infrastructure/database/index.js";

const PORT = 9911;
const SECRET = "whsec_verify_" + crypto.randomBytes(6).toString("hex");
const MARKER = "wh-verify-" + crypto.randomBytes(6).toString("hex");

interface Captured {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

async function main() {
  await sequelize.authenticate();

  // Reuse a real tenant if one exists (tenant ids are slug strings, not UUIDs).
  let tenantId = "wh-verify-tenant";
  try {
    const [rows] = await sequelize.query(`SELECT id FROM tenants LIMIT 1`);
    if ((rows as any[])[0]?.id) tenantId = (rows as any[])[0].id;
  } catch { /* tenants table optional */ }
  console.log("Using tenantId:", tenantId);

  let captured: Captured | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = { headers: req.headers, rawBody: body };
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`Receiver listening on http://127.0.0.1:${PORT}`);

  const url = `http://127.0.0.1:${PORT}/hook`;
  await sequelize.query(
    `INSERT INTO webhook_subscriptions (tenant_id, url, secret, is_active) VALUES (:t, :u, :s, true)`,
    { replacements: { t: tenantId, u: url, s: SECRET } }
  );
  await sequelize.query(
    `INSERT INTO outbox_events (type, channel, payload) VALUES ('DOCUMENT.STATUS_CHANGED', 'WEBSOCKET', :p)`,
    { replacements: { p: JSON.stringify({ marker: MARKER, tenantId, status: "APPROVED", documentId: null }) } }
  );
  console.log("Seeded subscription + outbox event; waiting for delivery (poller ~5s)...");

  const deadline = Date.now() + 30_000;
  while (!captured && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  let ok = true;
  const fail = (m: string) => { ok = false; console.log("  ❌", m); };
  const pass = (m: string) => console.log("  ✅", m);

  if (!captured) {
    fail("No webhook received within 30s");
  } else {
    const c: Captured = captured;
    c.headers["x-edms-event-type"] === "DOCUMENT.STATUS_CHANGED"
      ? pass("Event-Type header correct")
      : fail(`Event-Type header wrong: ${c.headers["x-edms-event-type"]}`);

    c.headers["x-edms-event-id"]
      ? pass("Event-Id header present (consumer dedupe)")
      : fail("Event-Id header missing");

    const expectedSig = crypto.createHmac("sha256", SECRET).update(c.rawBody).digest("hex");
    c.headers["x-edms-signature"] === expectedSig
      ? pass("HMAC-SHA256 signature valid")
      : fail("HMAC signature mismatch");

    try {
      const body = JSON.parse(c.rawBody);
      body.tenantId === tenantId ? pass("Payload tenant-scoped correctly") : fail("Payload tenantId mismatch");
      body.marker === MARKER ? pass("Payload round-tripped intact") : fail("Payload marker missing");
    } catch {
      fail("Body is not valid JSON");
    }
  }

  // Cleanup: subscription + both outbox rows (seed + fanned-out WEBHOOK child).
  await sequelize.query(`DELETE FROM webhook_subscriptions WHERE secret = :s`, { replacements: { s: SECRET } });
  await sequelize.query(`DELETE FROM outbox_events WHERE payload LIKE :m`, { replacements: { m: `%${MARKER}%` } });
  server.close();
  await sequelize.close();

  console.log(ok ? "\n✅ WEBHOOK DISPATCH VERIFIED" : "\n❌ WEBHOOK DISPATCH FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
