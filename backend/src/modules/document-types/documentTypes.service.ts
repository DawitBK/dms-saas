import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import { DocumentType, Document, Department, OrgUnit, RetentionPolicy } from "../../infrastructure/database/index.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { AppError } from "../../core/AppError.js";

// Tri-level scope, in order of precedence: departmentId set = DEPARTMENT
// (this one department only); else orgUnitId set = ORG_UNIT (every
// department under that org unit); both null = TENANT (global, the
// pre-existing default). Never both at once — see assertValidScope below
// and the DB CHECK document_types_not_both_dept_and_org_unit.
const documentTypeSchema = z.object({
  code: z.string().min(2).max(10),
  name: z.string().min(1).max(255),
  departmentId: z.string().uuid().nullable().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  defaultRetentionClass: z.string().min(1).max(50),
  requiresSignature: z.boolean().optional(),
  signatoryRole: z.string().max(100).optional().nullable(),
  // Per-type governance policies (SYSTEM-DECISIONS.md D2/D5/D8)
  auditPolicy: z.enum(["required", "optional", "never"]).optional(),
  // FIX 2026-09-14: `signingPolicy` used to be an independently client-set
  // field alongside `requiresSignature` — two separate booleans/enums for
  // the same underlying question ("does this type need a signing
  // ceremony?"), set at different times by different code (requiresSignature
  // from day one, signingPolicy added later for the D8 governance rework)
  // and never reconciled. Reproduced live: examplecorp's AGREEMENT/BOARD/
  // CONTRACT types all had requiresSignature=true but signingPolicy="none",
  // so a document of one of those types that went through the *newer*
  // approval-chain completion path (approvals.service.ts, which only checks
  // signingPolicy) silently skipped the ceremony its own admin-configured
  // flag said it needed — while the *older* completion path
  // (workflow.service.ts, which only checks requiresSignature) would have
  // honored it. No longer independently settable — createDocumentType/
  // updateDocumentType below always derive it from requiresSignature, so the
  // two can't drift apart again. (FormTemplate has its own independent
  // signingPolicy — forms have no requiresSignature of their own — untouched
  // by this.)
  reapprovalPolicy: z.enum(["none", "major_versions", "all_changes"]).optional(),
  requiresApproval: z.boolean().optional(),
  isActive: z.boolean().optional()
});

// Not folded into a zod `.refine()` on documentTypeSchema: updateDocumentType
// calls `.partial()` on this same schema (a partial update may only touch one
// of the two fields), and a ZodEffects wrapper from `.refine()` doesn't expose
// `.partial()`. Called instead against each write path's *effective* final
// state (createDocumentType: the parsed input as-is; updateDocumentType: the
// existing row merged with whatever fields the patch actually sent).
function assertValidScope(departmentId: string | null | undefined, orgUnitId: string | null | undefined) {
  if (departmentId && orgUnitId) {
    throw new AppError(
      422,
      "ERR-DOCTYPE-SCOPE-CONFLICT",
      "A document type can be scoped to a department or an org unit, not both"
    );
  }
}

// The department / org unit a type is scoped to must belong to THIS tenant.
// Neither id was checked before: a type could be scoped to another tenant's
// department (the row is stamped with the caller's tenant, so it only ever
// showed up as a dangling, unusable type — but the foreign key accepted it, and
// the "which department" picker could be probed for ids across tenants).
async function assertScopeTargetsInTenant(
  tenantId: string,
  departmentId: string | null | undefined,
  orgUnitId: string | null | undefined,
) {
  if (departmentId) {
    const dept = await Department.findOne({ where: { id: departmentId, tenantId }, attributes: ["id"] });
    if (!dept) throw new AppError(422, "ERR-DOCTYPE-SCOPE-INVALID", "Department not found in this tenant");
  }
  if (orgUnitId) {
    const unit = await OrgUnit.findOne({ where: { id: orgUnitId, tenantId }, attributes: ["id"] });
    if (!unit) throw new AppError(422, "ERR-DOCTYPE-SCOPE-INVALID", "Organizational unit not found in this tenant");
  }
}

