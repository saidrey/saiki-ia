import type { ExecutionView, StageId } from "../api/types";

/**
 * «Tiempo observado» de una etapa: cuánto tiempo mostró la API la etapa como
 * `running`, según las respuestas de `GET /executions/:id` que ESTA pestaña
 * recibió (sondeo). No es la duración oficial: el backend no guarda tiempos por
 * etapa. Nunca se usa el SSE (sus eventos llegan en ráfagas al terminar cada
 * tramo del grafo).
 *
 * El inicio solo se conoce si se vio la etapa NO en curso y, en la consulta
 * siguiente, en curso; el fin, si se la vio en curso y luego fuera de curso.
 * Cada borde queda acotado entre dos consultas: de ahí el margen.
 */
export interface StageObservation {
  /** Última consulta en la que la etapa no estaba en curso (antes de empezar). */
  lastIdleAt?: number;
  /** Primera consulta en curso, si se vio la transición. */
  startSeenAt?: number;
  /** Ya estaba en curso (o terminada) la primera vez que se observó. */
  startUnknown?: boolean;
  lastRunningAt?: number;
  /** Primera consulta tras salir de "en curso". */
  endSeenAt?: number;
}

export type ExecutionObservations = Partial<Record<StageId, StageObservation>>;

/** ¿La API muestra la etapa ejecutándose? (`final_approval` esperando al humano no cuenta.) */
function isRunning(view: ExecutionView, id: StageId, status: string): boolean {
  return status === "running" && !(view.pendingApproval.required && view.pendingApproval.kind === id);
}

/** Incorpora una respuesta de la API recibida en el instante `at` (ms). */
export function observe(prev: ExecutionObservations | undefined, view: ExecutionView, at: number): ExecutionObservations {
  const next: ExecutionObservations = { ...prev };
  for (const stage of view.stages) {
    let o: StageObservation = { ...(prev?.[stage.id] ?? {}) };
    const running = isRunning(view, stage.id, stage.status);
    if (running) {
      // Vuelve a ejecutarse tras haber terminado (ciclo de corrección): nueva medición.
      if (o.endSeenAt !== undefined) o = { lastIdleAt: o.endSeenAt };
      if (o.startSeenAt === undefined && !o.startUnknown) {
        if (o.lastIdleAt !== undefined) o.startSeenAt = at;
        else o.startUnknown = true;
      }
      o.lastRunningAt = at;
    } else if (o.lastRunningAt !== undefined) {
      if (o.endSeenAt === undefined) o.endSeenAt = at;
    } else if (stage.status === "pending") {
      o.lastIdleAt = at;
    } else if (o.lastIdleAt === undefined) {
      // Terminada (o en otro estado) sin haberla visto empezar.
      o.startUnknown = true;
    }
    next[stage.id] = o;
  }
  return next;
}

export type ObservedTime =
  | { kind: "measured"; ms: number; marginMs: number }
  | { kind: "running"; ms: number; marginMs: number }
  | { kind: "unavailable"; reason: string };

/** Lectura legible de una observación. `now` solo se usa para etapas aún en curso. */
export function observedTime(o: StageObservation | undefined, now: number): ObservedTime {
  if (o === undefined || (o.startSeenAt === undefined && !o.startUnknown && o.lastRunningAt === undefined)) {
    return { kind: "unavailable", reason: "esta pestaña no ha visto la etapa en curso." };
  }
  if (o.startUnknown || o.startSeenAt === undefined || o.lastIdleAt === undefined) {
    return { kind: "unavailable", reason: "la etapa ya había empezado cuando esta pestaña empezó a observarla." };
  }
  const startMid = (o.lastIdleAt + o.startSeenAt) / 2;
  const startHalf = (o.startSeenAt - o.lastIdleAt) / 2;
  if (o.endSeenAt === undefined) {
    return { kind: "running", ms: now - startMid, marginMs: startHalf };
  }
  const lastRunning = o.lastRunningAt ?? o.startSeenAt;
  const endMid = (lastRunning + o.endSeenAt) / 2;
  const endHalf = (o.endSeenAt - lastRunning) / 2;
  return { kind: "measured", ms: Math.max(0, endMid - startMid), marginMs: startHalf + endHalf };
}
