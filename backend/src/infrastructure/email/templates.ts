/**
 * Email template system for DMS.
 *
 * Replaces the previous inline string-concatenation approach with a small
 * registry of typed templates. Each template renders a `subject`, an
 * email-safe `html` body (wrapped in a shared branded layout) and a plain
 * `text` fallback. Unknown event types fall back to a generic template so a
 * new event can never produce an un-sendable email.
 *
 * To add a new templated email: add an entry to TEMPLATES keyed by the
 * outbox event `type`.
 */
import { config } from '../../config/env.js';

const BRAND = {
  name: "DMS",
  full: "Enterprise Document & Archive Management System",
  accent: "#4F46E5",
  ink: "#0F172A",
  muted: "#64748B",
  bg: "#F0F4FF",
  surface: "#FFFFFF",
  border: "#E2E8F0",
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Section {
  /** Short heading shown above the body. */
  heading: string;
  /** One or more paragraphs of body copy (plain strings; HTML-escaped). */
  paragraphs: string[];
  /** Optional labelled key/value facts rendered as a table. */
  facts?: Array<{ label: string; value: string }>;
  /** Optional call-to-action button. */
  cta?: { label: string; url: string };
  /** Severity tints the accent strip: info (brand), warn (amber), danger (rose). */
  tone?: "info" | "warn" | "danger";
}

const TONE_COLOR: Record<NonNullable<Section["tone"]>, string> = {
  info: BRAND.accent,
  warn: "#D97706",
  danger: "#E11D48",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wraps a section in the shared, email-client-safe HTML layout. */
function layout(section: Section): string {
  const accent = TONE_COLOR[section.tone ?? "info"];
  const paragraphs = section.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:${BRAND.ink};">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("");

  const facts = section.facts?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 18px;border-collapse:collapse;">${section.facts
        .map(
          (f) =>
            `<tr><td style="padding:6px 0;font-size:12px;color:${BRAND.muted};width:160px;vertical-align:top;">${escapeHtml(
              f.label,
            )}</td><td style="padding:6px 0;font-size:13px;color:${BRAND.ink};font-weight:600;">${escapeHtml(
              f.value,
            )}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const cta = section.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr><td style="border-radius:8px;background:${accent};"><a href="${escapeHtml(
        section.cta.url,
      )}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(
        section.cta.label,
      )}</a></td></tr></table>`
    : "";

  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.bg};">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:${BRAND.bg};padding:28px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
        <tr><td style="background:#06091A;padding:20px 28px;">
          <span style="display:inline-block;width:30px;height:30px;background:${BRAND.accent};border-radius:7px;color:#fff;font-weight:800;font-size:13px;text-align:center;line-height:30px;vertical-align:middle;">E</span>
          <span style="margin-left:10px;font-size:15px;font-weight:700;color:#fff;vertical-align:middle;letter-spacing:-0.3px;">${BRAND.name}</span>
        </td></tr>
        <tr><td style="height:4px;background:${accent};"></td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-size:19px;line-height:1.3;color:${BRAND.ink};font-weight:800;letter-spacing:-0.02em;">${escapeHtml(
            section.heading,
          )}</h1>
          ${paragraphs}
          ${facts}
          ${cta}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid ${BRAND.border};">
          <p style="margin:0;font-size:11px;line-height:1.6;color:${BRAND.muted};">This is an automated message from ${BRAND.full}. Please do not reply directly to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Plain-text fallback derived from the same section content. */
function textOf(section: Section): string {
  const parts = [section.heading, "", ...section.paragraphs];
  if (section.facts?.length) {
    parts.push("");
    for (const f of section.facts) parts.push(`${f.label}: ${f.value}`);
  }
  if (section.cta) {
    parts.push("", `${section.cta.label}: ${section.cta.url}`);
  }
  parts.push("", `— ${BRAND.full} (automated message)`);
  return parts.join("\n");
}

type TemplateFn = (payload: Record<string, unknown>) => { subject: string; section: Section };

const appUrl = (path: string): string => {
  // CLIENT_URL is already zod-validated with a default in config/env.ts —
  // this used to re-read process.env directly (bypassing that validation)
  // and additionally fall back to an undeclared APP_BASE_URL alias env.ts
  // doesn't know about.
  return `${config.CLIENT_URL.replace(/\/$/, "")}${path}`;
};

const TEMPLATES: Record<string, TemplateFn> = {
  "RETENTION.DISPOSAL_WARNING_90": (p) => ({
    subject: "[DMS] Retention notice — disposal in 90 days",
    section: {
      tone: "warn",
      heading: "A document is approaching its disposal date",
      paragraphs: [
        `The document below is scheduled for disposal in 90 days. If it should be retained longer, extend its retention before the eligible date.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Document ID", value: String(p.documentId ?? "—") },
        { label: "Eligible for disposal", value: String(p.eligibleAt ?? "—") },
      ],
      cta: p.documentId
        ? { label: "Review document", url: appUrl(`/dashboard/documents/${p.documentId}`) }
        : undefined,
    },
  }),
  "RETENTION.DISPOSAL_WARNING_30": (p) => ({
    subject: "[DMS] Final retention notice — disposal in 30 days",
    section: {
      tone: "danger",
      heading: "Final warning before scheduled disposal",
      paragraphs: [
        `The document below is scheduled for disposal in 30 days. This is the final automated warning. Review it immediately if retention should be extended.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Document ID", value: String(p.documentId ?? "—") },
        { label: "Eligible for disposal", value: String(p.eligibleAt ?? "—") },
      ],
      cta: p.documentId
        ? { label: "Review document", url: appUrl(`/dashboard/documents/${p.documentId}`) }
        : undefined,
    },
  }),
  "RETENTION.DISPOSAL_PENDING": (p) => ({
    subject: "[DMS] Document pending disposal",
    section: {
      tone: "warn",
      heading: "A document has reached its retention end date",
      paragraphs: [
        `The document below has reached its retention end date and is now pending certified disposal. No action is required unless you wish to appeal.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Document ID", value: String(p.documentId ?? "—") },
      ],
      cta: p.documentId
        ? { label: "View document", url: appUrl(`/dashboard/documents/${p.documentId}`) }
        : undefined,
    },
  }),
  "RETENTION.DISPOSAL_EXECUTED": (p) => ({
    subject: "[DMS] Document disposed per retention policy",
    section: {
      tone: "danger",
      heading: "A document has been permanently disposed of",
      paragraphs: [
        `The document below has been certified-disposed per its retention policy. This action is irreversible; a certificate of destruction has been recorded.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Document ID", value: String(p.documentId ?? "—") },
      ],
    },
  }),
  "WORKFLOW.SLA_BREACH": (p) => ({
    subject: "[DMS] Workflow SLA breach — action required",
    section: {
      tone: "danger",
      heading: "A workflow task has breached its SLA",
      paragraphs: [
        `A task assigned to you has exceeded its SLA deadline and now requires immediate attention.`,
      ],
      facts: [
        { label: "Stage", value: String(p.stageName ?? "—") },
        { label: "Task ID", value: String(p.taskId ?? "—") },
      ],
      cta: { label: "Open approval queue", url: appUrl(`/operations?panel=workflows`) },
    },
  }),
  "ESIGNING.RECIPIENT_INVITED": (p) => ({
    subject: `[DMS] You've been asked to sign a document`,
    section: {
      tone: "info",
      heading: "You've been asked to sign a document",
      paragraphs: [
        `${String(p.name ?? "You")} have been invited to review and sign a document via ${BRAND.name}. No account is required — use the secure link below to open it.`,
        `This link is personal to you and expires after a limited time. Do not forward this email.`,
      ],
      facts: [
        { label: "Requested of", value: String(p.name ?? p.email ?? "—") },
        { label: "Email", value: String(p.email ?? "—") },
      ],
      cta: p.signUrl ? { label: "Review & sign", url: String(p.signUrl) } : undefined,
    },
  }),
  "LETTER.STEP_PENDING": (p) => ({
    subject: `[DMS] A letter awaits your ${String(p.stepType ?? "review").toLowerCase()}`,
    section: {
      tone: "info",
      heading: "A correspondence letter needs your attention",
      paragraphs: [
        `A letter has reached a step assigned to you and is now awaiting your ${String(p.stepType ?? "review").toLowerCase()}.`,
      ],
      facts: [
        { label: "Subject", value: String(p.subject ?? "—") },
        { label: "Step", value: String(p.stepType ?? "—") },
      ],
      cta: { label: "Open letter", url: appUrl(`/dashboard/letters/${p.letterId ?? ""}`) },
    },
  }),
  "LETTER.EXECUTIVE_NOTICE": (p) => {
    const direction = p.direction === "Incoming" ? "Incoming" : "Outgoing";
    const attached = p.hasAttachment ? " The letter file is attached to this email." : "";
    return {
      subject: `[DMS] ${direction} correspondence: ${String(p.referenceNumber ?? p.subject ?? "")}`,
      section: {
        tone: "info",
        heading: `${direction} letter ${p.referenceNumber ? "filed" : "logged"}`,
        paragraphs: [
          direction === "Incoming"
            ? `An incoming letter was registered into the system.${attached}`
            : `An outgoing letter was approved and finalized.${attached}`,
        ],
        facts: [
          { label: "Reference No.", value: String(p.referenceNumber ?? "—") },
          { label: "Subject", value: String(p.subject ?? "—") },
          { label: direction === "Incoming" ? "From" : "To", value: String(p.correspondent ?? "—") },
          { label: "Department", value: String(p.departmentName ?? "—") },
        ],
        cta: { label: "Open letter", url: appUrl(`/dashboard/letters/${p.letterId ?? ""}`) },
      },
    };
  },
  "TRASH.SCHEDULED_PURGE": (p) => ({
    subject: "[DMS] Document moved to trash — permanent deletion scheduled",
    section: {
      tone: "warn",
      heading: "A document you own was moved to trash",
      paragraphs: [
        `The document below was moved to trash and is scheduled for permanent, certified destruction after ${String(
          p.retentionDays ?? 30,
        )} days. If this was unintended, restore it from the trash before that date — after it, the content cannot be recovered.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Document ID", value: String(p.documentId ?? "—") },
        { label: "Permanent deletion after", value: String(p.purgeAfter ?? "—") },
      ],
      cta: { label: "Open trash", url: appUrl(`/dashboard/trash`) },
    },
  }),
  "DOCUMENT.PURGED": (p) => ({
    subject: "[DMS] Document permanently destroyed",
    section: {
      tone: "danger",
      heading: "A document you owned has been permanently destroyed",
      paragraphs: [
        `The document below has been permanently destroyed under a certified disposal. Its content, versions, and encryption keys no longer exist and cannot be recovered. The certificate reference below is your audit record.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? "—") },
        { label: "Certificate reference", value: String(p.certificateReference ?? "—") },
        { label: "Disposal method", value: String(p.disposalMethod ?? "—") },
      ],
    },
  }),
  "APPROVAL.SLA_BREACH": (p) => ({
    subject: "[DMS] Approval overdue — action required",
    section: {
      tone: "danger",
      heading: "An approval step has missed its deadline",
      paragraphs: [
        `"${String(p.title ?? "An item")}" has an approval step past its SLA deadline and needs an immediate decision or reassignment.`,
      ],
      facts: [
        { label: "Item", value: String(p.title ?? "—") },
        { label: "Type", value: String(p.itemType ?? "—") },
      ],
      cta: { label: "Open My Work", url: appUrl(`/dashboard/mywork`) },
    },
  }),
  "LEGALHOLD.DOCUMENT_HELD": (p) => ({
    subject: "[DMS] Legal hold placed on your document",
    section: {
      tone: "warn",
      heading: "A document you own is now under legal hold",
      paragraphs: [
        `The document below has been placed under a legal hold (case ${String(
          p.caseReference ?? "—",
        )}). While the hold is active it cannot be edited, trashed, or disposed of, regardless of its retention schedule. You will be notified when the hold is released.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? p.documentId ?? "—") },
        { label: "Case reference", value: String(p.caseReference ?? "—") },
        { label: "Custodian", value: String(p.custodianName ?? "—") },
      ],
      cta: { label: "Open document", url: appUrl(`/dashboard/files?doc=${p.documentId ?? ""}`) },
    },
  }),
  "LEGALHOLD.DOCUMENT_RELEASED": (p) => ({
    subject: "[DMS] Legal hold released on your document",
    section: {
      tone: "info",
      heading: "The legal hold on your document has been released",
      paragraphs: [
        `The hold placed under case ${String(
          p.caseReference ?? "—",
        )} has been released (closure reference ${String(p.closureRef ?? "—")}). The document is no longer frozen and its normal retention schedule now applies.`,
      ],
      facts: [
        { label: "Document", value: String(p.documentName ?? p.documentId ?? "—") },
        { label: "Case reference", value: String(p.caseReference ?? "—") },
        { label: "Closure reference", value: String(p.closureRef ?? "—") },
      ],
      cta: { label: "Open document", url: appUrl(`/dashboard/files?doc=${p.documentId ?? ""}`) },
    },
  }),
  "SYSTEM.ALERT": (p) => ({
    subject: `[DMS] System alert: ${String(p.alertType ?? "critical event")}`,
    section: {
      tone: "danger",
      heading: "A critical system event needs operator attention",
      paragraphs: [
        `DMS raised a CRITICAL platform alert. Details are below — investigate promptly; repeated alerts of the same type usually indicate a failing dependency (storage, key management, queues, or mail).`,
      ],
      facts: [
        { label: "Alert", value: String(p.alertType ?? "—") },
        { label: "Tenant", value: String(p.tenantId ?? "—") },
        { label: "Details", value: String(p.details ?? "—").slice(0, 500) },
      ],
      cta: { label: "Open operations", url: appUrl(`/operations`) },
    },
  }),
  // Generic template for notifications.service.ts's fanOut() — covers every
  // type in its EMAIL_ALSO_ON_FANOUT set (approval/audit-stage decisions on
  // documents and forms, e-signing assignment/decline/completion, and letter
  // approved/returned/cancelled/registered) with one template rather than one
  // per type, reusing the same title/body already computed for the in-app
  // notification. `p.body` already reads naturally as a sentence (see
  // notifications.service.ts's getNotificationBody), so it needs no reframing
  // here — just the branded wrapper and a link back into the app.
  "NOTIFICATION.FANOUT": (p) => ({
    subject: `[DMS] ${String(p.subject ?? "Notification")}`,
    section: {
      tone: "info",
      heading: String(p.subject ?? "You have a new notification"),
      paragraphs: [String(p.body ?? "")],
      cta: { label: "Open in DMS", url: appUrl(String(p.url ?? "/dashboard/mywork")) },
    },
  }),
  "LETTER.DISPATCH_EMAIL": (p) => ({
    subject: `${String(p.senderOrganization ?? "Example Corp")}: ${String(p.subject ?? "Correspondence")}`,
    section: {
      tone: "info",
      heading: "You have received official correspondence",
      paragraphs: [
        `${String(p.senderOrganization ?? "Example Corp")} has sent you the letter below. The full document is attached to this email${p.hasCoverSheet ? ", along with a verification cover sheet bearing a QR code" : ""}.`,
        "To confirm this letter is authentic, scan the QR code on the attached document or open the verification link below.",
      ],
      facts: [
        { label: "Reference No.", value: String(p.referenceNumber ?? "—") },
        { label: "Subject", value: String(p.subject ?? "—") },
        { label: "Date", value: String(p.dateStr ?? "—") },
      ],
      cta: p.verifyUrl ? { label: "Verify this letter", url: String(p.verifyUrl) } : undefined,
    },
  }),
  // Sent directly by infrastructure/alerting/adminAlerts.ts — NOT through the
  // outbox (an unhandled fault, including a DB-capacity one, is exactly the
  // case where writing an outbox row and waiting 5s for the poller is the
  // wrong tool). Backs the ERR-INTERNAL response's "the team has been
  // notified" text with an actual email.
  "SYSTEM.UNHANDLED_ERROR": (p) => ({
    subject: `[DMS] Unhandled error — ${String(p.method ?? "")} ${String(p.route ?? "")}`,
    section: {
      tone: "danger",
      heading: "An unhandled server error occurred",
      paragraphs: [
        p.occurrenceCount && Number(p.occurrenceCount) > 1
          ? `This has now happened ${p.occurrenceCount} times since ${p.firstSeenAt}. This email was sent once for this error and route; repeats are suppressed for ${p.throttleMinutes} minutes.`
          : `A request failed with an unhandled exception and returned a 500 to the caller.`,
      ],
      facts: [
        { label: "Route", value: `${String(p.method ?? "—")} ${String(p.route ?? "—")}` },
        { label: "Error", value: String(p.errorName ?? "—") },
        { label: "Message", value: String(p.errorMessage ?? "—") },
        { label: "Request ID", value: String(p.requestId ?? "—") },
        ...(p.tenantId ? [{ label: "Tenant", value: String(p.tenantId) }] : []),
        { label: "Last seen", value: String(p.lastSeenAt ?? "—") },
      ],
      cta: { label: "Open System Errors panel", url: appUrl(`/operations?panel=systemErrors`) },
    },
  }),
};

/**
 * Renders an email for the given outbox event type. Always returns a sendable
 * email — unknown types use a generic, branded fallback.
 */
export function renderEmail(type: string, payload: Record<string, unknown>): RenderedEmail {
  const tpl = TEMPLATES[type];
  if (tpl) {
    const { subject, section } = tpl(payload);
    return { subject, html: layout(section), text: textOf(section) };
  }

  const section: Section = {
    tone: "info",
    heading: "System notification",
    paragraphs: [`An event of type "${type}" occurred in DMS.`],
    facts: Object.entries(payload)
      .filter(([, v]) => typeof v !== "object")
      .slice(0, 8)
      .map(([k, v]) => ({ label: k, value: String(v) })),
  };
  return {
    subject: `[DMS] System notification: ${type}`,
    html: layout(section),
    text: textOf(section),
  };
}

/** Exposed for tests / tooling: the set of explicitly templated event types. */
export const TEMPLATED_EVENT_TYPES = Object.keys(TEMPLATES);
