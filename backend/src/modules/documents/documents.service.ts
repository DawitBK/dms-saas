import crypto from 'node:crypto';
import { literal, Op, QueryTypes, UniqueConstraintError, Transaction as SequelizeTransaction } from 'sequelize';
import type { Transaction } from 'sequelize';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import {
  AclEntry,
  ApprovalChain,
  ApprovalStep,
  ArchiveRecord,
  Department,
  DocLock,
  Document,
  DocumentCheckout,
  DocumentDek,
  DocumentMetadata,
  DocumentLegalHold,
  DocumentSequence,
  DocumentType,
  DocumentVersion,
  FolderNode,
  FormInstance,
  FormTemplate,
  LegalHold,
  OutboxEvent,
  PurgePending,
  RetentionPolicy,
  SignatureRecord,
  SignatureRequest,
  SignatureRecipient,
  SignatureField,
  AuditStageReview,
  sequelize,
  User,
  UserDepartment,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowTask,
} from '../../infrastructure/database/index.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import { serializeBigInt } from '../../shared/bigintJson.js';
import { encryptAndStore, fetchAndDecrypt, fetchDecryptStream } from './documentCrypto.js';
import { generateFlattenedUnsignedPdf, PADES_CHANGE_SUMMARY } from '../esigning/esignPades.js';
import {
  requireDocumentAccess,
  requireLegalHoldClear,
  assertNotTerminalState,
  assertNotTrashed,
  assertScanCleared,
} from '../../shared/documentGuards.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { PERMISSIONS, userHasPermission } from '../../config/permissions.js';
import {
  mandatoryMetadataFields,
  sha256,
  validateUploadInput,
} from './documentValidation.js';
import { validateTransition, requiredPermissionForManualTransition, MANUAL_TRANSITION_PERMISSIONS } from './DocumentStateMachine.js';
import { assertStatusPermission } from './statusPermissions.service.js';
import { resolveACLBatch } from '../../shared/resolveACL.js';
import { CLASSIFIED_LEVELS, classificationLabel, holdsDepartmentManage, isClassified, letterBackedDocumentIds } from '../../shared/classifiedAccess.js';
import { assertCanManageDepartment } from '../../shared/orgScope.js';
import { grantExistingParticipantsRead } from '../approvals/classifiedParticipants.js';
import { getCachedUserDepartments, cacheUserDepartments, loadUserDepartmentIds } from '../../infrastructure/cache/userDeptCache.js';
import { validateUploadedFile as validateMimeAndExtension } from './mimeValidation.js';
import { writeIndexSidecar } from './indexSidecar.js';
import { sanitizeFilename } from '../../shared/sanitizeFilename.js';
import { departmentCodeNotRegistered } from '../../shared/departmentCodeError.js';
import { reserveStorageQuota } from './quotaService.js';
import { createQueue } from '../../infrastructure/queue/queues.js';
import { runInTransaction } from '../../shared/transaction.js';
import { applyRetention } from '../retention/retentionEngine.js';

const createDocumentSchema = z.object({
  title: z.string().min(1).max(255),
  // departmentId is the precise, collision-free field — department codes are
  // only unique per (tenant, org unit) as of migration
  // 20260912000001-department-code-scope-org-unit.sql, so two departments in
  // different org units can legitimately share a code (e.g. two "IT"
  // departments). Resolving by code alone (the old sole field) picked
  // whichever same-coded department Postgres happened to return first,
  // silently filing a genuine department member's upload into the WRONG
  // department's row and rejecting it with "not a member of this department"
  // — reproduced live: an IT member under one org unit was resolved to the
  // OTHER org unit's "IT" department and blocked. departmentCode is kept only
  // for backward compatibility with any caller that hasn't been updated to
  // send departmentId yet (see the departmentId-preferred resolution below).
  departmentId: z.string().uuid().optional(),
  departmentCode: z.string().min(2).max(10).optional(),
  documentTypeCode: z.string().min(2).max(10),
  organisationUnit: z.string().min(1).max(100),
  securityClassification: z.enum([
    'PUBLIC',
    'INTERNAL',
    'CONFIDENTIAL',
    'RESTRICTED',
  ]),
  retentionClass: z.string().min(1).max(50),
  source: z.enum([
    'MANUAL_UPLOAD',
    'SCANNER',
    'EMAIL',
    'API',
    'CREATED_IN_SYSTEM',
    'MIGRATION',
  ]),
  documentDate: z.coerce.date().optional(),
  retentionTriggerDate: z.coerce.date().optional(),
  keywords: z.string().optional(),
  description: z.string().optional(),
  language: z.string().max(10).optional(),
  originatingSystem: z.string().max(100).optional(),
  confidentialityNotice: z.string().max(500).optional(),
  geographicScope: z.string().max(100).optional(),
  externalReference: z.string().max(200).optional(),
  folderPath: z.string().optional(),
  changeSummary: z.string().max(2000).optional(),
}).refine((data) => Boolean(data.departmentId || data.departmentCode), {
  message: 'departmentId or departmentCode is required',
  path: ['departmentId'],
});

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
  // Present on request-derived principals (req.user); some internal/seed
  // callers construct a CurrentUser without it, so it is optional and treated
  // as "no permissions"/"single role" (default-deny) when absent.
  permissions?: readonly string[];
  roles?: readonly string[];
};

// S4-05: Encryption helpers (encryptAndStore / fetchAndDecrypt) live in
// ./documentCrypto.ts — the single canonical storage read/write path shared
// by uploads, previews, version restore, and seeders.

const ownerInclude = {
  model: User,
  as: 'owner',
  attributes: ['id', 'firstName', 'lastName', 'email'],
};

const getDocumentInclude = [
  { model: Department, as: 'department' },
  { model: DocumentType, as: 'documentType' },
  {
    model: DocumentVersion,
    as: 'versions',
    separate: true,
    order: [['createdAt', 'DESC']],
  },
  { model: DocumentMetadata, as: 'metadata' },
  {
    model: DocumentCheckout,
    as: 'checkout',
    include: [{ model: User, as: 'checkedOutByUser', attributes: ['id', 'firstName', 'lastName', 'email'] }],
  },
  ownerInclude,
  {
    model: WorkflowInstance,
    as: 'workflowInstances',
    separate: true,
    limit: 1,
    order: [['createdAt', 'DESC']],
    include: [
      { model: WorkflowDefinition, as: 'workflowDefinition' },
      { model: User, as: 'initiator', attributes: ['id', 'firstName', 'lastName', 'email'] },
      {
        model: WorkflowTask,
        as: 'tasks',
        separate: true,
        order: [['createdAt', 'DESC']],
      },
    ],
  },
  {
    model: SignatureRecord,
    as: 'signatures',
    separate: true,
    order: [['createdAt', 'DESC']],
    include: [
      { model: User, as: 'signatoryUser', attributes: ['id', 'firstName', 'lastName', 'email'] },
    ],
  },
  {
    // The real e-signing ceremony data (esigning module) — distinct from the
    // legacy `signatures`/SignatureRecord association above, which the
    // signing/ module still writes to but the current signing UI does not.
    model: SignatureRequest,
    as: 'signatureRequests',
    separate: true,
    order: [['createdAt', 'DESC']],
    include: [{ model: SignatureRecipient, as: 'recipients' }],
  },
  {
    model: DocumentLegalHold,
    as: 'legalHolds',
    separate: true,
    where: { removedAt: null },
    include: [{ model: LegalHold, as: 'legalHold' }],
  },
];

type DocumentRow = Document & {
  checkout?: DocumentCheckout | null;
  department?: Department;
  documentType?: DocumentType;
  versions?: DocumentVersion[];
};

/** Default ACLs for a newly created document. Before this, only SEEDED
 *  documents had ACL entries (the seed granted role reads per document) — a
 *  freshly uploaded document had none, so every non-admin (including the
 *  approvers and auditors the unified engine assigns) hit AUTHZ_ACL_NO_ENTRY
 *  on GET /documents/:id. Adds owner grants so the author can read/version/
 *  trash their own file, plus department-scoped read for everyone else who
 *  should plausibly see it. DENY-first semantics are unaffected — admins can
 *  still place DENYs that beat these ALLOWs.
 *
 *  FIX: this used to also grant document:read to an entire role — RECORDS_
 *  OFFICER/DEPT_MANAGER/APPROVER/EMPLOYEE/AUDITOR/EXECUTIVE — TENANT-WIDE.
 *  AclEntry has no department dimension on a role principal, so that grant
 *  applied to literally anyone in the tenant holding that role, regardless
 *  of which department they actually belong to: a Finance manager could
 *  open a Procurement document straight from Browse/Dashboard, no different
 *  department membership required. Caught live (a letters-module ACL grant
 *  copied this exact pattern; the underlying bug was here all along and
 *  affects every document ever created through this shared helper —
 *  documents.service.ts's own upload, tusUpload.ts, esigning.service.ts,
 *  forms.service.ts). Correct default: read access follows the document's
 *  own department — snapshot every CURRENT member of that department as an
 *  individual per-user ALLOW instead of a blanket role grant.
 *
 *  Known tradeoff, same one the owner grant already has: this is a snapshot
 *  at creation time, not a live membership check — someone who joins the
 *  department later doesn't retroactively gain access to older documents,
 *  and someone who leaves keeps what they already had. A fully live check
 *  would need resolveACL itself extended with a department-membership rule
 *  — a separate, larger change to the platform's hottest authorization
 *  path, not something to fold into this fix silently. */
export async function grantDefaultDocumentAcl(
  documentId: string,
  ownerId: string,
  tenantId: string,
  departmentId: string,
  tx?: Transaction,
  options: {
    /** Letters (L14): a CONFIDENTIAL/RESTRICTED letter's backing documents are participants-only, so the
     *  department-member read snapshot is not written. The owner and RECORDS_OFFICER purge grants stay. */
    withholdDepartmentSnapshot?: boolean;
  } = {},
) {
  const rows: Array<Record<string, unknown>> = [];
  // H8: records officers can purge any document tenant-wide (subject to the
  // maker–checker rule + legal hold) — a deliberate, documented cross-
  // department capability for the records-management/compliance function
  // specifically, not the same category of bug as the blanket read grant
  // this replaced. Purge is also far more consequential to over-grant than
  // read, so it stays tightly limited to this one role/permission pair.
  rows.push({
    tenantId, resourceType: 'document', resourceId: documentId,
    principalType: 'role', principalId: 'RECORDS_OFFICER',
    effect: 'ALLOW', permission: 'document:purge', grantedById: ownerId,
  });
  // document:checkout: without it nobody but an admin could check a document out, and a new version
  // can only be uploaded by whoever holds the checkout (uploadVersion), so owners could never version their own file.
  for (const permission of ['document:read', 'document:upload', 'document:archive', 'document:checkout']) {
    rows.push({
      tenantId, resourceType: 'document', resourceId: documentId,
      principalType: 'user', principalId: ownerId,
      effect: 'ALLOW', permission, grantedById: ownerId,
    });
  }
  const deptMembers = options.withholdDepartmentSnapshot
    ? []
    : await UserDepartment.findAll({ where: { departmentId }, attributes: ['userId'], transaction: tx });
  for (const member of deptMembers) {
    if (member.userId === ownerId) continue; // already granted above
    rows.push({
      tenantId, resourceType: 'document', resourceId: documentId,
      principalType: 'user', principalId: member.userId,
      effect: 'ALLOW', permission: 'document:read', grantedById: ownerId,
      // Marks this as a department snapshot (bound by resolveACL's live department check), as opposed to a
      // deliberate grant, which stays valid outside the department. See migration 20261004000010.
      origin: 'DEPT_SNAPSHOT',
    });
  }
  await AclEntry.bulkCreate(rows as never[], { transaction: tx, ignoreDuplicates: true });
}

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

