// Fails CI on any HIGH or CRITICAL npm advisory in the PRODUCTION dependency
// tree, except the ones explicitly accepted below.
//
// Why this exists instead of a bare `npm audit --audit-level=high`: one
// advisory in this tree cannot be fixed without a framework major, so the bare
// command is red on every run forever — and a gate that is always red is a gate
// nobody reads. This one stays green until something NEW appears, which is the
// only signal worth acting on.
//
// Usage: node tools/audit-gate.mjs
//
// To accept a new advisory you must add it here with a reason and a removal
// condition. Do not widen the severity threshold instead.

import { execFileSync } from 'node:child_process';

/**
 * Advisory IDs (the GHSA / npm advisory `url` slug) accepted with cause.
 * Each entry must say what it is, why it is not being fixed, and what would
 * let it be removed.
 */
// Empty, and worth keeping that way. The one entry this ever held was
// postcss@8.4.31, pinned inside next@15.x's own nested node_modules where an
// npm root `override` could not reach it (npm 11.4.2 ignores overrides for a
// workspace dependency) and which every stable next@15.x carried. Its stated
// removal condition — "the frontend moves to next@16, which ships a patched
// postcss" — was met on 2026-09-06, so it was removed rather than left to rot
// into an exception nobody rechecks.
//
// 2026-10-17: node-forge (and @signpdf/signer-p12, which only depends on it) carries GHSA-86w9-cpqp-85rv, "RSA PKCS#1 v1.5
// signature verification accepts extra nested DigestAlgorithm elements". The advisory range is "*" and node-forge 1.4.0 is the
// latest release, so there is no version to move to. DMS uses node-forge to create its own CA and certificates, to sign, and to
// verify (signing.service.ts, publicKey.verify and caCert.verify) signatures it created itself; it does not accept signatures from
// outside. That limits the exposure but does not remove it, so this is a tracked exception, not a dismissal.
const ACCEPTED = {
  'node-forge': {
    reason: 'GHSA-86w9-cpqp-85rv has no patched release; DMS verifies only signatures it produced with its own CA',
    removeWhen: 'node-forge publishes a fixed release (check each month), or signature verification moves to Node crypto; re-review by 2026-12-31',
  },
  '@signpdf/signer-p12': {
    reason: 'flagged only through node-forge (same advisory)',
    removeWhen: 'node-forge is fixed',
  },
};

let report;
try {
  report = JSON.parse(
    execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
} catch (err) {
  // `npm audit` exits non-zero whenever it finds anything, so a non-zero exit
  // is expected and its stdout is still the report we want. Only a genuinely
  // unparseable result is a failure of this script.
  if (!err.stdout) throw err;
  report = JSON.parse(err.stdout);
}

const blocking = [];
const accepted = [];

for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
  (ACCEPTED[name] ? accepted : blocking).push({ name, severity: vuln.severity, vuln });
}

for (const { name, severity } of accepted) {
  console.log(`accepted  ${severity.padEnd(8)} ${name} — ${ACCEPTED[name].reason}`);
  console.log(`          remove when: ${ACCEPTED[name].removeWhen}\n`);
}

if (blocking.length === 0) {
  console.log(
    `audit gate PASS — ${accepted.length} accepted advisory/advisories, 0 unaccepted high or critical.`,
  );
  process.exit(0);
}

console.error('\naudit gate FAIL — unaccepted high/critical advisories:\n');
for (const { name, severity, vuln } of blocking) {
  console.error(`  ${severity.toUpperCase()}  ${name}`);
  for (const via of vuln.via) {
    if (typeof via === 'object') console.error(`    - ${via.title} (${via.url})`);
  }
}
console.error(
  '\nFix them, or — only with a written reason and a removal condition — add them\n' +
    'to ACCEPTED in tools/audit-gate.mjs.\n',
);
process.exit(1);
