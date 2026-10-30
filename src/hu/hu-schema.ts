/**
 * Esquema tipado de una Historia de Usuario (HU) analizada (Fase 9).
 *
 * Es el "contrato de salida" del rol `huAnalyst`: la respuesta del agente
 * (texto) se convierte y se VALIDA contra esta forma. Un resultado que no
 * cumple el esquema NO se acepta (sin fallback silencioso): se reporta error.
 *
 * KISS: validacion propia con TypeScript + chequeos en runtime, sin anadir una
 * libreria de schemas (no son necesarias para esta estructura).
 */
import { createHash } from "node:crypto";

/** Una tarea propuesta, con orden explicito. */
export interface HuTask {
  /** Orden 1..n. */
  order: number;
  /** Descripcion de la tarea. */
  description: string;
}

/** Un criterio de aceptacion verificable. */
export interface AcceptanceCriterion {
  id: string;
  description: string;
}

/**
 * Historia de Usuario analizada y estructurada. Los campos cubren lo que pide
 * el enunciado de la Fase 9.
 */
export interface AnalyzedHu {
  /** Resumen breve de la HU. */
  summary: string;
  /** Necesidad o comportamiento esperado. */
  need: string;
  /** Tareas propuestas, ordenadas. */
  tasks: HuTask[];
  /** Criterios de aceptacion verificables. */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Supuestos asumidos. */
  assumptions: string[];
  /** Preguntas pendientes para el humano. */
  openQuestions: string[];
  /** Dependencias identificadas. */
  dependencies: string[];
}

/** Resultado de validar una HU candidata. */
export type HuValidation =
  | { ok: true; hu: AnalyzedHu }
  | { ok: false; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Valida un objeto candidato contra el esquema `AnalyzedHu`.
 *
 * Reglas de validez (una HU util no puede estar vacia en lo esencial):
 * - `summary` y `need` deben ser strings no vacios.
 * - `tasks` debe tener al menos 1 tarea con `order` numerico y descripcion.
 * - `acceptanceCriteria` debe tener al menos 1 criterio con id y descripcion.
 * - `assumptions`, `openQuestions`, `dependencies` deben ser listas de strings
 *   (pueden estar vacias).
 *
 * Devuelve `ok:false` con la lista de errores si algo falla. NUNCA "arregla"
 * una HU invalida ni la da por buena.
 */
export function validateHu(candidate: unknown): HuValidation {
  const errors: string[] = [];

  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["La HU no es un objeto."] };
  }
  const c = candidate as Record<string, unknown>;

  if (!isNonEmptyString(c.summary)) errors.push("summary vacio o invalido.");
  if (!isNonEmptyString(c.need)) errors.push("need vacio o invalido.");

  if (!Array.isArray(c.tasks) || c.tasks.length === 0) {
    errors.push("tasks debe tener al menos una tarea.");
  } else {
    c.tasks.forEach((t, i) => {
      const task = t as Record<string, unknown>;
      if (typeof task.order !== "number") errors.push(`tasks[${i}].order no es numero.`);
      if (!isNonEmptyString(task.description)) errors.push(`tasks[${i}].description vacio.`);
    });
  }

  if (!Array.isArray(c.acceptanceCriteria) || c.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria debe tener al menos un criterio.");
  } else {
    c.acceptanceCriteria.forEach((a, i) => {
      const crit = a as Record<string, unknown>;
      if (!isNonEmptyString(crit.id)) errors.push(`acceptanceCriteria[${i}].id vacio.`);
      if (!isNonEmptyString(crit.description)) errors.push(`acceptanceCriteria[${i}].description vacio.`);
    });
  }

  if (!isStringArray(c.assumptions)) errors.push("assumptions debe ser lista de strings.");
  if (!isStringArray(c.openQuestions)) errors.push("openQuestions debe ser lista de strings.");
  if (!isStringArray(c.dependencies)) errors.push("dependencies debe ser lista de strings.");

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, hu: candidate as AnalyzedHu };
}

/**
 * (Fase 21) Hash SHA-256 ESTABLE de la HU que el humano revisa. Incluye el
 * número de versión: una decisión sobre una versión anterior no coincide aunque
 * el contenido regenerado sea idéntico. Campos en orden fijo (determinista).
 */
export function hashHuReview(hu: AnalyzedHu, version: number): string {
  const canonical = JSON.stringify({
    version,
    summary: hu.summary,
    need: hu.need,
    tasks: hu.tasks.map((t) => ({ order: t.order, description: t.description })),
    acceptanceCriteria: hu.acceptanceCriteria.map((c) => ({ id: c.id, description: c.description })),
    assumptions: hu.assumptions,
    openQuestions: hu.openQuestions,
    dependencies: hu.dependencies,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