// Exported so other filing paths that need the same "DEPT-TYPE-YYYYMMDD-NNNN"
// naming scheme (e.g. esigning.service.ts's upload-and-sign flow) reuse the
// canonical allocator instead of inventing their own numbering.
export async function nextDocumentName(
  tx: Transaction,
  deptCode: string,
  docTypeCode: string,
) {
  const key = dateKey();
  // FIX (platform audit finding 4.4): findOrCreate + a separate .update()
  // with no row lock let two concurrent uploads for the same dept/type/day
  // both read the same lastSeq and both compute the same next number — one
  // upload then fails on the (tenant_id, document_name) unique constraint
  // instead of gracefully getting the next number in line. Same fix as
  // letters.service.ts's gap-free letter_sequences counter: an
  // INSERT ... ON CONFLICT DO NOTHING guarantees the row exists without a
  // race, then SELECT ... FOR UPDATE actually serializes concurrent callers
  // on it for the rest of this transaction.
  await sequelize.query(
    `INSERT INTO document_sequences (dept_code, doc_type_code, date_key, last_seq)
     VALUES (:deptCode, :docTypeCode, :dateKey, 0)
     ON CONFLICT (dept_code, doc_type_code, date_key) DO NOTHING`,
    { replacements: { deptCode, docTypeCode, dateKey: key }, transaction: tx },
  );
  const seq = await DocumentSequence.findOne({
    where: { deptCode, docTypeCode, dateKey: key },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!seq) throw new AppError(500, "ERR-SEQUENCE-MISSING", "Document sequence row missing");

  // Documents created outside this allocator (seed fixtures, imports) carry
  // explicit names but never advance this counter, and the (tenant_id,
  // document_name) unique key would reject a reissued number — trashed rows
  // still hold their names. Align with the max sequence already visible for
  // this prefix (raw query: sees soft-deleted rows too; under RLS it is
  // tenant-scoped, which is exactly the uniqueness scope). Safe to read
  // without its own lock — the sequence row above is already locked for the
  // rest of this transaction, and this only ever pushes lastSeq forward.
  const prefix = `${deptCode}-${docTypeCode}-${key}-`;
  const [existing] = await sequelize.query<{ max_seq: number | null }>(
    `SELECT MAX((substring(document_name from '[0-9]+$'))::int) AS max_seq
     FROM documents WHERE document_name LIKE :prefix`,
    { replacements: { prefix: `${prefix}%` }, type: QueryTypes.SELECT, transaction: tx },
  );
  const maxExisting = Number(existing?.max_seq ?? 0);
  let lastSeq = seq.lastSeq + 1;
  if (maxExisting >= lastSeq) lastSeq = maxExisting + 1;
  await seq.update({ lastSeq }, { transaction: tx });
  if (lastSeq >= 9000)
    logger.warn(
      { deptCode, docTypeCode, dateKey: key, lastSeq },
      'document sequence nearing limit',
    );
  const width = lastSeq > 9999 ? 5 : 4;
  return `${deptCode}-${docTypeCode}-${key}-${String(lastSeq).padStart(width, '0')}`;
}

/** documents.service.ts's own cache-then-DB user-department lookup (same
 *  4-line pattern as letters.service.ts's local getUserDepartmentIds and
 *  resolveACL.ts's — not centralized into userDeptCache.ts itself to avoid
 *  touching that module's public surface for this fix). */
async function getUserDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const cached = await getCachedUserDepartments(tenantId, userId);
  if (cached) return cached;
  const departmentIds = await loadUserDepartmentIds(tenantId, userId);
  await cacheUserDepartments(tenantId, userId, departmentIds);
  return departmentIds;
}

/** FIX: `departmentId` used to be accepted and silently ignored (param
 *  literally named `_departmentId` to mark it unused) — the comment here
 *  used to read "SPRINT-1: departmentIds removed from JWT. In Sprint 1, we
 *  rely on role and later ACL/RLS", and that "later" fix never happened.
 *  The only check was "does this role hold document:upload at all" — a
 *  permission virtually every employee has — so any authenticated user
 *  could upload straight into ANY department by typing a different
 *  department code into the upload form, IT staff into EXECUTIVE included.
 *  Caught live. Now actually checks the user belongs to the target
 *  department, with ACL_BYPASS_ADMIN (true super-admin, held by no seeded
 *  role today) as the sole override — mirrors the same department-
 *  membership model this session's other ACL fixes already use. */
export async function ensureCanCreate(user: CurrentUser, departmentId: string) {
  // §1: permission-based — must have DOCUMENT_UPLOAD
  if (!userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_UPLOAD)) {
    throw new AppError(
      403,
      'ERR-PERMISSION-DENIED',
      'Role cannot create documents',
    );
  }
  if (userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.ACL_BYPASS_ADMIN)) {
    return;
  }
  const deptIds = await getUserDepartmentIds(user.tenantId, user.userId);
  if (!deptIds.includes(departmentId)) {
    throw new AppError(
      403,
      'ERR-DEPT-SCOPE',
      'You are not a member of this department and cannot upload documents into it',
    );
  }
}

/** A document type is usable by the department it names, by every department under the org unit it names, or by
 *  everyone when it names neither (tenant-wide). Shared by the buffered upload and the resumable (tus) upload —
 *  the tus path used to skip it, so any type could be filed under any department by a large-file upload. */
export function assertDocumentTypeInScope(
  documentType: { departmentId?: string | null; orgUnitId?: string | null },
  department: { id: string; orgUnitId?: string | null },
  user: CurrentUser,
) {
  const inScope =
    (!documentType.departmentId && !documentType.orgUnitId) || // TENANT (global)
    documentType.departmentId === department.id || // DEPARTMENT
    (!!documentType.orgUnitId && documentType.orgUnitId === department.orgUnitId); // ORG_UNIT
  if (
    !inScope &&
    !userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.ACL_BYPASS_ADMIN)
  ) {
    throw new AppError(
      403,
      'ERR-DOCTYPE-SCOPE',
      'This document type is not available for the selected department',
    );
  }
}

export async function createDocument(
  input: unknown,
  file: Express.Multer.File | undefined,
  user: CurrentUser,
) {
  if (!file)
    throw new AppError(422, 'ERR-FILE-MISSING', 'Document file is required');
  await validateUploadInput(input as Record<string, unknown>, file);
  const data = createDocumentSchema.parse(input);

  // BUG 4 FIX: Removed pre-flight quota check - now done atomically in transaction

  // S4-07: MIME validation
  await validateMimeAndExtension(file.buffer, file.originalname);

  const [department, documentType, retentionPolicy] = await Promise.all([
    data.departmentId
      ? Department.findOne({ where: { id: data.departmentId, tenantId: user.tenantId } })
      : Department.findOne({ where: { code: data.departmentCode!.toUpperCase(), tenantId: user.tenantId } }),
    DocumentType.findOne({
      where: { code: data.documentTypeCode.toUpperCase(), tenantId: user.tenantId },
    }),
    RetentionPolicy.findOne({ where: { code: data.retentionClass } }),
  ]);
  if (!department) {
    // A departmentId that resolved to nothing (wrong tenant, or a stale/
    // deleted id) has no "code" to name in the diagnostic below — it's a
    // different failure mode than a legacy caller's unregistered code.
    if (data.departmentId) {
      throw new AppError(422, 'ERR-DEPT-INVALID', 'Selected department was not found in your organization');
    }
    // Names the rejected code in the response and logs it next to the codes
    // this tenant actually has — see shared/departmentCodeError.ts for the
    // incident that made a code-less rejection expensive to diagnose.
    throw await departmentCodeNotRegistered(data.departmentCode, user, {
      route: 'POST /documents',
      lookedUpAs: data.departmentCode!.toUpperCase(),
    });
  }
  if (!documentType)
    throw new AppError(
      422,
      'ERR-DOCTYPE-INVALID',
      'Document type code is not registered',
    );
  if (!retentionPolicy)
    throw new AppError(
      422,
      'ERR-RETENTION-INVALID',
      'Retention class is not registered',
    );
  // FIX: a scoped document type was resolved purely by tenant-wide code
  // lookup above and never cross-checked against the target department —
  // the Upload wizard's dropdown filters to the caller's own department
  // client-side, but nothing stopped a direct/crafted request from
  // submitting any other department's (or org unit's) type code and having
  // it persist. DocumentType has a tri-level scope, most-specific first:
  // departmentId set -> usable only by that exact department; else
  // orgUnitId set -> usable by any department under that org unit; both
  // null -> tenant-wide global, usable by every department. Mirrors
  // listDocumentTypesForDepartment's own visibility rule exactly.
  // ACL_BYPASS_ADMIN is the same sole override ensureCanCreate below already
  // grants for department membership.
  assertDocumentTypeInScope(documentType, department, user);
  await ensureCanCreate(user, department.id);

  let folderId: string | null = null;
  if (data.folderPath) {
    const folder = await FolderNode.findOne({
      where: {
        path: data.folderPath,
        tenantId: user.tenantId,
        isActive: true,
      },
    });
    if (!folder) {
      throw new AppError(
        422,
        'ERR-FOLDER-INVALID',
        'Selected folder path is not valid for this tenant',
      );
    }
    
    // Validate that folder's department matches document's department
    if (folder.departmentId && folder.departmentId !== department.id) {
      throw new AppError(
        422,
        'ERR-FOLDER-DEPARTMENT-MISMATCH',
        `Folder belongs to a different department. Folder department: ${folder.departmentId}, Document department: ${department.id}`,
      );
    }
    
    folderId = folder.id;
  }

  const hash = sha256(file.buffer); // Plaintext hash for duplicate detection

  // S4-09: Async virus scan for files > 100 MB, sync scan for smaller files
  const ASYNC_SCAN_THRESHOLD = 100 * 1024 * 1024; // 100 MB
  const useAsyncScan = file.size > ASYNC_SCAN_THRESHOLD;

  // Async path (ScanWorker) hasn't scanned yet at all when this row is
  // created — 'unscanned' is the honest starting state, corrected to
  // 'clean' (or QUARANTINED) once the job actually runs.
  let avScanStatus: 'clean' | 'unscanned' = 'unscanned';
  if (!useAsyncScan) {
    avScanStatus = await scanBuffer(file.buffer);
  }

  // BUG 2 FIX: Check duplicate against plaintext hash
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

  // WARN-DUPLICATE-DETECTED surfacing: the upload is never blocked on a
  // duplicate (see the `duplicate` lookup above), but the API response and
  // audit log should say WHICH document it duplicates, not just that it does
  // — a bare boolean warning was silently swallowed by the frontend today.
  // Cheap PK lookup, only ever runs on the rare duplicate-hash path.
  const duplicateDocInfo = duplicate
    ? await Document.findByPk(duplicate.documentId, {
        attributes: ['title', 'documentName'],
      })
    : null;

  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  // TEN-3: tenantId segment added so a leaked MinIO credential or a future
  // route bug has no cross-tenant path to walk — department/doc-type codes
  // and UUIDs alone gave the shared bucket no independent tenant boundary of
  // its own. Purely additive: storageKey is always read back verbatim from
  // the DB row it's stored on (fetchAndDecrypt etc. never reconstruct a key
  // from parts), so this needs no migration of any existing object.
  const storageKey = `${user.tenantId}/${department.code}/${documentType.code}/${documentId}/${versionId}/${sanitizeFilename(file.originalname)}`;

  // S4-05: Encrypt and store
  const {
    encryptedKey,
    sha256Hash: encHash,
    kekId,
  } = await encryptAndStore(
    storageKey,
    file.buffer,
    file.mimetype,
    department.id,
    user.tenantId,
  );

  const document = await sequelize.transaction(
    { isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.SERIALIZABLE },
    async (tx: Transaction) => {
      // FIX: this deliberately stays a standalone transaction (see
      // shared/transaction.ts's runInTransaction doc comment) because it
      // needs SERIALIZABLE isolation for the atomic quota reservation below,
      // which reusing the request's default-isolation transaction would
      // silently downgrade. Being standalone means it's a second connection
      // that the request-level tenantContext middleware never touches, so it
      // must set its own tenant GUC as its first statement — otherwise it
      // would be invisible/unwritable to RLS-protected tables the day the DB
      // role is switched away from superuser, same as every other bare
      // sequelize.transaction() call this audit found.
      await sequelize.query(`SET LOCAL app.current_tenant = :tenantId`, {
        transaction: tx,
        replacements: { tenantId: user.tenantId },
      });

      // BUG 4 FIX: Atomically reserve storage quota within transaction
      await reserveStorageQuota(user.tenantId, file.size, tx);
      
      const documentName = await nextDocumentName(
        tx,
        department.code,
        documentType.code,
      );
      await Document.create(
        {
          id: documentId,
          tenantId: user.tenantId,
          documentName,
          title: data.title,
          departmentId: department.id,
          documentTypeId: documentType.id,
          folderId,
          ownerId: user.userId,
          organisationUnit: data.organisationUnit,
          status: useAsyncScan ? 'SCAN_PENDING' : 'DRAFT', // S4-09: async-scanned large files await ScanWorker promotion
          approvalStatus: documentType.requiresSignature
            ? 'PENDING'
            : 'NOT_REQUIRED',
          securityClassification: data.securityClassification,
          sensitivityLabel: classificationLabel(data.securityClassification), // derived from the class (the database trigger does the same)
          retentionClass: data.retentionClass,
          documentDate: data.documentDate ?? null,
          retentionTriggerDate: data.retentionTriggerDate ?? null,
          source: data.source,
          latestVersionId: versionId,
        },
        { transaction: tx },
      );
      await DocumentMetadata.create(
        {
          documentId,
          keywords: data.keywords ?? null,
          description: data.description ?? null,
          language: data.language ?? null,
          originatingSystem: data.originatingSystem ?? null,
          confidentialityNotice: data.confidentialityNotice ?? null,
          geographicScope: data.geographicScope ?? null,
          externalReference: data.externalReference ?? null,
        },
        { transaction: tx },
      );
      await DocumentVersion.create(
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
          sha256Hash: encHash, // Ciphertext hash (for storage integrity)
          plaintextSha256: hash, // BUG 2 FIX: Plaintext hash (for duplicate detection & content integrity)
          authorId: user.userId,
          changeSummary: data.changeSummary ?? 'Initial upload',
          avScanStatus,
        },
        { transaction: tx },
      );

      // S4-05: Store encrypted DEK (keyed by versionId — one DEK per version)
      await DocumentDek.create(
        {
          documentId,
          versionId,
          encryptedDek: encryptedKey,
          kekId,
          algorithm: 'AES-256-GCM',
        },
        { transaction: tx },
      );

      await OutboxEvent.bulkCreate(
        [
          {
            documentId,
            type: 'DOCUMENT.CREATED',
            channel: 'WEBSOCKET',
            // tenantId/departmentId are load-bearing, not decoration: without a
            // departmentId the WEBSOCKET dispatch has no room to route to (the
            // event was silently dropped), and without payload.tenantId the
            // webhook fan-out falls back to a documents read the dispatcher
            // cannot make under the RLS-enforcing non-superuser role.
            payload: JSON.stringify({ documentId, tenantId: user.tenantId, departmentId: department.id }),
          },
          {
            documentId,
            type: 'OCR_PROCESSING',
            channel: 'OCR',
            payload: JSON.stringify({ documentId, versionId, tenantId: user.tenantId }),
          },
          {
            documentId,
            type: 'SEARCH_INDEX',
            channel: 'SEARCH_INDEX',
            payload: JSON.stringify({ documentId, tenantId: user.tenantId }),
          },
        ],
        { transaction: tx },
      );

      // Retention engine (gap #1): start the retention clock at creation so
      // disposalEligibleDate and the 90/30-day warning row actually exist.
      await applyRetention(documentId, tx);

      // Default ACLs — without these only admins could open the new document.
      await grantDefaultDocumentAcl(documentId, user.userId, user.tenantId, department.id, tx);
      const created = await Document.findByPk(documentId, {
        include: [
          { model: DocumentVersion, as: 'versions' },
          { model: DocumentMetadata, as: 'metadata' },
          { model: Department, as: 'department' },
          { model: DocumentType, as: 'documentType' },
        ],
        transaction: tx,
      });
      if (!created)
        throw new AppError(
          500,
          'ERR-DOCUMENT-CREATE',
          'Failed to load created document',
        );

      // This upload uses a deliberate standalone SERIALIZABLE transaction for
      // quota correctness. Keep its audit entries in that same transaction so
      // a process crash can never commit a document without its audit trail.
      await writeAuditLog({
        eventType: AUDIT_EVENTS.DOC_CREATE,
        tenantId: user.tenantId,
        userId: user.userId,
        userRole: user.role,
        documentId,
        actionDetails: {
          documentName: created.documentName,
          duplicateOf: duplicate?.documentId ?? null,
        },
      }, tx);

      if (avScanStatus === 'unscanned') {
        await writeAuditLog({
          eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
          tenantId: user.tenantId,
          userId: user.userId,
          userRole: user.role,
          documentId,
          actionDetails: { versionId, reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
        }, tx);
      }

      return created;
    },
  );

  // BUG 4 FIX: Removed separate incrementStorageUsed - now done atomically in transaction above

  // S4-06: Write index.json sidecar
  await writeIndexSidecar(storageKey, {
    documentId,
    versionId,
    filename: file.originalname,
    mimeType: file.mimetype,
    sensitivityLabel: classificationLabel(data.securityClassification),
    sha256: encHash,
    kekId,
    createdAt: new Date().toISOString(),
    createdBy: user.userId,
  });

  // S4-09: Enqueue async virus scan for large files
  if (useAsyncScan) {
    const scanQueue = createQueue('VIRUS_SCAN');
    if (scanQueue) {
      await scanQueue.add('scan-document', {
        documentId,
        versionId,
        storageKey,
        tenantId: user.tenantId,
        userId: user.userId,
        userRole: user.role,
      });
      logger.info(
        { documentId, fileSize: file.size },
        'Enqueued async virus scan for large file',
      );
    } else {
      logger.warn(
        { documentId },
        'Scan queue unavailable, document status remains scan_pending',
      );
    }
  }

  return serializeBigInt({
    ...document.get({ plain: true }),
    warnings: [
      ...(duplicate ? ['WARN-DUPLICATE-DETECTED'] : []),
      ...(avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : []),
    ],
    duplicateOf: duplicate?.documentId ?? null,
    duplicateOfTitle: duplicateDocInfo?.title ?? null,
    duplicateOfDocumentName: duplicateDocInfo?.documentName ?? null,
  });
}

