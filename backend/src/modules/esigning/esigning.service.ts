/**
 * E-signing service.
 *
 * Two surfaces share one signing engine:
 *   Surface 1 — freeform: sender drops field markers on a PDF page; coords are
 *     normalized to PDF point-space (72pt/inch) on click capture.
 *   Surface 2 — forms: field positions already resolved from Phase 7 (B1);
 *     skip placement, go straight to recipient assignment.
 *
 * Cryptographic note:
 *   The existing signing.service.ts (Phase 2 of old sessions) produces a
 *   detached DMS-only PKI record (CA keypair in documentCrypto.ts).  For
 *   third-party-verifiable PAdES-embedded signatures, upgrade path is:
 *     1. Load the signer's PKCS#12 cert (stored in Vault).
 *     2. Use pdf-lib + a PAdES-compatible signature handler to embed the
 *        byte-range signature into the PDF.
 *     3. Optionally add an RFC-3161 timestamp via a TSA endpoint.
 *   This service wires the workflow (request → recipients sign → complete)
 *   and calls the existing verifySigning() for now.  PAdES upgrade is flagged
 *   as a production TODO at the completion step.
 *
 * All events (view/invite/sign/decline) write to the hash-chained audit log.
 */

import { classificationLabel } from '../../shared/classifiedAccess.js';
import { isHiddenUser, withoutHiddenIds } from '../../shared/platformAdmin.js';
import crypto from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import {
  SignatureRequest, SignatureRecipient, SignatureField, Document, DocumentVersion, DocumentDek,
  OutboxEvent, AuditStageReview, User, UserTenant, UserRole, Role, UserDepartment,
  Department, DocumentType, DocumentMetadata, FolderNode, RetentionPolicy, Tenant, Letter,
  ApprovalChain, ApprovalStep, AuditLog,
} from '../../infrastructure/database/index.js';
import { finalizeLetterAfterSigning, notifyExecutivesOfLetter } from '../letters/letters.service.js';
import { withWorkerTenantContext } from '../../shared/workerTenantContext.js';
import { encryptAndStore, fetchAndDecrypt } from '../documents/documentCrypto.js';
import { validateTransition } from '../documents/DocumentStateMachine.js';
import { padesConfigured, generatePadesSignedPdf, generateFlattenedUnsignedPdf, PADES_CHANGE_SUMMARY, FLATTENED_CHANGE_SUMMARY } from './esignPades.js';
import { AppError } from '../../core/AppError.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { enqueueWebsocketEvent } from '../../infrastructure/queue/outbox.js';
import { invalidateResourceACL } from '../../infrastructure/cache/aclCache.js';
import { assertACLAllow, resolveACL } from '../../shared/resolveACL.js';
import { departmentCodeNotRegistered } from '../../shared/departmentCodeError.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { getResolvedRolePermissions } from '../roles/roles.service.js';
import { resolveRoleUserIds } from '../../shared/assignmentAdvisory.js';
import { fanOut } from '../notifications/notifications.service.js';
import type { AuthenticatedUser } from '../../shared/auth.js';
import { logger } from '../../core/logger.js';
import { config } from '../../config/env.js';
import { runInTransaction } from '../../shared/transaction.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import { validateUploadedFile } from '../documents/mimeValidation.js';
import { sha256 } from '../documents/documentValidation.js';
import { sanitizeFilename } from '../../shared/sanitizeFilename.js';
import { reserveStorageQuota } from '../documents/quotaService.js';
import { applyRetention } from '../retention/retentionEngine.js';
import { grantDefaultDocumentAcl, nextDocumentName, ensureCanCreate } from '../documents/documents.service.js';
import { EXTERNAL_TOKEN_TTL_MS, mintAccessToken, accessTokenMatches } from './esignTokens.js';
import { emitCeremonyEnded, hasCeremonyEndedHandlers } from './esigning.events.js';

// ── Access-token helpers (external signers, E24) ─────────────────────────────
//
// Only the SHA-256 of an external signer's token is stored (see esignTokens.ts).
// The raw token is minted at SEND and again at every REMINDER (a reminder rotates
// it: the earlier link stops working), and exists only in the emailed link.

export { EXTERNAL_TOKEN_TTL_MS };

/** Request statuses in which a ceremony is live (signable / declinable / voidable by a signer). */
const LIVE_REQUEST_STATUSES = ['sent', 'partially_signed'];

/** The caller's network identity, recorded on the audit trail of every ceremony action. */
export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

function metaDetails(meta?: RequestMeta): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta?.ip) out.ipAddress = meta.ip;
  // A user agent is attacker-controlled free text: bound it before it is hash-chained forever.
  if (meta?.userAgent) out.userAgent = meta.userAgent.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
  return out;
}

/** The recipient's stored token digest (the model getter is deliberately blank so no
 *  serialised response can carry it; the raw column is only reachable via getDataValue).
 *  Plain objects (tests) fall back to the property. */
export function recipientTokenHash(r: SignatureRecipient): string | null {
  const raw = typeof (r as any).getDataValue === 'function'
    ? (r as any).getDataValue('accessTokenHash')
    : (r as any).accessTokenHash;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Legacy plaintext token of a row written before the hash column existed (read-only bridge,
 *  always null once migration 20261004000021 has run). */
function recipientLegacyToken(r: SignatureRecipient): string | null {
  const raw = typeof (r as any).getDataValue === 'function'
    ? (r as any).getDataValue('accessToken')
    : (r as any).accessToken;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Constant-time check of a presented token against a recipient's stored digest. */
export function tokenMatchesRecipient(presented: string | undefined | null, r: SignatureRecipient): boolean {
  return accessTokenMatches(presented, { hash: recipientTokenHash(r), legacyPlaintext: recipientLegacyToken(r) });
}

/** One audit row per (recipient, address, action) per minute for unauthenticated token
 *  traffic: enough evidence, not an audit-log flood for anyone holding a link. */
const tokenAuditSeen = new Map<string, number>();
const TOKEN_AUDIT_WINDOW_MS = 60_000;
function shouldAuditTokenEvent(key: string): boolean {
  const now = Date.now();
  if (tokenAuditSeen.size > 5_000) {
    for (const [k, t] of tokenAuditSeen) if (now - t > TOKEN_AUDIT_WINDOW_MS) tokenAuditSeen.delete(k);
    if (tokenAuditSeen.size > 5_000) tokenAuditSeen.clear();
  }
  const last = tokenAuditSeen.get(key);
  if (last !== undefined && now - last < TOKEN_AUDIT_WINDOW_MS) return false;
  tokenAuditSeen.set(key, now);
  return true;
}

/** What an external-token check needs to leave an audit trail (E26). */
interface TokenAuditContext {
  requestId: string;
  documentId: string | null;
  tenantId: string | null;
  attempt: 'sign' | 'decline' | 'view' | 'document';
  meta?: RequestMeta;
}

async function auditTokenRejection(recipient: SignatureRecipient, reason: 'invalid' | 'expired', ctx: TokenAuditContext): Promise<void> {
  if (!shouldAuditTokenEvent(`reject|${recipient.id}|${ctx.meta?.ip ?? ''}`)) return;
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: ctx.documentId,
    tenantId: ctx.tenantId,
    userId: null,
    isSuccess: false,
    errorCode: 'ERR-FORBIDDEN',
    actionDetails: {
      action: 'signature_token_rejected',
      requestId: ctx.requestId,
      recipientId: recipient.id,
      attempt: ctx.attempt,
      reason,
      ...metaDetails(ctx.meta),
    },
  }).catch((err) => logger.warn({ err }, 'failed to audit a rejected signing token'));
}

/** Validates an external signer's token (match + not expired). Same 403 wording as before;
 *  a refusal is audited (E26). */
async function assertExternalToken(
  recipient: SignatureRecipient,
  accessToken: string | undefined,
  ctx: TokenAuditContext,
): Promise<void> {
  if (!tokenMatchesRecipient(accessToken, recipient)) {
    await auditTokenRejection(recipient, 'invalid', ctx);
    throw new AppError(403, 'ERR-FORBIDDEN', 'Invalid or expired signing token');
  }
  if (recipient.accessTokenExpires && recipient.accessTokenExpires < new Date()) {
    await auditTokenRejection(recipient, 'expired', ctx);
    throw new AppError(403, 'ERR-FORBIDDEN', 'Signing token has expired');
  }
}

/** Active users holding `roleName` who may claim a role-based signature
 *  recipient for `document` — department-scoped to the document's own
 *  department, unless the role itself holds DOCUMENT_READ_ALL (blanket
 *  tenant-wide access), mirroring letters.service.ts's assertStepIsActionable
 *  bypass for LETTER_READ_ALL role steps. */
async function resolveSigningRoleHolders(
  roleName: string,
  tenantId: string,
  documentDepartmentId: string | null,
): Promise<string[]> {
  // Resolved per-tenant (role_permissions, static ROLE_PERMISSIONS map as
  // fallback) rather than from the static map alone — same coherence rule the
  // letters/approvals submit-time validators follow, so a tenant that granted
  // document:read_all to a custom role gets the same blanket-access bypass
  // here that its holders already get at read time.
  const rolePerms = await getResolvedRolePermissions(roleName, tenantId);
  const deptScoped = documentDepartmentId && !rolePerms.includes(PERMISSIONS.DOCUMENT_READ_ALL);
  return resolveRoleUserIds(roleName, tenantId, deptScoped ? documentDepartmentId : null);
}

// ── Assignable signers (recipient picker) ──────────────────────────────────────
/**
 * Candidate signers for the "new signature request" recipient picker.
 *
 * Before this existed, the picker had no data source at all: recipients were
 * free-text name/email inputs, so an internal signer only became internal when
 * the sender happened to hand-type an email that exactly matched an active user
 * (see the dmsUserId auto-resolution in createSignatureRequest below). This
 * gives the UI a real, searchable list and lets it set dmsUserId directly.
 *
 * Gated at the route by SIGNING_MANAGE — the same permission that creates a
 * request — NOT USER_MANAGE. This mirrors the approvals module's assignable-users
 * picker (H4): a signing manager without user-admin rights still gets a populated
 * picker instead of an empty/403 one. Scoped to the actor's tenant via
 * user_tenants so it never leaks names from other tenants. Search matches first
 * name, last name, OR email (case-insensitive). Each result also carries the
 * user's primary role name, purely as display context in the picker.
 *
 * `filters.departmentId`/`filters.roleId` narrow the candidate set BEFORE the
 * name/email search — same id-based convention as GET /users' roleId/
 * departmentId params (features/users/hooks.ts useUsersList). Department
 * membership is the many-to-many User<->Department join (user_departments,
 * see infrastructure/database/models/UserDepartment.ts + associations.ts),
 * not a single-valued column on User — a user can belong to more than one
 * department. Role membership reuses the same UserRole rows the primary-role
 * lookup below already resolves display names from.
 */
export async function listSigningAssignableUsers(
  user: AuthenticatedUser,
  q?: string,
  limit = 25,
  filters?: { departmentId?: string; roleId?: string },
): Promise<Array<{ id: string; firstName: string; lastName: string; email: string; role: string | null; departments: Array<{ id: string; name: string; code: string }> }>> {
  const memberships = await UserTenant.findAll({
    where: { tenantId: user.tenantId },
    attributes: ['userId'],
    raw: true,
  });
  let candidateIds = await withoutHiddenIds([...new Set(memberships.map((m) => m.userId))], user.userId);
  if (candidateIds.length === 0) return [];

  if (filters?.departmentId) {
    const deptRows = await UserDepartment.findAll({
      where: { departmentId: filters.departmentId, userId: { [Op.in]: candidateIds } },
      attributes: ['userId'],
      raw: true,
    });
    candidateIds = [...new Set(deptRows.map((r) => r.userId))];
    if (candidateIds.length === 0) return [];
  }
  if (filters?.roleId) {
    const roleRows = await UserRole.findAll({
      where: { roleId: filters.roleId, userId: { [Op.in]: candidateIds } },
      attributes: ['userId'],
      raw: true,
    });
    candidateIds = [...new Set(roleRows.map((r) => r.userId))];
    if (candidateIds.length === 0) return [];
  }

  const where: any = { id: { [Op.in]: candidateIds }, isActive: true, deletedAt: null };
  const term = q?.trim();
  if (term) {
    where[Op.or] = [
      { firstName: { [Op.iLike]: `%${term}%` } },
      { lastName: { [Op.iLike]: `%${term}%` } },
      { email: { [Op.iLike]: `%${term}%` } },
    ];
  }

  const users = await User.findAll({
    where,
    attributes: ['id', 'firstName', 'lastName', 'email'],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
    limit: Math.min(limit, 50),
    raw: true,
  });
  if (users.length === 0) return [];

  // Primary role name per user, resolved in bulk (two small queries, no
  // association-alias assumptions) purely for display context in the picker.
  const userRoleRows = await UserRole.findAll({
    where: { userId: { [Op.in]: users.map((u) => u.id) } },
    attributes: ['userId', 'roleId'],
    raw: true,
  });
  const roleIds = [...new Set(userRoleRows.map((r) => r.roleId))];
  const roles = roleIds.length
    ? await Role.findAll({ where: { id: { [Op.in]: roleIds } }, attributes: ['id', 'name'], raw: true })
    : [];
  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
  const primaryRoleByUser = new Map<string, string>();
  for (const r of userRoleRows) {
    if (!primaryRoleByUser.has(r.userId)) primaryRoleByUser.set(r.userId, roleNameById.get(r.roleId) ?? '');
  }

  // Departments per user, same "two small queries" pattern as the role
  // lookup above — for the picker's cross-department warning.
  const userDeptRows = await UserDepartment.findAll({
    where: { userId: { [Op.in]: users.map((u) => u.id) } },
    attributes: ['userId', 'departmentId'],
    raw: true,
  });
  const deptIds = [...new Set(userDeptRows.map((r) => r.departmentId))];
  const depts = deptIds.length
    ? await Department.findAll({ where: { id: { [Op.in]: deptIds } }, attributes: ['id', 'name', 'code'], raw: true })
    : [];
  const deptById = new Map(depts.map((d) => [d.id, d]));
  const deptsByUser = new Map<string, Array<{ id: string; name: string; code: string }>>();
  for (const r of userDeptRows) {
    const dept = deptById.get(r.departmentId);
    if (!dept) continue;
    const list = deptsByUser.get(r.userId) ?? [];
    list.push({ id: dept.id, name: dept.name, code: dept.code });
    deptsByUser.set(r.userId, list);
  }

  return users.map((u) => ({
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    role: primaryRoleByUser.get(u.id) || null,
    departments: deptsByUser.get(u.id) ?? [],
  }));
}

