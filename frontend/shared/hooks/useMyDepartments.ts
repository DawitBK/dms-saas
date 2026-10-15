'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';

export type MyDepartment = { id: string; name: string; code: string; orgUnitId?: string | null };

/**
 * Single source of truth for "which departments (and which org units) does
 * the current user belong to". Upload, Letters/new, Signing, Search and
 * Forms/fill each used to hand-roll their own `/users/me` query and their
 * own myDeptIds/myOrgUnitIds derivation, with the inline response type
 * sometimes silently dropping orgUnitId (signing/page.tsx, forms/fill/page.tsx)
 * while others kept it — org-unit resolution only worked wherever a copy
 * happened to include the field. This is the one place that shape is
 * defined now, so every caller sees the same fields and the same logic.
 *
 * `enabled` lets a caller with its own "bypass everywhere" permission (e.g.
 * ACL_BYPASS_ADMIN, LETTER_READ_ALL, SEARCH_SCOPE_ALL) skip the fetch
 * entirely -- pass `!canBypass`.
 */
export function useMyDepartments(enabled = true) {
  const { data: meRes } = useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => apiClient<{ departments?: MyDepartment[] }>('/users/me'),
    enabled,
    // Not 5 minutes: this gates which departments/org units every caller's
    // picker offers, and a fresh admin assignment must show up the next time
    // the page opens, not minutes later while it keeps serving a stale
    // "you belong to nothing" snapshot.
    staleTime: 0,
  });

  // Memoised: several callers feed this straight into a useResetOnChange
  // dependency list, where an always-changing `?? []` fallback identity is
  // an infinite render loop, not just wasted work (see upload/page.tsx's
  // original comment on this exact footgun).
  const departments = useMemo(() => meRes?.departments ?? [], [meRes]);

  const myDepartmentIds = useMemo(() => new Set(departments.map((d) => d.id)), [departments]);

  const myOrgUnitIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of departments) if (d.orgUnitId) ids.add(d.orgUnitId);
    return Array.from(ids).sort();
  }, [departments]);

  return { meRes, departments, myDepartmentIds, myOrgUnitIds };
}
