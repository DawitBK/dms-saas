// Small, dependency-free helpers for classifying database errors.
//
// Deliberately its own module rather than living in shared/middleware.ts: a
// service importing that file drags in `pinoHttp({ logger })`, which runs at
// module-eval time and blows up under the minimal logger mocks the service
// unit tests use.

/** Postgres 22P02 = invalid_text_representation — e.g. a non-UUID string
 *  compared against a `uuid` column (`GET /documents/not-a-uuid`), or a
 *  non-numeric string against an integer one.
 *
 *  Reaches application code either as a raw `pg` error or wrapped by
 *  Sequelize's DatabaseError (which exposes the original under both `.parent`
 *  and `.original`). It means the REQUEST was malformed, so it belongs on the
 *  400 side of the fence, not the 500 side — see errorHandler. */
export function isInvalidTextRepresentation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; parent?: { code?: unknown }; original?: { code?: unknown } };
  return e.code === "22P02" || e.parent?.code === "22P02" || e.original?.code === "22P02";
}

/** Pull the SQLSTATE off a raw `pg` error or a Sequelize-wrapped one. */
function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: unknown; parent?: { code?: unknown }; original?: { code?: unknown } };
  for (const candidate of [e.code, e.parent?.code, e.original?.code]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/**
 * R-01: the request could not get, or could not keep, a database connection —
 * the process is over capacity or the database is not keeping up. Three
 * distinct causes, one meaning to the caller:
 *
 *   - Sequelize's own `ConnectionAcquireTimeoutError`: every pooled connection
 *     was busy for DB_POOL_ACQUIRE_MS. Matched by NAME rather than by
 *     importing the class, to keep this module dependency-free (see the header
 *     comment) — the name is part of Sequelize's public API surface.
 *   - 57014 query_canceled: DB_STATEMENT_TIMEOUT_MS aborted a statement.
 *   - 25P03 idle_in_transaction_session_timeout: the request transaction sat
 *     open with no statement running for DB_IDLE_IN_TRANSACTION_TIMEOUT_MS.
 *
 * All three are 503, not 500. The distinction is not cosmetic: a 500 says
 * "this request is broken, retrying will not help", and every one of these
 * says the opposite — the request was fine and a retry may well succeed. It
 * is also what lets a load balancer, a client, and an alerting rule tell
 * "DMS is over capacity" apart from "DMS has a bug", which are different
 * incidents with different responses.
 */
export function isCapacityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "SequelizeConnectionAcquireTimeoutError" || name === "ConnectionAcquireTimeoutError") {
    return true;
  }
  const state = sqlState(error);
  return state === "57014" || state === "25P03";
}

// ───────────────────────────────────────────────────────────────────────────
// Generic DB-constraint-violation -> precise AppError translation.
//
// This is the SAFETY NET, not the primary path: a service that already knows
// the business meaning of a conflict (departments.service.ts's duplicate-code
// pre-check, folders.service.ts's "a folder with this name already exists in
// this location") should keep throwing its own well-worded AppError BEFORE
// the write ever reaches Postgres — that will always read better than
// anything derived here, because it has context (which location, which
// scope) that the raw SQL error does not carry.
//
// What this covers is everything NOT pre-checked: any unique/foreign-key/
// not-null/check-constraint violation anywhere in the app that would
// otherwise fall through errorHandler's final catch-all as a bare
// "Internal server error" 500. Postgres reports these with structured wire-
// protocol fields (table/column/constraint/detail), independent of whichever
// SQL statement triggered them and independent of whether a migration added
// them last week or a service method was ever updated to expect them — so a
// single generic translator here gets every current AND future constraint
// covered for free, without hand-authoring a message registry that will
// silently go stale as the schema grows. It won't always read as naturally
// as a bespoke pre-check, but it is always accurate: built from the real
// table/column names Postgres reported, never a guess.
// ───────────────────────────────────────────────────────────────────────────

export interface DescribedDatabaseError {
  statusCode: number;
  code: string;
  message: string;
}

/** Fields Postgres attaches to a constraint-violation error, read off
 *  whichever object actually carries them (Sequelize wraps the raw `pg`
 *  error as `.original`/`.parent`; the wrapper itself sometimes duplicates
 *  a subset, e.g. ForeignKeyConstraintError#table). */
interface PgErrorFields {
  code?: string;
  table?: string;
  column?: string;
  constraint?: string;
  detail?: string;
  message?: string;
}

