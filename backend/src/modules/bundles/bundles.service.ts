import { classificationLabel } from '../../shared/classifiedAccess.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { Op, Transaction as SequelizeTransaction, UniqueConstraintError } from 'sequelize';
import type { Transaction } from 'sequelize';
import {
  Department,
  Document,
  DocumentBundle,
  DocumentBundleItem,
  DocumentDek,
  DocumentMetadata,
  DocumentType,
  DocumentVersion,
  OutboxEvent,
  sequelize,
  User,
} from '../../infrastructure/database/index.js';
import { config } from '../../config/env.js';
import { AppError } from '../../core/AppError.js';
import { logger } from '../../core/logger.js';
import type { AuthenticatedUser } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { requireDocumentAccess } from '../../shared/documentGuards.js';
import { resolveACL } from '../../shared/resolveACL.js';
import { fetchAndDecrypt, encryptAndStore } from '../documents/documentCrypto.js';
import { reserveStorageQuota } from '../documents/quotaService.js';
import { sha256 } from '../documents/documentValidation.js';
import { grantDefaultDocumentAcl } from '../documents/documents.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { runInTransaction } from '../../shared/transaction.js';

const docInclude = [
  { model: DocumentVersion, as: 'versions', separate: true, order: [['createdAt', 'DESC']] as const },
  { model: Department, as: 'department' },
  { model: DocumentType, as: 'documentType' },
  { model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName', 'email'] },
];

const bundleInclude = [
  {
    model: DocumentBundleItem,
    as: 'items',
    separate: true,
    order: [['position', 'ASC']] as const,
    include: [
      { model: Document, as: 'document', include: docInclude as any },
      { model: User, as: 'adder', attributes: ['id', 'firstName', 'lastName', 'email'] },
    ],
  },
  { model: Document, as: 'compiledDocument', include: docInclude as any },
  { model: User, as: 'creator', attributes: ['id', 'firstName', 'lastName', 'email'] },
];

function plain<T extends { get?: (opts?: { plain: boolean }) => unknown }>(value: T): unknown {
  return typeof value?.get === 'function' ? value.get({ plain: true }) : value;
}

async function assertCanReadDocument(document: Document, user: AuthenticatedUser) {
  requireDocumentAccess(document as any, user);
  if (user.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) return;
  const result = await resolveACL({
    resourceType: 'document',
    resourceId: document.id,
    permission: PERMISSIONS.DOCUMENT_READ,
    userId: user.userId,
    userRole: user.role,
    userRoles: user.roles,
    userPermissions: user.permissions,
  });
  if (!result.allowed) {
    throw new AppError(result.effect === 'DENY' ? 403 : 403, result.effect === 'DENY' ? 'AUTHZ_ACL_DENIED' : 'AUTHZ_ACL_NO_ENTRY', 'No read access to one or more bundle documents');
  }
}

async function getBundle(id: string, user: AuthenticatedUser) {
  const bundle = await DocumentBundle.findOne({ where: { id, tenantId: user.tenantId }, include: bundleInclude as any });
  if (!bundle) throw new AppError(404, 'ERR-BUNDLE-NOT-FOUND', 'Document bundle not found');
  return bundle;
}

function canReadEmptyBundle(bundle: DocumentBundle, user: AuthenticatedUser) {
  return bundle.createdBy === user.userId || user.permissions.includes(PERMISSIONS.DOCUMENT_READ_ALL) || user.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN);
}

/**
 * Bundles do not own an independent content scope: their name, manifest, and
 * compiled bytes describe every source item. A caller must therefore be able
 * to read every item, not merely a visible subset. This avoids leaking bundle
 * metadata and prevents a mixed-department compilation from becoming a new
 * route around a source document's ACL.
 */
