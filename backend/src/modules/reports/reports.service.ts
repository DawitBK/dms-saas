/**
 * Compliance reporting.
 *
 * A registry of tenant-scoped reports computed by SQL aggregation over the
 * live data (documents, workflow tasks, audit trail). Each report returns a
 * uniform { columns, rows, summary } shape so the API and UI can render any
 * report generically, and CSV export works for all of them. Adding a report =
 * one registry entry.
 *
 * Tenant scoping: documents and workflow_tasks carry tenant_id directly; the
 * audit trail has no tenant column, so audit reports are scoped to events tied
 * to the tenant's documents.
 */
import { QueryTypes } from "sequelize";
import { toCsv } from "../../shared/csv.js";
import { sequelize } from "../../infrastructure/database/sequelize.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS, type Permission } from "../../config/permissions.js";

export interface ReportRange {
  from?: string | null;
  to?: string | null;
}

export interface ReportResult {
  key: string;
  name: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

interface ReportDef {
  key: string;
  name: string;
  description: string;
  requiredPermission: Permission;
  hasDateRange: boolean;
  generate: (tenantId: string, range: ReportRange) => Promise<Omit<ReportResult, "key" | "name">>;
}

async function q(sql: string, replacements: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const rows = await sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
  return rows as unknown as Record<string, unknown>[];
}

const sum = (rows: Record<string, unknown>[], key: string) =>
  rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);

