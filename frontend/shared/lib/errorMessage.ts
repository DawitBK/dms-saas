// shared/lib/errorMessage.ts
//
// One place to turn a caught error into display text, replacing the ~4
// byte-identical `parseApiError` copies (crudPanels.tsx, OrgUnitsPanel.tsx,
// UsersManagementPanel.tsx, WorkflowDefinitionsPanel.tsx) and the ~8 ad hoc
// inline variants (`(err as Error)?.message ?? '...'`, `err?.message || '...'`)
// scattered across app/ and features/ — none of which knew about ApiError's
// `code`/`details`/`isNetworkError`, because apiClient.ts used to discard all
// three before any of this code ran.
import { ApiError } from './apiClient';
import { licenseWording } from './license';

/** Turn any caught value into a message worth showing a user. Never returns
 *  a bare "Request failed"-style non-answer when the backend sent a real
 *  reason — that fallback only fires for a value that genuinely isn't an
 *  Error at all (a thrown string/object, which nothing in this app throws
 *  deliberately). */
export function getErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  // The three licence refusals (read-only, module not licensed, user limit) get one plain wording everywhere.
  const licence = err instanceof ApiError ? licenseWording(err.code) : undefined;
  if (licence) return licence.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** The backend's error code (e.g. `ERR-DEPT-CODE-EXISTS`), when the failure
 *  came from the API — undefined for a network failure, a render exception,
 *  or anything else that isn't an ApiError. Useful for a handful of `case`
 *  branches (e.g. redirecting on ERR-SESSION-EXPIRED) without re-parsing
 *  the message string. */
export function getErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

/** True when the request never reached the server (offline, DNS, connection
 *  refused, CORS, timeout) — worth phrasing differently from "the server
 *  rejected this," since a retry is far more likely to help. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.isNetworkError;
}

/** A short reference string worth showing alongside a genuine server-fault
 *  (500-class) message, so a user reporting a bug has something to quote and
 *  an operator has something to grep the logs for. Absent for expected 4xx
 *  failures (validation, not-found, conflict) — only backend.ts's true
 *  catch-all attaches a requestId, deliberately, so this doesn't show up on
 *  routine "that code already exists" messages. */
export function getErrorReference(err: unknown): string | undefined {
  return err instanceof ApiError ? err.requestId : undefined;
}

/** Per-field validation messages from a 400 ERR-VALIDATION response (Zod's
 *  `error.flatten().fieldErrors`, attached by the backend's central error
 *  handler under `details`). Returns the first message for `field`, or
 *  undefined if this error didn't fail validation on that field — pass this
 *  straight to a form field's error slot instead of only showing one
 *  top-level banner/toast for the whole form regardless of which input was
 *  actually invalid. */
export function getFieldError(err: unknown, field: string): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return err.details?.fieldErrors?.[field]?.[0];
}
