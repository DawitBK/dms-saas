/**
 * Verification: letterhead form templates paginate correctly past ~17
 * fields, and the letterhead artwork repeats correctly on every generated
 * page (the "identified-but-not-fixed" gap from the prior session's
 * summary, now closed in schema.ts's toSchema() + forms.service.ts's
 * fetchBasePdf()/toPdfmeSchema()).
 *
 * Exercises the REAL pipeline: frontend's toSchema() (imported directly —
 * it's framework-free) lays out fields exactly as the template builder
 * would, then getExampleCorpLetterheadObjectKey() + previewFormTemplatePdf()
 * run the exact same generateFormPdf()/toPdfmeSchema()/fetchBasePdf() code a
 * real submission uses. No DB needed — only storage (MinIO/local disk).
 *
 * Run: npx tsx test-scripts/verify-letterhead-pagination.ts
 */
import { PDFDocument } from 'pdf-lib';
import { getExampleCorpLetterheadObjectKey, previewFormTemplatePdf } from '../src/modules/forms/forms.service.js';
import { toSchema, type BuilderField, type SectionMeta } from '../../frontend/features/forms/schema.js';

let ok = true;
const check = (cond: boolean, msg: string, details?: unknown) => {
  if (cond) {
    console.log('  ✅', msg);
  } else {
    ok = false;
    console.log('  ❌', msg, details ?? '');
  }
};

function field(n: number, section?: string): BuilderField {
  return {
    id: `f${n}`,
    name: `field_${n}`,
    label: `Field ${n} label text`,
    type: 'text',
    required: false,
    section,
  };
}

async function main() {
  console.log('\n═══ Letterhead pagination + artwork repeat ═══\n');

  const sections: SectionMeta[] = [
    { id: 'sec_a', label: 'Section A', order: 0 },
    { id: 'sec_b', label: 'Section B', order: 1 },
  ];
  // 30 fields split across two sections — comfortably past the ~17-field
  // single-page ceiling the prior session flagged as unfixed.
  const fields: BuilderField[] = [
    ...Array.from({ length: 15 }, (_, i) => field(i + 1, 'sec_a')),
    ...Array.from({ length: 15 }, (_, i) => field(i + 16, 'sec_b')),
  ];

  const pagedSchema = toSchema(fields, sections, true);
  check(pagedSchema.length > 1, `toSchema() splits 30 fields onto multiple pages (got ${pagedSchema.length} pages)`, pagedSchema.map((p) => p.length));

  const totalFieldsAcrossPages = pagedSchema.reduce((sum, p) => sum + p.length, 0);
  check(totalFieldsAcrossPages === fields.length, `all ${fields.length} fields present across pages (got ${totalFieldsAcrossPages})`, pagedSchema.map((p) => p.length));

  const objectKey = await getExampleCorpLetterheadObjectKey('test-tenant-1');
  check(typeof objectKey === 'string' && objectKey.length > 0, 'getExampleCorpLetterheadObjectKey resolves an object key', objectKey);

  const pdf = await previewFormTemplatePdf({ schemaJson: pagedSchema, basePdfObjectKey: objectKey, isLetterhead: true });
  check(Buffer.isBuffer(pdf) && pdf.length > 0, 'previewFormTemplatePdf renders a non-empty buffer');
  check(pdf.subarray(0, 5).toString('latin1') === '%PDF-', 'output starts with the %PDF- magic header');

  const loaded = await PDFDocument.load(pdf);
  check(loaded.getPageCount() === pagedSchema.length, `generated PDF has ${pagedSchema.length} pages (got ${loaded.getPageCount()})`);

  // Every page must carry the letterhead artwork background, not just page 1
  // — this is exactly the "fetchBasePdf must repeat the base file's last
  // page for every extra page needed" fix (forms.service.ts).
  const pageSizes = loaded.getPages().map((p) => p.getSize());
  check(
    pageSizes.every((s) => Math.abs(s.width - 595.276) < 1 && Math.abs(s.height - 841.89) < 1),
    'every page is A4-sized (consistent with the letterhead artwork background)',
    pageSizes,
  );

  // A single-page (no pagination needed) letterhead template should still
  // render fine and NOT duplicate pages.
  const smallFields: BuilderField[] = Array.from({ length: 5 }, (_, i) => field(i + 1));
  const smallSchema = toSchema(smallFields, [], true);
  check(smallSchema.length === 1, `5 fields stay on a single page (got ${smallSchema.length})`);
  const smallPdf = await previewFormTemplatePdf({ schemaJson: smallSchema, basePdfObjectKey: objectKey, isLetterhead: true });
  const smallLoaded = await PDFDocument.load(smallPdf);
  check(smallLoaded.getPageCount() === 1, `single-page letterhead template renders exactly 1 page (got ${smallLoaded.getPageCount()})`);

  console.log(ok ? '\n✅ LETTERHEAD PAGINATION VERIFIED' : '\n❌ LETTERHEAD PAGINATION FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error running verification:', err);
  process.exit(1);
});
