// S4-08: tus.io resumable upload endpoint
// Handles large file uploads (>= 50 MB) using tus protocol
// After upload completes, runs same validation chain as regular upload

import { classificationLabel } from "../../shared/classifiedAccess.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Server as TusServer, Upload } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Request, Response } from "express";
import { z } from "zod";
import { config } from "../../config/env.js";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import {
  Department,
  Document,
  DocumentDek,
  DocumentMetadata,
  DocumentType,
  DocumentVersion,
  FolderNode,
  OutboxEvent,
  RetentionPolicy,
  sequelize
} from "../../infrastructure/database/index.js";
import { Transaction as SequelizeTransaction, Transaction } from "sequelize";
import { encryptAndStore, encryptStreamAndStore } from "./documentCrypto.js";
import { nextDocumentName, ensureCanCreate, assertDocumentTypeInScope } from "./documents.service.js";
import { scanBuffer } from "../../infrastructure/antivirus/clamscan.js";
import { validateUploadedFile as validateMimeAndExtension } from "./mimeValidation.js";
import { checkStorageQuota, reserveStorageQuota } from "./quotaService.js";
import { writeIndexSidecar } from "./indexSidecar.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { applyRetention } from "../retention/retentionEngine.js";
import { sanitizeFilename } from "../../shared/sanitizeFilename.js";
import { departmentCodeNotRegistered } from "../../shared/departmentCodeError.js";

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
};

function detectMimeType(buffer: Buffer, filename?: string): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return "application/pdf";
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      const ext = filename?.split('.').pop()?.toLowerCase();
      if (ext === 'docx') return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (ext === 'xlsx') return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (ext === 'pptx') return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      return "application/zip";
    }
    if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)) {
      return "image/tiff";
    }
  }
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return "application/pdf";
  if (ext === 'png') return "image/png";
  if (ext === 'jpg' || ext === 'jpeg') return "image/jpeg";
  if (ext === 'txt') return "text/plain";
  if (ext === 'csv') return "text/csv";
  if (ext === 'xml') return "application/xml";
  if (ext === 'eml') return "message/rfc822";
  return "application/octet-stream";
}

const tusMetadataSchema = z.object({
  title: z.string().min(1).max(255),
  // departmentId is the precise, collision-free field (same fix as
  // documents.service.ts's createDocument) — department codes are only
  // unique per (tenant, org unit), so resolving by code alone could silently
  // resolve to the WRONG same-coded department in a different org unit.
  // departmentCode is kept only for a tus client not yet updated to send an id.
  departmentId: z.string().uuid().optional(),
  departmentCode: z.string().min(2).max(10).optional(),
  documentTypeCode: z.string().min(2).max(10),
  organisationUnit: z.string().min(1).max(100),
  securityClassification: z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]),
  retentionClass: z.string().min(1).max(50),
  source: z.enum(["MANUAL_UPLOAD", "SCANNER", "EMAIL", "API", "CREATED_IN_SYSTEM", "MIGRATION"]),
  retentionTriggerDate: z.string().optional(),
  keywords: z.string().optional(),
  description: z.string().optional(),
  language: z.string().max(10).optional(),
  originatingSystem: z.string().max(100).optional(),
  confidentialityNotice: z.string().max(500).optional(),
  geographicScope: z.string().max(100).optional(),
  externalReference: z.string().max(200).optional(),
  folderPath: z.string().optional(),
  changeSummary: z.string().max(2000).optional(),
  filename: z.string()
}).refine((data) => Boolean(data.departmentId || data.departmentCode), {
  message: "departmentId or departmentCode is required",
  path: ["departmentId"],
});

// FIX: this used to duplicate documentCrypto.ts's encryptAndStore verbatim —
// a second, independently-maintained write path for document ciphertext,
// directly contradicting that module's own "single write path" invariant.
// Delegates to the canonical implementation now.

// FIX (platform audit finding 4.4): this used to duplicate
// documents.service.ts's nextDocumentName verbatim — a second,
// independently-maintained document-numbering allocator with no row lock at
// all (not even the reconciliation-against-existing-rows safety net the
// canonical version has), so it could both race with itself under
// concurrent large-file uploads AND drift out of sync with numbers the
// canonical allocator hands out. Delegates to the canonical implementation
// now, same "single write path" fix already applied to this file's
// encryptAndStore duplicate above.