function pgFields(error: unknown): PgErrorFields {
  if (!error || typeof error !== "object") return {};
  const e = error as Record<string, unknown>;
  const original = (e.original ?? e.parent ?? {}) as Record<string, unknown>;
  const pick = (key: string): unknown => original[key] ?? e[key];
  return {
    code: typeof pick("code") === "string" ? (pick("code") as string) : undefined,
    table: typeof pick("table") === "string" ? (pick("table") as string) : undefined,
    column: typeof pick("column") === "string" ? (pick("column") as string) : undefined,
    constraint: typeof pick("constraint") === "string" ? (pick("constraint") as string) : undefined,
    detail: typeof original.detail === "string" ? (original.detail as string) : undefined,
    message: typeof original.message === "string" ? (original.message as string) : typeof e.message === "string" ? (e.message as string) : undefined,
  };
}

// Columns that are implementation detail, never something a user typed or
// would recognize — worth naming a table by, never worth naming a column by.
const SKIP_COLUMNS = new Set(["id", "tenant_id", "created_at", "updated_at", "deleted_at"]);

const COLUMN_LABELS: Record<string, string> = {
  org_unit_id: "organizational unit",
  department_id: "department",
  parent_id: "parent",
  document_type_id: "document type",
  form_template_id: "form template",
  form_instance_id: "form",
  role_id: "role",
  user_id: "user",
  document_id: "document",
  version_id: "version",
  code: "code",
  email: "email address",
  name: "name",
  path: "path",
  reference: "reference number",
  reference_number: "reference number",
  key: "key",
  sequence_number: "sequence number",
  external_sub: "external identity",
};

const TABLE_LABELS: Record<string, string> = {
  departments: "department",
  document_types: "document type",
  org_units: "organizational unit",
  folder_nodes: "folder",
  users: "user",
  roles: "role",
  letters: "letter",
  tenants: "tenant",
  form_instances: "form",
  form_templates: "form template",
  documents: "document",
  document_versions: "document version",
  document_deks: "document encryption key",
  access_rules: "access rule",
  audit_logs: "audit log entry",
  doc_locks: "document lock",
  outbox_events: "outbox event",
  approval_chains: "approval chain",
  approval_chain_templates: "approval chain template",
  user_departments: "department membership",
  user_roles: "role assignment",
};

