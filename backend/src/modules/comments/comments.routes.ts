/**
 * Document comment routes.
 * Mounted at the protected router root; paths are absolute so they sit
 * alongside /documents without colliding with the documents router.
 */
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { requireACL } from "../../shared/resolveACL.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { listComments, createComment, deleteComment } from "./comments.service.js";

export const commentRoutes = Router();

// List comments on a document
commentRoutes.get(
  "/documents/:documentId/comments",
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: "document", permission: PERMISSIONS.DOCUMENT_READ, paramName: "documentId" }),
  asyncHandler(async (req, res) => {
    const data = await listComments(String(req.params.documentId), req.user!.tenantId);
    res.json({ data });
  }),
);

// Add a comment (or threaded reply via parentId)
commentRoutes.post(
  "/documents/:documentId/comments",
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  requireACL({ resourceType: "document", permission: PERMISSIONS.DOCUMENT_READ, paramName: "documentId" }),
  asyncHandler(async (req, res) => {
    const { body, parentId } = req.body ?? {};
    const comment = await createComment(req.user!, String(req.params.documentId), body, parentId ?? null);
    res.status(201).json({ data: comment });
  }),
);

// Soft-delete a comment (author, or a moderator with document:archive)
commentRoutes.delete(
  "/comments/:commentId",
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    const result = await deleteComment(req.user!, String(req.params.commentId));
    res.json(result);
  }),
);