// ── Direct upload-and-sign (file a document, then hand back its id) ────────

/**
 * Files a locally-picked file as a first-class Document — the same encryption
 * pipeline, transaction shape, and outbox events as documents.service.ts's
 * createDocument()/forms.service.ts's createFormInstance() — but with
 * department/documentType/folder all OPTIONAL. This backs the e-signing
 * page's "upload a new document to sign" path, where asking the user to first
 * classify a document they only want signed is unnecessary friction: an
 * omitted department/type falls back to the tenant's fixed UNCAT/SIGN-UNCAT
 * bucket (seeded per-tenant — see migrations/20260728000001-tenant-system-
 * defaults.sql and tenants.service.ts's createTenant()) instead of erroring
 * the way createDocument's ERR-DEPT-INVALID/ERR-DOCTYPE-INVALID do.
 *
 * Returns the new document's id so the caller can immediately continue into
 * createSignatureRequest(documentId, ...) exactly as if the document had been
 * picked from the existing document-search picker.
 */
export async function uploadAndFileDocumentForSigning(
  file: Express.Multer.File | undefined,
  data: { departmentId?: string; departmentCode?: string; documentTypeCode?: string; folderPath?: string; title?: string },
  user: AuthenticatedUser,
): Promise<{ documentId: string; documentName: string; warnings: string[]; duplicateOf: string | null }> {
  if (!file) throw new AppError(422, 'ERR-FILE-MISSING', 'A file to sign is required');

  // Same byte-sniffing/extension-blocking + AV scan as the main upload path
  // (documents.service.ts createDocument) — this endpoint must not become a
  // softer upload path just because its metadata is optional.
  await validateUploadedFile(file.buffer, file.originalname);
  const avScanStatus = await scanBuffer(file.buffer);

  // departmentId is the precise, collision-free field (same fix as
  // documents.service.ts's createDocument) — department codes are only
  // unique per (tenant, org unit), so resolving by code alone could silently
  // pick the WRONG same-coded department in a different org unit than the
  // one the caller actually belongs to.
  const department = data.departmentId
    ? await Department.findOne({ where: { id: data.departmentId, tenantId: user.tenantId } })
    : data.departmentCode
      ? await Department.findOne({ where: { tenantId: user.tenantId, code: data.departmentCode.toUpperCase() } })
      : await Department.findOne({ where: { tenantId: user.tenantId, code: 'UNCAT' } });
  if (!department) {
    // A missing UNCAT fallback is a per-tenant seeding fault, not a client
    // mistake — there is no submitted code to name, so it keeps its own
    // message. A submitted id/code that matched nothing gets named (when
    // there is one to name).
    if (!data.departmentId && !data.departmentCode) {
      throw new AppError(
        422,
        'ERR-DEPT-INVALID',
        'Uncategorized fallback department is not seeded for this tenant',
      );
    }
    if (data.departmentId) {
      throw new AppError(422, 'ERR-DEPT-INVALID', 'Selected department was not found in your organization');
    }
    throw await departmentCodeNotRegistered(data.departmentCode, user, {
      route: 'POST /signing/uploads',
      lookedUpAs: data.departmentCode!.toUpperCase(),
    });
  }
  // FIX: this endpoint (the signing page's "upload a new document to sign"
  // tab) had NO department-membership check at all — data.departmentCode is
  // client-supplied, so anyone could file a document into any department,
  // including one they have no business in. documents.service.ts's
  // createDocument has (now-fixed) department scoping via ensureCanCreate;
  // this path skipped it entirely rather than inheriting the bug, which is
  // arguably worse. The UNCAT fallback (no department given) is always
  // allowed — every tenant member can file into the shared uncategorized
  // bucket, same as before.
  if (data.departmentId || data.departmentCode) {
    await ensureCanCreate(user, department.id);
  }

  const documentType = data.documentTypeCode
    ? await DocumentType.findOne({ where: { tenantId: user.tenantId, code: data.documentTypeCode.toUpperCase() } })
    : await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'SIGN-UNCAT' } });
  if (!documentType) {
    throw new AppError(
      422,
      'ERR-DOCTYPE-INVALID',
      data.documentTypeCode ? 'Document type code is not registered' : 'Uncategorized signed-document type is not seeded for this tenant',
    );
  }

  let folderId: string | null = null;
  if (data.folderPath) {
    const folder = await FolderNode.findOne({
      where: { path: data.folderPath, tenantId: user.tenantId, isActive: true },
    });
    if (!folder) throw new AppError(422, 'ERR-FOLDER-INVALID', 'Selected folder path is not valid for this tenant');
    if (folder.departmentId && folder.departmentId !== department.id) {
      throw new AppError(
        422,
        'ERR-FOLDER-DEPARTMENT-MISMATCH',
        `Folder belongs to a different department. Folder department: ${folder.departmentId}, Document department: ${department.id}`,
      );
    }
    folderId = folder.id;
  }

  const retentionPolicy = await RetentionPolicy.findOne({ where: { code: documentType.defaultRetentionClass } });
  if (!retentionPolicy) {
    throw new AppError(500, 'ERR-RETENTION-CONFIG', `Document type ${documentType.code}'s default retention class is not registered`);
  }

  const hash = sha256(file.buffer); // Plaintext hash for duplicate detection — same field/query as createDocument.
  const duplicate = await DocumentVersion.findOne({
    attributes: ['documentId'],
    where: { plaintextSha256: hash },
    include: [
      {
        model: Document,
        required: true,
        attributes: [],
        where: {
          deletedAt: { [Op.is]: null },
          status: { [Op.notIn]: ['DISPOSED', 'CANCELLED'] },
          tenantId: user.tenantId,
        },
      },
    ],
  });

  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
  const storageKey = `${user.tenantId}/${department.code}/${documentType.code}/${documentId}/${versionId}/${sanitizeFilename(file.originalname)}`;

  // Encryption I/O happens outside the DB transaction, same convention as
  // createDocument/createFormInstance.
  const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
    storageKey, file.buffer, file.mimetype, department.id, user.tenantId,
  );

  const documentName = await runInTransaction(async (tx) => {
    await reserveStorageQuota(user.tenantId, file.size, tx);
    const name = await nextDocumentName(tx, department.code, documentType.code);

    await Document.create(
      {
        id: documentId,
        tenantId: user.tenantId,
        documentName: name,
        title: (data.title?.trim() || file.originalname).slice(0, 255),
        departmentId: department.id,
        documentTypeId: documentType.id,
        folderId,
        ownerId: user.userId,
        organisationUnit: department.code,
        // Uploaded specifically to be signed (not through the approval-chain
        // upload path), so it skips the normal DRAFT holding state and is
        // live/visible immediately — DRAFT->ACTIVE is a graph-valid edge on
        // DocumentStateMachine for exactly this "publish directly" case (see
        // publishDraft). approvalStatus still separately tracks the signature
        // itself via requiresSignature, independent of this document-level status.
        status: 'ACTIVE',
        approvalStatus: documentType.requiresSignature ? 'PENDING' : 'NOT_REQUIRED',
        securityClassification: 'INTERNAL',
        sensitivityLabel: classificationLabel('INTERNAL'),
        retentionClass: retentionPolicy.code,
        documentDate: new Date(),
        retentionTriggerDate: new Date(),
        disposalEligibleDate: null,
        latestVersionId: null,
        // A human picked this exact file from their machine — the same act as
        // the main Upload page, just entered from the signing page instead of
        // re-navigating there first. MANUAL_UPLOAD (not CREATED_IN_SYSTEM,
        // which forms.service.ts reserves for system-generated PDFs) is the
        // accurate fit from documents.service.ts's source enum.
        source: 'MANUAL_UPLOAD',
        archivedAt: null,
        ocrStatus: 'PENDING',
        ocrConfidenceScore: null,
        aiSummary: null,
        aiSuggestedMetadata: null,
        deletedAt: null,
      } as any,
      { transaction: tx },
    );
    await DocumentMetadata.create(
      { documentId, keywords: null, description: null, language: null, originatingSystem: null, confidentialityNotice: null, geographicScope: null, externalReference: null },
      { transaction: tx },
    );
    const version = await DocumentVersion.create(
      {
        id: versionId,
        documentId,
        versionNumber: '1.0',
        isMajorVersion: true,
        storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        sha256Hash: encHash,
        plaintextSha256: hash,
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'Uploaded for e-signing',
        avScanStatus,
      } as any,
      { transaction: tx },
    );
    await Document.update({ latestVersionId: version.id }, { where: { id: documentId }, transaction: tx });
    await DocumentDek.create(
      { documentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
      { transaction: tx },
    );
    await OutboxEvent.bulkCreate(
      [
        { documentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId, tenantId: user.tenantId, departmentId: department.id }) },
        { documentId, type: 'OCR_PROCESSING', channel: 'OCR', payload: JSON.stringify({ documentId, versionId, tenantId: user.tenantId }) },
        { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
      ],
      { transaction: tx },
    );
    await applyRetention(documentId, tx);
    await grantDefaultDocumentAcl(documentId, user.userId, user.tenantId, department.id, tx);
    return name;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_CREATE,
    documentId,
    userId: user.userId,
    userRole: user.role,
    actionDetails: {
      action: 'document_uploaded_for_signing',
      documentId,
      documentName,
      departmentCode: department.code,
      documentTypeCode: documentType.code,
      usedFallbackDepartment: !data.departmentCode,
      usedFallbackDocumentType: !data.documentTypeCode,
      duplicateOf: duplicate?.documentId ?? null,
    },
  });

  if (avScanStatus === 'unscanned') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
      documentId,
      userId: user.userId,
      userRole: user.role,
      actionDetails: { versionId, reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
    });
  }

  return {
    documentId,
    documentName,
    warnings: [
      ...(duplicate ? ['WARN-DUPLICATE-DETECTED'] : []),
      ...(avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : []),
    ],
    duplicateOf: duplicate?.documentId ?? null,
  };
}

// ── Request creation ─────────────────────────────────────────────────────────

