/**
 * Esquemas de salida de los revisores automáticos (Fase 12).
 *
 * Dos revisores INDEPENDIENTES, ambos Kiro, solo lectura, que NO modifican la
 * propuesta ni generan código:
 *  - `FunctionalReview`: ¿la propuesta cumple la HU y sus criterios?
 *  - `QualityReview`: ¿la propuesta tiene calidad técnica aceptable?
 *
 * Distinción (igual que el Reviewer de Fase 8): un resultado inválido o un fallo
 * de ejecución NUNCA se interpreta como aprobación.
 */

export type ReviewDecision = "approved" | "rejected";
export type Severity = "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
  id: string;
  severity: Severity;
  description: string;
}

/** Salida del revisor FUNCIONAL. */
export interface FunctionalReview {
  decision: ReviewDecision;
  evaluatedCriteria: string[];
  metCriteria: string[];
  unmetCriteria: string[];
  findings: ReviewFinding[];
  requiredChanges: string[];
  openQuestions: string[];
  summary: string;
}

/** Evaluación por categoría del revisor de CALIDAD. */
export interface QualityCategory {
  category: string; // p.ej. "clean-code", "solid", "errores", "seguridad"
  assessment: string;
}

/** Salida del revisor de CALIDAD. */
export interface QualityReview {
  decision: ReviewDecision;
  categories: QualityCategory[];
  findings: ReviewFinding[];
  requiredChanges: string[];
  acceptedRisks: string[];
  summary: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function validDecision(v: unknown): v is ReviewDecision {
  return v === "approved" || v === "rejected";
}

export type FunctionalValidation =
  | { ok: true; review: FunctionalReview }
  | { ok: false; errors: string[] };

/** Valida la salida del revisor funcional. Inválido => NO aprobación. */
export function validateFunctionalReview(candidate: unknown): FunctionalValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["La revisión funcional no es un objeto."] };
  }
  const c = candidate as Record<string, unknown>;
  const errors: string[] = [];
  if (!validDecision(c.decision)) errors.push("decision inválida.");
  if (!isStringArray(c.evaluatedCriteria)) errors.push("evaluatedCriteria debe ser lista de strings.");
  if (!isStringArray(c.metCriteria)) errors.push("metCriteria debe ser lista de strings.");
  if (!isStringArray(c.unmetCriteria)) errors.push("unmetCriteria debe ser lista de strings.");
  if (!Array.isArray(c.findings)) errors.push("findings debe ser lista.");
  if (!isStringArray(c.requiredChanges)) errors.push("requiredChanges debe ser lista de strings.");
  if (!isStringArray(c.openQuestions)) errors.push("openQuestions debe ser lista de strings.");
  if (!isNonEmptyString(c.summary)) errors.push("summary vacío.");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, review: candidate as FunctionalReview };
}

export type QualityValidation =
  | { ok: true; review: QualityReview }
  | { ok: false; errors: string[] };

/** Valida la salida del revisor de calidad. Inválido => NO aprobación. */
export function validateQualityReview(candidate: unknown): QualityValidation {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, errors: ["La revisión de calidad no es un objeto."] };
  }
  const c = candidate as Record<string, unknown>;
  const errors: string[] = [];
  if (!validDecision(c.decision)) errors.push("decision inválida.");
  if (!Array.isArray(c.categories)) errors.push("categories debe ser lista.");
  if (!Array.isArray(c.findings)) errors.push("findings debe ser lista.");
  if (!isStringArray(c.requiredChanges)) errors.push("requiredChanges debe ser lista de strings.");
  if (!isStringArray(c.acceptedRisks)) errors.push("acceptedRisks debe ser lista de strings.");
  if (!isNonEmptyString(c.summary)) errors.push("summary vacío.");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, review: candidate as QualityReview };
}
