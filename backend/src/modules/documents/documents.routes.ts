import { restrictAuditToVisibleActors } from '../../shared/platformAdmin.js';
import { Router } from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import { logger } from '../../core/logger.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { requireACL } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { config } from '../../config/env.js';
import { AppError } from '../../core/AppError.js';
import { bufferedUploadMiddleware } from '../../shared/uploadMiddleware.js';
import { attachmentDisposition } from '../../shared/contentDisposition.js';
import {
  createDocument,
  getDocument,
  listDocuments,
  updateDocumentStatus,
  getAllowedManualTransitions,
  checkoutDocument,
  checkinDocument,
  uploadVersion,
  rollbackVersion,
  archiveDocument,
  activateDocument,
  publishDraft,
  fetchDocumentFile,
  getDashboardStats,
  applyAiSuggestedMetadataField,
  changeDocumentClassification,
  listTrashedDocuments,
  stagePurge,
  approvePurge,
  cancelPurge,
  type ListDocumentsFilters,
} from './documents.service.js';
import {
  lockDocument,
  unlockDocument,
  forceUnlock,
  getLockStatus,
} from './lockService.js';
import { generateDocumentPreview } from './previewService.js';
import { moveToTrash, restoreFromTrash, deleteDraftPermanently, getCertificateOfDestruction } from './trashService.js';
import { bulkDocumentOperation, type BulkOperation } from './bulkService.js';
import { DocumentVersion, AuditLog } from '../../infrastructure/database/index.js';
import {
  requestSigning,
  executeSigning,
  declineSigning,
  verifySigning,
} from '../signing/signing.service.js';

export const documentRoutes = Router();

// Phase 6 "tus-only >25MB": the regular multipart route buffers the whole
// file into process memory (multer.memoryStorage()), so its ceiling must
// stay small. Anything larger must go through the resumable tus endpoint,
// which streams to disk and has no such limit (see tusUpload.ts).
const MAX_BUFFERED_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const TUS_UPLOAD_PATH = `${config.API_BASE_PATH}/documents/upload/tus`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BUFFERED_UPLOAD_BYTES },
});

// Wraps multer's field parser so ANY MulterError (not just LIMIT_FILE_SIZE)
// comes back as a clear, actionable JSON error instead of falling through to
// the generic 500 handler (multer's error isn't an AppError/ZodError
// instance) — see shared/uploadMiddleware.ts for the shared implementation
// and why LIMIT_FILE_SIZE gets a per-endpoint message here.
function handleBufferedUpload(fieldName: string) {
  return bufferedUploadMiddleware(upload, fieldName, {
    fileTooLargeCode: 'ERR-FILE-TOO-LARGE',
    fileTooLargeMessage:
      `File exceeds the ${MAX_BUFFERED_UPLOAD_BYTES / (1024 * 1024)}MB limit for this endpoint. ` +
      `Use the resumable upload endpoint instead: POST ${TUS_UPLOAD_PATH}`,
  });
}

documentRoutes.post(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  handleBufferedUpload('file'),
  asyncHandler(async (req, res) =>
    res.status(201).json(await createDocument(req.body, req.file, req.user!)),
  ),
);
// Bulk operations — declared before /:id routes so "bulk" is never read as an id.
documentRoutes.post(
  '/bulk',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    const { operation, documentIds, params } = req.body ?? {};
    const result = await bulkDocumentOperation(
      req.user!,
      operation as BulkOperation,
      documentIds,
      params ?? {},
    );
    // 207 Multi-Status when some failed, 200 when all succeeded
    res.status(result.summary.failed > 0 ? 207 : 200).json(result);
  }),
);