export type ListDocumentsFilters = {
  folderId?: string;
  status?: string;
  departmentId?: string;
  documentTypeId?: string;
  q?: string;
  // "My Files" page filter — an exact ownerId match, still subject to the same
  // per-user read scope (buildReadScope) as every other listDocuments call.
  ownerId?: string;
  // Only documents currently checked out (have a DocumentCheckout row). Backs the
  // "Checked Out" tab on My Files, which was previously fed by an unpaginated
  // top-50 feed AND could never populate — the list include didn't fetch checkout
  // data at all, so every row's `checkout` was undefined.
  checkedOut?: boolean;
  // Comma-separated OCR statuses (e.g. "LOW_CONFIDENCE"). Backs the OCR Review
  // panel so it can page server-side instead of filtering a capped feed.
  ocrStatus?: string;
  // "Retention" view of the Records Officer console: documents that are either
  // pending disposal OR carry a retention class. Matches the previous client-side
  // filter (`status === 'DISPOSAL_PENDING' || d.retentionClass`) exactly, so it
  // can be paged server-side.
  retentionRelevant?: boolean;
  /** Include the internal artifacts that back a letter's signature.
   *
   *  Off by default. See the exclusion in listDocuments — these are real,
   *  retained documents, they just are not separate items in the library. */
  includeLetterSignedDrafts?: boolean;
  // Folder-browse date filters (e.g. "this week/month/year" presets computed
  // client-side) — same semantics as search.service.ts's dateFrom/dateTo,
  // ranged over createdAt.
  dateFrom?: string;
  dateTo?: string;
  // Folder-browse sort controls. Both are validated against an allow-list
  // below and silently fall back to the pre-existing default (updatedAt DESC)
  // for anything else, so this can never produce an invalid Sequelize order
  // clause or change behavior for any existing caller that omits them.
  sortBy?: string;
  sortDir?: string;
  // Keyset-pagination continuation token (see encodeDocumentCursor /
  // decodeDocumentCursor below), from a previous response's `nextCursor`.
  // Additive: passing this instead of relying on `skip` avoids the classic
  // offset-pagination failure mode — a row inserted/deleted by a concurrent
  // write shifting every subsequent page's boundary — since the underlying
  // table receives continuous outbox-driven writes (indexing, OCR) alongside
  // ordinary uploads. `skip`/`take` keep working exactly as before for any
  // caller that doesn't pass a cursor.
  cursor?: string;
};

const SORTABLE_DOCUMENT_COLUMNS = new Set(['updatedAt', 'createdAt', 'title']);

interface DocumentCursor { v: string; id: string }

/** Encodes the (sortColumn value, id) pair a keyset page ended on into an
 *  opaque, URL-safe token. `id` is a UUID (not itself orderable), so it's
 *  used only as the tiebreaker for rows sharing the same sortColumn value. */
function encodeDocumentCursor(row: Record<string, unknown> & { id: string }, sortColumn: string): string {
  const raw = row[sortColumn];
  const v = raw instanceof Date ? raw.toISOString() : String(raw);
  return Buffer.from(JSON.stringify({ v, id: row.id } satisfies DocumentCursor), 'utf8').toString('base64url');
}

function decodeDocumentCursor(token: string): DocumentCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.v === 'string' && typeof parsed.id === 'string') return parsed as DocumentCursor;
  } catch {
    // malformed/tampered cursor — treated as "no cursor" below, not a 500
  }
  return null;
}

/**
 * C6: build a per-user read scope for document LISTING/STATS. A user WITHOUT
 * `document:read_all` must only see documents they can actually read; before
 * this, list/stats returned every document in the tenant (titles, owners,
 * keywords) regardless of department or ACL, even though GET /:id was gated.
 *
 * Visible set = owner OR in one of the user's departments (direct membership only)
 * OR an explicit ALLOW ACL on the document or its folder (for the user or any
 * of their roles), MINUS any explicit user/role DENY on the document. This
 * reuses resolveACL's building blocks; full folder-ancestry/access-rule
 * resolution still runs on GET /:id. It errs toward showing fewer rows, never
 * more. Returns null when the user has oversight scope (no filtering).
 */
async function buildReadScope(user: CurrentUser): Promise<Record<string | symbol, unknown> | null> {
  if (userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_READ_ALL)) {
    return null;
  }
  // Departments the user belongs to — DIRECT membership only. Belonging to a parent department does not reach its
  // sub-departments' documents (owner decision 2026-10-09); a person who needs a sub-department is made a member of it.
  const memberDepts = await UserDepartment.findAll({
    where: { userId: user.userId },
    attributes: ['departmentId'],
    raw: true,
  });
  const deptIds = memberDepts.map((d) => d.departmentId).filter(Boolean) as string[];

  // Explicit document/folder ACLs for this user or any of their roles.
  // Do not use role principals for document:read here. A role grant has no
  // department dimension and would widen a department-scoped active session
  // back to the whole tenant. Explicit user grants remain supported; the
  // authoritative detail ACL pass applies the same active-scope boundary.
  const principalOr: Record<string, unknown>[] = [
    { principalType: 'user', principalId: user.userId },
  ];
  const aclEntries = await AclEntry.findAll({
    where: {
      permission: PERMISSIONS.DOCUMENT_READ,
      // 'department' included alongside document/folder: the Access Control
      // Center's "Department" scope (AccessControlCenter.tsx's GrantAccessForm)
      // writes exactly this resourceType, and resolveACL's detail-view check
      // (step 6, "Ancestor department checks") already honors it — without it
      // here, a department-level grant let a user open a document by direct
      // link/detail view but never see it in Browse or on the dashboard at
      // all, since this function alone decides what the LIST query fetches.
      resourceType: { [Op.in]: ['document', 'folder', 'department'] },
      [Op.or]: principalOr,
    },
    attributes: ['resourceType', 'resourceId', 'effect', 'expiresAt', 'origin'],
    raw: true,
  });
  const notExpired = (e: { expiresAt: Date | null }) => !e.expiresAt || new Date(e.expiresAt) > new Date();
  const allowDocEntries = aclEntries.filter((e) => e.resourceType === 'document' && e.effect === 'ALLOW' && notExpired(e));
  // A deliberate per-document grant opens a document whatever its class; the automatic department snapshot rows do not open a
  // CONFIDENTIAL or RESTRICTED one (shared/classifiedAccess.ts), so they are kept apart here.
  const allowDocIds = allowDocEntries.filter((e) => e.origin !== 'DEPT_SNAPSHOT').map((e) => e.resourceId);
  const allowSnapshotDocIds = allowDocEntries.filter((e) => e.origin === 'DEPT_SNAPSHOT').map((e) => e.resourceId);
  const allowFolderIds = aclEntries.filter((e) => e.resourceType === 'folder' && e.effect === 'ALLOW' && notExpired(e)).map((e) => e.resourceId);
  const allowDeptAclIds = aclEntries.filter((e) => e.resourceType === 'department' && e.effect === 'ALLOW' && notExpired(e)).map((e) => e.resourceId);
  const denyDocIds = aclEntries.filter((e) => e.resourceType === 'document' && e.effect === 'DENY').map((e) => e.resourceId);
  // Department-level DENY is deliberately NOT replicated here (unlike
  // denyDocIds below) — resolveACL only applies a role-scoped department DENY
  // to users who are actual members of that department (see resolveACL.ts's
  // "6. Ancestor department checks" comment on why), and never overrides a
  // direct per-document ALLOW (e.g. the owner's own creation-time grant).
  // Reproducing that precedence in a flat SQL OR/AND would risk hiding
  // documents that should stay visible. filterDocsByDetailAcl below already
  // re-runs the real resolveACL over this function's candidate page and drops
  // anything it would deny — this function only needs to avoid UNDER-fetching
  // (false negatives), which is what allowDeptAclIds fixes.

  // Classified documents (shared/classifiedAccess.ts): department membership, the automatic snapshot rows and grants on a folder or
  // department open only documents that are NOT CONFIDENTIAL or RESTRICTED. The head of a department also reads that department's
  // CONFIDENTIAL ones (a letter's documents are excluded later, by the authoritative pass below).
  const notClassified = { securityClassification: { [Op.notIn]: [...CLASSIFIED_LEVELS] } };
  const isHead = holdsDepartmentManage({ userRole: user.role, userPermissions: user.permissions });
  const or: Record<string | symbol, unknown>[] = [{ ownerId: user.userId }];
  if (deptIds.length > 0) or.push({ departmentId: { [Op.in]: deptIds }, ...notClassified });
  if (deptIds.length > 0 && isHead) or.push({ departmentId: { [Op.in]: deptIds }, securityClassification: 'CONFIDENTIAL' });
  if (allowDocIds.length > 0) or.push({ id: { [Op.in]: allowDocIds } });
  if (allowSnapshotDocIds.length > 0) or.push({ id: { [Op.in]: allowSnapshotDocIds }, ...notClassified });
  if (allowFolderIds.length > 0) or.push({ folderId: { [Op.in]: allowFolderIds }, ...notClassified });
  if (allowDeptAclIds.length > 0) or.push({ departmentId: { [Op.in]: allowDeptAclIds }, ...notClassified });

  const scope: Record<string | symbol, unknown> = { [Op.or]: or };
  if (denyDocIds.length > 0) scope.id = { [Op.notIn]: denyDocIds };
  return scope;
}

