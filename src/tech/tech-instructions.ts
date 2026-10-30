import type { AnalyzedHu } from "../hu/hu-schema.js";

/**
 * Instrucciones del rol `technicalAnalyst` (Fase 10). SEPARADAS del grafo y de
 * las del analista de HU, para poder especializarlas en el futuro.
 *
 * El agente inspecciona el codigo con SOLO LECTURA (fs_read) y produce un
 * analisis estructurado. No implementa cambios ni ejecuta herramientas con
 * efectos secundarios. Debe referenciar archivos REALES; si no puede verificar
 * una ruta o un flujo, debe decirlo en `openQuestions`, no inventar.
 */
export function buildTechnicalPrompt(hu: AnalyzedHu, rootDir: string): string {
  return [
    "Eres un analista tecnico de software. Tienes acceso de SOLO LECTURA al",
    `codigo del proyecto en: ${rootDir}`,
    "Analiza la siguiente Historia de Usuario YA APROBADA y estudia el codigo",
    "existente para determinar QUE cambiar y DONDE. NO implementes cambios.",
    "",
    "Reglas:",
    "- Referencia solo archivos que EXISTAN de verdad (verifica leyendo).",
    "- Si no puedes verificar una ruta o entender un flujo, dilo en openQuestions.",
    "- Relaciona los cambios con las tareas y criterios de la HU.",
    "",
    "Devuelve UNICAMENTE un objeto JSON valido (sin markdown) con esta forma:",
    "{",
    '  "summary": string,',
    '  "currentFlow": string,',
    '  "affectedFiles": [{ "path": string, "responsibility": string }],',
    '  "proposedChanges": [{ "path": string, "change": string }],',
    '  "traceability": [{ "ref": string, "note": string }],',
    '  "dependencies": string[],',
    '  "risks": string[],',
    '  "openQuestions": string[]',
    "}",
    "",
    "Historia de Usuario aprobada (JSON):",
    JSON.stringify(hu),
  ].join("\n");
}