documentRoutes.get(
  '/stats',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) =>
    res.json(await getDashboardStats(req.user!)),
  ),
);
documentRoutes.get(
  '/',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const take = req.query.take ? Number(req.query.take) : 20;
    // Parse filters from individual query params
    const filters: ListDocumentsFilters = {};
    if (req.query.folderId) filters.folderId = String(req.query.folderId);
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.q) filters.q = String(req.query.q);
    if (req.query.departmentId) filters.departmentId = String(req.query.departmentId);
    if (req.query.documentTypeId) filters.documentTypeId = String(req.query.documentTypeId);
    // "My Files" page filter — combines with the existing per-user read scope
    // (buildReadScope in documents.service.ts), so passing someone else's id
    // here just intersects down to whatever this caller could already see.
    if (req.query.ownerId) filters.ownerId = String(req.query.ownerId);
    if (req.query.ocrStatus) filters.ocrStatus = String(req.query.ocrStatus);
    if (req.query.checkedOut === 'true') filters.checkedOut = true;
    if (req.query.retentionRelevant === 'true') filters.retentionRelevant = true;
    // Opt back in to the letter signature artifacts the library hides by
    // default (see the exclusion in listDocuments) — for records/audit views
    // that genuinely want every filed object, not the reading library.
    if (req.query.includeLetterSignedDrafts === 'true') filters.includeLetterSignedDrafts = true;
    if (req.query.dateFrom) filters.dateFrom = String(req.query.dateFrom);
    if (req.query.dateTo) filters.dateTo = String(req.query.dateTo);
    if (req.query.sortBy) filters.sortBy = String(req.query.sortBy);
    if (req.query.sortDir) filters.sortDir = String(req.query.sortDir);
    if (req.query.cursor) filters.cursor = String(req.query.cursor);

    const result = await listDocuments(req.user!, skip, take, filters);
    // This is an authorization-scoped, mutable repository listing. A browser
    // cache window makes a document filed by another surface (for example,
    // bundle compilation) disappear from My Files and dashboard navigation
    // until the TTL expires. Query caching is handled deliberately by the UI;
    // do not let HTTP cache override an explicit invalidation.
    res.set('Cache-Control', 'private, no-store');
    res.json(result);
  }),
);
// Recycle bin: trashed documents visible to the caller (own items; tenant-wide
// with document:read_all), with purge countdown from the PurgePending row.
// MUST register before '/:id' or "trash" is captured as a document id.
documentRoutes.get(
  '/trash',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    const result = await listTrashedDocuments(req.user!, {
      skip: req.query.skip ? Number(req.query.skip) : 0,
      take: req.query.take ? Number(req.query.take) : 50,
    });
    res.json(result);
  }),
);
documentRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) =>
    res.json(await getDocument(String(req.params.id), req.user!)),
  ),
);
// The manual status transitions the current user may perform on this document,
// so the detail-view status control offers exactly the valid options (never a
// subsystem-driven or unpermitted one). Read access is enough to see them; each
// option is already gated by its own permission server-side.
documentRoutes.get(
  '/:id/allowed-transitions',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) =>
    res.json({ data: await getAllowedManualTransitions(String(req.params.id), req.user!) }),
  ),
);
documentRoutes.patch(
  '/:id/status',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  asyncHandler(async (req, res) =>
    res.json(
      await updateDocumentStatus(
        String(req.params.id),
        String(req.body.toState),
        req.user!,
      ),
    ),
  ),
);

// Change the classification (owner, department head who can read it, or an administrator; lowering needs a reason). See
// changeDocumentClassification.
documentRoutes.patch(
  '/:id/classification',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const updated = await changeDocumentClassification(String(req.params.id), req.body ?? {}, req.user!);
    res.json({ data: updated });
  }),
);

// Apply a single AI-suggested metadata field (from Document.aiSuggestedMetadata,
// see AIWorker.extractMetadata) onto the real Document/DocumentMetadata columns.
documentRoutes.patch(
  '/:id/metadata/apply-suggestion',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  asyncHandler(async (req, res) => {
    const { field, value } = req.body as { field: string; value: unknown };
    const updated = await applyAiSuggestedMetadataField(String(req.params.id), field, value, req.user!);
    res.json({ data: updated });
  }),
);

