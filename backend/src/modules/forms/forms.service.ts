/**
 * Forms engine service.
 *
 * Templates are authored (schemaJson = pdfme Template), submitted for approval
 * via the existing workflow engine, then activated.
 *
 * Instances capture field data and generate a PDF via @pdfme/generator, stored
 * in MinIO (or local disk fallback) and registered as a first-class Document.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Op, col, fn, literal, where as sqlWhere, type Transaction as SequelizeTransaction } from 'sequelize';
import { generate } from '@pdfme/generator';
import { text, rectangle } from '@pdfme/schemas';
import type { Template, Font } from '@pdfme/common';
import { getDefaultFont } from '@pdfme/common';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  FormTemplate, FormInstance, Document, DocumentType, DocumentVersion,
  DocumentDek, Department, OrgUnit, OutboxEvent, SignatureRequest, SignatureRecipient, User,
  UserDepartment, ApprovalChain, FormSequence, sequelize,
} from '../../infrastructure/database/index.js';
import type { ApprovalTemplateStep } from '../../infrastructure/database/models/ApprovalChainTemplate.js';
import { AppError } from '../../core/AppError.js';
import { config } from '../../config/env.js';
import { getStorageAdapter } from '../../infrastructure/storage/StorageAdapter.js';
import { scanBuffer } from '../../infrastructure/antivirus/clamscan.js';
import { validateUploadedFile } from '../documents/mimeValidation.js';
import { encryptAndStore } from '../documents/documentCrypto.js';
import { filterDocsByDetailAcl, ensureCanCreate } from '../documents/documents.service.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import type { AuthenticatedUser } from '../../shared/auth.js';
import { logger } from '../../core/logger.js';
import { runInSavepoint, runInTransaction } from '../../shared/transaction.js';
import { applyRetention } from '../retention/retentionEngine.js';
import { sanitizeFilename } from '../../shared/sanitizeFilename.js';
import { assertACLAllow } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { reserveStorageQuota } from '../documents/quotaService.js';
import { assertStatusPermission } from '../documents/statusPermissions.service.js';
import { hiddenUserIds } from '../../shared/platformAdmin.js';
import { requireLegalHoldClear } from '../../shared/documentGuards.js';
import { validateTransition } from '../documents/DocumentStateMachine.js';
import { getUserDepartmentIds } from '../approvals/stepRules.js';
import {
  assertScopeWritable,
  assertTemplateUsableForDepartment,
  canViewFormTemplate,
  hasOrgWideTemplateAuthority,
  templateVisibilityWhere,
} from './formTemplateScope.js';

// basePdfObjectKey always stores a PDF — image uploads are wrapped into a
// single-page PDF (wrapImageAsPdf) before being written, so everything
// downstream (fetchBasePdf, the generated/filled form output) only ever
// deals with PDF bytes regardless of what was originally uploaded.
//
// FIX 2026-09-14: was PNG/JPEG-only because wrapImageAsPdf branched directly
// on mimetype into pdf-lib's embedPng/embedJpg — the only two raster formats
// pdf-lib can embed natively. wrapImageAsPdf now normalizes every accepted
// format to PNG with sharp (already a project dependency, same fix applied
// to users.service.ts's signature-image upload) before ever touching
// pdf-lib, so growing this list to WEBP/GIF needed no change to the
// PDF-embedding logic at all — just the accepted-mimetype set below.
const SUPPORTED_BASE_FILE_MIMETYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const WORD_DOC_MIMETYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** Wraps a single raster image onto one A4 page, scaled to fit within a
 *  margin — used so a template's base file can be an image (e.g. a photo
 *  or scan of a pre-printed form) while everything downstream still only
 *  ever handles a PDF (basePdfObjectKey, fetchBasePdf, pdfme's basePdf).
 *  Normalizes to PNG first (sharp) so pdf-lib's embedPng is the only
 *  embed path needed regardless of the original format. */
async function wrapImageAsPdf(buffer: Buffer, _mimetype: string): Promise<Buffer> {
  const pngBuffer = await sharp(buffer).png().toBuffer();
  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(pngBuffer);
  const PAGE_WIDTH_PT = 595.28; // A4 @ 72dpi
  const PAGE_HEIGHT_PT = 841.89;
  const MARGIN_PT = 28; // ~10mm
  const page = pdfDoc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
  const maxWidth = PAGE_WIDTH_PT - MARGIN_PT * 2;
  const maxHeight = PAGE_HEIGHT_PT - MARGIN_PT * 2;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  page.drawImage(image, {
    x: (PAGE_WIDTH_PT - drawWidth) / 2,
    y: (PAGE_HEIGHT_PT - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  });
  return Buffer.from(await pdfDoc.save());
}

/** Stores an uploaded base file (PDF, or an image wrapped into a one-page PDF)
 *  to overlay a template's fields onto (basePdfObjectKey) — a template asset,
 *  not a tenant Document (no ACL/retention/versioning: fetchBasePdf() already
 *  reads it back directly via the storage adapter). DOCX isn't supported —
 *  that needs an external conversion binary (LibreOffice/pandoc) that isn't
 *  guaranteed available; users are pointed at exporting to PDF instead. */
export async function uploadFormBasePdf(file: Express.Multer.File, user: AuthenticatedUser): Promise<string> {
  const looksLikeWordDoc =
    WORD_DOC_MIMETYPES.has(file.mimetype) || /\.docx?$/i.test(file.originalname);
  if (looksLikeWordDoc) {
    throw new AppError(
      422,
      'ERR-BASE-PDF-TYPE',
      "DOCX isn't supported yet — please upload a PDF, PNG, JPEG, WEBP, or GIF, or export your document to PDF first",
    );
  }
  if (!SUPPORTED_BASE_FILE_MIMETYPES.has(file.mimetype)) {
    throw new AppError(422, 'ERR-BASE-PDF-TYPE', 'Unsupported file type — please upload a PDF, PNG, JPEG, WEBP, or GIF');
  }

  // Scan the user-supplied bytes as uploaded, before any transformation
  // (wrapImageAsPdf re-encodes images into a new PDF buffer, which isn't what
  // the user actually sent). A genuine detected virus throws ERR-AV-THREAT-DETECTED;
  // an infra failure (timeout/crash) returns 'unscanned' — fail-open, matching
  // every other upload path in this codebase, since this asset has no
  // DocumentVersion row to record the flag on (it's a template asset, not a
  // tenant Document — see the doc comment above), so an unscanned base file is
  // just logged, not persisted.
  const avScanStatus = await scanBuffer(file.buffer);
  if (avScanStatus === 'unscanned') {
    logger.warn({ tenantId: user.tenantId, filename: file.originalname }, 'Form base-file upload allowed through unscanned (clamav did not complete)');
  }

  let bytesToStore: Buffer = file.buffer;
  let storedFilename = file.originalname;
  if (file.mimetype !== 'application/pdf') {
    bytesToStore = await wrapImageAsPdf(file.buffer, file.mimetype);
    storedFilename = `${file.originalname.replace(/\.[^./\\]+$/, '')}.pdf`;
  }

  const objectKey = `${user.tenantId}/forms/base-pdfs/${crypto.randomUUID()}/${storedFilename.replace(/[^\w.-]+/g, '_')}`;
  const storage = getStorageAdapter();
  await storage.put(objectKey, bytesToStore, 'application/pdf');
  return objectKey;
}

// cwd is backend/ for npm run dev, node dist/src/main.js, the worker, and
// jest; the repo root when scripts run from there — mirrors letterPdf.ts's
// fontsDirCandidates() (no import.meta here — the jest transform can't parse it).
function letterheadAssetCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'assets/letterheads/examplecorp-group-letterhead.pdf'),
    path.resolve(process.cwd(), 'backend/assets/letterheads/examplecorp-group-letterhead.pdf'),
  ];
}

// ── Font handling ────────────────────────────────────────────────────────────
//
// pdfme's own default font ("Roboto", via @pdfme/common's getDefaultFont())
// has no Ethiopic coverage — a form with an Amharic field title, or any
// submitted value containing Amharic text (routinely used at Example Corp, see
// letters' letterPdf.ts), silently rendered as a wall of tofu boxes with no
// error. Reuses the exact same font asset letters already carry
// (backend/assets/fonts/NotoSansEthiopic-Regular.ttf) rather than adding a
// second copy.
const ETHIOPIC_FONT_NAME = 'NotoSansEthiopic';
// Same coverage test as letterPdf.ts's WinAnsi check: pdfme's default font
// already renders the full Latin-1 range correctly (that's the existing,
// working behavior for every non-Amharic form today), so only route text
// containing something OUTSIDE that range through the Ethiopic font —
// staying on the default font for everything else means zero rendering
// change for the overwhelming majority of forms.
function hasNonLatin1Char(text: string): boolean {
  return /[^\x20-\xFF\n\t]/.test(text);
}

function fontsDirCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), 'backend/assets/fonts'),
  ];
}

let ethiopicFontBytesCache: Buffer | null | undefined;

function loadEthiopicFontBytes(): Buffer | null {
  if (ethiopicFontBytesCache !== undefined) return ethiopicFontBytesCache;
  for (const dir of fontsDirCandidates()) {
    const regularPath = path.join(dir, 'NotoSansEthiopic-Regular.ttf');
    if (fs.existsSync(regularPath)) {
      ethiopicFontBytesCache = fs.readFileSync(regularPath);
      return ethiopicFontBytesCache;
    }
  }
  logger.warn(
    { candidates: fontsDirCandidates() },
    '[forms] Noto Sans Ethiopic font asset not found — non-Latin1 text in forms will render as tofu boxes',
  );
  ethiopicFontBytesCache = null;
  return null;
}

/** pdfme's Font map for generate()'s `options.font` — the default font (kept
 *  as the fallback so every existing Latin form renders byte-identical to
 *  before) plus Ethiopic, opt-in per schema entry via `fontName` (see
 *  toPdfmeSchema's use of ETHIOPIC_FONT_NAME/hasNonLatin1Char below). Cached
 *  per call rather than module-level since pdfme's Font entries can be
 *  mutated by generate() internals (cloneDeep guards against that, but a
 *  fresh object per call keeps this file's own reasoning simple). */
function buildPdfmeFontMap(): Font {
  const font: Font = { ...getDefaultFont() };
  const ethiopicBytes = loadEthiopicFontBytes();
  if (ethiopicBytes) font[ETHIOPIC_FONT_NAME] = { data: new Uint8Array(ethiopicBytes) };
  return font;
}

/** Every tenant's "Use Example Corp Letterhead" quick-pick in the
 *  template builder resolves to this — a well-known, deterministic object
 *  key rather than something authors have to manually upload and hand
 *  around. Uploads the repo-tracked asset into that tenant's storage the
 *  first time it's asked for; every call after that is a plain existence
 *  check, so this self-heals across environments/storage resets without
 *  needing a one-off seed script run out of band. */
export async function getExampleCorpLetterheadObjectKey(tenantId: string): Promise<string> {
  const objectKey = `${tenantId}/forms/base-pdfs/examplecorp-group-letterhead/letterhead.pdf`;
  const storage = getStorageAdapter();
  if (await storage.exists(objectKey)) return objectKey;

  const assetPath = letterheadAssetCandidates().find((p) => fs.existsSync(p));
  if (!assetPath) {
    throw new AppError(500, 'ERR-LETTERHEAD-ASSET-MISSING', 'Example Corp letterhead asset is not present on this server');
  }
  await storage.put(objectKey, fs.readFileSync(assetPath), 'application/pdf');
  return objectKey;
}

// ── Template CRUD ────────────────────────────────────────────────────────────

// FIX 2026-09-15: name/category had NO validation at all (any length, any
// value) and auditPolicy/signingPolicy accepted any non-null value via a bare
// `?? 'never'`/`?? 'none'` fallback — contrast documentTypeSchema's
// z.enum(...)-validated equivalents. A garbage value here didn't error, it
// just saved silently.
const formTemplateNameCategorySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  category: z.string().trim().max(100).optional().nullable(),
});
const formTemplateGovernanceSchema = z.object({
  instanceApproval: z.enum(['none', 'chain']).optional(),
  auditPolicy: z.enum(['required', 'optional', 'never']).optional(),
  signingPolicy: z.enum(['none', 'ceremony']).optional(),
});

/**
 * auditPolicy/signingPolicy only mean anything for a chain-approval template:
 * completeItemApproval (approvals.service.ts) reads them at FINAL APPROVAL,
 * and a template with instanceApproval:'none' never reaches that code path —
 * createFormInstance files it straight to ACTIVE (see below), so the
 * approval engine, and therefore these two fields, never runs for it.
 *
 * Without this, a template could save signingPolicy:'ceremony' and/or
 * auditPolicy:'required' alongside instanceApproval:'none' — individually
 * valid enum values that would silently never fire. Same "flag that looks
 * like it governs something but doesn't unless a DIFFERENT flag also agrees"
 * trap that DocumentType.requiresSignature/signingPolicy drift was, just
 * fixed here as a derivation instead of a cross-field validation error —
 * there's no legitimate reason to reject the write outright when the
 * intended, unambiguous meaning ("this doesn't route through approval, so
 * these don't apply") is obvious and recoverable.
 */
function resolveFormGovernance(
  instanceApproval: 'none' | 'chain',
  auditPolicy: 'required' | 'optional' | 'never' | undefined,
  signingPolicy: 'none' | 'ceremony' | undefined,
): { auditPolicy: 'required' | 'optional' | 'never'; signingPolicy: 'none' | 'ceremony' } {
  if (instanceApproval !== 'chain') return { auditPolicy: 'never', signingPolicy: 'none' };
  return { auditPolicy: auditPolicy ?? 'never', signingPolicy: signingPolicy ?? 'none' };
}

/**
 * A template's base PDF is a storage object the builder uploads through
 * POST /templates/base-pdf, which always writes under
 * `<tenantId>/forms/base-pdfs/`. The key then comes BACK from the client in
 * create/update/preview bodies, and fetchBasePdf() reads whatever it names
 * straight from the storage adapter — so without this check any template
 * author could point it at another tenant's base PDF (or any other unencrypted
 * object) and have it rendered into their own forms or returned by the preview
 * endpoint. Only keys inside the caller's own forms folder are accepted.
 */
