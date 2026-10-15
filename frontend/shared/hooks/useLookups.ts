// §1 FIX: Single source of truth for department/document-type lookups.
// Both hooks return bare arrays (not the { data: [...] } envelope) so consumers
// can safely call .find()/.map() without shape mismatches. The query keys are
// shared across the entire app, preventing cache-collision crashes like the
// upload page's "departments.find is not a function" error.

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';

export type Department = {
  id: string;
  code: string;
  name: string;
  description?: string;
  parentId?: string | null;
  orgUnitId?: string | null;
};

export type OrgUnit = {
  id: string;
  code: string;
  name: string;
  unitType?: string;
};

export type DocumentType = {
  id: string;
  code: string;
  name: string;
  description?: string;
};

export function useDepartments() {
  return useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: async () => {
      const res = await apiClient<{ data: Department[] }>('/departments');
      return res.data ?? [];
    },
    // Was 5 minutes ("settings data rarely changes") — but Upload/Signing/
    // Forms/Search/Letters all narrow this list down by the caller's own
    // membership, so a department created (or a user assigned to one) less
    // than 5 minutes ago silently kept not appearing in those pickers even on
    // a fresh page visit. 30s still avoids refetching on every re-render
    // without leaving a just-made admin change invisible for minutes.
    staleTime: 30_000,
  });
}

// Query key deliberately distinct from crudPanels.tsx's own `['org-units']`
// useQuery (envelope-shaped: `{ data: [...] }`) — this hook unwraps to a bare
// array like useDepartments()/`['departments']` above does relative to
// crudPanels.tsx's `['admin-departments']`. Same cache key + different
// shapes returned by different queryFns is exactly the cache-collision this
// file's top comment warns about (the historical "departments.find is not a
// function" bug): whichever query runs first wins the cache entry and every
// other shape's consumer breaks.
export function useOrgUnits() {
  return useQuery<OrgUnit[]>({
    queryKey: ['org-units-lookup'],
    queryFn: async () => {
      const res = await apiClient<{ data: OrgUnit[] }>('/org-units');
      return res.data ?? [];
    },
    // See useDepartments() above for why this dropped from 5 minutes.
    staleTime: 30_000,
  });
}

export function useDocumentTypes() {
  return useQuery<DocumentType[]>({
    queryKey: ['document-types'],
    queryFn: async () => {
      const res = await apiClient<{ data: DocumentType[] }>('/document-types');
      return res.data ?? [];
    },
    // See useDepartments() above for why this dropped from 5 minutes.
    staleTime: 30_000,
  });
}
