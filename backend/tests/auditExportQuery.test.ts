import {
  parseAuditExportQuery,
  MAX_AUDIT_EXPORT_ROWS,
  DEFAULT_AUDIT_EXPORT_ROWS,
} from "../src/modules/audit/auditExportQuery.js";
import { AppError } from "../src/core/AppError.js";

// Regression cover for the 2026-09-03 audit finding on GET /audit/export:
// `limit` was `req.query.limit ? Number(req.query.limit) : 10000` and went
// straight into AuditLog.findAll, so an `audit:read` holder could ask for
// every audit row the tenant has (heap exhaustion for every tenant on the
// process) or send a non-numeric value (LIMIT NaN → a Postgres syntax error
// as a 500). `format`, `from` and `to` were unvalidated too.
describe("parseAuditExportQuery", () => {
  const codeOf = (fn: () => unknown): { status: number; code: string } => {
    try {
      fn();
    } catch (e) {
      const err = e as AppError;
      return { status: err.statusCode, code: err.code };
    }
    throw new Error("expected parseAuditExportQuery to throw");
  };

  describe("defaults", () => {
    it("defaults to csv and the previous row default when nothing is passed", () => {
      expect(parseAuditExportQuery({})).toEqual({
        format: "csv",
        limit: DEFAULT_AUDIT_EXPORT_ROWS,
        eventType: undefined,
        from: undefined,
        to: undefined,
      });
    });
  });

  describe("limit", () => {
    it("passes a reasonable limit through unchanged", () => {
      expect(parseAuditExportQuery({ limit: "500" }).limit).toBe(500);
      expect(parseAuditExportQuery({ limit: 1 }).limit).toBe(1);
    });

    it("CLAMPS an over-large limit instead of serving it", () => {
      // The finding itself: this used to be honoured verbatim.
      expect(parseAuditExportQuery({ limit: "50000000" }).limit).toBe(MAX_AUDIT_EXPORT_ROWS);
      expect(parseAuditExportQuery({ limit: String(MAX_AUDIT_EXPORT_ROWS + 1) }).limit).toBe(
        MAX_AUDIT_EXPORT_ROWS,
      );
    });

    it("allows exactly the ceiling", () => {
      expect(parseAuditExportQuery({ limit: String(MAX_AUDIT_EXPORT_ROWS) }).limit).toBe(
        MAX_AUDIT_EXPORT_ROWS,
      );
    });

    it("rejects a non-numeric limit as 400, not LIMIT NaN as 500", () => {
      expect(codeOf(() => parseAuditExportQuery({ limit: "abc" }))).toEqual({
        status: 400,
        code: "ERR-INVALID-INPUT",
      });
    });

    it("rejects zero, negatives and fractions", () => {
      for (const bad of ["0", "-5", "1.5"]) {
        expect(codeOf(() => parseAuditExportQuery({ limit: bad })).status).toBe(400);
      }
    });
  });

  describe("format", () => {
    it("accepts the three supported formats, case-insensitively", () => {
      expect(parseAuditExportQuery({ format: "csv" }).format).toBe("csv");
      expect(parseAuditExportQuery({ format: "JSON" }).format).toBe("json");
      expect(parseAuditExportQuery({ format: "Pdf" }).format).toBe("pdf");
    });

    it("rejects an unsupported format instead of silently sending CSV", () => {
      expect(codeOf(() => parseAuditExportQuery({ format: "xlsx" }))).toEqual({
        status: 400,
        code: "ERR-INVALID-INPUT",
      });
    });
  });

  describe("from / to", () => {
    it("parses valid bounds", () => {
      const q = parseAuditExportQuery({ from: "2026-01-01", to: "2026-12-31" });
      expect(q.from?.toISOString().slice(0, 10)).toBe("2026-01-01");
      expect(q.to?.toISOString().slice(0, 10)).toBe("2026-12-31");
    });

    it("rejects an unparseable date rather than passing an Invalid Date to the driver", () => {
      expect(codeOf(() => parseAuditExportQuery({ from: "garbage" })).status).toBe(400);
      expect(codeOf(() => parseAuditExportQuery({ to: "not-a-date" })).status).toBe(400);
    });

    it("rejects an inverted range", () => {
      expect(
        codeOf(() => parseAuditExportQuery({ from: "2026-12-31", to: "2026-01-01" })).status,
      ).toBe(400);
    });

    it("accepts from == to", () => {
      expect(() => parseAuditExportQuery({ from: "2026-05-01", to: "2026-05-01" })).not.toThrow();
    });
  });

  describe("eventType", () => {
    it("is passed through as a string when present, undefined when absent", () => {
      expect(parseAuditExportQuery({ eventType: "AUTH_LOGIN" }).eventType).toBe("AUTH_LOGIN");
      expect(parseAuditExportQuery({}).eventType).toBeUndefined();
      // An empty string is falsy, and means "no filter" — same as before.
      expect(parseAuditExportQuery({ eventType: "" }).eventType).toBeUndefined();
    });
  });
});
