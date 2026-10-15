import { useQuery } from '@tanstack/react-query';
import { fetchLetterVolumeReport } from './api';
import { useAuthStore } from '../../state/auth.store';

/** Correspondence volume for the last 6 months — backs the dashboard widget. */
export function useLetterVolumeReport() {
  const { userId, role } = useAuthStore();
  return useQuery({
    queryKey: ['letter-volume-report', userId, role],
    queryFn: () => fetchLetterVolumeReport(),
    enabled: Boolean(userId && role),
    staleTime: 60_000,
  });
}