/**
 * C6 correctness net (S19 audit): `buildReadScope` is a fast SQL *approximation*
 * of `resolveACL` — it does not model folder-ancestry DENYs, department-scoped
 * ACLs, `access_rules`, or the secondary-role/display-role split exactly, so on
 * its own it can list a document whose DETAIL view (`GET /:id`, gated by
 * `resolveACL`) would DENY — a metadata info-leak. This pass runs the SAME
 * authority the detail route uses over the candidate page and drops anything it
 * would deny, guaranteeing list-visibility ⊆ detail-visibility by construction.
 *
 * The bypass here MUST match the detail route's bypass exactly, or the invariant
 * breaks. `requireACL` (GET /:id) bypasses ONLY on ACL_BYPASS_ADMIN and does NOT
 * honor DOCUMENT_READ_ALL — so exempting READ_ALL here would let oversight roles
 * (RECORDS_OFFICER, AUDITOR) list documents the detail route then 403s (S19
 * re-audit 4.1). We therefore filter READ_ALL users too; they still see every
 * document their role's default/explicit ACL allows (which detail allows
 * identically), and no longer see ones an explicit DENY hides at detail. The
 * bypass is checked against the effective permission set (the dynamic form
 * requireACL uses), so a DB-granted ACL_BYPASS_ADMIN is honored consistently
 * (4.2). `resolveACL` is cached, so the per-row cost on a ≤100-row page is small.
 */
/**
 * When a new version resets a settled document back to DRAFT for reapproval
 * (M7), any ceremony that was in flight for the OLD content must be torn down —
 * otherwise (S19 re-audit 4.3) an external signer keeps a live token and can
 * complete a signature bound to a superseded version, or a pending audit review
 * lingers against content the auditor never saw. Mirrors moveToTrash: void live
 * signature requests (killing recipient tokens) and cancel pending audit reviews.
 * Only acts when the prior status was actually mid-ceremony.
 */
async function voidInFlightCeremoniesOnReapproval(
  documentId: string,
  priorStatus: string,
  tx: Transaction,
): Promise<void> {
  if (priorStatus === 'PENDING_SIGNATURE') {
    const live = await SignatureRequest.findAll({
      where: { documentId, status: { [Op.in]: ['sent', 'partially_signed'] } },
      attributes: ['id'],
      transaction: tx,
    });
    if (live.length > 0) {
      const ids = live.map((r) => r.id);
      await SignatureRequest.update(
        { status: 'voided', voidedReason: 'Superseded by a new version (reapproval required)' },
        { where: { id: { [Op.in]: ids } }, transaction: tx },
      );
      await SignatureRecipient.update(
        { accessToken: null, accessTokenHash: null, accessTokenExpires: null },
        { where: { signatureRequestId: { [Op.in]: ids }, status: { [Op.in]: ['pending', 'viewed'] } }, transaction: tx },
      );
      // AUDIT-FINDINGS-2026-08-11 lifecycle sweep #7: same silent-void gap as
      // trashService.moveToTrash — a signer with the page open otherwise saw
      // no update when a new version superseded their in-flight ceremony.
      const voidedDoc = await Document.findByPk(documentId, { attributes: ['departmentId', 'tenantId'], transaction: tx });
      await OutboxEvent.create(
        {
          documentId,
          type: 'SIGNING.UPDATED',
          channel: 'WEBSOCKET',
          payload: JSON.stringify({ documentId, change: 'superseded', departmentId: voidedDoc?.departmentId, tenantId: voidedDoc?.tenantId }),
        },
        { transaction: tx },
      );
    }
  }
  if (priorStatus === 'PENDING_AUDIT') {
    const hadPending = await AuditStageReview.count({
      where: { itemType: 'DOCUMENT', itemId: documentId, status: 'PENDING' },
      transaction: tx,
    });
    await AuditStageReview.destroy({
      where: { itemType: 'DOCUMENT', itemId: documentId, status: 'PENDING' },
      transaction: tx,
    });
    if (hadPending > 0) {
      const voidedDoc = await Document.findByPk(documentId, { attributes: ['departmentId', 'tenantId'], transaction: tx });
      await OutboxEvent.create(
        {
          documentId,
          type: 'APPROVAL_CHAIN.UPDATED',
          channel: 'WEBSOCKET',
          payload: JSON.stringify({ documentId, change: 'superseded', departmentId: voidedDoc?.departmentId, tenantId: voidedDoc?.tenantId }),
        },
        { transaction: tx },
      );
    }
  }
}

export async function filterDocsByDetailAcl<T extends { id: string }>(
  user: CurrentUser,
  docs: T[],
): Promise<T[]> {
  if ((user.permissions as string[] | undefined)?.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) {
    return docs;
  }
  // Perf: was one resolveACL() call per row (Promise.all) — on a cold cache
  // that's ~4-5 queries/row, so a 100-row page could issue 400-500 queries.
  // resolveACLBatch produces identical per-document results (same DENY-first
  // ladder, same cache keys) but fetches ancestors/entries/access-rules for
  // every cache-miss row in one round trip each instead of one per row.
  const results = await resolveACLBatch(
    docs.map((doc) => doc.id),
    {
      permission: PERMISSIONS.DOCUMENT_READ,
      userId: user.userId,
      userRole: user.role,
      userRoles: user.roles,
      userPermissions: user.permissions,
      tenantId: user.tenantId,
    },
  );
  return docs.filter((doc) => results.get(doc.id)?.allowed);
}

/**
 * A signed correspondence draft remains a retained, auditable attachment of
 * its final letter, but it is not a second repository item. Keep this predicate
 * shared by repository lists and document aggregates so a dashboard cannot
 * advertise rows that the corresponding library page intentionally suppresses.
 */
function excludeSignedLetterDrafts(): object {
  return literal(
    'NOT EXISTS (SELECT 1 FROM letters l WHERE l.signed_draft_document_id = "Document"."id")',
  ) as unknown as object;
}

export async function listDocuments(
  user: CurrentUser,
  skip = 0,
  take = 50,
  filters: ListDocumentsFilters = {},
) {
  // Enforce max take of 100
  const safeTake = Math.min(take, 100);
  
  const where: Record<string | symbol, unknown> = { deletedAt: { [Op.is]: null }, tenantId: user.tenantId };
  // C6: per-user read scope (owner / department / ACL) unless the user has the
  // document:read_all oversight permission. Collected alongside any other AND
  // conditions so a later filter doesn't clobber where[Op.and].
  const andConditions: object[] = [];
  const readScope = await buildReadScope(user);
  if (readScope) {
    andConditions.push(readScope);
  }
  if (filters.folderId) where.folderId = filters.folderId;
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length > 1 ? { [Op.in]: statuses } : statuses[0];
  }
  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.documentTypeId) where.documentTypeId = filters.documentTypeId;
  if (filters.ownerId) where.ownerId = filters.ownerId;
  if (filters.ocrStatus) {
    const statuses = filters.ocrStatus.split(',').map((s) => s.trim()).filter(Boolean);
    where.ocrStatus = statuses.length > 1 ? { [Op.in]: statuses } : statuses[0];
  }
  if (filters.retentionRelevant) {
    // Faithful server-side equivalent of the Records console's client filter
    // `status === 'DISPOSAL_PENDING' || d.retentionClass` (truthy).
    andConditions.push({
      [Op.or]: [
        { status: 'DISPOSAL_PENDING' },
        { retentionClass: { [Op.notIn]: ['', 'NONE'] } },
      ],
    });
  }
  if (filters.dateFrom || filters.dateTo) {
    const range: Record<symbol, Date> = {};
    if (filters.dateFrom) range[Op.gte] = new Date(filters.dateFrom);
    if (filters.dateTo) range[Op.lte] = new Date(filters.dateTo);
    where.createdAt = range;
  }

  // A signed letter files TWO documents, and both were showing up in every
  // list under the same title — reported as "it lists the same document twice".
  //
  //   REF/HQ/FIN/OUT/2026/00063 — Signed Draft   the unnumbered draft the
  //                                             e-signing ceremony stamped,
  //                                             carrying the PAdES proof
  //   REF/HQ/FIN/OUT/2026/00063                  the letter of record
  //
  // The draft is not junk and must not be deleted: it is the cryptographic
  // evidence that the letter was signed, it is retained under the same policy,
  // and letters.signed_draft_document_id points at it. It simply is not a
  // separate item in the library — it is an attachment to one. The letter
  // detail page reaches it by id, and a direct GET /documents/:id still works,
  // so nothing becomes unreachable; it just stops being listed twice.
  //
  // NOT EXISTS rather than NOT IN: NOT IN against a subquery that can yield
  // NULL silently matches nothing, and `letters_signed_draft_document_idx` is a
  // partial index on exactly this column, so the lookup is cheap.
  if (!filters.includeLetterSignedDrafts) {
    andConditions.push(excludeSignedLetterDrafts());
  }

  const sortColumn = filters.sortBy && SORTABLE_DOCUMENT_COLUMNS.has(filters.sortBy) ? filters.sortBy : 'updatedAt';
  const sortDir = filters.sortDir === 'ASC' ? 'ASC' : 'DESC';

  // Cursor decoding is retained for the exact authorized-set slice below.
  // Applying it after ACL filtering prevents inaccessible rows from creating
  // gaps or phantom pages.
  const cursor = filters.cursor ? decodeDocumentCursor(filters.cursor) : null;
  const include: object[] = [
    { model: Department, as: 'department' },
    { model: DocumentType, as: 'documentType' },
    ownerInclude,
    {
      model: DocumentVersion,
      as: 'versions',
      required: false,
      limit: 1,
      order: [['versionNumber', 'DESC']],
    },
    // Checkout row so list consumers (e.g. the "Checked Out" tab) can see it;
    // `required` only when explicitly filtering to checked-out documents so it
    // becomes an INNER JOIN and the count/pagination are correct.
    {
      model: DocumentCheckout,
      as: 'checkout',
      required: Boolean(filters.checkedOut),
      include: [{ model: User, as: 'checkedOutByUser', attributes: ['id', 'firstName', 'lastName', 'email'] }],
    },
  ];
  if (filters.q?.trim()) {
    include.push({
      model: DocumentMetadata,
      as: 'metadata',
      required: false,
      where: {
        [Op.or]: [
          { keywords: { [Op.iLike]: `%${filters.q}%` } },
          { description: { [Op.iLike]: `%${filters.q}%` } },
          { tags: { [Op.iLike]: `%${filters.q}%` } },
        ],
      },
    });
    Object.assign(where, {
      [Op.or]: [
        { title: { [Op.iLike]: `%${filters.q}%` } },
        { documentName: { [Op.iLike]: `%${filters.q}%` } },
      ],
    });
  }

  // Authorize the complete candidate set before slicing it. This keeps the
  // returned rows, total, and cursor on one exact visibility contract.
  if (andConditions.length > 0) where[Op.and] = andConditions;
  const candidateInclude: object[] = [];
  if (filters.q?.trim()) candidateInclude.push({ model: DocumentMetadata, as: 'metadata', required: false, where: { [Op.or]: [
    { keywords: { [Op.iLike]: `%${filters.q}%` } },
    { description: { [Op.iLike]: `%${filters.q}%` } },
    { tags: { [Op.iLike]: `%${filters.q}%` } },
  ] } });
  candidateInclude.push({
    model: DocumentCheckout,
    as: 'checkout',
    required: Boolean(filters.checkedOut),
    include: [{ model: User, as: 'checkedOutByUser', attributes: ['id', 'firstName', 'lastName', 'email'] }],
  });
  const candidateRows = await Document.findAll({
    where,
    attributes: ['id', sortColumn],
    include: candidateInclude,
    order: [[sortColumn, sortDir], ['id', sortDir]],
  });
  const visibleCandidates = await filterDocsByDetailAcl(user, candidateRows as unknown as Array<{ id: string }>);
  const visibleIds = visibleCandidates.map((row) => row.id);
  const exactTotal = visibleIds.length;
  const cursorIndex = cursor ? visibleIds.indexOf(cursor.id) : -1;
  const pageStart = cursor ? cursorIndex + 1 : skip;
  const pageIds = visibleIds.slice(pageStart, pageStart + safeTake);
  const pageRows = pageIds.length === 0 ? [] : await Document.findAll({
    where: { ...where, id: { [Op.in]: pageIds } },
    include,
    order: [[sortColumn, sortDir], ['id', sortDir]],
  });
  const byId = new Map(pageRows.map((row) => [row.id, row]));
  const data = pageIds.map((id) => byId.get(id)).filter(Boolean) as DocumentRow[];

  // D4: list rows keep the single IN_REVIEW chip but carry a progress hint
  // ("2/3 · waiting on X") — batch-load live chains for the page's IN_REVIEW
  // documents so lists don't fire one chain request per row.
  const inReviewIds = data.filter((d) => d.status === 'IN_REVIEW').map((d) => d.id);
  const progressById = new Map<string, { done: number; total: number; waitingOn: string | null }>();
  if (inReviewIds.length > 0) {
    const chains = await ApprovalChain.findAll({
      where: { itemType: 'DOCUMENT', itemId: { [Op.in]: inReviewIds }, status: 'IN_REVIEW' },
      include: [{
        model: ApprovalStep,
        as: 'steps',
        separate: true,
        order: [['stepOrder', 'ASC']],
        include: [{ model: User, as: 'assignedUser', attributes: ['firstName', 'lastName'] }],
      }],
    });
    for (const chain of chains) {
      const steps = (chain as ApprovalChain & { steps?: Array<ApprovalStep & { assignedUser?: { firstName: string; lastName: string } | null }> }).steps ?? [];
      const pending = steps.find((s) => s.status === 'PENDING');
      progressById.set(chain.itemId, {
        done: steps.filter((s) => s.status === 'APPROVED').length,
        total: steps.length,
        waitingOn: pending
          ? pending.assignedUser
            ? `${pending.assignedUser.firstName} ${pending.assignedUser.lastName}`
            : pending.assignedRole?.replace(/_/g, ' ') ?? null
          : null,
      });
    }
  }

  const rows = (serializeBigInt(data) as unknown as Array<Record<string, unknown> & { id: string }>).map((row) => ({
    ...row,
    approvalProgress: progressById.get(row.id) ?? null,
  }));
  // Cursor for the NEXT page comes from the last visible row in the exact
  // authorized set. It is emitted only while visible rows remain.
  const lastVisible = data[data.length - 1] as unknown as Record<string, unknown> & { id: string } | undefined;
  const nextCursor = pageStart + data.length < exactTotal && lastVisible
    ? encodeDocumentCursor(lastVisible, sortColumn)
    : null;
  return { data: rows, total: exactTotal, skip, take: safeTake, nextCursor };
}