// FIX 2026-09-14: retention_policies is a global (platform-wide, not
// per-tenant) catalog of real, registered retention classes — but this
// schema previously accepted ANY 1-50 char string here with no cross-check
// against it. The admin panel's create form also hardcoded a plausible-
// looking but nonexistent default ("STANDARD"), so a document type could be
// saved successfully and only fail — as a raw 500, not a form validation
// error — the first time someone actually uploaded/e-signed a document of
// that type (esigning.service.ts / documents.service.ts both look the code
// up at that point). Validate against the real catalog at save time instead,
// so the mistake is caught here with a clear message.
async function assertValidRetentionClass(code: string) {
  const policy = await RetentionPolicy.findOne({ where: { code, isActive: true } });
  if (!policy) {
    throw new AppError(
      422,
      "ERR-RETENTION-CLASS-INVALID",
      `"${code}" is not a registered retention class — pick one from Operations > Retention Policies`
    );
  }
}

// `visibleDepartmentIds`/`visibleOrgUnitIds` mirror departments.service.ts's
// getVisibleDepartmentIds/getVisibleOrgUnitIds ("mine" scope: membership ∪
// ACL grant ∪ ancestors) — when passed, returns tenant-wide global types
// (both null) ∪ types scoped to a department the caller can see ∪ types
// scoped to an org unit the caller can see, instead of every type in the
// tenant. Undefined (the default) keeps the unfiltered tenant-wide list for
// existing callers that need it (e.g. ACL_BYPASS_ADMIN holders).
export function listDocumentTypes(
  tenantId: string,
  visibleDepartmentIds?: Set<string>,
  visibleOrgUnitIds?: Set<string>,
  // Deactivated types, for the admin screen that re-activates them. Everything else (pickers) stays active-only.
  includeInactive = false,
) {
  return DocumentType.findAll({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      tenantId,
      ...(visibleDepartmentIds
        ? {
            [Op.or]: [
              { departmentId: null, orgUnitId: null },
              { departmentId: { [Op.in]: Array.from(visibleDepartmentIds) } },
              { orgUnitId: { [Op.in]: Array.from(visibleOrgUnitIds ?? []) } },
            ],
          }
        : {}),
    },
    order: [["code", "ASC"]]
  });
}

// Phase 3: List document types available for a specific department.
// Returns: tenant-wide global types (both null) + types scoped to this
// department's org unit + types scoped to this department itself.
export async function listDocumentTypesForDepartment(tenantId: string, departmentId: string | null) {
  if (!departmentId) {
    // No department context - return only tenant-wide global types
    return DocumentType.findAll({
      where: { isActive: true, tenantId, departmentId: null, orgUnitId: null },
      order: [["code", "ASC"]]
    });
  }

  const department = await Department.findOne({ where: { id: departmentId, tenantId }, attributes: ["orgUnitId"] });

  return DocumentType.findAll({
    where: {
      isActive: true,
      tenantId,
      [Op.or]: [
        { departmentId: null, orgUnitId: null }, // Tenant-wide global
        { departmentId }, // Department-specific
        ...(department?.orgUnitId ? [{ orgUnitId: department.orgUnitId }] : []), // Org-unit-wide
      ]
    },
    order: [["code", "ASC"]]
  });
}

export async function createDocumentType(input: unknown, requesterId: string, tenantId: string) {
  const data = documentTypeSchema.parse(input);
  const code = data.code.toUpperCase();
  assertValidScope(data.departmentId, data.orgUnitId);
  await assertScopeTargetsInTenant(tenantId, data.departmentId, data.orgUnitId);
  await assertValidRetentionClass(data.defaultRetentionClass);

  // Pre-check for a clean 409 instead of letting the DB's
  // document_types_tenant_id_code_key unique constraint surface as an
  // unhandled 500 — same pattern as departments.service.ts's duplicate-code
  // check.
  const duplicate = await DocumentType.findOne({ where: { tenantId, code } });
  if (duplicate) {
    throw new AppError(409, "ERR-DOCTYPE-CODE-EXISTS", `A document type with code "${code}" already exists`);
  }

  const requiresSignature = data.requiresSignature ?? false;
  let row: DocumentType;
  try {
    row = await DocumentType.create({
      ...data,
      code,
      departmentId: data.departmentId ?? null, // Phase 3: NULL = global
      orgUnitId: data.orgUnitId ?? null,
      requiresSignature,
      signingPolicy: requiresSignature ? "ceremony" : "none",
      isActive: data.isActive ?? true,
      tenantId
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new AppError(409, "ERR-DOCTYPE-CODE-EXISTS", `A document type with code "${code}" already exists`);
    }
    throw err;
  }
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_TYPE_CREATED,
    userId: requesterId,
    actionDetails: { docTypeId: row.id, code: row.code, name: row.name, departmentId: row.departmentId, orgUnitId: row.orgUnitId },
  });
  return row;
}

