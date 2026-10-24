import { Op } from "sequelize";
import { Notification, OutboxEvent, UserRole, Role, UserTenant, sequelize } from "../../infrastructure/database/index.js";
import { emitDomainEvent } from "../../infrastructure/websocket/socket.js";
import { enqueueWebsocketEvent } from "../../infrastructure/queue/outbox.js";
import { logger } from "../../core/logger.js";

export type NotificationType =
  | "LOCK_EXPIRY_WARNING"
  | "PURGE_APPROVAL_REQUIRED"
  | "AUDIT_INTEGRITY_FAILURE"
  | "VIRUS_DETECTED"
  | "DOCUMENT_SCAN_COMPLETED"
  | "STORAGE_QUOTA_WARNING"
  | "HSM_UNAVAILABLE"
  | "KEY_ROTATION_COMPLETE"
  // CAMS correspondence — mirrors the NotifType union the frontend
  // notifications page already renders icons/colors/deep-links for.
  | "LETTER_STEP_PENDING"
  | "LETTER_REGISTERED"
  | "LETTER_APPROVED"
  | "LETTER_RETURNED"
  | "LETTER_RECALLED"
  | "LETTER_SLA_BREACH"
  | "LETTER_STEP_ESCALATED"
  | "LETTER_CANCELLED"
  // A letter's e-signing ceremony completing (finalizeLetterAfterSigning)
  // never had a letter-aware notification of its own — only the generic
  // ESIGN_REQUEST_COMPLETED fired, in-app only, to whoever happened to
  // initiate signing rather than the drafter. Reported live as "letter was
  // signed but no email went out."
  | "LETTER_SIGNED"
  // Unified approval engine + audit stage (SYSTEM-DECISIONS.md D1–D7)
  | "APPROVAL_STEP_PENDING"
  | "APPROVAL_CHANGES_REQUESTED"
  | "APPROVAL_DECLINED"
  | "APPROVAL_COMPLETED"
  | "APPROVAL_CANCELLED"
  | "AUDIT_STAGE_ASSIGNED"
  | "AUDIT_STAGE_PASSED"
  | "AUDIT_STAGE_FLAGGED"
  | "APPROVAL_SLA_BREACH"
  | "APPROVAL_STEP_DELEGATED"
  | "APPROVAL_STEP_ESCALATED"
  | "APPROVAL_WITHDRAWN"
  // M8: offboarding sweep — pending work assigned to a now-deactivated user
  | "ASSIGNEE_DEACTIVATED"
  // L5: an outbox event permanently failed (DEAD_LETTER) — admins must know
  | "OUTBOX_DEAD_LETTER"
  // Observability follow-up: AIWorker silently no-op'd when a document had no
  // usable OCR text — "Summarize" queued forever with zero user-facing signal
  // of why. Surfaced the same way OUTBOX_DEAD_LETTER is, with a documentId so
  // it deep-links straight to the document instead of just an admin alert.
  | "AI_PROCESSING_SKIPPED"
  // E-signing: an internal (dmsUserId) recipient is notified in-app when a
  // request is sent, rather than by the access-token email external signers get.
  | "ESIGN_REQUEST_ASSIGNED"
  // audit 2026-08-11 data-flow sweep #8: neither a recipient
  // declining nor all-recipients-signed completion notified the SENDER
  // (SignatureRequest.createdBy) — only enqueueWebsocketEvent (realtime-only,
  // missed if they aren't watching the page), unlike letters' equivalent
  // LETTER_APPROVED/LETTER_RETURNED which do fanOut to the submitter.
  | "ESIGN_REQUEST_DECLINED"
  | "ESIGN_REQUEST_COMPLETED"
  // DATA-3: every background worker (including retention purge and
  // legal-hold-respecting disposal) is offline because REDIS_URL was unset/
  // unreachable at boot. Fanned out once at boot with the "system" pseudo-
  // tenant, same pattern as OUTBOX_DEAD_LETTER — a boot-time log line alone
  // is easy to miss forever, this makes it a real, actioned alert.
  | "WORKERS_OFFLINE";

export type NotificationSeverity = "INFO" | "WARNING" | "CRITICAL";