export async function createSignatureRequest(
  documentId: string,
  data: {
    source?: 'freeform' | 'form_instance';
    orderingMode?: 'parallel' | 'serial';
    completionAction?: 'none' | 'move_folder' | 'notify_only';
    completionTargetFolderId?: string | null;
    expiresAt?: string | null;
    // `assignedRole`: an alternative to `dmsUserId` for an internal
    // recipient with no specific person picked yet — department-scoped to
    // this document (mirrors letters' role-assigned approval steps).
    // Claimed by whichever qualified holder signs first (signDocument).
    recipients: Array<{ name: string; email: string; dmsUserId?: string; assignedRole?: string; orderIndex?: number }>;
    fields: Array<{ recipientIndex: number; pageNumber: number; x: number; y: number; width: number; height: number; fieldType: string }>;
  },
  user: AuthenticatedUser,
  meta?: RequestMeta,
): Promise<SignatureRequest> {
  const doc = await Document.findOne({ where: { id: documentId, tenantId: user.tenantId } });
  if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');

  // E25: starting a ceremony is a write-grade act on the document. signing:manage plus a plain
  // document:read ACL (which every department colleague holds) is not enough.
  await assertMayStartCeremony(doc, user);

  // E23: the version the fields are placed on is the version that gets signed.
  if (!doc.latestVersionId) {
    throw new AppError(409, 'ERR-DOCUMENT-NOT-SIGNABLE', 'This document has no filed version yet, so there is nothing to sign.');
  }

  if (!Array.isArray(data.recipients) || data.recipients.length === 0) {
    throw new AppError(422, 'ERR-RECIPIENT-INVALID', 'At least one recipient is required');
  }

  for (const r of data.recipients) {
    if (r.dmsUserId && r.assignedRole) {
      throw new AppError(422, 'ERR-RECIPIENT-INVALID', 'A recipient cannot have both dmsUserId and assignedRole');
    }
    // FIX (2026-09-03): an external recipient (neither dmsUserId nor
    // assignedRole) with a missing email used to reach the email-based
    // auto-resolution below and throw on `r.email.toLowerCase()` — a 500 for
    // what is plainly a 422. The UI already refuses to submit such a row; the
    // API accepted it. `signature_recipients.email` is NOT NULL, so a blank
    // one would also have been persisted as an unusable empty string.
    if (!r.dmsUserId && !r.assignedRole && (!r.name?.trim() || !r.email?.trim())) {
      throw new AppError(422, 'ERR-RECIPIENT-INVALID', 'An external recipient needs both a name and an email address');
    }
    // A named internal signer must be a live member of THIS tenant, and must not be
    // the hidden platform administrator. dmsUserId was trusted verbatim before: a
    // user id from another tenant became a recipient able to sign here, and naming
    // the platform admin's id succeeded (a probe that distinguished it from an
    // unknown id). Every refusal below carries the same message on purpose.
    if (r.dmsUserId && r.dmsUserId !== user.userId) {
      const member = await UserTenant.findOne({ where: { userId: r.dmsUserId, tenantId: user.tenantId }, attributes: ['userId'] });
      const target = member
        ? await User.findOne({ where: { id: r.dmsUserId, isActive: true, deletedAt: null }, attributes: ['id'] })
        : null;
      if (!member || !target || (await isHiddenUser(r.dmsUserId, user.userId))) {
        throw new AppError(422, 'ERR-RECIPIENT-INVALID', 'The selected signer was not found in your organization');
      }
    }
    if (r.assignedRole) {
      const holders = await resolveSigningRoleHolders(r.assignedRole, user.tenantId, doc.departmentId ?? null);
      if (holders.length === 0) {
        throw new AppError(
          422,
          'ERR-RECIPIENT-ROLE-UNSTAFFED',
          doc.departmentId
            ? `No active user holding role ${r.assignedRole} is a member of this document's department`
            : `No active user holds role ${r.assignedRole} in this tenant`,
        );
      }
    }
  }

  // A field whose recipientIndex points past the recipient list used to be
  // silently re-assigned to recipient 0 (`?? recipients[0].id` below), handing
  // the first signer a field nobody meant for them. Refuse instead.
  if (data.fields.some((f) => !Number.isInteger(f.recipientIndex) || f.recipientIndex < 0 || f.recipientIndex >= data.recipients.length)) {
    throw new AppError(422, 'ERR-FIELD-INVALID', 'A signature field refers to a recipient that is not on this request');
  }

  // A request that is already expired the moment it is created could never be
  // signed (signDocument flips it to 'expired' on first touch).
  if (data.expiresAt && !(new Date(data.expiresAt).getTime() > Date.now())) {
    throw new AppError(422, 'ERR-EXPIRY-INVALID', 'The expiry time must be in the future');
  }

  // completionTargetFolderId is client-supplied and, on completion, is written
  // straight into documents.folder_id — validate it belongs to THIS tenant, or a
  // request could move a finished document into another tenant's folder tree.
  if (data.completionTargetFolderId) {
    const target = await FolderNode.findOne({
      where: { id: data.completionTargetFolderId, tenantId: user.tenantId, isActive: true },
      attributes: ['id'],
    });
    if (!target) throw new AppError(422, 'ERR-FOLDER-INVALID', 'The completion target folder was not found in your organization');
  }

  // The document-state guard belongs here, not just at send time: sendSignatureRequest
  // (below) refuses to transition into PENDING_SIGNATURE from anything but APPROVED/
  // ACTIVE/SIGNING_DECLINED (DocumentStateMachine.ts), so a request created against a
  // document in any other status — e.g. still DRAFT, or already ARCHIVED — could be
  // built in full (recipients, fields, everything) and then silently could never be
  // sent. Reject it up front with an actionable message instead of letting it become a
  // dead-on-arrival draft. ACTIVE is included because that's the normal state of an
  // already-published/live document (APPROVED -> ACTIVE is a routine "publish" step —
  // see DocumentStateMachine.ts), so a doc doesn't stop being signable just because it
  // was published before anyone got around to sending it for signature.
  const SIGNABLE_DOCUMENT_STATUSES = new Set(['APPROVED', 'ACTIVE', 'SIGNING_DECLINED', 'PENDING_SIGNATURE']);
  if (!SIGNABLE_DOCUMENT_STATUSES.has(doc.status)) {
    throw new AppError(
      409,
      'ERR-DOCUMENT-NOT-SIGNABLE',
      `Document is ${doc.status} — it must be Approved before a signature request can be created. Submit it for approval first.`,
    );
  }

  // M12: internal signers must be created WITH an dmsUserId, otherwise they are
  // treated as external (access-token) recipients and can never sign in-app (the
  // internal sign path 403s them). The UI often omits it, so resolve it here: any
  // recipient whose email matches an active user in this tenant becomes internal.
  const resolvedRecipients = await Promise.all(
    data.recipients.map(async (r) => {
      if (r.dmsUserId || r.assignedRole) return r;
      const match = await User.findOne({
        where: { email: r.email.toLowerCase(), isActive: true, deletedAt: null },
        attributes: ['id'],
      });
      if (!match) return r;
      // The hidden platform admin never becomes a recipient by email match; the
      // row stays an ordinary external recipient, exactly as an unknown address does.
      if (await isHiddenUser(match.id, user.userId)) return r;
      const member = await UserTenant.findOne({ where: { userId: match.id, tenantId: user.tenantId }, attributes: ['userId'] });
      return member ? { ...r, dmsUserId: match.id } : r;
    }),
  );
  data = { ...data, recipients: resolvedRecipients };

  const request = await SignatureRequest.create({
    documentId,
    source: data.source ?? 'freeform',
    orderingMode: data.orderingMode ?? 'parallel',
    status: 'draft',
    completionAction: data.completionAction ?? 'none',
    completionTargetFolderId: data.completionTargetFolderId ?? null,
    expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    createdBy: user.userId,
    completedAt: null,
    documentVersionId: doc.latestVersionId,
  });

  const recipients = await SignatureRecipient.bulkCreate(
    data.recipients.map((r, i) => ({
      signatureRequestId: request.id,
      orderIndex: r.orderIndex ?? i,
      // A role-based recipient has no real person yet — name/email are a
      // clearly-synthetic placeholder (email NOT NULL at the DB level), both
      // fully overwritten with the real claimer's identity in signDocument
      // once someone actually claims and signs. Never trust a caller-
      // supplied name/email for this case — always synthesize server-side.
      name: r.assignedRole ? `Role: ${r.assignedRole.replace(/_/g, ' ')} (unclaimed)` : r.name,
      email: r.assignedRole ? `role-${r.assignedRole.toLowerCase()}@unassigned.internal` : r.email,
      dmsUserId: r.dmsUserId ?? null,
      assignedRole: r.assignedRole ?? null,
      status: 'pending' as const,
      signedAt: null,
      declinedAt: null,
      declineReason: null,
      ipAddress: null,
      // E24: no token exists until the request is SENT. sendSignatureRequest mints it (external
      // recipients only; named and role-based recipients are internal and never get one), stores
      // only its SHA-256, and puts the raw value in the emailed link alone.
      accessToken: null,
      accessTokenHash: null,
      accessTokenExpires: null,
    })),
    { returning: true },
  );

  if (data.fields.length > 0) {
    await SignatureField.bulkCreate(
      data.fields.map((f) => ({
        signatureRequestId: request.id,
        recipientId: recipients[f.recipientIndex]?.id ?? recipients[0].id,
        pageNumber: f.pageNumber,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        fieldType: f.fieldType as 'signature' | 'initial' | 'date' | 'text' | 'seal',
        value: null,
        signedAt: null,
      })),
    );
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId,
    userId: user.userId,
    userRole: user.role,
    actionDetails: {
      action: 'signature_request_created',
      requestId: request.id,
      recipientCount: recipients.length,
      documentVersionId: doc.latestVersionId,
      ...metaDetails(meta),
    },
  });

  return request;
}

/**
 * Documentations/audits/AUDIT-FINDINGS-2026-07-26.md #8: signing had no realtime wiring at all
 * beyond sendSignatureRequest's own DOCUMENT.UPDATED emit (which the
 * frontend's signing pending/sent/completed lists never listen for — they're
 * keyed ['signing', ...], not ['document']). A second approver watching
 * "Pending" or a sender watching "Sent" saw no live update when a recipient
 * signed or declined until a remount or the 30s staleTime lapsed. Emits a
 * dedicated SIGNING.UPDATED type the frontend's EVENT_TYPE_TO_QUERY_KEYS maps
 * to the 'signing' query key family, in addition to whatever DOCUMENT.*
 * event (if any) the caller already emits for the same change.
 */
async function emitSigningUpdated(documentId: string, tenantId: string, change: string, recipientUserIds?: string[]) {
  try {
    const doc = await Document.findByPk(documentId, { attributes: ['departmentId'] });
    await enqueueWebsocketEvent('SIGNING.UPDATED', {
      documentId,
      change,
      departmentId: (doc as any)?.departmentId ?? null,
      tenantId,
      // FIX: the sender/recipients of a signature request are not
      // guaranteed to be members of the document's department (mirrors the
      // same gap found in APPROVAL_CHAIN.UPDATED) — department-only routing
      // silently missed them whenever they weren't. Reach them directly too.
      recipientUserIds: recipientUserIds?.length ? Array.from(new Set(recipientUserIds)) : undefined,
    });
  } catch (e) {
    logger.error({ e }, 'websocket enqueue failed');
  }
}

// ── Send (transition draft → sent, email access tokens) ────────────────────

export async function sendSignatureRequest(requestId: string, user: AuthenticatedUser, meta?: RequestMeta): Promise<SignatureRequest> {
  const request = await loadRequest(requestId, user);
  assertCanManageRequest(request, user);
  if (request.status !== 'draft') {
    throw new AppError(409, 'ERR-INVALID-STATE', 'Only draft requests can be sent');
  }
  // E23: the fields were placed on the pinned version; refuse to send once the document has moved on.
  assertPinnedVersionCurrent(request, (request as any).document);
  // A draft whose expiry passed while it sat unsent would go out already dead.
  if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
    throw new AppError(422, 'ERR-EXPIRY-INVALID', 'The expiry time of this request has already passed. Cancel it and create a new one.');
  }

  // One live ceremony per document. Two concurrent requests on the same document
  // could each "complete" it, filing two signed copies and double-advancing its
  // lifecycle; the second request's recipients would also still be able to sign
  // after the first had already archived the document.
  const otherLive = await SignatureRequest.findOne({
    where: { documentId: request.documentId, status: { [Op.in]: LIVE_REQUEST_STATUSES }, id: { [Op.ne]: request.id } },
    attributes: ['id'],
  });
  if (otherLive) {
    throw new AppError(409, 'ERR-SIGNING-IN-PROGRESS', 'This document already has a signature request in progress. Cancel it before sending another.');
  }

  const recipients = (request as any).recipients as SignatureRecipient[];
  const documentName = ((request as any).document as Document | undefined)?.documentName;

  // Status transition and the per-recipient invite emails are two effects of
  // the same domain action — write them in one transaction so a crash between
  // them can never leave a "sent" request whose external recipients were
  // never notified (or a queued email for a request that never actually sent).
  await runInTransaction(async (t) => {
    await request.update({ status: 'sent' }, { transaction: t });

    // M2: SIGNING_DECLINED was a dead-end (only exit CANCELLED) — the promised
    // restart to PENDING_SIGNATURE was never implemented. Sending a fresh
    // ceremony for a document parked in SIGNING_DECLINED re-arms the lifecycle so
    // completion/decline/expiry route it correctly again.
    //
    // Generalized beyond just the SIGNING_DECLINED restart: createSignatureRequest
    // accepts ANY existing document (not just ones the approval engine already
    // routed into PENDING_SIGNATURE via signingPolicy='ceremony') — e.g. the
    // document detail page's "Send for Signature" action on an APPROVED document.
    // Without this, sending a ceremony that way left Document.status showing
    // APPROVED while a real signature request was in flight. validateTransition
    // rejects sending one for a document that isn't actually in a signable state
    // (e.g. still DRAFT).
    const doc = await Document.findByPk(request.documentId, { transaction: t });
    if (doc && doc.status !== 'PENDING_SIGNATURE') {
      validateTransition(doc.status, 'PENDING_SIGNATURE');
      await doc.update({ status: 'PENDING_SIGNATURE' }, { transaction: t });
    }

    for (const recipient of recipients) {
      // Internal DMS users are notified in-app, not by access-token email —
      // a role-based recipient is internal too (just unclaimed), and would
      // otherwise fall through to this external-email branch and try to
      // email its non-routable placeholder address.
      if (recipient.dmsUserId || recipient.assignedRole) continue;
      // Re-arm the link's lifetime from the moment it is actually emailed (the
      // token was minted at draft time and may already be near/past expiry).
      // E24: mint the token now. Only its SHA-256 is stored; the raw value lives in the emailed link only.
      const minted = mintAccessToken();
      await recipient.update(
        { accessTokenHash: minted.hash, accessToken: null, accessTokenExpires: new Date(Date.now() + EXTERNAL_TOKEN_TTL_MS) },
        { transaction: t },
      );
      const base = config.CLIENT_URL.replace(/\/$/, '');
      const signUrl = `${base}/sign/${request.id}/${recipient.id}?token=${encodeURIComponent(minted.raw)}`;
      await OutboxEvent.create(
        {
          documentId: request.documentId,
          type: 'ESIGNING.RECIPIENT_INVITED',
          channel: 'EMAIL',
          payload: JSON.stringify({
            email: recipient.email,
            name: recipient.name,
            documentId: request.documentId,
            documentName: documentName ?? null,
            requestId: request.id,
            recipientId: recipient.id,
            signUrl,
          }),
        },
        { transaction: t },
      );
    }
  });

  // Emit realtime so document detail refreshes
  const doc = await Document.findByPk(request.documentId, { attributes: ['departmentId', 'tenantId'] });
  try {
    await enqueueWebsocketEvent('DOCUMENT.UPDATED', {
      documentId: request.documentId,
      change: 'signing_sent',
      departmentId: (doc as any)?.departmentId ?? null,
      tenantId: user.tenantId,
    });
  } catch (e) {
    logger.error({ e }, 'websocket enqueue failed');
  }

  // Role-based (unclaimed) recipients have no dmsUserId to route a realtime
  // refresh or a notification to — resolve the current department-scoped
  // holders of each assigned role instead, mirroring letters.service.ts's
  // notifyStepPending fan-out for role-assigned approval steps.
  const roleHolderIdsByRecipient = new Map<string, string[]>();
  for (const recipient of recipients) {
    if (!recipient.assignedRole || recipient.dmsUserId) continue;
    const holders = await resolveSigningRoleHolders(recipient.assignedRole, user.tenantId, (doc as any)?.departmentId ?? null);
    roleHolderIdsByRecipient.set(recipient.id, holders);
  }
  const allRoleHolderIds = [...roleHolderIdsByRecipient.values()].flat();

  await emitSigningUpdated(request.documentId, user.tenantId, 'sent', [
    user.userId,
    ...recipients.filter((r) => r.dmsUserId).map((r) => r.dmsUserId as string),
    ...allRoleHolderIds,
  ]);

  // Internal recipients get no access-token email (see the loop above) — the
  // gap that left them with no way to discover a pending signature task short
  // of manually opening the signing page and searching for the document.
  for (const recipient of recipients) {
    if (recipient.dmsUserId) {
      await fanOut({
        type: 'ESIGN_REQUEST_ASSIGNED',
        tenantId: user.tenantId,
        recipientIds: [recipient.dmsUserId],
        severity: 'INFO',
        payload: { documentId: request.documentId, documentName: documentName ?? null, requestId: request.id, recipientId: recipient.id },
      }).catch(() => {});
    } else if (recipient.assignedRole) {
      const holders = roleHolderIdsByRecipient.get(recipient.id) ?? [];
      if (holders.length === 0) continue;
      await fanOut({
        type: 'ESIGN_REQUEST_ASSIGNED',
        tenantId: user.tenantId,
        recipientIds: holders,
        severity: 'INFO',
        payload: { documentId: request.documentId, documentName: documentName ?? null, requestId: request.id, recipientId: recipient.id },
      }).catch(() => {});
    }
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: request.documentId,
    userId: user.userId,
    actionDetails: { action: 'signature_request_sent', requestId, documentVersionId: request.documentVersionId ?? null, ...metaDetails(meta) },
  });

  return request;
}