async function assertBundleVisible(bundle: DocumentBundle, user: AuthenticatedUser) {
  const items = ((bundle as DocumentBundle & { items?: DocumentBundleItem[] }).items ?? []);
  if (items.length === 0) {
    if (!canReadEmptyBundle(bundle, user)) {
      throw new AppError(404, 'ERR-BUNDLE-NOT-FOUND', 'Document bundle not found');
    }
    return;
  }
  try {
    for (const item of items) {
      const document = (item as DocumentBundleItem & { document?: Document }).document;
      if (!document) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Bundle source document not found');
      await assertCanReadDocument(document, user);
    }
    const compiledDocument = (bundle as DocumentBundle & { compiledDocument?: Document | null }).compiledDocument;
    if (compiledDocument) await assertCanReadDocument(compiledDocument, user);
  } catch (err) {
    if (err instanceof AppError && [403, 404].includes(err.statusCode)) {
      // Do not disclose that a bundle exists to someone who cannot read every
      // item it represents. The direct compiled-document endpoint retains its
      // own ACL response semantics.
      throw new AppError(404, 'ERR-BUNDLE-NOT-FOUND', 'Document bundle not found');
    }
    throw err;
  }
}

// API-1: the route forwarded req.body with no schema at all — `name`'s
// presence was checked manually below, but nothing bounded its length or
// `description`'s, and addBundleItem/reorderBundleItems below had the same
// gap for documentId/anchor/itemIds shape. Real Zod validation, matching the
// pattern every other module in this codebase uses.
const createBundleSchema = z.object({
  name: z.string().trim().min(1, 'Bundle name is required').max(255),
  description: z.string().trim().max(2000).optional(),
  documentIds: z.array(z.string().uuid()).max(1000).optional().default([]),
});

async function readableDocuments(documentIds: string[], user: AuthenticatedUser) {
  const ids = [...new Set(documentIds)];
  if (ids.length !== documentIds.length) throw new AppError(422, 'ERR-BUNDLE-DUPLICATE-IDS', 'A document may appear only once in a bundle');
  if (ids.length === 0) return [];
  const docs = await Document.findAll({ where: { id: { [Op.in]: ids }, tenantId: user.tenantId }, include: docInclude as any });
  if (docs.length !== ids.length) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'One or more selected documents were not found');
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const ordered = ids.map((id) => byId.get(id)!);
  for (const doc of ordered) {
    if (doc.deletedAt) throw new AppError(409, 'ERR-DOCUMENT-TRASHED', 'A selected document is in the recycle bin');
    await assertCanReadDocument(doc, user);
  }
  return ordered;
}

export async function createBundle(input: { name?: string; description?: string; documentIds?: string[] }, user: AuthenticatedUser) {
  const { name, description, documentIds } = createBundleSchema.parse(input);
  const docs = await readableDocuments(documentIds, user);
  const bundle = await runInTransaction(async (tx) => {
    const created = await DocumentBundle.create({
      tenantId: user.tenantId,
      name,
      description: description || null,
      status: 'DRAFT',
      compiledDocumentId: null,
      createdBy: user.userId,
    }, { transaction: tx });
    if (docs.length) {
      await DocumentBundleItem.bulkCreate(docs.map((doc, index) => ({ bundleId: created.id, documentId: doc.id, position: index + 1, addedBy: user.userId })), { transaction: tx });
    }
    return created;
  });
  return { data: plain(await getBundle(bundle.id, user)) };
}

const updateBundleSchema = z
  .object({
    name: z.string().trim().min(1, 'Bundle name is required').max(255).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined, { message: 'Nothing to change' });

/** Only the person who made a bundle, or an organisation administrator, renames or deletes it. */
function assertCanManageBundle(bundle: DocumentBundle, user: AuthenticatedUser) {
  if (bundle.createdBy !== user.userId && !user.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN))
    throw new AppError(403, 'ERR-BUNDLE-NOT-OWNER', 'Only the person who created this bundle (or an administrator) can change it');
}