// FIX: this used to be its own local copy — a hardcoded role blocklist
// (only AUDITOR/APPROVER refused) plus a tenant-match check that never
// looked at department membership at all, so any other role (EMPLOYEE,
// DEPT_MANAGER, EXECUTIVE...) could tus-upload a large file straight into
// ANY department in the tenant. The comment here already said "Mirrors the
// role gate in documents.service.ts createDocument" — now it actually does,
// via the shared, department-scoped implementation imported above, instead
// of a second copy that silently drifted from it.

// Create tus server with file store
const tusUploadPath = path.join(process.cwd(), "storage", "tus-uploads");

// FIX: abandoned/incomplete tus uploads (client never resumes/finishes) never
// hit onUploadFinish's cleanup — nothing else in the system swept
// storage/tus-uploads, so partial files + their .json sidecars accumulated on
// disk indefinitely. expirationPeriodInMilliseconds + the scheduled
// cleanupExpiredTusUploads() sweep below (see TusUploadCleanupWorker.ts) makes
// @tus/file-store's own deleteExpired() reclaim any upload that's sat
// incomplete (size !== offset) longer than this window.
const TUS_UPLOAD_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const tusDataStore = new FileStore({
  directory: tusUploadPath,
  expirationPeriodInMilliseconds: TUS_UPLOAD_EXPIRATION_MS,
});

/**
 * Sweeps storage/tus-uploads for abandoned/incomplete uploads older than
 * TUS_UPLOAD_EXPIRATION_MS and removes their bytes + metadata sidecar.
 * Called on a schedule by TusUploadCleanupWorker.ts. Never throws — a sweep
 * failure should log, not crash the worker.
 */
export async function cleanupExpiredTusUploads(): Promise<{ removedCount: number }> {
  try {
    const removedCount = await tusDataStore.deleteExpired();
    if (removedCount > 0) {
      logger.info({ removedCount }, "Swept expired/abandoned tus uploads");
    }
    return { removedCount };
  } catch (err) {
    logger.warn({ error: err }, "Failed to sweep expired tus uploads");
    return { removedCount: 0 };
  }
}

// The documented per-file ceiling (the Upload page says "max 500 MB each" and the buffered upload's
// validateUploadInput rejects above it). The tus server had NO size limit: an authenticated uploader could
// stream arbitrary bytes into storage/tus-uploads, and the tenant-quota check only ran after the last byte.
const TUS_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const tusServer = new TusServer({
  path: "/api/v1/documents/upload/tus",
  maxSize: TUS_MAX_UPLOAD_BYTES,
  datastore: tusDataStore,
  namingFunction: (_req) => crypto.randomUUID(),
  onUploadFinish: async (req: any, upload: Upload): Promise<any> => {
    // @tus/server hands hooks a web-standard Request wrapper (srvx), NOT the
    // Express request the authenticate middleware decorated — the node req
    // (and its .user) lives at req.runtime.node.req (req.node.req on older
    // versions). Reading req.user off the wrapper always yielded undefined,
    // which failed every COMPLETED tus upload with a 500 "Authentication
    // required" at the final PATCH.
    const nodeReq = req?.runtime?.node?.req ?? req?.node?.req ?? req;
    const user = nodeReq?.user as CurrentUser | undefined;
    if (!user) {
      throw new AppError(401, "ERR-UNAUTHORIZED", "Authentication required");
    }

    // upload.metadata is ALREADY decoded: @tus/utils' Metadata.parse base64-
    // decodes every Upload-Metadata value before storing it. The old code here
    // base64-decoded a second time, turning every value into mojibake — the
    // enum fields then failed validation and every completed tus upload 500'd.
    const metadata = upload.metadata ?? {};
    const metadataObj: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === "string") metadataObj[key] = value;
    }

    const data = tusMetadataSchema.parse(metadataObj);

    // Read the uploaded file from tus storage
    const tusFilePath = path.join(tusUploadPath, upload.id);

    // FIX: the temp file at tusFilePath used to only be unlinked on the
    // success path — any thrown error (quota, MIME validation, virus scan,
    // a DB failure) left it on disk forever, since nothing else in the
    // system ever sweeps storage/tus-uploads. Wrapping the whole handler in
    // try/finally guarantees cleanup on every exit path.
    try {
      return await processTusUpload(user, upload, data, tusFilePath);
    } finally {
      try {
        await fs.unlink(tusFilePath);
        logger.debug({ uploadId: upload.id }, "Cleaned up tus temporary file");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.warn({ uploadId: upload.id, error: err }, "Failed to clean up tus temporary file");
        }
      }
    }
  }
});

