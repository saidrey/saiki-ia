import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Contratos de ENTRADA y SALIDA del desarrollador (Claude) — Fase 11.
 *
 * ENTRADA (`DevContext`): contexto estructurado que se arma DESDE el estado del
 * grafo (fuente de verdad única). Claude no debe reconstruir información.
 *
 * SALIDA (`DevProposal`): propuesta de implementación validable. Claude NO
 * escribe; esto es una propuesta para revisión y posterior aplicación segura.
 */

// ── ENTRADA ────────────────────────────────────────────────────────────────

export interface DevContext {
  /** HU aprobada (resumen, necesidad, tareas, criterios, supuestos, preguntas). */
  hu: {
    version: number; // nº de versión de la HU (índice en versions)
    summary: string;
    need: string;
    tasks: Array<{ order: number; description: string }>;
    acceptanceCriteria: Array<{ id: string; description: string }>;
    assumptions: string[];
    openQuestions: string[];
  };
  /** Resultado del análisis técnico. */
  technical: {
    summary: string;
    currentFlow: string;
    affectedFiles: Array<{ path: string; responsibility: string; exists?: boolean }>;
    proposedChanges: Array<{ path: string; change: string }>;
    dependencies: string[];
    risks: string[];
    openQuestions: string[];
  };
  /** Estado de viabilidad y motivos. */
  feasibility: "ready" | "partially_ready";
  feasibilityReasons: string[];
  /** Restricciones arquitectónicas conocidas (del proyecto). */
  constraints: string[];
  /**
   * (Fase 12) Hallazgos/cambios requeridos de revisiones previas que esta nueva
   * versión debe corregir. Vacío en la primera propuesta.
   */
  reviewFindings?: string[];
}

// ── SALIDA ─────────────────────────────────────────────────────────────────

export type DevFileOperation = "create" | "modify" | "delete";

export interface DevFileChange {
  path: string;
  operation: DevFileOperation;
  /** Contenido propuesto (vacío permitido para delete). */
  content: string;
  /** Verificación en disco (la rellena el validador). */
  exists?: boolean;
}

export interface DevProposal {
  summary: string;
  technicalDecisions: string[];
  changes: DevFileChange[];
  /** Relación cambio/tarea/criterio. */
  traceability: Array<{ ref: string; note: string }>;
  risks: string[];
  dependencies: string[];
  openQuestions: string[];
  coveredCriteria: string[];
  uncoveredCriteria: Array<{ id: string; reason: string }>;
}

export type DevValidation =
  | { ok: true; proposal: DevProposal; newFiles: string[]; existingFiles: string[]; unverifiablePaths: string[] }
  | { ok: false; errors: string[] };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Valida una propuesta de desarrollo y clasifica sus rutas contra el disco.
 *
 * - No exige que haya cambios: una propuesta legítima puede no proponer archivos
 *   (p. ej. criterios no cubiertos) PERO entonces no es "lista para aplicar".
 * - Diferencia archivos nuevos / existentes / no verificables (absolutas/traversal).
 * - Rutas de `create` que ya existen, o de `modify`/`delete` que no existen, se
 *   reportan como inconsistencias en los campos de clasificación (no invalidan
 *   el esquema por sí solas; la decisión de aplicar es del humano + aplicador).
 */
export function validateDevProposal(candidate: unknown, rootDir: string): DevValidation {
  const errors: string[] = [];
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["La propuesta no es un objeto."] };
  }
  const c = candidate as Record<string, unknown>;

  if (!isNonEmptyString(c.summary)) errors.push("summary vacio.");
  if (!isStringArray(c.technicalDecisions)) errors.push("technicalDecisions debe ser lista de strings.");
  if (!Array.isArray(c.changes)) errors.push("changes debe ser lista.");
  if (!Array.isArray(c.traceability)) errors.push("traceability debe ser lista.");
  if (!isStringArray(c.risks)) errors.push("risks debe ser lista de strings.");
  if (!isStringArray(c.dependencies)) errors.push("dependencies debe ser lista de strings.");
  if (!isStringArray(c.openQuestions)) errors.push("openQuestions debe ser lista de strings.");
  if (!isStringArray(c.coveredCriteria)) errors.push("coveredCriteria debe ser lista de strings.");
  if (!Array.isArray(c.uncoveredCriteria)) errors.push("uncoveredCriteria debe ser lista.");
  if (errors.length > 0) return { ok: false, errors };

  const newFiles: string[] = [];
  const existingFiles: string[] = [];
  const unverifiablePaths: string[] = [];

  const changes = (c.changes as DevFileChange[]).map((ch) => {
    if (!isNonEmptyString(ch.path)) {
      errors.push("Un cambio tiene ruta vacia.");
      return ch;
    }
    if (!["create", "modify", "delete"].includes(ch.operation)) {
      errors.push(`operation invalida en "${ch.path}".`);
    }
    if (isAbsolute(ch.path) || ch.path.split(/[/\\]/).includes("..")) {
      unverifiablePaths.push(`${ch.path} (absoluta o traversal)`);
      return { ...ch, exists: false };
    }
    const exists = existsSync(join(rootDir, ch.path));
    if (exists) existingFiles.push(ch.path);
    else newFiles.push(ch.path);
    return { ...ch, exists };
  });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    proposal: { ...(candidate as DevProposal), changes },
    newFiles,
    existingFiles,
    unverifiablePaths,
  };
}

/**
 * Hash SHA-256 ESTABLE de una propuesta de desarrollo. Es lo que el humano
 * aprueba; si la propuesta cambia, el hash cambia y se exige nueva aprobación.
 * Determinista: cambios ordenados por ruta, campos en orden fijo.
 */
export function hashDevProposal(p: DevProposal): string {
  const orderedChanges = [...p.changes]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((ch) => ({ path: ch.path, operation: ch.operation, content: ch.content }));
  const canonical = JSON.stringify({
    summary: p.summary,
    technicalDecisions: p.technicalDecisions,
    changes: orderedChanges,
    traceability: p.traceability,
    coveredCriteria: p.coveredCriteria,
    uncoveredCriteria: p.uncoveredCriteria,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
