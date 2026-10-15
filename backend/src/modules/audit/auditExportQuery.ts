import { AppError } from "../../core/AppError.js";

/**
 * Validation for GET /audit/export's query string.
 *
 * Its own module, and a pure function, so the rules can be unit-tested without
 * standing up the app + a database: the route sits behind `authenticate` and
 * `tenantContext`, so a route-level test of a 400 would be a test of the whole
 * request pipeline instead of a test of these bounds.
 *
 * Every one of these four parameters used to be taken on trust:
 *
 *  - `limit` went straight into `AuditLog.findAll({ limit })` with no ceiling.
 *    `?limit=50000000` loaded every audit row the tenant has into memory and
 *    then built ONE string (CSV/JSON) or one pdf-lib document (~50 rows per
 *    page) from it. audit_logs is the largest table in the system and grows by
 *    a row on essentially every mutating request, so one request from one
 *    `audit:read` holder could exhaust the heap and take the API process down
 *    for everybody on it. `?limit=abc` failed more quietly: NaN reached
 *    Sequelize as `LIMIT NaN`, a Postgres syntax error surfacing as a 500 on an
 *    ordinary-looking URL.
 *  - `from`/`to`: `new Date('garbage')` is an Invalid Date, which reaches the
 *    driver as a malformed timestamp rather than as rejected input.
 *  - `format`: anything unrecognised fell through to CSV, so a caller asking
 *    for `xlsx` got a CSV body under a CSV filename with no indication their
 *    request had not been understood.
 */

export const AUDIT_EXPORT_FORMATS = ["csv", "json", "pdf"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/**
 * 25 000 rows is roughly 4 MB of CSV and ~500 PDF pages — comfortably more
 * than anyone can do anything useful with in one file, and bounded enough that
 * several concurrent exports cannot collectively exhaust the heap. Callers who
 * genuinely need more page through it with `from`/`to`.
 */
export const MAX_AUDIT_EXPORT_ROWS = 25_000;

/** Preserved from before this validation existed, so default behaviour is unchanged. */
export const DEFAULT_AUDIT_EXPORT_ROWS = 10_000;

export type AuditExportQuery = {
  format: AuditExportFormat;
  limit: number;
  eventType?: string;
  from?: Date;
  to?: Date;
};

export function parseAuditExportQuery(query: Record<string, unknown>): AuditExportQuery {
  const requested = String(query.format ?? "csv").toLowerCase();
  if (!(AUDIT_EXPORT_FORMATS as readonly string[]).includes(requested)) {
    throw new AppError(
      400,
      "ERR-INVALID-INPUT",
      `format must be one of: ${AUDIT_EXPORT_FORMATS.join(", ")}`,
    );
  }
  const format = requested as AuditExportFormat;

  let limit = DEFAULT_AUDIT_EXPORT_ROWS;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new AppError(400, "ERR-INVALID-INPUT", "limit must be a positive integer");
    }
    // Clamped, not rejected: an over-large limit is a caller asking for
    // "everything", which is a reasonable thing to ask for and an unreasonable
    // thing to serve in one response.
    limit = Math.min(parsed, MAX_AUDIT_EXPORT_ROWS);
  }

  const parseBound = (raw: unknown, name: string): Date | undefined => {
    if (raw === undefined) return undefined;
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) {
      throw new AppError(400, "ERR-INVALID-INPUT", `${name} must be a valid date`);
    }
    return d;
  };
  const from = parseBound(query.from, "from");
  const to = parseBound(query.to, "to");

  if (from && to && from.getTime() > to.getTime()) {
    throw new AppError(400, "ERR-INVALID-INPUT", "from must not be later than to");
  }

  return {
    format,
    limit,
    eventType: query.eventType ? String(query.eventType) : undefined,
    from,
    to,
  };
}