function singularize(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function humanizeTable(table: string | undefined): string {
  if (!table) return "record";
  if (TABLE_LABELS[table]) return TABLE_LABELS[table];
  return singularize(table.replace(/_/g, " "));
}

function humanizeColumn(column: string): string {
  if (COLUMN_LABELS[column]) return COLUMN_LABELS[column];
  return column.replace(/_id$/, "").replace(/_/g, " ");
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function describeUniqueViolation(error: unknown, fields: PgErrorFields): DescribedDatabaseError {
  const entity = humanizeTable(fields.table);
  // Sequelize's own UniqueConstraintError parses Postgres's "Key (a, b)=(x, y)
  // already exists." detail line into a real {column: value} map — read it
  // directly rather than re-parsing `fields.detail` ourselves.
  const values = (error as { fields?: Record<string, unknown> } | null)?.fields ?? undefined;
  const columns = values ? Object.keys(values).filter((c) => !SKIP_COLUMNS.has(c)) : [];

  if (columns.length === 0) {
    return { statusCode: 409, code: "ERR-DUPLICATE", message: `A ${entity} with these exact details already exists.` };
  }

  // An _id column names a relationship, not something the user typed — showing
  // its raw UUID value would be meaningless to them, so only the label is
  // shown for those; a code/email/name/path/etc. column shows its real value,
  // since that IS what the user typed and recognizes.
  const mentions = columns.map((col) => {
    const label = humanizeColumn(col);
    if (col.endsWith("_id") || col === "id") return label;
    return `${label} "${String(values![col])}"`;
  });

  return {
    statusCode: 409,
    code: "ERR-DUPLICATE",
    message: `A ${entity} already exists with the same ${joinNaturally(mentions)}.`,
  };
}

function extractTableFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const match = /(?:insert or update|update or delete) on table "(.+?)"/.exec(message);
  return match?.[1];
}

function describeForeignKeyViolation(fields: PgErrorFields): DescribedDatabaseError {
  const detail = fields.detail ?? "";
  const thisTable = extractTableFromMessage(fields.message) ?? fields.table;
  const entity = humanizeTable(thisTable);

  // Postgres phrases these two directions of the same SQLSTATE differently,
  // and the difference is exactly what the caller needs to know: "the thing
  // you're pointing at doesn't exist" is a 422 the caller can fix by
  // re-picking a valid target; "other rows still depend on this" is a 409 the
  // caller can only fix by removing those first.
  const notPresent = /is not present in table "(.+?)"/.exec(detail);
  if (notPresent) {
    const parentEntity = humanizeTable(notPresent[1]);
    return {
      statusCode: 422,
      code: "ERR-REFERENCE-NOT-FOUND",
      message: `This ${entity} refers to a ${parentEntity} that no longer exists. Refresh and try again.`,
    };
  }

  const stillReferenced = /is still referenced from table "(.+?)"/.exec(detail);
  if (stillReferenced) {
    const childEntity = humanizeTable(stillReferenced[1]);
    return {
      statusCode: 409,
      code: "ERR-REFERENCE-IN-USE",
      message: `This ${entity} cannot be removed because it is still referenced by one or more ${pluralize(childEntity)}.`,
    };
  }

  return {
    statusCode: 409,
    code: "ERR-REFERENCE",
    message: `This change is blocked by a data relationship on ${entity}${fields.constraint ? ` (${fields.constraint})` : ""}.`,
  };
}

function describeNotNullViolation(fields: PgErrorFields): DescribedDatabaseError {
  const entity = humanizeTable(fields.table);
  const field = fields.column ? humanizeColumn(fields.column) : "a required field";
  return {
    statusCode: 400,
    code: "ERR-REQUIRED-FIELD",
    message: `${capitalize(field)} is required for a ${entity}.`,
  };
}

function describeCheckViolation(fields: PgErrorFields): DescribedDatabaseError {
  const entity = humanizeTable(fields.table);
  let rule = fields.constraint ?? "a validation rule";
  if (fields.table && rule.startsWith(`${fields.table}_`)) rule = rule.slice(fields.table.length + 1);
  rule = rule.replace(/_check$/, "").replace(/_/g, " ").trim();
  return {
    statusCode: 422,
    code: "ERR-CONSTRAINT-VIOLATION",
    message: `That value is not allowed for a ${entity}${rule ? ` (violates "${rule}")` : ""}.`,
  };
}

function describeStringTooLong(fields: PgErrorFields): DescribedDatabaseError {
  const match = /character varying\((\d+)\)/.exec(fields.message ?? "");
  const limit = match?.[1];
  return {
    statusCode: 400,
    code: "ERR-VALUE-TOO-LONG",
    message: limit
      ? `One of the values provided is longer than the allowed ${limit} characters.`
      : "One of the values provided is too long.",
  };
}

function describeNumericOutOfRange(fields: PgErrorFields): DescribedDatabaseError {
  const entity = humanizeTable(fields.table);
  const field = fields.column ? humanizeColumn(fields.column) : "a value";
  return {
    statusCode: 400,
    code: "ERR-VALUE-OUT-OF-RANGE",
    message: `${capitalize(field)} is out of the allowed range for a ${entity}.`,
  };
}

/**
 * Translate a raw Sequelize/Postgres constraint-violation error into a
 * precise, user-safe `{ statusCode, code, message }` triple — or `null` if
 * this isn't a DB-constraint error at all (genuinely unexpected bugs still
 * fall through to errorHandler's true catch-all, which is correct: a 500
 * there is honest, not a gap in this classifier).
 */
export function describeDatabaseError(error: unknown): DescribedDatabaseError | null {
  if (!error || typeof error !== "object") return null;
  const name = (error as { name?: unknown }).name;
  const fields = pgFields(error);

  if (name === "SequelizeUniqueConstraintError" || name === "SequelizeExclusionConstraintError" || fields.code === "23505" || fields.code === "23P01") {
    return describeUniqueViolation(error, fields);
  }
  if (name === "SequelizeForeignKeyConstraintError" || fields.code === "23503") {
    return describeForeignKeyViolation(fields);
  }
  if (fields.code === "23502") return describeNotNullViolation(fields);
  if (fields.code === "23514") return describeCheckViolation(fields);
  if (fields.code === "22001") return describeStringTooLong(fields);
  if (fields.code === "22003") return describeNumericOutOfRange(fields);

  return null;
}