export async function getDocument(id: string, user: CurrentUser) {
  const document = await Document.findByPk(id, {
    include: getDocumentInclude as never,
  });
  if (!document || document.deletedAt)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'read', user);

  // A document filed by the forms engine has its approval chain (and
  // lifecycle) keyed to the FORM_INSTANCE, not this DOCUMENT — surface the
  // link so the frontend can ask the approval engine the right question.
  const formInstance = await FormInstance.findOne({ where: { documentId: id }, attributes: ['id', 'templateId'] });

  const plain: Record<string, any> = serializeBigInt(document.get({ plain: true }));
  if (formInstance) {
    // A FORM_INSTANCE is governed by its own template's audit/signing policy,
    // not the shared tenant-wide FORM document type (see approvals.service.ts's
    // completeItemApproval) — override the governance fields the frontend
    // reads off `documentType` so its auditor-pick prompt reflects the
    // template that actually applies, not every form template's shared type.
    const template = await FormTemplate.findByPk(formInstance.templateId, {
      attributes: ['auditPolicy', 'signingPolicy'],
    });
    if (template && plain.documentType) {
      plain.documentType = {
        ...plain.documentType,
        auditPolicy: template.auditPolicy,
        signingPolicy: template.signingPolicy,
      };
    }
  }

  return { ...plain, formInstanceId: formInstance?.id ?? null };
}

/**
 * The manual status transitions the given user can perform on this document
 * right now — derived from the SAME MANUAL_TRANSITION_PERMISSIONS allowlist the
 * write path enforces, so the UI can offer exactly the valid options and never
 * a transition that would 409 (subsystem-driven) or 403 (missing permission).
 * Subsystem-only transitions (approval/audit/signing/legal-hold/disposal) are
 * intentionally never returned here.
 */
export async function getAllowedManualTransitions(
  id: string,
  user: CurrentUser,
): Promise<Array<{ toState: string; permission: string }>> {
  const document = await Document.findByPk(id);
  if (!document) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  const from = document.status;
  const userPerms = user.permissions ?? [];
  const out: Array<{ toState: string; permission: string }> = [];
  for (const [key, permission] of Object.entries(MANUAL_TRANSITION_PERMISSIONS)) {
    const [f, t] = key.split('->');
    if (f === from && userPerms.includes(permission)) out.push({ toState: t, permission });
  }
  return out;
}

export async function updateDocumentStatus(
  id: string,
  toState: string,
  user: CurrentUser,
) {
  const document = await Document.findByPk(id, {
    include: [{ model: DocumentCheckout, as: 'checkout' }],
  });
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'status_change', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  validateTransition(document.status, toState);

  // C2: per-transition authorization. A structurally valid transition is not
  // enough — the manual endpoint must not let `document:upload` self-approve or
  // archive. Transitions driven by a subsystem (approval engine, audit, signing,
  // legal hold, disposal) are refused here entirely and must go through their
  // own flow.
  const requiredPermission = requiredPermissionForManualTransition(document.status, toState);
  if (requiredPermission === null) {
    throw new AppError(
      409,
      'ERR-TRANSITION-NOT-MANUAL',
      `Transition ${document.status} -> ${toState} is driven by its workflow and cannot be set directly`,
    );
  }
  if (!(user.permissions ?? []).includes(requiredPermission)) {
    throw new AppError(403, 'ERR-PERMISSION-DENIED', `This transition requires the ${requiredPermission} permission`);
  }

  // BUG 3 FIX: Capture previousState BEFORE calling update()
  const previousState = document.status;
  
  const updated = await runInTransaction(async (tx: Transaction) => {
    await document.update({ status: toState }, { transaction: tx });
    await OutboxEvent.create(
      {
        documentId: id,
        type: 'DOCUMENT.STATUS_CHANGED',
        channel: 'WEBSOCKET',
        payload: JSON.stringify({
          documentId: id,
          previousState, // BUG 3 FIX: Use captured value, not document.status
          newState: toState,
          tenantId: document.tenantId,
          departmentId: document.departmentId,
        }),
      },
      { transaction: tx },
    );
    return document;
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_EDIT,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    previousState, // BUG 3 FIX: Use captured value
    newState: toState,
    actionDetails: { statusChange: true },
  });
  return updated.get({ plain: true });
}

export function requiredMetadataFields() {
  return mandatoryMetadataFields;
}

// ── AI-suggested metadata application ───────────────────────────────────────
// Maps the fixed set of keys the AIWorker's extractMetadata() step writes
// into Document.aiSuggestedMetadata (see infrastructure/queue/workers/AIWorker.ts)
// onto the actual columns they represent, so the "Apply" button on the
// document detail page's AI Insights card can commit a single suggested
// field without a bespoke endpoint per field.
const AI_SUGGESTION_FIELD_MAP: Record<
  string,
  { target: 'document' | 'metadata'; column: string; transform?: (value: unknown) => unknown }
> = {
  suggestedClassification: { target: 'document', column: 'securityClassification' },
  suggestedDocumentDate: { target: 'document', column: 'documentDate', transform: (v) => (v ? new Date(String(v)) : null) },
  suggestedLanguage: { target: 'metadata', column: 'language' },
  suggestedKeywords: {
    target: 'metadata',
    column: 'keywords',
    transform: (v) => (Array.isArray(v) ? v.join(', ') : v == null ? null : String(v)),
  },
  summary: { target: 'metadata', column: 'description' },
};

export async function applyAiSuggestedMetadataField(
  id: string,
  field: string,
  value: unknown,
  user: CurrentUser,
) {
  const mapping = AI_SUGGESTION_FIELD_MAP[field];
  if (!mapping) {
    throw new AppError(400, 'ERR-VALIDATION', `Unsupported AI suggestion field: ${field}`);
  }

  const document = await Document.findOne({
    where: { id, tenantId: user.tenantId },
    include: [{ model: DocumentMetadata, as: 'metadata' }],
  });
  if (!document) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  requireLegalHoldClear(document);

  const nextValue = mapping.transform ? mapping.transform(value) : value;

  // A suggested classification is a change of class like any other: only the owner, the head of the department or an administrator
  // may apply it, lowering needs a reason, and a letter's documents are refused. It goes through the one controlled action.
  if (mapping.column === 'securityClassification') {
    await changeDocumentClassification(
      id,
      { classification: String(nextValue), reason: 'Applied from the AI suggestion on the document page' },
      user,
    );
    const refreshedAfterClass = await Document.findByPk(id, { include: [{ model: DocumentMetadata, as: 'metadata' }] });
    return serializeBigInt(refreshedAfterClass!.get({ plain: true }));
  }

  if (mapping.target === 'document') {
    await document.update({ [mapping.column]: nextValue } as never);
  } else {
    const metadata = (document as unknown as { metadata?: DocumentMetadata }).metadata;
    if (metadata) {
      await metadata.update({ [mapping.column]: nextValue } as never);
    } else {
      await DocumentMetadata.create({ documentId: id, [mapping.column]: nextValue } as never);
    }
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_EDIT,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { action: 'ai_suggestion_applied', field, value: nextValue },
  });

  const refreshed = await Document.findByPk(id, { include: [{ model: DocumentMetadata, as: 'metadata' }] });
  return serializeBigInt(refreshed!.get({ plain: true }));
}

const CLASSIFICATION_RANK: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 };

const changeClassificationSchema = z.object({
  classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Change a document's classification (new 2026-10-10: it could not be changed after upload, and with CONFIDENTIAL/RESTRICTED now closing a
 * document, a wrongly tagged one must be fixable). Who: the owner, the head of the document's department (who must already be able to
 * read it, which the route checks, so a head cannot lower a RESTRICTED document they are not allowed to see in order to read it), or an
 * administrator. LOWERING a class (for example CONFIDENTIAL to INTERNAL) opens the document to more people, so it needs a reason of at
 * least 10 characters; raising does not. A letter's documents are refused (change the letter's confidentiality instead), and so is a
 * document on legal hold. Audited, and the search index is refreshed.
 */