/** Rename a bundle or change its description. Allowed in any state: it is the label, the compiled document itself is untouched. */
export async function updateBundle(id: string, input: unknown, user: AuthenticatedUser) {
  const data = updateBundleSchema.parse(input ?? {});
  const bundle = await getBundle(id, user);
  await assertBundleVisible(bundle, user);
  assertCanManageBundle(bundle, user);
  const before = { name: bundle.name, description: bundle.description };
  await bundle.update({
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(data.description !== undefined ? { description: data.description || null } : {}),
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.BUNDLE_UPDATED,
    tenantId: user.tenantId,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { bundleId: bundle.id, before, after: { name: bundle.name, description: bundle.description } },
  });
  return getBundleDetail(id, user);
}

/** Delete a bundle (its list of documents). The documents themselves, and a compiled PDF that came from it, are separate
 *  records and are NOT deleted; the compiled document stays in the register exactly as it was. */
export async function deleteBundle(id: string, user: AuthenticatedUser) {
  const bundle = await getBundle(id, user);
  await assertBundleVisible(bundle, user);
  assertCanManageBundle(bundle, user);
  const items = await DocumentBundleItem.count({ where: { bundleId: id } });
  await runInTransaction(async (tx) => {
    await DocumentBundleItem.destroy({ where: { bundleId: id }, transaction: tx });
    await DocumentBundle.destroy({ where: { id, tenantId: user.tenantId }, transaction: tx });
    await writeAuditLog({
      eventType: AUDIT_EVENTS.BUNDLE_DELETED,
      tenantId: user.tenantId,
      userId: user.userId,
      userRole: user.role,
      actionDetails: { bundleId: id, name: bundle.name, status: bundle.status, itemCount: items, compiledDocumentId: bundle.compiledDocumentId },
    }, tx);
  });
  return { data: { id, deleted: true, compiledDocumentKept: Boolean(bundle.compiledDocumentId) } };
}

export async function listBundles(user: AuthenticatedUser, skip = 0, take = 50) {
  const where = { tenantId: user.tenantId };
  // Authorize the complete ordered set before slicing it, just like document
  // listing. Counting broad tenant rows first created phantom bundle pages and
  // exposed bundle names to users who could not read all source documents.
  const bundles = await DocumentBundle.findAll({
    where,
    include: bundleInclude as any,
    order: [['updatedAt', 'DESC']],
  });
  const visible: DocumentBundle[] = [];
  for (const bundle of bundles) {
    try {
      await assertBundleVisible(bundle, user);
      visible.push(bundle);
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode !== 404) throw err;
    }
  }
  const data = await Promise.all(
    visible.slice(skip, skip + take).map(async (bundle) => (await getBundleDetail(bundle.id, user)).data),
  );
  return { data, total: visible.length, skip, take };
}

export async function getBundleDetail(id: string, user: AuthenticatedUser) {
  const bundle = await getBundle(id, user);
  await assertBundleVisible(bundle, user);
  const result = plain(bundle) as any;
  return { data: result };
}

async function nextPosition(bundleId: string, tx?: Transaction) {
  const max = await DocumentBundleItem.max('position', { where: { bundleId }, transaction: tx }) as number | null;
  return Number(max ?? 0) + 1;
}

async function normalizePositions(bundleId: string, tx: Transaction) {
  const items = await DocumentBundleItem.findAll({ where: { bundleId }, order: [['position', 'ASC']], transaction: tx });
  for (let i = 0; i < items.length; i++) {
    await items[i].update({ position: i + 1 }, { transaction: tx });
  }
}

const addBundleItemSchema = z.object({
  documentId: z.string().uuid('documentId is required'),
  anchor: z.string().uuid().optional(),
  placement: z.enum(['BEFORE', 'AFTER']).optional(),
});

