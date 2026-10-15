import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../shared/lib/apiClient";

// §1 FIX: Re-export shared lookup hooks from the canonical location.
export { useDocumentTypes } from '../../shared/hooks/useLookups';

export function useRetentionClasses() {
  return useQuery({
    queryKey: ["retention-classes"],
    queryFn: async () => {
      const res = await apiClient<{ data: any[] }>("/retention");
      return res;
    },
    staleTime: 5 * 60_000,  // 5 minutes — settings data rarely changes
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await apiClient<{ data: any[] }>("/users");
      return res;
    },
    staleTime: 30_000,  // 30 seconds — user list changes occasionally
  });
}

// §1 FIX: Re-export shared lookup hooks from the canonical location.
export { useDepartments } from '../../shared/hooks/useLookups';

export function useSystemHealth() {
  return useQuery({
    queryKey: ["system-health"],
    queryFn: async () => {
      const res = await apiClient<any>("/operations/health");
      return res;
    },
    staleTime: 15_000,  // 15 seconds — system health updates frequently
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      apiClient(`/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useCreateDocumentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      apiClient("/document-types", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document-types"] }),
  });
}
