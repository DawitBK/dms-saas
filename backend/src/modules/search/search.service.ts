// SPRINT-1/5: search setup and later ACL-filtered indexing depend on the external auth and search contract.
import { Op } from "sequelize";
import {
  Department,
  Document,
  DocumentMetadata,
  DocumentType,
  SavedSearch
} from "../../infrastructure/database/index.js";
import { meili } from "../../infrastructure/search/meilisearch.js";
import { logger } from "../../core/logger.js";
import { resolveACL } from "../../shared/resolveACL.js";
import { PERMISSIONS, userHasPermission } from "../../config/permissions.js";

type CurrentUser = {
  userId: string;
  role: string;
  roles?: string[];
  permissions?: string[];
  tenantId: string;
};

type SearchFilters = {
  // departmentId is the precise, collision-free filter — department codes are
  // only unique per (tenant, org unit) as of migration
  // 20260912000001-department-code-scope-org-unit.sql, so two departments in
  // different org units can now share a code. departmentCode is kept ONLY so
  // saved searches serialized before departmentId existed still filter
  // sensibly: resolveDepartmentCodeToIds() below expands a legacy code into
  // every department id sharing it (tenant-wide), same recall as the old
  // code-based filter had, just expressed through the new field internally.
  // New callers (search/page.tsx) always send departmentId.
  departmentId?: string;
  departmentCode?: string;
  documentTypeCode?: string;
  status?: string;
  securityClassification?: string;
  isOnLegalHold?: boolean;
  dateFrom?: string;
  dateTo?: string;
  retentionClass?: string;
  facets?: boolean;
};

// Documents carry TWO confidentiality fields: `sensitivityLabel` stored in title
// case ('Public' | 'Internal' | 'Confidential' | 'Restricted') and
// `securityClassification` stored upper case. The Restricted rule below compared
// the label to "RESTRICTED", which never matches a stored 'Restricted' — so the
// S5-06 rule was silently inert and a Restricted document surfaced in search for
// anyone who could read it, exactly like an Internal one. Compare
// case-insensitively and on both fields.
function isRestricted(doc: { sensitivityLabel?: string | null; securityClassification?: string | null }): boolean {
  return [doc.sensitivityLabel, doc.securityClassification].some((v) => typeof v === "string" && v.toUpperCase() === "RESTRICTED");
}

// Meilisearch filter values are caller-controlled strings (query parameters);
// JSON.stringify yields a correctly quoted/escaped literal so a value can never
// close the quote and append its own clause.
const filterValue = (v: string) => JSON.stringify(v);

async function isUserAllowedToReadDocument(user: CurrentUser, doc: { id: string; sensitivityLabel?: string | null; securityClassification?: string | null }) {
  // §1: permission-based ACL bypass — users with ACL_BYPASS_ADMIN skip per-resource checks
  if (userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.ACL_BYPASS_ADMIN)) {
    return true;
  }

  const result = await resolveACL({
    resourceType: "document",
    resourceId: doc.id,
    permission: "document:read",
    userId: user.userId,
    userRole: user.role,
    userRoles: user.roles,
    userPermissions: user.permissions,
    tenantId: user.tenantId
  });

  if (!result.allowed) {
    return false;
  }

  // S5-06: Restricted label excluded from search without user-specific ACL
  // Holders of tenant-wide read (Executive, Auditor, Records Officer: the oversight roles)
  // are exempt: they already see Restricted documents in every list, and an oversight role
  // that cannot FIND what it may open defeats its purpose. An explicit DENY has already
  // been applied by resolveACL above, so it still wins over this exemption.
  if (isRestricted(doc) && !userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_READ_ALL)) {
    if (result.principalType !== "user" || result.effect !== "ALLOW") {
      return false;
    }
  }

  return true;
}

// A legacy saved search's departmentCode may now match departments in
// several org units (see the SearchFilters comment) — resolve it to every
// matching department id in this tenant rather than picking one arbitrarily,
// so a stale filter's recall never gets narrower than it used to be.
async function resolveDepartmentCodeToIds(tenantId: string, code: string): Promise<string[]> {
  const rows = await Department.findAll({ where: { tenantId, code }, attributes: ["id"] });
  return rows.map((r) => r.id);
}

