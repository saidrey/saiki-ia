/**
 * Geometría de la vía del pipeline (presentación pura; el flujo sigue siendo
 * lineal y de 9 etapas). Las etapas se muestran en filas de 3; el tramo que
 * cambia de fila rodea las etiquetas: sale por la derecha, baja entre filas y
 * entra por la izquierda.
 */

export interface NodeBox {
  /** Centro del nodo, relativo al contenedor. */
  x: number;
  y: number;
  /** Radio del nodo (el tramo empieza y acaba en su borde). */
  r: number;
  /** Borde inferior de la celda de la etapa (incluye su texto). */
  cellBottom: number;
  /** Borde superior de la celda de la etapa. */
  cellTop: number;
}

export interface Segment {
  d: string;
  /** Punto medio del tramo (para la puerta humana). */
  mid: { x: number; y: number };
}

/** Grupos de presentación: tres etapas por fila. */
export const PIPELINE_PHASES = ["Análisis", "Desarrollo y revisión", "Entrega"] as const;
export const STAGES_PER_ROW = 3;

const round = (n: number) => Math.round(n * 10) / 10;

/** Trazado SVG del tramo que va del nodo `a` al `b`. */
export function segmentPath(a: NodeBox, b: NodeBox, corner = 16, gutter = 36): Segment {
  // Misma fila: recto, de borde a borde.
  if (Math.abs(a.y - b.y) < 2) {
    const x1 = a.x + a.r;
    const x2 = b.x - b.r;
    return { d: `M${round(x1)} ${round(a.y)}H${round(x2)}`, mid: { x: round((x1 + x2) / 2), y: round(a.y) } };
  }
  // Una sola columna (pantallas estrechas): recto hacia abajo.
  if (Math.abs(a.x - b.x) < 2) {
    const y1 = a.y + a.r;
    const y2 = b.y - b.r;
    return { d: `M${round(a.x)} ${round(y1)}V${round(y2)}`, mid: { x: round(a.x), y: round((y1 + y2) / 2) } };
  }
  // Cambio de fila: derecha → baja entre filas → izquierda → entra por la izquierda.
  const xr = a.x + a.r + gutter;
  const xl = b.x - b.r - gutter;
  const my = (a.cellBottom + b.cellTop) / 2;
  const c = corner;
  const p = [
    `M${round(a.x + a.r)} ${round(a.y)}`,
    `H${round(xr - c)}`,
    `Q${round(xr)} ${round(a.y)} ${round(xr)} ${round(a.y + c)}`,
    `V${round(my - c)}`,
    `Q${round(xr)} ${round(my)} ${round(xr - c)} ${round(my)}`,
    `H${round(xl + c)}`,
    `Q${round(xl)} ${round(my)} ${round(xl)} ${round(my + c)}`,
    `V${round(b.y - c)}`,
    `Q${round(xl)} ${round(b.y)} ${round(xl + c)} ${round(b.y)}`,
    `H${round(b.x - b.r)}`,
  ];
  return { d: p.join(""), mid: { x: round((xr + xl) / 2), y: round(my) } };
}

/** Estados de etapa tal como los pinta el pipeline (ver `stationState`). */
type Lit = "pending" | "running" | "done" | "failed" | "skipped" | "not_applicable" | "awaiting";

export interface Handoff {
  /** Etapa que recibe la luz (el tramo es el que llega desde la anterior). */
  to: number;
  /** Color del relevo: agente trabajando, persona esperada o recorrido completado. */
  tone: "agent" | "human" | "trail";
}

const TONE: Partial<Record<Lit, Handoff["tone"]>> = { running: "agent", awaiting: "human", done: "trail" };

/**
 * Relevos de luz entre una observación y la siguiente: una etapa que se
 * enciende (en curso, espera tu decisión o completada) tras otra ya
 * completada. Sin observación previa no hay relevos (no se anima el historial).
 * Varias a la vez → en orden, para mostrarlas en cascada.
 */
export function handoffsBetween(prev: readonly Lit[] | null, next: readonly Lit[]): Handoff[] {
  if (prev === null || prev.length !== next.length) return [];
  const out: Handoff[] = [];
  for (let j = 1; j < next.length; j++) {
    const tone = TONE[next[j]];
    // Solo cuando la luz LLEGA: la etapa estaba apagada (no en curso, esperando ni completada).
    if (tone && TONE[prev[j]] === undefined && next[j - 1] === "done") out.push({ to: j, tone });
  }
  return out;
}
