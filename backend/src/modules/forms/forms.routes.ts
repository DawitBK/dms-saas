import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { AppError } from '../../core/AppError.js';
import { bufferedUploadMiddleware, bufferedAnyUploadMiddleware } from '../../shared/uploadMiddleware.js';
import {
  createFormTemplate,
  listFormTemplates,
  listFormTemplateCategories,
  getFormTemplate,
  updateFormTemplateStatus,
  updateFormTemplateContent,
  createFormTemplateVersion,
  createFormInstance,
  getFormInstanceApprovalPrefill,
  getFormInstance,
  updateFormInstance,
  withdrawFormInstance,
  cancelFormInstance,
  listFormInstances,
  uploadFormBasePdf,
  previewFormTemplatePdf,
  getExampleCorpLetterheadObjectKey,
  assertOwnBasePdfKey,
  validateTemplateSchemaJson,
} from './forms.service.js';
import { extractFormFieldsFromImage } from './formAiExtract.js';

const upload = multer({
  storage: multer.memoryStorage(),
  // `files`: POST /instances uses .any(), which buffers EVERY part in memory —
  // including ones that belong to no form field — so the count has to be bounded
  // as well as each file's size.
  limits: { fileSize: 100 * 1024 * 1024, files: 25 },
});

// AI form extraction rejects anything over 15MB (formAiExtract.ts's
// MAX_INPUT_BYTES) AFTER it has been read into memory; accepting 100MB here
// just to refuse it was a memory cost for no benefit. Same limit, enforced at
// the multer boundary.
const AI_EXTRACT_MAX_BYTES = 15 * 1024 * 1024;
const extractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AI_EXTRACT_MAX_BYTES, files: 1 },
});

export const formsRoutes = Router();

// ── Templates ────────────────────────────────────────────────────────────────

formsRoutes.get('/templates', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const status = req.query.status as string | undefined;
  const skip = req.query.skip ? Number(req.query.skip) : 0;
  const take = req.query.take ? Number(req.query.take) : 25;
  const result = await listFormTemplates(req.user!, status, skip, take);
  res.json(result);
}));

formsRoutes.post('/templates/base-pdf', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), bufferedUploadMiddleware(upload, 'file', {
  fileTooLargeMessage: `File exceeds the ${(100 * 1024 * 1024) / (1024 * 1024)}MB limit for a form template's base PDF.`,
}), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(422, 'ERR-FILE-MISSING', 'A PDF file is required');
  const objectKey = await uploadFormBasePdf(req.file, req.user!);
  res.status(201).json({ data: { objectKey } });
}));

// AI-assisted authoring: upload a photo or PDF of what the form should look
// like, get back a proposed field list to load into the (still fully
// editable) builder canvas — see formAiExtract.ts's own comment for why this
// is a proposal the admin reviews, never an auto-saved template. Gated the
// same as every other template-authoring action (FORM_TEMPLATE_MANAGE); the
// service layer additionally enforces the tenant's ai_processing consent
// flag, same gate every other AI feature in this app already requires.
formsRoutes.post('/templates/extract-from-image', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), requirePermission(PERMISSIONS.AI_USE), bufferedUploadMiddleware(extractUpload, 'file', {
  fileTooLargeMessage: `File exceeds the ${AI_EXTRACT_MAX_BYTES / (1024 * 1024)}MB limit.`,
}), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError(422, 'ERR-FILE-MISSING', 'A photo or PDF of the form is required');
  const result = await extractFormFieldsFromImage(req.file, req.user!);
  res.json({ data: result });
}));

// The template builder's "Use Example Corp Letterhead" quick-pick —
// resolves to a well-known object key, uploading the repo-tracked asset into
// this tenant's storage on first use.
formsRoutes.get('/templates/letterhead', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const objectKey = await getExampleCorpLetterheadObjectKey(req.user!.tenantId);
  res.json({ data: { objectKey } });
}));

