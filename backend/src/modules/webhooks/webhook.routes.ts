// S5-10: Webhook subscriptions management routes
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { AppError } from "../../core/AppError.js";
import { WebhookSubscription } from "../../infrastructure/database/index.js";
import { assertSafeWebhookUrl, assertResolvesToPublicAddress } from "../../shared/ssrf.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";

export const webhookRoutes = Router();

// API-1: this used to be a manual `if (!url || !secret)` presence check —
// real, but with no shape/strength validation, letting a malformed URL reach
// the SSRF guards below with no clear error, and a trivially weak secret
// (e.g. "x") reach the HMAC-SHA256 signing path this subscription drives
// every webhook delivery through. 16 chars is a practical floor for a shared
// HMAC secret, not a hard cryptographic requirement.
const createWebhookSchema = z.object({
  url: z.string().url().max(2000),
  secret: z.string().min(16).max(255),
});

// Never expose the signing secret over the API; callers only need to know a
// subscription exists and where it points. The secret is write-only.
const PUBLIC_ATTRS = ["id", "tenantId", "url", "isActive", "createdAt", "updatedAt"] as const;

webhookRoutes.get("/", requirePermission(PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (req, res) => {
  const subs = await WebhookSubscription.findAll({
    where: { tenantId: req.user!.tenantId },
    attributes: PUBLIC_ATTRS as unknown as string[],
    order: [["createdAt", "DESC"]],
  });
  res.json({ data: subs });
}));

webhookRoutes.post("/", requirePermission(PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (req, res) => {
  const { url, secret } = createWebhookSchema.parse(req.body);
  // Tenant is taken from the authenticated principal, NEVER the body — otherwise
  // an operator could register a subscription stamped with another tenant's id
  // and receive that tenant's events (cross-tenant exfiltration).
  const tenantId = req.user!.tenantId;

  // SSRF guard: reject internal/loopback/metadata targets both by literal IP now
  // and by DNS resolution (defends against DNS rebinding).
  assertSafeWebhookUrl(String(url));
  await assertResolvesToPublicAddress(String(url));

  const sub = await WebhookSubscription.create({
    url: String(url),
    secret: String(secret),
    tenantId,
    isActive: true
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.WEBHOOK_SUBSCRIPTION_CREATED,
    userId: req.user!.userId,
    userRole: req.user!.role,
    actionDetails: { subscriptionId: sub.id, url: sub.url },
  });
  res.status(201).json({
    id: sub.id,
    tenantId: sub.tenantId,
    url: sub.url,
    isActive: sub.isActive,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  });
}));

// Edit a subscription: the URL (checked by the same SSRF guards as create), a NEW signing secret (write-only, never returned), and the
// on/off switch. An inactive subscription keeps its place but receives nothing, which is the safe way to pause a receiver.
const updateWebhookSchema = z
  .object({
    url: z.string().url().max(2000).optional(),
    secret: z.string().min(16).max(255).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => d.url !== undefined || d.secret !== undefined || d.isActive !== undefined, { message: "Nothing to change" });

webhookRoutes.patch("/:id", requirePermission(PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (req, res) => {
  const data = updateWebhookSchema.parse(req.body);
  const sub = await WebhookSubscription.findOne({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } });
  if (!sub) throw new AppError(404, "ERR-WEBHOOK-NOT-FOUND", "Subscription not found");
  if (data.url !== undefined) {
    assertSafeWebhookUrl(String(data.url));
    await assertResolvesToPublicAddress(String(data.url));
  }
  const before = { url: sub.url, isActive: sub.isActive };
  await sub.update({
    ...(data.url !== undefined ? { url: String(data.url) } : {}),
    ...(data.secret !== undefined ? { secret: String(data.secret) } : {}),
    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.WEBHOOK_SUBSCRIPTION_UPDATED,
    userId: req.user!.userId,
    userRole: req.user!.role,
    // The secret itself is never written to the log, only that it was replaced.
    actionDetails: { subscriptionId: sub.id, before, after: { url: sub.url, isActive: sub.isActive }, secretReplaced: data.secret !== undefined },
  });
  res.json({ id: sub.id, tenantId: sub.tenantId, url: sub.url, isActive: sub.isActive, createdAt: sub.createdAt, updatedAt: sub.updatedAt });
}));

webhookRoutes.delete("/:id", requirePermission(PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (req, res) => {
  const sub = await WebhookSubscription.findOne({
    where: { id: String(req.params.id), tenantId: req.user!.tenantId },
  });
  if (!sub) {
    throw new AppError(404, "ERR-WEBHOOK-NOT-FOUND", "Subscription not found");
  }
  await sub.destroy();
  await writeAuditLog({
    eventType: AUDIT_EVENTS.WEBHOOK_SUBSCRIPTION_DELETED,
    userId: req.user!.userId,
    userRole: req.user!.role,
    actionDetails: { subscriptionId: sub.id, url: sub.url },
  });
  res.json({ success: true });
}));
