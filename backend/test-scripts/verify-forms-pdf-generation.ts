/**
 * Verification: forms engine PDF generation (Task 1 fix).
 *
 * Root cause: generate() (from @pdfme/generator) was called without a
 * `plugins` option, falling back to @pdfme/schemas' `builtInPlugins`, which
 * in the installed version (6.1.11) only registers `text`. Any field whose
 * pdfme schema `type` wasn't `'text'` made generate() throw
 * "Plugin or renderer for type <type> not found" — surfaced as
 * ERR-PDF-GENERATION for every template with a non-text field (date, number,
 * checkbox, textarea, select, radio, email, file).
 *
 * Fix: toPdfmeSchema() now forces every field's rendered type to 'text',
 * generate() is called with an explicit `plugins: { text }`, and
 * toPrintableFormData() stringifies every value (checkbox -> Yes/No, etc.)
 * before it's handed to pdfme.
 *
 * This script proves the fix directly against the real @pdfme/generator +
 * @pdfme/schemas packages (no DB/server needed) by rendering a template with
 * one field of every supported type via previewFormTemplatePdf() — the same
 * generateFormPdf()/toPdfmeSchema()/toPrintableFormData() pipeline
 * createFormInstance() uses for real submissions.
 *
 * Run: npx tsx test-scripts/verify-forms-pdf-generation.ts
 */
import { previewFormTemplatePdf } from '../src/modules/forms/forms.service.js';

let ok = true;
const check = (cond: boolean, msg: string, details?: unknown) => {
  if (cond) {
    console.log('  ✅', msg);
  } else {
    ok = false;
    console.log('  ❌', msg, details ?? '');
  }
};

async function main() {
  console.log('\n═══ Forms PDF generation (Task 1 fix) ═══\n');

  // One field per type the builder supports, on a blank A4 page (no base PDF).
  const schemaJson = [
    [
      { name: 'full_name', type: 'text', title: 'Full name', position: { x: 20, y: 20 }, width: 170, height: 10, required: true },
      { name: 'notes', type: 'textarea', title: 'Notes', position: { x: 20, y: 32 }, width: 170, height: 18 },
      { name: 'requested_date', type: 'date', title: 'Requested date', position: { x: 20, y: 52 }, width: 80, height: 10 },
      { name: 'amount', type: 'number', title: 'Amount', position: { x: 110, y: 52 }, width: 80, height: 10 },
      { name: 'urgent', type: 'checkbox', title: 'Urgent', position: { x: 20, y: 64 }, width: 10, height: 10 },
      { name: 'department', type: 'select', title: 'Department', options: ['Finance', 'Legal', 'HR'], position: { x: 20, y: 76 }, width: 80, height: 10 },
      { name: 'priority', type: 'radio', title: 'Priority', options: ['Low', 'High'], position: { x: 110, y: 76 }, width: 80, height: 10 },
      { name: 'contact_email', type: 'email', title: 'Contact email', position: { x: 20, y: 88 }, width: 170, height: 10 },
      { name: 'attachment', type: 'file', title: 'Attachment', position: { x: 20, y: 100 }, width: 170, height: 10 },
    ],
  ];

  // 1. Every field type together must not throw and must return a real PDF.
  try {
    const pdf = await previewFormTemplatePdf({ schemaJson });
    check(Buffer.isBuffer(pdf) && pdf.length > 0, 'generate() returns a non-empty buffer for a mixed-type schema');
    check(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'output starts with the %PDF- magic header');
  } catch (err) {
    check(false, 'generate() did not throw for a mixed-type schema', err);
  }

  // 2. Each field type individually — pinpoints which type regresses if one does.
  const singleFieldSchemas: Record<string, unknown> = {
    text: { name: 'f', type: 'text', title: 'F', position: { x: 20, y: 20 }, width: 170, height: 10 },
    textarea: { name: 'f', type: 'textarea', title: 'F', position: { x: 20, y: 20 }, width: 170, height: 18 },
    date: { name: 'f', type: 'date', title: 'F', position: { x: 20, y: 20 }, width: 80, height: 10 },
    number: { name: 'f', type: 'number', title: 'F', position: { x: 20, y: 20 }, width: 80, height: 10 },
    checkbox: { name: 'f', type: 'checkbox', title: 'F', position: { x: 20, y: 20 }, width: 10, height: 10 },
    select: { name: 'f', type: 'select', title: 'F', options: ['A', 'B'], position: { x: 20, y: 20 }, width: 80, height: 10 },
    radio: { name: 'f', type: 'radio', title: 'F', options: ['A', 'B'], position: { x: 20, y: 20 }, width: 80, height: 10 },
    email: { name: 'f', type: 'email', title: 'F', position: { x: 20, y: 20 }, width: 170, height: 10 },
    file: { name: 'f', type: 'file', title: 'F', position: { x: 20, y: 20 }, width: 170, height: 10 },
  };
  for (const [type, field] of Object.entries(singleFieldSchemas)) {
    try {
      const pdf = await previewFormTemplatePdf({ schemaJson: [[field]] });
      check(Buffer.isBuffer(pdf) && pdf.length > 0, `type '${type}' alone renders without throwing`);
    } catch (err) {
      check(false, `type '${type}' alone renders without throwing`, err);
    }
  }

  // 3. A required field of each type must not trip pdfme's own
  //    "input for '<name>' is required" check — previewFormTemplatePdf always
  //    supplies a non-empty sample value, including for file fields.
  try {
    const requiredSchema = [
      Object.entries(singleFieldSchemas).map(([, field]) => ({ ...(field as object), required: true })),
    ];
    const pdf = await previewFormTemplatePdf({ schemaJson: requiredSchema });
    check(Buffer.isBuffer(pdf) && pdf.length > 0, 'all-required mixed-type schema renders without throwing');
  } catch (err) {
    check(false, 'all-required mixed-type schema renders without throwing', err);
  }

  console.log(ok ? '\n✅ FORMS PDF GENERATION VERIFIED' : '\n❌ FORMS PDF GENERATION FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error running verification:', err);
  process.exit(1);
});