// ── Sign ─────────────────────────────────────────────────────────────────────

export async function signDocument(
  requestId: string,
  recipientId: string,
  fieldValues: Array<{ fieldId: string; value: string }>,
  ipAddress: string,
  user?: AuthenticatedUser,
  accessToken?: string,
  meta?: RequestMeta,
): Promise<{ request: SignatureRequest; allSigned: boolean }> {
  const request = await SignatureRequest.findByPk(requestId, {
    include: [
      { model: SignatureRecipient, as: 'recipients' },
      { model: SignatureField, as: 'fields' },
    ],
  });
  if (!request) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  if (!LIVE_REQUEST_STATUSES.includes(request.status)) {
    throw new AppError(409, 'ERR-INVALID-STATE', 'Request is not in a signable state');
  }

  // AUDIT-FINDINGS-2026-08-11 lifecycle sweep #2: legal hold blocked direct
  // document edits but not an in-flight signing ceremony — completion files a
  // new signed PDF as a new document version (see PAdES note in CLAUDE.md),
  // silently defeating a hold placed after the ceremony started.
  const holdDoc = await Document.findByPk(request.documentId, { attributes: ['isOnLegalHold', 'departmentId', 'tenantId', 'latestVersionId'] });
  // Tenant isolation for the authenticated path. The signature tables carry no RLS
  // and no tenant column, so the only thing keeping tenant B's session away from
  // tenant A's request is this check: a role-based recipient was claimable by ANY
  // tenant's role holder (the holder lookup ran against the CALLER's tenant), and
  // a user belonging to two tenants could sign in the one they were not logged
  // into. Answered as "not found" so request ids cannot be probed across tenants.
  if (user && holdDoc && holdDoc.tenantId !== user.tenantId) {
    throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  }
  if (holdDoc?.isOnLegalHold) {
    throw new AppError(403, 'ERR-HOLD-MODIFICATION-BLOCKED', 'Document is under legal hold and cannot be signed');
  }

  // Request-level expiry: signing must be refused once expiresAt has passed,
  // regardless of per-recipient accessTokenExpires (which only bounds the
  // token itself). Flip the request to 'expired' the first time this is hit.
  if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
    // Own transaction on purpose: the 410 below rolls the request transaction back, which used to
    // discard this flip (the request stayed 'sent' until the sweep got to it).
    if (holdDoc) await expireRequestNow(requestId, holdDoc.tenantId);
    throw new AppError(410, 'ERR-SIGNING-EXPIRED', 'This signature request has expired and can no longer be signed');
  }

  // E23: sign only the version the fields were placed on.
  assertPinnedVersionCurrent(request, holdDoc);

  const recipients = (request as any).recipients as SignatureRecipient[];
  const recipient = recipients.find((r) => r.id === recipientId);
  if (!recipient) throw new AppError(404, 'ERR-NOT-FOUND', 'Recipient not found');

  // Serial ordering: a recipient may only sign once every recipient with a
  // lower order_index has signed. Parallel mode skips this check.
  if (request.orderingMode === 'serial') {
    const blocking = recipients.filter(
      (r) => r.orderIndex < recipient.orderIndex && r.status !== 'signed',
    );
    if (blocking.length > 0) {
      throw new AppError(
        409,
        'ERR-SIGNING-OUT-OF-ORDER',
        'Earlier recipients must sign before you in this serial signing order',
      );
    }
  }

  // Auth: DMS user must match, a role-based recipient's claimant must hold
  // the assigned role (department-scoped), external signer must present a
  // valid access token.
  if (recipient.dmsUserId) {
    if (!user || user.userId !== recipient.dmsUserId) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to sign for this recipient');
    }
  } else if (recipient.assignedRole) {
    if (!user || !(user.roles ?? []).includes(recipient.assignedRole)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to sign for this recipient');
    }
    const holders = await resolveSigningRoleHolders(recipient.assignedRole, user.tenantId, holdDoc?.departmentId ?? null);
    if (!holders.includes(user.userId)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to sign for this recipient');
    }
  } else {
    await assertExternalToken(recipient, accessToken, {
      requestId, documentId: request.documentId, tenantId: holdDoc?.tenantId ?? null, attempt: 'sign', meta,
    });
  }

  if (recipient.status === 'signed') throw new AppError(409, 'ERR-ALREADY-SIGNED', 'Already signed');
  if (recipient.status === 'declined') throw new AppError(409, 'ERR-INVALID-STATE', 'This recipient has already declined');

  // The submission must actually carry the mark. An empty `fieldValues` used to be
  // accepted: the recipient flipped to 'signed' with every one of their signature
  // fields still blank, and the ceremony (and, for a letter, the letter itself)
  // completed with no signature on the page. Signature/initial/seal fields need a
  // non-empty value; an image value must be a PNG/JPEG data URL (anything else is
  // not something the PDF flattener can draw).
  const ownFields = ((request as any).fields as SignatureField[]).filter((f) => f.recipientId === recipientId);
  const submitted = new Map(fieldValues.map((v) => [v.fieldId, v.value]));
  for (const f of ownFields) {
    const v = submitted.get(f.id);
    if (['signature', 'initial', 'seal'].includes(f.fieldType) && (!v || !v.trim())) {
      throw new AppError(422, 'ERR-SIGNATURE-REQUIRED', 'Every signature field assigned to you must be completed before you can sign');
    }
    if (v && v.startsWith('data:') && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v)) {
      throw new AppError(422, 'ERR-SIGNATURE-INVALID', 'The signature image must be a PNG or JPEG');
    }
  }

  const now = new Date();

  // FIX: the whole completion sequence (recipient status, field values,
  // request status, and the parent-document reflection + optional
  // move_folder) used to run as separate, un-transacted statements, with the
  // document-move step wrapped in a try/catch that only logged on failure.
  // That meant a request could be durably marked `completed` while the
  // document silently never moved and fullySignedAt was never set, with no
  // retry. It also meant two concurrent "last signer" requests could both
  // observe allSigned=true and both run completion. Locking the request row
  // and doing everything in one transaction fixes both: completion is now
  // all-or-nothing, and concurrent finishers serialize on the row lock.
  const { allSigned, finalizedLetter } = await runInTransaction(async (tx): Promise<{
    allSigned: boolean;
    completedDoc: { tenantId: string } | null;
    finalizedLetter: Letter | null;
  }> => {
    let allSigned = false;
    let completedDoc: { tenantId: string } | null = null;
    let finalizedLetter: Letter | null = null;
    const lockedRequest = await SignatureRequest.findByPk(requestId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!lockedRequest) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
    // Re-check under the row lock: the state check at the top of this function read
    // the request before any lock, so a decline / cancel / expiry that committed in
    // between could still be signed over (completing a voided request).
    if (!LIVE_REQUEST_STATUSES.includes(lockedRequest.status)) {
      throw new AppError(409, 'ERR-INVALID-STATE', 'Request is not in a signable state');
    }
    // E23, re-checked under the lock: a version filed since the check above must not be signed over.
    assertPinnedVersionCurrent(
      lockedRequest,
      await Document.findByPk(lockedRequest.documentId, { attributes: ['latestVersionId'], transaction: tx }),
    );

    const lockedRecipient = await SignatureRecipient.findByPk(recipientId, { transaction: tx });
    if (!lockedRecipient || lockedRecipient.signatureRequestId !== requestId || lockedRecipient.status === 'signed') {
      throw new AppError(409, 'ERR-ALREADY-SIGNED', 'Already signed');
    }
    if (lockedRecipient.status === 'declined') {
      throw new AppError(409, 'ERR-INVALID-STATE', 'This recipient has already declined');
    }

    // Claim a role-based recipient now that we hold the request-row lock
    // (which serializes concurrent signDocument calls for this request) —
    // the eligibility check above already confirmed this caller qualifies,
    // this only guards against a second qualified holder racing to claim
    // the same slot between that check and this write.
    if (lockedRecipient.assignedRole && !lockedRecipient.dmsUserId) {
      const claimer = user ? await User.findByPk(user.userId, { transaction: tx }) : null;
      if (!claimer) throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to sign for this recipient');
      await lockedRecipient.update(
        { dmsUserId: claimer.id, name: `${claimer.firstName} ${claimer.lastName}`.trim(), email: claimer.email },
        { transaction: tx },
      );
    } else if (lockedRecipient.assignedRole && lockedRecipient.dmsUserId && lockedRecipient.dmsUserId !== user?.userId) {
      throw new AppError(409, 'ERR-ALREADY-CLAIMED', 'This role-based signature task was already claimed by someone else');
    }

    await lockedRecipient.update({ status: 'signed', signedAt: now, ipAddress }, { transaction: tx });

    // FIX: scope by recipientId too — the old filter (id + signatureRequestId
    // only) let any recipient overwrite ANY other recipient's field values,
    // since field ownership was checked on read but never enforced on write.
    for (const { fieldId, value } of fieldValues) {
      await SignatureField.update(
        { value, signedAt: now },
        { where: { id: fieldId, signatureRequestId: requestId, recipientId }, transaction: tx },
      );
    }

    const allRecipients = await SignatureRecipient.findAll({ where: { signatureRequestId: requestId }, transaction: tx });
    allSigned = allRecipients.every((r) => r.status === 'signed');

    if (allSigned) {
      await lockedRequest.update({ status: 'completed', completedAt: now }, { transaction: tx });

      // Reflect completion on the parent Document unconditionally — this must
      // happen regardless of completionAction, which only controls the
      // *additional*, optional move_folder side effect below. Any failure
      // here now rolls back the whole transaction instead of being swallowed.
      const doc = await Document.findByPk(lockedRequest.documentId, { transaction: tx });

      // Flattened signed copy: filed as a new document version AFTER commit —
      // it is a derived artifact (slow crypto + storage I/O) and must never
      // block or roll back the ceremony completion itself. setImmediate
      // escapes the request's CLS frame (and, with it, the tenant-scoped
      // transaction/RLS GUC that frame carried), so the filing runs in its
      // own transaction, not against the already-committed one.
      //
      // FIX 2026-09-14, two bugs stacked on the same line:
      //  1. This used to skip filing anything at all when ESIGN_P12_B64
      //     isn't configured — a "completed" ceremony left the document file
      //     completely unchanged, no visible signature anywhere.
      //     filePadesSignedCopy now always runs and decides internally
      //     (padesConfigured()) whether to produce the full PAdES-embedded
      //     copy or a plain flattened one.
      //  2. Even with a cert configured, the bare setImmediate call escapes
      //     the tenant GUC along with the CLS frame — every query inside
      //     filePadesSignedCopy (Document/SignatureRequest/etc., all RLS-
      //     protected with no unset-GUC escape valve) then silently found
      //     nothing under the app's own restricted DB role, so the request
      //     row read back as not-found and the function returned having
      //     filed nothing — no exception, so the .catch() below never even
      //     saw it (reproduced live on mirror, edams_app's actual role;
      //     masked on dev, which happens to connect as postgres, a role RLS
      //     always lets through — see routeExpiredCeremonyDocument's
      //     identical fix a few hundred lines down for the same pattern).
      //     withWorkerTenantContext re-establishes that GUC for the deferred
      //     call, same as every other cross-tenant/no-request-context path
      //     in this codebase already does.
      if (doc) {
        const tenantIdForFiling = doc.tenantId;
        tx.afterCommit(() => {
          setImmediate(() => {
            void withWorkerTenantContext(tenantIdForFiling, () => filePadesSignedCopy(requestId)).catch((err) =>
              logger.error({ err, requestId }, '[esign] signed-copy generation failed (ceremony completion unaffected)'),
            );
          });
        });

        await doc.update({ fullySignedAt: now }, { transaction: tx });

        // Lifecycle integration (SYSTEM-DECISIONS.md D8): a ceremony triggered
        // by the approval engine leaves the document in PENDING_SIGNATURE —
        // completion advances it to SIGNED, then routes to the audit stage if
        // the final approver assigned an auditor at approval time (the review
        // was created then, PENDING); otherwise a fully-signed document has
        // nothing left to do, so it goes straight to ARCHIVED rather than
        // parking at ACTIVE waiting for a separate manual archive step.
        if (doc.status === 'PENDING_SIGNATURE') {
          await doc.update({ status: 'SIGNED' }, { transaction: tx });
          const pendingAudit = await AuditStageReview.findOne({
            where: { itemType: 'DOCUMENT', itemId: doc.id, status: 'PENDING' },
            transaction: tx,
          });
          if (pendingAudit) {
            await doc.update({ status: 'PENDING_AUDIT' }, { transaction: tx });
          } else {
            // Mirror documents.service.ts's archiveDocument(): archivedAt must be
            // stamped and applyRetention() re-run here too, not just on the manual
            // archive endpoint — retentionEngine.ts's retentionBaseDate() reads
            // archivedAt for any ARCHIVE-triggered retention policy, and without
            // this a doc that auto-archives via signing would get disposalEligibleDate
            // stuck at null (retention clock never starts) since nothing else
            // ever calls applyRetention for it again after creation.
            await doc.update({ status: 'ARCHIVED', archivedAt: now }, { transaction: tx });
            await applyRetention(doc.id, tx);
          }
        }

        if (lockedRequest.completionAction === 'move_folder' && lockedRequest.completionTargetFolderId) {
          await doc.update({ folderId: lockedRequest.completionTargetFolderId }, { transaction: tx });
          completedDoc = { tenantId: doc.tenantId };
        }

        // Letters integration: an outgoing composed letter's approval routes
        // through enterPendingSignatureInTx (letters.service.ts), which files
        // an unnumbered signable draft as exactly this kind of document and
        // parks the letter in PENDING_SIGNATURE with letters.document_id
        // pointing at it. Ceremony completion is the letter's real
        // finalization trigger — allocate its reference number and render
        // the numbered PDF now, same as the non-signing letter path already
        // does directly from decideStep.
        const letter = await Letter.findOne({
          where: { documentId: doc.id, status: 'PENDING_SIGNATURE' },
          transaction: tx,
        });
        if (letter) {
          const signingUser = user ?? {
            userId: letter.signatoryUserId!,
            role: 'SYSTEM',
            tenantId: letter.tenantId,
          };
          if (!user) {
            logger.warn(
              { requestId, letterId: letter.id },
              '[letters] signDocument completed a letter ceremony with no authenticated signer on the call — falling back to the letter\'s stored signatory',
            );
          }
          await finalizeLetterAfterSigning(letter, signingUser, tx);
          finalizedLetter = letter;
        }
      }
    } else {
      await lockedRequest.update({ status: 'partially_signed' }, { transaction: tx });
    }

    // Cache invalidation is not a DB write — run it after the transaction has
    // actually committed, not inside it.
    //
    // FIX (runInTransaction conversion): this used to run right after the
    // managed `sequelize.transaction()` call returned, which used to BE the
    // true commit point (that call always opened its own independent
    // transaction). Now that it can reuse the ambient request transaction,
    // the callback resolving no longer means committed — the real commit
    // happens later, at response-finish time (see shared/middleware.ts).
    // tx.afterCommit is the one hook that fires at the true commit point in
    // both the ambient-reuse case and the fresh-transaction fallback.
    if (completedDoc) {
      const tenantIdForCache = completedDoc.tenantId;
      tx.afterCommit(() => {
        void invalidateResourceACL(tenantIdForCache, 'document', request.documentId).catch((err) => {
          logger.warn({ err, tenantId: tenantIdForCache, documentId: request.documentId }, 'Failed to invalidate document ACL cache after signing completion commit');
        });
      });
    }

    return { allSigned, completedDoc, finalizedLetter };
  });

  // audit_logs.user_id is a UUID column — an external signer has no user id,
  // so identity goes in actionDetails (pseudonymized at write time). tenantId
  // is stamped explicitly because the public route has no request context.
  const signedDocTenantId = (await Document.findByPk(request.documentId, { attributes: ['tenantId'] }))?.tenantId ?? null;
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: request.documentId,
    tenantId: signedDocTenantId,
    userId: user?.userId ?? null,
    actionDetails: {
      action: allSigned ? 'document_signed_completed' : 'document_signed_partial',
      requestId,
      recipientId,
      documentVersionId: request.documentVersionId ?? null,
      ...metaDetails({ ip: ipAddress || meta?.ip, userAgent: meta?.userAgent }),
      ...(user ? {} : { externalSigner: recipient.email }),
    },
  });

  if (signedDocTenantId) {
    await emitSigningUpdated(request.documentId, signedDocTenantId, allSigned ? 'completed' : 'partially_signed', request.createdBy ? [request.createdBy] : undefined);
  }

  // AUDIT-FINDINGS-2026-08-11 data-flow sweep #8: notify the SENDER, not just
  // a realtime event they'd miss if not watching the page — mirrors letters'
  // fanOut to the submitter on LETTER_APPROVED.
  if (allSigned && request.createdBy && signedDocTenantId) {
    const doc = await Document.findByPk(request.documentId, { attributes: ['documentName'] });
    await fanOut({
      type: 'ESIGN_REQUEST_COMPLETED',
      tenantId: signedDocTenantId,
      recipientIds: [request.createdBy],
      severity: 'INFO',
      payload: { documentId: request.documentId, documentName: doc?.documentName ?? null, requestId },
    }).catch(() => {});
  }

  // Letters: a ceremony completing IS the letter's real finalization (see the
  // "Letters integration" comment above finalizeLetterAfterSigning's call
  // site). The generic ESIGN_REQUEST_COMPLETED fanOut above only reaches
  // whoever happened to click "Initiate Signing" (often an approver, not the
  // drafter) and carries no reference number — reported live as "the letter
  // was signed but no email went out." Mirrors decideStep's own finalized
  // branch (letters.service.ts) exactly: audit log, websocket event, fanOut
  // to the drafter, and the executive correspondence notice.
  if (finalizedLetter) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.LETTER_APPROVED,
      userId: user?.userId ?? null,
      userRole: user?.role ?? null,
      documentId: finalizedLetter.documentId,
      tenantId: finalizedLetter.tenantId,
      actionDetails: { letterId: finalizedLetter.id, referenceNumber: finalizedLetter.referenceNumber, viaSigningCeremony: true },
    });
    await enqueueWebsocketEvent('LETTER.APPROVED', {
      tenantId: finalizedLetter.tenantId,
      departmentId: finalizedLetter.departmentId,
      letterId: finalizedLetter.id,
      referenceNumber: finalizedLetter.referenceNumber,
      subject: finalizedLetter.subject,
    });
    await fanOut({
      type: 'LETTER_SIGNED',
      tenantId: finalizedLetter.tenantId,
      recipientIds: [finalizedLetter.createdBy],
      severity: 'INFO',
      payload: { letterId: finalizedLetter.id, referenceNumber: finalizedLetter.referenceNumber, subject: finalizedLetter.subject },
    }).catch(() => {});
    const dept = finalizedLetter.departmentId
      ? await Department.findByPk(finalizedLetter.departmentId, { attributes: ['name'] })
      : null;
    await notifyExecutivesOfLetter(finalizedLetter, {
      departmentName: dept?.name ?? null,
      attachDocumentId: finalizedLetter.documentId,
    });
  }

  return { request, allSigned };
}

