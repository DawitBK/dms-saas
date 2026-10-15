/**
 * Reports & Analytics dashboard aggregate.
 *
 * Unlike the flat { columns, rows, summary } compliance reports in
 * reports.service.ts, this returns a dashboard-shaped payload: KPI totals, a
 * zero-filled daily trend, and a handful of distribution breakdowns — all
 * computed from the same `documents` table those reports already query, plus
 * an optional storage-analytics roll-up.
 *
 * Every query is anchored on the tenant and on the caller's detail-ACL-visible
 * document ids; optional department/document-type filters are ANDed on top.
 * Scope is never widened by caller-supplied filters.
 *
 * Permission scoping: the route requires the same baseline permission the
 * existing document-inventory / by-department / by-type / by-classification
 * reports use (AUDIT_READ). A few KPI fields surface data that the report
 * registry gates behind a *more specific* permission elsewhere
 * (retention-disposal-eligible → RETENTION_READ, legal-hold-register →
 * LEGAL_HOLD_READ, storage/analytics → DOCUMENT_READ) — those fields are only
 * included when the caller also holds that specific permission, so this
 * endpoint never discloses more than the equivalent existing endpoints would.
 */
import { QueryTypes } from "sequelize";
import { sequelize } from "../../infrastructure/database/sequelize.js";
import { PERMISSIONS, type Permission } from "../../config/permissions.js";
import { getStorageAnalytics } from "./storage.service.js";
import { getDetailVisibleDocumentIds } from "../documents/documents.service.js";
import type { AuthenticatedUser } from "../../shared/auth.js";

export interface DashboardFilters {
  from?: string | null;
  to?: string | null;
  departmentId?: string | null;
  documentTypeId?: string | null;
}

export interface DashboardResult {
  range: { from: string; to: string };
  filters: { departmentId: string | null; documentTypeId: string | null };
  kpis: {
    totalDocuments: number;
    documentsThisPeriod: number;
    documentsPreviousPeriod: number;
    periodChangePercent: number | null;
    pendingApprovals: number;
    pendingSignatures: number;
    retentionEligibleForDisposal?: number;
    documentsOnLegalHold?: number;
    totalStorageUsedBytes?: string;
    storageQuotaUsedPercent?: number;
  };
  trend: { date: string; count: number }[];
  byDepartment: { code: string; name: string; count: number }[];
  byType: { code: string; name: string; count: number }[];
  byClassification: { classification: string; count: number }[];
  byStatus: { status: string; count: number }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeUuid(v: string | null | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

function sanitizeDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.slice(0, 10);
  return DATE_RE.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function q<T = Record<string, unknown>>(
  sql: string,
  replacements: Record<string, unknown>,
): Promise<T[]> {
  const rows = await sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
  return rows as unknown as T[];
}

const DEFAULT_RANGE_DAYS = 30;

export async function getDashboard(
  user: AuthenticatedUser,
  filters: DashboardFilters,
): Promise<DashboardResult> {
  const tenantId = user.tenantId;
  const permissions = user.permissions;
  const departmentId = sanitizeUuid(filters.departmentId);
  const documentTypeId = sanitizeUuid(filters.documentTypeId);
  const to = sanitizeDate(filters.to) ?? new Date().toISOString().slice(0, 10);
  const from = sanitizeDate(filters.from) ?? addDays(to, -DEFAULT_RANGE_DAYS);

  // Previous period of equal length, immediately preceding `from` — used for
  // the "vs previous period" KPI comparison.
  const periodDays = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  );
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(periodDays - 1));

  const visibleDocumentIds = await getDetailVisibleDocumentIds(user, { departmentId, documentTypeId });
  // Keep the SQL aggregates fast, but constrain every one to the exact same
  // detail-visible id set. The sentinel makes the empty result case safe for
  // PostgreSQL's IN expansion without special-casing every query below.
  const scopedIds = visibleDocumentIds.length ? visibleDocumentIds : ['00000000-0000-0000-0000-000000000000'];

  const has = (p: Permission) => permissions.includes(p);

  // Shared WHERE fragment: tenant scope + deleted-doc exclusion + the
  // optional department/document-type filters. Every aggregate below reuses
  // this exact fragment so filters apply uniformly across KPIs and charts.
  const scopeSql = `
    doc.tenant_id = :tenantId AND doc.deleted_at IS NULL
    AND (:departmentId::uuid IS NULL OR doc.department_id = :departmentId)
    AND (:documentTypeId::uuid IS NULL OR doc.document_type_id = :documentTypeId)
    AND doc.id IN (:visibleDocumentIds)
  `;
  const rep = {
    tenantId,
    departmentId,
    documentTypeId,
    from,
    to,
    prevFrom,
    prevTo,
    visibleDocumentIds: scopedIds,
  };