// Distinct category values already in use in this tenant, for the builder's
// category field to suggest (a `<datalist>`, not a hard enum — see
// listFormTemplateCategories's own comment for why a free-text field with no
// suggestions was the forms-module analog of the fixed DocumentType
// retention-class bug). Must be declared before GET /templates/:id or Express
// would try to resolve "categories" as a template id.
formsRoutes.get('/templates/categories', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const categories = await listFormTemplateCategories(req.user!.tenantId);
  res.json({ data: categories });
}));

// Stateless preview render — same generate() pipeline as a real form
// instance, but with sample data and no DB writes/encryption/audit log.
// Takes schemaJson/basePdfObjectKey directly in the body (not a template id)
// so the builder can preview a template that hasn't been saved yet.
formsRoutes.post('/templates/preview', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const { schemaJson, basePdfObjectKey, isLetterhead, name } = req.body as { schemaJson?: unknown; basePdfObjectKey?: string | null; isLetterhead?: boolean; name?: string };
  if (!schemaJson) throw new AppError(422, 'ERR-FORM-VALIDATION', 'schemaJson is required to render a preview');
  // Same checks a save applies: the base-file key is read straight from storage
  // and returned rendered, so it must be one of this tenant's own template files.
  validateTemplateSchemaJson(schemaJson);
  assertOwnBasePdfKey(basePdfObjectKey, req.user!.tenantId);
  const pdf = await previewFormTemplatePdf({ schemaJson, basePdfObjectKey, isLetterhead, name });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
  res.send(pdf);
}));

formsRoutes.post('/templates', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const { name, category, basePdfObjectKey, isLetterhead, schemaJson, sectionsJson, layoutMode, instanceApproval, auditPolicy, signingPolicy, departmentId, orgUnitId } = req.body;
  const template = await createFormTemplate({ name, category, basePdfObjectKey, isLetterhead, schemaJson, sectionsJson, layoutMode, instanceApproval, auditPolicy, signingPolicy, departmentId, orgUnitId }, req.user!);
  res.status(201).json({ data: template });
}));

formsRoutes.get('/templates/:id', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const template = await getFormTemplate(String(req.params.id), req.user!);
  res.json({ data: template });
}));

// Lifecycle transitions: draft → pending_approval → active → deprecated
formsRoutes.patch('/templates/:id/status', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const { status } = req.body as { status: 'draft' | 'pending_approval' | 'active' | 'deprecated' };
  const template = await updateFormTemplateStatus(String(req.params.id), status, req.user!);
  res.json({ data: template });
}));

// Content edits — draft templates only; published ones use POST /versions instead.
formsRoutes.patch('/templates/:id/content', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const { name, category, basePdfObjectKey, isLetterhead, schemaJson, sectionsJson, instanceApproval, auditPolicy, signingPolicy, departmentId, orgUnitId } = req.body;
  const template = await updateFormTemplateContent(
    String(req.params.id),
    { name, category, basePdfObjectKey, isLetterhead, schemaJson, sectionsJson, instanceApproval, auditPolicy, signingPolicy, departmentId, orgUnitId },
    req.user!,
  );
  res.json({ data: template });
}));

// Clone a published template into a fresh draft revision (version + 1).
formsRoutes.post('/templates/:id/versions', requirePermission(PERMISSIONS.FORM_TEMPLATE_MANAGE), asyncHandler(async (req, res) => {
  const revision = await createFormTemplateVersion(String(req.params.id), req.user!);
  res.status(201).json({ data: revision });
}));

// ── Instances ────────────────────────────────────────────────────────────────

formsRoutes.get('/instances', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const { createdBy, templateId, status } = req.query as { createdBy?: string; templateId?: string; status?: string };
  const skip = req.query.skip ? Number(req.query.skip) : 0;
  const take = req.query.take ? Number(req.query.take) : 25;
  const result = await listFormInstances(req.user!, { createdBy, templateId, status }, skip, take);
  res.json(result);
}));

