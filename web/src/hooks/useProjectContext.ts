import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { connectProjectContextEvents, type EventsConnection } from "../api/events";
import type { FileKind, ScanMode, ScanProgressData } from "../api/types";

/** `GET /projects/:id/context`: estado, snapshot, escaneo activo y frescura (los calcula el backend). */
export function useProjectContext(projectId: string) {
  return useQuery({
    queryKey: ["projectContext", projectId],
    queryFn: () => api.getProjectContext(projectId),
    select: (r) => r.context,
  });
}

export function useContextScans(projectId: string) {
  return useQuery({
    queryKey: ["projectContext", projectId, "scans"],
    queryFn: () => api.listScans(projectId),
    select: (r) => r.scans,
  });
}

export function useContextScan(projectId: string, scanId: string) {
  return useQuery({
    queryKey: ["projectContext", projectId, "scans", scanId],
    queryFn: () => api.getScan(projectId, scanId),
    select: (r) => r.scan,
  });
}

const FILES_PAGE = 100;

/** Índice paginado por cursor del backend. */
export function useContextFiles(projectId: string, filter: { prefix: string; kind: FileKind | "" }) {
  return useInfiniteQuery({
    queryKey: ["projectContext", projectId, "files", filter.prefix, filter.kind],
    queryFn: ({ pageParam }) =>
      api.listFiles(projectId, { prefix: filter.prefix || undefined, kind: filter.kind || undefined, cursor: pageParam, limit: FILES_PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Pide un escaneo (la caché se invalida al terminar; los cambios llegan por SSE). */
export function useRequestScan(projectId: string) {
  return useMutation({ mutationFn: (mode: ScanMode) => api.requestScan(projectId, mode) });
}

/** (T10) Conocimiento del proyecto (todas sus versiones). Clave bajo el proyecto: el SSE lo refresca. */
export function useProjectKnowledge(projectId: string) {
  return useQuery({
    queryKey: ["projectContext", projectId, "knowledge"],
    queryFn: () => api.listProjectKnowledge(projectId),
    select: (r) => r.documents,
  });
}

/** (T11) Último análisis del Project Analyst. Clave bajo el proyecto: sus eventos lo refrescan. */
export function useProjectAnalysis(projectId: string) {
  return useQuery({
    queryKey: ["projectContext", projectId, "analysis"],
    queryFn: () => api.getProjectAnalysis(projectId),
    select: (r) => r.analysis,
  });
}

/** (T11) Lanza el análisis; el estado llega por SSE. */
export function useAnalyzeProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.analyzeProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projectContext", projectId, "analysis"] }),
  });
}

/** Texto congelado que recibieron Kiro y Claude. Solo se pide al abrir la inspección. */
export function useExecutionContextBundles(executionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["executionContext", executionId],
    queryFn: () => api.getExecutionContext(executionId),
    select: (r) => r.context,
    enabled,
    // Inmutable: no hace falta volver a pedirlo.
    staleTime: Infinity,
    retry: false,
  });
}

/** Agrupa las invalidaciones de una ráfaga de eventos en una sola recarga. */
const INVALIDATE_DEBOUNCE_MS = 200;

interface ContextEventsState {
  projectId: string;
  connection: EventsConnection;
  /** Último `context.scan.progress` recibido, por escaneo. Solo cifras reales del backend. */
  progress: Record<string, ScanProgressData>;
  announcement: string;
}

/**
 * SSE del contexto del proyecto. Cada evento invalida las consultas del
 * proyecto: los estados siguen saliendo de REST. Sin eventos no hay recargas.
 */
export function useProjectContextEvents(projectId: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ContextEventsState>(() => ({ projectId, connection: "connecting", progress: {}, announcement: "" }));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["projectContext", projectId] }), INVALIDATE_DEBOUNCE_MS);
    };
    setState({ projectId, connection: "connecting", progress: {}, announcement: "" });
    const disconnect = connectProjectContextEvents(projectId, {
      onEvent: (ev) => {
        const data = ev.data as Record<string, unknown>;
        if (ev.type === "context.scan.progress") {
          const p = data as unknown as ScanProgressData;
          setState((s) => ({ ...s, progress: { ...s.progress, [p.scanId]: p } }));
          return; // el progreso no cambia nada que REST conozca
        }
        const announcement =
          ev.type === "context.scan.completed"
            ? "Escaneo completado."
            : ev.type === "context.scan.failed"
              ? "El escaneo falló."
              : ev.type === "context.scan.started"
                ? "Escaneo iniciado."
                : ev.type === "project.analysis.completed"
                  ? "Análisis del proyecto terminado."
                  : ev.type === "project.analysis.failed"
                    ? "El análisis del proyecto falló."
                    : null;
        if (announcement) setState((s) => ({ ...s, announcement }));
        invalidate();
      },
      onControl: () => invalidate(), // gap o shutdown: lo vigente lo dice REST
      onConnection: (connection) => setState((s) => ({ ...s, connection })),
    });
    return () => {
      clearTimeout(timer);
      disconnect();
    };
  }, [projectId, queryClient]);

  return state.projectId === projectId ? state : { projectId, connection: "connecting" as const, progress: {}, announcement: "" };
}