documentRoutes.get(
  '/:id/versions',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const versions = await DocumentVersion.findAll({
      where: { documentId: String(req.params.id) },
      order: [['createdAt', 'DESC']],
    });
    // toJSON(), not { ...v }. Spreading a Sequelize model instance copies its
    // OWN enumerable properties — dataValues, _previousDataValues, uniqno,
    // _changed, _options, isNewRecord — and none of the attributes, which live
    // on prototype getters. This endpoint was returning exactly that shape:
    //
    //   { dataValues, _previousDataValues, uniqno, _changed, _options,
    //     isNewRecord, fileSize }
    //
    // No error, no empty response, a 200 with a plausible-looking body — and
    // not one version field in it. It went unnoticed because the document
    // detail page reads versions off the include on GET /documents/:id instead
    // of calling this route.
    const serialized = versions.map((v) => ({
      ...v.toJSON(),
      // fileSize is a BIGINT; JSON has no 64-bit integer, so it goes out as a
      // string rather than silently losing precision past 2^53.
      fileSize: v.fileSize.toString(),
    }));
    res.json({ data: serialized });
  }),
);

documentRoutes.post(
  '/:id/checkout',
  requirePermission(PERMISSIONS.DOCUMENT_CHECKOUT),
  requireACL({ resourceType: 'document', permission: 'document:checkout' }),
  asyncHandler(async (req, res) => {
    const result = await checkoutDocument(
      String(req.params.id),
      req.user!,
      req.body.notes,
    );
    res.json(result);
  }),
);
documentRoutes.post(
  '/:id/checkin',
  requirePermission(PERMISSIONS.DOCUMENT_CHECKOUT),
  requireACL({ resourceType: 'document', permission: 'document:checkout' }),
  asyncHandler(async (req, res) => {
    const result = await checkinDocument(String(req.params.id), req.user!);
    res.json(result);
  }),
);
documentRoutes.post(
  '/:id/versions',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  handleBufferedUpload('file'),
  asyncHandler(async (req, res) => {
    const isMajor = req.body.isMajor === 'true' || req.body.isMajor === true;
    const result = await uploadVersion(
      String(req.params.id),
      req.file,
      isMajor,
      req.body.changeSummary || '',
      req.user!,
    );
    res.status(201).json(result);
  }),
);
documentRoutes.post(
  '/:id/rollback',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  asyncHandler(async (req, res) => {
    const result = await rollbackVersion(
      String(req.params.id),
      String(req.body.versionId),
      req.user!,
    );
    res.json(result);
  }),
);
documentRoutes.post(
  '/:id/archive',
  requirePermission(PERMISSIONS.DOCUMENT_ARCHIVE),
  requireACL({ resourceType: 'document', permission: 'document:archive' }),
  asyncHandler(async (req, res) => {
    const result = await archiveDocument(String(req.params.id), req.user!);
    res.json(result);
  }),
);
// Reverse of archive: bring an ARCHIVED document back to ACTIVE. Same
// permission as archiving — see activateDocument for why.
documentRoutes.post(
  '/:id/activate',
  requirePermission(PERMISSIONS.DOCUMENT_ARCHIVE),
  requireACL({ resourceType: 'document', permission: 'document:archive' }),
  asyncHandler(async (req, res) => {
    const result = await activateDocument(String(req.params.id), req.user!);
    res.json(result);
  }),
);
// Owner-driven publish for document types that opt out of approval
// (DocumentType.requiresApproval = false) — see publishDraft for the
// service-level guard that actually enforces the opt-out.
documentRoutes.post(
  '/:id/publish',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  asyncHandler(async (req, res) => {
    const result = await publishDraft(String(req.params.id), req.user!);
    res.json(result);
  }),
);

// S4-12: Document lock endpoints (using doc_locks table)
documentRoutes.post(
  '/:id/lock',
  requirePermission(PERMISSIONS.DOCUMENT_CHECKOUT),
  requireACL({ resourceType: 'document', permission: 'document:checkout' }),
  asyncHandler(async (req, res) => {
    const result = await lockDocument(
      String(req.params.id),
      req.user!,
      req.body.reason,
      req.body.durationHours,
    );
    res.json(result);
  }),
);