// Before this, fanOut emailed ONLY payload.severity === "CRITICAL" (via the
// SYSTEM.ALERT branch below) — every other notification, however important,
// was in-app + websocket only. That silently meant an approval/signing/letter
// lifecycle event NEVER emailed anyone in ANY environment, correctly
// configured SMTP or not: a person asked to sign a letter (ESIGN_REQUEST_
// ASSIGNED to a dmsUserId) got nothing but an in-app ping unless they were an
// external signer with no DMS account (those alone go through esigning.
// service.ts's own dedicated ESIGNING.RECIPIENT_INVITED EMAIL row). Confirmed
// live: grepped every NotificationType through this file and templates.ts —
// none of the types below had ANY email path, dedicated or otherwise.
//
// Scoped deliberately to "someone needs to act, or needs to know their own
// submission moved" — approval/signing/letter lifecycle and the assignee-
// left-so-you're-stuck alert. Left OUT on purpose: routine/high-frequency
// in-app-only notices (DOCUMENT_SCAN_COMPLETED fires on every upload,
// LOCK_EXPIRY_WARNING is a periodic nudge, AI_PROCESSING_SKIPPED is advisory)
// and anything already CRITICAL (VIRUS_DETECTED, HSM_UNAVAILABLE, etc. —
// those already email via SYSTEM.ALERT and would otherwise double-send).
const EMAIL_ALSO_ON_FANOUT = new Set<NotificationType>([
  "LETTER_APPROVED",
  "LETTER_RETURNED",
  "LETTER_CANCELLED",
  "LETTER_SLA_BREACH",
  "LETTER_STEP_ESCALATED",
  "LETTER_REGISTERED",
  "LETTER_SIGNED",
  "ESIGN_REQUEST_ASSIGNED",
  "ESIGN_REQUEST_DECLINED",
  "ESIGN_REQUEST_COMPLETED",
  "APPROVAL_STEP_PENDING",
  "APPROVAL_CHANGES_REQUESTED",
  "APPROVAL_DECLINED",
  "APPROVAL_COMPLETED",
  "APPROVAL_CANCELLED",
  "APPROVAL_STEP_DELEGATED",
  "APPROVAL_STEP_ESCALATED",
  "APPROVAL_WITHDRAWN",
  "AUDIT_STAGE_ASSIGNED",
  "AUDIT_STAGE_PASSED",
  "AUDIT_STAGE_FLAGGED",
  "ASSIGNEE_DEACTIVATED",
]);

/** Same deep-link scheme the frontend's own My Work list uses
 *  (app/dashboard/mywork/page.tsx) — letters, form templates, and everything
 *  else (documents, form instances, e-signing requests, which all resolve to
 *  a backing documentId) each have their own route shape. Falls back to My
 *  Work itself, which is always a valid, navigable page, rather than a dead
 *  link, when neither a letter nor a document id is resolvable. */
function resolveDeepLink(
  notification: { letterId: string | null; documentId: string | null },
  rawPayload: Record<string, unknown>,
): string {
  if (notification.letterId) return `/dashboard/letters/${notification.letterId}`;
  if (rawPayload.itemType === "FORM_TEMPLATE" && rawPayload.itemId) {
    return `/dashboard/forms/templates?highlight=${rawPayload.itemId}`;
  }
  if (notification.documentId) return `/dashboard/documents/${notification.documentId}?tab=workflow`;
  return `/dashboard/mywork`;
}