export function assertOwnBasePdfKey(key: string | null | undefined, tenantId: string): void {
  if (key === null || key === undefined || key === '') return;
  const prefix = `${tenantId}/forms/base-pdfs/`;
  if (
    typeof key !== 'string' ||
    !key.startsWith(prefix) ||
    key.includes('\\') ||
    key.split('/').some((seg) => seg === '.' || seg === '..')
  ) {
    throw new AppError(422, 'ERR-FORM-BASE-PDF-INVALID', 'The base file is not one of this organisation\'s uploaded template files');
  }
}

const TEMPLATE_FIELD_TYPES = ['text', 'textarea', 'date', 'number', 'checkbox', 'select', 'radio', 'email', 'file'] as const;
const MAX_TEMPLATE_FIELDS = 300;
const MAX_PATTERN_LENGTH = 200;
// A submitter-controlled string is tested against an AUTHOR-controlled regex on
// the API thread. These two shapes — a quantified group that itself contains a
// quantifier, and a quantified alternation — are the classic catastrophic
// backtracking forms. A heuristic, not a proof; it removes the textbook cases.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;
/** Longest value the regex rule is ever run against (see fieldZodType). */
const PATTERN_INPUT_CAP = 2000;

const templateFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(TEMPLATE_FIELD_TYPES),
    required: z.boolean().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    width: z.number().finite().positive(),
    options: z.array(z.string().max(200)).max(200).optional(),
    validation: z
      .object({ pattern: z.string().max(MAX_PATTERN_LENGTH).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Structural check of a template's schemaJson at save time. It used to be an
 * unvalidated JSON blob: a malformed one saved fine and then crashed (HTTP 500)
 * on every fill, and an author-supplied validation.pattern ran unchecked
 * against submitters' input. Existing rows are not re-validated.
 */
export function validateTemplateSchemaJson(schemaJson: unknown): void {
  const fail = (message: string): never => {
    throw new AppError(422, 'ERR-FORM-VALIDATION', message);
  };
  if (!Array.isArray(schemaJson) || !schemaJson.every(Array.isArray)) {
    fail('schemaJson must be a list of pages, each a list of fields');
  }
  const fields = (schemaJson as unknown[][]).flat();
  if (fields.length > MAX_TEMPLATE_FIELDS) fail(`A template may have at most ${MAX_TEMPLATE_FIELDS} fields`);
  const seen = new Set<string>();
  for (const raw of fields) {
    const parsed = templateFieldSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(`Invalid field definition${issue ? ` (${issue.path.join('.') || 'field'}: ${issue.message})` : ''}`);
    }
    const field = (parsed as { data: z.infer<typeof templateFieldSchema> }).data;
    if (seen.has(field.name)) fail(`Duplicate field name "${field.name}"`);
    seen.add(field.name);
    const pattern = field.validation?.pattern;
    if (pattern) {
      try {
        new RegExp(pattern);
      } catch {
        fail(`The pattern for "${field.name}" is not a valid regular expression`);
      }
      if (NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern)) {
        fail(`The pattern for "${field.name}" is too complex (nested repetition) — simplify it`);
      }
    }
  }
}

/**
 * Only a template's author — or an approval administrator, the same rule the
 * engine applies to submitting someone else's item (approvals.service.ts's
 * ERR-NOT-ITEM-OWNER) — may edit, revise or change the state of it.
 *
 * FORM_TEMPLATE_MANAGE is held by EMPLOYEE (deliberately: "build your own
 * form"), so the permission alone said nothing about WHOSE template. Without
 * this, any employee could edit a colleague's draft, deprecate the company's
 * live leave form, or fork a revision of it.
 */
async function assertCanModifyTemplate(template: FormTemplate, user: AuthenticatedUser): Promise<void> {
  if (template.createdBy && template.createdBy === user.userId) return;
  if (!(user.permissions as string[] | undefined)?.includes(PERMISSIONS.APPROVAL_ADMIN)) {
    throw new AppError(403, 'ERR-NOT-TEMPLATE-OWNER', "Only the template's author (or an approval administrator) can change it");
  }
  // approval:admin is held by every department manager. It may touch a template only inside its own scope: a
  // department-scoped template by a member of that department; a tenant-wide or org-unit template only by an
  // organisation-level role (audit item 6).
  if (hasOrgWideTemplateAuthority(user)) return;
  if (template.departmentId && (await getUserDepartmentIds(user.tenantId, user.userId)).includes(template.departmentId)) return;
  throw new AppError(403, 'ERR-FORM-TEMPLATE-SCOPE', 'This form template is outside the departments you administer');
}

/**
 * Versions are tracked BY NAME (createFormTemplateVersion numbers a revision
 * from the highest version sharing the tenant + name, and the fill picker hides
 * a template that a newer active revision of the same name supersedes). Two
 * unrelated templates sharing a name would therefore share one version line —
 * one could hide the other from the picker — so a brand-new template (or a
 * rename) may not reuse a name already in the tenant, case-insensitively.
 */
async function assertTemplateNameFree(name: string, tenantId: string): Promise<void> {
  const clash = await FormTemplate.findOne({
    where: { tenantId, [Op.and]: [sqlWhere(fn('lower', col('name')), name.toLowerCase())] },
    attributes: ['id'],
  });
  if (clash) {
    throw new AppError(409, 'ERR-FORM-TEMPLATE-NAME-TAKEN', `A form template named "${name}" already exists — open it and use "new version", or pick another name`);
  }
}

export async function createFormTemplate(
  data: {
    name: string;
    category?: string;
    basePdfObjectKey?: string;
    isLetterhead?: boolean;
    schemaJson: object;
    sectionsJson?: Array<{ id: string; label: string; order: number }>;
    layoutMode?: 'static' | 'dynamic';
    instanceApproval?: 'none' | 'chain';
    auditPolicy?: 'required' | 'optional' | 'never';
    signingPolicy?: 'none' | 'ceremony';
    /** Scope (audit item 6): a department, or an org unit, or neither (tenant-wide; organisation-level roles only). */
    departmentId?: string | null;
    orgUnitId?: string | null;
  },
  user: AuthenticatedUser,
): Promise<FormTemplate> {
  const { name, category } = formTemplateNameCategorySchema.parse({ name: data.name, category: data.category });
  if (!name) throw new AppError(422, 'ERR-FORM-VALIDATION', 'name is required');
  const governanceInput = formTemplateGovernanceSchema.parse({
    instanceApproval: data.instanceApproval, auditPolicy: data.auditPolicy, signingPolicy: data.signingPolicy,
  });
  const instanceApproval = governanceInput.instanceApproval === 'chain' ? 'chain' : 'none';
  const { auditPolicy, signingPolicy } = resolveFormGovernance(instanceApproval, governanceInput.auditPolicy, governanceInput.signingPolicy);
  validateTemplateSchemaJson(data.schemaJson);
  assertOwnBasePdfKey(data.basePdfObjectKey, user.tenantId);
  await assertTemplateNameFree(name, user.tenantId);
  const scope = await assertScopeWritable(user, { departmentId: data.departmentId, orgUnitId: data.orgUnitId });

  const template = await FormTemplate.create({
    tenantId: user.tenantId,
    name,
    category: category ?? null,
    basePdfObjectKey: data.basePdfObjectKey ?? null,
    isLetterhead: Boolean(data.basePdfObjectKey) && Boolean(data.isLetterhead),
    departmentId: scope.departmentId,
    orgUnitId: scope.orgUnitId,
    schemaJson: data.schemaJson,
    sectionsJson: data.sectionsJson ?? null,
    layoutMode: data.layoutMode ?? 'static',
    instanceApproval,
    auditPolicy,
    signingPolicy,
    status: 'draft',
    createdBy: user.userId,
    version: 1,
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_CREATED,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { action: 'form_template_created', templateId: template.id, name: template.name, tenantId: user.tenantId, departmentId: scope.departmentId, orgUnitId: scope.orgUnitId },
  });

  return template;
}