documentRoutes.delete(
  '/:id/lock',
  requirePermission(PERMISSIONS.DOCUMENT_CHECKOUT),
  requireACL({ resourceType: 'document', permission: 'document:checkout' }),
  asyncHandler(async (req, res) => {
    const result = await unlockDocument(String(req.params.id), req.user!);
    res.json(result);
  }),
);

// S4-14: Force unlock endpoint (DEPT_MANAGER only).
// M14: this route had NO ACL middleware at all — any department:manage holder
// could force-unlock any document in the tenant, across departments. It now
// requires a per-document ACL (admins pass via the ACL_BYPASS_ADMIN branch
// inside requireACL); the service still enforces the role + mandatory-reason
// rules on top. The ACL is document:READ (live department scope, sub-department
// documents included), not document:checkout: only a document's OWNER holds
// checkout, and a force-unlock exists precisely for a manager who is NOT the
// owner — gating it on checkout made the button answer 403 for every manager.
documentRoutes.post(
  '/:id/force-unlock',
  requirePermission(PERMISSIONS.DOCUMENT_CHECKOUT),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const result = await forceUnlock(
      String(req.params.id),
      req.user!,
      req.body.reason,
    );
    res.json(result);
  }),
);

documentRoutes.get(
  '/:id/lock-status',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const status = await getLockStatus(String(req.params.id));
    res.json(status);
  }),
);

// S4-16: Soft delete to trash
documentRoutes.post(
  '/:id/trash',
  requirePermission(PERMISSIONS.DOCUMENT_ARCHIVE),
  requireACL({ resourceType: 'document', permission: 'document:archive' }),
  asyncHandler(async (req, res) => {
    const result = await moveToTrash(String(req.params.id), req.user!);
    res.json(result);
  }),
);

documentRoutes.post(
  '/:id/restore',
  requirePermission(PERMISSIONS.DOCUMENT_ARCHIVE),
  requireACL({ resourceType: 'document', permission: 'document:archive' }),
  asyncHandler(async (req, res) => {
    const result = await restoreFromTrash(String(req.params.id), req.user!);
    res.json(result);
  }),
);

// Direct hard delete for DRAFT documents only — bypasses Trash and the
// maker-checker purge flow entirely (see trashService.deleteDraftPermanently
// for why: an unpublished draft was never a managed record, so there is
// nothing to certify the destruction of). Same permission/ACL as Discard
// (the DRAFT -> CANCELLED status transition), since both act on the exact
// same precondition and author.
documentRoutes.delete(
  '/:id',
  requirePermission(PERMISSIONS.DOCUMENT_UPLOAD),
  requireACL({ resourceType: 'document', permission: 'document:upload' }),
  asyncHandler(async (req, res) => {
    const result = await deleteDraftPermanently(String(req.params.id), req.user!);
    res.json(result);
  }),
);

// Look up an already-issued Certificate of Destruction — the purge/approve
// response below hands the reference back exactly once (in a toast), with
// nowhere to see it again afterward. Same permission as the purge actions
// themselves, since this documents a completed destruction.
documentRoutes.get(
  '/certificates/:reference',
  requirePermission(PERMISSIONS.DOCUMENT_PURGE),
  asyncHandler(async (req, res) => {
    const cert = await getCertificateOfDestruction(String(req.params.reference));
    res.json({ data: cert });
  }),
);

// Staged purge (permanent destruction) with maker–checker: the stager and the
// approver must be different users (SYSTEM-DECISIONS.md D12).
documentRoutes.post(
  '/:id/purge/stage',
  requirePermission(PERMISSIONS.DOCUMENT_PURGE),
  requireACL({ resourceType: 'document', permission: 'document:purge' }),
  asyncHandler(async (req, res) => {
    const days = req.body?.purgeAfterDays ? Number(req.body.purgeAfterDays) : undefined;
    const result = await stagePurge(String(req.params.id), req.user!, days);
    res.json(result);
  }),
);