export async function fanOut(payload: {
  type: NotificationType;
  tenantId: string;
  recipientIds?: string[];
  severity: NotificationSeverity;
  payload: Record<string, unknown>;
}): Promise<void> {
  let recipientUserIds: string[] = [];

  if (payload.recipientIds && payload.recipientIds.length > 0) {
    recipientUserIds = payload.recipientIds;
  } else {
    // Default recipients = SYSTEM_ADMINs, but scoped to THIS tenant. Role grants
    // (user_roles) are global (no tenantId column), so resolving SYSTEM_ADMIN
    // alone returns admins of every tenant — a tenant-A dead-letter / virus /
    // HSM alert would then be delivered to tenant-B and tenant-C admins,
    // leaking tenant-A operational detail (S19 audit finding). Intersect with
    // user_tenants membership so only admins of payload.tenantId are notified.
    const systemAdminRole = await Role.findOne({ where: { name: "SYSTEM_ADMIN" } });
    if (systemAdminRole) {
      const userRoles = await UserRole.findAll({ where: { roleId: systemAdminRole.id } });
      const adminIds = [...new Set(userRoles.map(ur => ur.userId))];
      if (adminIds.length > 0) {
        const memberships = await UserTenant.findAll({
          where: { tenantId: payload.tenantId, userId: { [Op.in]: adminIds } },
          attributes: ["userId"],
          raw: true,
        });
        recipientUserIds = memberships.map(m => m.userId);
        // Fallback (S19 re-audit F1): some CRITICAL alerts are platform-level and
        // carry a pseudo-tenant with no user_tenants rows — OUTBOX_DEAD_LETTER
        // ("system") and HSM_UNAVAILABLE ("unknown"). Scoping to nobody would
        // silently drop them, a regression from "notify all admins". If the
        // membership intersection is empty, broadcast to all SYSTEM_ADMINs: a
        // platform sentinel carries no tenant data to leak, and a real tenant
        // with no enrolled admin still must not lose a critical alert.
        if (recipientUserIds.length === 0) {
          logger.warn(
            { tenantId: payload.tenantId, type: payload.type },
            "fanOut: no tenant-scoped SYSTEM_ADMIN found; broadcasting to all admins so the alert is not dropped",
          );
          recipientUserIds = adminIds;
        }
      }
    }
  }

  if (recipientUserIds.length === 0) {
    return;
  }

  // Create a notification for each recipient
  const notifications = recipientUserIds.map(userId => ({
    userId,
    // Stamp the owning tenant so cross-tenant rows can be segregated/filtered
    // (S19 audit finding — the table previously had no tenant_id at all).
    tenantId: payload.tenantId ?? null,
    // L2: approval/audit payloads carry itemType/itemId, not documentId — derive
    // it for DOCUMENT items so the notification deep-links instead of resolving
    // to a dead, non-navigable row.
    documentId:
      (payload.payload.documentId as string | undefined) ??
      (payload.payload.itemType === "DOCUMENT" ? (payload.payload.itemId as string | undefined) : undefined) ??
      null,
    letterId: (payload.payload.letterId as string | undefined) ?? null,
    type: payload.type,
    title: getNotificationTitle(payload.type, payload.payload),
    body: getNotificationBody(payload.type, payload.payload),
  }));

  // Best-effort like every other step below (email enqueue, websocket emit) —
  // fanOut is a side-effect attached to whatever real operation triggered it
  // (e.g. a document download hitting HSM_UNAVAILABLE, or an approval decision
  // completing), and a failure to ALERT about a problem must never itself
  // crash the operation that hit the problem. Found 2026-09-14: the
  // "broadcast to all SYSTEM_ADMINs" fallback above (S19 re-audit F1), and
  // plain single-recipient notifications like APPROVAL_COMPLETED, can both
  // name a recipient with zero `user_tenants` rows (e.g. admin@examplecorp.com
  // — a real account with no tenant membership assigned), and notifications'
  // RLS policy requires the recipient to have a membership row for the
  // CURRENT SESSION's tenant regardless of the notification's own tenant_id.
  //
  // FIX (2026-09-14, round 2): the try/catch below stops the JS exception
  // from propagating, but that alone is not enough — fanOut runs inside
  // whichever ambient transaction the triggering request already opened
  // (Sequelize CLS auto-attaches it), and Postgres marks that ENTIRE
  // transaction aborted the instant any one statement inside it errors.
  // Catching the JS error without rolling back left every later query on that
  // same transaction — the caller's own follow-up reads, not just this insert
  // — failing with "current transaction is aborted", masking a caught,
  // logged, harmless notification failure as a fresh unhandled 500 on an
  // unrelated statement moments later. Wrapping the bulkCreate in its own
  // sequelize.transaction() creates a SAVEPOINT (CLS detects the ambient
  // transaction), so a failure here rolls back only to that savepoint and the
  // outer transaction is unaffected.
  let created: Notification[] = [];
  try {
    created = await sequelize.transaction(
      (t) => Notification.bulkCreate(notifications, { transaction: t }),
    );
  } catch (err) {
    logger.error({ err, type: payload.type, recipientCount: recipientUserIds.length }, "fanOut: bulkCreate failed — continuing without in-app notifications");
    return;
  }

  // CRITICAL alerts also go out by email to the resolved operators
  // (suppressible per-user via the emailOnSystem preference at dispatch
  // time). Recipients are resolved HERE — the outbox dispatcher has no
  // request context to re-derive tenant-scoped admins from.
  // Loop guard: a dead-lettered EMAIL row raises OUTBOX_DEAD_LETTER — emailing
  // that alert would enqueue another EMAIL row that dead-letters the same way
  // (mail is down), amplifying forever. In-app-only for that one case.
  const emailDeadLetterAlert =
    payload.type === "OUTBOX_DEAD_LETTER" && (payload.payload.channel as string | undefined) === "EMAIL";
  if (payload.severity === "CRITICAL" && !emailDeadLetterAlert) {
    await OutboxEvent.create({
      documentId: null,
      type: "SYSTEM.ALERT",
      channel: "EMAIL",
      payload: JSON.stringify({
        alertType: payload.type,
        tenantId: payload.tenantId,
        recipientUserIds,
        details: JSON.stringify(payload.payload).slice(0, 1000),
      }),
    }).catch((err) => {
      logger.warn({ err, type: payload.type }, "fanOut: SYSTEM.ALERT email enqueue failed (in-app notification already created)");
    });
  }

  // Emit real-time notification to each recipient's user room. fanOut is called
  // from worker processes (ScanWorker, lock maintenance) where the Socket.IO
  // `io` instance is null — a direct emit there is a silent no-op. Route
  // through the outbox so the API process (which holds the socket) delivers it.
  for (const notification of created) {
    await enqueueWebsocketEvent("NOTIFICATION.CREATED", {
      room: `user_${notification.userId}`,
      userId: notification.userId,
      notificationId: notification.id,
      type: notification.type,
      title: notification.title,
    }).catch(() => {
      // Best-effort: if outbox insert fails, try a direct emit (API process).
      emitDomainEvent(`user_${notification.userId}`, "NOTIFICATION.CREATED", {
        userId: notification.userId,
        notificationId: notification.id,
        type: notification.type,
        title: notification.title,
      });
    });

    // Email in addition to the in-app notification — see EMAIL_ALSO_ON_FANOUT's
    // own comment for why this exists. Reuses the same title/body already
    // computed above rather than a bespoke template per type; renderEmail's
    // "NOTIFICATION.FANOUT" template (templates.ts) just brands and links it.
    // Best-effort and outside the notifications transaction — a failed email
    // enqueue must not undo the in-app notification that already succeeded.
    if (EMAIL_ALSO_ON_FANOUT.has(notification.type as NotificationType)) {
      await OutboxEvent.create({
        documentId: notification.documentId,
        type: "NOTIFICATION.FANOUT",
        channel: "EMAIL",
        payload: JSON.stringify({
          tenantId: payload.tenantId,
          recipientUserId: notification.userId,
          subject: notification.title,
          body: notification.body,
          notificationType: notification.type,
          url: resolveDeepLink(notification, payload.payload),
        }),
      }).catch((err) => {
        logger.warn({ err, type: notification.type, userId: notification.userId }, "fanOut: email enqueue failed (in-app notification already created)");
      });
    }
  }
}