export async function listFormTemplates(
  user: AuthenticatedUser,
  statusFilter?: string,
  skip = 0,
  take = 25,
): Promise<{ data: FormTemplate[]; total: number }> {
  const where: Record<string | symbol, unknown> = { tenantId: user.tenantId };
  if (statusFilter) where.status = statusFilter;
  if (statusFilter === 'active') {
    // A newer ACTIVE revision of the same template supersedes this one: the
    // approval engine activates a new version but never deprecates the one it
    // replaces, so without this the fill picker offers both and the older one
    // keeps accepting submissions (createFormInstance refuses it too).
    where[Op.and] = [literal(SUPERSEDED_SQL.replace(/__T__/g, '"FormTemplate"'))];
  }
  // Out-of-scope templates are not offered, the way GET /document-types is scoped; organisation-level roles see every
  // template and an author always sees their own.
  const scopeWhere = await templateVisibilityWhere(user);
  if (scopeWhere) where[Op.and] = [...((where[Op.and] as unknown[] | undefined) ?? []), scopeWhere];
  const safeTake = Math.min(Math.max(Number.isFinite(take) ? Math.trunc(take) : 25, 1), 100);
  const safeSkip = Math.max(Number.isFinite(skip) ? Math.trunc(skip) : 0, 0);
  const { rows, count } = await FormTemplate.findAndCountAll({
    where,
    order: [['updatedAt', 'DESC']],
    offset: safeSkip,
    limit: safeTake,
    include: [{ model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName', 'email'] }],
  });
  await hideHiddenApprovers(rows, user);
  return { data: rows, total: count };
}

/** `NOT EXISTS` a newer active revision of the same template (same tenant + name). */
const SUPERSEDED_SQL = `NOT EXISTS (
  SELECT 1 FROM form_templates newer
   WHERE newer.tenant_id = __T__.tenant_id AND newer.name = __T__.name
     AND newer.status = 'active' AND newer.version > __T__.version)`;

/**
 * The platform administrator is invisible to everyone else (shared/platformAdmin.ts).
 * A template they approved carries their id and, through the `approver`
 * association, their name and e-mail — redact both from what is RETURNED.
 * Done on the response copy only: the model instance is also what the
 * update paths save, so its approvedBy must never be rewritten.
 */
async function hideHiddenApprovers(rows: FormTemplate[], user: AuthenticatedUser): Promise<void> {
  if (rows.length === 0) return;
  const hidden = new Set(await hiddenUserIds(user.userId));
  if (hidden.size === 0) return;
  for (const row of rows) {
    const values = row.dataValues as unknown as Record<string, unknown>;
    if (row.approvedBy && hidden.has(row.approvedBy)) {
      values.approver = null;
      values.approvedBy = null;
    }
    if (row.createdBy && hidden.has(row.createdBy)) values.createdBy = null;
  }
}

/**
 * Distinct, non-null category values already used by this tenant's own
 * templates — powers the template builder's category field as a `<datalist>`
 * suggestion list rather than a hard enum.
 *
 * FIX 2026-09-15: `category` (FormTemplate.category) is a free-text
 * VARCHAR(100) with no backing table, so the forms-module analog of the
 * DocumentType retention-class bug isn't "an invalid value gets accepted"
 * (there is no invalid value — any string is a legitimate category name) but
 * "near-duplicate categories accumulate with nobody able to see what already
 * exists" ("HR" / "Hr" / "Human Resources" all separately typed for the same
 * intended grouping, splitting what should be one filter bucket into three).
 * Sourcing suggestions from what tenants have actually already typed — same
 * spirit as the department-name-disambiguation fix elsewhere this pass —
 * fixes that without inventing an artificial fixed taxonomy no one asked for.
 */
export async function listFormTemplateCategories(tenantId: string): Promise<string[]> {
  const rows = await FormTemplate.findAll({
    where: { tenantId },
    attributes: ['category'],
    group: ['category'],
    order: [['category', 'ASC']],
  });
  return rows.map((r) => r.category).filter((c): c is string => Boolean(c));
}

/** Raw load for the update paths — the returned model is what they SAVE, so it
 *  must not have been redacted (see hideHiddenApprovers). */
async function loadFormTemplate(id: string, user: AuthenticatedUser): Promise<FormTemplate> {
  const template = await FormTemplate.findOne({
    where: { id, tenantId: user.tenantId },
    include: [{ model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName', 'email'] }],
  });
  if (!template) throw new AppError(404, 'ERR-NOT-FOUND', 'Form template not found');
  return template;
}

export async function getFormTemplate(id: string, user: AuthenticatedUser): Promise<FormTemplate> {
  const template = await loadFormTemplate(id, user);
  // A template outside the caller's scope reads as not found (authors, org-level roles and its approvers excepted).
  if (!(await canViewFormTemplate(template, user))) throw new AppError(404, 'ERR-NOT-FOUND', 'Form template not found');
  await hideHiddenApprovers([template], user);
  return template;
}

// Lifecycle of a template:
//   draft -> pending_approval   POST /approvals/FORM_TEMPLATE/:id/submit (engine)
//   pending_approval -> active  final APPROVE (engine; stamps approvedBy)
//   pending_approval -> draft   REQUEST_CHANGES / DECLINE / admin cancel (engine)
//   active -> deprecated        PATCH /templates/:id/status (below) — the ONLY
//                               transition this endpoint performs
// Every other flip used to be allowed here and each one bypassed the engine:
// draft -> pending_approval left a pending template with no chain;
// pending_approval -> draft let the author edit a template whose approval was
// still running (approve-then-swap); active -> draft reopened a live template
// for in-place edits that its already-filed instances (which reference the
// template row, not a snapshot) would then be displayed against. A published
// template is changed by authoring a new version, never by reopening it.
const FORM_TEMPLATE_TRANSITIONS: Record<string, string[]> = {
  draft: [],
  pending_approval: [],
  active: ['deprecated'],
  deprecated: [],
};

export async function updateFormTemplateStatus(
  id: string,
  status: 'draft' | 'pending_approval' | 'active' | 'deprecated',
  user: AuthenticatedUser,
): Promise<FormTemplate> {
  const template = await loadFormTemplate(id, user);
  await assertCanModifyTemplate(template, user);

  const allowed = FORM_TEMPLATE_TRANSITIONS[template.status] ?? [];
  if (template.status !== status && !allowed.includes(status)) {
    throw new AppError(
      409,
      'ERR-FORM-STATE-INVALID',
      `Invalid form template transition: ${template.status} -> ${status}`,
    );
  }

  // Rec §7.1 / SYSTEM-DECISIONS.md D1: activation is no longer a status-flag
  // flip — templates go through the unified approval engine (submit via
  // POST /approvals/FORM_TEMPLATE/:id/submit; the final APPROVE sets 'active'
  // and stamps approvedBy). Direct flips to 'active' are refused.
  if (status === 'active' && template.status !== 'active') {
    throw new AppError(
      409,
      'ERR-FORM-APPROVAL-REQUIRED',
      'Templates are activated through the approval engine — submit it for approval instead of setting the status directly',
    );
  }

  if (template.status !== status) {
    const from = template.status;
    await template.update({ status });

    await writeAuditLog({
      eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
      userId: user.userId,
      userRole: user.role,
      actionDetails: { action: 'form_template_status_changed', templateId: id, from, status, tenantId: user.tenantId },
    });
  }

  await hideHiddenApprovers([template], user);
  return template;
}

/** While a template is still a draft (never published), its content is
 *  freely editable — nothing has ever been filled against it. Once it's been
 *  through the approval engine (active/deprecated), content is immutable;
 *  use createFormTemplateVersion() to author a new revision instead. */
export async function updateFormTemplateContent(
  id: string,
  data: {
    name?: string;
    category?: string;
    basePdfObjectKey?: string | null;
    isLetterhead?: boolean;
    schemaJson?: object;
    sectionsJson?: Array<{ id: string; label: string; order: number }>;
    instanceApproval?: 'none' | 'chain';
    auditPolicy?: 'required' | 'optional' | 'never';
    signingPolicy?: 'none' | 'ceremony';
    /** Omit both to keep the scope; send either (null = cleared) to change it. */
    departmentId?: string | null;
    orgUnitId?: string | null;
  },
  user: AuthenticatedUser,
): Promise<FormTemplate> {
  const template = await loadFormTemplate(id, user);
  await assertCanModifyTemplate(template, user);
  if (template.status !== 'draft') {
    throw new AppError(409, 'ERR-FORM-TEMPLATE-NOT-DRAFT', 'Only a draft template can be edited directly — use "new version" for a published template');
  }
  const { name, category } = formTemplateNameCategorySchema.parse({ name: data.name, category: data.category });
  if (data.schemaJson !== undefined) validateTemplateSchemaJson(data.schemaJson);
  assertOwnBasePdfKey(data.basePdfObjectKey, user.tenantId);
  if (name && name !== template.name) await assertTemplateNameFree(name, user.tenantId);
  const governanceInput = formTemplateGovernanceSchema.parse({
    instanceApproval: data.instanceApproval, auditPolicy: data.auditPolicy, signingPolicy: data.signingPolicy,
  });
  const nextInstanceApproval = governanceInput.instanceApproval ?? template.instanceApproval;
  // Only reset auditPolicy/signingPolicy to their inert defaults when THIS
  // update is what turns chain approval off (or it was already off) — a
  // partial update that touches neither instanceApproval nor these two
  // fields must keep whatever the template already had, not stomp it.
  const { auditPolicy, signingPolicy } = resolveFormGovernance(
    nextInstanceApproval,
    governanceInput.auditPolicy ?? (template.auditPolicy as 'required' | 'optional' | 'never'),
    governanceInput.signingPolicy ?? (template.signingPolicy as 'none' | 'ceremony'),
  );
  const nextScope = data.departmentId !== undefined || data.orgUnitId !== undefined
    ? await assertScopeWritable(user, { departmentId: data.departmentId, orgUnitId: data.orgUnitId })
    : null;
  const nextBasePdfObjectKey = data.basePdfObjectKey !== undefined ? data.basePdfObjectKey : template.basePdfObjectKey;
  await template.update({
    name: name ?? template.name,
    category: category !== undefined ? (category ?? null) : template.category,
    basePdfObjectKey: nextBasePdfObjectKey,
    isLetterhead: Boolean(nextBasePdfObjectKey) && (data.isLetterhead ?? template.isLetterhead),
    schemaJson: data.schemaJson ?? template.schemaJson,
    sectionsJson: data.sectionsJson ?? template.sectionsJson,
    instanceApproval: nextInstanceApproval,
    auditPolicy,
    signingPolicy,
    ...(nextScope ? { departmentId: nextScope.departmentId, orgUnitId: nextScope.orgUnitId } : {}),
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { action: 'form_template_content_updated', templateId: id, tenantId: user.tenantId },
  });

  await hideHiddenApprovers([template], user);
  return template;
}

/** Authors a new revision of a published template — clones it into a fresh
 *  draft row (version = previous + 1, same name/category) rather than
 *  mutating the published one in place, so existing filled instances keep
 *  referencing the template version they were actually filled against
 *  (FormInstance.templateVersion). */
export async function createFormTemplateVersion(id: string, user: AuthenticatedUser): Promise<FormTemplate> {
  const source = await loadFormTemplate(id, user);
  await assertCanModifyTemplate(source, user);
  if (source.status === 'draft') {
    throw new AppError(409, 'ERR-FORM-TEMPLATE-ALREADY-DRAFT', 'This template is already a draft — edit it directly');
  }

  const nextVersion = (await FormTemplate.max('version', {
    where: { tenantId: user.tenantId, name: source.name },
  })) as number | null;

  const revision = await FormTemplate.create({
    tenantId: user.tenantId,
    name: source.name,
    category: source.category,
    basePdfObjectKey: source.basePdfObjectKey,
    isLetterhead: source.isLetterhead,
    schemaJson: source.schemaJson,
    sectionsJson: source.sectionsJson,
    layoutMode: source.layoutMode,
    departmentId: source.departmentId,
    orgUnitId: source.orgUnitId,
    instanceApproval: source.instanceApproval,
    auditPolicy: source.auditPolicy,
    signingPolicy: source.signingPolicy,
    status: 'draft',
    createdBy: user.userId,
    version: (nextVersion ?? source.version) + 1,
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_CREATED,
    userId: user.userId, userRole: user.role,
    actionDetails: { action: 'form_template_version_created', templateId: revision.id, sourceTemplateId: id, version: revision.version, tenantId: user.tenantId },
  });

  return revision;
}

/** The department a filled form will actually be filed under.
 *
 *  Extracted because TWO callers need the same answer and disagreeing is a
 *  user-visible bug: `createFormInstance` files the document under it, and
 *  `getFormInstanceApprovalPrefill` scopes role-holder resolution to it. When
 *  the picker resolved holders tenant-wide while the filer used this rule, the
 *  dialog reported every role as staffed everywhere — and the author only found
 *  out otherwise after the PDF had been rendered and the instance filed, when
 *  the engine refused the chain with ERR-STEP-ROLE-UNSTAFFED.
 *
 *  FIX 2026-10-04: with no departmentId the fallback used to be the TENANT's
 *  alphabetically-first department — a department the caller usually does not
 *  belong to, and one that createFormInstance then skipped the membership check
 *  for (it only ran for a client-supplied id). The filed PDF and its attachments
 *  are readable by every member of the department they are filed under
 *  (grantDefaultDocumentAcl), and a DEPT_MANAGER step is scoped to it, so a
 *  request that simply omitted departmentId published the submission to, and
 *  routed its approval through, an unrelated department. The fallback is now the
 *  caller's OWN first department (by code). Someone with no department gets the
 *  old tenant-wide fallback only if they hold acl:bypass_admin (the same override
 *  ensureCanCreate honours); everyone else is asked to pick one. */
async function resolveFormDepartment(user: AuthenticatedUser, departmentId?: string): Promise<Department> {
  let department: Department | null;
  if (departmentId) {
    department = await Department.findOne({ where: { id: departmentId, tenantId: user.tenantId } });
  } else {
    const memberships = await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ['departmentId'] });
    const ownIds = memberships.map((m) => m.departmentId);
    department = ownIds.length > 0
      ? await Department.findOne({ where: { tenantId: user.tenantId, id: { [Op.in]: ownIds } }, order: [['code', 'ASC']] })
      : null;
    if (!department && (user.permissions as string[] | undefined)?.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) {
      department = await Department.findOne({ where: { tenantId: user.tenantId }, order: [['code', 'ASC']] });
    }
    if (!department) {
      throw new AppError(422, 'ERR-DEPT-INVALID', 'You are not a member of any department, so there is nowhere to file the form — choose a department, or ask an administrator to add you to one');
    }
  }
  if (!department)
    throw new AppError(422, 'ERR-DEPT-INVALID', 'No department available to file the form under');
  return department;
}

/** The approval chain a filled instance of this template WOULD get, resolved
 *  before the instance exists.
 *
 *  The engine's own `getSubmitPrefill` needs an item id, and a form instance
 *  has none until it is filed — which is exactly why the fill UI never had a
 *  chain to show and `fillForm` shipped an empty step list, collapsing every
 *  form in the estate onto the engine's hardcoded [{ APPROVE, DEPT_MANAGER }]
 *  default. This resolves the same recipe from the FORM TEMPLATE instead, so
 *  the submitter sees and can edit the real chain up front.
 *
 *  Source of the recipe is deliberately identical to what `submitForApproval`
 *  will use at submit time (`findActiveTemplate`: the active
 *  ApprovalChainTemplate for this formTemplateId, else the engine default), so
 *  the picker cannot show one chain and the engine build another.
 *
 *  `departmentId` scopes role-holder resolution the same way the engine scopes
 *  it at decide time (ERR-STEP-DEPT-SCOPE). Passing none is legal and simply
 *  yields the coarser tenant-wide "who holds this anywhere" list — the fill
 *  modal re-fetches with the department once the submitter picks one, so the
 *  "no one holds this role" warning reflects who can ACTUALLY act. */
export async function getFormInstanceApprovalPrefill(
  templateId: string,
  user: AuthenticatedUser,
  departmentId?: string,
): Promise<{
  instanceApproval: 'none' | 'chain';
  chainTemplateId: string | null;
  chainTemplateName: string | null;
  /** The department the instance will actually be filed under — the caller's
   *  choice when they made one, otherwise the same fallback createFormInstance
   *  applies. Returned so the UI can scope its own role-holder lookups to it
   *  and name it, rather than guessing or asking tenant-wide. */
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  steps: Array<ApprovalTemplateStep & { roleHolders?: { id: string; firstName: string; lastName: string; email: string }[] }>;
}> {
  // Reuses the template's own read authorization — a caller who cannot see
  // the template must not learn its approval routing either.
  const template = await getFormTemplate(templateId, user);
  const department = await resolveFormDepartment(user, departmentId);
  assertTemplateUsableForDepartment(template, department, user);

  if (template.instanceApproval !== 'chain') {
    return {
      instanceApproval: 'none',
      chainTemplateId: null,
      chainTemplateName: null,
      departmentId: department.id,
      departmentName: department.name,
      departmentCode: department.code,
      steps: [],
    };
  }

  // The SAME recipe resolution submitForApproval will use (form template's own recipe, then the FORM document type's;
  // department > org unit > tenant-wide), so the picker cannot show one chain and the engine build another.
  const { findFormInstanceRecipe } = await import('../approvals/approvals.service.js');
  const formDocType = await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'FORM' }, attributes: ['id'] });
  const chainTemplate = await findFormInstanceRecipe(user.tenantId, department.id, template.id, formDocType?.id ?? null);

  const steps: ApprovalTemplateStep[] = chainTemplate?.steps?.length
    ? chainTemplate.steps
    : [{ stepOrder: 1, stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', assignedUserId: null, locked: false, slaHours: null }];

  // Dynamic, like the submitForApproval call below: approvals.service imports
  // this module for the form-instance lifecycle, so a static import here is a
  // cycle.
  const { resolveRoleHolders } = await import('../approvals/approvals.service.js');
  const roleNames = [...new Set(steps.map((s) => s.assignedRole).filter(Boolean))] as string[];
  const byRole = await resolveRoleHolders(roleNames, user.tenantId, department.id);

  return {
    instanceApproval: 'chain',
    chainTemplateId: chainTemplate?.id ?? null,
    chainTemplateName: chainTemplate?.name ?? null,
    departmentId: department.id,
    departmentName: department.name,
    departmentCode: department.code,
    steps: steps.map((s) => (s.assignedRole ? { ...s, roleHolders: byRole.get(s.assignedRole) ?? [] } : s)),
  };
}

// ── Instance (form submission → PDF → Document) ──────────────────────────────

/** Author-chosen approval chain for a filled form instance.
 *
 *  Mirrors the engine's own submit shape (approvals.service.ts's submitSchema)
 *  so what the picker offers can never disagree with what submitForApproval
 *  will accept. Omitted -> the template's chain recipe, then the engine
 *  default: exactly the previous behaviour, so an existing caller that sends
 *  nothing is unaffected. */
const formApprovalStepsSchema = z
  .array(
    z
      .object({
        stepType: z.enum(['REVIEW', 'APPROVE']),
        assignedUserId: z.string().uuid().optional(),
        assignedRole: z.string().max(64).optional(),
        slaHours: z.coerce.number().int().min(1).optional(),
      })
      .refine((s) => Boolean(s.assignedUserId) !== Boolean(s.assignedRole), {
        message: 'Each step needs exactly one of an assigned user or an assigned role',
      }),
  )
  .min(1)
  .optional();

type PreparedSubmission = {
  allFields: FormFieldSchema[];
  fileFieldNames: Set<string>;
  hiddenFileFieldNames: Set<string>;
  effectiveDataJson: Record<string, unknown>;
  effectiveFiles: Record<string, Express.Multer.File> | undefined;
  parsedData: Record<string, unknown>;
};

/**
 * Server-side preparation of a submitted form, shared by filing and by editing a pre-approval instance: derive
 * computed fields, drop hidden ones, validate against the template, check required files. `existingAttachments`
 * are file-field values already filed (an edit): they satisfy `required` and are not asked for again.
 */
function prepareSubmission(
  template: FormTemplate,
  dataJson: Record<string, unknown>,
  files: Record<string, Express.Multer.File> | undefined,
  existingAttachments: Record<string, unknown> = {},
): PreparedSubmission {
  const allFields = ((template.schemaJson as FormFieldSchema[][]) ?? []).flat();
  // file-type fields carry their real value in `files`, not `dataJson`.
  const fileFieldNames = new Set(allFields.filter((f) => f?.type === 'file').map((f) => f.name));
  // Computed fields are re-derived from the OTHER submitted values (never trust a client value the server can compute),
  // then a hidden (conditionalOn not met) field's value is stripped outright.
  // A required file field validates as a required string, so a file that IS supplied (just now, or already filed on an
  // edit) must count as its value even if the client did not echo the file name into dataJson.
  const submitted: Record<string, unknown> = { ...dataJson };
  for (const name of fileFieldNames) {
    if (submitted[name] !== undefined && submitted[name] !== '') continue;
    const fresh = files?.[name];
    const existing = existingAttachments[name] as { fileName?: string } | undefined;
    if (fresh) submitted[name] = fresh.originalname;
    else if (existing) submitted[name] = existing.fileName || 'attached';
  }
  const effectiveDataJson = stripHiddenFieldValues(allFields, applyComputedFields(allFields, submitted));
  const hiddenFileFieldNames = new Set(
    allFields.filter((f) => f?.type === 'file' && !isFieldConditionMet(f, effectiveDataJson)).map((f) => f.name),
  );
  const effectiveFiles = files
    ? Object.fromEntries(Object.entries(files).filter(([name]) => !hiddenFileFieldNames.has(name)))
    : files;
  const parsed = buildZodSchemaFromTemplate(template.schemaJson, effectiveDataJson).safeParse(effectiveDataJson);
  if (!parsed.success) {
    throw new AppError(422, 'ERR-FORM-VALIDATION', 'Form submission failed validation', parsed.error.flatten());
  }
  for (const name of fileFieldNames) {
    // A file field its condition hides was never shown to the submitter, so it can be neither required nor filed.
    if (hiddenFileFieldNames.has(name)) continue;
    const field = allFields.find((f) => f.name === name);
    if (field?.required && !files?.[name] && !existingAttachments[name]) {
      throw new AppError(422, 'ERR-FORM-VALIDATION', '"' + name + '" requires an uploaded file');
    }
  }
  return { allFields, fileFieldNames, hiddenFileFieldNames, effectiveDataJson, effectiveFiles, parsedData: parsed.data as Record<string, unknown> };
}

type PreparedAttachment = {
  name: string; file: Express.Multer.File; documentId: string; versionId: string; storageKey: string;
  encryptedKey: string; encHash: string; kekId: string; plaintextSha: string;
  avScanStatus: 'clean' | 'unscanned';
};

/** Validate, scan and encrypt each uploaded file-field attachment (I/O outside the DB transaction). */
async function prepareAttachmentUploads(args: {
  fileFieldNames: Set<string>;
  hiddenFileFieldNames: Set<string>;
  files?: Record<string, Express.Multer.File>;
  parentDocumentId: string;
  department: Department;
  user: AuthenticatedUser;
}): Promise<PreparedAttachment[]> {
  const { fileFieldNames, hiddenFileFieldNames, files, parentDocumentId, department, user } = args;
  const out: PreparedAttachment[] = [];
  for (const name of fileFieldNames) {
    const file = hiddenFileFieldNames.has(name) ? undefined : files?.[name];
    if (!file) continue;
    // Same byte-sniffed type/extension allowlist and (fail-open) antivirus scan as every other upload path.
    await validateUploadedFile(file.buffer, file.originalname);
    const avScanStatus = await scanBuffer(file.buffer);
    const attDocumentId = crypto.randomUUID();
    const attVersionId = crypto.randomUUID();
    const attStorageKey = department.code + '/FORM/' + parentDocumentId + '/attachments/' + attDocumentId + '/' + sanitizeFilename(file.originalname);
    const att = await encryptAndStore(attStorageKey, file.buffer, file.mimetype, department.id, user.tenantId);
    out.push({
      name, file, documentId: attDocumentId, versionId: attVersionId, storageKey: attStorageKey,
      encryptedKey: att.encryptedKey, encHash: att.sha256Hash, kekId: att.kekId,
      plaintextSha: crypto.createHash('sha256').update(file.buffer).digest('hex'),
      avScanStatus,
    });
  }
  return out;
}

/** File each prepared attachment as its own Document (inside the caller's transaction). Returns the dataJson file-field values. */
async function createAttachmentDocuments(
  attachments: PreparedAttachment[],
  ctx: { tenantId: string; department: Department; docTypeId: string; user: AuthenticatedUser },
  tx: SequelizeTransaction,
): Promise<Record<string, { documentId: string; fileName: string }>> {
  const { grantDefaultDocumentAcl } = await import('../documents/documents.service.js');
  const { tenantId, department, docTypeId, user } = ctx;
  const refs: Record<string, { documentId: string; fileName: string }> = {};
  for (const att of attachments) {
    await Document.create(
      {
        id: att.documentId,
        tenantId,
        documentName: att.file.originalname.slice(0, 235) + ' — ' + att.documentId.slice(0, 8),
        title: att.file.originalname.slice(0, 255),
        departmentId: department.id,
        documentTypeId: docTypeId,
        folderId: null,
        ownerId: user.userId,
        organisationUnit: department.code,
        status: 'ACTIVE',
        securityClassification: 'INTERNAL',
        retentionClass: 'RET-FORM-5Y',
        documentDate: new Date(),
        retentionTriggerDate: new Date(),
        disposalEligibleDate: null,
        latestVersionId: null,
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
    const attVersion = await DocumentVersion.create(
      {
        id: att.versionId,
        documentId: att.documentId,
        versionNumber: '1.0',
        isMajorVersion: true,
        storageKey: att.storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(att.file.size),
        mimeType: att.file.mimetype,
        originalFilename: att.file.originalname,
        sha256Hash: att.encHash,
        plaintextSha256: att.plaintextSha,
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'Form field attachment uploaded',
        avScanStatus: att.avScanStatus,
      } as any,
      { transaction: tx },
    );
    await Document.update({ latestVersionId: attVersion.id }, { where: { id: att.documentId }, transaction: tx });
    await DocumentDek.create(
      { documentId: att.documentId, versionId: att.versionId, encryptedDek: att.encryptedKey, kekId: att.kekId, algorithm: 'AES-256-GCM' },
      { transaction: tx },
    );
    await OutboxEvent.bulkCreate(
      [
        { documentId: att.documentId, type: 'OCR_PROCESSING', channel: 'OCR', payload: JSON.stringify({ documentId: att.documentId, versionId: att.versionId, tenantId }) },
        { documentId: att.documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId: att.documentId, tenantId }) },
      ],
      { transaction: tx },
    );
    await grantDefaultDocumentAcl(att.documentId, user.userId, tenantId, department.id, tx);
    refs[att.name] = { documentId: att.documentId, fileName: att.file.originalname };
  }
  return refs;
}

export async function createFormInstance(
  templateId: string,
  dataJson: Record<string, unknown>,
  user: AuthenticatedUser,
  departmentId?: string,
  files?: Record<string, Express.Multer.File>,
  /** Who approves this submission. See formApprovalStepsSchema. */
  approvalSteps?: unknown,
  /** saveAsDraft: file the form as a DRAFT without submitting it (chain-approval templates only); submit it later. */
  options: { saveAsDraft?: boolean } = {},
): Promise<{ instance: FormInstance; approvalWarning?: string }> {
  const template = await getFormTemplate(templateId, user);
  if (template.status !== 'active') {
    throw new AppError(409, 'ERR-TEMPLATE-INACTIVE', 'Form template is not active');
  }

  if (options.saveAsDraft && template.instanceApproval !== 'chain') {
    throw new AppError(422, 'ERR-FORM-DRAFT-NOT-USED', 'This form does not go through approval, so it cannot be saved as a draft — filing it is final');
  }

  // Parsed up front so a malformed chain is a 422 before a PDF is rendered and
  // a document filed — the fill transaction commits before the submit runs, so
  // a late failure would leave a filed instance with no chain.
  const chosenSteps = formApprovalStepsSchema.parse(approvalSteps ?? undefined);
  if (chosenSteps && template.instanceApproval !== 'chain') {
    throw new AppError(
      422,
      'ERR-FORM-APPROVAL-NOT-USED',
      'This form template does not use chain approval, so approvers cannot be chosen for it',
    );
  }
  if (chosenSteps && chosenSteps[chosenSteps.length - 1]!.stepType !== 'APPROVE') {
    throw new AppError(
      422,
      'ERR-CHAIN-FINAL-STEP',
      'The final step of the approval chain must be an APPROVE step',
    );
  }

  // A newer ACTIVE revision of this template supersedes it. The engine activates a
  // new version without deprecating the old one, so both stay 'active'; the old
  // one must not keep accepting submissions (the picker hides it too).
  const newer = await FormTemplate.findOne({
    where: { tenantId: user.tenantId, name: template.name, status: 'active', version: { [Op.gt]: template.version } },
    attributes: ['id', 'version'],
  });
  if (newer) {
    throw new AppError(409, 'ERR-TEMPLATE-SUPERSEDED', 'A newer version of this form template is active — reopen the form to use it');
  }

  const prepared = prepareSubmission(template, dataJson, files);
  const { allFields, fileFieldNames, hiddenFileFieldNames, effectiveDataJson, effectiveFiles } = prepared;
  const parsed = { data: prepared.parsedData };

  // A generated form is filed as a first-class Document, which requires a
  // document type and a department (both NOT NULL). Resolve the FORM doctype
  // (seeded per tenant) and a target department.
  const docType = await DocumentType.findOne({ where: { tenantId: user.tenantId, code: 'FORM' } });
  if (!docType)
    throw new AppError(500, 'ERR-DOCTYPE-FORM-MISSING', 'FORM document type is not seeded for this tenant');
  const department = await resolveFormDepartment(user, departmentId);
  // FIX: departmentId is client-supplied (forms.routes.ts's POST /instances
  // takes it straight from req.body) and had NO membership check — any
  // employee submitting a form could pick ANY department id and have the
  // generated PDF filed under it. Same bug class as documents.service.ts's
  // createDocument (now fixed via ensureCanCreate) and esigning.service.ts's
  // upload-to-sign endpoint; this path just never had the check to begin
  // with. Only guards the CLIENT-SUPPLIED case — the no-departmentId
  // fallback above (arbitrary first department) isn't attacker-controlled.
  if (departmentId) {
    await ensureCanCreate(user, department.id);
  }
  // The template must cover the filing department (audit item 6), like a document type must.
  assertTemplateUsableForDepartment(template, department, user);

  // Generate PDF using pdfme — every field renders through the `text` plugin
  // (see toPdfmeSchema below), so every value handed to pdfme must be a
  // string: file fields print as "(attached: <filename>)" rather than
  // nothing, since the real file is filed as its own Document (see the
  // attachment-filing block below), not as printable text; checkbox/number
  // values are formatted via toPrintableFormData (parsed.data, not the raw
  // dataJson, so a coerced number is a real number and a passthrough-only
  // hidden field doesn't crash the string conversion).
  const printableDataJson = toPrintableFormData(allFields, parsed.data as Record<string, unknown>, effectiveFiles);

  let pdf: Buffer;
  try {
    pdf = await generateFormPdf(template.schemaJson, template.basePdfObjectKey, template.isLetterhead, parsed.data as Record<string, unknown>, printableDataJson, template.name);
  } catch (err) {
    logger.error({ err, templateId }, 'pdfme generation failed');
    throw new AppError(500, 'ERR-PDF-GENERATION', 'Failed to generate form PDF');
  }

  const documentName = `${template.name} — ${new Date().toISOString().slice(0, 19).replace('T', ' ')} — ${crypto.randomUUID().slice(0, 8)}`;
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  // TEN-3: see documents.service.ts's uploadDocument storageKey comment.
  const storageKey = `${user.tenantId}/${department.code}/FORM/${documentId}/${versionId}/form.pdf`;
  const plaintextSha = crypto.createHash('sha256').update(pdf).digest('hex');

  // File through the canonical encryption pipeline (same as documents/letters).
  const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(
    storageKey, pdf, 'application/pdf', department.id, user.tenantId,
  );

  // File each uploaded "file"-type field as its own encrypted Document — same
  // pattern letters.service.ts's addLetterAttachment uses — rather than
  // storing just the filename string in dataJson (which was previously the
  // whole "upload"; no bytes were ever kept). Encryption I/O happens outside
  // the DB transaction, same as the main PDF above.
  const attachmentsToFile = await prepareAttachmentUploads({
    fileFieldNames, hiddenFileFieldNames, files, parentDocumentId: documentId, department, user,
  });

  const instance = await runInTransaction(async (tx) => {
    // Filed bytes count against the tenant's storage quota exactly like an upload
    // (documents.service.ts's createDocument). Forms skipped this entirely, so the
    // quota was never enforced for them — yet trash/purge give the bytes BACK
    // (decrementStorageUsed), steadily under-counting everyone else's usage.
    await reserveStorageQuota(
      user.tenantId,
      pdf.length + attachmentsToFile.reduce((sum, att) => sum + att.file.size, 0),
      tx,
    );
    await Document.create(
      {
        id: documentId,
        tenantId: user.tenantId,
        documentName,
        title: template.name.slice(0, 255),
        departmentId: department.id,
        documentTypeId: docType.id,
        folderId: null,
        ownerId: user.userId,
        organisationUnit: department.code,
        // Rec §7.2: instances of chain-approval templates start as DRAFT and
        // are auto-submitted through the engine right after creation; plain
        // templates keep the historical fill-and-done ACTIVE.
        status: template.instanceApproval === 'chain' ? 'DRAFT' : 'ACTIVE',
        securityClassification: 'INTERNAL',
        retentionClass: 'RET-FORM-5Y',
        documentDate: new Date(),
        retentionTriggerDate: new Date(),
        disposalEligibleDate: null,
        latestVersionId: null,
        source: 'CREATED_IN_SYSTEM',
        archivedAt: null,
        ocrStatus: null,
        ocrConfidenceScore: null,
        aiSummary: null,
        aiSuggestedMetadata: null,
        deletedAt: null,
      } as any,
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
        fileSize: BigInt(pdf.length),
        mimeType: 'application/pdf',
        originalFilename: `${documentName.replace(/[^\w.-]+/g, '_')}.pdf`,
        sha256Hash: encHash,
        plaintextSha256: plaintextSha,
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'Generated form instance',
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
        { documentId, type: 'DOCUMENT.CREATED', channel: 'WEBSOCKET', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
        { documentId, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId, tenantId: user.tenantId }) },
      ],
      { transaction: tx },
    );
    // Retention engine (gap #1): form documents get their disposal clock too.
    await applyRetention(documentId, tx);
    // Default ACLs — without these only admins could open the generated form.
    const { grantDefaultDocumentAcl } = await import('../documents/documents.service.js');
    await grantDefaultDocumentAcl(documentId, user.userId, user.tenantId, department.id, tx);

    // Stored from the SERVER-derived values, not the raw request body: a client
    // can send any value for a computed field and any stray value for a field
    // its answers hid (both were already neutralised for the PDF but still landed
    // in this row, which is what the detail view and downstream readers show),
    // plus arbitrary extra keys that belong to no field at all.
    const knownFieldNames = new Set(allFields.map((f) => f?.name).filter(Boolean));
    const enrichedDataJson: Record<string, unknown> = Object.fromEntries(
      Object.entries(effectiveDataJson).filter(([key]) => knownFieldNames.has(key) && !fileFieldNames.has(key)),
    );
    Object.assign(
      enrichedDataJson,
      await createAttachmentDocuments(attachmentsToFile, { tenantId: user.tenantId, department, docTypeId: docType.id, user }, tx),
    );

    return FormInstance.create(
      {
        templateId,
        templateVersion: template.version,
        documentId,
        dataJson: enrichedDataJson,
        generatedPdfObjectKey: storageKey,
        createdBy: user.userId,
      },
      { transaction: tx },
    );
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_CREATED,
    documentId,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { action: 'form_instance_created', instanceId: instance.id, templateId, templateVersion: template.version, tenantId: user.tenantId, draft: Boolean(options.saveAsDraft) },
  });

  for (const att of attachmentsToFile) {
    if (att.avScanStatus === 'unscanned') {
      await writeAuditLog({
        eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
        userId: user.userId,
        userRole: user.role,
        documentId: att.documentId,
        actionDetails: { versionId: att.versionId, reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
      });
    }
  }

  // Rec §7.2: chain-approval templates auto-submit the filled instance through
  // the unified engine (the template's own chain recipe, or the default).
  //
  // M6: the fill transaction has already committed, so a submit failure (e.g. an
  // unstaffed role in the default chain) must NOT surface as a fill failure or
  // strand the instance with no recovery. Treat the fill as successful, leave the
  // instance as a retryable DRAFT, and return a warning the caller can show — the
  // author can submit it later from My Work (POST /approvals/FORM_INSTANCE/:id/submit).
  let approvalWarning: string | undefined;
  if (template.instanceApproval === 'chain' && !options.saveAsDraft) {
    const { submitForApproval } = await import('../approvals/approvals.service.js');
    try {
      // Was `{}` — an empty step list, which is why every form chain in the
      // database ended up as the engine's hardcoded single
      // [{ APPROVE, DEPT_MANAGER }] default regardless of who the submitter
      // actually wanted. Omitting `steps` still falls back to the template
      // recipe, so a caller that chooses nothing behaves exactly as before.
      await submitForApproval(
        'FORM_INSTANCE',
        instance.id,
        chosenSteps ? { steps: chosenSteps } : {},
        user,
      );
    } catch (err) {
      logger.warn(
        { err, instanceId: instance.id, documentId },
        'form instance auto-submit failed; left as DRAFT for manual submission',
      );
      // Returned as a sibling field, not a property on the Sequelize instance —
      // Model#toJSON() only serializes DataTypes-defined attributes, so an
      // ad-hoc property assigned here would silently vanish over the wire and
      // the caller would never learn the submission needs a manual retry.
      approvalWarning =
        err instanceof AppError
          ? `Saved, but automatic submission for approval failed: ${err.message}. You can submit it from My Work.`
          : 'Saved, but automatic submission for approval failed. You can submit it from My Work.';
    }
  }

  return { instance, approvalWarning };
}

