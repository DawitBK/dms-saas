import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { idempotent } from '../../shared/idempotency.middleware.js';
import { requirePermission } from '../../shared/auth.js';
import { requireACL } from '../../shared/resolveACL.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { bufferedUploadMiddleware } from '../../shared/uploadMiddleware.js';
import {
  createSignatureRequest,
  sendSignatureRequest,
  signDocument,
  declineSignature,
  getSignatureRequest,
  listSignatureRequestsForDocument,
  markRecipientViewed,
  fetchSigningDocumentBytes,
  listMySignatureTasks,
  listSentSignatureRequests,
  listCompletedSignatureRequests,
  remindSignatureRequest,
  cancelSignatureRequest,
  listSigningAssignableUsers,
  uploadAndFileDocumentForSigning,
  listAllSignatureRequests,
  getSignatureRequestAuditTrail,
  type RequestMeta,
} from './esigning.service.js';

export const esigningRoutes = Router();

// API-1: keep the public HTTP boundary deliberately narrow.  The signing
// service still owns business validation (recipient eligibility, document
// state and field ownership), while these schemas reject malformed data before
// it reaches persistence or an expensive document operation.
const uuidSchema = z.string().uuid();
// A drawn/typed/uploaded signature (SignaturePad.tsx) is submitted as a
// data:image/png;base64 string from a 480x160 canvas, not plain text — even
// a modest hand-drawn signature routinely base64-encodes past 10,000
// characters, so that cap rejected real signatures as a validation error
// (confirmed live 2026-09-19: a normal 3-stroke signature draw failed here).
// 500,000 chars (~375KB raw) comfortably covers the canvas's worst case
// (a dense scribble or an uploaded photo, both re-encoded to the same fixed
// 480x160 PNG footprint by SignaturePad before submission) while still
// bounding the field against an arbitrarily large payload.
const signatureFieldValueSchema = z.object({
  fieldId: uuidSchema,
  value: z.string().max(500_000),
});
const signingActionSchema = z.object({
  fieldValues: z.array(signatureFieldValueSchema).max(1_000).default([]),
});
const externalSigningActionSchema = signingActionSchema.extend({
  accessToken: z.string().min(1).max(512),
});
const cancelSchema = z.object({
  reason: z.string().trim().max(2_000).default(''),
});
const declineSchema = z.object({
  reason: z.string().trim().max(2_000).default(''),
});
const externalDeclineSchema = declineSchema.extend({
  accessToken: z.string().min(1).max(512),
});
const signingUploadMetadataSchema = z.object({
  departmentId: uuidSchema.optional(),
  departmentCode: z.string().trim().min(1).max(64).optional(),
  documentTypeCode: z.string().trim().min(1).max(64).optional(),
  folderPath: z.string().trim().min(1).max(2_000).optional(),
  title: z.string().trim().min(1).max(255).optional(),
});
const signatureRecipientSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  dmsUserId: uuidSchema.optional(),
  assignedRole: z.string().trim().min(1).max(128).optional(),
  orderIndex: z.number().int().min(0).max(10_000).optional(),
}).superRefine((recipient, ctx) => {
  if (recipient.dmsUserId && recipient.assignedRole) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A recipient cannot specify both dmsUserId and assignedRole' });
  }
  if (!recipient.dmsUserId && !recipient.assignedRole && (!recipient.name || !recipient.email)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An external recipient needs both a name and an email address' });
  }
}).transform((recipient) => ({
  // The service owns the role-recipient placeholders. These fallbacks only
  // satisfy its typed input for named internal recipients, whose identity is
  // ultimately authorized by dmsUserId rather than client-supplied display text.
  ...recipient,
  name: recipient.name ?? '',
  email: recipient.email ?? '',
}));
const createSignatureRequestSchema = z.object({
  source: z.enum(['freeform', 'form_instance']).optional(),
  orderingMode: z.enum(['parallel', 'serial']).optional(),
  completionAction: z.enum(['none', 'move_folder', 'notify_only']).optional(),
  completionTargetFolderId: uuidSchema.nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  recipients: z.array(signatureRecipientSchema).min(1).max(500),
  fields: z.array(z.object({
    recipientIndex: z.number().int().min(0).max(499),
    pageNumber: z.number().int().min(1).max(10_000),
    x: z.number().finite().min(0).max(100_000),
    y: z.number().finite().min(0).max(100_000),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    fieldType: z.enum(['signature', 'initial', 'date', 'text', 'seal']),
  })).max(5_000).default([]),
});

