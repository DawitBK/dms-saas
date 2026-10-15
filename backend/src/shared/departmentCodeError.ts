// Self-diagnosing ERR-DEPT-INVALID.
//
// WHY THIS EXISTS. On 2026-09-08 a SYSTEM_ADMIN hit five consecutive 422s
// uploading to production and the only thing anyone could say afterwards was
// that the rejection was "Department code is not registered". The message
// named no code, the logs carried no code (multipart bodies are not logged),
// and the response was indistinguishable in the access log from the other
// 422s on that route except by its byte length. Reconstructing what had
// actually been submitted took a full forensic pass over the request log and
// the database, and it still ended inconclusive: the submitted string could
// not be recovered from any evidence the server had kept. The user worked
// around it by creating a new department.
//
// Every one of those dead ends was avoidable by printing the value that was
// rejected. That is all this module does.
//
// Two audiences, deliberately given different amounts of detail:
//
//   - The CALLER gets the code back in the message, so the person at the
//     screen can see that they sent "IT " or "it" or "I.T" and fix it
//     themselves. They supplied the value, so echoing it discloses nothing.
//   - The LOG additionally gets the tenant's real department codes, so an
//     operator reading it after the fact can see the near-miss immediately
//     without opening psql. That list is NOT in the response: which
//     departments a tenant has is not something a failed request should
//     enumerate for its caller.
import { AppError } from "../core/AppError.js";
import { logger } from "../core/logger.js";
import { Department } from "../infrastructure/database/index.js";

// Two of the three call sites validate departmentCode with
// `z.string().min(2).max(10)` before it reaches here; the third
// (esigning.routes.ts POST /signing/uploads) reads it straight off req.body
// with no schema at all, so it can be any length, any bytes, or not a string.
// Sanitize unconditionally rather than relying on the caller: this value goes
// into a response body and a log line, and neither should be steerable by the
// client. Control characters are stripped (log-line injection), the result is
// truncated, and the truncation is made visible so a too-long code cannot be
// mistaken for a short one that merely looks wrong.
const MAX_ECHOED_LENGTH = 32;

export function sanitizeCodeForDisplay(raw: unknown): string {
  if (typeof raw !== "string") return "(not a string)";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  if (cleaned.length === 0) return "(empty)";
  return cleaned.length > MAX_ECHOED_LENGTH
    ? `${cleaned.slice(0, MAX_ECHOED_LENGTH)}… (truncated, ${cleaned.length} chars)`
    : cleaned;
}

/**
 * Build the 422 for a departmentCode that matched no row, logging what was
 * submitted alongside what the tenant actually has.
 *
 * Call this ONLY on the failure path — it issues an extra query to list the
 * tenant's codes, which is free in practice because a rejected upload is rare
 * and already terminal. If that query fails (it runs inside the caller's
 * request transaction, which is still open and healthy at this point) the
 * error is still returned; a diagnostic must never be able to convert a 422
 * into a 500.
 */
export async function departmentCodeNotRegistered(
  submitted: unknown,
  user: { userId: string; tenantId: string },
  context: { route: string; lookedUpAs?: string },
): Promise<AppError> {
  const display = sanitizeCodeForDisplay(submitted);

  let knownCodes: string[] | undefined;
  try {
    const rows = await Department.findAll({
      where: { tenantId: user.tenantId },
      attributes: ["code"],
      order: [["code", "ASC"]],
      limit: 50,
      raw: true,
    });
    knownCodes = (rows as unknown as Array<{ code: string }>).map((r) => r.code);
  } catch (error) {
    logger.warn({ error, tenantId: user.tenantId }, "ERR-DEPT-INVALID: could not list tenant departments for diagnostics");
  }

  logger.warn(
    {
      submittedDepartmentCode: display,
      lookedUpAs: context.lookedUpAs,
      tenantId: user.tenantId,
      userId: user.userId,
      route: context.route,
      tenantDepartmentCodes: knownCodes,
      tenantDepartmentCount: knownCodes?.length,
    },
    "ERR-DEPT-INVALID: rejected an upload because the submitted department code matched no department in this tenant",
  );

  return new AppError(
    422,
    "ERR-DEPT-INVALID",
    `Department code "${display}" is not registered in your organization`,
  );
}