async function resolveDepartmentIdFilter(user: CurrentUser, filters?: SearchFilters): Promise<string[] | undefined> {
  if (filters?.departmentId) return [filters.departmentId];
  if (filters?.departmentCode) return resolveDepartmentCodeToIds(user.tenantId, filters.departmentCode);
  return undefined;
}

async function searchDocumentsDb(user: CurrentUser, query: string, filters?: SearchFilters) {
  // Tenant scope is MANDATORY here. RLS is currently bypassed (the DB role is a
  // superuser) and resolveACL is not tenant-scoped, so without this filter a
  // user in tenant A whose default role ALLOWs match tenant B's documents would
  // receive B's document metadata through the ILIKE fallback (S19 audit finding).
  // The Meilisearch path is already isolated via the per-tenant index name.
  const where: Record<string, unknown> = { tenantId: user.tenantId, deletedAt: { [Op.is]: null } };
  const isOversight = userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.SEARCH_SCOPE_ALL);

  if (!isOversight) {
    // SPRINT-1: departmentIds removed from JWT. In Sprint 1, we rely on role and later ACL/RLS.
    // For now, if we don't have departmentIds, we'll allow seeing documents in the tenant.
  }
  if (filters?.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length > 1 ? { [Op.in]: statuses } : statuses[0];
  }
  if (filters?.securityClassification) where.securityClassification = filters.securityClassification;
  if (filters?.isOnLegalHold !== undefined) where.isOnLegalHold = filters.isOnLegalHold;
  if (filters?.retentionClass) where.retentionClass = filters.retentionClass;
  if (filters?.dateFrom || filters?.dateTo) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range[Op.gte as unknown as string] = new Date(filters.dateFrom);
    if (filters.dateTo) range[Op.lte as unknown as string] = new Date(filters.dateTo);
    where.createdAt = range;
  }

  const deptInclude: { model: typeof Department; as: string; where?: Record<string, unknown> } = {
    model: Department,
    as: "department"
  };
  // Filtered on Document.departmentId directly rather than joining on the
  // department's code — precise for a real departmentId, and for a legacy
  // departmentCode preserves the old recall across every org unit sharing
  // that code instead of arbitrarily picking one.
  const departmentIds = await resolveDepartmentIdFilter(user, filters);
  if (departmentIds) where.departmentId = departmentIds.length === 1 ? departmentIds[0] : { [Op.in]: departmentIds };

  const typeInclude: { model: typeof DocumentType; as: string; where?: Record<string, unknown> } = {
    model: DocumentType,
    as: "documentType"
  };
  if (filters?.documentTypeCode) typeInclude.where = { code: filters.documentTypeCode };

  if (query.trim()) {
    Object.assign(where, {
      [Op.or]: [
        { title: { [Op.iLike]: `%${query}%` } },
        { documentName: { [Op.iLike]: `%${query}%` } }
      ]
    });
  }

  const rows = await Document.findAll({
    where,
    include: [deptInclude, typeInclude, { model: DocumentMetadata, as: "metadata", required: false }],
    order: [["updatedAt", "DESC"]],
    limit: 50
  });

  const candidateHits = rows.map((doc) => {
    const plain = doc.get({ plain: true }) as any;
    return {
      id: plain.id,
      documentName: plain.documentName,
      title: plain.title,
      departmentId: plain.departmentId,
      departmentCode: plain.department?.code,
      documentTypeCode: plain.documentType?.code,
      status: plain.status,
      securityClassification: plain.securityClassification,
      sensitivityLabel: plain.sensitivityLabel,
      isOnLegalHold: plain.isOnLegalHold,
      updatedAt: plain.updatedAt
    };
  });
  const allowed = await Promise.all(candidateHits.map((hit) => isUserAllowedToReadDocument(user, hit)));
  const hits = candidateHits.filter((_, i) => allowed[i]);

  return { hits, totalHits: hits.length, source: "database" as const };
}

function buildFacetDistribution(hits: Array<Record<string, unknown>>, fields: string[]): Record<string, Record<string, number>> {
  const dist: Record<string, Record<string, number>> = {};
  for (const field of fields) {
    const counts: Record<string, number> = {};
    for (const hit of hits) {
      const value = hit[field];
      if (value === undefined || value === null || value === "") continue;
      counts[String(value)] = (counts[String(value)] ?? 0) + 1;
    }
    dist[field] = counts;
  }
  return dist;
}

