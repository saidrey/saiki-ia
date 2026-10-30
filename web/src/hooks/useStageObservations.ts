import { useSyncExternalStore } from "react";
import type { ExecutionView } from "../api/types";
import { observe, type ExecutionObservations } from "../model/observations";

/**
 * Observaciones de etapas hechas por ESTA pestaña (memoria, sin persistir: al
 * recargar se empieza de cero, como corresponde a «observado en esta pestaña»).
 */
const store = new Map<string, ExecutionObservations>();
const lastAt = new Map<string, number>();
const listeners = new Set<() => void>();

/** Registra una respuesta de `GET /executions/:id` recibida en `at` (una vez por respuesta). */
export function recordExecutionSnapshot(view: ExecutionView, at: number): void {
  if (lastAt.get(view.executionId) === at) return;
  lastAt.set(view.executionId, at);
  store.set(view.executionId, observe(store.get(view.executionId), view, at));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStageObservations(executionId: string): ExecutionObservations | undefined {
  return useSyncExternalStore(subscribe, () => store.get(executionId));
}
