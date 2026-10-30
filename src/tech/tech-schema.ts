import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Esquema tipado del Análisis Técnico (Fase 10).
 *
 * Es el "contrato de salida" del rol `technicalAnalyst`: estudia el código
 * existente (solo lectura) y explica QUE cambiar y DONDE, relacionandolo con la
 * HU aprobada. NO implementa cambios ni produce una propuesta aplicable.
 *
 * Requisito clave del PO: las rutas referenciadas deben EXISTIR de verdad. El
 * validador verifica cada ruta en disco; si no existe o no es verificable, se
 * marca explicitamente (no se inventa).
 */

/** Un archivo afectado por los cambios, con su rol actual. */
export interface AffectedFile {
  /** Ruta relativa al root del proyecto. */
  path: string;
  /** Responsabilidad actual del archivo. */
  responsibility: string;
  /** true si la ruta se verifico que existe en disco. */
  exists?: boolean;
}

/** Cambio propuesto para un archivo (descriptivo, NO aplicable). */
export interface ProposedChange {
  path: string;
  /** Qué cambiar y por qué (texto). */
  change: string;
}

/** Relación de un cambio con una tarea / criterio de la HU. */
export interface TraceabilityLink {
  /** id de tarea o criterio de la HU. */
  ref: string;
  /** Cómo el análisis lo cubre. */
  note: string;
}

/** Análisis técnico estructurado. */
export interface TechnicalAnalysis {
  /** Resumen del análisis. */
  summary: string;
  /** Explicación del flujo actual relevante. */
  currentFlow: string;
  /** Archivos afectados (rutas + responsabilidad). */
  affectedFiles: AffectedFile[];
  /** Cambios propuestos por archivo. */
  proposedChanges: ProposedChange[];
  /** Relación con tareas y criterios de aceptación de la HU. */
  traceability: TraceabilityLink[];
  /** Dependencias identificadas. */
  dependencies: string[];
  /** Riesgos identificados. */
  risks: string[];
  /** Preguntas pendientes / cosas que el agente no pudo verificar. */
  openQuestions: string[];
}

export type TechValidation =
  | { ok: true; analysis: TechnicalAnalysis; unresolvedPaths: string[] }
  | { ok: false; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Valida el análisis técnico y VERIFICA las rutas contra el disco.
 *
 * - `rootDir`: directorio base para resolver rutas relativas.
 * - Cada `affectedFiles[].path` se comprueba: se rechazan rutas absolutas o con
 *   traversal (no verificables de forma segura) y se marca `exists`.
 * - Las rutas que no existen NO invalidan el análisis (el agente puede proponer
 *   crear archivos nuevos), pero se devuelven en `unresolvedPaths` para que el
 *   flujo las reporte explicitamente en vez de darlas por buenas en silencio.
 */
export function validateTechnicalAnalysis(candidate: unknown, rootDir: string): TechValidation {
  const errors: string[] = [];

  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["El análisis no es un objeto."] };
  }
  const c = candidate as Record<string, unknown>;

  if (!isNonEmptyString(c.summary)) errors.push("summary vacio.");
  if (!isNonEmptyString(c.currentFlow)) errors.push("currentFlow vacio.");

  // affectedFiles y proposedChanges deben ser LISTAS, pero PUEDEN estar vacias:
  // un analisis legitimo puede concluir que la HU no mapea a archivos del
  // codigo actual (p. ej. pide UI en un proyecto sin UI). En ese caso el agente
  // debe explicar el porque en summary / openQuestions, no inventar archivos.
  if (!Array.isArray(c.affectedFiles)) errors.push("affectedFiles debe ser lista.");
  if (!Array.isArray(c.proposedChanges)) errors.push("proposedChanges debe ser lista.");
  if (!Array.isArray(c.traceability)) errors.push("traceability debe ser lista.");
  if (!isStringArray(c.dependencies)) errors.push("dependencies debe ser lista de strings.");
  if (!isStringArray(c.risks)) errors.push("risks debe ser lista de strings.");
  if (!isStringArray(c.openQuestions)) errors.push("openQuestions debe ser lista de strings.");

  if (errors.length > 0) return { ok: false, errors };

  // Verificación de rutas en disco.
  const unresolvedPaths: string[] = [];
  const affected = (c.affectedFiles as AffectedFile[]).map((f) => {
    if (!isNonEmptyString(f.path)) {
      errors.push("affectedFiles tiene una ruta vacia.");
      return f;
    }
    // Rechazar rutas no verificables de forma segura.
    if (isAbsolute(f.path) || f.path.split(/[/\\]/).includes("..")) {
      unresolvedPaths.push(`${f.path} (ruta no verificable: absoluta o traversal)`);
      return { ...f, exists: false };
    }
    const exists = existsSync(join(rootDir, f.path));
    if (!exists) unresolvedPaths.push(f.path);
    return { ...f, exists };
  });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    analysis: { ...(candidate as TechnicalAnalysis), affectedFiles: affected },
    unresolvedPaths,
  };
}