export async function changeDocumentClassification(id: string, input: unknown, user: CurrentUser) {
  const { classification, reason } = changeClassificationSchema.parse(input);
  const document = await Document.findOne({ where: { id, tenantId: user.tenantId } });
  if (!document || document.deletedAt) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireLegalHoldClear(document);

  const isOwner = document.ownerId === user.userId;
  const isAdmin = (user.permissions as string[] | undefined)?.includes(PERMISSIONS.ACL_BYPASS_ADMIN) ?? false;
  if (!isOwner && !isAdmin) {
    // Heads only: the permission says they ARE a head, the scope check says it is THEIR department (own department and below).
    // (assertCanManageDepartment alone answers only "where", it assumes the caller already holds the permission.)
    if (!(user.permissions as string[] | undefined)?.includes(PERMISSIONS.DEPT_MANAGE)) {
      throw new AppError(403, 'ERR-PERMISSION-DENIED', 'Only the owner, the head of the department that holds the document, or an administrator can change its classification');
    }
    await assertCanManageDepartment(user, document.departmentId ?? '');
  }
  if ((await letterBackedDocumentIds([id])).has(id)) {
    throw new AppError(409, 'ERR-CLASSIFICATION-LETTER', "This document belongs to a letter. Change the letter's confidentiality instead.");
  }

  const from = document.securityClassification;
  if (from === classification) return serializeBigInt(document.get({ plain: true }));
  const lowering = (CLASSIFICATION_RANK[classification] ?? 0) < (CLASSIFICATION_RANK[from] ?? 0);
  if (lowering && (reason ?? '').length < 10) {
    throw new AppError(422, 'ERR-REASON-REQUIRED', 'Lowering a classification opens the document to more people, so a reason of at least 10 characters is required');
  }

  await runInTransaction(async (tx: Transaction) => {
    await document.update(
      { securityClassification: classification, sensitivityLabel: classificationLabel(classification) } as never,
      { transaction: tx },
    );
    // Becoming classified must not lock out the people already working on the document through an approval chain or an audit review.
    if (isClassified(classification)) await grantExistingParticipantsRead(id, user.tenantId, user.userId, tx);
    await OutboxEvent.create(
      {
        documentId: id,
        type: 'SEARCH_INDEX_UPSERT',
        channel: 'SEARCH_INDEX',
        payload: JSON.stringify({ documentId: id, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOC_CLASSIFICATION_CHANGED,
      userId: user.userId,
      userRole: user.role,
      documentId: id,
      actionDetails: {
        from,
        to: classification,
        lowering,
        reason: reason ?? null,
        // Whether the document was closed before and after, so the log says what the change meant for access.
        closedBefore: isClassified(from),
        closedAfter: isClassified(classification),
      },
    }, tx);
  });

  const refreshed = await Document.findByPk(id);
  return serializeBigInt(refreshed!.get({ plain: true }));
}

// FIX: the document lock system (lockService.ts / doc_locks) and the checkout
// system (DocumentCheckout, here) never checked each other — a document
// "locked" via one system could still be freely checked out and versioned
// through the other, defeating the lock's purpose. Both checkoutDocument and
// uploadVersion now respect an active lock held by someone else; the lock
// owner themselves is unaffected (mirrors lockDocument's own "same user" carve
// -out), and an admin bypass is intentionally NOT offered here — forceUnlock
// in lockService.ts is the designated admin override path, requiring its own
// mandatory reason and audit trail rather than a silent bypass on every write.
async function assertNotLockedByOther(documentId: string, user: CurrentUser) {
  const lock = await DocLock.findOne({ where: { documentId } });
  if (!lock) return;
  if (lock.expiresAt < new Date()) return; // expired lock — treat as absent
  if (lock.lockedBy !== user.userId) {
    throw new AppError(
      409,
      'ERR-DOCUMENT-LOCKED',
      'Document is locked by another user',
    );
  }
}

export async function checkoutDocument(
  id: string,
  user: CurrentUser,
  notes?: string,
) {
  const document = (await Document.findByPk(id, {
    include: [{ model: DocumentCheckout, as: 'checkout' }],
  })) as DocumentRow | null;
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'checkout', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  assertNotTrashed(document);
  await assertNotLockedByOther(id, user);

  if (document.checkout) {
    throw new AppError(
      409,
      'ERR-CHECKOUT-ACTIVE',
      'Document is already checked out',
    );
  }

  // The `if (document.checkout)` check above reads before this insert, so two
  // concurrent checkouts on the same document can both pass it and race to
  // create — the documentId UNIQUE constraint (document_checkouts) is what
  // actually enforces exclusivity. Without this catch, the losing request's
  // constraint violation surfaced as an unhandled 500 instead of the same
  // clean 409 the pre-check already gives a non-racing caller.
  let checkout;
  try {
    checkout = await DocumentCheckout.create({
      documentId: id,
      checkedOutBy: user.userId,
      notes: notes ?? null,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new AppError(
        409,
        'ERR-CHECKOUT-ACTIVE',
        'Document is already checked out',
      );
    }
    throw err;
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_CHECKOUT,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { notes: notes ?? null },
  });

  return checkout.get({ plain: true });
}

export async function checkinDocument(id: string, user: CurrentUser) {
  const document = (await Document.findByPk(id, {
    include: [{ model: DocumentCheckout, as: 'checkout' }],
  })) as DocumentRow | null;
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'checkin', user);

  if (!document.checkout) {
    throw new AppError(
      409,
      'ERR-NOT-CHECKED-OUT',
      'Document is not checked out',
    );
  }

  if (
    document.checkout.checkedOutBy !== user.userId &&
    !userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.ACL_BYPASS_ADMIN)
  ) {
    throw new AppError(
      403,
      'ERR-CHECKOUT-OWNER-REQUIRED',
      'Only checkout owner or admin can cancel checkout',
    );
  }

  await DocumentCheckout.destroy({ where: { documentId: id } });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_CHECKIN_CANCEL,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { cancelled: true },
  });

  return { success: true };
}

export async function uploadVersion(
  id: string,
  file: Express.Multer.File | undefined,
  isMajor: boolean,
  changeSummary: string,
  user: CurrentUser,
) {
  if (!file)
    throw new AppError(422, 'ERR-FILE-MISSING', 'New version file is required');

  // BUG 4 FIX: Removed pre-flight quota check - now done atomically in transaction

  // S4-07: MIME validation
  await validateMimeAndExtension(file.buffer, file.originalname);

  const document = (await Document.findByPk(id, {
    include: [
      { model: DocumentCheckout, as: 'checkout' },
      { model: Department, as: 'department' },
      { model: DocumentType, as: 'documentType' },
    ],
  })) as DocumentRow | null;
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'upload_version', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  assertNotTrashed(document);
  await assertNotLockedByOther(id, user);

  if (!document.checkout || document.checkout.checkedOutBy !== user.userId) {
    throw new AppError(
      403,
      'ERR-CHECKOUT-OWNER-REQUIRED',
      'Document must be checked out by you to upload a version',
    );
  }

  const hash = sha256(file.buffer); // BUG 2 FIX: Plaintext hash for duplicate detection

  // S4-09: Async virus scan for files > 100 MB
  const ASYNC_SCAN_THRESHOLD = 100 * 1024 * 1024; // 100 MB
  const useAsyncScan = file.size > ASYNC_SCAN_THRESHOLD;

  let avScanStatus: 'clean' | 'unscanned' = 'unscanned';
  if (!useAsyncScan) {
    avScanStatus = await scanBuffer(file.buffer);
  }

  const versionId = crypto.randomUUID();
  // TEN-3: see uploadDocument's storageKey comment above.
  const storageKey = `${document.tenantId}/${document.department?.code}/${document.documentType?.code}/${document.id}/${versionId}/${sanitizeFilename(file.originalname)}`;

  // S4-05: Encrypt and store
  const {
    encryptedKey,
    sha256Hash: encHash,
    kekId,
  } = await encryptAndStore(
    storageKey,
    file.buffer,
    file.mimetype,
    document.departmentId,
    user.tenantId,
  );

  const nextVer = incrementVersionNumber(document.currentVersion, isMajor);

  // M7: enforce the document type's re-approval policy. A new version of an
  // already-settled (APPROVED/ACTIVE/AUDITED/SIGNED) document must re-enter the
  // approval lifecycle when the type requires it — otherwise an approved record
  // can be silently changed with no re-review. `major_versions` triggers only on
  // a major bump; `all_changes` on any version; `none` never. We reset the
  // document to DRAFT so the author resubmits it through the unified engine.
  const reapprovalPolicy = (document as DocumentRow & { documentType?: { reapprovalPolicy?: string } }).documentType?.reapprovalPolicy ?? 'none';
  // Include the in-flight PENDING_AUDIT / PENDING_SIGNATURE states (S19 audit
  // finding): a new version uploaded while an audit or signature ceremony is
  // still running would otherwise proceed against silently-changed content,
  // since those states were absent from the settled set and never triggered the
  // reapproval reset. ARCHIVED is included too: it's now the default terminal
  // state after approval (see approvals.service.ts), and checkout/upload-version
  // is reachable directly from ARCHIVED without first using the Activate action
  // (assertNotTerminalState doesn't treat ARCHIVED as terminal) — without it, a
  // new version attached straight to an archived record left it silently
  // ARCHIVED with changed content instead of re-entering the approval chain.
  const settled = ['APPROVED', 'ACTIVE', 'AUDITED', 'SIGNED', 'PENDING_AUDIT', 'PENDING_SIGNATURE', 'ARCHIVED'].includes(document.status);
  const needsReapproval =
    settled && (reapprovalPolicy === 'all_changes' || (reapprovalPolicy === 'major_versions' && isMajor));

  await runInTransaction(async (tx: Transaction) => {
    // BUG 4 FIX: Atomically reserve storage quota within transaction
    await reserveStorageQuota(user.tenantId, file.size, tx);

    await DocumentVersion.create(
      {
        id: versionId,
        documentId: id,
        versionNumber: nextVer,
        isMajorVersion: isMajor,
        storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        sha256Hash: encHash, // Ciphertext hash (for storage integrity)
        plaintextSha256: hash, // BUG 2 FIX: Plaintext hash (for duplicate detection & content integrity)
        authorId: user.userId,
        changeSummary: changeSummary || 'New version upload',
        avScanStatus,
      },
      { transaction: tx },
    );

    // FIX: create a NEW DEK row for this version rather than upserting on
    // documentId — the old upsert overwrote the previous version's DEK,
    // permanently destroying its decryptability.
    await DocumentDek.create(
      {
        documentId: id,
        versionId,
        encryptedDek: encryptedKey,
        kekId,
        algorithm: 'AES-256-GCM',
      },
      { transaction: tx },
    );

    const priorStatusForReapproval = document.status;
    await document.update(
      {
        currentVersion: nextVer,
        latestVersionId: versionId,
        // M7: drop the settled document back to DRAFT so it must be resubmitted
        // for approval; also clear any stale approvalStatus.
        ...(needsReapproval ? { status: 'DRAFT', approvalStatus: 'NOT_REQUIRED' } : {}),
      },
      { transaction: tx },
    );
    // S19 re-audit 4.3: tear down any ceremony that was in flight for the old
    // content so a superseded version can't still be signed/audited.
    if (needsReapproval) {
      await voidInFlightCeremoniesOnReapproval(id, priorStatusForReapproval, tx);
    }

    await DocumentCheckout.destroy({
      where: { documentId: id },
      transaction: tx,
    });

    await OutboxEvent.create(
      {
        documentId: id,
        type: 'DOCUMENT.VERSION_UPLOADED',
        channel: 'WEBSOCKET',
        payload: JSON.stringify({
          documentId: id,
          versionNumber: nextVer,
          tenantId: document.tenantId,
          departmentId: document.departmentId,
        }),
      },
      { transaction: tx },
    );
  });

  // BUG 4 FIX: Removed separate incrementStorageUsed - now done atomically in transaction above

  // S4-09: Enqueue async virus scan for large files
  if (useAsyncScan) {
    const scanQueue = createQueue('VIRUS_SCAN');
    if (scanQueue) {
      await scanQueue.add('scan-document', {
        documentId: id,
        versionId,
        storageKey,
        tenantId: user.tenantId,
        userId: user.userId,
        userRole: user.role,
      });
      logger.info(
        { documentId: id, fileSize: file.size },
        'Enqueued async virus scan for large version',
      );
    }
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_VERSION_UPLOAD,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { versionNumber: nextVer, sha256Hash: hash },
  });

  if (avScanStatus === 'unscanned') {
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
      userId: user.userId,
      userRole: user.role,
      documentId: id,
      actionDetails: { versionId, reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
    });
  }

  return { success: true, versionNumber: nextVer, warnings: avScanStatus === 'unscanned' ? ['WARN-UNSCANNED'] : [] };
}

function incrementVersionNumber(current: string, isMajor: boolean) {
  const parts = current.split('.');
  const major = parseInt(parts[0] || '1', 10);
  const minor = parseInt(parts[1] || '0', 10);
  if (isMajor) {
    return `${major + 1}.0`;
  } else {
    return `${major}.${minor + 1}`;
  }
}

