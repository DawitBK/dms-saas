/**
 * Uploads are actually scanned, and an infected one is actually refused.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * With CLAMAV_ENABLED=false — which is what this deployment ran until
 * 2026-09-03 — scanBuffer() returns "clean" without scanning anything, and
 * every upload is written to the immutable audit log as DOCUMENT_SCAN_CLEAN.
 * So the system was not merely unprotected: it was asserting, in the record
 * people rely on, that files had been checked when nothing had looked at them.
 *
 * Turning the flag on does not fix that by itself. The scan path fails open by
 * policy (availability over strict blocking), so "enabled but clamd is not
 * running" produces working uploads, an `unscanned` stamp, and no other
 * symptom. The only way to know scanning genuinely happens is to send
 * something that must be caught and watch it be caught.
 *
 * WHAT IT PROVES
 *
 *   1. clamd is reachable and a clean buffer comes back "clean" — not
 *      "unscanned", which is what a silently-absent daemon returns.
 *   2. EICAR is detected at the library boundary (ERR-AV-THREAT-DETECTED).
 *   3. An infected upload is REFUSED by the real HTTP endpoint, 422 — this is
 *      the one that matters, because it exercises the path a user reaches.
 *   4. A clean upload still succeeds and is recorded avScanStatus='clean', so
 *      the scanner is not simply rejecting everything.
 *
 * EICAR is the industry-standard harmless test signature (68 printable ASCII
 * bytes, defined by EICAR precisely so scanners can be tested without live
 * malware). It is assembled at runtime from fragments so this source file is
 * not itself flagged and quarantined by the machine's own AV — which would
 * otherwise delete the test that proves AV works.
 *
 * Needs the backend on :7100, seeded users, and clamd on CLAMAV_PORT.
 * Run: npx tsx test-scripts/verify-antivirus.ts
 */

import 'dotenv/config';
import axios from 'axios';
import FormData from 'form-data';
import { config } from '../src/config/env.js';
import { scanBuffer } from '../src/infrastructure/antivirus/clamscan.js';
import { AppError } from '../src/core/AppError.js';
import { loginAs, verifyAdminEmail } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL ?? 'http://127.0.0.1:7100/api/v1';

// Assembled, not written literally. See the header.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE!$H+H*'].join('-');

// Smallest thing Postgres and the PDF sniffers both accept as a document.
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`, details ?? '');
  }
}

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string; user: any }> {
  return loginAs(email, 'verify-antivirus.ts');
}

/** Errors are wrapped as { error: { code, message } } — not `data.code`. */
const failureCode = (e: any) => e?.response?.data?.error?.code ?? e?.response?.status ?? e?.message;

async function main() {
  console.log('\n═══ Antivirus: uploads are really scanned ═══\n');
  console.log(`  clamd      ${config.CLAMAV_HOST}:${config.CLAMAV_PORT}`);
  console.log(`  enabled    ${config.CLAMAV_ENABLED}\n`);

  if (!config.CLAMAV_ENABLED) {
    console.error(
      '  CLAMAV_ENABLED is false. scanBuffer() short-circuits to "clean" without scanning, so every\n' +
        '  check below would pass while proving nothing at all. Refusing to report a false green.\n',
    );
    process.exit(1);
  }

  // ── 1. The daemon is really there ─────────────────────────────────────────
  //
  // "clean" and "unscanned" are the two non-throwing outcomes, and only the
  // first means a scanner looked at the bytes. Asserting on the exact value is
  // the whole difference between testing AV and testing that uploads work.
  const cleanResult = await scanBuffer(TINY_PDF);
  check(
    'a clean buffer scans as "clean" — not "unscanned", which is what an absent daemon returns',
    cleanResult === 'clean',
    cleanResult,
  );

  // ── 2. It detects something it must detect ────────────────────────────────
  const eicarOutcome = await scanBuffer(Buffer.from(EICAR))
    .then((r) => `returned ${r}`)
    .catch((e) => (e instanceof AppError ? e.code : `threw ${e?.message}`));
  check('the EICAR test signature is detected', eicarOutcome === 'ERR-AV-THREAT-DETECTED', eicarOutcome);

  // ── 3. The endpoint a user actually reaches ───────────────────────────────
  const { token } = await loginWithTenant(verifyAdminEmail());
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  check('admin authenticates', Boolean(token));

  const departments = (await axios.get(`${API_BASE}/departments`, auth)).data.data;
  const docTypes = (await axios.get(`${API_BASE}/document-types`, auth)).data.data;
  const orgUnits = (await axios.get(`${API_BASE}/org-units`, auth)).data.data;
  // Retention class is validated against the tenant's registered policies
  // (ERR-RETENTION-INVALID), so it has to be read rather than assumed.
  const retention = (await axios.get(`${API_BASE}/retention`, auth)).data.data;
  const retentionClass = retention?.[0]?.retentionClass ?? retention?.[0]?.code ?? retention?.[0]?.name;
  check('a retention policy is registered to upload against', Boolean(retentionClass));

  function upload(filename: string, buffer: Buffer, mimeType: string, title: string) {
    const form = new FormData();
    form.append('title', title);
    form.append('departmentCode', departments[0].code);
    form.append('documentTypeCode', (docTypes.find((t: any) => t.code === 'POLICY') ?? docTypes[0]).code);
    form.append('organisationUnit', orgUnits[0].name);
    form.append('securityClassification', 'INTERNAL');
    form.append('retentionClass', retentionClass);
    form.append('source', 'MANUAL_UPLOAD');
    form.append('file', buffer, { filename, contentType: mimeType });
    return axios.post(`${API_BASE}/documents`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
    });
  }

  const stamp = Date.now();
  const infected = await upload('eicar-probe.txt', Buffer.from(EICAR), 'text/plain', `AV probe infected ${stamp}`)
    .then(() => 'ACCEPTED')
    .catch(failureCode);
  check(
    'an infected file is REFUSED by POST /documents — the path a user actually reaches',
    infected === 'ERR-AV-THREAT-DETECTED',
    infected,
  );

  // ── 4. And it is not just rejecting everything ────────────────────────────
  const cleanUpload = await upload('clean-probe.pdf', TINY_PDF, 'application/pdf', `AV probe clean ${stamp}`)
    .then((r) => r.data.data ?? r.data)
    .catch((e) => ({ error: failureCode(e) }));
  check('a clean file still uploads', Boolean(cleanUpload?.id), cleanUpload?.error);

  if (cleanUpload?.id) {
    const versions = (await axios.get(`${API_BASE}/documents/${cleanUpload.id}/versions`, auth)).data.data ?? [];
    const scanStatus = versions[0]?.avScanStatus;
    check(
      "its version records avScanStatus='clean' — the audit trail matches what happened",
      scanStatus === 'clean',
      scanStatus,
    );
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err.response?.status, err.response?.data ?? err.message);
  process.exit(1);
});