documentRoutes.post(
  '/:id/purge/approve',
  requirePermission(PERMISSIONS.DOCUMENT_PURGE),
  requireACL({ resourceType: 'document', permission: 'document:purge' }),
  asyncHandler(async (req, res) => {
    const result = await approvePurge(String(req.params.id), req.user!);
    res.json(result);
  }),
);

documentRoutes.post(
  '/:id/purge/cancel',
  requirePermission(PERMISSIONS.DOCUMENT_PURGE),
  requireACL({ resourceType: 'document', permission: 'document:purge' }),
  asyncHandler(async (req, res) => {
    const result = await cancelPurge(String(req.params.id), req.user!);
    res.json(result);
  }),
);

documentRoutes.get(
  '/:id/download',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const result = await fetchDocumentFile(String(req.params.id), req.user!, {
      certificate: req.query.certificate === 'true',
    });
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', attachmentDisposition(result.originalFilename));
    if (result.stream) {
      try {
        await pipeline(result.stream, res);
      } catch (err) {
        logger.error(
          { err, documentId: req.params.id },
          'Streaming document download failed mid-stream',
        );
        // If nothing has reached the client yet, surface a normal error
        // response. If bytes already went out (large-file streaming, so this
        // can happen partway through), there's no clean response left to
        // send — just end the connection instead of attempting a second one.
        if (!res.headersSent) throw err;
        res.destroy();
      }
      return;
    }
    res.send(result.buffer);
  }),
);

// S4-18: Preview endpoint (thumbnail only, not full file)
documentRoutes.get(
  '/:id/preview',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const preview = await generateDocumentPreview(
      String(req.params.id),
      req.user!,
    );
    if (!preview) {
      throw new AppError(415, 'ERR-PREVIEW-NOT-SUPPORTED', 'Preview not supported for this file type');
    }
    res.setHeader('Content-Type', preview.mimeType);
    // `private`, never `public`: this is an ACL-gated rendering of a document's
    // contents. `public` lets a shared cache (reverse proxy, corporate gateway)
    // store it and hand it to someone with no access for the next hour; the
    // browser's own copy is still allowed to live for that hour.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(preview.buffer);
  }),
);

// FIX: `/storage/files` and `/storage/download` used to let any caller
// holding the blanket DOCUMENT_READ permission enumerate and download every
// file under storage/dms-documents, across every tenant and department,
// with no tenant scoping and no per-resource ACL check at all — only a
// path-traversal guard. Nothing in the frontend calls either route (grep
// confirms zero references), and the real download path
// (documents.service.ts's fetchDocumentFile, via fetchAndDecrypt) already
// enforces requireDocumentAccess per document. Removed rather than
// tenant-scoped, since there is no legitimate caller to preserve.

// Word-count ceiling for the version-diff endpoint below (Finding 4): above
// this, the O(m*n) computeLCS DP table becomes a real hang/OOM risk.
const DIFF_MAX_WORDS = 5000;