export async function updateDocumentType(id: string, input: unknown, requesterId: string, tenantId: string) {
  const data = documentTypeSchema.partial().parse(input);
  const row = await DocumentType.findOne({ where: { id, tenantId } });
  if (!row) throw new AppError(404, 'ERR-DOCTYPE-NOT-FOUND', 'Document type not found');

  const code = data.code?.toUpperCase();
  if (code) {
    const duplicate = await DocumentType.findOne({ where: { tenantId, code, id: { [Op.ne]: id } } });
    if (duplicate) {
      throw new AppError(409, "ERR-DOCTYPE-CODE-EXISTS", `A document type with code "${code}" already exists`);
    }
  }
  if (data.defaultRetentionClass) {
    await assertValidRetentionClass(data.defaultRetentionClass);
  }

  // Validate the *effective* post-update scope, not just whichever of the
  // two fields this particular patch happened to touch — a patch that only
  // sends orgUnitId (leaving departmentId untouched) must still be rejected
  // if the row already has a departmentId, or vice versa.
  const nextDepartmentId = data.departmentId !== undefined ? data.departmentId : row.departmentId;
  const nextOrgUnitId = data.orgUnitId !== undefined ? data.orgUnitId : row.orgUnitId;
  assertValidScope(nextDepartmentId, nextOrgUnitId);
  await assertScopeTargetsInTenant(tenantId, data.departmentId, data.orgUnitId);

  // Same "effective final state" pattern as the scope check above —
  // signingPolicy is derived from requiresSignature's effective value (the
  // patch's own value if it touched the field, else whatever the row already
  // had), not just from whatever this particular patch happened to send.
  const nextRequiresSignature = data.requiresSignature !== undefined ? data.requiresSignature : row.requiresSignature;

  let updated: DocumentType;
  try {
    updated = await row.update({ ...data, code, signingPolicy: nextRequiresSignature ? "ceremony" : "none" });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new AppError(409, "ERR-DOCTYPE-CODE-EXISTS", `A document type with code "${code}" already exists`);
    }
    throw err;
  }
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_TYPE_UPDATED,
    userId: requesterId,
    actionDetails: { docTypeId: id, updates: data },
  });
  return updated;
}

export async function getDocumentType(id: string, tenantId: string) {
  const docType = await DocumentType.findOne({ where: { id, tenantId } });
  if (!docType) throw new AppError(404, 'ERR-DOCTYPE-NOT-FOUND', 'Document type not found');
  return docType;
}

export async function deactivateDocumentType(id: string, requesterId: string, tenantId: string) {
  const docType = await DocumentType.findOne({ where: { id, tenantId } });
  if (!docType) throw new AppError(404, 'ERR-DOCTYPE-NOT-FOUND', 'Document type not found');

  // ARCHIVED documents are finished records and do not block deactivation (the same rule as
  // departments, assertDepartmentDeactivatable): the type only stops being offered for new documents.
  const activeDocCount = await Document.count({
    where: {
      documentTypeId: id,
      tenantId,
      deletedAt: null,
      status: { [Op.notIn]: ['CANCELLED', 'DISPOSED', 'ARCHIVED'] }
    }
  });
  if (activeDocCount > 0)
    throw new AppError(409, 'ERR-DOCTYPE-IN-USE',
      `Cannot deactivate: ${activeDocCount} document(s) use this type`);

  await docType.update({ isActive: false });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_TYPE_DEACTIVATED,
    userId: requesterId,
    actionDetails: { docTypeId: id, code: docType.code }
  });
  return docType;
}