// Either marker means "a signed copy was already filed for this ceremony" —
// used for the idempotency guard and to find the true pre-signing base
// version, regardless of which of the two the tenant's config produced.
function isFiledSignedCopy(changeSummary: string | null): boolean {
  return changeSummary === PADES_CHANGE_SUMMARY || changeSummary === FLATTENED_CHANGE_SUMMARY;
}

/** Post-completion: build the signed PDF and file it as a new minor version
 *  of the ceremony's document (own transaction — runs after the completion
 *  commit, never inside it).
 *
 *  FIX 2026-09-14: always files a copy now, instead of silently filing
 *  nothing when ESIGN_P12_B64 isn't configured — with or without a
 *  certificate, "completed" must mean the document itself visibly changed.
 *  Uses the full PAdES-embedded, certificate-of-completion copy
 *  (generatePadesSignedPdf) when a signing certificate is configured, or a
 *  plain flattened copy (generateFlattenedUnsignedPdf — visible signature
 *  marks only, no cert page, no PAdES envelope) when it isn't. */
export async function filePadesSignedCopy(requestId: string, options?: { force?: boolean }): Promise<void> {
  const force = options?.force ?? false;
  const usePades = padesConfigured();
  const request = await SignatureRequest.findByPk(requestId);
  if (!request || request.status !== 'completed') return;
  const doc = await Document.findByPk(request.documentId);
  if (!doc || !doc.latestVersionId) return;

  const latestVersion = await DocumentVersion.findByPk(doc.latestVersionId);
  if (!latestVersion) return;

  // E23: a request that pinned its version flattens THAT version and records which version holds
  // its signed copy, so "already filed" is a per-request fact. Before, the guard looked at the
  // document's latest version, so a SECOND ceremony on a document that already carried a signed
  // copy from the first never produced its own. A historical request (no pin) keeps the old
  // document-level behaviour.
  const pinned = request.documentVersionId ? await DocumentVersion.findByPk(request.documentVersionId) : null;
  if (pinned) {
    if (request.signedVersionId && !force) return; // already filed (at-least-once safety)
  } else if (isFiledSignedCopy(latestVersion.changeSummary) && !force) {
    return;
  }

  // Flatten from the base version — never from a signed copy this very request filed. Without this,
  // a --force regenerate (after fixing a flattening bug, or after a signing certificate is
  // configured following an earlier cert-free completion) would stack a second flattening on top
  // of the first instead of replacing it.
  const currentVersion = pinned
    ?? (isFiledSignedCopy(latestVersion.changeSummary)
      ? await DocumentVersion.findOne({
          where: { documentId: doc.id, changeSummary: { [Op.notIn]: [PADES_CHANGE_SUMMARY, FLATTENED_CHANGE_SUMMARY] } },
          order: [['createdAt', 'DESC']],
        })
      : latestVersion);
  if (!currentVersion) return;

  const originalPdf = await fetchAndDecrypt(currentVersion.storageKey, currentVersion.id);
  const [fields, recipients] = await Promise.all([
    SignatureField.findAll({ where: { signatureRequestId: requestId } }),
    SignatureRecipient.findAll({ where: { signatureRequestId: requestId }, order: [['orderIndex', 'ASC']] }),
  ]);
  const fieldInputs = fields.map((f) => ({
    pageNumber: f.pageNumber, x: f.x, y: f.y, width: f.width, height: f.height,
    fieldType: f.fieldType, value: f.value,
  }));

  const signedPdf = usePades
    ? await generatePadesSignedPdf({
        originalPdf,
        fields: fieldInputs,
        signers: recipients.map((r) => ({ name: r.name, email: r.email, signedAt: r.signedAt, ipAddress: r.ipAddress })),
        requestId,
        requestTitle: doc.title ?? doc.documentName ?? 'Signature request',
      })
    : await generateFlattenedUnsignedPdf({ originalPdf, fields: fieldInputs, requestId });

  const versionId = crypto.randomUUID();
  const storageKey = `${currentVersion.storageKey}-${usePades ? 'pades' : 'flat'}-${versionId.slice(0, 8)}`;
  const { encryptedKey, sha256Hash, kekId } = await encryptAndStore(
    storageKey, signedPdf, 'application/pdf', doc.departmentId, doc.tenantId,
  );

  // Minor version bump off the document's LATEST version ("2.0" -> "2.1"; ".1" suffix semantics as
  // a fallback). Bumping the base instead collided with an existing number on a forced regenerate
  // and for a second ceremony.
  const [major, minor] = String(latestVersion.versionNumber ?? currentVersion.versionNumber ?? '1.0').split('.');
  const nextVersion = `${major || '1'}.${(parseInt(minor || '0', 10) || 0) + 1}`;
  const changeSummary = usePades ? PADES_CHANGE_SUMMARY : FLATTENED_CHANGE_SUMMARY;

  await runInTransaction(async (tx) => {
    await DocumentVersion.create(
      {
        id: versionId,
        documentId: doc.id,
        versionNumber: nextVersion,
        isMajorVersion: false,
        storageKey,
        storageBucket: currentVersion.storageBucket,
        fileSize: BigInt(signedPdf.length),
        mimeType: 'application/pdf',
        originalFilename: (currentVersion.originalFilename ?? 'document.pdf').replace(/(\.pdf)?$/i, '-signed.pdf'),
        sha256Hash,
        plaintextSha256: crypto.createHash('sha256').update(signedPdf).digest('hex'),
        extractedText: null,
        authorId: request.createdBy ?? doc.ownerId,
        changeSummary,
        avScanStatus: currentVersion.avScanStatus, // rendered from currentVersion's already-scanned plaintext
      },
      { transaction: tx },
    );
    await DocumentDek.create(
      { documentId: doc.id, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' },
      { transaction: tx },
    );
    await Document.update({ latestVersionId: versionId }, { where: { id: doc.id }, transaction: tx });
    await SignatureRequest.update({ signedVersionId: versionId }, { where: { id: requestId }, transaction: tx });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: doc.id,
    tenantId: doc.tenantId,
    userId: null,
    actionDetails: { action: usePades ? 'pades_signed_copy_filed' : 'flattened_signed_copy_filed', requestId, versionId, versionNumber: nextVersion, pades: usePades, baseVersionId: currentVersion.id },
  });
  logger.info({ requestId, documentId: doc.id, versionId, pades: usePades }, `[esign] ${usePades ? 'PAdES-signed' : 'flattened'} copy filed as new version`);
}


// ── Decline ──────────────────────────────────────────────────────────────────

export async function declineSignature(
  requestId: string,
  recipientId: string,
  reason: string,
  ipAddress: string,
  user?: AuthenticatedUser,
  accessToken?: string,
  meta?: RequestMeta,
): Promise<void> {
  const recipient = await SignatureRecipient.findOne({ where: { id: recipientId, signatureRequestId: requestId } });
  if (!recipient) throw new AppError(404, 'ERR-NOT-FOUND', 'Recipient not found');

  const requestForAuth = await SignatureRequest.findByPk(requestId);
  if (!requestForAuth) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  const authDoc = await Document.findByPk(requestForAuth.documentId, { attributes: ['departmentId', 'tenantId'] });
  // Same tenant-isolation rule as signDocument (the signature tables have no RLS).
  if (user && authDoc && authDoc.tenantId !== user.tenantId) {
    throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  }

  // Auth: DMS user must match the recipient; a role-based recipient's claimant must
  // hold the role (department-scoped, same rule as signing); external signer must
  // present a valid token. (An unclaimed role recipient used to fall into the token
  // branch and always answer "invalid token", so a role holder could never decline.)
  if (recipient.dmsUserId) {
    if (!user || user.userId !== recipient.dmsUserId) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to decline for this recipient');
    }
  } else if (recipient.assignedRole) {
    if (!user || !(user.roles ?? []).includes(recipient.assignedRole)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to decline for this recipient');
    }
    const holders = await resolveSigningRoleHolders(recipient.assignedRole, user.tenantId, authDoc?.departmentId ?? null);
    if (!holders.includes(user.userId)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to decline for this recipient');
    }
  } else {
    await assertExternalToken(recipient, accessToken, {
      requestId, documentId: requestForAuth.documentId, tenantId: authDoc?.tenantId ?? null, attempt: 'decline', meta,
    });
  }

  // State machine: only a recipient who has not yet acted, on a LIVE request, can
  // decline. There was no check at all: a recipient who had ALREADY SIGNED could
  // decline afterwards and flip a COMPLETED request to 'voided' (and a stale token
  // could void a cancelled/expired one). The request row is locked so a concurrent
  // sign/decline/cancel serialises with this one.
  const request = await runInTransaction(async (tx) => {
    const locked = await SignatureRequest.findByPk(requestId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!locked) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
    if (!LIVE_REQUEST_STATUSES.includes(locked.status)) {
      throw new AppError(409, 'ERR-INVALID-STATE', 'This signature request is no longer open, so it cannot be declined');
    }
    const fresh = await SignatureRecipient.findByPk(recipientId, { transaction: tx });
    if (!fresh || fresh.status === 'signed' || fresh.status === 'declined') {
      throw new AppError(409, 'ERR-INVALID-STATE', 'You have already responded to this signature request');
    }
    const claimant = recipient.assignedRole && !recipient.dmsUserId && user
      ? await User.findByPk(user.userId, { transaction: tx })
      : null;
    await fresh.update(
      {
        status: 'declined', declinedAt: new Date(), declineReason: reason, ipAddress,
        ...(claimant ? { dmsUserId: claimant.id, name: `${claimant.firstName} ${claimant.lastName}`.trim(), email: claimant.email } : {}),
      },
      { transaction: tx },
    );
    await locked.update({ status: 'voided', voidedReason: `Recipient ${fresh.email} declined: ${reason}` }, { transaction: tx });

    // Lifecycle integration (D8): a ceremony pending on the document lifecycle
    // that gets declined moves the document to SIGNING_DECLINED, from which a
    // new ceremony can be started (PENDING_SIGNATURE) or the item cancelled.
    const doc = await Document.findByPk(locked.documentId, { transaction: tx });
    if (doc?.status === 'PENDING_SIGNATURE') {
      await doc.update({ status: 'SIGNING_DECLINED' }, { transaction: tx });
    }
    // E27: tell whoever is waiting on this ceremony (letters), atomically with the decline.
    await emitCeremonyEnded(
      {
        requestId, documentId: locked.documentId, tenantId: authDoc?.tenantId ?? doc?.tenantId ?? '',
        outcome: 'declined', reason: reason || null, actorUserId: user?.userId ?? null, recipientId,
      },
      tx,
    );
    return locked;
  });

  const declinedDocTenantId = request?.documentId
    ? ((await Document.findByPk(request.documentId, { attributes: ['tenantId'] }))?.tenantId ?? null)
    : null;
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: request?.documentId ?? null,
    tenantId: declinedDocTenantId,
    userId: user?.userId ?? null,
    actionDetails: {
      action: 'signature_declined',
      requestId,
      recipientId,
      reason,
      ...metaDetails({ ip: ipAddress || meta?.ip, userAgent: meta?.userAgent }),
      ...(user ? {} : { externalSigner: recipient.email }),
    },
  });

  if (request?.documentId && declinedDocTenantId) {
    await emitSigningUpdated(request.documentId, declinedDocTenantId, 'declined', request?.createdBy ? [request.createdBy] : undefined);
  }

  // AUDIT-FINDINGS-2026-08-11 data-flow sweep #8: same sender-notification
  // gap as signDocument's completion path — a decline is the more urgent of
  // the two (the sender needs to know the ceremony died), and previously
  // got no persisted notification either.
  if (request?.createdBy && declinedDocTenantId) {
    const doc = request.documentId ? await Document.findByPk(request.documentId, { attributes: ['documentName'] }) : null;
    await fanOut({
      type: 'ESIGN_REQUEST_DECLINED',
      tenantId: declinedDocTenantId,
      recipientIds: [request.createdBy],
      severity: 'WARNING',
      payload: { documentId: request.documentId, documentName: doc?.documentName ?? null, requestId, reason },
    }).catch(() => {});
  }
}