export async function searchDocuments(user: CurrentUser, query: string, filters?: SearchFilters) {
  if (meili && query.trim()) {
    try {
      const filterList: string[] = [];
      const isOversightRole = userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.SEARCH_SCOPE_ALL);

      if (!isOversightRole) {
        // SPRINT-1: departmentIds removed from JWT. In Sprint 1, we rely on role and later ACL/RLS.
      }

      // §4 FIX: Meilisearch string filter values must be quoted.
      // departmentId is precise; a legacy departmentCode (old saved search)
      // is resolved to every department id sharing it in this tenant so its
      // recall never gets narrower than the old code-based filter had.
      const departmentIds = await resolveDepartmentIdFilter(user, filters);
      if (departmentIds && departmentIds.length > 0) {
        filterList.push(
          departmentIds.length > 1
            ? `(${departmentIds.map((id) => `departmentId = ${filterValue(id)}`).join(" OR ")})`
            : `departmentId = ${filterValue(departmentIds[0]!)}`
        );
      } else if (departmentIds && departmentIds.length === 0) {
        // A legacy code matched no department in this tenant — filter to
        // nothing rather than silently ignoring the filter (matches the DB
        // fallback's Op.in-on-empty-array behavior).
        filterList.push(`departmentId = "__no_match__"`);
      }
      if (filters?.documentTypeCode) filterList.push(`documentTypeCode = ${filterValue(filters.documentTypeCode)}`);
      if (filters?.status) {
        const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
        filterList.push(statuses.length > 1 ? `(${statuses.map((s) => `status = ${filterValue(s)}`).join(' OR ')})` : `status = ${filterValue(statuses[0]!)}`);
      }
      if (filters?.securityClassification) filterList.push(`securityClassification = ${filterValue(filters.securityClassification)}`);
      if (filters?.isOnLegalHold !== undefined) filterList.push(`isOnLegalHold = ${filters.isOnLegalHold}`);
      if (filters?.retentionClass) filterList.push(`retentionClass = ${filterValue(filters.retentionClass)}`);
      if (filters?.dateFrom) filterList.push(`createdAt >= ${new Date(filters.dateFrom).getTime()}`);
      if (filters?.dateTo) filterList.push(`createdAt <= ${new Date(filters.dateTo).getTime()}`);

      const indexName = `edms-docs-${user.tenantId}`;
      const facetDistList = filters?.facets
        ? ['departmentId', 'documentTypeCode', 'status', 'securityClassification', 'retentionClass']
        : undefined;

      const result = await meili.index(indexName).search(query, {
        filter: filterList.length ? filterList.join(" AND ") : undefined,
        limit: 50,
        facets: facetDistList,
      } as any);

      const candidateHits = result.hits as any[];
      const allowed = await Promise.all(candidateHits.map((hit) => isUserAllowedToReadDocument(user, hit)));
      const filteredHits = candidateHits.filter((_, i) => allowed[i]);

      return {
        hits: filteredHits,
        totalHits: filteredHits.length,
        source: "meilisearch" as const,
        // Meilisearch's own facetDistribution counts EVERY matching document in
        // the tenant index, before the per-document ACL filter above — so it
        // disclosed how many documents of each department/type/status/
        // classification exist that the caller may not read. Rebuilt from the
        // hits the caller is actually allowed to see.
        facetDistribution: facetDistList ? buildFacetDistribution(filteredHits, facetDistList) : undefined,
      };
    } catch (error) {
      logger.warn({ error }, "meilisearch failed, falling back to database search");
    }
  }

  return searchDocumentsDb(user, query, filters);
}

export function saveSearch(userId: string, name: string, query: string, filters?: string) {
  return SavedSearch.create({ userId, name, query, filters });
}

export function getSavedSearches(userId: string) {
  return SavedSearch.findAll({ where: { userId }, order: [["createdAt", "DESC"]] });
}

export async function deleteSavedSearch(id: string, userId: string) {
  const existing = await SavedSearch.findByPk(id);
  if (!existing) throw new Error("Saved search not found");
  if (existing.userId !== userId) throw new Error("Access denied");
  await existing.destroy();
  return { success: true };
}