function getNotificationTitle(type: NotificationType, payload: Record<string, unknown> = {}): string {
  switch (type) {
    case "LOCK_EXPIRY_WARNING":
      return "Document Lock Expiring Soon";
    case "PURGE_APPROVAL_REQUIRED":
      return "Purge Approval Required";
    case "AUDIT_INTEGRITY_FAILURE":
      return "Audit Integrity Failure";
    case "VIRUS_DETECTED":
      return "Virus Detected";
    case "DOCUMENT_SCAN_COMPLETED":
      return "Antivirus Scan Complete";
    case "STORAGE_QUOTA_WARNING":
      return "Storage Quota Warning";
    case "HSM_UNAVAILABLE":
      return "HSM Unavailable";
    case "KEY_ROTATION_COMPLETE":
      return "Key Rotation Complete";
    case "LETTER_STEP_PENDING":
      return "Letter Awaiting Your Decision";
    case "LETTER_REGISTERED":
      return "Incoming Letter Registered";
    case "LETTER_APPROVED":
      // Final approval of an OUTGOING+COMPOSED letter only flips status to
      // APPROVED — signing is a deliberate, separate manual step the
      // recipient must trigger via "Initiate Signing" (letters.service.ts's
      // decideStep()/awaitingSigning branch). The generic "Letter Approved"
      // title read identically to a fully-finalized letter, so nobody had
      // any reason to go click that button and letters sat in APPROVED with
      // no document forever — this was reported as "approval fired an email
      // but signing did not."
      return payload.awaitingSigningInitiation ? "Letter Approved — Signature Required" : "Letter Approved";
    case "LETTER_SIGNED":
      return "Letter Signed";
    case "LETTER_RETURNED":
      return "Letter Returned";
    case "LETTER_RECALLED":
      return "Letter Recalled";
    case "LETTER_SLA_BREACH":
      return "Letter Step Overdue";
    case "LETTER_STEP_ESCALATED":
      return "Overdue Letter Escalated";
    case "LETTER_CANCELLED":
      return "Letter Cancelled";
    case "APPROVAL_STEP_PENDING":
      return "Item Awaiting Your Decision";
    case "APPROVAL_CHANGES_REQUESTED":
      return "Changes Requested";
    case "APPROVAL_DECLINED":
      return "Submission Declined";
    case "APPROVAL_COMPLETED":
      return "Approval Complete";
    case "APPROVAL_CANCELLED":
      return "Approval Cancelled";
    case "APPROVAL_SLA_BREACH":
      return "Approval Overdue";
    case "APPROVAL_STEP_DELEGATED":
      return "Approval Delegated to You";
    case "APPROVAL_STEP_ESCALATED":
      return "Overdue Approval Escalated";
    case "APPROVAL_WITHDRAWN":
      return "Submission Withdrawn";
    case "AUDIT_STAGE_ASSIGNED":
      return "Audit Review Assigned";
    case "AUDIT_STAGE_PASSED":
      return "Audit Passed";
    case "AUDIT_STAGE_FLAGGED":
      return "Audit Flagged";
    case "ASSIGNEE_DEACTIVATED":
      return "Assignee Deactivated — Action Needed";
    case "OUTBOX_DEAD_LETTER":
      return "Delivery Permanently Failed";
    case "AI_PROCESSING_SKIPPED":
      return "AI Processing Skipped";
    case "ESIGN_REQUEST_ASSIGNED":
      return "Signature Requested";
    case "ESIGN_REQUEST_DECLINED":
      return "Signature Request Declined";
    case "ESIGN_REQUEST_COMPLETED":
      return "Signing Complete";
    case "WORKERS_OFFLINE":
      return "Background Workers Offline";
    default:
      return "Notification";
  }
}

