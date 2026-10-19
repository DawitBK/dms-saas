'use client';

// shared/hooks/useLicense.ts
//
// GET /license/status (any signed-in user), polled gently: the backend itself only re-reads the licence from SSO every
// LICENSE_POLL_SECONDS (default 5 minutes), so asking more often buys nothing. A failure (older backend, API down)
// leaves `status` undefined, which every consumer treats as "no restriction": the UI never blocks on its own.
import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../../state/auth.store';
import { apiClient } from '../lib/apiClient';
import {
  LICENSE_QUERY_KEY,
  isModuleEnabled as moduleEnabled,
  type LicenseModuleKey,
  type LicenseStatus,
} from '../lib/license';

const FIVE_MINUTES = 5 * 60_000;

export function useLicenseStatus() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const userId = useAuthStore((s) => s.userId);
  return useQuery<LicenseStatus>({
    queryKey: LICENSE_QUERY_KEY,
    queryFn: () => apiClient<LicenseStatus>('/license/status'),
    enabled: !!accessToken && !!userId,
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** `isModuleOn` has a stable identity until the licence status itself changes (safe as a memo / change key). */
export function useLicenseModules() {
  const { data: status } = useLicenseStatus();
  const isModuleOn = useCallback((key: LicenseModuleKey) => moduleEnabled(status, key), [status]);
  return useMemo(() => ({ status, isModuleOn, readOnly: !!status?.readOnly }), [status, isModuleOn]);
}