export async function rollbackVersion(
  id: string,
  targetVersionId: string,
  user: CurrentUser,
) {
  const document = (await Document.findByPk(id, {
    include: [
      { model: Department, as: 'department' },
      { model: DocumentType, as: 'documentType' },
    ],
  })) as DocumentRow | null;
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'rollback', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  assertNotTrashed(document);

  if (!userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.VERSION_MANAGE)) {
    throw new AppError(
      403,
      'ERR-PERMISSION-DENIED',
      'Only users with version:manage permission can rollback versions',
    );
  }

  const targetVersion = await DocumentVersion.findByPk(targetVersionId);
  if (!targetVersion || targetVersion.documentId !== id) {
    throw new AppError(
      404,
      'ERR-VERSION-NOT-FOUND',
      'Version not found or mismatch',
    );
  }

  const nextVer = incrementVersionNumber(document.currentVersion, true);
  const newVersionId = crypto.randomUUID();

  // M7: a rollback produces a new MAJOR version, so it triggers re-approval on a
  // settled document under either `major_versions` or `all_changes`.
  const rbPolicy = (document as DocumentRow & { documentType?: { reapprovalPolicy?: string } }).documentType?.reapprovalPolicy ?? 'none';
  // Include in-flight PENDING_AUDIT / PENDING_SIGNATURE (S19 audit finding) — see
  // the matching note in uploadVersion.
  const rbSettled = ['APPROVED', 'ACTIVE', 'AUDITED', 'SIGNED', 'PENDING_AUDIT', 'PENDING_SIGNATURE'].includes(document.status);
  const rbNeedsReapproval = rbSettled && (rbPolicy === 'all_changes' || rbPolicy === 'major_versions');

  // FIX: a rollback used to point the new "current" version straight at the
  // target's old storageKey without re-encrypting. Since every version now
  // has its own DEK (see documentCrypto.ts), reusing the target's ciphertext
  // under a NEW version id would leave that new version's DocumentDek row
  // missing and undecryptable. Re-encrypt fresh instead: decrypt the
  // target's plaintext, then run it back through the canonical
  // encrypt-and-store pipeline exactly like a new upload.
  const plaintext = await fetchAndDecrypt(
    targetVersion.storageKey,
    targetVersion.id,
  );
  // TEN-3: see uploadDocument's storageKey comment above.
  const storageKey = `${document.tenantId}/${document.department?.code}/${document.documentType?.code}/${id}/${newVersionId}/${targetVersion.originalFilename}`;
  const {
    encryptedKey,
    sha256Hash: encHash,
    kekId,
  } = await encryptAndStore(
    storageKey,
    plaintext,
    targetVersion.mimeType,
    document.departmentId,
    user.tenantId,
  );

  await runInTransaction(async (tx: Transaction) => {
    // FIX: rollback used to bypass quota accounting entirely even though it
    // duplicates the target version's bytes under a new storage key.
    await reserveStorageQuota(user.tenantId, Number(targetVersion.fileSize), tx);

    await DocumentVersion.create(
      {
        id: newVersionId,
        documentId: id,
        versionNumber: nextVer,
        isMajorVersion: true,
        storageKey,
        storageBucket: targetVersion.storageBucket,
        fileSize: targetVersion.fileSize,
        mimeType: targetVersion.mimeType,
        originalFilename: targetVersion.originalFilename,
        sha256Hash: encHash, // ciphertext hash of the freshly re-encrypted bytes
        plaintextSha256: targetVersion.plaintextSha256, // FIX: was never copied before; content is unchanged
        authorId: user.userId,
        changeSummary: `Rollback to version ${targetVersion.versionNumber}`,
        avScanStatus: targetVersion.avScanStatus, // same bytes as the target version — its scan result still applies
      },
      { transaction: tx },
    );

    await DocumentDek.create(
      {
        documentId: id,
        versionId: newVersionId,
        encryptedDek: encryptedKey,
        kekId,
        algorithm: 'AES-256-GCM',
      },
      { transaction: tx },
    );

    const priorStatusForReapproval = document.status;
    await document.update(
      {
        currentVersion: nextVer,
        latestVersionId: newVersionId,
        ...(rbNeedsReapproval ? { status: 'DRAFT', approvalStatus: 'NOT_REQUIRED' } : {}),
      },
      { transaction: tx },
    );
    // S19 re-audit 4.3: void any in-flight ceremony for the superseded content.
    if (rbNeedsReapproval) {
      await voidInFlightCeremoniesOnReapproval(id, priorStatusForReapproval, tx);
    }
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_ROLLBACK,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: {
      rolledBackTo: targetVersion.versionNumber,
      nextVersion: nextVer,
    },
  });

  return { success: true, versionNumber: nextVer };
}

export async function archiveDocument(id: string, user: CurrentUser) {
  const document = await Document.findByPk(id);
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'archive', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  assertNotTrashed(document);

  if (!userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_ARCHIVE)) {
    throw new AppError(
      403,
      'ERR-PERMISSION-DENIED',
      'Only users with document:archive permission can archive documents',
    );
  }

  // Respect the state machine (S19 audit finding): archive used to jump to
  // ARCHIVED from ANY non-terminal state, so a DRAFT/IN_REVIEW could be archived
  // by hand — an inconsistency with the transition graph the manual status
  // endpoint enforces. Re-archiving an already-ARCHIVED document stays idempotent
  // (the ArchiveRecord upsert below handles it), so only validate a real move.
  if (document.status !== 'ARCHIVED') {
    validateTransition(document.status, 'ARCHIVED');
  }

  await runInTransaction(async (tx: Transaction) => {
    await document.update(
      { status: 'ARCHIVED', archivedAt: new Date() },
      { transaction: tx },
    );

    const [record, created] = await ArchiveRecord.findOrCreate({
      where: { documentId: id },
      defaults: {
        documentId: id,
        status: 'ARCHIVED',
        archiveStorageTier: 'WARM',
        archivedById: user.userId,
      },
      transaction: tx,
    });
    if (!created) {
      await record.update({ status: 'ARCHIVED' }, { transaction: tx });
    }

    await OutboxEvent.create(
      {
        documentId: id,
        type: 'SEARCH_INDEX_DELETE',
        channel: 'SEARCH_INDEX',
        payload: JSON.stringify({ documentId: id, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );

    // Retention engine (gap #1): archive is a retention trigger — archive-based
    // policies start their clock now, and creation-based ones are unaffected
    // (applyRetention recomputes idempotently).
    await applyRetention(id, tx);
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_ARCHIVE,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { archived: true },
  });

  return { success: true };
}

// Reverse of archiveDocument(): a document filed to ARCHIVED (the default
// terminal state after approval — see approvals.service.ts/auditStage.service.ts)
// can be brought back live if it's needed again. Same permission as archiving
// it — reactivating is the same records-management decision in the other
// direction, not a lesser one.
export async function activateDocument(id: string, user: CurrentUser) {
  const document = await Document.findByPk(id);
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'activate', user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);
  assertNotTrashed(document);

  if (!userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_ARCHIVE)) {
    throw new AppError(
      403,
      'ERR-PERMISSION-DENIED',
      'Only users with document:archive permission can activate documents',
    );
  }

  validateTransition(document.status, 'ACTIVE');

  await runInTransaction(async (tx: Transaction) => {
    await document.update(
      { status: 'ACTIVE', archivedAt: null },
      { transaction: tx },
    );

    const record = await ArchiveRecord.findOne({ where: { documentId: id }, transaction: tx });
    if (record) {
      await record.update({ status: 'ACTIVE' }, { transaction: tx });
    }

    await OutboxEvent.create(
      {
        documentId: id,
        type: 'SEARCH_INDEX_UPSERT',
        channel: 'SEARCH_INDEX',
        payload: JSON.stringify({ documentId: id, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );

    // Retention engine: activating clears an archive-triggered policy's clock
    // (retentionBaseDate() reads archivedAt, now null) — applyRetention is
    // idempotent and recomputes this the same way archiving starts it.
    await applyRetention(id, tx);
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_ACTIVATE,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { activated: true },
  });

  return { success: true };
}

// Owner-driven shortcut for document types that opt out of the approval
// chain (DocumentType.requiresApproval = false). Deliberately NOT routed
// through updateDocumentStatus/MANUAL_TRANSITION_PERMISSIONS: DRAFT -> ACTIVE
// must never become a generically-permissioned transition (see the C2 note
// in DocumentStateMachine.ts) — the type-level opt-out below is what keeps a
// document:upload-only holder from self-publishing an approval-required
// document.
export async function publishDraft(id: string, user: CurrentUser) {
  const document = await Document.findByPk(id, { include: [{ model: DocumentType, as: 'documentType' }] });
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'publish', user);
  requireLegalHoldClear(document);
  assertNotTrashed(document);

  if (document.status !== 'DRAFT')
    throw new AppError(409, 'ERR-DOCUMENT-STATE-INVALID', `Invalid document transition: ${document.status} -> ACTIVE`);

  const documentType = (document as any).documentType ?? (await DocumentType.findByPk(document.documentTypeId));
  if (!documentType || documentType.requiresApproval !== false)
    throw new AppError(
      422,
      'ERR-APPROVAL-REQUIRED',
      'This document type requires approval — submit it for approval instead of publishing directly',
    );

  const publishSubject = { role: user.role, permissions: user.permissions as never };
  if (document.ownerId !== user.userId && !userHasPermission(publishSubject, PERMISSIONS.APPROVAL_ADMIN) && !userHasPermission(publishSubject, PERMISSIONS.DOCUMENT_ARCHIVE))
    throw new AppError(403, 'ERR-NOT-DOCUMENT-OWNER', "Only the document's owner (or an approval admin) can publish it");

  validateTransition('DRAFT', 'ACTIVE');

  await runInTransaction(async (tx: Transaction) => {
    await document.update({ status: 'ACTIVE' }, { transaction: tx });

    await OutboxEvent.create(
      {
        documentId: id,
        type: 'SEARCH_INDEX',
        channel: 'SEARCH_INDEX',
        payload: JSON.stringify({ documentId: id, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_PUBLISH,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { published: true },
  });

  return { success: true };
}

export async function deleteDocument(id: string, user: CurrentUser) {
  const document = await Document.findByPk(id);
  if (!document || document.deletedAt)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);

  await document.update({ deletedAt: new Date() });

  await OutboxEvent.create({
    documentId: id,
    type: 'SEARCH_INDEX_DELETE',
    channel: 'SEARCH_INDEX',
    payload: JSON.stringify({ documentId: id, tenantId: document.tenantId }),
  });

  // Security-critical: awaited so the audit row is atomic with the deletion
  // (via the request CLS transaction). Fails the operation on audit failure.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_DELETE,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { softDeleted: true },
  });

  return { success: true };
}

/** Recycle bin listing: TRASHED documents the caller may see — their own, or
 *  tenant-wide with document:read_all (records staff). Each row carries its
 *  PurgePending countdown so the UI can show days remaining. */
export async function listTrashedDocuments(
  user: CurrentUser,
  opts: { skip?: number; take?: number } = {},
) {
  const skip = opts.skip ?? 0;
  const take = Math.min(opts.take ?? 50, 200);
  const where: Record<string, unknown> = {
    tenantId: user.tenantId,
    status: 'TRASHED',
  };
  if (!userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_READ_ALL)) {
    where.ownerId = user.userId;
  }
  const { rows, count } = await Document.findAndCountAll({
    where,
    include: [
      { model: Department, as: 'department', attributes: ['id', 'code', 'name'] },
      { model: DocumentType, as: 'documentType', attributes: ['id', 'code', 'name'] },
      { model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email'] },
      { model: PurgePending, as: 'purgePending', required: false },
    ],
    order: [['deletedAt', 'DESC']],
    offset: skip,
    limit: take,
    distinct: true,
  });
  const now = Date.now();
  const data = rows.map((row) => {
    const plain = row.get({ plain: true }) as Record<string, unknown> & {
      purgePending?: { purgeAfter: string | Date; status: string } | null;
    };
    const purgeAfter = plain.purgePending?.purgeAfter
      ? new Date(plain.purgePending.purgeAfter)
      : null;
    const daysUntilPurge = purgeAfter
      ? Math.max(0, Math.ceil((purgeAfter.getTime() - now) / 86_400_000))
      : null;
    return { ...plain, daysUntilPurge };
  });
  return { data: serializeBigInt(data), total: count, skip, take };
}

// S4-10: Staged purge for hard delete
export async function stagePurge(
  id: string,
  user: CurrentUser,
  purgeAfterDays = 90,
) {
  const document = await Document.findByPk(id);
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  if (!document.deletedAt)
    throw new AppError(
      400,
      'ERR-NOT-SOFT-DELETED',
      'Document must be soft-deleted first',
    );
  requireDocumentAccess(document, user);
  await assertStatusPermission(document, 'purge_stage', user);
  requireLegalHoldClear(document);

  const purgeAfter = new Date();
  purgeAfter.setDate(purgeAfter.getDate() + purgeAfterDays);

  // moveToTrash already creates the (unique-per-document) PurgePending row;
  // staging a manual purge re-uses it rather than violating the unique key.
  const existing = await PurgePending.findOne({ where: { documentId: id } });
  if (existing) {
    await existing.update({
      stagedAt: new Date(),
      stagedById: user.userId,
      purgeAfter,
      approvedById: null,
      approvedAt: null,
      status: 'PENDING',
    });
  } else {
    await PurgePending.create({
      documentId: id,
      stagedAt: new Date(),
      stagedById: user.userId,
      purgeAfter,
      approvedById: null,
      approvedAt: null,
      status: 'PENDING',
    });
  }

  // Security-critical: awaited so audit is atomic with staging the purge.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_PURGE_STAGED,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { purgeAfter: purgeAfter.toISOString() },
  });

  return { success: true, purgeAfter };
}

export async function approvePurge(id: string, user: CurrentUser) {
  // Tenant scope: the pending purge is only addressable through a document
  // in the caller's tenant.
  const doc = await Document.findOne({ where: { id, tenantId: user.tenantId }, attributes: ['id', 'status'] });
  if (!doc) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  await assertStatusPermission({ tenantId: user.tenantId, status: doc.status }, 'purge_approve', user);
  const pending = await PurgePending.findOne({
    where: { documentId: id, status: 'PENDING' },
  });
  if (!pending)
    throw new AppError(
      404,
      'ERR-PURGE-NOT-FOUND',
      'No pending purge found for this document',
    );

  // Maker–checker (SYSTEM-DECISIONS.md D12): the person who staged the purge
  // (or trashed the document) can never be the one who approves its
  // irreversible destruction — a second authorized person must confirm.
  if (pending.stagedById && pending.stagedById === user.userId)
    throw new AppError(
      403,
      'ERR-MAKER-CHECKER',
      'The user who staged a purge cannot approve it — a second authorized user must confirm the destruction',
    );

  // Real destruction: delete ciphertext + rows, de-index, issue a Certificate
  // of Destruction. Before this, approval only flipped a status and the bytes
  // lived on forever.
  const { executePurge } = await import('./trashService.js');
  const result = await executePurge(id, user.userId);

  // Security-critical (irreversible destruction): awaited so the audit row is
  // durably written; a failure surfaces instead of being silently swallowed.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_PURGE_APPROVED,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { approvedAt: new Date().toISOString(), certificateReference: result.certificateReference },
  });

  return { success: true, certificateReference: result.certificateReference };
}