/** Backs "My Submissions" — a tenant- and (optionally) creator-scoped list of
 *  filled forms with their backing document's status, since a form instance's
 *  own approval progress is really the backing document's lifecycle. */
/**
 * Allocate a form instance's reference number, at final approval.
 *
 * FORMAT  REF/<UNIT>/<DEPT>/FORM/<YEAR>/<00001>
 *
 * Same shape as a letter's, and the segments come from the same places: the
 * form's backing document carries the department, and departments.org_unit_id
 * gives the unit. Nothing about a form instance needed to change to make this
 * resolvable — the join was simply never made.
 *
 * WHY AT FINAL APPROVAL, NOT AT SUBMIT
 *
 * A number allocated at submit is consumed by every declined or abandoned
 * submission, so the series develops gaps in normal use — which defeats a
 * gap-free counter and makes a genuine gap unnoticeable. Letters allocate at
 * signature for the same reason; this is the equivalent moment in a form's own
 * lifecycle.
 *
 * CONCURRENCY
 *
 * Mirrors the letters allocator exactly: upsert the counter row, then lock it
 * FOR UPDATE inside the caller's transaction and increment. Two forms approved
 * simultaneously in the same org unit serialise on that row and get consecutive
 * numbers; neither can read a stale value, because the lock is held until the
 * approval itself commits.
 *
 * IDEMPOTENT. `completeItemApproval` runs inside the decide transaction, which
 * is already guarded against double-decide, but an instance that somehow
 * already carries a number must never be given a second one — the first is
 * printed on a filed PDF.
 *
 * Returns null rather than throwing when the form cannot be numbered (no
 * backing document, no department, no org unit, or a database error). A missing
 * reference number is a gap in a nice-to-have; a throw here would fail an
 * approval that has already been decided.
 *
 * The work runs in a SAVEPOINT. A plain try/catch is not a rollback boundary:
 * if one statement fails (a number that clashes with an existing one, say),
 * Postgres aborts the whole request transaction, the catch swallows the error,
 * and the approval's next statement dies with "current transaction is
 * aborted", which reached the person as a 500 `ERR-INTERNAL`. With a
 * savepoint only this allocation is undone and the approval carries on.
 */