// ── View (public, external signers) ─────────────────────────────────────────

/** Shape returned to the public signer landing page — deliberately excludes
 * other recipients' access tokens / emails so the page can render request
 * context (serial ordering, document name) without leaking sensitive data. */
export interface ExternalSigningView {
  request: {
    id: string;
    status: SignatureRequest['status'];
    orderingMode: SignatureRequest['orderingMode'];
    expiresAt: Date | null;
    documentName: string | null;
  };
  recipient: {
    id: string;
    name: string;
    email: string;
    status: SignatureRecipient['status'];
    orderIndex: number;
  };
  fields: Array<{
    id: string;
    fieldType: SignatureField['fieldType'];
    pageNumber: number;
    value: string | null;
  }>;
  recipients: Array<{ id: string; name: string; orderIndex: number; status: SignatureRecipient['status'] }>;
}

/**
 * Marks an external recipient's status as 'viewed' the first time they open
 * their signing link (never downgrades a recipient who has already signed or
 * declined) and returns everything the public landing page needs to render:
 * the request/document context, this recipient's own fields, and a minimal
 * roster of co-recipients (for serial-order awareness). Public route only
 * (access-token auth, same pattern as signDocument/declineSignature's
 * external branch) — DMS users are never routed through this endpoint.
 */
export async function markRecipientViewed(
  requestId: string,
  recipientId: string,
  accessToken: string,
  meta?: RequestMeta,
): Promise<ExternalSigningView> {
  const request = await SignatureRequest.findByPk(requestId, {
    include: [
      { model: Document, as: 'document', attributes: ['documentName', 'tenantId'] },
      { model: SignatureRecipient, as: 'recipients' },
      { model: SignatureField, as: 'fields' },
    ],
  });
  if (!request) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');

  const recipients = (request as any).recipients as SignatureRecipient[];
  const recipient = recipients.find((r) => r.id === recipientId);
  if (!recipient) throw new AppError(404, 'ERR-NOT-FOUND', 'Recipient not found');

  const viewTenantId = ((request as any).document as Document | undefined)?.tenantId ?? null;
  await assertExternalToken(recipient, accessToken, {
    requestId, documentId: request.documentId, tenantId: viewTenantId, attempt: 'view', meta,
  });

  // Lazily flip an overdue request to 'expired' — mirrors signDocument()'s
  // check — so the landing page shows a friendly expired state even if the
  // periodic expiry sweep hasn't run yet, without ever downgrading a request
  // that already reached a terminal state.
  if (
    request.expiresAt &&
    request.expiresAt.getTime() < Date.now() &&
    LIVE_REQUEST_STATUSES.includes(request.status)
  ) {
    if (viewTenantId) await expireRequestNow(requestId, viewTenantId);
    request.status = 'expired';
  }

  // 'viewed' is only meaningful on a live ceremony — don't stamp a view (and an audit
  // row) onto a draft, voided, expired or completed request.
  if (recipient.status === 'pending' && LIVE_REQUEST_STATUSES.includes(request.status)) {
    await recipient.update({ status: 'viewed' });

    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
      documentId: request.documentId,
      tenantId: ((request as any).document as Document | undefined)?.tenantId ?? null,
      userId: null,
      actionDetails: {
        action: 'signature_request_viewed',
        requestId,
        recipientId,
        externalSigner: recipient.email,
        ...metaDetails(meta),
      },
    });
  }

  const fields = ((request as any).fields as SignatureField[]).filter((f) => f.recipientId === recipientId);

  return {
    request: {
      id: request.id,
      status: request.status,
      orderingMode: request.orderingMode,
      expiresAt: request.expiresAt,
      documentName: ((request as any).document as Document | undefined)?.documentName ?? null,
    },
    recipient: {
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      status: recipient.status,
      orderIndex: recipient.orderIndex,
    },
    fields: fields.map((f) => ({ id: f.id, fieldType: f.fieldType, pageNumber: f.pageNumber, value: f.value })),
    recipients: recipients
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((r) => ({ id: r.id, name: r.name, orderIndex: r.orderIndex, status: r.status })),
  };
}

/**
 * Fetches the ORIGINAL document bytes a signature-request recipient is being
 * asked to sign — not the request metadata (getSignatureRequest/
 * markRecipientViewed already return that), the actual file content, so a
 * signer can see what they're signing before they do.
 *
 * FIX 2026-09-15: neither the internal "Pending My Signature" queue
 * (frontend/app/dashboard/signing/pending/page.tsx) nor the external
 * emailed-link landing page (frontend/app/sign/[requestId]/[recipientId])
 * ever fetched or rendered the document itself — both showed only a list of
 * field placeholders ("Signature · p.1") plus a name box/signature pad, with
 * no way to actually see the content being approved before signing it.
 * Reproduced live for both internal and external signers. The obvious "just
 * point the frontend at GET /documents/:id/download" fix does not work here:
 * that route requires generic document:read ACL, which an external signer
 * has no identity to hold at all, and which already 403'd internal signers
 * named on a request for a document outside their normal folder/department
 * scope (see listMySignatureTasks's own comment on this exact prior
 * incident) — so this needs its own, request-scoped authorization instead.
 *
 * Authorization mirrors signDocument()'s own rule exactly (DMS user must
 * match dmsUserId; a role-based recipient's viewer must hold the assigned
 * role, department-scoped the same way claiming/signing already is;
 * external signer must present a valid, unexpired access token) — viewing
 * grants no capability signing doesn't already imply, so it uses the same
 * gate rather than a looser one.
 */
export async function fetchSigningDocumentBytes(
  requestId: string,
  recipientId: string,
  auth: { user?: AuthenticatedUser; accessToken?: string },
  meta?: RequestMeta,
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const request = await SignatureRequest.findByPk(requestId, {
    include: [{ model: SignatureRecipient, as: 'recipients' }],
  });
  if (!request) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');

  const recipients = (request as any).recipients as SignatureRecipient[];
  const recipient = recipients.find((r) => r.id === recipientId);
  if (!recipient) throw new AppError(404, 'ERR-NOT-FOUND', 'Recipient not found');

  const doc = await Document.findByPk(request.documentId, { attributes: ['id', 'departmentId', 'latestVersionId', 'tenantId'] });
  if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');
  // Tenant isolation for the authenticated path (see signDocument).
  if (auth.user && doc.tenantId !== auth.user.tenantId) {
    throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  }

  if (recipient.dmsUserId) {
    if (!auth.user || auth.user.userId !== recipient.dmsUserId) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to view this document');
    }
  } else if (recipient.assignedRole) {
    if (!auth.user || !(auth.user.roles ?? []).includes(recipient.assignedRole)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to view this document');
    }
    const holders = await resolveSigningRoleHolders(recipient.assignedRole, auth.user.tenantId, doc.departmentId ?? null);
    if (!holders.includes(auth.user.userId)) {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Not authorized to view this document');
    }
  } else {
    await assertExternalToken(recipient, auth.accessToken, {
      requestId, documentId: request.documentId, tenantId: doc.tenantId, attempt: 'document', meta,
    });
  }

  // The link only serves the document while the ceremony is open (or finished). A
  // cancelled / declined / expired / never-sent request's token used to keep
  // returning the full document until the token's own 7-day expiry.
  if (!['sent', 'partially_signed', 'completed'].includes(request.status)) {
    throw new AppError(409, 'ERR-INVALID-STATE', 'This signature request is no longer open');
  }

  // E23: serve the version the request covers, not whatever is latest. A live request whose
  // document has since moved on is refused (it can no longer be signed either); a completed one
  // serves its filed signed copy when it has one, else the pinned version.
  let versionId: string | null = doc.latestVersionId ?? null;
  if (request.documentVersionId) {
    if (request.status === 'completed') {
      versionId = request.signedVersionId ?? request.documentVersionId;
    } else {
      assertPinnedVersionCurrent(request, doc);
      versionId = request.documentVersionId;
    }
  }
  if (!versionId) throw new AppError(500, 'ERR-VERSION-MISSING', 'Document has no filed version yet');
  const version = await DocumentVersion.findByPk(versionId);
  if (!version || (version.documentId && version.documentId !== doc.id)) {
    throw new AppError(500, 'ERR-VERSION-MISSING', 'Document has no filed version yet');
  }
  const buffer = await fetchAndDecrypt(version.storageKey, version.id);

  // E26: an external signer has no account, so every fetch of the document by link is evidence.
  if (!auth.user && shouldAuditTokenEvent(`fetch|${recipientId}|${meta?.ip ?? ''}`)) {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
      documentId: doc.id,
      tenantId: doc.tenantId,
      userId: null,
      actionDetails: {
        action: 'signature_document_fetched',
        requestId,
        recipientId,
        versionId: version.id,
        externalSigner: recipient.email,
        ...metaDetails(meta),
      },
    }).catch((err) => logger.warn({ err }, 'failed to audit an external document fetch'));
  }
  return { buffer, filename: version.originalFilename, mimeType: version.mimeType };
}

// ── Get + list ───────────────────────────────────────────────────────────────

export async function getSignatureRequest(requestId: string, user: AuthenticatedUser): Promise<SignatureRequest> {
  const request = await loadRequest(requestId, user);
  return request;
}

export async function listSignatureRequestsForDocument(documentId: string, user: AuthenticatedUser): Promise<SignatureRequest[]> {
  const doc = await Document.findOne({ where: { id: documentId, tenantId: user.tenantId } });
  if (!doc) throw new AppError(404, 'ERR-NOT-FOUND', 'Document not found');
  return SignatureRequest.findAll({
    where: { documentId },
    include: [
      { model: SignatureRecipient, as: 'recipients' },
      { model: SignatureField, as: 'fields' },
    ],
    order: [['createdAt', 'DESC']],
  });
}

/** Recipient-centric: requests waiting on ME to sign. Shared with My Work
 *  (approvals/myWork.service.ts), which surfaces the same rows in its unified
 *  inbox — this is the single source of truth for that query. Only needs
 *  userId/tenantId, so it accepts My Work's narrower CurrentUser too. */
