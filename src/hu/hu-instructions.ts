/**
 * Instrucciones del rol `huAnalyst` (Fase 9).
 *
 * SEPARADAS del codigo del grafo a proposito: asi, en el futuro, se pueden
 * especializar (por framework, por empresa) sin tocar nodos ni aristas. El
 * agente es GENERICO; no se le atan skills ni herramientas especificas aqui.
 *
 * Pedimos la salida como JSON para poder validarla contra el esquema de forma
 * robusta (parsear JSON es determinista; parsear prosa libre, no).
 */

/** Construye el prompt para analizar una HU en texto libre. */
export function buildHuPrompt(userStory: string): string {
  return [
    "Eres un analista de historias de usuario. Analiza la siguiente solicitud",
    "en texto libre y devuelve UNICAMENTE un objeto JSON valido (sin texto",
    "alrededor, sin markdown) con EXACTAMENTE esta forma:",
    "{",
    '  "summary": string,              // resumen breve de la HU',
    '  "need": string,                 // necesidad o comportamiento esperado',
    '  "tasks": [{ "order": number, "description": string }],',
    '  "acceptanceCriteria": [{ "id": string, "description": string }],',
    '  "assumptions": string[],',
    '  "openQuestions": string[],',
    '  "dependencies": string[]',
    "}",
    "Las tareas deben ir ordenadas (order 1..n). Los criterios de aceptacion",
    "deben ser verificables. No inventes dependencias; si no hay, usa [].",
    "",
    "Solicitud:",
    userStory,
  ].join("\n");
}

/**
 * Construye el prompt de REVISION: recibe la HU anterior (como JSON) y el
 * feedback humano, y pide una NUEVA version que incorpore el feedback.
 */
export function buildHuRevisionPrompt(previousHuJson: string, feedback: string): string {
  return [
    "Eres un analista de historias de usuario. Esta es una version previa de",
    "una HU analizada (JSON) y el feedback del revisor humano. Genera una NUEVA",
    "version del MISMO objeto JSON (misma forma exacta) que incorpore el",
    "feedback. Devuelve UNICAMENTE el JSON, sin texto alrededor.",
    "",
    "HU previa:",
    previousHuJson,
    "",
    "Feedback del humano:",
    feedback,
  ].join("\n");
}