export async function addBundleItem(
  bundleId: string,
  input: { documentId?: string; anchor?: string; placement?: 'BEFORE' | 'AFTER' },
  user: AuthenticatedUser,
) {
  const parsed = addBundleItemSchema.parse(input);
  const bundle = await getBundle(bundleId, user);
  if (bundle.status !== 'DRAFT') throw new AppError(409, 'ERR-BUNDLE-COMPILED', 'Compiled bundles cannot be edited');
  const doc = await Document.findOne({ where: { id: parsed.documentId, tenantId: user.tenantId } });
  if (!doc || doc.deletedAt) throw new AppError(404, 'ERR-DOCUMENT-NOT-FOUND', 'Document not found');
  await assertCanReadDocument(doc, user);

  await runInTransaction(async (tx) => {
    const existing = await DocumentBundleItem.findOne({ where: { bundleId, documentId: doc.id }, transaction: tx });
    if (existing) throw new AppError(409, 'ERR-BUNDLE-DUPLICATE', 'Document is already in this bundle');
    let position = await nextPosition(bundleId, tx);
    if (parsed.anchor) {
      const anchor = await DocumentBundleItem.findOne({ where: { bundleId, documentId: parsed.anchor }, transaction: tx });
      if (!anchor) throw new AppError(404, 'ERR-BUNDLE-ANCHOR', 'Anchor document is not in this bundle');
      position = anchor.position + (parsed.placement === 'AFTER' ? 1 : 0);
      await DocumentBundleItem.increment('position', { by: 1, where: { bundleId, position: { [Op.gte]: position } }, transaction: tx });
    }
    // The `existing` check above isn't row-locked, so two concurrent adds of
    // the same document to the same bundle can both pass it and race
    // document_bundle_items_bundle_document_uniq here -- catch it with the
    // same friendly message the pre-check already uses instead of leaking a
    // raw constraint violation to the loser.
    try {
      await DocumentBundleItem.create({ bundleId, documentId: doc.id, position, addedBy: user.userId }, { transaction: tx });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw new AppError(409, 'ERR-BUNDLE-DUPLICATE', 'Document is already in this bundle');
      }
      throw err;
    }
    await normalizePositions(bundleId, tx);
    await bundle.update({ status: 'DRAFT' }, { transaction: tx });
  });
  return getBundleDetail(bundleId, user);
}

const addBundleItemsSchema = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(1000) });

/** Adds a selected/uploaded batch in one transaction. A failed authorization,
 * missing document, or duplicate aborts the whole operation; partial bundles
 * are worse than a clear error because they look complete to the user. */
export async function addBundleItems(bundleId: string, input: { documentIds?: string[] }, user: AuthenticatedUser) {
  const { documentIds } = addBundleItemsSchema.parse(input);
  const bundle = await getBundle(bundleId, user);
  if (bundle.status !== 'DRAFT') throw new AppError(409, 'ERR-BUNDLE-COMPILED', 'Compiled bundles cannot be edited');
  const docs = await readableDocuments(documentIds, user);
  await runInTransaction(async (tx) => {
    const existing = await DocumentBundleItem.findAll({ where: { bundleId, documentId: { [Op.in]: docs.map((doc) => doc.id) } }, transaction: tx });
    if (existing.length) throw new AppError(409, 'ERR-BUNDLE-DUPLICATE', 'One or more documents are already in this bundle');
    const start = await nextPosition(bundleId, tx);
    await DocumentBundleItem.bulkCreate(docs.map((doc, index) => ({ bundleId, documentId: doc.id, position: start + index, addedBy: user.userId })), { transaction: tx });
    await normalizePositions(bundleId, tx);
  });
  return getBundleDetail(bundleId, user);
}

export async function removeBundleItem(bundleId: string, itemId: string, user: AuthenticatedUser) {
  const bundle = await getBundle(bundleId, user);
  if (bundle.status !== 'DRAFT') throw new AppError(409, 'ERR-BUNDLE-COMPILED', 'Compiled bundles cannot be edited');
  await runInTransaction(async (tx) => {
    const deleted = await DocumentBundleItem.destroy({ where: { id: itemId, bundleId }, transaction: tx });
    if (!deleted) throw new AppError(404, 'ERR-BUNDLE-ITEM-NOT-FOUND', 'Bundle item not found');
    await normalizePositions(bundleId, tx);
  });
  return getBundleDetail(bundleId, user);
}

