import { apiClient } from '../../shared/lib/apiClient';
import type { DocumentSummary } from '../documents/types';

export type BundleItem = {
  id: string;
  bundleId: string;
  documentId: string;
  position: number;
  document?: DocumentSummary & { versions?: Array<{ mimeType: string; originalFilename: string }> };
  adder?: { id: string; firstName: string; lastName: string; email: string } | null;
};

export type DocumentBundle = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'COMPILED';
  compiledDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  items?: BundleItem[];
  compiledDocument?: DocumentSummary | null;
};

export function listBundles(skip = 0, take = 50) {
  const params = new URLSearchParams({ skip: String(skip), take: String(take) });
  return apiClient<{ data: DocumentBundle[]; total: number; skip: number; take: number }>(`/bundles?${params}`);
}

export function createBundle(input: { name: string; description?: string; documentIds?: string[] }) {
  return apiClient<{ data: DocumentBundle }>('/bundles', { method: 'POST', body: JSON.stringify(input) });
}

export function addBundleItems(bundleId: string, documentIds: string[]) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}/items/bulk`, {
    method: 'POST',
    body: JSON.stringify({ documentIds }),
  });
}

export function getBundle(id: string) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${id}`);
}

export function addBundleItem(bundleId: string, documentId: string, anchor?: string, placement?: 'BEFORE' | 'AFTER') {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}/items`, {
    method: 'POST',
    body: JSON.stringify({ documentId, anchor, placement }),
  });
}

export function removeBundleItem(bundleId: string, itemId: string) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}/items/${itemId}`, { method: 'DELETE' });
}

export function reorderBundleItems(bundleId: string, itemIds: string[]) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}/items/reorder`, {
    method: 'PATCH',
    body: JSON.stringify({ itemIds }),
  });
}

/** Rename a bundle or change its description (creator or administrator; any state). */
export function updateBundle(bundleId: string, input: { name?: string; description?: string | null }) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

/** Delete a bundle's list. The documents and any compiled PDF are separate records and are kept. */
export function deleteBundle(bundleId: string) {
  return apiClient<{ data: { id: string; deleted: boolean; compiledDocumentKept: boolean } }>(`/bundles/${bundleId}`, { method: 'DELETE' });
}

export function compileBundle(bundleId: string) {
  return apiClient<{ data: DocumentBundle }>(`/bundles/${bundleId}/compile`, { method: 'POST' });
}
