import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { searchDocuments, saveSearch, getSavedSearches, deleteSavedSearch } from "./search.service.js";

export const searchRoutes = Router();

searchRoutes.get("/", requirePermission(PERMISSIONS.SEARCH_READ), asyncHandler(async (req, res) => {
  const user = (req as any).user;
  const {
    q = "", departmentId, departmentCode, documentTypeCode, status, securityClassification,
    isOnLegalHold, dateFrom, dateTo, retentionClass, facets,
  } = req.query;

  const filters: any = {};
  // departmentId is the precise, collision-free filter; departmentCode is
  // accepted only for saved searches serialized before it existed (see
  // search.service.ts's SearchFilters comment). Prefer departmentId when both
  // are present — a caller that has already resolved to an id has more
  // precise intent than a stale code.
  if (typeof departmentId === "string") filters.departmentId = departmentId;
  else if (typeof departmentCode === "string") filters.departmentCode = departmentCode;
  if (typeof documentTypeCode === "string") filters.documentTypeCode = documentTypeCode;
  if (typeof status === "string") filters.status = status;
  if (typeof securityClassification === "string") filters.securityClassification = securityClassification;
  if (isOnLegalHold === "true") filters.isOnLegalHold = true;
  if (isOnLegalHold === "false") filters.isOnLegalHold = false;
  if (typeof dateFrom === "string") filters.dateFrom = dateFrom;
  if (typeof dateTo === "string") filters.dateTo = dateTo;
  if (typeof retentionClass === "string") filters.retentionClass = retentionClass;
  if (facets === "true") filters.facets = true;

  const result = await searchDocuments(user, String(q), filters);
  res.json(result);
}));

searchRoutes.post("/saved", requirePermission(PERMISSIONS.SEARCH_READ), asyncHandler(async (req, res) => {
  const user = (req as any).user;
  const { name, query, filters } = req.body;
  if (!name || typeof name !== "string") throw new Error("Invalid name");
  
  const saved = await saveSearch(user.userId, name, query || "", filters ? JSON.stringify(filters) : undefined);
  res.status(201).json(saved);
}));

searchRoutes.get("/saved", requirePermission(PERMISSIONS.SEARCH_READ), asyncHandler(async (req, res) => {
  const user = (req as any).user;
  const list = await getSavedSearches(user.userId);
  res.json({ data: list });
}));

searchRoutes.delete("/saved/:id", requirePermission(PERMISSIONS.SEARCH_READ), asyncHandler(async (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const result = await deleteSavedSearch(id, user.userId);
  res.json(result);
}));
