/**
 * Ciclo de vida de una ejecución (mini-fase de estabilización, hallazgo 13).
 *
 * ÚNICA fuente de verdad para clasificar una ejecución; la usan la vista
 * (`ExecutionView`) y los eventos (`execution.*`). Antes había dos
 * clasificaciones que se contradecían (un rechazo humano se emitía como
 * `execution.failed`).
 *
 * - running: SaikiCore está ejecutando el grafo de esta ejecución AHORA.
 * - awaiting_decision: el grafo está PAUSADO en una puerta humana (interrupt real).
 * - interrupted: quedó trabajo pendiente, sin pausa ni ejecución en marcha (el
 *   proceso se detuvo a mitad, p. ej. reinicio del backend). No se reanuda solo.
 * - completed: aplicado (con o sin fallos en los checks del proyecto).
 * - failed: fallo técnico (agente, aplicación, verificación).
 * - stopped: parada por decisión humana o por política (rechazo, límites, bloqueo).
 *
 * No existe "cancelled": el sistema no soporta cancelar ejecuciones.
 */
export type ExecutionLifecycle = "running" | "awaiting_decision" | "interrupted" | "completed" | "failed" | "stopped";

export const COMPLETED_PHASES: readonly string[] = ["applied", "applied_with_test_failures"];
export const FAILED_PHASES: readonly string[] = [
  "failed",
  "tech_failed",
  "dev_failed",
  "review_failed",
  "rolled_back",
  "unrecoverable",
  "apply_blocked",
];
export const STOPPED_PHASES: readonly string[] = [
  "rejected",
  "revision_limit",
  "blocked",
  "final_approval_rejected",
  "reviews_exhausted",
];

/** Clasificación de una fase terminal, o null si la fase no es terminal. */
export function terminalLifecycle(phase: string): "completed" | "failed" | "stopped" | null {
  if (COMPLETED_PHASES.includes(phase)) return "completed";
  if (FAILED_PHASES.includes(phase)) return "failed";
  if (STOPPED_PHASES.includes(phase)) return "stopped";
  return null;
}

export function isTerminalLifecycle(l: ExecutionLifecycle): boolean {
  return l === "completed" || l === "failed" || l === "stopped";
}

/** Ejecución del grafo en curso en este proceso (SaikiCore la registra). */
export interface ActiveRun {
  since: string;
  /** Qué la disparó: un mensaje de desarrollo o una decisión humana. */
  trigger: "message" | "decision";
}

export function deriveLifecycle(input: {
  phase: string;
  active: boolean;
  /** Tipo de la puerta en la que el grafo está pausado (interrupt real), o null. */
  pausedKind: string | null;
  /** Nodos pendientes según el checkpoint. */
  next: readonly string[];
}): ExecutionLifecycle {
  if (input.active) return "running";
  const terminal = terminalLifecycle(input.phase);
  if (terminal !== null) return terminal;
  if (input.pausedKind !== null) return "awaiting_decision";
  // Trabajo pendiente sin pausa ni ejecución activa (o estado no terminal sin
  // siguiente nodo, que no debería ocurrir): no se finge que avanza.
  return "interrupted";
}
