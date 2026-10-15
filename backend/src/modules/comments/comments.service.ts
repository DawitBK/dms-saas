/**
 * Document comments / annotations — threaded, tenant-scoped, soft-deletable.
 * Document access is gated at the route (requirePermission + requireACL on the
 * document); this layer enforces tenant isolation and author/moderator rules.
 */
import { z } from "zod";
import { AppError } from "../../core/AppError.js";
import { Document, DocumentComment, User } from "../../infrastructure/database/index.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { PERMISSIONS, userHasPermission } from "../../config/permissions.js";
import { assertACLAllow } from "../../shared/resolveACL.js";
import { assertNotTrashed } from "../../shared/documentGuards.js";
import type { AuthenticatedUser } from "../../shared/auth.js";

const MAX_BODY = 5000;

// API-1: the route forwarded `body`/`parentId` with no schema at all — body
// length WAS checked manually below, but parentId had no shape validation,
// so a non-UUID (a number, an object) flowed straight into
// DocumentComment.findByPk() and failed with an opaque Sequelize error
// instead of a clean 400. Real Zod validation, matching the pattern every
// other module in this codebase uses (schema.parse() inside the service).
const createCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment body is required").max(MAX_BODY, `Comment exceeds ${MAX_BODY} characters`),
  parentId: z.string().uuid().nullable().optional(),
});

function toView(c: any) {
  const author = c.author ?? (typeof c.get === "function" ? c.get("author") : null);
  return {
    id: c.id,
    documentId: c.documentId,
    parentId: c.parentId ?? null,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: author
      ? { id: author.id, firstName: author.firstName, lastName: author.lastName, email: author.email }
      : null,
  };
}

const authorInclude = {
  model: User,
  as: "author",
  attributes: ["id", "firstName", "lastName", "email"],
};

async function requireDocumentInTenant(
  documentId: string,
  tenantId: string,
  opts: { checkTrashed?: boolean } = {},
) {
  const doc = await Document.findByPk(documentId, { attributes: ["id", "tenantId", "status", "deletedAt"] });
  if (!doc || doc.tenantId !== tenantId) {
    throw new AppError(404, "ERR-NOT-FOUND", "Document not found");
  }
  // DATA-5: every other mutation path on a document (bundles, approvals,
  // signing, legal-hold, lock, preview) is guarded by assertNotTrashed via
  // shared/documentGuards.ts — comments had no such check anywhere, so a
  // document sitting in trash (up to 37 days before purge) could still
  // receive new comments. Only the write path checks this; reading existing
  // comments on an already-trashed document is unaffected.
  if (opts.checkTrashed) assertNotTrashed(doc);
}

export async function listComments(documentId: string, tenantId: string) {
  await requireDocumentInTenant(documentId, tenantId);
  const comments = await DocumentComment.findAll({
    where: { documentId, isDeleted: false },
    include: [authorInclude],
    order: [["createdAt", "ASC"]],
  });
  return comments.map(toView);
}

export async function createComment(
  user: AuthenticatedUser,
  documentId: string,
  body: string,
  parentId?: string | null,
) {
  const { body: text, parentId: validParentId } = createCommentSchema.parse({ body, parentId });

  await requireDocumentInTenant(documentId, user.tenantId, { checkTrashed: true });

  if (validParentId) {
    const parent = await DocumentComment.findByPk(validParentId, { attributes: ["id", "documentId"] });
    if (!parent || parent.documentId !== documentId) {
      throw new AppError(400, "ERR-VALIDATION", "Invalid parent comment");
    }
  }

  const created = await DocumentComment.create({
    documentId,
    tenantId: user.tenantId,
    authorId: user.userId,
    parentId: validParentId ?? null,
    body: text,
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: { action: "comment_added", commentId: created.id, parentId: validParentId ?? null },
    isSuccess: true,
  });

  const withAuthor = await DocumentComment.findByPk(created.id, { include: [authorInclude] });
  return toView(withAuthor);
}

export async function deleteComment(user: AuthenticatedUser, commentId: string) {
  const comment = await DocumentComment.findByPk(commentId);
  if (!comment || comment.isDeleted || comment.tenantId !== user.tenantId) {
    throw new AppError(404, "ERR-NOT-FOUND", "Comment not found");
  }

  const isAuthor = comment.authorId === user.userId;
  const canModerate = userHasPermission(
    { role: user.role, permissions: user.permissions },
    PERMISSIONS.DOCUMENT_ARCHIVE,
  );
  if (!isAuthor && !canModerate) {
    throw new AppError(403, "ERR-PERMISSION-DENIED", "Cannot delete another user's comment");
  }
  // M14: the moderator path used to be tenant-wide — any document:archive
  // holder could delete anyone's comment on any document, including documents
  // they have no ACL access to at all (the DELETE route is keyed by comment
  // id, so no route-level requireACL can cover it). Moderators must now hold
  // the archive ACL on the underlying document; admins pass via the
  // ACL_BYPASS_ADMIN branch inside assertACLAllow.
  if (!isAuthor) {
    await assertACLAllow(
      user.userId,
      user.roles,
      user.tenantId,
      { resourceType: "document", resourceId: comment.documentId, permission: PERMISSIONS.DOCUMENT_ARCHIVE },
      user.permissions,
    );
  }

  await comment.update({ isDeleted: true, updatedAt: new Date() });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    userId: user.userId,
    userRole: user.role,
    documentId: comment.documentId,
    actionDetails: { action: "comment_deleted", commentId },
    isSuccess: true,
  });

  return { success: true };
}