const REPORTS: ReportDef[] = [
  {
    key: "document-inventory",
    name: "Document Inventory by Status",
    description: "Count of active (non-deleted) documents grouped by lifecycle status.",
    requiredPermission: PERMISSIONS.AUDIT_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT status, COUNT(*)::int AS count FROM documents
         WHERE tenant_id = :tenantId AND deleted_at IS NULL
         GROUP BY status ORDER BY count DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "status", label: "Status" },
          { key: "count", label: "Documents" },
        ],
        rows,
        summary: { totalDocuments: sum(rows, "count"), statuses: rows.length },
      };
    },
  },
  {
    key: "documents-by-department",
    name: "Documents by Department",
    description: "Document counts grouped by owning department.",
    requiredPermission: PERMISSIONS.AUDIT_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT d.code AS department_code, d.name AS department_name, COUNT(doc.id)::int AS count
         FROM documents doc JOIN departments d ON d.id = doc.department_id
         WHERE doc.tenant_id = :tenantId AND doc.deleted_at IS NULL
         GROUP BY d.code, d.name ORDER BY count DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "department_code", label: "Code" },
          { key: "department_name", label: "Department" },
          { key: "count", label: "Documents" },
        ],
        rows,
        summary: { totalDocuments: sum(rows, "count"), departments: rows.length },
      };
    },
  },
  {
    key: "documents-by-type",
    name: "Documents by Type",
    description: "Document counts grouped by document type.",
    requiredPermission: PERMISSIONS.AUDIT_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT t.code AS type_code, t.name AS type_name, COUNT(doc.id)::int AS count
         FROM documents doc JOIN document_types t ON t.id = doc.document_type_id
         WHERE doc.tenant_id = :tenantId AND doc.deleted_at IS NULL
         GROUP BY t.code, t.name ORDER BY count DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "type_code", label: "Code" },
          { key: "type_name", label: "Document Type" },
          { key: "count", label: "Documents" },
        ],
        rows,
        summary: { totalDocuments: sum(rows, "count"), types: rows.length },
      };
    },
  },
  {
    key: "documents-by-classification",
    name: "Security Classification Breakdown",
    description: "Document counts grouped by security classification.",
    requiredPermission: PERMISSIONS.AUDIT_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT security_classification AS classification, COUNT(*)::int AS count
         FROM documents WHERE tenant_id = :tenantId AND deleted_at IS NULL
         GROUP BY security_classification ORDER BY count DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "classification", label: "Classification" },
          { key: "count", label: "Documents" },
        ],
        rows,
        summary: { totalDocuments: sum(rows, "count") },
      };
    },
  },
  {
    key: "retention-disposal-eligible",
    name: "Disposal Eligibility Register",
    description: "Documents whose disposal-eligible date has passed (or falls before the range end), excluding those on legal hold.",
    requiredPermission: PERMISSIONS.RETENTION_READ,
    hasDateRange: true,
    generate: async (tenantId, range) => {
      const rows = await q(
        `SELECT id, document_name, title, retention_class, disposal_eligible_date, is_on_legal_hold, status
         FROM documents
         WHERE tenant_id = :tenantId AND deleted_at IS NULL
           AND disposal_eligible_date IS NOT NULL
           AND disposal_eligible_date <= COALESCE(CAST(:to AS timestamptz), now())
         ORDER BY disposal_eligible_date ASC`,
        { tenantId, to: range.to ?? null },
      );
      return {
        columns: [
          { key: "document_name", label: "Reference" },
          { key: "title", label: "Title" },
          { key: "retention_class", label: "Retention Class" },
          { key: "disposal_eligible_date", label: "Eligible Date" },
          { key: "is_on_legal_hold", label: "On Hold" },
          { key: "status", label: "Status" },
        ],
        rows,
        summary: {
          eligibleCount: rows.length,
          blockedByHold: rows.filter((r) => r.is_on_legal_hold).length,
        },
      };
    },
  },
  {
    key: "legal-hold-register",
    name: "Legal Hold Register",
    description: "Documents currently under legal hold.",
    requiredPermission: PERMISSIONS.LEGAL_HOLD_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT doc.document_name, doc.title, doc.status, d.name AS department_name
         FROM documents doc LEFT JOIN departments d ON d.id = doc.department_id
         WHERE doc.tenant_id = :tenantId AND doc.is_on_legal_hold = true AND doc.deleted_at IS NULL
         ORDER BY doc.updated_at DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "document_name", label: "Reference" },
          { key: "title", label: "Title" },
          { key: "department_name", label: "Department" },
          { key: "status", label: "Status" },
        ],
        rows,
        summary: { documentsOnHold: rows.length },
      };
    },
  },
  {
    key: "workflow-sla",
    name: "Workflow SLA Compliance",
    description: "Workflow tasks grouped by status, with SLA breach counts.",
    requiredPermission: PERMISSIONS.WORKFLOW_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT status, COUNT(*)::int AS count,
                SUM(CASE WHEN is_sla_breach THEN 1 ELSE 0 END)::int AS sla_breaches
         FROM workflow_tasks WHERE tenant_id = :tenantId
         GROUP BY status ORDER BY count DESC`,
        { tenantId },
      );
      return {
        columns: [
          { key: "status", label: "Task Status" },
          { key: "count", label: "Tasks" },
          { key: "sla_breaches", label: "SLA Breaches" },
        ],
        rows,
        summary: { totalTasks: sum(rows, "count"), totalBreaches: sum(rows, "sla_breaches") },
      };
    },
  },
  {
    key: "letter-volume",
    name: "Letter Volume (Last 6 Months)",
    description: "Correspondence volume per month, split by direction, for the trailing 6 months (zero-filled).",
    requiredPermission: PERMISSIONS.LETTER_READ,
    hasDateRange: false,
    generate: async (tenantId) => {
      const rows = await q(
        `SELECT to_char(month, 'YYYY-MM') AS month,
                COALESCE(SUM(CASE WHEN l.direction = 'OUTGOING' THEN 1 ELSE 0 END), 0)::int AS outgoing_count,
                COALESCE(SUM(CASE WHEN l.direction = 'INCOMING' THEN 1 ELSE 0 END), 0)::int AS incoming_count,
                COUNT(l.id)::int AS total_count
         FROM generate_series(
                date_trunc('month', now()) - interval '5 months',
                date_trunc('month', now()),
                interval '1 month'
              ) AS month
         LEFT JOIN letters l
                ON l.tenant_id = :tenantId
               AND date_trunc('month', l.created_at) = month
         GROUP BY month
         ORDER BY month`,
        { tenantId },
      );
      const totalLetters = sum(rows, "total_count");
      return {
        columns: [
          { key: "month", label: "Month" },
          { key: "outgoing_count", label: "Outgoing" },
          { key: "incoming_count", label: "Incoming" },
          { key: "total_count", label: "Total" },
        ],
        rows,
        summary: {
          totalLetters,
          monthsCovered: rows.length,
          avgPerMonth: rows.length > 0 ? Math.round((totalLetters / rows.length) * 10) / 10 : 0,
        },
      };
    },
  },
  {
    key: "audit-activity",
    name: "Audit Activity Summary",
    description: "Audit events for this tenant's documents, grouped by event type (optionally within a date range).",
    requiredPermission: PERMISSIONS.AUDIT_READ,
    hasDateRange: true,
    generate: async (tenantId, range) => {
      const rows = await q(
        `SELECT event_type, COUNT(*)::int AS count,
                SUM(CASE WHEN is_success THEN 0 ELSE 1 END)::int AS failures
         FROM audit_logs
         WHERE document_id IN (SELECT id FROM documents WHERE tenant_id = :tenantId)
           AND (CAST(:from AS timestamptz) IS NULL OR timestamp >= CAST(:from AS timestamptz))
           AND (CAST(:to AS timestamptz) IS NULL OR timestamp <= CAST(:to AS timestamptz))
         GROUP BY event_type ORDER BY count DESC`,
        { tenantId, from: range.from ?? null, to: range.to ?? null },
      );
      return {
        columns: [
          { key: "event_type", label: "Event Type" },
          { key: "count", label: "Events" },
          { key: "failures", label: "Failures" },
        ],
        rows,
        summary: { totalEvents: sum(rows, "count"), totalFailures: sum(rows, "failures") },
      };
    },
  },
];

const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

/** Metadata for all available reports (for the picker UI). */
export function listReports() {
  return REPORTS.map(({ key, name, description, requiredPermission, hasDateRange }) => ({
    key,
    name,
    description,
    requiredPermission,
    hasDateRange,
  }));
}

export function getReportDef(key: string): ReportDef {
  const def = BY_KEY.get(key);
  if (!def) throw new AppError(404, "ERR-REPORT-NOT-FOUND", `Unknown report: ${key}`);
  return def;
}

export async function runReport(key: string, tenantId: string, range: ReportRange): Promise<ReportResult> {
  const def = getReportDef(key);
  const { columns, rows, summary } = await def.generate(tenantId, range);
  return { key: def.key, name: def.name, columns, rows, summary };
}

/**
 * Report rows as CSV.
 *
 * Escaping lives in shared/csv.ts now — this had the closest of the three
 * hand-rolled escapers in the codebase (it did test for quotes and newlines)
 * but still missed a bare carriage return, and the point of consolidating is
 * that a fourth export endpoint cannot reintroduce a fourth variant.
 */
export function reportToCsv(result: ReportResult): string {
  return toCsv(
    result.columns.map((c) => c.label),
    result.rows.map((row) => result.columns.map((c) => row[c.key])),
  );
}