/** A header-safe Content-Disposition: the stored filename is user-supplied (it may hold quotes or
 *  non-ASCII), so quote an ASCII fallback and carry the real name as RFC 5987 filename*. */
function inlineDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The signer's IP as recorded on the signature audit record — legal evidence
 * of WHERE a signature was executed from, so it must not be assertable by the
 * signer.
 *
 * These four routes used to read `req.headers['x-forwarded-for']` straight
 * off the request, which is a raw client-supplied header: any signer (and, on
 * the /external variants, anyone holding the emailed access token) could put
 * an arbitrary address into their own non-repudiation record just by sending
 * the header. `req.ip` is the same value filtered through Express's
 * `trust proxy` setting (app.ts / TRUST_PROXY, default `loopback`), so the
 * header is honoured only when it came from the Apache hop and is ignored
 * when a client sends it directly.
 */
function signerIp(req: { ip?: string; socket?: { remoteAddress?: string | null } }): string {
  return req.ip ?? req.socket?.remoteAddress ?? '';
}

/** Address (same trust rule as signerIp) and browser of the caller, for the per-request audit trail. */
function requestMeta(req: { ip?: string; socket?: { remoteAddress?: string | null }; get(name: string): string | undefined }): RequestMeta {
  return { ip: signerIp(req) || undefined, userAgent: req.get('user-agent') || undefined };
}

// Buffered upload for the signing page's "upload a new document to sign"
// path — same in-memory multer + size ceiling as documents.routes.ts's main
// upload route (large files should go through the resumable tus endpoint and
// get filed via the regular Upload page instead).
const MAX_BUFFERED_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BUFFERED_UPLOAD_BYTES } });

function handleBufferedUpload(fieldName: string) {
  return bufferedUploadMiddleware(upload, fieldName, {
    fileTooLargeCode: 'ERR-FILE-TOO-LARGE',
    fileTooLargeMessage: `File exceeds the ${MAX_BUFFERED_UPLOAD_BYTES / (1024 * 1024)}MB limit for this endpoint. Use the main Upload page for larger files.`,
  });
}

// List all signature requests for a document. Platform audit finding 4.2:
// this route (and the POST below) had no ACL check, letting any
// SIGNING_READ/SIGNING_MANAGE holder read/create signature requests for a
// document their folder ACL would otherwise hide — fixed to match
// documents.routes.ts's document:read gate on every other document route.
esigningRoutes.get(
  '/documents/:documentId/signing',
  requirePermission(PERMISSIONS.SIGNING_READ),
  requireACL({ resourceType: 'document', permission: 'document:read', paramName: 'documentId' }),
  asyncHandler(async (req, res) => {
    const requests = await listSignatureRequestsForDocument(String(req.params.documentId), req.user!);
    res.json({ data: requests });
  }),
);

// Create a new signature request (freeform or form-linked)
esigningRoutes.post(
  '/documents/:documentId/signing',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  requireACL({ resourceType: 'document', permission: 'document:read', paramName: 'documentId' }),
  asyncHandler(async (req, res) => {
    const request = await createSignatureRequest(
      uuidSchema.parse(req.params.documentId),
      createSignatureRequestSchema.parse(req.body),
      req.user!,
      requestMeta(req),
    );
    res.status(201).json({ data: request });
  }),
);

// Cross-document queue views backing the E-Signing sidebar (registered
// BEFORE /signing/:requestId so the literal "requests" segment isn't
// swallowed as a requestId param).
esigningRoutes.get(
  '/signing/requests',
  requirePermission(PERMISSIONS.SIGNING_READ),
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope ?? 'pending-me');
    // Number('abc') is NaN, which reached the SQL OFFSET/LIMIT as a 500; clamp instead.
    const skip = Math.max(0, Math.trunc(Number(req.query.skip)) || 0);
    const take = Math.min(100, Math.max(1, Math.trunc(Number(req.query.take)) || 25));
    // `all`: the tenant-wide, read-only oversight list (document:read_all holders only; the
    // service refuses everyone else with 403).
    const result =
      scope === 'all' ? await listAllSignatureRequests(req.user!, {
        skip, take,
        status: req.query.status ? String(req.query.status) : undefined,
        q: req.query.q ? String(req.query.q).slice(0, 200) : undefined,
      })
      : scope === 'sent-by-me' ? await listSentSignatureRequests(req.user!, skip, take)
      : scope === 'completed' ? await listCompletedSignatureRequests(req.user!, skip, take)
      : await listMySignatureTasks(req.user!, skip, take);
    res.json(result);
  }),
);