export async function allocateFormReferenceNumber(
  instanceId: string,
  tenantId: string,
  tx: SequelizeTransaction,
): Promise<string | null> {
  try {
    return await runInSavepoint(() => allocateFormReferenceNumberInner(instanceId, tenantId, tx));
  } catch (error) {
    logger.warn({ error, instanceId }, '[forms] could not allocate a reference number for an approved form');
    return null;
  }
}

async function allocateFormReferenceNumberInner(
  instanceId: string,
  tenantId: string,
  tx: SequelizeTransaction,
): Promise<string | null> {
  const instance = await FormInstance.findByPk(instanceId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!instance) return null;
  if (instance.referenceNumber) return instance.referenceNumber;
  if (!instance.documentId) return null;

  const doc = await Document.findByPk(instance.documentId, { transaction: tx });
  if (!doc?.departmentId) return null;
  const department = await Department.findByPk(doc.departmentId, { transaction: tx });
  if (!department) return null;
  const orgUnit = await OrgUnit.findByPk(department.orgUnitId, { transaction: tx });
  if (!orgUnit) return null;

  const allocatedAt = new Date(); // server time, never client time
  const year = allocatedAt.getFullYear();

  await sequelize.query(
    `INSERT INTO form_sequences (tenant_id, org_unit_id, year, last_value)
     VALUES (:tenantId, :orgUnitId, :year, 0)
     ON CONFLICT (tenant_id, org_unit_id, year) DO NOTHING`,
    { replacements: { tenantId, orgUnitId: orgUnit.id, year }, transaction: tx },
  );
  const seqRow = await FormSequence.findOne({
    where: { tenantId, orgUnitId: orgUnit.id, year },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!seqRow) return null;

  const nextValue = seqRow.lastValue + 1;
  await seqRow.update({ lastValue: nextValue }, { transaction: tx });

  const referenceNumber = `${config.REFERENCE_NUMBER_PREFIX}/${orgUnit.code}/${department.code}/FORM/${year}/${String(nextValue).padStart(5, '0')}`;
  await instance.update({ referenceNumber, referenceAllocatedAt: allocatedAt, referenceTenantId: tenantId }, { transaction: tx });

  // The number is what people will quote, so put it on the document too —
  // otherwise the form is findable by it and the filed PDF is not.
  await doc.update({ documentName: `${referenceNumber} — ${doc.title}`.slice(0, 255) }, { transaction: tx });

  return referenceNumber;
}

export async function listFormInstances(
  user: AuthenticatedUser,
  filters: { createdBy?: string; templateId?: string; status?: string } = {},
  skip = 0,
  take = 25,
): Promise<{ data: FormInstance[]; total: number }> {
  // The ids go straight into uuid columns: a non-uuid used to surface as a
  // Postgres "invalid input syntax" 500 rather than a validation error.
  const uuid = z.string().uuid();
  if ((filters.createdBy && !uuid.safeParse(filters.createdBy).success) || (filters.templateId && !uuid.safeParse(filters.templateId).success)) {
    throw new AppError(422, 'ERR-FORM-VALIDATION', 'createdBy and templateId must be ids');
  }
  const where: Record<string, unknown> = {};
  if (filters.createdBy) where.createdBy = filters.createdBy;
  if (filters.templateId) where.templateId = filters.templateId;

  // A trashed form is gone from every other list and from GET /documents/:id
  // (both check deletedAt); Document is not paranoid, so it has to be asked for.
  const documentWhere: Record<string, unknown> = { tenantId: user.tenantId, deletedAt: { [Op.is]: null } };
  if (filters.status) documentWhere.status = filters.status;

  const safeTake = Math.min(Math.max(Number.isFinite(take) ? Math.trunc(take) : 25, 1), 100);
  const safeSkip = Math.max(Number.isFinite(skip) ? Math.trunc(skip) : 0, 0);
  const { rows, count } = await FormInstance.findAndCountAll({
    where,
    include: [
      { model: FormTemplate, as: 'template', attributes: ['id', 'name', 'category', 'auditPolicy', 'instanceApproval'] },
      {
        model: Document,
        as: 'document',
        where: documentWhere,
        // departmentId is in this list because the Department join below needs
        // the foreign key selected — omit it and the query dies with
        // `column "document.departmentId" does not exist`, at runtime only.
        attributes: ['id', 'title', 'status', 'createdAt', 'departmentId'],
        // A filed form belongs to a department and, through it, to an org unit
        // — exactly like every other document in the system. `form_instances`
        // itself stores neither, but it does not need to: the backing document
        // already carries departmentId, and Department.orgUnitId is NOT NULL,
        // so both are derivable rather than missing. Included here so a
        // submission can show where it was filed without the client having to
        // fetch each document separately.
        //
        // This is also the whole data prerequisite for giving forms a
        // letters-style reference number (REF/UNIT/DEPT/TYPE/YEAR/SEQ): the UNIT
        // and DEPT segments resolve from here. Only the numbering scheme itself
        // is still an open decision.
        // Same association the document detail page reads (documents.service.ts)
        // — without it, ApprovalChainCard on this page had no signatureRequests
        // prop at all and always claimed "no signing request has been created"
        // even once one existed, plus no way to reach the audit-stage placeholder
        // since auditPolicy wasn't fetched either (see template attributes above).
        include: [
          {
            model: Department,
            as: 'department',
            attributes: ['id', 'code', 'name'],
            required: false,
            include: [{ model: OrgUnit, as: 'orgUnit', attributes: ['id', 'code', 'name'], required: false }],
          },
          {
            model: SignatureRequest,
            as: 'signatureRequests',
            separate: true,
            order: [['createdAt', 'DESC']],
            include: [{ model: SignatureRecipient, as: 'recipients' }],
          },
        ],
      },
    ],
    order: [['createdAt', 'DESC']],
    offset: safeSkip,
    limit: safeTake,
    // findAndCountAll's count query drops include/attributes but keeps
    // required-inner-join wheres unless distinct — without it, count()
    // double-counts instances that hasMany-join more than one row.
    distinct: true,
  });

  // Platform audit finding (2026-08-14, HIGH): this only filtered by tenantId
  // (via the joined document), never by department/folder ACL — since
  // DOCUMENT_READ is held by essentially every role including EMPLOYEE, any
  // user in the tenant could read any other department's filled form
  // submissions. The backing document DOES get a real per-department ACL via
  // grantDefaultDocumentAcl (documents.service.ts), so filter through the
  // same authoritative check the document detail route uses — mirrors
  // listDocuments()'s own "list-visibility ⊆ detail-visibility" guarantee.
  // `count` stays the coarse pre-filter total (an upper bound); this page may
  // return fewer than safeTake, same as listDocuments/search.
  const docs = rows.map((r) => (r as unknown as { document?: { id: string } }).document).filter((d): d is { id: string } => Boolean(d));
  const allowedDocIds = new Set((await filterDocsByDetailAcl(user, docs)).map((d) => d.id));
  const data = rows.filter((r) => allowedDocIds.has((r as unknown as { document?: { id: string } }).document?.id ?? ''));

  return { data, total: count };
}

export async function getFormInstance(id: string, user: AuthenticatedUser): Promise<FormInstance> {
  const instance = await FormInstance.findByPk(id, { include: [{ model: FormTemplate, as: 'template' }] });
  if (!instance) throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
  const template = (instance as any).template as FormTemplate;
  // Another tenant's id is treated as nonexistent (404, like getDocument) so it
  // cannot be used to confirm an instance id exists elsewhere.
  if (template?.tenantId !== user.tenantId) throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
  // Platform audit finding (2026-08-14, HIGH): this only checked the
  // template's tenantId — never the backing document's per-department ACL
  // (grantDefaultDocumentAcl), letting any DOCUMENT_READ holder in the
  // tenant open any other department's filled form. Same authoritative
  // check documents.routes.ts's GET /:id runs.
  //
  // FIX 2026-10-04: three gaps against that check. (1) An instance whose backing
  // document is gone — form_instances.document_id is ON DELETE SET NULL, so a
  // purge leaves the row and its dataJson behind — used to skip the ACL check
  // ("not yet auto-submitted") and be readable by EVERY document:read holder in
  // the tenant; createFormInstance always files a document, so a null one only
  // ever means the document was destroyed. (2) A trashed document (deletedAt) was
  // still served. (3) The tenant's status-conditioned read rules
  // (assertStatusPermission 'read', which getDocument applies) were bypassed.
  if (!instance.documentId) throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
  const document = await Document.findByPk(instance.documentId, { attributes: ['id', 'tenantId', 'status', 'deletedAt'] });
  if (!document || document.deletedAt || document.tenantId !== user.tenantId) {
    throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
  }
  await assertACLAllow(
    user.userId,
    user.roles && user.roles.length > 0 ? user.roles : [user.role],
    user.tenantId,
    { resourceType: 'document', resourceId: instance.documentId, permission: PERMISSIONS.DOCUMENT_READ },
    user.permissions as string[] | undefined,
  );
  await assertStatusPermission(document, 'read', user);
  return instance;
}

// ── The filer's own lifecycle: edit, withdraw, cancel (audit E7) ──────────────
//
// Until now a filed form could never be changed: REQUEST_CHANGES / DECLINE could only lead to a resubmit of identical
// data or a brand-new filing, and a mistaken submission could not be taken back. For templates that go through approval
// the person who filed the form may now, while it is PRE-APPROVAL:
//   * save it as a draft (createFormInstance { saveAsDraft }) and submit it later;
//   * EDIT it while it is a DRAFT, CHANGES_REQUESTED or DECLINED (the PDF is re-rendered and filed as a new minor
//     version of the same document; the old versions are kept, attachments that are replaced stay as ordinary documents);
//   * WITHDRAW it from review (IN_REVIEW -> DRAFT, running chain cancelled) so it can be edited and resubmitted;
//   * CANCEL it (abandon: the document becomes CANCELLED, terminal).
// Decisions (SAFE choices, recorded in MODULE-WORKFLOWS-AND-SCOPE.md): only the filer (not even an approval admin, who
// has cancelChain); never while IN_REVIEW (approvers must not review a moving target -- withdraw first); an edit is
// validated against the template version the form was filed on and is refused if that version is no longer the active
// one (re-file under the new version); a form with no approval (instanceApproval none) is final once filed. Every action
// is audited against the backing document, checks the document ACL and legal hold, and approval is only ever reached by
// the normal submit, never by an edit.

const EDITABLE_FORM_STATUSES = ['DRAFT', 'CHANGES_REQUESTED', 'DECLINED'];

async function loadFilerInstance(
  id: string,
  user: AuthenticatedUser,
): Promise<{ instance: FormInstance; template: FormTemplate; document: Document }> {
  const notFound = () => new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
  const instance = await FormInstance.findByPk(id);
  if (!instance || !instance.documentId) throw notFound();
  const template = await FormTemplate.findOne({ where: { id: instance.templateId, tenantId: user.tenantId } });
  if (!template) throw notFound();
  const document = await Document.findByPk(instance.documentId);
  if (!document || document.deletedAt || document.tenantId !== user.tenantId) throw notFound();
  if (instance.createdBy !== user.userId && document.ownerId !== user.userId) {
    throw new AppError(403, 'ERR-NOT-FORM-FILER', 'Only the person who filed this form can edit, withdraw or cancel it');
  }
  if (template.instanceApproval !== 'chain') {
    throw new AppError(409, 'ERR-FORM-NOT-EDITABLE', 'This form does not go through approval, so it is final once filed');
  }
  requireLegalHoldClear(document);
  return { instance, template, document };
}

function assertEditableStatus(status: string): void {
  if (status === 'IN_REVIEW') {
    throw new AppError(409, 'ERR-FORM-IN-REVIEW', 'This form is under review — withdraw it from review first, then edit and resubmit it');
  }
  if (!EDITABLE_FORM_STATUSES.includes(status)) {
    throw new AppError(409, 'ERR-FORM-NOT-EDITABLE', 'A form can only be edited before it is approved (it is ' + status + ')');
  }
}

function nextMinorVersion(latest: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)$/.exec(latest ?? '');
  return m ? m[1] + '.' + (Number(m[2]) + 1) : '1.1';
}