  const [
    totalRows,
    periodRows,
    prevPeriodRows,
    statusRows,
    trendRows,
    deptRows,
    typeRows,
    classRows,
  ] = await Promise.all([
    q<{ count: number }>(`SELECT COUNT(*)::int AS count FROM documents doc WHERE ${scopeSql}`, rep),
    q<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM documents doc WHERE ${scopeSql}
       AND doc.created_at >= :from::timestamptz AND doc.created_at < (:to::date + interval '1 day')`,
      rep,
    ),
    q<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM documents doc WHERE ${scopeSql}
       AND doc.created_at >= :prevFrom::timestamptz AND doc.created_at < (:prevTo::date + interval '1 day')`,
      rep,
    ),
    q<{ pending_approvals: number; pending_signatures: number }>(
      `SELECT
         SUM(CASE WHEN doc.status IN ('PENDING_REVIEW','IN_REVIEW') THEN 1 ELSE 0 END)::int AS pending_approvals,
         SUM(CASE WHEN doc.status = 'PENDING_SIGNATURE' THEN 1 ELSE 0 END)::int AS pending_signatures
       FROM documents doc WHERE ${scopeSql}`,
      rep,
    ),
    q<{ date: string; count: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS date, COUNT(doc.id)::int AS count
       FROM generate_series(:from::date, :to::date, interval '1 day') AS day
       LEFT JOIN documents doc
         ON doc.tenant_id = :tenantId AND doc.deleted_at IS NULL
        AND date_trunc('day', doc.created_at) = day
        AND (:departmentId::uuid IS NULL OR doc.department_id = :departmentId)
        AND (:documentTypeId::uuid IS NULL OR doc.document_type_id = :documentTypeId)
        AND doc.id IN (:visibleDocumentIds)
       GROUP BY day ORDER BY day`,
      rep,
    ),
    q<{ code: string; name: string; count: number }>(
      `SELECT d.code AS code, d.name AS name, COUNT(doc.id)::int AS count
       FROM documents doc JOIN departments d ON d.id = doc.department_id
       WHERE ${scopeSql}
       GROUP BY d.code, d.name ORDER BY count DESC`,
      rep,
    ),
    q<{ code: string; name: string; count: number }>(
      `SELECT t.code AS code, t.name AS name, COUNT(doc.id)::int AS count
       FROM documents doc JOIN document_types t ON t.id = doc.document_type_id
       WHERE ${scopeSql}
       GROUP BY t.code, t.name ORDER BY count DESC`,
      rep,
    ),
    q<{ classification: string; count: number }>(
      `SELECT doc.security_classification AS classification, COUNT(*)::int AS count
       FROM documents doc WHERE ${scopeSql}
       GROUP BY doc.security_classification ORDER BY count DESC`,
      rep,
    ),
  ]);

  // byStatus reuses the same status buckets as document-inventory (AUDIT_READ).
  const byStatusRows = await q<{ status: string; count: number }>(
    `SELECT doc.status AS status, COUNT(*)::int AS count
     FROM documents doc WHERE ${scopeSql}
     GROUP BY doc.status ORDER BY count DESC`,
    rep,
  );

  const totalDocuments = Number(totalRows[0]?.count ?? 0);
  const documentsThisPeriod = Number(periodRows[0]?.count ?? 0);
  const documentsPreviousPeriod = Number(prevPeriodRows[0]?.count ?? 0);
  const periodChangePercent =
    documentsPreviousPeriod > 0
      ? Math.round(((documentsThisPeriod - documentsPreviousPeriod) / documentsPreviousPeriod) * 1000) / 10
      : documentsThisPeriod > 0
        ? 100
        : null;

  const kpis: DashboardResult["kpis"] = {
    totalDocuments,
    documentsThisPeriod,
    documentsPreviousPeriod,
    periodChangePercent,
    pendingApprovals: Number(statusRows[0]?.pending_approvals ?? 0),
    pendingSignatures: Number(statusRows[0]?.pending_signatures ?? 0),
  };

  // Retention and legal-hold counts read the same `documents` columns the
  // corresponding reports (RETENTION_READ / LEGAL_HOLD_READ) already expose —
  // only surfaced here if the caller holds that same permission.
  if (has(PERMISSIONS.RETENTION_READ)) {
    const rows = await q<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM documents doc WHERE ${scopeSql}
       AND doc.disposal_eligible_date IS NOT NULL
       AND doc.disposal_eligible_date <= now()
       AND doc.is_on_legal_hold = false`,
      rep,
    );
    kpis.retentionEligibleForDisposal = Number(rows[0]?.count ?? 0);
  }

  if (has(PERMISSIONS.LEGAL_HOLD_READ)) {
    const rows = await q<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM documents doc WHERE ${scopeSql} AND doc.is_on_legal_hold = true`,
      rep,
    );
    kpis.documentsOnLegalHold = Number(rows[0]?.count ?? 0);
  }

  if (has(PERMISSIONS.DOCUMENT_READ_ALL)) {
    const analytics = await getStorageAnalytics(tenantId);
    kpis.totalStorageUsedBytes = analytics.summary.totalStorageUsed;
    kpis.storageQuotaUsedPercent = analytics.summary.quotaUsedPercent;
  }

  return {
    range: { from, to },
    filters: { departmentId, documentTypeId },
    kpis,
    trend: trendRows.map((r) => ({ date: r.date, count: Number(r.count) })),
    byDepartment: deptRows.map((r) => ({ code: r.code, name: r.name, count: Number(r.count) })),
    byType: typeRows.map((r) => ({ code: r.code, name: r.name, count: Number(r.count) })),
    byClassification: classRows.map((r) => ({
      classification: r.classification,
      count: Number(r.count),
    })),
    byStatus: byStatusRows.map((r) => ({ status: r.status, count: Number(r.count) })),
  };
}
