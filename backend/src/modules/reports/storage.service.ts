import { QueryTypes } from "sequelize";
import { sequelize } from "../../infrastructure/database/sequelize.js";
import { Tenant } from "../../infrastructure/database/index.js";

export interface StorageAnalyticsResult {
  summary: {
    totalStorageUsed: string;
    totalDocuments: number;
    quotaBytes: string;
    quotaUsedPercent: number;
    alerts: Array<{ threshold: number; reached: boolean; message: string }>;
  };
  byDepartment: Array<{
    departmentId: string;
    departmentCode: string;
    departmentName: string;
    totalBytes: string;
    documentCount: number;
    versionCount: number;
  }>;
  byDocumentType: Array<{
    documentTypeCode: string;
    documentTypeName: string;
    totalBytes: string;
    documentCount: number;
  }>;
  byStatus: Array<{
    status: string;
    documentCount: number;
    totalBytes: string;
  }>;
}

export async function getStorageAnalytics(tenantId: string): Promise<StorageAnalyticsResult> {
  const tenant = await Tenant.findByPk(tenantId);
  const quotaBytes = BigInt(tenant?.storageQuotaBytes ?? 10_737_418_240);

  const [byDept, byType, byStatus] = await Promise.all([
    sequelize.query<{
      dept_id: string; dept_code: string; dept_name: string;
      total_bytes: string; doc_count: string; version_count: string;
    }>(
      `SELECT d.id AS dept_id, d.code AS dept_code, d.name AS dept_name,
              COALESCE(SUM(dv.file_size), 0) AS total_bytes,
              COUNT(DISTINCT docs.id) AS doc_count,
              COUNT(dv.id) AS version_count
       FROM departments d
       LEFT JOIN documents docs ON docs.department_id = d.id
         AND docs.tenant_id = :tenantId AND docs.deleted_at IS NULL
       LEFT JOIN document_versions dv ON dv.document_id = docs.id
       WHERE d.tenant_id = :tenantId AND d.is_active = true
       GROUP BY d.id, d.code, d.name
       ORDER BY total_bytes DESC`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
    sequelize.query<{
      type_code: string; type_name: string;
      total_bytes: string; doc_count: string;
    }>(
      `SELECT dt.code AS type_code, dt.name AS type_name,
              COALESCE(SUM(dv.file_size), 0) AS total_bytes,
              COUNT(DISTINCT docs.id) AS doc_count
       FROM document_types dt
       LEFT JOIN documents docs ON docs.document_type_id = dt.id
         AND docs.tenant_id = :tenantId AND docs.deleted_at IS NULL
       LEFT JOIN document_versions dv ON dv.document_id = docs.id
       WHERE dt.tenant_id = :tenantId AND dt.is_active = true
       GROUP BY dt.id, dt.code, dt.name
       ORDER BY total_bytes DESC`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
    sequelize.query<{ status: string; doc_count: string; total_bytes: string }>(
      `SELECT docs.status,
              COUNT(DISTINCT docs.id) AS doc_count,
              COALESCE(SUM(dv.file_size), 0) AS total_bytes
       FROM documents docs
       LEFT JOIN document_versions dv ON dv.document_id = docs.id
       WHERE docs.tenant_id = :tenantId AND docs.deleted_at IS NULL
       GROUP BY docs.status
       ORDER BY doc_count DESC`,
      { replacements: { tenantId }, type: QueryTypes.SELECT }
    ),
  ]);

  const totalBytes = byDept.reduce((acc, r) => acc + BigInt(r.total_bytes), 0n);
  const totalDocs = byDept.reduce((acc, r) => acc + Number(r.doc_count), 0);
  const usedPercent = quotaBytes > 0n
    ? Math.round(Number((totalBytes * 100n) / quotaBytes))
    : 0;

  const alerts = [80, 90, 100].map(t => ({
    threshold: t,
    reached: usedPercent >= t,
    message: usedPercent >= t
      ? `Storage at ${usedPercent}% capacity — ${t}% threshold reached`
      : `Storage at ${usedPercent}% (${t}% threshold not yet reached)`,
  }));

  return {
    summary: {
      totalStorageUsed: totalBytes.toString(),
      totalDocuments: totalDocs,
      quotaBytes: quotaBytes.toString(),
      quotaUsedPercent: usedPercent,
      alerts,
    },
    byDepartment: byDept.map(r => ({
      departmentId: r.dept_id,
      departmentCode: r.dept_code,
      departmentName: r.dept_name,
      totalBytes: r.total_bytes,
      documentCount: Number(r.doc_count),
      versionCount: Number(r.version_count),
    })),
    byDocumentType: byType.map(r => ({
      documentTypeCode: r.type_code,
      documentTypeName: r.type_name,
      totalBytes: r.total_bytes,
      documentCount: Number(r.doc_count),
    })),
    byStatus: byStatus.map(r => ({
      status: r.status,
      documentCount: Number(r.doc_count),
      totalBytes: r.total_bytes,
    })),
  };
}
