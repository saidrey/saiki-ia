import { createHash } from "node:crypto";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";

/**
 * Clasificación de viabilidad técnica (Fase 11).
 *
 * Deriva un estado a partir del CONTENIDO del análisis técnico, NO de una
 * asignación arbitraria del agente. Reglas explícitas y auditables:
 *
 * - `blocked`: el análisis no propone nada implementable (sin cambios ni
 *   archivos afectados) O todas las rutas referenciadas son no verificables.
 *   Hay impedimentos que requieren decisión/aclaración antes de desarrollar.
 * - `partially_ready`: hay partes implementables (algún cambio propuesto) pero
 *   tambien preguntas pendientes o rutas no verificables que dependen de
 *   decisiones. No se debe implementar todo automaticamente.
 * - `ready`: hay cambios propuestos, sin preguntas pendientes bloqueantes y sin
 *   rutas no verificables. Puede continuar con el desarrollo.
 *
 * `unresolvedPaths` viene de la verificación en disco de la Fase 10.
 */
export type Feasibility = "ready" | "blocked" | "partially_ready";

export interface FeasibilityResult {
  feasibility: Feasibility;
  /** Motivos legibles que respaldan la clasificación. */
  reasons: string[];
}

export function classifyFeasibility(
  analysis: TechnicalAnalysis,
  unresolvedPaths: string[],
): FeasibilityResult {
  const reasons: string[] = [];

  const hasChanges = analysis.proposedChanges.length > 0;
  const hasOpenQuestions = analysis.openQuestions.length > 0;
  const hasUnresolved = unresolvedPaths.length > 0;

  // Sin nada implementable -> bloqueado.
  if (!hasChanges) {
    reasons.push("El análisis no propone cambios implementables.");
    if (hasOpenQuestions) reasons.push(`Hay ${analysis.openQuestions.length} pregunta(s) pendiente(s).`);
    return { feasibility: "blocked", reasons };
  }

  // Hay cambios, pero con preguntas pendientes o rutas no verificables ->
  // parcialmente listo (requiere decisión humana sobre cómo proceder).
  if (hasOpenQuestions || hasUnresolved) {
    if (hasOpenQuestions) reasons.push(`Hay ${analysis.openQuestions.length} pregunta(s) pendiente(s) que condicionan parte del alcance.`);
    if (hasUnresolved) reasons.push(`Hay ${unresolvedPaths.length} ruta(s) no verificable(s): ${unresolvedPaths.join(", ")}.`);
    reasons.push("Existen partes implementables y otras que dependen de decisiones.");
    return { feasibility: "partially_ready", reasons };
  }

  // Cambios propuestos, sin preguntas pendientes ni rutas no verificables.
  reasons.push("El análisis propone cambios concretos sin preguntas bloqueantes ni rutas no verificables.");
  return { feasibility: "ready", reasons };
}

/**
 * (Fase 21) Hash SHA-256 ESTABLE de lo que el humano decide en `partially_ready`:
 * el análisis técnico, la clasificación y sus motivos, ligado a la versión de la
 * HU de la que deriva. Si cualquiera cambia, se exige una nueva decisión.
 */
export function hashFeasibilityDecision(input: {
  huVersion: number;
  feasibility: string;
  reasons: string[];
  unresolvedPaths: string[];
  analysis: TechnicalAnalysis | null;
}): string {
  const canonical = JSON.stringify({
    huVersion: input.huVersion,
    feasibility: input.feasibility,
    reasons: input.reasons,
    unresolvedPaths: input.unresolvedPaths,
    analysis: input.analysis,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
