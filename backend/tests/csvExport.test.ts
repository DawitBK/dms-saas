import { csvCell, csvRow, toCsv } from "../src/shared/csv.js";

// Regression cover for the 2026-09-03 audit finding: three export endpoints
// (audit, legal-hold, reports) each carried their own CSV escaper and two were
// wrong. shared/csv.ts is now the single implementation — these are the cases
// that were actually broken, plus the formula-injection hardening it adds.
describe("shared/csv", () => {
  describe("csvCell", () => {
    it("passes ordinary text through untouched", () => {
      expect(csvCell("Quarterly report")).toBe("Quarterly report");
      expect(csvCell("DOCUMENT_CREATED")).toBe("DOCUMENT_CREATED");
    });

    it("renders null and undefined as an empty field", () => {
      expect(csvCell(null)).toBe("");
      expect(csvCell(undefined)).toBe("");
    });

    it("stringifies non-strings", () => {
      expect(csvCell(42)).toBe("42");
      expect(csvCell(0)).toBe("0");
      expect(csvCell(false)).toBe("false");
    });

    it("quotes a field containing a comma", () => {
      expect(csvCell("Doe, Jane")).toBe('"Doe, Jane"');
    });

    // The audit exporter's old escaper tested ONLY for a comma, so each of the
    // next three went out raw and corrupted the file.
    it("quotes and doubles an embedded double quote", () => {
      expect(csvCell('the "final" draft')).toBe('"the ""final"" draft"');
    });

    it("quotes a field containing a newline", () => {
      expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    });

    it("quotes a field containing a bare carriage return", () => {
      // reports.service.ts's escaper tested /[",\n]/ and so missed this one:
      // Excel on Windows treats a lone CR as a row break.
      expect(csvCell("line one\rline two")).toBe('"line one\rline two"');
    });

    it("neutralises a value that would otherwise be read as a formula", () => {
      // Prefixed with an apostrophe so Excel/LibreOffice render the text
      // rather than evaluating it. The apostrophe is itself in NEEDS_QUOTING,
      // so a neutralised cell always comes out quoted too — see csv.ts.
      expect(csvCell("+1234")).toBe(`"'+1234"`);
      expect(csvCell("-1+1")).toBe(`"'-1+1"`);
      expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
      expect(csvCell("=1+1")).toBe(`"'=1+1"`);

      // The formula payload that motivates this: quoting alone would not have
      // stopped it, because the cell text still began with "=".
      const attack = `=HYPERLINK("http://attacker/","click")`;
      const cell = csvCell(attack);
      expect(cell.startsWith("=")).toBe(false);
      expect(cell).toBe(`"'=HYPERLINK(""http://attacker/"",""click"")"`);
    });

    it("does not treat a leading digit or letter as a formula", () => {
      expect(csvCell("2026-09-03")).toBe("2026-09-03");
      expect(csvCell("KRC-2026-001")).toBe("KRC-2026-001");
    });
  });

  describe("csvRow / toCsv", () => {
    it("joins fields with commas and rows with CRLF", () => {
      expect(csvRow(["a", "b", "c"])).toBe("a,b,c");
      expect(toCsv(["h1", "h2"], [["a", "b"], ["c", "d"]])).toBe(
        "h1,h2\r\na,b\r\nc,d",
      );
    });

    it("emits a header-only document when there are no rows", () => {
      expect(toCsv(["id", "status"], [])).toBe("id,status");
    });

    // The failure the audit exporter's escaper actually allowed: a newline in
    // any value silently split one row into two, so a row could be forged
    // inside the tamper-evidence export itself.
    it("keeps a value containing a newline inside a single row", () => {
      const csv = toCsv(
        ["sequenceNumber", "errorCode"],
        [["1", "ERR-X\n2,ERR-FORGED"]],
      );
      // Exactly one row separator: the one between header and body.
      expect(csv.split("\r\n")).toHaveLength(2);
      expect(csv).toBe('sequenceNumber,errorCode\r\n1,"ERR-X\n2,ERR-FORGED"');
    });
  });
});