export async function cancelPurge(id: string, user: CurrentUser) {
  const doc = await Document.findOne({ where: { id, tenantId: user.tenantId }, attributes: ['id', 'status'] });
  if (!doc) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  await assertStatusPermission({ tenantId: user.tenantId, status: doc.status }, 'purge_cancel', user);
  const pending = await PurgePending.findOne({
    where: { documentId: id, status: 'PENDING' },
  });
  if (!pending)
    throw new AppError(
      404,
      'ERR-PURGE-NOT-FOUND',
      'No pending purge found for this document',
    );

  await pending.update({ status: 'CANCELLED' });

  // Security-critical: awaited so audit is atomic with cancelling the purge.
  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOC_PURGE_CANCELLED,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: { cancelledAt: new Date().toISOString() },
  });

  return { success: true };
}

async function scopeWhere(user: CurrentUser): Promise<Record<string | symbol, unknown>> {
  const where: Record<string | symbol, unknown> = {
    deletedAt: { [Op.is]: null },
    tenantId: user.tenantId,
  };
  // C6: same per-user read scope and repository visibility rules as the list,
  // so dashboard/report totals never count rows hidden from that library.
  const readScope = await buildReadScope(user);
  where[Op.and] = readScope
    ? [readScope, excludeSignedLetterDrafts()]
    : [excludeSignedLetterDrafts()];
  return where;
}

export async function getDashboardStats(user: CurrentUser) {
  const where = await scopeWhere(user);
  /* exact detail ACL filtering is applied before counters are derived */
  const candidates = await Document.findAll({ where, attributes: ['id', 'status', 'isOnLegalHold', 'updatedAt'], order: [['updatedAt', 'DESC']] });
  const visible = await filterDocsByDetailAcl(user, candidates);
  const byStatus: Record<string, number> = {};
  let onLegalHold = 0;
  for (const doc of visible) {
    byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
    if (doc.isOnLegalHold) onLegalHold++;
  }
  const recentIds = visible.slice(0, 8).map((doc) => doc.id);
  const recentRows = recentIds.length === 0 ? [] : await Document.findAll({
    where: { ...where, id: { [Op.in]: recentIds } },
    include: [
      { model: Department, as: 'department', attributes: ['code', 'name'] },
      { model: DocumentType, as: 'documentType', attributes: ['code', 'name'] },
      { model: User, as: 'owner', attributes: ['firstName', 'lastName', 'email'] },
    ],
  });
  const recentById = new Map(recentRows.map((doc) => [doc.id, doc]));
  const recent = recentIds.map((id) => recentById.get(id)).filter((doc): doc is Document => Boolean(doc));
  return { total: visible.length, byStatus, onLegalHold, recent: serializeBigInt(recent) };
}

/** Returns the authoritative detail-ACL-visible ids for aggregate/report
 * consumers. Callers can add their own department/type filters, but must never
 * replace this pass with a coarse tenant-only count. */
export async function getDetailVisibleDocumentIds(
  user: CurrentUser,
  filters: { departmentId?: string | null; documentTypeId?: string | null } = {},
) {
  const where = await scopeWhere(user);
  if (filters.departmentId) where.departmentId = filters.departmentId;
  if (filters.documentTypeId) where.documentTypeId = filters.documentTypeId;
  const candidates = await Document.findAll({ where, attributes: ['id'] });
  const visible = await filterDocsByDetailAcl(user, candidates);
  return visible.map((doc) => doc.id);
}

export async function fetchDocumentFile(
  id: string,
  user: CurrentUser,
  options?: { certificate?: boolean },
) {
  const document = await Document.findByPk(id, {
    include: [
      {
        model: DocumentVersion,
        as: 'versions',
        separate: true,
        order: [['createdAt', 'DESC']] as const,
      },
    ],
  });
  if (!document)
    throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  requireDocumentAccess(document, user);
  assertScanCleared(document);
  await assertStatusPermission(document, 'download', user);

  const latestVersion = (document as DocumentRow).versions?.[0];
  if (!latestVersion)
    throw new AppError(404, 'ERR-VERSION-NOT-FOUND', 'No version available');

  // Default download omits the certificate-of-completion page a completed
  // e-sign ceremony always appends to the filed PAdES copy — most people
  // downloading a signed letter/document want the pages that were actually
  // signed, not also the proof-of-ceremony page bundled in. That page's
  // bytes can't be stripped from the real signed copy (it's inside the
  // PAdES byte-range signature — removing it would invalidate the
  // signature), so this regenerates a certificate-free render on demand
  // instead of serving the stored version — see generateFlattenedUnsignedPdf's
  // own comment. `?certificate=true` (or the corresponding UI action) skips
  // this and serves the real signed copy, cert page included.
  if (!options?.certificate && latestVersion.changeSummary === PADES_CHANGE_SUMMARY) {
    const baseVersion = await DocumentVersion.findOne({
      where: { documentId: document.id, changeSummary: { [Op.ne]: PADES_CHANGE_SUMMARY } },
      order: [['createdAt', 'DESC']],
    });
    const request = baseVersion
      ? await SignatureRequest.findOne({
          where: { documentId: document.id, status: 'completed' },
          order: [['completedAt', 'DESC']],
        })
      : null;
    if (baseVersion && request) {
      const [originalPdf, fields] = await Promise.all([
        fetchAndDecrypt(baseVersion.storageKey, baseVersion.id),
        SignatureField.findAll({ where: { signatureRequestId: request.id } }),
      ]);
      const pdf = await generateFlattenedUnsignedPdf({
        originalPdf,
        fields: fields.map((f) => ({
          pageNumber: f.pageNumber, x: f.x, y: f.y, width: f.width, height: f.height,
          fieldType: f.fieldType, value: f.value,
        })),
        requestId: request.id,
      });
      await writeAuditLog({
        eventType: AUDIT_EVENTS.DOCUMENT_DOWNLOADED,
        userId: user.userId,
        userRole: user.role,
        documentId: id,
        actionDetails: {
          originalFilename: latestVersion.originalFilename,
          mimeType: 'application/pdf',
          versionNumber: latestVersion.versionNumber,
          certificateOfCompletion: false,
        },
      });
      return {
        buffer: pdf,
        mimeType: 'application/pdf',
        originalFilename: (baseVersion.originalFilename ?? latestVersion.originalFilename ?? 'document.pdf').replace(/(\.pdf)?$/i, '-signed.pdf'),
      };
    }
    // No base version / completed request found (shouldn't happen for a
    // genuine PADES_CHANGE_SUMMARY version, but degrade to the real signed
    // copy rather than fail the download outright) — falls through below.
  }

  logger.info(
    {
      storageKey: latestVersion.storageKey,
      storageBucket: latestVersion.storageBucket,
    },
    'Fetching document file',
  );

  // Perf audit 2026-08-13: documents written via the streaming upload path
  // (encryptStreamAndStore — currently only tus uploads over 100MB) can be
  // large enough that buffering the whole plaintext into memory on every
  // single download/view is exactly the problem that path was added to
  // avoid on the WRITE side. DocumentDek.formatVersion tells us which layout
  // a version used; format 2 streams the response instead of buffering it.
  const dek = await DocumentDek.findOne({
    where: { versionId: latestVersion.id },
    attributes: ['formatVersion'],
  });

  if (dek?.formatVersion === 2) {
    const stream = await fetchDecryptStream(latestVersion.storageKey, latestVersion.id);

    // NOTE: unlike the buffered path below, there is no plaintext-hash
    // integrity check here — that would require buffering the whole
    // decrypted stream to hash it first, which defeats the purpose. This is
    // not a regression for these documents specifically: tusUpload.ts never
    // populates DocumentVersion.plaintextSha256 in the first place (only the
    // regular multer upload path does), so the check below is already a
    // no-op for every document that could ever be format 2. GCM's own
    // auth-tag verification (inside fetchDecryptStream) still runs and still
    // throws on tampering/corruption — as a stream error, not a pre-send
    // rejection.
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_DOWNLOADED,
      userId: user.userId,
      userRole: user.role,
      documentId: id,
      actionDetails: {
        originalFilename: latestVersion.originalFilename,
        mimeType: latestVersion.mimeType,
        versionNumber: latestVersion.versionNumber,
      },
    });

    return {
      stream,
      mimeType: latestVersion.mimeType,
      originalFilename: latestVersion.originalFilename,
    };
  }

  // S4-05: Decrypt and fetch (DEK is keyed by versionId, not documentId)
  const buffer = await fetchAndDecrypt(latestVersion.storageKey, latestVersion.id);

  logger.info(
    {
      bufferSize: buffer.length,
      expectedSize: latestVersion.fileSize.toString(),
    },
    'File buffer retrieved (decrypted)',
  );

  // BUG 2 FIX: Re-enabled integrity check comparing PLAINTEXT hash
  if (latestVersion.plaintextSha256) {
    const computedHash = crypto.createHash("sha256").update(buffer).digest("hex");
    logger.info({ computedHash, expectedHash: latestVersion.plaintextSha256 }, "Plaintext hash comparison");

    if (computedHash !== latestVersion.plaintextSha256) {
      await writeAuditLog({
        eventType: AUDIT_EVENTS.SECURITY_ALERT,
        userId: user.userId, // BUG 2 FIX: Corrected from user.id
        userRole: user.role, // BUG 2 FIX: Corrected from user.selectedRole
        documentId: id,
        actionDetails: {
          reason: "INTEGRITY_MISMATCH",
          expectedHash: latestVersion.plaintextSha256,
          actualHash: computedHash
        }
      });
      throw new AppError(409, "ERR-INTEGRITY-MISMATCH", "File integrity validation failed");
    }
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_DOWNLOADED,
    userId: user.userId,
    userRole: user.role,
    documentId: id,
    actionDetails: {
      originalFilename: latestVersion.originalFilename,
      mimeType: latestVersion.mimeType,
      versionNumber: latestVersion.versionNumber,
    },
  });

  return {
    buffer,
    mimeType: latestVersion.mimeType,
    originalFilename: latestVersion.originalFilename,
  };
}
