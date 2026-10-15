// Shared types + pure helpers for the form template builder and fill form.
// Kept framework-free (no React) so both TemplateBuilderModal and
// FillFormModal can import the exact same evaluation/validation logic.

export type FieldType =
  | 'text'
  | 'textarea'
  | 'date'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'radio'
  | 'email'
  | 'file';

export type ConditionOp = 'equals' | 'notEquals' | 'contains';

// How much of a row a field occupies, so fields can sit side by side instead
// of always stacking one per line (e.g. First name + Last name on one row).
// Fields flow left-to-right and wrap onto a new row once a row is full,
// the same way the section they belong to always starts its own fresh row —
// mirrored 1:1 by LAYOUT_WIDTH_SPAN (CSS grid, for on-screen rendering) and
// the private fraction table below (for computing pdfme x/y/width in toSchema).
export type LayoutWidth = 'full' | 'half' | 'third' | 'quarter';

export const LAYOUT_WIDTH_LABELS: Record<LayoutWidth, string> = {
  full: 'Full width (alone on its row)',
  half: 'Half width (pairs with one more)',
  third: 'One third (pairs with two more)',
  quarter: 'One quarter (pairs with three more)',
};

// Out of a 12-column grid — used by the builder's layout preview and the
// fill-form's live input grid so both render identically to each other.
export const LAYOUT_WIDTH_SPAN: Record<LayoutWidth, number> = {
  full: 12,
  half: 6,
  third: 4,
  quarter: 3,
};

const LAYOUT_WIDTH_FRACTIONS: Record<LayoutWidth, number> = {
  full: 1,
  half: 0.5,
  third: 1 / 3,
  quarter: 0.25,
};

// Packs items left-to-right by their width fraction, wrapping to a new row
// once the running total would exceed a full row — the same greedy flow a
// CSS `flex-wrap`/grid row does, just computed ahead of time since pdfme has
// no layout engine of its own to do this at render time.
function layoutRows<T extends { layoutWidth?: LayoutWidth }>(items: T[]): T[][] {
  const EPS = 1e-6;
  const rows: T[][] = [];
  let current: T[] = [];
  let sum = 0;
  for (const item of items) {
    const frac = LAYOUT_WIDTH_FRACTIONS[item.layoutWidth ?? 'full'];
    if (current.length > 0 && sum + frac > 1 + EPS) {
      rows.push(current);
      current = [];
      sum = 0;
    }
    current.push(item);
    sum += frac;
    if (sum >= 1 - EPS) {
      rows.push(current);
      current = [];
      sum = 0;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

export interface FieldCondition {
  field: string; // another field's `name`
  operator: ConditionOp;
  value: string;
}

export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
}

// A field whose value is derived from OTHER fields rather than typed by the
// submitter — e.g. a leave form's "No of days" computed from "Request from"/
// "Request to" instead of manually entered (and previously able to hold any
// value at all, including a nonsensical negative one). `dateDiffDays` is the
// only kind today; the tagged-union shape leaves room for more without
// touching every call site again. Only makes sense on a `number` field.
export type FieldComputed = {
  type: 'dateDiffDays';
  fromField: string; // another field's `name`, must be type 'date'
  toField: string; // another field's `name`, must be type 'date'
  // false (default): toField - fromField, e.g. Mon->Tue = 1. true: also
  // counts the start day itself, e.g. Mon->Tue = 2 ("2 calendar days
  // covered" rather than "1 day elapsed") — matches how a leave request's
  // day count is normally meant, but left opt-in since it depends on the
  // form.
  inclusive?: boolean;
};

// The field shape as authored in the builder (has a client-only `id` key for
// React lists; `name` is the stable, serialized identifier).
export interface BuilderField {
  id: string;
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  section?: string; // SectionMeta.id
  layoutWidth?: LayoutWidth; // defaults to 'full' when absent
  options?: string[]; // select/radio choices
  conditionalOn?: FieldCondition;
  validation?: FieldValidation;
  computed?: FieldComputed;
}

export interface SectionMeta {
  id: string;
  label: string;
  order: number;
}

// The field shape persisted in FormTemplate.schemaJson — pdfme's flat,
// position-based layout schema, extended with extra keys pdfme's generate()
// simply ignores since it only reads its own known keys (name/type/position/
// width/height/required). Existing rows (no section/options/conditionalOn/
// validation) remain valid: every new key is optional.
export interface FieldSchema {
  name: string;
  type: FieldType;
  position: { x: number; y: number };
  width: number;
  // The row-allocated width per layoutWidth (schema.ts's own layout math),
  // as opposed to `width` above, which for a checkbox is the small 10-unit
  // control box, not the space its caption needs — kept separate so the
  // backend's synthetic PDF label (forms.service.ts's toPdfmeSchema) can
  // span the full allocated column instead of being clipped to 10 units.
  labelWidth?: number;
  height: number;
  required?: boolean;
  title?: string;
  section?: string;
  // The section's human label at authoring time (SectionMeta.label), carried
  // per-field so the backend's PDF generation (forms.service.ts's
  // toPdfmeSchema) can draw a real heading above a section's first row
  // without a second lookup — it only has this flat field array, not
  // sectionsJson. Absent for unsectioned fields.
  sectionLabel?: string;
  layoutWidth?: LayoutWidth;
  options?: string[];
  conditionalOn?: FieldCondition;
  validation?: FieldValidation;
  computed?: FieldComputed;
}

export function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || `field_${Date.now()}`
  );
}