export async function listMySignatureTasks(
  user: Pick<AuthenticatedUser, 'userId' | 'tenantId'> & { roles?: string[]; permissions?: string[] },
  skip = 0,
  take = 25,
): Promise<{ data: SignatureRecipient[]; total: number }> {
  const roles = user.roles ?? [];
  // Same department-scoping rule resolveSigningRoleHolders enforces at
  // claim time — a role match alone isn't enough to surface an unclaimed
  // role-based task here for someone outside the document's own department,
  // who'd then be rejected the moment they tried to claim/sign it (mirrors
  // myWork.service.ts's identical letter-step scoping).
  const canBypassDeptScope = (user.permissions ?? []).includes(PERMISSIONS.DOCUMENT_READ_ALL);
  const myDepartmentIds = canBypassDeptScope
    ? null
    : new Set(
        (await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ['departmentId'] })).map(
          (r) => r.departmentId,
        ),
      );

  const safeTake = Math.min(take, 100);
  const { rows, count } = await SignatureRecipient.findAndCountAll({
    where: {
      status: { [Op.in]: ['pending', 'viewed'] },
      [Op.or]: [
        { dmsUserId: user.userId },
        // Unclaimed role-based recipients matching any of my roles — see
        // the department post-filter below (can't be expressed here since
        // it depends on the joined document, not a column on this model).
        ...(roles.length ? [{ dmsUserId: null, assignedRole: { [Op.in]: roles } }] : []),
      ],
    },
    include: [
      {
        model: SignatureRequest,
        as: 'request',
        where: { status: { [Op.in]: ['sent', 'partially_signed'] } },
        include: [
          { model: Document, as: 'document', attributes: ['id', 'title', 'documentName', 'tenantId', 'departmentId'] },
          // Needed so the caller can sign directly from this list (the field
          // values a signature submission must carry) without a second round
          // trip through GET /documents/:id/signing — which requires
          // document:read ACL and 403s for a recipient named on a request for
          // a document outside their normal folder/department scope, even
          // though the actual sign endpoint below has no such gate (it only
          // checks that the caller IS the named recipient).
          { model: SignatureField, as: 'fields' },
        ],
      },
    ],
    // Newest-first — matches the other My Work / worklist queues.
    order: [['createdAt', 'DESC']],
    offset: skip,
    limit: safeTake,
  });
  // Tenant scoping rides on the parent document (SignatureRecipient itself
  // carries no tenantId) — a post-query JS filter, same coarse-count tradeoff
  // documents.service.ts's listDocuments accepts: `total` is a pre-filter
  // upper bound, so a page may return fewer than safeTake.
  const data = rows.filter((r) => {
    const doc = (r as SignatureRecipient & { request?: SignatureRequest & { document?: Document } }).request?.document;
    if (doc?.tenantId && doc.tenantId !== user.tenantId) return false;
    if (r.dmsUserId) return true; // named recipient (mine) — never department-scoped, same as everywhere else
    if (!doc || !(doc as any).departmentId) return true; // no department on the document — nothing to scope against
    return myDepartmentIds === null || myDepartmentIds.has((doc as any).departmentId);
  });
  return { data, total: count };
}

/** Creator-centric: requests I sent, regardless of status. */
export async function listSentSignatureRequests(
  user: AuthenticatedUser,
  skip = 0,
  take = 25,
): Promise<{ data: SignatureRequest[]; total: number }> {
  const safeTake = Math.min(take, 100);
  const { rows, count } = await SignatureRequest.findAndCountAll({
    where: { createdBy: user.userId },
    include: [
      { model: Document, as: 'document', where: { tenantId: user.tenantId }, attributes: ['id', 'title', 'documentName'] },
      { model: SignatureRecipient, as: 'recipients' },
    ],
    order: [['createdAt', 'DESC']],
    offset: skip,
    limit: safeTake,
    distinct: true,
  });
  return { data: rows, total: count };
}

/** Completed ceremonies visible to me — either I sent them or I was a recipient. */
export async function listCompletedSignatureRequests(
  user: AuthenticatedUser,
  skip = 0,
  take = 25,
): Promise<{ data: SignatureRequest[]; total: number }> {
  const myRecipientRequestIds = (
    await SignatureRecipient.findAll({ where: { dmsUserId: user.userId }, attributes: ['signatureRequestId'] })
  ).map((r) => r.signatureRequestId);

  const safeTake = Math.min(take, 100);
  const { rows, count } = await SignatureRequest.findAndCountAll({
    where: {
      status: 'completed',
      [Op.or]: [{ createdBy: user.userId }, { id: { [Op.in]: myRecipientRequestIds } }],
    },
    include: [
      { model: Document, as: 'document', where: { tenantId: user.tenantId }, attributes: ['id', 'title', 'documentName'] },
      { model: SignatureRecipient, as: 'recipients' },
    ],
    order: [['completedAt', 'DESC']],
    offset: skip,
    limit: safeTake,
    distinct: true,
  });
  return { data: rows, total: count };
}

/** Re-sends the invite/notification to every recipient who hasn't signed yet — reuses sendSignatureRequest's delivery code path rather than duplicating it. */
export async function remindSignatureRequest(requestId: string, user: AuthenticatedUser, meta?: RequestMeta): Promise<SignatureRequest> {
  const request = await loadRequest(requestId, user);
  assertCanManageRequest(request, user);
  if (!LIVE_REQUEST_STATUSES.includes(request.status)) {
    throw new AppError(409, 'ERR-INVALID-STATE', 'Only a sent (or partially signed) request can be reminded');
  }
  // A request-level expiry that has already passed can never be signed: don't email
  // people a link that will only answer "expired".
  if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
    throw new AppError(410, 'ERR-SIGNING-EXPIRED', 'This signature request has expired');
  }
  // E23: do not nudge people to sign a version that is no longer the document's current one.
  assertPinnedVersionCurrent(request, (request as any).document);

  const recipients = ((request as any).recipients as SignatureRecipient[]).filter((r) => r.status === 'pending' || r.status === 'viewed');
  const documentName = ((request as any).document as Document | undefined)?.documentName;

  for (const recipient of recipients) {
    if (recipient.dmsUserId) {
      await fanOut({
        type: 'ESIGN_REQUEST_ASSIGNED',
        tenantId: user.tenantId,
        recipientIds: [recipient.dmsUserId],
        severity: 'INFO',
        payload: { documentId: request.documentId, documentName: documentName ?? null, requestId: request.id, recipientId: recipient.id },
      }).catch(() => {});
      continue;
    }
    // Role-based (unclaimed) recipients are internal: nudge the current qualified
    // holders in-app. They used to fall through to the email branch below and be
    // "emailed" their synthetic non-routable placeholder address.
    if (recipient.assignedRole) {
      const reqDoc = (request as any).document as Document | undefined;
      const holders = await resolveSigningRoleHolders(recipient.assignedRole, user.tenantId, reqDoc?.departmentId ?? null);
      if (holders.length > 0) {
        await fanOut({
          type: 'ESIGN_REQUEST_ASSIGNED',
          tenantId: user.tenantId,
          recipientIds: holders,
          severity: 'INFO',
          payload: { documentId: request.documentId, documentName: documentName ?? null, requestId: request.id, recipientId: recipient.id },
        }).catch(() => {});
      }
      continue;
    }
    // E24: only a digest is stored, so the earlier link cannot be re-sent. A reminder ROTATES the
    // token: a fresh one is minted, the earlier link stops working, and the new link is emailed.
    // Token and email row are written in one transaction so a signer is never locked out by a
    // rotation whose email was never queued.
    await runInTransaction(async (t) => {
      const minted = mintAccessToken();
      await recipient.update(
        { accessTokenHash: minted.hash, accessToken: null, accessTokenExpires: new Date(Date.now() + EXTERNAL_TOKEN_TTL_MS) },
        { transaction: t },
      );
      const base = config.CLIENT_URL.replace(/\/$/, '');
      const signUrl = `${base}/sign/${request.id}/${recipient.id}?token=${encodeURIComponent(minted.raw)}`;
      await OutboxEvent.create(
        {
          documentId: request.documentId,
          type: 'ESIGNING.RECIPIENT_INVITED',
          channel: 'EMAIL',
          payload: JSON.stringify({
            email: recipient.email,
            name: recipient.name,
            documentId: request.documentId,
            documentName: documentName ?? null,
            requestId: request.id,
            recipientId: recipient.id,
            signUrl,
            reminder: true,
          }),
        },
        { transaction: t },
      );
    });
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: request.documentId,
    userId: user.userId,
    actionDetails: { action: 'signature_request_reminded', requestId, recipientCount: recipients.length, ...metaDetails(meta) },
  });

  return request;
}

/**
 * M1: an expired ceremony must not strand its document in PENDING_SIGNATURE.
 * Route the backing document to SIGNING_DECLINED — the recoverable state from
 * which a fresh ceremony can be started (see sendSignatureRequest) or the item
 * cancelled. Only touches documents actually parked awaiting this ceremony.
 */
// documents has RLS with no unset-GUC escape valve — must run inside
// withWorkerTenantContext (see expireRequestNow below), never bare.
async function routeExpiredCeremonyDocument(documentId: string | null | undefined, tx?: Transaction, requestId?: string): Promise<void> {
  if (!documentId) return;
  const doc = await Document.findByPk(documentId, tx ? { transaction: tx } : undefined);
  if (doc?.status === 'PENDING_SIGNATURE') {
    await doc.update({ status: 'SIGNING_DECLINED' }, tx ? { transaction: tx } : undefined);
    await writeAuditLog({
      eventType: AUDIT_EVENTS.SIGNING_EXPIRED,
      documentId,
      tenantId: doc.tenantId,
      actionDetails: { fromStatus: 'PENDING_SIGNATURE', toStatus: 'SIGNING_DECLINED', ...(requestId ? { requestId } : {}) },
    }).catch((err) => logger.warn({ err, documentId }, 'Failed to write signing-expiry audit log'));
  }
}

/**
 * Expires ONE live request: status -> 'expired', its document out of PENDING_SIGNATURE, and the
 * ceremony-ended hook (E27), all in one transaction under the request row lock. Returns false when
 * the request was no longer live (someone signed, declined or cancelled first).
 *
 * Runs in its own tenant-scoped context (withWorkerTenantContext), on purpose, for every caller:
 * the lazy path in signDocument used to flip the status on the REQUEST transaction and then throw
 * the 410, and an error response rolls that transaction back — the flip never persisted.
 */
async function expireRequestNow(requestId: string, tenantId: string): Promise<boolean> {
  return withWorkerTenantContext(tenantId, () =>
    runInTransaction(async (tx) => {
      const locked = await SignatureRequest.findByPk(requestId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!locked || !LIVE_REQUEST_STATUSES.includes(locked.status)) return false;
      await locked.update({ status: 'expired' }, { transaction: tx });
      await routeExpiredCeremonyDocument(locked.documentId, tx, requestId); // M1
      await writeAuditLog({
        eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
        documentId: locked.documentId,
        tenantId,
        userId: null,
        actionDetails: { action: 'signature_request_expired', requestId },
      }, tx);
      await emitCeremonyEnded(
        { requestId, documentId: locked.documentId, tenantId, outcome: 'expired', reason: null, actorUserId: null, recipientId: null },
        tx,
      );
      return true;
    }),
  );
}

// ── Expiry sweep (periodic worker) ──────────────────────────────────────────

/**
 * Finds every signable request whose expiresAt has passed and flips it to
 * 'expired'. signDocument() also enforces expiry lazily on the hot path, but
 * a request nobody ever tries to sign again would otherwise sit in 'sent' /
 * 'partially_signed' forever — this sweep is what actually retires it. Each
 * expired request's document is routed out of PENDING_SIGNATURE (M1) and the
 * ceremony-ended hook fires (E27), one transaction per request.
 *
 * Looped per-tenant (same shape as RetentionPurgeWorker's sweeps), not one
 * global query: signature_requests carries no tenantId of its own (only
 * reachable via its document association), and documents' RLS policy has no
 * unset-GUC escape valve, so neither the lookup nor the eventual
 * routeExpiredCeremonyDocument() write could safely run without first knowing
 * which tenant they belong to — a bare cross-tenant query here would silently
 * return/affect nothing the day the DB role is switched away from superuser.
 */
export async function expireSignatureRequests(): Promise<number> {
  const tenants = await Tenant.findAll({ attributes: ['id'], raw: true });
  let count = 0;
  for (const t of tenants) {
    try {
      const stale = await withWorkerTenantContext(t.id, () =>
        SignatureRequest.findAll({
          where: {
            status: { [Op.in]: ['sent', 'partially_signed'] },
            expiresAt: { [Op.lt]: new Date() },
          },
          include: [{ model: Document, as: 'document', required: true, attributes: [], where: { tenantId: t.id } }],
          attributes: ['id', 'documentId'],
        }),
      );
      for (const r of stale) {
        try {
          if (await expireRequestNow(r.id, t.id)) count += 1;
        } catch (err) {
          logger.error({ err, requestId: r.id, tenantId: t.id }, 'e-signing expiry failed for request');
        }
      }
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'e-signing expiry sweep failed for tenant');
    }
  }
  if (count > 0) {
    logger.info({ count }, 'e-signing: expired stale signature requests');
    if (!hasCeremonyEndedHandlers()) {
      logger.warn('e-signing: requests expired but no ceremony-ended handler is registered in this process (the letters module must be imported by the worker entry; see esigning.events.ts)');
    }
  }
  return count;
}

// ── E23: version pinning ─────────────────────────────────────────────────────

/**
 * A request is signed against the version its fields were placed on. Refuse when the document has a
 * newer one. There is deliberately no in-place re-pin: a newer version means the field positions may
 * no longer fit, so the requester cancels this request and creates a fresh one (which pins the
 * current version) — that is the "re-send". A historical request (no pin) is not checked.
 */
function assertPinnedVersionCurrent(
  request: Pick<SignatureRequest, 'documentVersionId'>,
  doc: { latestVersionId?: string | null } | null | undefined,
): void {
  if (!request.documentVersionId || !doc?.latestVersionId) return;
  if (doc.latestVersionId !== request.documentVersionId) {
    throw new AppError(
      409,
      'ERR-SIGNING-VERSION-STALE',
      'The document has a newer version than the one this signature request was prepared on. Cancel this request and send a new one for the current version.',
    );
  }
}

// ── E25: who may start a ceremony ────────────────────────────────────────────