// Searchable signer picker for the "new request" recipient chooser. Registered
// BEFORE /signing/:requestId so the literal "assignable-users" segment isn't
// swallowed as a requestId param. Gated by SIGNING_MANAGE (same as creating a
// request), not USER_MANAGE — see listSigningAssignableUsers for why.
esigningRoutes.get(
  '/signing/assignable-users',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const q = req.query.q ? String(req.query.q) : undefined;
    // Id-based, same convention as GET /users' roleId/departmentId params
    // (features/users/hooks.ts useUsersList) — department membership is the
    // User<->Department many-to-many join, role membership the UserRole rows.
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;
    const roleId = req.query.roleId ? String(req.query.roleId) : undefined;
    const users = await listSigningAssignableUsers(req.user!, q, undefined, { departmentId, roleId });
    res.json({ data: users });
  }),
);

// Direct upload-and-file for the signing page's "upload a new document to
// sign" tab — files the picked document (optional department/type/folder,
// falling back to the tenant's UNCAT/SIGN-UNCAT bucket) and hands back its
// id so the frontend can immediately continue into the existing
// createSignatureRequest flow. Registered BEFORE /signing/:requestId for the
// same "literal segment" reason as the two routes above.
esigningRoutes.post(
  '/signing/uploads',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  handleBufferedUpload('file'),
  asyncHandler(async (req, res) => {
    const { departmentId, departmentCode, documentTypeCode, folderPath, title } = signingUploadMetadataSchema.parse(req.body);
    const result = await uploadAndFileDocumentForSigning(
      req.file,
      { departmentId, departmentCode, documentTypeCode, folderPath, title },
      req.user!,
    );
    res.status(201).json({ data: result });
  }),
);

// Get a specific signature request with recipients + fields
esigningRoutes.get(
  '/signing/:requestId',
  requirePermission(PERMISSIONS.SIGNING_READ),
  asyncHandler(async (req, res) => {
    const request = await getSignatureRequest(String(req.params.requestId), req.user!);
    res.json({ data: request });
  }),
);

// Who did what to this request, when, from where (requester, administrator or oversight only).
esigningRoutes.get(
  '/signing/:requestId/audit',
  requirePermission(PERMISSIONS.SIGNING_READ),
  asyncHandler(async (req, res) => {
    const entries = await getSignatureRequestAuditTrail(uuidSchema.parse(req.params.requestId), req.user!);
    res.json({ data: entries });
  }),
);

// Send (transition draft → sent, triggers emails to recipients)
esigningRoutes.post(
  '/signing/:requestId/send',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const request = await sendSignatureRequest(String(req.params.requestId), req.user!, requestMeta(req));
    res.json({ data: request });
  }),
);

// Re-send the invite/notification to every not-yet-signed recipient.
esigningRoutes.post(
  '/signing/:requestId/remind',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const request = await remindSignatureRequest(String(req.params.requestId), req.user!, requestMeta(req));
    res.json({ data: request });
  }),
);

// The requester (or a SYSTEM_ADMIN) withdraws a draft / sent / partially-signed request.
esigningRoutes.post(
  '/signing/:requestId/cancel',
  requirePermission(PERMISSIONS.SIGNING_MANAGE),
  asyncHandler(async (req, res) => {
    const { reason } = cancelSchema.parse(req.body ?? {});
    const request = await cancelSignatureRequest(uuidSchema.parse(req.params.requestId), reason, req.user!, requestMeta(req));
    res.json({ data: request });
  }),
);

// Internal signer submits their signature. M12: gated by SIGNING_READ, not
// SIGNING_MANAGE — the assigned recipient (who may not manage signing) must be
// able to sign their own task. The service enforces that the caller IS the
// named recipient (user.userId === recipient.dmsUserId), which is the real
// authorization here.
esigningRoutes.post(
  '/signing/:requestId/recipients/:recipientId/sign',
  requirePermission(PERMISSIONS.SIGNING_READ),
  // A dropped response after a successful signature otherwise looks like a
  // generic error to the signer even though their signature was recorded —
  // see idempotency.middleware.ts. Internal (JWT-authenticated) route only;
  // the external accessToken-based /sign/external variant below has no
  // req.user to key a cache entry on.
  idempotent('esigning.signDocument'),
  asyncHandler(async (req, res) => {
    const { fieldValues } = signingActionSchema.parse(req.body);
    const ip = signerIp(req);
    const result = await signDocument(
      String(req.params.requestId),
      String(req.params.recipientId),
      fieldValues ?? [],
      ip,
      req.user!,
      undefined,
      requestMeta(req),
    );
    res.json({ data: { requestId: result.request.id, status: result.request.status, allSigned: result.allSigned } });
  }),
);

