import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ApplyMode, Project } from "../api/types";

/** `GET /projects` (todos; la salud la calcula el backend al leer). */
export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: api.listProjects, select: (r) => r.projects });
}

/** Proyectos por id, para etiquetar sesiones y filas. */
export function useProjectsById(): Map<string, Project> | undefined {
  const { data } = useProjects();
  return useMemo(() => (data ? new Map(data.map((p) => [p.id, p])) : undefined), [data]);
}

export function useProjectHistory(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["projects", projectId, "history"],
    queryFn: () => api.getProjectHistory(projectId),
    select: (r) => r.history,
    enabled,
  });
}

// Las mutaciones invalidan toda la caché al terminar (queryClient).

export function useRegisterProject() {
  return useMutation({
    mutationFn: (body: { name: string; path: string; applyMode: ApplyMode; confirmRealApply?: boolean }) => api.registerProject(body),
  });
}

export function useUpdateProject(projectId: string) {
  return useMutation({
    mutationFn: (body: { name?: string; applyMode?: ApplyMode; confirmRealApply?: boolean }) => api.updateProject(projectId, body),
  });
}

export function useSetProjectActive(projectId: string) {
  return useMutation({ mutationFn: (active: boolean) => api.setProjectActive(projectId, active) });
}