export async function updateFormInstance(
  id: string,
  dataJson: Record<string, unknown>,
  user: AuthenticatedUser,
  files?: Record<string, Express.Multer.File>,
): Promise<FormInstance> {
  const { instance, template, document } = await loadFilerInstance(id, user);
  assertEditableStatus(document.status);
  await assertACLAllow(
    user.userId,
    user.roles && user.roles.length > 0 ? user.roles : [user.role],
    user.tenantId,
    { resourceType: 'document', resourceId: document.id, permission: PERMISSIONS.DOCUMENT_UPLOAD },
    user.permissions as string[] | undefined,
  );
  if (template.status !== 'active') {
    throw new AppError(409, 'ERR-TEMPLATE-INACTIVE', 'The form template this was filed on is no longer active — file the form again on the current version');
  }
  const newer = await FormTemplate.findOne({
    where: { tenantId: user.tenantId, name: template.name, status: 'active', version: { [Op.gt]: template.version } },
    attributes: ['id'],
  });
  if (newer) {
    throw new AppError(409, 'ERR-TEMPLATE-SUPERSEDED', 'A newer version of this form template is active — file the form again on it');
  }
  const department = await Department.findOne({ where: { id: document.departmentId, tenantId: user.tenantId } });
  if (!department) throw new AppError(422, 'ERR-DEPT-INVALID', 'The department this form was filed under no longer exists');

  const previousData = (instance.dataJson ?? {}) as Record<string, unknown>;
  const fileFields = ((template.schemaJson as FormFieldSchema[][]) ?? []).flat().filter((f) => f?.type === 'file').map((f) => f.name);
  const existingAttachments: Record<string, { documentId: string; fileName: string }> = {};
  for (const name of fileFields) {
    const v = previousData[name] as { documentId?: string; fileName?: string } | undefined;
    if (v && typeof v === 'object' && v.documentId) existingAttachments[name] = { documentId: v.documentId, fileName: v.fileName ?? '' };
  }

  const prepared = prepareSubmission(template, dataJson, files, existingAttachments);
  const { allFields, fileFieldNames, hiddenFileFieldNames, effectiveDataJson, effectiveFiles } = prepared;
  // What the PDF prints for a file field: the newly uploaded file, else the one already filed.
  const printableFiles: Record<string, { originalname: string }> = {};
  for (const name of fileFieldNames) {
    if (hiddenFileFieldNames.has(name)) continue;
    const fresh = effectiveFiles?.[name];
    if (fresh) printableFiles[name] = { originalname: fresh.originalname };
    else if (existingAttachments[name]) printableFiles[name] = { originalname: existingAttachments[name].fileName };
  }
  const printableDataJson = toPrintableFormData(allFields, prepared.parsedData, printableFiles);

  let pdf: Buffer;
  try {
    pdf = await generateFormPdf(template.schemaJson, template.basePdfObjectKey, template.isLetterhead, prepared.parsedData, printableDataJson, template.name);
  } catch (err) {
    logger.error({ err, templateId: template.id }, 'pdfme generation failed while editing a form');
    throw new AppError(500, 'ERR-PDF-GENERATION', 'Failed to generate form PDF');
  }

  const versionId = crypto.randomUUID();
  const storageKey = user.tenantId + '/' + department.code + '/FORM/' + document.id + '/' + versionId + '/form.pdf';
  const plaintextSha = crypto.createHash('sha256').update(pdf).digest('hex');
  const { encryptedKey, sha256Hash: encHash, kekId } = await encryptAndStore(storageKey, pdf, 'application/pdf', department.id, user.tenantId);
  const attachments = await prepareAttachmentUploads({
    fileFieldNames, hiddenFileFieldNames, files, parentDocumentId: document.id, department, user,
  });

  let versionNumber = '1.1';
  const updated = await runInTransaction(async (tx) => {
    // Re-checked under the row lock: a concurrent submit must not be edited underneath.
    const locked = await Document.findByPk(document.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!locked || locked.deletedAt) throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
    assertEditableStatus(locked.status);
    await reserveStorageQuota(user.tenantId, pdf.length + attachments.reduce((sum, a) => sum + a.file.size, 0), tx);

    const latest = locked.latestVersionId ? await DocumentVersion.findByPk(locked.latestVersionId, { transaction: tx }) : null;
    versionNumber = nextMinorVersion(latest?.versionNumber);
    await DocumentVersion.create(
      {
        id: versionId,
        documentId: document.id,
        versionNumber,
        isMajorVersion: false,
        storageKey,
        storageBucket: config.MINIO_BUCKET_DOCUMENTS,
        fileSize: BigInt(pdf.length),
        mimeType: 'application/pdf',
        originalFilename: locked.documentName.replace(/[^\w.-]+/g, '_') + '.pdf',
        sha256Hash: encHash,
        plaintextSha256: plaintextSha,
        extractedText: null,
        authorId: user.userId,
        changeSummary: 'Form edited by its filer before approval',
      } as any,
      { transaction: tx },
    );
    await Document.update({ latestVersionId: versionId }, { where: { id: document.id }, transaction: tx });
    await DocumentDek.create({ documentId: document.id, versionId, encryptedDek: encryptedKey, kekId, algorithm: 'AES-256-GCM' }, { transaction: tx });
    await OutboxEvent.bulkCreate(
      [{ documentId: document.id, type: 'SEARCH_INDEX', channel: 'SEARCH_INDEX', payload: JSON.stringify({ documentId: document.id, tenantId: user.tenantId }) }],
      { transaction: tx },
    );

    const fileRefs = await createAttachmentDocuments(attachments, { tenantId: user.tenantId, department, docTypeId: locked.documentTypeId, user }, tx);
    const knownFieldNames = new Set(allFields.map((f) => f?.name).filter(Boolean));
    const nextData: Record<string, unknown> = Object.fromEntries(
      Object.entries(effectiveDataJson).filter(([key]) => knownFieldNames.has(key) && !fileFieldNames.has(key)),
    );
    for (const name of fileFieldNames) {
      if (hiddenFileFieldNames.has(name)) continue;
      const ref = fileRefs[name] ?? existingAttachments[name];
      if (ref) nextData[name] = ref;
    }
    await instance.update({ dataJson: nextData, generatedPdfObjectKey: storageKey, updatedAt: new Date() }, { transaction: tx });
    return { nextData };
  });

  const changedFields = Object.keys({ ...previousData, ...updated.nextData }).filter(
    (k) => JSON.stringify(previousData[k]) !== JSON.stringify(updated.nextData[k]),
  );
  await writeAuditLog({
    eventType: AUDIT_EVENTS.FORM_INSTANCE_EDITED,
    documentId: document.id,
    userId: user.userId,
    userRole: user.role,
    actionDetails: {
      action: 'form_instance_edited', instanceId: instance.id, formInstanceId: instance.id, templateId: template.id,
      templateVersion: template.version, documentVersion: versionNumber, previousStatus: document.status,
      changedFields, newAttachments: attachments.map((a) => a.documentId), tenantId: user.tenantId,
    },
  });
  for (const att of attachments) {
    if (att.avScanStatus === 'unscanned') {
      await writeAuditLog({
        eventType: AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
        userId: user.userId,
        userRole: user.role,
        documentId: att.documentId,
        actionDetails: { versionId: att.versionId, reason: 'clamav scan did not complete; upload allowed through (fail-open)' },
      });
    }
  }
  return instance;
}

/** Recall a form from review so its filer can edit and resubmit it (IN_REVIEW -> DRAFT, chain cancelled, approvers told). */
export async function withdrawFormInstance(id: string, reason: string | undefined, user: AuthenticatedUser): Promise<FormInstance> {
  const { instance } = await loadFilerInstance(id, user);
  const { withdrawOwnSubmission } = await import('../approvals/withdraw.service.js');
  await withdrawOwnSubmission('FORM_INSTANCE', id, reason, user);
  return instance;
}

