/**
 * Verification: email template system.
 * Renders every templated event type plus the generic fallback and asserts
 * each produces a branded HTML body, a subject, and a plain-text fallback.
 * Run:  npx tsx test-scripts/verify-email-templates.ts
 */
import { renderEmail, TEMPLATED_EVENT_TYPES } from "../src/infrastructure/email/templates.js";

const SAMPLE: Record<string, Record<string, unknown>> = {
  "RETENTION.DISPOSAL_WARNING_90": { documentName: "FY24 Audit Report", documentId: "doc-1", eligibleAt: "2026-09-30" },
  "RETENTION.DISPOSAL_WARNING_30": { documentName: "FY24 Audit Report", documentId: "doc-1", eligibleAt: "2026-07-30" },
  "RETENTION.DISPOSAL_PENDING": { documentName: "Old Contract", documentId: "doc-2" },
  "WORKFLOW.SLA_BREACH": { stageName: "Legal Review", taskId: "task-9" },
};

let ok = true;
const check = (cond: boolean, msg: string) => { if (!cond) { ok = false; console.log("  ❌", msg); } else console.log("  ✅", msg); };

const types = [...TEMPLATED_EVENT_TYPES, "SOME.UNKNOWN_EVENT"];
for (const type of types) {
  const { subject, html, text } = renderEmail(type, SAMPLE[type] ?? { foo: "bar", n: 3 });
  console.log(`\n• ${type}`);
  console.log(`    subject: ${subject}`);
  check(subject.startsWith("[DMS]") || type === "LETTER.DISPATCH_EMAIL", "subject is branded");
  check(html.includes("<!doctype html") && html.includes("DMS"), "html is wrapped in branded layout");
  check(text.length > 20 && text.includes("automated message"), "plain-text fallback present");
}

console.log(ok ? "\n✅ EMAIL TEMPLATES VERIFIED" : "\n❌ EMAIL TEMPLATES FAILED");
process.exit(ok ? 0 : 1);
