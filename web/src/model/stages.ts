import type { ExecutionLifecycle, ExecutionStage, ExecutionView, StageId, StageStatus } from "../api/types";

/**
 * Lectura de `ExecutionView` para pintar el pipeline. El backend expone el ciclo
 * de vida, la etapa activa y la decisión esperada: aquí solo se traducen, sin
 * deducir estados a partir de combinaciones.
 */

/** Estado visual de una estación: el `status` de la API, o "awaiting" si es la etapa que espera decisión. */
export type StationState = StageStatus | "awaiting";

export const STATE_LABEL: Record<StationState, string> = {
  pending: "Pendiente",
  running: "En curso",
  done: "Completada",
  failed: "Error",
  skipped: "Omitida",
  not_applicable: "No aplica",
  awaiting: "Espera tu decisión",
};

export const LIFECYCLE_LABEL: Record<ExecutionLifecycle, string> = {
  running: "En curso",
  awaiting_decision: "Espera tu decisión",
  interrupted: "Interrumpida",
  completed: "Completada",
  failed: "Fallida",
  stopped: "Detenida",
};

const KIND_LABEL: Record<string, string> = {
  hu_review: "revisión de la HU",
  feasibility_partial: "decisión de viabilidad parcial",
  final_approval: "aprobación final de la propuesta",
};

/** Nombre legible de un tipo de aprobación; si la API trae uno desconocido, se muestra tal cual. */
export function approvalKindLabel(kind: string | undefined): string {
  if (kind === undefined) return "decisión pendiente";
  return KIND_LABEL[kind] ?? kind;
}

/** La etapa en la que se espera la decisión (`awaitingDecision.stageId`) se pinta como espera, no como ejecución. */
export function stationState(stage: ExecutionStage, view: ExecutionView): StationState {
  if (view.awaitingDecision?.stageId === stage.id) return "awaiting";
  return stage.status;
}

/** Tras qué etapa va la señal de una puerta que no es etapa (HU, viabilidad parcial), o null. */
export function gateAfterStage(view: ExecutionView): StageId | null {
  return view.awaitingDecision?.afterStageId ?? null;
}

/** ¿El backend está trabajando ahora mismo en esta ejecución? (Lo dice el backend.) */
export function isExecutionActive(view: ExecutionView): boolean {
  return view.lifecycle === "running";
}

export function isTerminal(view: ExecutionView): boolean {
  return view.lifecycle === "completed" || view.lifecycle === "failed" || view.lifecycle === "stopped";
}

export type TrackState = "off" | "done" | "active" | "approach";

/** Estado del tramo de vía que sale de la estación `index` hacia la siguiente. */
export function trackAfter(states: StationState[], index: number, gateAfterIndex: number): TrackState {
  const from = states[index];
  const to = states[index + 1];
  if (to === undefined) return "off";
  if (gateAfterIndex === index) return "approach";
  if (from !== "done") return "off";
  if (to === "done" || to === "skipped") return "done";
  if (to === "awaiting") return "approach";
  if (to === "running") return "active";
  return "off";
}

/** Resumen corto para lectores de pantalla y la mini-vía del inicio. */
export function progressSummary(view: ExecutionView): string {
  const done = view.stages.filter((s) => s.status === "done").length;
  const state = view.awaitingDecision
    ? `espera tu decisión: ${approvalKindLabel(view.awaitingDecision.kind)}`
    : LIFECYCLE_LABEL[view.lifecycle].toLowerCase();
  const parts = [`${done} de ${view.stages.length} etapas completadas`, state];
  const failed = view.stages.find((s) => s.status === "failed");
  if (failed) parts.push(`error en ${failed.label}`);
  return parts.join("; ");
}

/**
 * Etapa que el inspector muestra si el usuario no eligió otra: la que se está
 * ejecutando, la que espera decisión, la anterior a una señal, o la última que
 * dejó de estar pendiente.
 */
export function defaultSelectedStage(view: ExecutionView): StageId {
  if (view.activeStage !== "none") return view.activeStage;
  if (view.awaitingDecision?.stageId) return view.awaitingDecision.stageId;
  if (view.awaitingDecision?.afterStageId) return view.awaitingDecision.afterStageId;
  const started = view.stages.filter((s) => s.status !== "pending");
  return (started[started.length - 1] ?? view.stages[0]).id;
}

/**
 * Etiqueta de estado. En una ejecución definitiva, una etapa que sigue en
 * `pending` ya no se ejecutará: "No se ejecutó" (el valor crudo sigue en el inspector).
 */
export function stateLabel(state: StationState, view: ExecutionView): string {
  if (state === "pending" && isTerminal(view)) return "No se ejecutó";
  return STATE_LABEL[state];
}
