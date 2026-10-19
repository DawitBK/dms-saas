// SPRINT-2: replace role-gated registrations with permission middleware and ACL-aware route guards.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authRoutes } from "../../modules/auth/auth.routes.js";
import { aclRoutes } from "../../modules/acl/acl.routes.js";
import { accessRulesRoutes } from "../../modules/access-rules/access-rules.routes.js";
import { auditRoutes } from "../../modules/audit/audit.routes.js";
import { departmentRoutes } from "../../modules/departments/departments.routes.js";
import { documentTypeRoutes } from "../../modules/document-types/documentTypes.routes.js";
import { documentRoutes } from "../../modules/documents/documents.routes.js";
import { statusPermissionsRoutes } from "../../modules/documents/statusPermissions.routes.js";
import { retentionRoutes } from "../../modules/retention/retention.routes.js";
import { signingRoutes } from "../../modules/signing/signing.routes.js";
import { workflowRoutes } from "../../modules/workflow/workflow.routes.js";
import { userRoutes } from "../../modules/users/users.routes.js";
import { legalHoldRoutes } from "../../modules/legal-hold/legal-hold.routes.js";
import { searchRoutes } from "../../modules/search/search.routes.js";
import { operationsRoutes } from "../../modules/operations/operations.routes.js";
import { notificationRoutes } from "../../modules/notifications/notifications.routes.js";
import { folderRoutes } from "../../modules/folders/folders.routes.js";
import { tenantRoutes } from "../../modules/tenants/tenants.routes.js";
import { rolesRoutes } from "../../modules/roles/roles.routes.js";
import { internalRolesRoutes } from "../../modules/roles/internal.routes.js";
import { webhookRoutes } from "../../modules/webhooks/webhook.routes.js";
import { commentRoutes } from "../../modules/comments/comments.routes.js";
import { reportRoutes } from "../../modules/reports/reports.routes.js";
import { aiRoutes } from "../../modules/ai/ai.routes.js";
import { formsRoutes } from "../../modules/forms/forms.routes.js";
import { esigningRoutes, esigningPublicRoutes } from "../../modules/esigning/esigning.routes.js";
import { lettersRoutes, lettersPublicRoutes } from "../../modules/letters/letters.routes.js";
import { orgUnitsRoutes } from "../../modules/org-units/orgUnits.routes.js";
import { bundleRoutes } from "../../modules/bundles/bundles.routes.js";
import { approvalsRoutes } from "../../modules/approvals/approvals.routes.js";
import { assignmentAdvisoryRoutes } from "../../modules/assignment-advisory/assignmentAdvisory.routes.js";
import { featureFlagsRoutes } from "../../modules/feature-flags/featureFlags.routes.js";
import { licensePublicRoutes, licenseRoutes } from "../../modules/license/license.routes.js";
import { licenseGate } from "../../modules/license/licenseGate.js";
import { authenticate, requirePermission } from "../../shared/auth.js";
import { admissionControl, tenantContext } from "../../shared/middleware.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { config } from "../../config/env.js";
import { createRedisRateLimitStore } from "../../infrastructure/cache/rateLimitStore.js";

export const v1Routes = Router();

// Platform licensing (docs/operations/PLATFORM-LICENSING.md): the module gate and, once a verified licence has
// expired, the read-only guard. FIRST on purpose, so it also covers the public e-signing routes below and the
// /operations and /internal routers; it fails open on any fault and never reads req.user. See modules/license/.
v1Routes.use(licenseGate);

v1Routes.use("/auth", authRoutes);

// External e-signing endpoints â€” authenticated by a scoped access_token in the
// body (emailed link), NOT a JWT. Mounted on the public router so external
// signers with no DMS account are not rejected by `authenticate`.
v1Routes.use(esigningPublicRoutes);

// CAMS public QR verification â€” printed letters are verified by anyone who
// scans the QR code, no account required (returns non-sensitive data only).
v1Routes.use(lettersPublicRoutes);

// Licence install: unauthenticated on purpose (an unlicensed system may have no usable login; the token signature is
// the authority) and rate-limited inside the router. See modules/license/license.routes.ts.
v1Routes.use(licensePublicRoutes);