// Fetches the actual document bytes a recipient is being asked to sign — see
// fetchSigningDocumentBytes's own comment for why this couldn't just reuse
// GET /documents/:id/download (that route's generic ACL 403s exactly the
// recipients this route exists to serve). Gated the same way the sign
// endpoint above is: SIGNING_READ, then the service confirms the caller IS
// the named recipient.
esigningRoutes.get(
  '/signing/:requestId/recipients/:recipientId/document',
  requirePermission(PERMISSIONS.SIGNING_READ),
  asyncHandler(async (req, res) => {
    const { buffer, filename, mimeType } = await fetchSigningDocumentBytes(
      String(req.params.requestId),
      String(req.params.recipientId),
      { user: req.user! },
      requestMeta(req),
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', inlineDisposition(filename));
    res.send(buffer);
  }),
);

// Internal signer decline (JWT-authenticated DMS user). No extra permission
// gate: the service enforces that the caller IS the named recipient, so any
// authenticated recipient (regardless of role) can decline their own request.
esigningRoutes.post(
  '/signing/:requestId/recipients/:recipientId/decline',
  asyncHandler(async (req, res) => {
    const { reason } = declineSchema.parse(req.body);
    const ip = signerIp(req);
    await declineSignature(
      String(req.params.requestId),
      String(req.params.recipientId),
      reason ?? '',
      ip,
      req.user,
      undefined,
      requestMeta(req),
    );
    res.json({ success: true });
  }),
);

// ── Public router: external signers authenticated by access_token, NOT JWT ──
// Mounted OUTSIDE the `authenticate` chain (see api/v1/index.ts) so emailed
// external signers (who have no DMS account) can reach these endpoints.
export const esigningPublicRoutes = Router();

// External signer submits their signature (access_token in body)
esigningPublicRoutes.post(
  '/signing/:requestId/recipients/:recipientId/sign/external',
  asyncHandler(async (req, res) => {
    const { fieldValues, accessToken } = externalSigningActionSchema.parse(req.body);
    const ip = signerIp(req);
    const result = await signDocument(
      String(req.params.requestId),
      String(req.params.recipientId),
      fieldValues ?? [],
      ip,
      undefined,
      accessToken,
      requestMeta(req),
    );
    res.json({ data: { status: result.request.status, allSigned: result.allSigned } });
  }),
);

// External signer opens the signing link — marks the recipient 'viewed' the
// first time (never downgrades an already signed/declined recipient).
// access_token travels as a query param since this is a plain link-click GET,
// same convention as the public letters verify route.
esigningPublicRoutes.get(
  '/signing/:requestId/recipients/:recipientId/view',
  asyncHandler(async (req, res) => {
    const accessToken = String(req.query.token ?? '');
    const result = await markRecipientViewed(String(req.params.requestId), String(req.params.recipientId), accessToken, requestMeta(req));
    res.json({ data: result });
  }),
);

// External signer's document-bytes counterpart of the internal route above —
// same fetchSigningDocumentBytes, authorized by access token instead of a
// JWT/recipient match. This is the fix for the external emailed-link landing
// page (frontend/app/sign/[requestId]/[recipientId]) never having shown the
// actual document at all.
esigningPublicRoutes.get(
  '/signing/:requestId/recipients/:recipientId/document/external',
  asyncHandler(async (req, res) => {
    const accessToken = String(req.query.token ?? '');
    const { buffer, filename, mimeType } = await fetchSigningDocumentBytes(
      String(req.params.requestId),
      String(req.params.recipientId),
      { accessToken },
      requestMeta(req),
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', inlineDisposition(filename));
    res.send(buffer);
  }),
);

// External signer declines (access_token in body)
esigningPublicRoutes.post(
  '/signing/:requestId/recipients/:recipientId/decline/external',
  asyncHandler(async (req, res) => {
    const { reason, accessToken } = externalDeclineSchema.parse(req.body);
    const ip = signerIp(req);
    await declineSignature(
      String(req.params.requestId),
      String(req.params.recipientId),
      reason ?? '',
      ip,
      undefined,
      accessToken,
      requestMeta(req),
    );
    res.json({ success: true });
  }),
);