/** Abandon a pre-approval form: running chain withdrawn if needed, the document becomes CANCELLED (terminal). */
export async function cancelFormInstance(id: string, reason: string | undefined, user: AuthenticatedUser): Promise<FormInstance> {
  const { instance, document } = await loadFilerInstance(id, user);
  if (document.status === 'IN_REVIEW') {
    const { withdrawOwnSubmission } = await import('../approvals/withdraw.service.js');
    await withdrawOwnSubmission('FORM_INSTANCE', id, reason, user);
  } else {
    assertEditableStatus(document.status);
  }
  const cleanReason = reason?.trim() ? reason.trim().slice(0, 2000) : null;
  const previousStatus = document.status;
  await runInTransaction(async (tx) => {
    const locked = await Document.findByPk(document.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!locked || locked.deletedAt) throw new AppError(404, 'ERR-NOT-FOUND', 'Form instance not found');
    assertEditableStatus(locked.status);
    validateTransition(locked.status, 'CANCELLED');
    await locked.update({ status: 'CANCELLED' }, { transaction: tx });
    // A suspended (CHANGES_REQUESTED) chain would otherwise stay "live" for a document that can never resume.
    await ApprovalChain.update(
      { status: 'CANCELLED', completedAt: new Date() },
      { where: { tenantId: user.tenantId, itemType: 'FORM_INSTANCE', itemId: id, status: 'CHANGES_REQUESTED' }, transaction: tx },
    );
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.FORM_INSTANCE_CANCELLED,
    documentId: document.id,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { action: 'form_instance_cancelled', instanceId: instance.id, formInstanceId: instance.id, previousStatus, reason: cleanReason, tenantId: user.tenantId },
  });
  return instance;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Mirrors the field shape authored by the frontend builder
// (frontend/app/dashboard/forms/schema.ts) — schemaJson is untyped JSONB on
// the model, so this is a defensive re-declaration, not a shared import.
interface FormFieldSchema {
  name: string;
  type: string;
  required?: boolean;
  title?: string;
  position: { x: number; y: number };
  width: number;
  // Mirrors schema.ts's FieldSchema.height — 10 for normal fields, 18 for
  // textarea. Optional here because templates saved before this field was
  // added to the interface won't have it; toPdfmeSchema falls back to a
  // sensible default (10/18 by type) if it's absent.
  height?: number;
  // See schema.ts's FieldSchema.labelWidth — the row-allocated width, which
  // for a checkbox differs from `width` (the small drawn control box). Falls
  // back to `width` for pre-existing templates saved before this field
  // existed (where it already equals the allocated width for every
  // non-checkbox type, so the fallback is exact, not approximate).
  labelWidth?: number;
  section?: string;
  // See schema.ts's FieldSchema.sectionLabel — carried per-field so
  // toPdfmeSchema can draw a section heading without a second lookup.
  sectionLabel?: string;
  options?: string[];
  conditionalOn?: { field: string; operator: 'equals' | 'notEquals' | 'contains'; value: string };
  validation?: { minLength?: number; maxLength?: number; pattern?: string; min?: number; max?: number };
  // See schema.ts's FieldComputed — a field whose value is derived from
  // other fields rather than typed by the submitter (e.g. "No of days" from
  // two date fields). Mirrored type, not imported: the frontend module isn't
  // reachable from the backend build.
  computed?: { type: 'dateDiffDays'; fromField: string; toField: string; inclusive?: boolean };
}

function isFieldConditionMet(field: FormFieldSchema, values: Record<string, unknown>): boolean {
  if (!field.conditionalOn) return true;
  const actual = String(values[field.conditionalOn.field] ?? '');
  switch (field.conditionalOn.operator) {
    case 'equals': return actual === field.conditionalOn.value;
    case 'notEquals': return actual !== field.conditionalOn.value;
    case 'contains': return actual.includes(field.conditionalOn.value);
    default: return true;
  }
}

/** Mirrors schema.ts's computeFieldValue — kept in sync with that file. A
 *  computed field's derived value, or null if it isn't computed / its
 *  inputs aren't filled in / its inputs don't parse as dates (left null
 *  rather than '0' so a `required` field correctly reports "missing", not a
 *  bogus zero-day result). */
function computeFieldValue(field: FormFieldSchema, values: Record<string, unknown>): string | null {
  if (!field.computed) return null;
  if (field.computed.type === 'dateDiffDays') {
    const from = values[field.computed.fromField];
    const to = values[field.computed.toField];
    if (!from || !to) return null;
    const fromDate = new Date(String(from));
    const toDate = new Date(String(to));
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return null;
    const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + (field.computed.inclusive ? 1 : 0);
    return String(days);
  }
  return null;
}

/**
 * Overwrites every computed field's entry in `dataJson` with its own
 * server-derived value, ignoring whatever the client submitted for it — the
 * whole point of a computed field is that its value is NEVER trusted from
 * the client (that was the original bug this closes: "No of days" was a
 * plain number a submitter could type -8 into). Called before validation in
 * createFormInstance so `required`/`min` checks below run against the real
 * computed value, not client input.
 */
function applyComputedFields(fields: FormFieldSchema[], dataJson: Record<string, unknown>): Record<string, unknown> {
  const next = { ...dataJson };
  for (const field of fields) {
    if (!field.computed) continue;
    const computed = computeFieldValue(field, next);
    if (computed !== null) next[field.name] = computed;
    else delete next[field.name]; // inputs missing — let the required-check report it as missing, not stale
  }
  return next;
}

/**
 * FIX (found live 2026-08-28 while verifying an unrelated feature, via a
 * template with a conditional field): a field hidden by its `conditionalOn`
 * still had its VALUE printed onto the generated PDF — just without its
 * caption label — whenever the submitter had typed something into it before
 * the condition changed to hide it. Root cause: buildZodSchemaFromTemplate's
 * zod shape skips a condition-unmet field entirely (so it's never
 * validated), but `.passthrough()` lets whatever stray value the client
 * still had in dataJson for that field ride straight through into
 * parsed.data untouched — and toPdfmeSchema's `if (!drawLabels ||
 * !conditionMet) return [value]` only ever drops the LABEL for a hidden
 * field, never the value box itself, which pdfme still renders from
 * printableDataJson by field name. A real data leak, not just a cosmetic
 * bug: whatever the submitter typed before hiding it (potentially
 * sensitive) got baked into the official filed document, invisibly.
 * Deletes a hidden field's entry outright rather than blanking it to '' so
 * a later `required` check (were the field ever un-hidden) still correctly
 * reports it as missing rather than a stale non-empty value passing by
 * accident. Must run AFTER applyComputedFields, not before — a computed
 * field that is ALSO conditionally hidden must end up stripped either way,
 * and running this first would let the computed step immediately refill it.
 */
function stripHiddenFieldValues(fields: FormFieldSchema[], dataJson: Record<string, unknown>): Record<string, unknown> {
  const next = { ...dataJson };
  for (const field of fields) {
    if (!field.conditionalOn) continue;
    if (!isFieldConditionMet(field, next)) delete next[field.name];
  }
  return next;
}

function fieldZodType(field: FormFieldSchema): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case 'checkbox':
      base = z.union([z.literal('true'), z.literal('false')]);
      break;
    case 'email':
      base = z.string().email('Invalid email address');
      break;
    case 'number': {
      let num = z.coerce.number();
      if (field.validation?.min !== undefined) num = num.min(field.validation.min);
      if (field.validation?.max !== undefined) num = num.max(field.validation.max);
      base = num;
      break;
    }
    case 'select':
    case 'radio':
      base = field.options?.length ? z.enum(field.options as [string, ...string[]]) : z.string();
      break;
    default: {
      let str = z.string();
      if (field.validation?.minLength !== undefined) str = str.min(field.validation.minLength);
      if (field.validation?.maxLength !== undefined) str = str.max(field.validation.maxLength);
      base = str;
      if (field.validation?.pattern) {
        // The rule runs only against values up to PATTERN_INPUT_CAP long, so even a
        // template saved before validateTemplateSchemaJson existed (or a pattern the
        // heuristic there missed) cannot be fed a megabyte of backtracking input. A
        // pattern that does not even compile (legacy rows) is skipped, not a 500.
        let re: RegExp | null = null;
        try {
          re = new RegExp(field.validation.pattern);
        } catch {
          logger.warn({ field: field.name }, '[forms] ignoring an invalid validation pattern on a saved template');
        }
        if (re) {
          const pattern = re;
          base = str.superRefine((value, ctx) => {
            if (value.length > PATTERN_INPUT_CAP) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must be at most ${PATTERN_INPUT_CAP} characters` });
            } else if (!pattern.test(value)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Does not match required format' });
            }
          });
        }
      }
    }
  }
  return field.required ? base : z.union([base, z.literal(''), z.undefined()]);
}

/**
 * Builds a zod schema from a template's schemaJson (pdfme pages of fields),
 * skipping fields whose conditionalOn is unmet for the submitted values —
 * mirrors the frontend's evaluateVisibility so hidden fields aren't required.
 * Server-side re-validation; the fill form enforces the same rules client-side.
 */
export function buildZodSchemaFromTemplate(schemaJson: unknown, dataJson: Record<string, unknown>): z.ZodTypeAny {
  const pages = (schemaJson as FormFieldSchema[][]) ?? [];
  const fields = pages.flat();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (!field?.name || !isFieldConditionMet(field, dataJson)) continue;
    shape[field.name] = fieldZodType(field);
  }
  return z.object(shape).passthrough();
}

// Every field's VALUE renders as pdfme's `text` type, regardless of its
// real `type` (checkbox/date/number/textarea/select/radio/email/file) —
// registering per-type plugins for checkbox/date/etc. would require
// matching each plugin's exact runtime `content` encoding (e.g. checkbox's
// own true/false content contract, date's format string) — fragile to
// depend on for what is ultimately a filed/printed record. Rendering every
// value as formatted text (see toPrintableFormData) is simpler and correct
// here. The field's real `type` is preserved as-is in schemaJson for the
// builder/fill-form/validation, which read the field's own `type`, not
// this PDF-only view. (`rectangle` — a decorative, content-less plugin —
// IS additionally registered, purely to draw the value box; that's a
// static outline, not a per-type value renderer, so it doesn't conflict
// with the reasoning above.)
//
// `required` is dropped to false for any field whose `conditionalOn` is
// unmet for `values` — mirrors buildZodSchemaFromTemplate's isFieldConditionMet
// skip, so a required-but-hidden field's empty printable content doesn't
// make pdfme's generate() throw (it rejects a `required: true` schema with
// falsy content). Without this, any template with a required conditional
// field whose condition is unmet fails PDF generation every time.
// A field's own schema entry only ever carries its VALUE — pdfme has no
// separate "label" concept, so printing just the values (as originally
// implemented) leaves the generated PDF an unreadable wall of bare text with
// no indication what each value means. Each field gets a second, readOnly
// sibling entry directly above it whose `content` is the field's title, so
// pdfme draws it as a static caption rather than looking up `inputs` (see
// @pdfme/generator: `if (!schema.readOnly) return input?.[schema.name]...`,
// otherwise it falls through to the schema's own fixed `content`). The
// builder's row/section gaps (schema.ts ROW_GAP_Y=6 / SECTION_GAP_Y=10) were
// already sized to leave this much headroom above every field, so no
// frontend layout change is needed to make room for it. Skipped entirely
// when a base file is set (drawLabels=false) — a pre-printed letterhead scan
// already has its own printed labels; drawing synthetic ones on top of it
// would just double them up.
const LABEL_HEIGHT = 4;
const LABEL_GAP = 0.6;
const LABEL_FONT_SIZE = 7;
const LABEL_FONT_COLOR = '#666666';
// A field's value previously printed as bare floating text with nothing
// marking where the answer starts/ends — every real form (paper or scanned)
// draws a box or a ruled line under each blank, and without one the
// generated PDF reads as an undifferentiated wall of text rather than a
// filled-in form. Drawn as a plain, unfilled `rectangle` schema entry sized
// to exactly match the value's own position/width/height, placed just
// before the value in the schema array so the value text renders on top of
// it. `@pdfme/schemas` ships `rectangle` as a separate plugin from `text`
// (confirmed: `Object.keys(require('@pdfme/schemas'))` includes both) —
// registering it alongside `text` in generateFormPdf's plugins map is all
// that's needed; it needs no `content`, unlike the value/label text entries.
const VALUE_BOX_BORDER_WIDTH = 0.3;
const VALUE_BOX_BORDER_COLOR = '#999999';
// Page content area — mirrors schema.ts's PAGE_CONTENT_X/PAGE_CONTENT_WIDTH
// (A4, 20-unit margins each side), needed here only for the section
// heading's full-width span below.
const PAGE_CONTENT_X = 20;
const PAGE_CONTENT_WIDTH = 170;
// Mirrors schema.ts's Y_MAX_LETTERHEAD/Y_MAX_BLANK — the lowest a field may
// sit before it collides with the letterhead's footer artwork / the bottom
// page margin. Used only as a safety check before shifting page-1 content
// down to make room for the document title (see buildTitleSchema below):
// on the rare template whose page 1 is already packed right up to this
// limit, the shift is skipped rather than risk pushing a field past it.
const Y_MAX_LETTERHEAD = 253;
const Y_MAX_BLANK = 277;

// Document title (e.g. "Leave Form") drawn once at the top of page 1 only —
// every generated/downloaded form PDF previously gave no on-page indication
// of what kind of form it was, just the raw field sections (e.g. "Employee
// Details") starting immediately below the letterhead. `templateName` is the
// form template's own display name (FormTemplate.name), the same string
// already used elsewhere as the filed Document's name.
const TITLE_HEIGHT = 7;
const TITLE_GAP = 3;
const TITLE_RESERVE = TITLE_HEIGHT + TITLE_GAP; // page-1 content shifts down by this much
const TITLE_FONT_SIZE = 13;
const TITLE_FONT_COLOR = '#1f2937';
const TITLE_DYNAMIC_FONT_SIZE = { min: 8, max: TITLE_FONT_SIZE, fit: 'horizontal' as const };
// Measured the same way as schema.ts's Y_START_LETTERHEAD/Y_START_BLANK
// (see that file's comment) — clearance below the letterhead header artwork
// (ends at 60mm) / the plain top margin (20mm) respectively.
const TITLE_Y_LETTERHEAD = 63;
const TITLE_Y_BLANK = 22;

function buildTitleSchema(name: string, hasLetterhead: boolean) {
  return {
    name: '__form_title',
    type: 'text',
    content: name,
    position: { x: PAGE_CONTENT_X, y: hasLetterhead ? TITLE_Y_LETTERHEAD : TITLE_Y_BLANK },
    width: PAGE_CONTENT_WIDTH,
    height: TITLE_HEIGHT,
    dynamicFontSize: TITLE_DYNAMIC_FONT_SIZE,
    readOnly: true,
    fontSize: TITLE_FONT_SIZE,
    fontColor: TITLE_FONT_COLOR,
    alignment: 'center' as const,
    ...(hasNonLatin1Char(name) ? { fontName: ETHIOPIC_FONT_NAME } : {}),
  };
}

// Row height in the frontend's layoutRows()/toSchema() (schema.ts) is a
// fixed 10 units (18 for textarea) regardless of how much text actually
// lands in a box — a half/third/quarter-width field with a long label or a
// long submitted value would otherwise wrap onto a second line and collide
// with the row placed just ROW_GAP_Y (6 units) below it. Shrinking the font
// to fit one line (pdfme's own dynamicFontSize 'horizontal' fit) is a
// one-line, layout-preserving fix for exactly that case; a textarea's box is
// already tall and meant to hold wrapped multi-line text, so it keeps its
// authored font size and normal wrapping instead.
const VALUE_DYNAMIC_FONT_SIZE = { min: 6, max: 10, fit: 'horizontal' as const };
const LABEL_DYNAMIC_FONT_SIZE = { min: 5, max: LABEL_FONT_SIZE, fit: 'horizontal' as const };

// Section heading — drawn above a section's first row, in the headroom
// schema.ts's toSchema() reserves there (HEADING_HEIGHT/HEADING_GAP, kept in
// sync with those constants). The builder tells authors "renaming a section
// here renames its heading" — before this, the PDF never drew one at all.
const HEADING_HEIGHT = 5;
const HEADING_GAP = 1.5;
const HEADING_FONT_SIZE = 9;
const HEADING_FONT_COLOR = '#1f2937';
const HEADING_DYNAMIC_FONT_SIZE = { min: 6, max: HEADING_FONT_SIZE, fit: 'horizontal' as const };

function toPdfmeSchema(
  schemaJson: unknown,
  values: Record<string, unknown>,
  drawLabels: boolean,
  printableData: Record<string, string>,
): Template['schemas'] {
  const pages = (schemaJson as FormFieldSchema[][]) ?? [[]];
  return pages.map((page) => {
    let lastSection: string | undefined;
    return page.flatMap((field) => {
      const conditionMet = isFieldConditionMet(field, values);
      // The VALUE font is picked from the actual submitted content, not the
      // field's static schema — createFormInstance/previewFormTemplatePdf
      // both build a fresh schema per call with that submission's real
      // values already known, so this correctly follows whatever the
      // submitter actually typed (Latin, Amharic, or mixed) rather than
      // guessing from the field definition alone.
      const valueText = printableData[field.name] ?? '';
      // Defensive height: pdfme's schema validation rejects undefined height
      // with a ZodError. The frontend's toSchema() always sets it, but
      // templates saved before height was persisted (or malformed payloads)
      // would crash generateFormPdf without this fallback.
      const fieldHeight = field.height ?? (field.type === 'textarea' ? 18 : 10);
      const value = {
        ...field,
        type: 'text',
        height: fieldHeight,
        required: !!field.required && conditionMet,
        ...(field.type !== 'textarea' ? { dynamicFontSize: VALUE_DYNAMIC_FONT_SIZE } : {}),
        ...(hasNonLatin1Char(valueText) ? { fontName: ETHIOPIC_FONT_NAME } : {}),
      };
      // A conditional field hidden by its condition prints a blank value box
      // (by design, so the on-page layout doesn't shift) — but it must not
      // also print a caption above a permanently blank line for a question
      // the submitter was never asked.
      if (!drawLabels || !conditionMet) return [value];

      const heading =
        field.section && field.section !== lastSection && field.sectionLabel
          ? {
              name: `${field.section}__heading`,
              type: 'text',
              content: field.sectionLabel,
              position: { x: field.position.x, y: field.position.y - LABEL_HEIGHT - LABEL_GAP - HEADING_HEIGHT - HEADING_GAP },
              width: PAGE_CONTENT_WIDTH,
              height: HEADING_HEIGHT,
              dynamicFontSize: HEADING_DYNAMIC_FONT_SIZE,
              readOnly: true,
              fontSize: HEADING_FONT_SIZE,
              fontColor: HEADING_FONT_COLOR,
              ...(hasNonLatin1Char(field.sectionLabel) ? { fontName: ETHIOPIC_FONT_NAME } : {}),
            }
          : null;
      lastSection = field.section;

      const labelText = field.title || field.name;
      const label = {
        name: `${field.name}__label`,
        type: 'text',
        content: labelText,
        position: { x: field.position.x, y: field.position.y - LABEL_HEIGHT - LABEL_GAP },
        width: field.labelWidth ?? field.width,
        height: LABEL_HEIGHT,
        dynamicFontSize: LABEL_DYNAMIC_FONT_SIZE,
        readOnly: true,
        fontSize: LABEL_FONT_SIZE,
        fontColor: LABEL_FONT_COLOR,
        ...(hasNonLatin1Char(labelText) ? { fontName: ETHIOPIC_FONT_NAME } : {}),
      };
      const box = {
        name: `${field.name}__box`,
        type: 'rectangle',
        position: { x: field.position.x, y: field.position.y },
        width: field.width,
        height: fieldHeight,
        borderWidth: VALUE_BOX_BORDER_WIDTH,
        borderColor: VALUE_BOX_BORDER_COLOR,
        color: '',
        readOnly: true,
      };
      return heading ? [heading, label, box, value] : [label, box, value];
    });
  }) as Template['schemas'];
}

/** Converts a form submission's (validated or sample) field values into the
 *  plain strings pdfme's `text` plugin requires as `content` (see
 *  toPdfmeSchema above) — checkbox 'true'/'false' -> 'Yes'/'No', numbers ->
 *  their decimal string, file fields -> an "(attached: <filename>)" marker
 *  (the real file is filed as its own Document, not printed as text),
 *  everything else passed through as a string. Missing/empty values become
 *  '' — pdfme's own required-field check (`generate()` throws if a
 *  `required` schema has no truthy input) is satisfied upstream by the zod
 *  validation in createFormInstance, or by previewFormTemplatePdf always
 *  supplying a sample value. */
export function toPrintableFormData(
  fields: FormFieldSchema[],
  data: Record<string, unknown>,
  files?: Record<string, { originalname: string }>,
): Record<string, string> {
  const printable: Record<string, string> = {};
  for (const field of fields) {
    if (!field?.name) continue;
    if (field.type === 'file') {
      printable[field.name] = files?.[field.name] ? `(attached: ${files[field.name].originalname})` : '';
      continue;
    }
    const value = data[field.name];
    if (value === undefined || value === null || value === '') {
      printable[field.name] = '';
    } else if (field.type === 'checkbox') {
      printable[field.name] = value === 'true' || value === true ? 'Yes' : 'No';
    } else {
      printable[field.name] = String(value);
    }
  }
  return printable;
}

/** Sample value for a field used only by previewFormTemplatePdf — realistic
 *  enough to show layout/formatting, never real submitted data. */
function sampleValueForField(field: FormFieldSchema): unknown {
  switch (field.type) {
    case 'checkbox':
      return 'true';
    case 'date':
      return '01/01/2026';
    case 'number':
      return 42;
    case 'select':
    case 'radio':
      return field.options?.[0] ?? 'Sample option';
    case 'email':
      return 'sample@example.com';
    case 'textarea':
      return 'Sample long-form text shown here to preview wrapping and spacing.';
    default:
      return field.title ? `Sample ${field.title}` : 'Sample text';
  }
}

/** The single place that actually calls @pdfme/generator's generate() —
 *  used by both createFormInstance (real submitted data) and
 *  previewFormTemplatePdf (sample data), so the preview is guaranteed to be
 *  the same rendering pipeline as the real generated PDF, not a
 *  reimplementation of it. `plugins: { text, rectangle }` is passed
 *  explicitly rather than relying on generate()'s implicit `builtInPlugins`
 *  fallback (which only bundles `text`), so this doesn't silently break
 *  again if that default's shape changes upstream — `rectangle` draws each
 *  field's value box (see toPdfmeSchema's `box` entry). */
async function generateFormPdf(
  schemaJson: unknown,
  basePdfObjectKey: string | null | undefined,
  isLetterhead: boolean | null | undefined,
  values: Record<string, unknown>,
  printableDataJson: Record<string, string>,
  templateName?: string | null,
): Promise<Buffer> {
  // A pre-printed scan (isLetterhead=false) already has its own field
  // captions on the page — synthetic labels would double them up. A
  // branding-only letterhead (isLetterhead=true) has NO field captions at
  // all — the whole point of it is a header/footer banner around blank
  // content — so it needs labels drawn exactly like a blank page does.
  const drawLabels = !basePdfObjectKey || Boolean(isLetterhead);
  const pageCount = Math.max(1, ((schemaJson as unknown[][]) ?? [[]]).length);
  const schemas = toPdfmeSchema(schemaJson, values, drawLabels, printableDataJson);
  // Document title (e.g. "Leave Form") on page 1 only — same condition as
  // the synthetic labels above: a pre-printed scan already has its own
  // title printed on the page, so drawing one here would double it up.
  // Page-1 content shifts down by TITLE_RESERVE to make room; skipped (title
  // omitted, layout left untouched) on the rare template whose page 1 is
  // already packed right up to the footer/bottom-margin limit, rather than
  // risk pushing a field past it.
  if (drawLabels && templateName && schemas.length > 0) {
    const hasLH = Boolean(isLetterhead);
    const yMax = hasLH ? Y_MAX_LETTERHEAD : Y_MAX_BLANK;
    const firstPage = schemas[0] as Array<{ position: { x: number; y: number }; height?: number }>;
    const maxShiftedBottom = firstPage.reduce(
      (max, entry) => Math.max(max, entry.position.y + TITLE_RESERVE + (entry.height ?? 0)),
      0,
    );
    if (maxShiftedBottom <= yMax) {
      const shiftedFirstPage = firstPage.map((entry) => ({
        ...entry,
        position: { ...entry.position, y: entry.position.y + TITLE_RESERVE },
      }));
      schemas[0] = [buildTitleSchema(templateName, hasLH), ...shiftedFirstPage] as typeof schemas[number];
    } else {
      logger.warn({ templateName, maxShiftedBottom, yMax }, 'skipping form title — page 1 already full');
    }
  }
  const pdfmeTemplate: Template = {
    basePdf: basePdfObjectKey
      ? await fetchBasePdf(basePdfObjectKey, isLetterhead ? pageCount : 1)
      : { width: 210, height: 297, padding: [20, 20, 20, 20] },
    schemas,
  };
  const pdfBuffer = await generate({
    template: pdfmeTemplate,
    inputs: [printableDataJson],
    plugins: { text, rectangle },
    options: { font: buildPdfmeFontMap() },
  });
  return Buffer.from(pdfBuffer);
}

/** Stateless preview render for the template builder — same generate() call
 *  as createFormInstance, but with placeholder sample values instead of
 *  real submitted data, and no DB writes/encryption/audit log (throwaway
 *  render, not a filed instance). Works for an in-progress, not-yet-saved
 *  template since it takes schemaJson/basePdfObjectKey directly rather than
 *  a template id. */
export async function previewFormTemplatePdf(input: {
  schemaJson: unknown;
  basePdfObjectKey?: string | null;
  isLetterhead?: boolean | null;
  name?: string | null;
}): Promise<Buffer> {
  const fields = ((input.schemaJson as FormFieldSchema[][]) ?? []).flat();
  const sampleFiles: Record<string, { originalname: string }> = {};
  const sampleData: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field?.name) continue;
    if (field.type === 'file') {
      sampleFiles[field.name] = { originalname: 'sample-file.pdf' };
    } else {
      sampleData[field.name] = sampleValueForField(field);
    }
  }
  // Sample dates are identical placeholders ('01/01/2026') for every date
  // field, so a computed field previews as 0 rather than a realistic
  // duration — correct (not the generic 42 a plain number field gets), just
  // a known cosmetic limit of the preview; real submissions use whatever
  // distinct dates the submitter actually picks.
  //
  // sampleData above fills EVERY field unconditionally, including ones a
  // conditionalOn would hide given the OTHER sample values — without
  // stripHiddenFieldValues here, the builder's own live preview would show
  // exactly the tofu-box leak stripHiddenFieldValues's comment describes,
  // for any template with a conditional field, every time it's edited.
  const effectiveSampleData = stripHiddenFieldValues(fields, applyComputedFields(fields, sampleData));
  const printableDataJson = toPrintableFormData(fields, effectiveSampleData, sampleFiles);

  try {
    return await generateFormPdf(
      input.schemaJson,
      input.basePdfObjectKey,
      input.isLetterhead,
      effectiveSampleData,
      printableDataJson,
      input.name?.trim() || 'Untitled Form',
    );
  } catch (err) {
    logger.error({ err }, 'pdfme preview generation failed');
    throw new AppError(500, 'ERR-PDF-GENERATION', 'Failed to generate template preview');
  }
}

/** `neededPageCount` > 1 only for a letterhead base file (isLetterhead) —
 *  pdfme renders exactly one output page per BASE PDF page (getEmbedPdfPages
 *  in @pdfme/generator), not one per schemas entry, so a single-page
 *  letterhead handed straight to a multi-page filled form would silently
 *  truncate every page after the first. Repeats the base file's own last
 *  page (index min(i, pageCount-1)) to pad it out — for our one-page
 *  letterhead that's simply the same page N times; a genuinely multi-page
 *  base file keeps its own pages and only repeats the last one for any
 *  extra pages needed. A non-letterhead pre-printed scan always passes
 *  neededPageCount=1, so it's untouched by this and keeps its exact bytes. */
async function fetchBasePdf(objectKey: string, neededPageCount = 1): Promise<string> {
  const storage = getStorageAdapter();
  const buf = await storage.get(objectKey);
  if (neededPageCount <= 1) return buf.toString('base64');
  const source = await PDFDocument.load(buf);
  if (source.getPageCount() >= neededPageCount) return buf.toString('base64');
  const out = await PDFDocument.create();
  for (let i = 0; i < neededPageCount; i++) {
    const sourceIndex = Math.min(i, source.getPageCount() - 1);
    const [copied] = await out.copyPages(source, [sourceIndex]);
    out.addPage(copied);
  }
  const bytes = await out.save();
  return Buffer.from(bytes).toString('base64');
}
