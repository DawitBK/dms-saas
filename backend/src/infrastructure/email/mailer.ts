import nodemailer from "nodemailer";
// nodemailer ships its own types from v7 on (the @types/nodemailer stub is gone),
// and they export `Transporter` as a named type rather than under a `nodemailer`
// namespace — `nodemailer.Transporter` no longer resolves.
import type { Transporter } from "nodemailer";
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";

let transporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter> {
  if (transporter) return transporter;

  if (config.NODE_ENV === "development" && config.SMTP_HOST === "localhost") {
    logger.info("Creating Ethereal test account for local SMTP testing...");
    const account = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: account.user, pass: account.pass },
    });
  } else {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER && config.SMTP_PASS
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
        : {}),
      // POOLED, AND RATE-LIMITED, BECAUSE THE RELAY IS GMAIL.
      //
      // Unpooled, nodemailer opens a fresh TCP connection and a fresh AUTH for
      // every single message. The outbox drains in batches, so a backlog turns
      // into a burst of authenticated logins from one account — and Gmail
      // answers that with `454-4.7.0 Too many login attempts` and a temporary
      // block on the account, not with a per-message error. That is the whole
      // platform's outbound mail down, from notification traffic alone.
      //
      // Observed on 2026-09-03: 133 sends in a few minutes was enough to
      // trigger it. Pooling holds a few authenticated connections open and
      // reuses them, so a batch costs a handful of logins instead of one each;
      // rateDelta/rateLimit then caps throughput at 5 messages/second so a
      // large drain stays inside the relay's tolerance instead of racing it.
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
    });
  }

  return transporter;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<void> {
  const t = await getTransporter();

  // Non-production redirect (config.EMAIL_REDIRECT_TO; refused outright in
  // production/mirror by assertProductionRuntimeRequirements). Testing email
  // properly means pointing dev at the real relay, and the dev database is full
  // of seeded @edams.local users and real colleagues' addresses -- so without
  // this, exercising the mail path means actually mailing them.
  //
  // The real recipients are kept visible rather than dropped: the whole point of
  // a dev send is checking that the right person WOULD have been mailed, and a
  // redirected message that hides that answers a different question.
  const intended = Array.isArray(opts.to) ? opts.to : [opts.to];
  const redirect = config.EMAIL_REDIRECT_TO;
  const outgoing = redirect
    ? {
        ...opts,
        to: redirect,
        subject: `[dev → ${intended.join(", ")}] ${opts.subject}`,
        text: `[Redirected in development. Real recipients: ${intended.join(", ")}]

${opts.text}`,
        ...(opts.html
          ? {
              html: `<p style="background:#fffbe6;border:1px solid #f0c36d;padding:8px;font:13px sans-serif">Redirected in development. Real recipients: <strong>${intended.join(", ")}</strong></p>${opts.html}`,
            }
          : {}),
      }
    : opts;

  const info = await t.sendMail({ from: config.EMAIL_FROM, ...outgoing });
  const testUrl = nodemailer.getTestMessageUrl(info);
  if (testUrl) {
    logger.info({ to: outgoing.to, subject: opts.subject, testUrl }, "[mailer] email sent (Ethereal)");
  } else if (redirect) {
    logger.info(
      { to: redirect, intended, subject: opts.subject, messageId: info.messageId },
      "[mailer] email sent (REDIRECTED — EMAIL_REDIRECT_TO is set)",
    );
  } else {
    logger.info({ to: opts.to, subject: opts.subject, messageId: info.messageId }, "[mailer] email sent");
  }
}
