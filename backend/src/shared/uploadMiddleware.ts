import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { preserveRequestContext } from "./requestContext.js";

// Every MulterError code multer can throw, mapped to a message that names
// what actually went wrong rather than letting it fall through to the
// generic 500 handler (multer's error class isn't an AppError/ZodError, so
// nothing central recognized it before this). LIMIT_FILE_SIZE is the one
// callers care most about tailoring per-endpoint (pointing at a resumable
// upload alternative, say), via `fileTooLargeMessage` below.
const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "This file is too large for this endpoint.",
  LIMIT_FILE_COUNT: "Too many files were included in this upload.",
  LIMIT_UNEXPECTED_FILE: "An unexpected file field was included in this upload.",
  LIMIT_FIELD_COUNT: "Too many form fields were included in this upload.",
  LIMIT_FIELD_KEY: "A form field name in this upload is too long.",
  LIMIT_FIELD_VALUE: "A form field value in this upload is too long.",
  LIMIT_FIELD_SIZE: "A form field value in this upload is too long.",
  LIMIT_PART_COUNT: "This upload has too many parts.",
};

type MulterMiddleware = (req: Request, res: Response, callback: (err: unknown) => void) => void;

/**
 * Shared by bufferedUploadMiddleware (.single()) and
 * bufferedAnyUploadMiddleware (.any()) below — the MulterError-to-envelope
 * mapping and the preserveRequestContext wrap are identical either way; only
 * how the multer middleware itself is constructed differs.
 *
 * preserveRequestContext: multer reads the request stream itself, so for any
 * body over the 64 KB socket read boundary it invokes its callback from a
 * socket event OUTSIDE the request's AsyncLocalStorage frame. Without
 * re-entering it, everything downstream (including tenantContext, which
 * registers the tenant-scoped transaction) runs with no ambient store and
 * every query escapes `SET LOCAL app.current_tenant` — under RLS that reads
 * back zero rows with no error. See shared/requestContext.ts.
 */
function wrapMulterMiddleware(
  middleware: MulterMiddleware,
  options?: { fileTooLargeMessage?: string; fileTooLargeCode?: string },
) {
  return preserveRequestContext((req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const isTooLarge = err.code === "LIMIT_FILE_SIZE";
        const message = isTooLarge && options?.fileTooLargeMessage
          ? options.fileTooLargeMessage
          : (MULTER_ERROR_MESSAGES[err.code] ?? "This upload could not be processed.");
        const code = isTooLarge && options?.fileTooLargeCode ? options.fileTooLargeCode : `ERR-UPLOAD-${err.code}`;
        res.status(isTooLarge ? 413 : 400).json({ error: { code, message } });
        return;
      }
      next(err);
    });
  });
}

/**
 * Wraps `multer(...).single(fieldName)` so every MulterError comes back as
 * this app's one `{error:{code,message}}` envelope with a status code that
 * fits the failure (413 for oversized, 400 for anything else), instead of
 * falling through to errorHandler's generic 500 catch-all. Reuse this
 * instead of re-copying the try/catch by hand per route module — this is the
 * fourth time the same pattern was needed (documents, esigning, and the
 * forms/letters gaps it was extracted to close).
 */
export function bufferedUploadMiddleware(
  upload: ReturnType<typeof multer>,
  fieldName: string,
  options?: { fileTooLargeMessage?: string; fileTooLargeCode?: string },
) {
  return wrapMulterMiddleware(upload.single(fieldName), options);
}

/**
 * `.any()` counterpart of bufferedUploadMiddleware, for routes that accept a
 * variable/dynamic set of file fields (form-instance submissions, one per
 * "file"-type form field) rather than one fixed field name.
 *
 * FIX 2026-09-15: forms.routes.ts's POST /instances used a bare
 * `upload.any()` with none of this — the ONLY multer call site in the
 * backend not wrapped in preserveRequestContext. Same silent RLS-escape bug
 * as the one this file's own doc comment above already describes for a body
 * spanning more than one socket read (routine for a scanned attachment) —
 * reproduced live via the same reasoning as the original 2026-09-09
 * incident, just via multer's `.any()` entry point instead of `.single()`.
 */
export function bufferedAnyUploadMiddleware(
  upload: ReturnType<typeof multer>,
  options?: { fileTooLargeMessage?: string; fileTooLargeCode?: string },
) {
  return wrapMulterMiddleware(upload.any(), options);
}
