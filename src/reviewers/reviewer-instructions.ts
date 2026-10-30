import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { DevProposal } from "../dev/dev-schema.js";
import type { FunctionalReview } from "./reviewer-schemas.js";

/**
 * Instrucciones INDEPENDIENTES de los revisores (Fase 12). Separadas del grafo
 * y entre sí: cada revisor tiene una responsabilidad delimitada y no asume la
 * del otro. Ambos son genéricos (sin reglas de empresa/framework). Solo lectura.
 */

/** Prompt del revisor FUNCIONAL: ¿la propuesta cumple la HU? */
export function buildFunctionalPrompt(hu: AnalyzedHu, proposal: DevProposal): string {
  return [
    "Eres un revisor FUNCIONAL. Tu única responsabilidad es verificar que la",
    "PROPUESTA de implementación cumple la Historia de Usuario y sus criterios",
    "de aceptación. NO evalúes calidad de código. NO modifiques la propuesta ni",
    "generes código.",
    "",
    "Evalúa: cada criterio cubierto; cada tarea con correspondencia; funcionalidad",
    "omitida; contradicciones con el comportamiento esperado; supuestos no",
    "autorizados; inconsistencias entre HU y propuesta.",
    "",
    "Devuelve UNICAMENTE un objeto JSON válido (sin markdown) con esta forma:",
    "{",
    '  "decision": "approved" | "rejected",',
    '  "evaluatedCriteria": string[],',
    '  "metCriteria": string[],',
    '  "unmetCriteria": string[],',
    '  "findings": [{ "id": string, "severity": "low"|"medium"|"high"|"critical", "description": string }],',
    '  "requiredChanges": string[],',
    '  "openQuestions": string[],',
    '  "summary": string',
    "}",
    "Si algún criterio queda incumplido, la decision debe ser \"rejected\".",
    "",
    "Historia de Usuario (JSON):",
    JSON.stringify(hu),
    "",
    "Propuesta de implementación (JSON):",
    JSON.stringify(proposal),
  ].join("\n");
}

/** Prompt del revisor de CALIDAD: ¿la propuesta tiene calidad técnica? */
export function buildQualityPrompt(
  proposal: DevProposal,
  technical: TechnicalAnalysis,
  constraints: string[],
  functionalFindings: FunctionalReview["findings"],
): string {
  return [
    "Eres un revisor de CALIDAD técnica. Evalúa la PROPUESTA en: Clean Code,",
    "SOLID (cuando aplique), cohesión/acoplamiento, responsabilidades,",
    "legibilidad/mantenibilidad, manejo de errores, seguridad, posibles",
    "regresiones, coherencia con el lenguaje/arquitectura existentes, y",
    "complejidad innecesaria (KISS/YAGNI). NO exijas patrones sin justificación.",
    "NO evalúes cumplimiento funcional (eso es del revisor funcional). NO",
    "modifiques la propuesta ni generes código.",
    "",
    "Devuelve UNICAMENTE un objeto JSON válido (sin markdown) con esta forma:",
    "{",
    '  "decision": "approved" | "rejected",',
    '  "categories": [{ "category": string, "assessment": string }],',
    '  "findings": [{ "id": string, "severity": "low"|"medium"|"high"|"critical", "description": string }],',
    '  "requiredChanges": string[],',
    '  "acceptedRisks": string[],',
    '  "summary": string',
    "}",
    "",
    "Restricciones del proyecto a respetar:",
    JSON.stringify(constraints),
    "",
    "Análisis técnico original (JSON):",
    JSON.stringify(technical),
    "",
    "Hallazgos del revisor funcional (contexto, no los re-evalúes):",
    JSON.stringify(functionalFindings),
    "",
    "Propuesta de implementación (JSON):",
    JSON.stringify(proposal),
  ].join("\n");
}
