import type { DevContext } from "./dev-schema.js";

/**
 * Instrucciones del rol desarrollador (Claude) — Fase 11. SEPARADAS del grafo.
 *
 * Claude recibe el contexto COMPLETO (DevContext) y genera una PROPUESTA de
 * implementación en JSON. NO escribe archivos (lo impiden los permisos del
 * adaptador, no solo el prompt). Debe respetar las restricciones del proyecto,
 * aplicar KISS/YAGNI y relacionar cada cambio con tareas/criterios.
 */
export function buildDevPrompt(ctx: DevContext): string {
  return [
    "Eres un desarrollador senior. Recibes una Historia de Usuario YA APROBADA,",
    "su análisis técnico y el estado de viabilidad. Genera una PROPUESTA de",
    "implementación. NO apliques cambios ni crees archivos: solo propón.",
    "",
    "Reglas:",
    "- Respeta las restricciones del proyecto (ver 'constraints'). No introduzcas",
    "  frameworks, frontend, servidores ni dependencias sin justificarlo como",
    "  pregunta pendiente (openQuestions), no como hecho consumado.",
    "- Aplica KISS y YAGNI. No amplíes el alcance de la HU.",
    "- Relaciona cada cambio con tareas/criterios (traceability).",
    "- Indica criterios cubiertos y NO cubiertos (con justificación).",
    "- Referencia solo archivos reales; si no puedes verificar algo, dilo en",
    "  openQuestions. No inventes archivos ni afirmes que ejecutaste pruebas.",
    "- Si no hay cambios legítimos que proponer, devuelve changes:[] y explica.",
    "",
    "Devuelve UNICAMENTE un objeto JSON válido (sin markdown) con esta forma:",
    "{",
    '  "summary": string,',
    '  "technicalDecisions": string[],',
    '  "changes": [{ "path": string, "operation": "create"|"modify"|"delete", "content": string }],',
    '  "traceability": [{ "ref": string, "note": string }],',
    '  "risks": string[],',
    '  "dependencies": string[],',
    '  "openQuestions": string[],',
    '  "coveredCriteria": string[],',
    '  "uncoveredCriteria": [{ "id": string, "reason": string }]',
    "}",
    "",
    ...(ctx.reviewFindings && ctx.reviewFindings.length > 0
      ? [
          "",
          "IMPORTANTE: esta es una CORRECCIÓN. Debes resolver estos hallazgos de",
          "revisiones previas (no los ignores; si no corriges alguno, justifícalo",
          "en openQuestions):",
          ...ctx.reviewFindings.map((f) => `  - ${f}`),
        ]
      : []),
    "",
    "Contexto (fuente de verdad, no lo reconstruyas):",
    JSON.stringify(ctx),
  ].join("\n");
}