/**
 * Starting a ceremony flips the document into PENDING_SIGNATURE and puts it in front of signers, so
 * document:read + signing:manage (held by every department colleague) is not enough. The actor must be:
 *   - a SYSTEM_ADMIN or an acl:bypass_admin holder (document administrator);
 *   - the document's owner;
 *   - someone holding the write-grade `document:upload` ACL on it (explicit, folder or department grant);
 *   - the approver who approved it in the unified approval engine (the chain that routes a document
 *     to a ceremony hands the next step to them, and they hold only a read grant);
 *   - for a letter's signable draft: the letter's drafter, its signatory or a letter:approve holder
 *     (letters authorise their own start; the draft's owner is the drafter).
 * Anyone else gets 403 ERR-SIGNING-NOT-PERMITTED. Easy to change: this one function is the whole rule.
 */
async function assertMayStartCeremony(doc: Document, user: AuthenticatedUser): Promise<void> {
  const roles = user.roles ?? [];
  const perms = user.permissions ?? [];
  if (roles.includes('SYSTEM_ADMIN') || perms.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) return;
  if (doc.ownerId && doc.ownerId === user.userId) return;

  const letter = await Letter.findOne({
    where: { documentId: doc.id, status: 'PENDING_SIGNATURE' },
    attributes: ['id', 'createdBy', 'signatoryUserId'],
  });
  if (letter && (letter.createdBy === user.userId || letter.signatoryUserId === user.userId || perms.includes(PERMISSIONS.LETTER_APPROVE))) {
    return;
  }

  const acl = await resolveACL({
    resourceType: 'document',
    resourceId: doc.id,
    permission: PERMISSIONS.DOCUMENT_UPLOAD,
    userId: user.userId,
    userRole: roles[0] ?? user.role,
    userRoles: roles,
    userPermissions: perms,
    tenantId: user.tenantId,
  });
  if (acl.allowed) return;

  const chains = await ApprovalChain.findAll({
    where: { tenantId: user.tenantId, itemType: 'DOCUMENT', itemId: doc.id, status: 'APPROVED' },
    attributes: ['id'],
    raw: true,
  });
  if (chains.length > 0) {
    const approved = await ApprovalStep.findOne({
      where: { chainId: { [Op.in]: chains.map((c) => c.id) }, stepType: 'APPROVE', status: 'APPROVED', decidedBy: user.userId },
      attributes: ['id'],
    });
    if (approved) return;
  }

  throw new AppError(
    403,
    'ERR-SIGNING-NOT-PERMITTED',
    'Only the document owner, a document administrator, someone granted write access, or the approver of this document can send it for signature.',
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Platform audit finding (2026-08-14, HIGH, follow-up): this only checked
// tenantId — unlike the sibling GET/POST /documents/:documentId/signing
// routes (esigning.routes.ts), which got a requireACL('document:read') gate
// per "Platform audit finding 4.2", every route keyed by requestId
// (GET /signing/:requestId, POST .../send, POST .../remind — all three
// funnel through this one function) had no per-document ACL check at all.
// SIGNING_READ/SIGNING_MANAGE are tenant-wide permissions held by nearly
// every role, so any tenant user who obtained a requestId (a URL, an email
// header, a log line) could read another department's full signature
// request — recipient names/emails and signed field values — or a
// SIGNING_MANAGE holder could send/remind a draft/sent request for a
// document their folder ACL should hide, entirely bypassing the same
// document:read check the sibling routes enforce. Those sibling routes
// resolve their ACL via requireACL's paramName option, which only works
// because THEY carry a literal documentId route param — these requestId-
// keyed routes don't, so the check has to happen here, after resolving
// requestId -> documentId, not as route middleware. Fixing this one shared
// choke point covers all three call sites (getSignatureRequest,
// sendSignatureRequest, remindSignatureRequest) at once.
async function loadRequest(requestId: string, user: AuthenticatedUser): Promise<SignatureRequest> {
  const request = await SignatureRequest.findByPk(requestId, {
    include: [
      { model: Document, as: 'document', attributes: ['tenantId', 'departmentId', 'documentName', 'latestVersionId'] },
      { model: SignatureRecipient, as: 'recipients' },
      { model: SignatureField, as: 'fields' },
    ],
  });
  if (!request) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
  if (((request as any).document as Document)?.tenantId !== user.tenantId) {
    throw new AppError(403, 'ERR-FORBIDDEN', 'Access denied');
  }
  await assertACLAllow(
    user.userId,
    user.roles,
    user.tenantId,
    { resourceType: 'document', resourceId: request.documentId, permission: PERMISSIONS.DOCUMENT_READ },
    user.permissions,
  );
  return request;
}

/**
 * Who may act on a request as its OWNER (send it, remind its signers, cancel it):
 * the person who created it, or a SYSTEM_ADMIN. Until now loadRequest's
 * document:read ACL was the only gate, and every employee holds signing:manage, so
 * any colleague who could merely READ the document could send, remind or (draft)
 * hijack someone else's request — and sending flips the document into
 * PENDING_SIGNATURE. Letters are unaffected: they create and send as the same user.
 */
function assertCanManageRequest(request: SignatureRequest, user: AuthenticatedUser): void {
  if (request.createdBy && request.createdBy === user.userId) return;
  if ((user.roles ?? []).includes('SYSTEM_ADMIN')) return;
  throw new AppError(403, 'ERR-FORBIDDEN', 'Only the person who created this signature request can do that');
}

// ── Cancel / void ────────────────────────────────────────────────────────────

/**
 * The requester withdraws a request that is not finished: draft, sent or partially
 * signed -> 'voided'. There was NO way to do this (the only route to 'voided' was a
 * recipient declining), so a request sent to the wrong person, or one a signer was
 * ignoring, stayed live until its expiry — blocking any new request on the same
 * document (one live ceremony per document) and leaving external links usable.
 * Every recipient's token stops working with the status (sign/decline/document all
 * require a live or completed request).
 */
export async function cancelSignatureRequest(requestId: string, reason: string, user: AuthenticatedUser, meta?: RequestMeta): Promise<SignatureRequest> {
  const preload = await loadRequest(requestId, user);
  assertCanManageRequest(preload, user);

  const { request, wasLive } = await runInTransaction(async (tx) => {
    const locked = await SignatureRequest.findByPk(requestId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!locked) throw new AppError(404, 'ERR-NOT-FOUND', 'Signature request not found');
    if (!['draft', ...LIVE_REQUEST_STATUSES].includes(locked.status)) {
      throw new AppError(409, 'ERR-INVALID-STATE', `A ${locked.status} signature request cannot be cancelled`);
    }
    const live = LIVE_REQUEST_STATUSES.includes(locked.status);
    await locked.update(
      { status: 'voided', voidedReason: `Cancelled by the requester${reason ? `: ${reason}` : ''}` },
      { transaction: tx },
    );
    // Same lifecycle rule as a decline/expiry: a document parked in PENDING_SIGNATURE for
    // THIS ceremony returns to SIGNING_DECLINED, from which a fresh request can be sent.
    if (live) {
      const doc = await Document.findByPk(locked.documentId, { transaction: tx });
      if (doc?.status === 'PENDING_SIGNATURE') await doc.update({ status: 'SIGNING_DECLINED' }, { transaction: tx });
    }
    // E27: tell whoever is waiting on this ceremony (letters), atomically with the cancel.
    await emitCeremonyEnded(
      {
        requestId, documentId: locked.documentId, tenantId: user.tenantId,
        outcome: 'cancelled', reason: reason || null, actorUserId: user.userId, recipientId: null,
      },
      tx,
    );
    return { request: locked, wasLive: live };
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    documentId: request.documentId,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { action: 'signature_request_cancelled', requestId, reason: reason || null, wasLive, ...metaDetails(meta) },
  });

  const recipients = (preload as any).recipients as SignatureRecipient[];
  await emitSigningUpdated(request.documentId, user.tenantId, 'cancelled', [
    user.userId,
    ...recipients.filter((r) => r.dmsUserId).map((r) => r.dmsUserId as string),
  ]);
  return request;
}

// ── Per-request audit trail ──────────────────────────────────────────────────

export interface SigningAuditEntry {
  id: string;
  at: Date;
  /** The recorded action (`signature_request_sent`, `document_signed_completed`, ...). */
  action: string;
  success: boolean;
  /** The internal user who acted; null for an external signer or the system. */
  actor: { userId: string; name: string | null; role: string | null } | null;
  /** An external signer's (masked) address, when the actor was one. */
  externalSigner: string | null;
  recipientId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Free-text facts worth showing next to the action (decline/cancel reason, version number, ...). */
  detail: string | null;
}

/**
 * Everything that happened to one signature request — created, sent, reminded, viewed, signed,
 * declined, cancelled, expired, signed copy filed, and every REFUSED token attempt — in order, with
 * who, when, from which address and which browser. Backed by the document's hash-chained audit log
 * (rows whose details carry this request id); there is no separate table to drift.
 *
 * Who may read it: it carries signers' addresses and browsers, so beyond the document:read the
 * request detail needs, the caller must be the request's creator, a SYSTEM_ADMIN, or an oversight
 * holder (document:read_all or audit:read).
 */
export async function getSignatureRequestAuditTrail(requestId: string, user: AuthenticatedUser): Promise<SigningAuditEntry[]> {
  const request = await loadRequest(requestId, user);
  const roles = user.roles ?? [];
  const perms = user.permissions ?? [];
  const privileged =
    request.createdBy === user.userId ||
    roles.includes('SYSTEM_ADMIN') ||
    perms.includes(PERMISSIONS.DOCUMENT_READ_ALL) ||
    perms.includes(PERMISSIONS.AUDIT_READ);
  if (!privileged) {
    throw new AppError(403, 'ERR-FORBIDDEN', 'Only the requester, an administrator or an auditor can see the audit trail of a signature request');
  }

  const rows = await AuditLog.findAll({
    where: {
      documentId: request.documentId,
      tenantId: user.tenantId,
      actionDetails: { [Op.like]: `%${requestId}%` },
    },
    order: [['sequenceNumber', 'ASC']],
    limit: 1000,
  });

  const parsed = rows.flatMap((row) => {
    let details: Record<string, any> = {};
    try {
      details = JSON.parse(row.actionDetails) ?? {};
    } catch {
      return [];
    }
    return details.requestId === requestId ? [{ row, details }] : [];
  });

  const actorIds = [...new Set(parsed.map((p) => p.row.userId).filter((id): id is string => !!id))];
  const actors = actorIds.length
    ? await User.findAll({ where: { id: { [Op.in]: actorIds } }, attributes: ['id', 'firstName', 'lastName'], raw: true })
    : [];
  const nameById = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));

  return parsed.map(({ row, details }) => {
    const facts: string[] = [];
    if (details.reason) facts.push(String(details.reason));
    if (details.versionNumber) facts.push(`version ${details.versionNumber}`);
    if (details.attempt) facts.push(`on ${details.attempt}`);
    if (details.recipientCount != null) facts.push(`${details.recipientCount} recipient(s)`);
    return {
      id: row.id,
      at: row.timestamp,
      action: String(details.action ?? row.eventType),
      success: row.isSuccess !== false,
      actor: row.userId ? { userId: row.userId, name: nameById.get(row.userId) ?? null, role: row.userRole ?? null } : null,
      externalSigner: details.externalSigner ? String(details.externalSigner) : null,
      recipientId: details.recipientId ? String(details.recipientId) : null,
      ipAddress: row.sourceIp ?? (details.ipAddress ? String(details.ipAddress) : null),
      userAgent: details.userAgent ? String(details.userAgent) : null,
      detail: facts.length ? facts.join(' · ') : null,
    };
  });
}

// ── Tenant-wide oversight list ───────────────────────────────────────────────

const REQUEST_STATUSES = ['draft', 'sent', 'partially_signed', 'completed', 'voided', 'expired'] as const;

/**
 * Read-only list of EVERY signature request in the tenant with its status, for the oversight roles
 * (document:read_all — executive, auditor, records officer, system administrator). The other three
 * lists are always the caller's own requests or tasks; this one is not scoped to the caller. It
 * returns summaries (document name, creator, recipients and their state); tokens never appear.
 */
export async function listAllSignatureRequests(
  user: AuthenticatedUser,
  opts: { skip?: number; take?: number; status?: string; q?: string } = {},
): Promise<{ data: Array<Record<string, unknown>>; total: number }> {
  const roles = user.roles ?? [];
  if (!roles.includes('SYSTEM_ADMIN') && !(user.permissions ?? []).includes(PERMISSIONS.DOCUMENT_READ_ALL)) {
    throw new AppError(403, 'ERR-FORBIDDEN', 'The tenant-wide signing overview is for oversight roles only');
  }
  const take = Math.min(100, Math.max(1, opts.take ?? 25));
  const skip = Math.max(0, opts.skip ?? 0);
  const term = opts.q?.trim();
  const where: any = {};
  if (opts.status) {
    if (!(REQUEST_STATUSES as readonly string[]).includes(opts.status)) {
      throw new AppError(422, 'ERR-VALIDATION', 'Unknown status filter');
    }
    where.status = opts.status;
  }
  const { rows, count } = await SignatureRequest.findAndCountAll({
    where,
    include: [
      {
        model: Document,
        as: 'document',
        required: true,
        attributes: ['id', 'title', 'documentName'],
        where: {
          tenantId: user.tenantId,
          ...(term ? { [Op.or]: [{ title: { [Op.iLike]: `%${term}%` } }, { documentName: { [Op.iLike]: `%${term}%` } }] } : {}),
        },
      },
      { model: SignatureRecipient, as: 'recipients' },
    ],
    order: [['createdAt', 'DESC']],
    offset: skip,
    limit: take,
    distinct: true,
  });

  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((id): id is string => !!id))];
  const creators = creatorIds.length
    ? await User.findAll({ where: { id: { [Op.in]: creatorIds } }, attributes: ['id', 'firstName', 'lastName'], raw: true })
    : [];
  const nameById = new Map(creators.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const visibleCreatorIds = new Set(await withoutHiddenIds(creatorIds, user.userId));

  return {
    data: rows.map((r) => ({
      ...(r.toJSON() as Record<string, unknown>),
      createdByName: r.createdBy && visibleCreatorIds.has(r.createdBy) ? (nameById.get(r.createdBy) ?? null) : null,
    })),
    total: count,
  };
}