/** The approval chain a filled instance of this template would get.
 *
 *  Read-only, and gated on the same permission as filling the form
 *  (DOCUMENT_UPLOAD) rather than a workflow permission: the person choosing
 *  approvers here is the submitter, who by definition does not hold
 *  APPROVAL_DECIDE. `departmentId` is optional and only scopes role-holder
 *  resolution — the fill modal re-fetches with it once a department is
 *  chosen, so the "no one holds this role" warning matches who can actually
 *  act on the item. */
formsRoutes.get('/templates/:id/approval-prefill', requirePermission(PERMISSIONS.DOCUMENT_UPLOAD), asyncHandler(async (req, res) => {
  const departmentId = typeof req.query.departmentId === 'string' && req.query.departmentId ? req.query.departmentId : undefined;
  res.json(await getFormInstanceApprovalPrefill(String(req.params.id), req.user!, departmentId));
}));

function parseDataJson(body: { dataJson?: string }): Record<string, unknown> {
  try {
    const parsedData: unknown = JSON.parse(body.dataJson ?? '{}');
    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) throw new Error('not an object');
    return parsedData as Record<string, unknown>;
  } catch {
    throw new AppError(422, 'ERR-FORM-VALIDATION', 'dataJson must be a JSON object');
  }
}

formsRoutes.post('/instances', requirePermission(PERMISSIONS.DOCUMENT_UPLOAD), bufferedAnyUploadMiddleware(upload), asyncHandler(async (req, res) => {
  const { templateId, departmentId } = req.body as { templateId: string; departmentId?: string };
  const dataJson = parseDataJson(req.body as { dataJson?: string });
  // Multipart, so the chain arrives as a JSON string alongside dataJson.
  // Absent -> undefined, which keeps the previous template/default behaviour.
  const rawSteps = (req.body as { approvalSteps?: string }).approvalSteps;
  let approvalSteps: unknown;
  if (rawSteps) {
    try {
      approvalSteps = JSON.parse(rawSteps);
    } catch {
      throw new AppError(422, 'ERR-FORM-APPROVAL-INVALID', 'approvalSteps must be valid JSON');
    }
  }
  const files: Record<string, Express.Multer.File> = {};
  for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) files[f.fieldname] = f;
  const { instance, approvalWarning } = await createFormInstance(
    templateId,
    dataJson,
    req.user!,
    departmentId,
    files,
    approvalSteps,
    // Multipart: 'true' saves the form as a DRAFT (chain-approval templates) instead of submitting it.
    { saveAsDraft: (req.body as { saveAsDraft?: string }).saveAsDraft === 'true' },
  );
  res.status(201).json({ data: instance, ...(approvalWarning ? { approvalWarning } : {}) });
}));

formsRoutes.get('/instances/:id', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const instance = await getFormInstance(String(req.params.id), req.user!);
  res.json({ data: instance });
}));

// The filer's own pre-approval lifecycle (forms.service.ts, audit E7). Filer only; the service re-checks everything.
// Edit: same multipart shape as filing (dataJson + file fields). Allowed while DRAFT / CHANGES_REQUESTED / DECLINED.
formsRoutes.patch('/instances/:id', requirePermission(PERMISSIONS.DOCUMENT_UPLOAD), bufferedAnyUploadMiddleware(upload), asyncHandler(async (req, res) => {
  const dataJson = parseDataJson(req.body as { dataJson?: string });
  const files: Record<string, Express.Multer.File> = {};
  for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) files[f.fieldname] = f;
  const instance = await updateFormInstance(String(req.params.id), dataJson, req.user!, files);
  res.json({ data: instance });
}));

// Recall from review (IN_REVIEW -> DRAFT) so it can be edited and resubmitted.
formsRoutes.post('/instances/:id/withdraw', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  res.json({ data: await withdrawFormInstance(String(req.params.id), reason, req.user!) });
}));

// Abandon a pre-approval form (document becomes CANCELLED).
formsRoutes.post('/instances/:id/cancel', requirePermission(PERMISSIONS.DOCUMENT_READ), asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  res.json({ data: await cancelFormInstance(String(req.params.id), reason, req.user!) });
}));