const MIME_SNIFF_BYTES = 4100; // file-type only ever inspects a small leading sample of a file

/** Read just the first `maxBytes` of a file without loading the rest — used
 *  for mime-sniffing on the large-file streaming path below, where reading
 *  the whole file defeats the point of not buffering it. */
async function readFilePrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function processTusUpload(
  user: CurrentUser,
  upload: Upload,
  data: z.infer<typeof tusMetadataSchema>,
  tusFilePath: string,
): Promise<any> {
    const { size: fileSize } = await fs.stat(tusFilePath);

    logger.info(
      { uploadId: upload.id, fileSize, filename: data.filename, userId: user.userId },
      "Tus upload completed, processing validation chain"
    );

    // Cheap early-exit only — NOT the authoritative check, which happens
    // atomically inside the transaction below via reserveStorageQuota. This
    // used to be the only check, run before the bytes even land in the DB
    // path; two concurrent large tus uploads could each pass it and both
    // commit, blowing past the tenant's quota (the classic TOCTOU this
    // codebase already fixed for the regular multipart upload path).
    await checkStorageQuota(user.tenantId, fileSize);

    const ASYNC_SCAN_THRESHOLD = 100 * 1024 * 1024; // 100 MB
    // Perf audit 2026-08-13: this threshold now ALSO decides whether the file
    // is fully read into memory at all. Below it, behavior is 100% unchanged
    // (buffer everything, exactly as before). Above it, nothing reads the
    // whole file into memory — mime detection sniffs a small prefix, AV
    // scanning is already skipped in favor of the async queue below, and
    // encryption streams straight from disk (encryptStreamAndStore).
    const useAsyncScan = fileSize > ASYNC_SCAN_THRESHOLD;
    const useStreamingEncrypt = useAsyncScan;

    const fileBuffer = useStreamingEncrypt ? null : await fs.readFile(tusFilePath);
    const sniffBuffer = fileBuffer ?? (await readFilePrefix(tusFilePath, MIME_SNIFF_BYTES));
    await validateMimeAndExtension(sniffBuffer, data.filename);

    // Resolve department and document type — scoped to user's tenant
    //
    // THIS READ MUST CARRY THE TENANT GUC. The tus route is mounted outside
    // tenantContext (app.ts mounts it before the body parsers), so unlike the
    // buffered upload path there is no ambient tenant-scoped transaction here.
    // `departments` is the one RLS policy with no fail-open clause --
    // `tenant_id = current_setting('app.current_tenant')` and nothing else --
    // so reading it with the GUC unset returns ZERO rows and EVERY department
    // code looks unregistered. Same visible defect that broke every buffered
    // upload over 64 KB on 2026-09-09, reached a different way: this path was
    // never in a tenant transaction at all, so it applied at every file size.
    //
    // A short read-only transaction of its own, rather than hoisting these
    // into the SERIALIZABLE write transaction below: that one deliberately
    // opens only after AV scanning and encryption, so widening it would hold
    // a pooled connection for the whole scan of a very large file.
    const { department, documentType, folderId } = await sequelize.transaction(async (tx) => {
      await sequelize.query(`SET LOCAL app.current_tenant = :tenantId`, {
        transaction: tx,
        replacements: { tenantId: user.tenantId },
      });
      const [dept, docType] = await Promise.all([
        data.departmentId
          ? Department.findOne({ where: { id: data.departmentId, tenantId: user.tenantId }, transaction: tx })
          : Department.findOne({ where: { code: data.departmentCode!.toUpperCase(), tenantId: user.tenantId }, transaction: tx }),
        DocumentType.findOne({ where: { code: data.documentTypeCode.toUpperCase(), tenantId: user.tenantId }, transaction: tx }),
      ]);
      // Both checks stay INSIDE this transaction so the diagnostic in
      // departmentCodeNotRegistered (which lists the tenant's real codes)
      // also runs with the GUC set -- otherwise it would report an empty
      // department list and point at entirely the wrong cause.
      if (!dept) {
        if (data.departmentId) {
          throw new AppError(422, "ERR-DEPT-INVALID", "Selected department was not found in your organization");
        }
        throw await departmentCodeNotRegistered(data.departmentCode, user, {
          route: "POST /documents (tus resumable)",
          lookedUpAs: data.departmentCode!.toUpperCase(),
        });
      }
      if (!docType) throw new AppError(422, "ERR-DOCTYPE-INVALID", "Document type code is not registered in your tenant");
      // The buffered upload rejects an unknown retention class (ERR-RETENTION-INVALID); this path accepted any string.
      const retention = await RetentionPolicy.findOne({ where: { code: data.retentionClass }, transaction: tx });
      if (!retention) throw new AppError(422, "ERR-RETENTION-INVALID", "Retention class is not registered");
      // The chosen folder was accepted by the metadata schema and then ignored, so a large file picked into a
      // folder landed unfiled. Same checks as the buffered upload: a real active folder of this tenant, in the
      // document's own department.
      let resolvedFolderId: string | null = null;
      if (data.folderPath) {
        const folder = await FolderNode.findOne({
          where: { path: data.folderPath, tenantId: user.tenantId, isActive: true },
          transaction: tx,
        });
        if (!folder) throw new AppError(422, "ERR-FOLDER-INVALID", "Selected folder path is not valid for this tenant");
        if (folder.departmentId && folder.departmentId !== dept.id) {
          throw new AppError(422, "ERR-FOLDER-DEPARTMENT-MISMATCH", "Folder belongs to a different department than the document");
        }
        resolvedFolderId = folder.id;
      }
      return { department: dept, documentType: docType, folderId: resolvedFolderId };
    });

    // Same document-type scope rule as the buffered upload (see assertDocumentTypeInScope).
    assertDocumentTypeInScope(documentType, department, user as Parameters<typeof assertDocumentTypeInScope>[2]);
    // Department-scoped permission gate (see the import comment above).
    await ensureCanCreate(user, department.id);

    let avScanStatus: "clean" | "unscanned" = "unscanned";
    if (!useAsyncScan && fileBuffer) {
      avScanStatus = await scanBuffer(fileBuffer);
    }

    const mimeType = detectMimeType(sniffBuffer, data.filename);

    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
    const storageKey = `${user.tenantId}/${department.code}/${documentType.code}/${documentId}/${versionId}/${sanitizeFilename(data.filename)}`;

    const { encryptedKey, sha256Hash: encHash, kekId, formatVersion } = useStreamingEncrypt
      ? await encryptStreamAndStore(
          storageKey,
          () => createReadStream(tusFilePath),
          mimeType,
          user.tenantId,
        )
      : {
          ...(await encryptAndStore(storageKey, fileBuffer!, mimeType, department.id, user.tenantId)),
          formatVersion: 1,
        };

    const document = await sequelize.transaction(
      { isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.SERIALIZABLE },
      async (tx: Transaction) => {
        // This bare transaction runs OUTSIDE the tenantContext middleware (the
        // tus route is mounted separately), so it must set its own tenant GUC as
        // its first statement — mirroring createDocument. Without it, the day the
        // DB role is switched away from superuser the documents/versions/acl
        // inserts below would violate the RLS WITH CHECK (GUC unset → policy
        // predicate false) and every tus upload would fail (S19 audit finding 4b).
        await sequelize.query(`SET LOCAL app.current_tenant = :tenantId`, {
          transaction: tx,
          replacements: { tenantId: user.tenantId },
        });
        // FIX: this is the authoritative, atomic quota check — replaces the
        // old post-hoc incrementStorageUsed() call below, which ran AFTER
        // the transaction committed with no enforcement at all (bytes always
        // landed regardless of quota; two concurrent tus uploads could each
        // pass the earlier cheap check and both commit).
        await reserveStorageQuota(user.tenantId, fileSize, tx);
        const documentName = await nextDocumentName(tx, department.code, documentType.code);
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
            status: useAsyncScan ? "SCAN_PENDING" : "DRAFT",
            approvalStatus: documentType.requiresSignature ? "PENDING" : "NOT_REQUIRED",
            securityClassification: data.securityClassification,
            sensitivityLabel: classificationLabel(data.securityClassification),
            retentionClass: data.retentionClass,
            retentionTriggerDate: data.retentionTriggerDate ? new Date(data.retentionTriggerDate) : null,
            source: data.source,
            latestVersionId: versionId
          },
          { transaction: tx }
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
            externalReference: data.externalReference ?? null
          },
          { transaction: tx }
        );

        await DocumentVersion.create(
          {
            id: versionId,
            documentId,
            versionNumber: "1.0",
            isMajorVersion: true,
            storageKey,
            storageBucket: config.MINIO_BUCKET_DOCUMENTS,
            fileSize: BigInt(fileSize),
            mimeType: mimeType,
            originalFilename: data.filename,
            sha256Hash: encHash,
            authorId: user.userId,
            changeSummary: data.changeSummary ?? "Initial upload via tus",
            avScanStatus
          },
          { transaction: tx }
        );

        await DocumentDek.create(
          {
            documentId,
            versionId,
            encryptedDek: encryptedKey,
            kekId,
            algorithm: "AES-256-GCM",
            formatVersion
          },
          { transaction: tx }
        );

        await OutboxEvent.bulkCreate(
          [
            { documentId, type: "DOCUMENT.CREATED", channel: "WEBSOCKET", payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
            { documentId, type: "OCR_PROCESSING", channel: "OCR", payload: JSON.stringify({ documentId, versionId, tenantId: user.tenantId }) },
            { documentId, type: "SEARCH_INDEX", channel: "SEARCH_INDEX", payload: JSON.stringify({ documentId, tenantId: user.tenantId }) }
          ],
          { transaction: tx }
        );

        // Retention engine (gap #1): start the retention clock at creation.
        await applyRetention(documentId, tx);

        // Default ACLs — without these only admins could open the new document.
        const { grantDefaultDocumentAcl } = await import("./documents.service.js");
        await grantDefaultDocumentAcl(documentId, user.userId, user.tenantId, department.id, tx);

        const created = await Document.findByPk(documentId, {
          include: [
            { model: DocumentVersion, as: "versions" },
            { model: DocumentMetadata, as: "metadata" },
            { model: Department, as: "department" },
            { model: DocumentType, as: "documentType" }
          ],
          transaction: tx
        });
        if (!created) throw new AppError(500, "ERR-DOCUMENT-CREATE", "Failed to load created document");

        // tus is mounted outside tenantContext and this is a standalone
        // SERIALIZABLE transaction. Supply both the transaction and tenant so
        // the audit rows commit atomically and remain visible to this tenant.
        await writeAuditLog({
          eventType: "DOC_CREATE" as any,
          tenantId: user.tenantId,
          userId: user.userId,
          userRole: user.role,
          documentId,
          actionDetails: { documentName: created.documentName, uploadMethod: "tus" }
        }, tx);

        if (avScanStatus === "unscanned") {
          await writeAuditLog({
            eventType: "DOCUMENT_SCAN_UNSCANNED" as any,
            tenantId: user.tenantId,
            userId: user.userId,
            userRole: user.role,
            documentId,
            actionDetails: { versionId, reason: "clamav scan did not complete; upload allowed through (fail-open)" }
          }, tx);
        }

        return created;
      }
    );

    await writeIndexSidecar(storageKey, {
      documentId,
      versionId,
      filename: data.filename,
      mimeType: mimeType,
      sensitivityLabel: classificationLabel(data.securityClassification),
      sha256: encHash,
      kekId,
      createdAt: new Date().toISOString(),
      createdBy: user.userId
    });

    if (useAsyncScan) {
      const { createQueue } = await import("../../infrastructure/queue/queues.js");
      const scanQueue = createQueue("VIRUS_SCAN");
      if (scanQueue) {
        await scanQueue.add("scan-document", {
          documentId,
          versionId,
          storageKey,
          tenantId: user.tenantId,
          userId: user.userId,
          userRole: user.role
        });
        logger.info({ documentId, fileSize }, "Enqueued async virus scan for tus upload");
      } else {
        logger.warn({ documentId }, "Scan queue unavailable, document status remains scan_pending");
      }
    }

    logger.info({ documentId, uploadId: upload.id }, "Tus upload processed successfully");
    // Temp-file cleanup now happens in onUploadFinish's finally block, which
    // covers this success path AND every error path above.
    return document;
}

export function createTusHandler() {
  return (req: Request, res: Response) => {
    res.setHeader("Tus-Resumable", "1.0.0");
    // Express Request extends IncomingMessage but adds extra typed fields;
    // @tus/server accepts the raw IncomingMessage interface so we cast here.
    return tusServer.handle(req as any, res as any);
  };
}