// Page content area: A4 (210 wide) minus 20-unit margins each side, matching
// generateFormPdf's page size in forms.service.ts.
const PAGE_CONTENT_X = 20;
const PAGE_CONTENT_WIDTH = 170;
const ROW_GAP_X = 4;
const ROW_GAP_Y = 6;
const SECTION_GAP_Y = 10;
// Headroom reserved above a named section's first row for the heading
// forms.service.ts's toPdfmeSchema draws there — kept in sync with that
// file's HEADING_HEIGHT/HEADING_GAP constants (values duplicated rather than
// shared since the frontend and backend don't share a module).
const HEADING_HEIGHT = 5;
const HEADING_GAP = 1.5;

// Blank page: content can run the full A4 height minus a plain 20mm margin
// top and bottom (297 - 20 = 277).
const Y_START_BLANK = 28;
const Y_MAX_BLANK = 277;
// Letterhead page: the Example Corp letterhead's header banner ends at
// exactly 60mm and its footer (QR code / contact block) starts at ~258mm —
// measured directly off the asset (assets/letterheads in the backend repo)
// by overlaying a 10mm ruler and reading where the bands fall, not
// eyeballed. 5mm clearance on each side of those bands so content never
// touches the artwork.
const Y_START_LETTERHEAD = 65;
const Y_MAX_LETTERHEAD = 253;

