// CAMS letters API.
//
// Protected routes are mounted at /letters. The QR verification endpoint is
// mounted on the PUBLIC router (`lettersPublicRoutes`) â€” anyone scanning a
// printed letter's QR code must be able to verify it without an account.

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { idempotent } from '../../shared/idempotency.middleware.js';
import { requirePermission, requireAnyPermission } from '../../shared/auth.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { createRedisRateLimitStore } from '../../infrastructure/cache/rateLimitStore.js';
import { bufferedUploadMiddleware } from '../../shared/uploadMiddleware.js';
import {
  acknowledgeDispatch,
  addLetterAttachment,
  archiveLetter,
  assignLetter,
  canReadAnyLetter,
  cancelLetter,
  recallLetter,
  createLetter,
  createScannedOutgoingLetter,
  decideStep,
  downloadLetterAttachment,
  downloadLetterCoverSheet,
  downloadLetterPdf,
  getLetter,
  getLetterByDocumentId,
  getLetterRevisionBody,
  getLetterThread,
  linkLetters,
  listLetterAssignableUsers,
  listLetters,
  previewLetterPdf,
  reassignStep,
  recordDispatch,
  registerIncomingLetter,
  removeLetterAttachment,
  resolveIncomingLetter,
  submitLetter,
  initiateLetterSigning,
  unlinkLetters,
  updateLetter,
  verifyLetter,
} from './letters.service.js';
import { downloadLetterBodyImage, uploadLetterBodyImage } from './letterBodyImages.service.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Every upload.single(...) call below used to run with no MulterError
// handling at all -- a too-large scan/attachment fell straight through to
// the generic 500 handler instead of a clear 413. See shared/uploadMiddleware.ts.
function handleUpload(fieldName: string) {
  return bufferedUploadMiddleware(upload, fieldName, {
    fileTooLargeMessage: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit for this endpoint.`,
  });
}

export const lettersRoutes = Router();
export const lettersPublicRoutes = Router();

const listQuerySchema = z.object({
  direction: z.enum(['OUTGOING', 'INCOMING']).optional(),
  status: z.string().max(20).optional(),
  orgUnitId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  year: z.coerce.number().int().optional(),
  letterType: z.string().max(10).optional(),
  q: z.string().max(200).optional(),
  overdue: z.coerce.boolean().optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(50),
});

// â”€â”€ Public: QR verification (6.1.5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /letters/verify?ref=REF/HQ/FIN/OUT/2026/00147&hash=<sha256>
// Unauthenticated and mounted before the per-user limiter, so it carries its
// own IP rate limit â€” verification writes audit rows and must not be floodable.
// Raised 30 -> 120/min (2026-09-23, alongside the other prod rate limiters):
// this is IP-keyed with no tenant/user to bucket by, so anyone verifying
// letters from behind a shared corporate NAT (a reception desk scanning many
// incoming letters through the day) shares one bucket -- still low enough to
// stop an automated scraping flood, generous enough for real, heavy manual use.
const verifyRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  store: createRedisRateLimitStore('letters-verify'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'ERR-RATE-LIMIT', message: 'Too many verification requests' } },
});

lettersPublicRoutes.get(
  '/letters/verify',
  verifyRateLimiter,
  asyncHandler(async (req, res) => {
    const ref = String(req.query.ref ?? '');
    const hash = String(req.query.hash ?? '');
    if (!ref || !/^[0-9a-f]{64}$/i.test(hash)) {
      res.status(422).json({ error: { code: 'ERR-VERIFY-PARAMS', message: 'ref and hash query params are required' } });
      return;
    }
    const result = await verifyLetter(ref, hash);
    res.json({ data: result });
  }),
);

// â”€â”€ Protected â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

lettersRoutes.get(
  '/',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const result = await listLetters(query, req.user!);
    res.json(result);
  }),
);

lettersRoutes.post(
  '/',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await createLetter(req.body, req.user!);
    res.status(201).json({ data: letter });
  }),
);

// Incoming registration (6.2) â€” optional `scan` file (PDF, Word, or image)
lettersRoutes.post(
  '/register',
  requirePermission(PERMISSIONS.LETTER_REGISTER),
  handleUpload('scan'),
  asyncHandler(async (req, res) => {
    const letter = await registerIncomingLetter(req.body, req.file, req.user!);
    res.status(201).json({ data: letter });
  }),
);

// Outgoing letter filed as a scan of a signed paper original (not composed
// in-system) - required `scan` file (PDF, Word, or image). Goes through the
// same DRAFT -> IN_REVIEW -> APPROVED chain as a composed letter; the scan
// is only promoted to the letter's final document at approval.
lettersRoutes.post(
  '/scanned',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  handleUpload('scan'),
  asyncHandler(async (req, res) => {
    const letter = await createScannedOutgoingLetter(req.body, req.file, req.user!);
    res.status(201).json({ data: letter });
  }),
);

// Stateless preview render for the compose page (letters/new) — same
// generateLetterSignableDraft() pipeline the real signable draft uses, with
// whatever has been typed so far, no DB writes. Mirrors POST
// /forms/templates/preview. Registered here (a literal segment, not `/:id`)
// so it can't collide with the GET /:id route below.
lettersRoutes.post(
  '/preview-pdf',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const { pdf, blockPages } = await previewLetterPdf(req.body, req.user!);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="letter-preview.pdf"');
    // Per-top-level-block starting page (see drawLetterBodyDoc's onBlockPage)
    // so the compose page can jump the live preview to wherever the caret
    // is, exactly rather than by a rough scroll-position guess. Exposed via
    // app.ts's cors() exposedHeaders — a plain header is otherwise invisible
    // to a cross-origin fetch.
    res.setHeader('X-Letter-Block-Pages', JSON.stringify(blockPages));
    res.send(pdf);
  }),
);

// Reverse lookup for the Documents module's own detail page: is this
// document actually a filed letter (final PDF, an attachment, or a cover
// sheet), and if so, its full approval chain — letters never appear in the
// unified approval engine's chain, so that page can't find this any other
// way. `{ data: null }` (not a 404) when the document isn't letter-backed.
lettersRoutes.get(
  '/by-document/:documentId',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const letter = await getLetterByDocumentId(String(req.params.documentId), req.user!);
    res.json({ data: letter });
  }),
);

// Candidate named-person assignees for the submit-chain modal (approver/
// reviewer step, and the "who signs this letter" picker) — reachable by
// anyone who could actually submit or act on a letter, not just USER_MANAGE/
// DEPT_MANAGE/ACL_BYPASS_ADMIN holders (the gap GET /users has for an
// ordinary drafter). Registered BEFORE /:id so the literal
// "assignable-users" segment isn't swallowed as an id param.
lettersRoutes.get(
  '/assignable-users',
  requireAnyPermission(PERMISSIONS.LETTER_CREATE, PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE),
  asyncHandler(async (req, res) => {
    const raw = String(req.query.stepType ?? 'APPROVE');
    const stepType = raw === 'REVIEW' ? 'REVIEW' : raw === 'SIGNATORY' ? 'SIGNATORY' : 'APPROVE';
    const data = await listLetterAssignableUsers(req.user!, stepType);
    res.json({ data });
  }),
);

// Images inserted into the Body editor — uploaded independently of any
// specific letter (letters/new has no letter id yet), so these are their
// own top-level resource, not nested under /:id. Registered BEFORE /:id for
// the same reason as /assignable-users above.
lettersRoutes.post(
  '/body-images',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  handleUpload('file'),
  asyncHandler(async (req, res) => {
    const result = await uploadLetterBodyImage(req.file, req.user!);
    res.status(201).json({ data: result });
  }),
);

lettersRoutes.get(
  '/body-images/:imageId',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const { buffer, mimeType } = await downloadLetterBodyImage(String(req.params.imageId), req.user!, canReadAnyLetter);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.send(buffer);
  }),
);

lettersRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const letter = await getLetter(String(req.params.id), req.user!);
    res.json({ data: letter });
  }),
);

// Full bodyHtml for one revision, fetched on demand (getLetter()'s revision
// list omits bodyHtml â€” see letters.service.ts's getLetterRevisionBody).
lettersRoutes.get(
  '/:id/revisions/:revisionNo',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const revisionNo = Number(req.params.revisionNo);
    if (!Number.isInteger(revisionNo) || revisionNo < 1) {
      res.status(422).json({ error: { code: 'ERR-REVISION-INVALID', message: 'revisionNo must be a positive integer' } });
      return;
    }
    const revision = await getLetterRevisionBody(String(req.params.id), revisionNo, req.user!);
    res.json({ data: revision });
  }),
);

lettersRoutes.patch(
  '/:id',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await updateLetter(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Supplementary attachments (compose-with-attachments, like an email) — any
// number of files alongside a composed body or a SCANNED letter's original.
lettersRoutes.post(
  '/:id/attachments',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  handleUpload('file'),
  asyncHandler(async (req, res) => {
    const letter = await addLetterAttachment(String(req.params.id), req.file, req.user!);
    res.status(201).json({ data: letter });
  }),
);

lettersRoutes.get(
  '/:id/attachments/:attachmentId',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const { buffer, filename, mimeType } = await downloadLetterAttachment(
      String(req.params.id), String(req.params.attachmentId), req.user!,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

lettersRoutes.delete(
  '/:id/attachments/:attachmentId',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await removeLetterAttachment(String(req.params.id), String(req.params.attachmentId), req.user!);
    res.json({ data: letter });
  }),
);

lettersRoutes.post(
  '/:id/submit',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await submitLetter(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Initiate signing — the separate second action. Submitting for approval picks
// APPROVERS; this picks the SIGNATORY, and only once approval is complete.
// LETTER_CREATE because the drafter is the normal initiator; the service also
// admits a LETTER_APPROVE holder and enforces every state precondition under
// the letter's row lock.
lettersRoutes.post(
  '/:id/initiate-signing',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  // A dropped response after the ceremony was created would otherwise look
  // like an "already finalized" 409 on retry, same as decideStep below.
  idempotent('letters.initiateSigning'),
  asyncHandler(async (req, res) => {
    const letter = await initiateLetterSigning(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

lettersRoutes.post(
  '/:id/steps/:stepId/decision',
  requireAnyPermission(PERMISSIONS.LETTER_REVIEW, PERMISSIONS.LETTER_APPROVE),
  // A dropped response after a successful decision otherwise looks like a
  // "step not pending" 409 to the caller on retry — see idempotency.middleware.ts.
  idempotent('letters.decideStep'),
  asyncHandler(async (req, res) => {
    // Per-step permission (REVIEW vs APPROVE) is enforced in the service.
    const letter = await decideStep(String(req.params.id), String(req.params.stepId), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Admin recovery: reassign a stuck PENDING step to a different user/role
// (deactivated assignee, unstaffed role — see letters.service.ts's
// reassignStep doc comment). Elevated permission is enforced in the service,
// same as the decision endpoint above.
lettersRoutes.post(
  '/:id/steps/:stepId/reassign',
  // Department heads and administrators reassign; the person a step waits on may delegate it (service decides which).
  requireAnyPermission(PERMISSIONS.DEPT_MANAGE, PERMISSIONS.ACL_BYPASS_ADMIN, PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const letter = await reassignStep(String(req.params.id), String(req.params.stepId), req.body, req.user!);
    res.json({ data: letter });
  }),
);

lettersRoutes.get(
  '/:id/pdf',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    // Not always literally a PDF any more: SCANNED-origin letters serve
    // whatever was actually uploaded (Word/image/PDF), same endpoint.
    const { buffer, filename, mimeType } = await downloadLetterPdf(String(req.params.id), req.user!);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

lettersRoutes.get(
  '/:id/cover-sheet',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const { buffer, filename, mimeType } = await downloadLetterCoverSheet(String(req.params.id), req.user!);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

lettersRoutes.post(
  '/:id/dispatches',
  requirePermission(PERMISSIONS.LETTER_DISPATCH),
  asyncHandler(async (req, res) => {
    const dispatch = await recordDispatch(String(req.params.id), req.body, req.user!);
    res.status(201).json({ data: dispatch });
  }),
);

lettersRoutes.post(
  '/:id/dispatches/:dispatchId/acknowledge',
  requirePermission(PERMISSIONS.LETTER_DISPATCH),
  asyncHandler(async (req, res) => {
    const dispatch = await acknowledgeDispatch(
      String(req.params.id),
      String(req.params.dispatchId),
      typeof req.body?.note === 'string' ? req.body.note : undefined,
      req.user!,
    );
    res.json({ data: dispatch });
  }),
);

// Cancel: DRAFT/RETURNED (owner-only, no reason) and, as an admin recovery
// override, IN_REVIEW (department:manage/admin bypass + mandatory reason —
// enforced in the service, same as the reassignment endpoint above).
lettersRoutes.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await cancelLetter(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Drafter pulls a letter back out of review to edit it (IN_REVIEW -> RETURNED); service enforces owner + reason.
lettersRoutes.post(
  '/:id/recall',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const letter = await recallLetter(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Routing / assignment of incoming letters (6.2)
lettersRoutes.post(
  '/:id/assign',
  requirePermission(PERMISSIONS.LETTER_REGISTER),
  asyncHandler(async (req, res) => {
    const letter = await assignLetter(String(req.params.id), req.body, req.user!);
    res.json({ data: letter });
  }),
);

// Mark an incoming letter responded / closed (due-date tracking, 6.2)
lettersRoutes.post(
  '/:id/resolve',
  requirePermission(PERMISSIONS.LETTER_REGISTER),
  asyncHandler(async (req, res) => {
    const target = req.body?.status === 'CLOSED' ? 'CLOSED' : 'RESPONDED';
    const letter = await resolveIncomingLetter(String(req.params.id), target, req.user!);
    res.json({ data: letter });
  }),
);

// Cross-reference index (6.3)
lettersRoutes.get(
  '/:id/links',
  requirePermission(PERMISSIONS.LETTER_READ),
  asyncHandler(async (req, res) => {
    const thread = await getLetterThread(String(req.params.id), req.user!);
    res.json({ data: thread });
  }),
);

// L9: creating/removing cross-reference links MUTATES the correspondence
// record, but both routes were gated behind letter:read — the same permission
// that only allows viewing. A read-only user (e.g. an AUDITOR doing oversight) could
// silently rewrite the cross-reference index. Mutations require letter:create.
lettersRoutes.post(
  '/:id/links',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    const link = await linkLetters(String(req.params.id), req.body, req.user!);
    res.status(201).json({ data: link });
  }),
);

lettersRoutes.delete(
  '/:id/links/:linkId',
  requirePermission(PERMISSIONS.LETTER_CREATE),
  asyncHandler(async (req, res) => {
    await unlinkLetters(String(req.params.id), String(req.params.linkId), req.user!);
    res.status(204).end();
  }),
);

// Archive (6.3)
lettersRoutes.post(
  '/:id/archive',
  requirePermission(PERMISSIONS.LETTER_DISPATCH),
  asyncHandler(async (req, res) => {
    const letter = await archiveLetter(String(req.params.id), req.user!);
    res.json({ data: letter });
  }),
);
