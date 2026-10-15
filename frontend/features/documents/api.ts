import { apiClient } from "../../shared/lib/apiClient";
import type { DocumentSummary, CreateDocumentInput, DocumentDetail, CreateDocumentResponse } from "./types";

export function listDocuments(
  skip = 0,
  take = 50,
  filters?: { folderId?: string; status?: string; q?: string; departmentId?: string; documentTypeId?: string; ownerId?: string; checkedOut?: boolean; ocrStatus?: string; retentionRelevant?: boolean; dateFrom?: string; dateTo?: string; sortBy?: "updatedAt" | "createdAt" | "title"; sortDir?: "ASC" | "DESC"; cursor?: string }
) {
  // `cursor`, when passed, takes over pagination entirely — the backend
  // ignores `skip` in that case (see documents.service.ts's listDocuments),
  // so `skip`/`take` above only matter for the very first page or for a
  // caller that never passes a cursor at all. This keeps every existing
  // (skip-based) caller working unchanged.
  const params = new URLSearchParams({ skip: String(skip), take: String(take) });
  if (filters?.folderId) params.set("folderId", filters.folderId);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.q) params.set("q", filters.q);
  if (filters?.departmentId) params.set("departmentId", filters.departmentId);
  if (filters?.documentTypeId) params.set("documentTypeId", filters.documentTypeId);
  if (filters?.ownerId) params.set("ownerId", filters.ownerId);
  if (filters?.ocrStatus) params.set("ocrStatus", filters.ocrStatus);
  if (filters?.checkedOut) params.set("checkedOut", "true");
  if (filters?.retentionRelevant) params.set("retentionRelevant", "true");
  if (filters?.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("dateTo", filters.dateTo);
  if (filters?.sortBy) params.set("sortBy", filters.sortBy);
  if (filters?.sortDir) params.set("sortDir", filters.sortDir);
  if (filters?.cursor) params.set("cursor", filters.cursor);
  return apiClient<{ data: DocumentSummary[]; total: number; skip: number; take: number; nextCursor: string | null }>(`/documents?${params}`);
}

// "Delete" = soft delete: moves the document to trash (recoverable for 30
// days). Permanent destruction of anything past DRAFT goes through the
// staged purge flow with maker–checker (see the Recycle Bin page).
export function deleteDocument(id: string) {
  return apiClient<{ success: boolean }>(`/documents/${id}/trash`, { method: "POST" });
}

export function restoreDocument(id: string) {
  return apiClient<{ success: boolean }>(`/documents/${id}/restore`, { method: "POST" });
}

// Immediate hard delete — DRAFT documents only. Bypasses trash/cooling/
// maker-checker entirely since an unpublished draft was never a managed
// record (see backend trashService.deleteDraftPermanently).
export function deleteDraftPermanently(id: string) {
  return apiClient<{ success: boolean; message: string }>(`/documents/${id}`, { method: "DELETE" });
}

/** `certificate` defaults to false — for a document that went through
 *  e-signing, that's the copy without the certificate-of-completion page
 *  the ceremony appends (see documents.service.ts's fetchDocumentFile);
 *  pass true for the real signed copy, cert page included. No-op for a
 *  document that never went through e-signing either way. */
export function downloadDocumentUrl(id: string, opts?: { certificate?: boolean }) {
  const base = `${process.env.NEXT_PUBLIC_API_BASE_URL}/documents/${id}/download`;
  return opts?.certificate ? `${base}?certificate=true` : base;
}

export function previewDocumentUrl(id: string) {
  return `${process.env.NEXT_PUBLIC_API_BASE_URL}/documents/${id}/preview`;
}

export function fetchDashboardStats() {
  return apiClient<{
    total: number;
    byStatus: Record<string, number>;
    onLegalHold: number;
    recent: DocumentSummary[];
  }>("/documents/stats");
}

export function createDocument(input: CreateDocumentInput, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined) formData.append(key, value as string);
  });

  return apiClient<CreateDocumentResponse>("/documents", {
    method: "POST",
    body: formData,
  });
}

export function getDocument(id: string) {
  return apiClient<DocumentDetail>(`/documents/${id}`);
}

export function listDocumentTypes() {
  return apiClient<{ data: { id: string; name: string; code: string }[] }>("/document-types");
}

// Returns a bare array so it shares the SAME shape as useLookups.useDepartments()
// under the shared React Query key ['departments']. Mixing shapes on one key
// poisoned the cache cross-page (e.g. the upload form's department select going
// blank so it kept saying "select a department"). Keep both returning an array.
export async function listDepartments() {
  const res = await apiClient<{ data: { id: string; name: string; code: string; orgUnitId?: string | null }[] }>("/departments");
  return res.data ?? [];
}

export function listWorkflowTasks(params?: { page?: number; limit?: number; status?: string }) {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiClient<{ data: any[]; total: number; page: number; limit: number }>(`/workflow/tasks${suffix}`);
}

export function getWorkflowInstanceTasks(instanceId: string) {
  return apiClient<{ data: any[] }>(`/workflow/instances/${instanceId}/tasks`);
}

export function submitTaskDecision(taskId: string, decision: "APPROVE" | "REJECT", reason?: string) {
  return apiClient(`/workflow/tasks/${taskId}/decide`, {
    method: "POST",
    body: JSON.stringify({ decision, reason })
  });
}

export function listAuditLogs(params?: {
  documentId?: string;
  eventType?: string;
  q?: string;
  skip?: number;
  take?: number;
}) {
  const query = new URLSearchParams();
  if (params?.documentId) query.set("documentId", params.documentId);
  if (params?.eventType) query.set("eventType", params.eventType);
  if (params?.q) query.set("q", params.q);
  if (params?.skip !== undefined) query.set("skip", String(params.skip));
  if (params?.take !== undefined) query.set("take", String(params.take));
  return apiClient<{ data: any[]; total: number; skip: number; take: number }>(`/audit?${query}`);
}