function getNotificationBody(type: NotificationType, payload: Record<string, unknown>): string {
  switch (type) {
    case "LOCK_EXPIRY_WARNING":
      return `Your document lock will expire at ${payload.expiresAt}`;
    case "PURGE_APPROVAL_REQUIRED":
      return "A document requires your approval for purge";
    case "AUDIT_INTEGRITY_FAILURE":
      return "Audit log integrity check failed";
    case "VIRUS_DETECTED":
      return `Virus detected in document ${payload.documentId}`;
    case "DOCUMENT_SCAN_COMPLETED":
      return payload.scanStatus === "clean"
        ? "Your large-file upload passed its antivirus scan."
        : "Your large-file upload could not be scanned and is flagged for review.";
    case "STORAGE_QUOTA_WARNING":
      return `Storage usage is at ${payload.percentUsed}% of quota`;
    case "HSM_UNAVAILABLE":
      return `HSM is unavailable: ${payload.error}`;
    case "KEY_ROTATION_COMPLETE":
      return "Key rotation completed successfully";
    case "LETTER_STEP_PENDING":
      return `"${payload.subject}" is awaiting your ${payload.stepType === "APPROVE" ? "approval" : "review"}`;
    case "LETTER_REGISTERED":
      return `Incoming letter ${payload.referenceNumber ?? ""} "${payload.subject}" was registered and assigned to you`;
    case "LETTER_APPROVED":
      return payload.awaitingSigningInitiation
        ? `"${payload.subject}" has completed approval and is awaiting your signature. Open it and use "Initiate Signing" to finish.`
        : `"${payload.subject}" was approved${payload.referenceNumber ? ` (${payload.referenceNumber})` : ""}`;
    case "LETTER_SIGNED":
      return `"${payload.subject}" was signed and finalized${payload.referenceNumber ? ` (${payload.referenceNumber})` : ""}`;
    case "LETTER_RETURNED":
      return `"${payload.subject}" was returned for revision${payload.comment ? `: ${payload.comment}` : ""}`;
    case "LETTER_SLA_BREACH":
      return `"${payload.subject}" has missed its review deadline and needs a decision`;
    case "LETTER_STEP_ESCALATED":
      return `"${payload.subject}" is overdue and has been escalated${payload.escalatedToNames ? ` to ${payload.escalatedToNames}` : ""} so it can be decided`;
    case "LETTER_RECALLED":
      return `"${payload.subject}" was recalled by its drafter and is no longer waiting for you${payload.reason ? `: ${payload.reason}` : ""}`;
    case "LETTER_CANCELLED":
      return `"${payload.subject}" was cancelled while in review${payload.reason ? `: ${payload.reason}` : ""}`;
    case "APPROVAL_STEP_PENDING":
      return `"${payload.title ?? "An item"}" is awaiting your ${payload.stepType === "APPROVE" ? "approval" : "review"}`;
    case "APPROVAL_CHANGES_REQUESTED":
      return `Changes were requested on "${payload.title ?? "your submission"}"${payload.comment ? `: ${payload.comment}` : ""}`;
    case "APPROVAL_DECLINED":
      return `"${payload.title ?? "Your submission"}" was declined${payload.comment ? `: ${payload.comment}` : ""}`;
    case "APPROVAL_COMPLETED":
      return `"${payload.title ?? "Your submission"}" completed approval`;
    case "APPROVAL_CANCELLED":
      return `The approval for "${payload.title ?? "your submission"}" was cancelled by an administrator${payload.reason ? `: ${payload.reason}` : ""}`;
    case "APPROVAL_SLA_BREACH":
      return `"${payload.title ?? "An item"}" has missed its approval deadline and needs attention`;
    case "APPROVAL_STEP_DELEGATED":
      return `"${payload.title ?? "An item"}" was delegated to you for ${payload.stepType === "REVIEW" ? "review" : "approval"}${payload.fromName ? ` by ${payload.fromName}` : ""}`;
    case "APPROVAL_STEP_ESCALATED":
      return `"${payload.title ?? "An item"}" is overdue and has been escalated${payload.escalatedToNames ? ` to ${payload.escalatedToNames}` : ""} so it can be decided`;
    case "APPROVAL_WITHDRAWN":
      return `"${payload.title ?? "An item"}" was withdrawn by its author and no longer needs your decision${payload.reason ? `: ${payload.reason}` : ""}`;
    case "AUDIT_STAGE_ASSIGNED":
      return `You have been assigned to audit "${payload.title ?? "an approved item"}"`;
    case "AUDIT_STAGE_PASSED":
      return `Audit passed for "${payload.title ?? "your item"}"`;
    case "AUDIT_STAGE_FLAGGED":
      return `Audit flagged "${payload.title ?? "your item"}"${payload.findings ? `: ${payload.findings}` : ""}`;
    case "ASSIGNEE_DEACTIVATED":
      return `"${payload.title ?? "An item"}" is waiting on ${payload.assigneeName ?? "a user"} who has been deactivated — reassign or cancel it`;
    case "OUTBOX_DEAD_LETTER":
      return `A ${payload.channel ?? ""} event (${payload.eventType ?? "unknown"}) exhausted all retries and was dead-lettered — retry it from Operations → Outbox`;
    case "AI_PROCESSING_SKIPPED":
      return `${payload.operation === "AI_EXTRACT_METADATA" ? "Metadata extraction" : "Summarization"} for "${payload.documentTitle ?? "a document"}" was skipped: ${payload.reason ?? "no reason given"}`;
    case "ESIGN_REQUEST_ASSIGNED":
      return `"${payload.documentName ?? "A document"}" is waiting on your signature`;
    case "ESIGN_REQUEST_DECLINED":
      return `Signing was declined for "${payload.documentName ?? "your document"}"${payload.reason ? `: ${payload.reason}` : ""}`;
    case "ESIGN_REQUEST_COMPLETED":
      return `All signatures collected for "${payload.documentName ?? "your document"}"`;
    case "WORKERS_OFFLINE":
      return String(payload.reason ?? "Retention purge, legal-hold disposal, and SLA escalation are not running. Check Operations → System Health.");
    default:
      return "You have a new notification";
  }
}