// Lays fields out section by section (each section always starts a fresh
// row), packing same-row fields side by side per their layoutWidth so the
// generated PDF matches what the builder's live preview and the fill-form
// grid both show on screen. Wraps onto additional pages once content would
// run past the bottom margin (or the letterhead's footer artwork) instead of
// silently running fields off the bottom of a single page — every page
// after the first starts back at the top margin (and reprints a section
// heading if a section continues onto it, matching toPdfmeSchema's own
// per-page heading reset in forms.service.ts).
export function toSchema(fields: BuilderField[], sections: SectionMeta[] = [], hasLetterhead = false): FieldSchema[][] {
  const bySection = new Map<string, BuilderField[]>();
  for (const f of fields) {
    const key = f.section ?? UNSECTIONED_ID;
    bySection.set(key, [...(bySection.get(key) ?? []), f]);
  }

  const yStart = hasLetterhead ? Y_START_LETTERHEAD : Y_START_BLANK;
  const yMax = hasLetterhead ? Y_MAX_LETTERHEAD : Y_MAX_BLANK;

  const pages: FieldSchema[][] = [[]];
  let y = yStart;
  // Whether the section currently being laid out has already had its
  // heading reserved/placed on the CURRENT page — reset on every section
  // change and on every page break, since a section's heading reprints at
  // the top of each page it spans.
  let sectionHeadingPlacedOnPage = false;

  const startNewPage = () => {
    pages.push([]);
    y = yStart;
    sectionHeadingPlacedOnPage = false;
  };

  for (const sectionId of [UNSECTIONED_ID, ...sections.map((s) => s.id)]) {
    const sectionFields = bySection.get(sectionId);
    if (!sectionFields || sectionFields.length === 0) continue;
    const sectionMeta = sections.find((s) => s.id === sectionId);
    sectionHeadingPlacedOnPage = false; // a new section always needs its own heading placed
    for (const row of layoutRows(sectionFields)) {
      const rowHeight = Math.max(...row.map((f) => (f.type === 'textarea' ? 18 : 10)));
      const neededHeadingRoom = sectionMeta && !sectionHeadingPlacedOnPage ? HEADING_HEIGHT + HEADING_GAP : 0;
      if (y + neededHeadingRoom + rowHeight > yMax && pages[pages.length - 1].length > 0) {
        startNewPage();
      }
      if (sectionMeta && !sectionHeadingPlacedOnPage) {
        y += HEADING_HEIGHT + HEADING_GAP;
        sectionHeadingPlacedOnPage = true;
      }

      const usableRowWidth = PAGE_CONTENT_WIDTH - ROW_GAP_X * (row.length - 1);
      let x = PAGE_CONTENT_X;
      for (const f of row) {
        const allocatedWidth = LAYOUT_WIDTH_FRACTIONS[f.layoutWidth ?? 'full'] * usableRowWidth;
        const width = f.type === 'checkbox' ? 10 : allocatedWidth;
        const height = f.type === 'textarea' ? 18 : 10;
        pages[pages.length - 1].push({
          name: f.name,
          type: f.type,
          position: { x, y },
          width,
          labelWidth: allocatedWidth,
          height,
          required: f.required,
          title: f.label,
          section: f.section,
          sectionLabel: sectionMeta?.label,
          layoutWidth: f.layoutWidth,
          options: f.options,
          conditionalOn: f.conditionalOn,
          validation: f.validation,
          computed: f.computed,
        });
        x += allocatedWidth + ROW_GAP_X;
      }
      y += rowHeight + ROW_GAP_Y;
    }
    y += SECTION_GAP_Y - ROW_GAP_Y;
  }
  return pages;
}

/** The inverse of toSchema() — recovers the author-facing BuilderField[]
 *  from a saved template's already-positioned FieldSchema[][] (position/
 *  width/height/labelWidth/sectionLabel are toSchema()'s own computed
 *  layout, not authoring input, so they're dropped here). Needed because a
 *  template's DB row only stores the computed pdfme schema, not the
 *  BuilderField[] the builder UI edits — without this, editing a previously
 *  saved (or newly cloned "new version") draft has nothing to load into the
 *  builder and can only ever start from a blank template. `id` is
 *  regenerated per field since FieldSchema has no stable id of its own
 *  (only `name`, which IS preserved so field-to-value keying/PDF schema
 *  names stay identical after a re-save). */
export function fromSchema(schemaJson: FieldSchema[][] | undefined | null): BuilderField[] {
  const fields = (schemaJson ?? []).flat();
  return fields.map((f) => ({
    id: crypto.randomUUID(),
    name: f.name,
    label: f.title || f.name,
    type: f.type,
    required: Boolean(f.required),
    section: f.section,
    layoutWidth: f.layoutWidth,
    options: f.options,
    conditionalOn: f.conditionalOn,
    validation: f.validation,
    computed: f.computed,
  }));
}