const reorderItemIdsSchema = z.array(z.string().uuid()).max(1000);

export async function reorderBundleItems(bundleId: string, itemIdsInput: string[], user: AuthenticatedUser) {
  const itemIds = reorderItemIdsSchema.parse(itemIdsInput);
  const bundle = await getBundle(bundleId, user);
  if (bundle.status !== 'DRAFT') throw new AppError(409, 'ERR-BUNDLE-COMPILED', 'Compiled bundles cannot be edited');
  const items = await DocumentBundleItem.findAll({ where: { bundleId }, order: [['position', 'ASC']] });
  const current = items.map((i) => i.id).sort();
  const requested = [...itemIds].sort();
  if (current.length !== requested.length || current.some((id, i) => id !== requested[i])) {
    throw new AppError(422, 'ERR-BUNDLE-REORDER', 'Reorder list must contain every bundle item exactly once');
  }
  await runInTransaction(async (tx) => {
    for (let i = 0; i < itemIds.length; i++) {
      await DocumentBundleItem.update({ position: 10_000 + i }, { where: { id: itemIds[i], bundleId }, transaction: tx });
    }
    for (let i = 0; i < itemIds.length; i++) {
      await DocumentBundleItem.update({ position: i + 1 }, { where: { id: itemIds[i], bundleId }, transaction: tx });
    }
  });
  return getBundleDetail(bundleId, user);
}

function cleanFilename(value: string) {
  return value.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 120) || 'bundle.pdf';
}

function strongestClassification(docs: Document[]) {
  const order = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
  return docs.reduce((best, doc) => order.indexOf(doc.securityClassification) > order.indexOf(best) ? doc.securityClassification : best, 'PUBLIC');
}

async function drawWrapped(page: any, text: string, x: number, y: number, width: number, font: any, size: number, color = rgb(0.15, 0.18, 0.24)) {
  const words = text.split(/\s+/).filter(Boolean);
  let line = '';
  let cursor = y;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      page.drawText(line, { x, y: cursor, size, font, color });
      cursor -= size + 4;
      line = word;
    } else {
      line = next;
    }
  }
  if (line) page.drawText(line, { x, y: cursor, size, font, color });
  return cursor - size - 4;
}

async function addCoverPage(pdf: PDFDocument, title: string, subtitle: string) {
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText(title.slice(0, 90), { x: 56, y: 742, size: 20, font: bold, color: rgb(0.08, 0.11, 0.2) });
  await drawWrapped(page, subtitle, 56, 704, 480, font, 11);
  page.drawRectangle({ x: 56, y: 96, width: 483, height: 1, color: rgb(0.82, 0.85, 0.9) });
}