// Version text diff — compare extracted text between any two document versions
documentRoutes.get(
  '/:id/versions/diff',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const { v1, v2 } = req.query as { v1?: string; v2?: string };
    if (!v1 || !v2) {
      throw new Error('v1 and v2 version IDs are required');
    }

    const [ver1, ver2] = await Promise.all([
      DocumentVersion.findOne({ where: { id: v1, documentId: req.params.id } }),
      DocumentVersion.findOne({ where: { id: v2, documentId: req.params.id } }),
    ]);

    if (!ver1 || !ver2) {
      throw new Error('One or both versions not found for this document');
    }

    const text1 = (ver1.extractedText ?? '').split(/\s+/).filter(Boolean);
    const text2 = (ver2.extractedText ?? '').split(/\s+/).filter(Boolean);

    // FIX: computeLCS below builds a full (m+1)x(n+1) DP table with no cap —
    // O(m*n) time AND memory. Two real, multi-page OCR'd documents can each
    // run tens of thousands of words, so an uncapped diff request here is a
    // hang/OOM risk on a single authenticated request. Cap the input size and
    // report the diff as unavailable for documents this large rather than
    // attempting the full table; a real O(ND) algorithm is a separate,
    // larger effort if this ceiling ever proves too tight in practice.
    if (text1.length > DIFF_MAX_WORDS || text2.length > DIFF_MAX_WORDS) {
      res.json({
        data: {
          v1: { id: ver1.id, versionNumber: ver1.versionNumber, createdAt: ver1.createdAt },
          v2: { id: ver2.id, versionNumber: ver2.versionNumber, createdAt: ver2.createdAt },
          diff: null,
          truncated: true,
          message: `Diff unavailable: one or both versions exceed the ${DIFF_MAX_WORDS}-word comparison limit (v1: ${text1.length} words, v2: ${text2.length} words).`,
          stats: null,
        },
      });
      return;
    }

    // Myers diff LCS-based word diff
    const lcs = computeLCS(text1, text2);
    const diff = buildDiff(text1, text2, lcs);

    res.json({
      data: {
        v1: { id: ver1.id, versionNumber: ver1.versionNumber, createdAt: ver1.createdAt },
        v2: { id: ver2.id, versionNumber: ver2.versionNumber, createdAt: ver2.createdAt },
        diff,
        truncated: false,
        stats: {
          additions: diff.filter((s: any) => s.type === 'add').length,
          deletions: diff.filter((s: any) => s.type === 'del').length,
          unchanged: diff.filter((s: any) => s.type === 'eq').length,
        },
      },
    });
  }),
);

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function buildDiff(a: string[], b: string[], dp: number[][]): Array<{ type: 'eq' | 'add' | 'del'; value: string }> {
  const result: Array<{ type: 'eq' | 'add' | 'del'; value: string }> = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'eq', value: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', value: b[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'del', value: a[i - 1] });
      i--;
    }
  }
  // Merge consecutive same-type tokens into segments (max 50 words per segment for readability)
  const merged: Array<{ type: 'eq' | 'add' | 'del'; value: string }> = [];
  for (const seg of result) {
    const last = merged[merged.length - 1];
    if (last && last.type === seg.type) {
      last.value += ' ' + seg.value;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// S6-07: E-signature sub-routes
documentRoutes.post(
  '/:id/sign/request',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const result = await requestSigning(String(req.params.id), req.user!);
    res.json(result);
  }),
);

documentRoutes.post(
  '/:id/sign/execute',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const { signingType, consentAcknowledged } = req.body;
    const result = await executeSigning(
      String(req.params.id),
      req.user!,
      signingType ?? 'ELECTRONIC',
      {
        // Non-repudiation evidence is taken from the connection (req.ip honours only the trusted proxy
        // hop), never from the body: a signer could otherwise write any address into their own record.
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] as string,
        consentAcknowledged: consentAcknowledged === true,
      },
    );
    res.json(result);
  }),
);

documentRoutes.post(
  '/:id/sign/decline',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const result = await declineSigning(
      String(req.params.id),
      req.user!,
      reason ?? '',
    );
    res.json(result);
  }),
);

documentRoutes.get(
  '/:id/sign/verify',
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const result = await verifySigning(String(req.params.id), req.user!);
    res.json(result);
  }),
);

// MoReq2010: per-entity intrinsic audit history accessible from the document endpoint.
// Returns the audit events for this document ordered newest first.
documentRoutes.get(
  '/:id/history',
  requirePermission(PERMISSIONS.AUDIT_READ),
  requireACL({ resourceType: 'document', permission: 'document:read' }),
  asyncHandler(async (req, res) => {
    const logs = await AuditLog.findAll({
      where: await restrictAuditToVisibleActors(
        { documentId: String(req.params.id), tenantId: req.user!.tenantId },
        req.user!.userId,
      ),
      order: [['sequenceNumber', 'DESC']],
      limit: 500,
    });
    const serialized = logs.map((l) => {
      const plain = l.toJSON();
      return { ...plain, sequenceNumber: plain.sequenceNumber?.toString() ?? '0' };
    });
    res.json({ data: serialized, total: serialized.length });
  }),
);