/** Whether `field`'s conditionalOn rule (if any) is satisfied by the current values. */
export function evaluateVisibility(
  field: Pick<FieldSchema, 'conditionalOn'>,
  values: Record<string, unknown>,
): boolean {
  if (!field.conditionalOn) return true;
  const { field: refName, operator, value } = field.conditionalOn;
  const actual = String(values[refName] ?? '');
  switch (operator) {
    case 'equals':
      return actual === value;
    case 'notEquals':
      return actual !== value;
    case 'contains':
      return actual.includes(value);
    default:
      return true;
  }
}

/** A computed field's derived value, or null if it isn't computed / its
 *  inputs aren't filled in yet / its inputs don't parse as dates. Mirrors
 *  the backend's computeFieldValue in forms.service.ts — keep both in sync.
 *  `values` should be keyed by field name, same shape as fillData/dataJson. */
export function computeFieldValue(
  field: Pick<FieldSchema, 'computed'>,
  values: Record<string, string | undefined>,
): string | null {
  if (!field.computed) return null;
  if (field.computed.type === 'dateDiffDays') {
    const from = values[field.computed.fromField];
    const to = values[field.computed.toField];
    if (!from || !to) return null;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;
    const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + (field.computed.inclusive ? 1 : 0);
    return String(days);
  }
  return null;
}

/** Returns `values` with every computed field's own entry overwritten by its
 *  derived value (left untouched if inputs aren't filled yet, so a
 *  required-field check still correctly reports it as missing rather than
 *  as an empty computed result). Used by FillFormModal so the submitter
 *  always sees/submits the derived value, never a stale or hand-typed one,
 *  and by the builder's live preview for the same reason. The backend
 *  applies its own copy of this before validating (never trusts a
 *  client-submitted value for a field it can compute itself). */
export function applyComputedFields(
  fields: Pick<FieldSchema, 'name' | 'computed'>[],
  values: Record<string, string>,
): Record<string, string> {
  const next = { ...values };
  for (const field of fields) {
    const computed = computeFieldValue(field, next);
    if (computed !== null) next[field.name] = computed;
  }
  return next;
}

/** Returns an error message for a single field's current value, or null if valid. Mirrors backend fieldZodType in forms.service.ts. */
export function validateFieldValue(field: FieldSchema, rawValue: string | undefined): string | null {
  const value = rawValue ?? '';
  if (field.required && value.trim() === '') {
    return field.computed ? 'Fill in the fields this is calculated from' : 'This field is required';
  }
  if (value === '') return null; // optional + empty: nothing further to check

  const v = field.validation;
  if (field.type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Invalid email address';
  }
  if (field.type === 'number') {
    const num = Number(value);
    if (Number.isNaN(num)) return 'Must be a number';
    if (v?.min !== undefined && num < v.min) return `Must be at least ${v.min}`;
    if (v?.max !== undefined && num > v.max) return `Must be at most ${v.max}`;
  }
  if ((field.type === 'text' || field.type === 'textarea') && v) {
    if (v.minLength !== undefined && value.length < v.minLength) return `Must be at least ${v.minLength} characters`;
    if (v.maxLength !== undefined && value.length > v.maxLength) return `Must be at most ${v.maxLength} characters`;
    if (v.pattern) {
      try {
        if (!new RegExp(v.pattern).test(value)) return 'Does not match required format';
      } catch {
        // invalid regex authored in the builder — ignore rather than block submission
      }
    }
  }
  return null;
}

/** Validates only the currently-visible fields, returning { fieldName: errorMessage }. */
export function validateAll(
  fields: FieldSchema[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!evaluateVisibility(field, values)) continue;
    const error = validateFieldValue(field, values[field.name]);
    if (error) errors[field.name] = error;
  }
  return errors;
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  textarea: 'Long text',
  date: 'Date',
  number: 'Number',
  checkbox: 'Checkbox',
  select: 'Dropdown',
  radio: 'Radio',
  email: 'Email',
  file: 'File upload',
};

export const UNSECTIONED_ID = '__general__';