async function buildCompiledPdf(bundle: DocumentBundle, items: DocumentBundleItem[]) {
  const out = await PDFDocument.create();
  await addCoverPage(out, `Bundle: ${bundle.name}`, `${items.length} item(s) compiled on ${new Date().toLocaleString()}`);

  const manifest = out.addPage([595.28, 841.89]);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  manifest.drawText('Stitch Manifest', { x: 56, y: 768, size: 18, font: bold, color: rgb(0.08, 0.11, 0.2) });
  let y = 730;
  for (const item of items) {
    const doc = (item as any).document as Document & { versions?: DocumentVersion[]; documentType?: DocumentType };
    const latest = doc.versions?.[0];
    y = await drawWrapped(manifest, `${item.position}. ${doc.documentName} - ${doc.title} (${doc.documentType?.code ?? 'DOC'}, ${latest?.mimeType ?? 'no file'})`, 56, y, 480, font, 10);
    if (y < 80) y = 730;
  }

  for (const item of items) {
    const doc = (item as any).document as Document & { versions?: DocumentVersion[]; documentType?: DocumentType };
    const latest = doc.versions?.[0];
    if (!latest) {
      await addCoverPage(out, doc.title, 'No file version was available when this bundle was compiled.');
      continue;
    }
    const buffer = await fetchAndDecrypt(latest.storageKey, latest.id);
    if (latest.mimeType === 'application/pdf') {
      try {
        const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
        continue;
      } catch (err) {
        logger.warn({ err, documentId: doc.id }, 'Failed to merge PDF, adding cover sheet');
      }
    }
    // FIX 2026-09-14: mimeValidation.ts's general upload pipeline accepts
    // GIF/WEBP as regular document uploads (not just PNG/JPEG), but this
    // compiler only knew pdf-lib's own embedPng/embedJpg — a GIF or WEBP
    // document dropped into a bundle silently degraded to a placeholder
    // cover sheet instead of actually rendering, even though the platform
    // fully supports uploading it. Normalizing every raster mimetype to PNG
    // with sharp first (same fix as users.service.ts's signature image and
    // forms.service.ts's form base file) covers every image mimetype this
    // app accepts as a document, not just the two pdf-lib embeds natively.
    if (latest.mimeType.startsWith('image/')) {
      try {
        const pngBuffer = await sharp(buffer).png().toBuffer();
        const image = await out.embedPng(pngBuffer);
        const page = out.addPage([595.28, 841.89]);
        const maxW = 515;
        const maxH = 700;
        const scale = Math.min(maxW / image.width, maxH / image.height, 1);
        page.drawImage(image, { x: 40 + (maxW - image.width * scale) / 2, y: 70 + (maxH - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
        continue;
      } catch (err) {
        logger.warn({ err, documentId: doc.id }, 'Failed to embed image, adding cover sheet');
      }
    }
    // Office and other binary formats cannot be faithfully rasterized without
    // a system converter. Preserve their exact bytes as a PDF attachment so
    // compilation never drops a selected file or invents a misleading page.
    // The manifest remains the human-readable index and the original document
    // remains available through the bundle item viewer.
    try {
      await out.attach(buffer, cleanFilename(latest.originalFilename || doc.documentName), {
        mimeType: latest.mimeType,
        description: `Original bundle item: ${doc.title}`,
      });
    } catch (err) {
      logger.warn({ err, documentId: doc.id }, 'Failed to attach non-renderable bundle item');
      await addCoverPage(out, doc.title, `The original file ${latest.originalFilename} could not be embedded in the compiled PDF.`);
    }
  }

  return Buffer.from(await out.save());
}

async function fileCompiledBundle(bundle: DocumentBundle, docs: Document[], pdf: Buffer, user: AuthenticatedUser) {
  const first = docs[0];
  const department = await Department.findOne({ where: { id: first.departmentId, tenantId: user.tenantId } });
  if (!department) throw new AppError(422, 'ERR-DEPT-INVALID', 'Bundle department is unavailable');
  const docType = await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'BUNDLE' } });
  if (!docType) throw new AppError(500, 'ERR-DOCTYPE-BUNDLE-MISSING', 'BUNDLE document type is not seeded for this tenant');

  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const filename = cleanFilename(`${bundle.name}.pdf`);
  // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
  const storageKey = `${user.tenantId}/${department.code}/BUNDLE/${documentId}/${versionId}/${filename}`;
  const plaintextSha = sha256(pdf);
  const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(storageKey, pdf, 'application/pdf', department.id, user.tenantId);
  const classification = strongestClassification(docs);

  return sequelize.transaction({ isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.SERIALIZABLE }, async (tx) => {
    // FIX: deliberately standalone (see runInTransaction's doc comment in
    // shared/transaction.ts) — SERIALIZABLE for the atomic quota reservation
    // below would be silently downgraded by reusing the request's
    // default-isolation transaction. Being standalone means a second
    // connection the request-level tenantContext middleware never touches, so
    // it must set its own tenant GUC as its first statement for RLS-safety.
    await sequelize.query(`SET LOCAL app.current_tenant = :tenantId`, {
      transaction: tx,
      replacements: { tenantId: user.tenantId },
    });
    await reserveStorageQuota(user.tenantId, pdf.length, tx);
    await Document.create({
      id: documentId,
      tenantId: user.tenantId,
      documentName: `BUNDLE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      title: bundle.name.slice(0, 255),
      departmentId: department.id,
      documentTypeId: docType.id,
      folderId: null,
      ownerId: user.userId,
      organisationUnit: first.organisationUnit || department.code,
      status: 'ACTIVE',
      approvalStatus: 'NOT_REQUIRED',
      securityClassification: classification,
      sensitivityLabel: classificationLabel(classification),
      retentionClass: 'RET-BUNDLE-5Y',
      documentDate: new Date(),
      retentionTriggerDate: new Date(),
      disposalEligibleDate: null,
      latestVersionId: versionId,
      source: 'CREATED_IN_SYSTEM',
      isOnLegalHold: false,
      archivedAt: null,
      ocrStatus: null,
      ocrConfidenceScore: null,
      aiSummary: null,
      aiSuggestedMetadata: null,
      preTrashStatus: null,
      deletedAt: null,
    } as any, { transaction: tx });
    // Compiled bundles are first-class repository documents. Apply the same
    // owner and department-member ACL snapshot as every other filing path so
    // the creator can open the compiled PDF and its department sees it in
    // scoped lists. Omitting this leaves a valid document row that fails
    // detail/download authorization with AUTHZ_ACL_NO_ENTRY.
    await grantDefaultDocumentAcl(documentId, user.userId, user.tenantId, department.id, tx);
    await DocumentMetadata.create({
      documentId,
      keywords: 'bundle,stitched,compiled',
      description: `Compiled bundle ${bundle.name} from ${docs.length} document(s).`,
      language: 'en',
    } as any, { transaction: tx });
    await DocumentVersion.create({
      id: versionId,
      documentId,
      versionNumber: '1.0',
      isMajorVersion: true,
      storageKey,
      storageBucket: config.MINIO_BUCKET_DOCUMENTS,
      fileSize: BigInt(pdf.length),
      mimeType: 'application/pdf',
      originalFilename: filename,
      sha256Hash: encHash,
      plaintextSha256: plaintextSha,
      extractedText: null,
      authorId: user.userId,
      changeSummary: 'Compiled stitched document bundle',
    } as any, { transaction: tx });
    await DocumentDek.create({ documentId, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' }, { transaction: tx });
    await OutboxEvent.bulkCreate([
      { documentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId, tenantId: user.tenantId, departmentId: department.id }) },
      { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
    ], { transaction: tx });
    await bundle.update({ status: 'COMPILED', compiledDocumentId: documentId }, { transaction: tx });
    // Keep the compiled-document audit record atomic with the SERIALIZABLE
    // document/quota mutation; writing it after this callback commits leaves
    // an irrecoverable audit gap if the process dies in between.
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOC_CREATE,
      tenantId: user.tenantId,
      userId: user.userId,
      userRole: user.role,
      documentId,
      actionDetails: { action: 'bundle_compiled', bundleId: bundle.id, sourceDocumentIds: docs.map((d) => d.id), itemCount: docs.length },
    }, tx);
    return documentId;
  });
}

export async function compileBundle(bundleId: string, user: AuthenticatedUser) {
  const bundle = await getBundle(bundleId, user);
  const items = ((bundle as any).items ?? []) as DocumentBundleItem[];
  if (items.length === 0) throw new AppError(422, 'ERR-BUNDLE-EMPTY', 'Add at least one document before compiling');
  const docs = items.map((item) => (item as any).document as Document);
  for (const doc of docs) await assertCanReadDocument(doc, user);
  const pdf = await buildCompiledPdf(bundle, items);
  await fileCompiledBundle(bundle, docs, pdf, user);

  return getBundleDetail(bundleId, user);
}