// User-based rate limiter â€” applied after authenticate so req.user is available.
// Keys by userId for authenticated callers; falls back to IP for any unauthenticated
// request that somehow reaches this router.
const userRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_USER_PER_MINUTE,
  keyGenerator: (req) => (req as any).user?.userId ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown',
  store: createRedisRateLimitStore('user'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'ERR-RATE-LIMIT', message: 'Too many requests, please slow down' } },
});

// Apply authenticate and tenantContext to all other routes
const protectedRoutes = Router();
protectedRoutes.use(authenticate);
protectedRoutes.use(userRateLimiter);
// R-01: admission control sits between the rate limiter and tenantContext, and
// the order is the point.
//   - AFTER the rate limiter, so a single abusive caller is still capped by
//     its own per-user budget rather than being allowed to consume the shared
//     concurrency allowance.
//   - BEFORE tenantContext, because tenantContext is what checks out a pooled
//     DB connection for the whole request. Shedding after that point would
//     mean the request had already joined the pool queue, which is exactly
//     what this exists to prevent.
// Note /metrics is registered separately below, outside this router, so
// observability keeps working while the process is shedding.
protectedRoutes.use(admissionControl);
protectedRoutes.use(tenantContext);

protectedRoutes.use("/users", userRoutes);
protectedRoutes.use("/departments", departmentRoutes);
protectedRoutes.use("/document-types", documentTypeRoutes);
protectedRoutes.use("/documents", documentRoutes);
// Registered before /documents' own /:id catch-alls could ever apply — but
// since this is a distinct top-level path segment there's no actual overlap;
// kept adjacent to /documents purely for discoverability.
protectedRoutes.use("/status-permissions", statusPermissionsRoutes);
protectedRoutes.use("/audit", auditRoutes);
protectedRoutes.use("/roles", rolesRoutes);
// (No /ocr or /archive routers: those were 501 placeholder shells. OCR runs
// via the outbox OCR channel + workers; archive is a document status +
// retention concern — both features live behind their real routes.)
protectedRoutes.use("/workflow", workflowRoutes);
protectedRoutes.use("/signing", signingRoutes);
protectedRoutes.use("/retention", retentionRoutes);
protectedRoutes.use("/legal-hold", legalHoldRoutes);
protectedRoutes.use("/acl", aclRoutes);
protectedRoutes.use("/access-rules", accessRulesRoutes);
protectedRoutes.use("/search", searchRoutes);
protectedRoutes.use("/notifications", notificationRoutes);
protectedRoutes.use("/folders", folderRoutes);
protectedRoutes.use("/tenants", tenantRoutes);
protectedRoutes.use(featureFlagsRoutes); // absolute paths: /tenants/:tenantId/feature-flags
protectedRoutes.use(commentRoutes); // absolute paths: /documents/:id/comments, /comments/:id
protectedRoutes.use(esigningRoutes); // absolute paths: /documents/:id/signing, /signing/:id
protectedRoutes.use("/reports", reportRoutes);
protectedRoutes.use("/ai", aiRoutes);
protectedRoutes.use("/forms", formsRoutes);
protectedRoutes.use("/webhooks", webhookRoutes);
protectedRoutes.use("/letters", lettersRoutes);
protectedRoutes.use("/org-units", orgUnitsRoutes);
protectedRoutes.use("/bundles", bundleRoutes);
protectedRoutes.use("/approvals", approvalsRoutes);
protectedRoutes.use("/assignment-advisory", assignmentAdvisoryRoutes);

// Licence status: any authenticated user, authenticate only (no tenantContext; the answer is installation-wide).
v1Routes.use("/license", authenticate, licenseRoutes);

v1Routes.use("/operations", operationsRoutes);
// Internal admin API for the IdP's admin console — has its own shared-secret
// auth (requireInternalApiKey), so it's mounted before/outside `authenticate`.
v1Routes.use("/internal/roles", internalRolesRoutes);
v1Routes.use(protectedRoutes);

v1Routes.get("/metrics", authenticate, tenantContext, requirePermission(PERMISSIONS.OPERATIONS_MANAGE), async (_req, res) => {
  const { renderMetrics, metricsContentType } = await import("../../infrastructure/metrics.js");
  res.setHeader("Content-Type", metricsContentType);
  res.send(await renderMetrics());
});


