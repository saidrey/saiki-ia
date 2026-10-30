import type {
  Moderator,
  ModeratorSession,
  ModeratorDecision,
  IntentClassification,
  IntentCategory,
} from "./moderator-types.js";

/**
 * Moderador BÁSICO y DETERMINISTA (Fase 14).
 *
 * NO es el moderador conversacional completo (eso llega en una fase futura, con
 * un motor de lenguaje). Es una implementación mínima que:
 *  - Clasifica el mensaje en conversation / assistance / development mediante
 *    heurísticas explícitas (no IA), de forma determinista y auditable.
 *  - Respeta los LÍMITES DUROS: una pregunta técnica NO inicia desarrollo; solo
 *    se escala a `development` con autorización explícita del usuario; nunca
 *    salta aprobaciones ni ejecuta el Safe Applier.
 *
 * Es honesto sobre su alcance: las heurísticas son simples (palabras clave).
 * La `confidence` refleja esa limitación.
 */

/** Verbos/expresiones que PIDEN iniciar un desarrollo (acción sobre el repo). */
const DEVELOPMENT_HINTS = [
  "implementa",
  "implementar",
  "crea el",
  "crear el",
  "desarrolla",
  "desarrollar",
  "agrega la funcionalidad",
  "añade la funcionalidad",
  "codifica",
  "programa la",
  "aplica el cambio",
];

/** Expresiones de AUTORIZACIÓN explícita para escalar a desarrollo. */
const DEVELOPMENT_AUTHORIZATION = [
  "autorizo",
  "procede con el desarrollo",
  "inicia el desarrollo",
  "empieza el desarrollo",
  "adelante con la implementacion",
  "adelante con la implementación",
  "si, desarrolla",
  "sí, desarrolla",
];

/** Verbos de tareas AUXILIARES delegables (sin tocar el repo). */
const ASSISTANCE_HINTS = [
  "investiga",
  "investigar",
  "compara",
  "comparar",
  "busca documentacion",
  "busca documentación",
  "redacta",
  "redactar",
  "resume",
  "resumir",
  "analiza el error",
  "explora alternativas",
  "prepara un informe",
  "prepara una propuesta",
];

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export class BasicModerator implements Moderator {
  readonly name = "basic-moderator";

  classify(message: string, _session: ModeratorSession): IntentClassification {
    const text = normalize(message);
    const authorized = containsAny(text, DEVELOPMENT_AUTHORIZATION);

    // 1. Desarrollo: SOLO si hay autorización explícita, O un verbo de
    //    implementación claro (acción sobre el repo). Una mera pregunta técnica
    //    ("¿cómo funciona X?") NO cae aquí.
    const looksLikeDevRequest = containsAny(text, DEVELOPMENT_HINTS);
    if (authorized || looksLikeDevRequest) {
      return {
        category: "development",
        confidence: authorized ? 0.9 : 0.6,
        reason: authorized
          ? "El usuario autorizó explícitamente iniciar el desarrollo."
          : "El mensaje solicita implementar/crear algo en el repositorio.",
        developmentAuthorized: authorized || looksLikeDevRequest,
      };
    }

    // 2. Asistencia: tareas auxiliares delegables.
    if (containsAny(text, ASSISTANCE_HINTS)) {
      return {
        category: "assistance",
        confidence: 0.6,
        reason: "El mensaje pide una tarea auxiliar (investigar/redactar/comparar).",
        developmentAuthorized: false,
      };
    }

    // 3. Por defecto: conversación. Preguntas técnicas viven aquí y NUNCA
    //    inician un desarrollo por sí solas.
    return {
      category: "conversation",
      confidence: 0.5,
      reason: "Sin señales de asistencia ni de desarrollo: se trata como consulta.",
      developmentAuthorized: false,
    };
  }

  handle(message: string, session: ModeratorSession): ModeratorDecision {
    const classification = this.classify(message, session);
    const category: IntentCategory = classification.category;

    if (category === "development") {
      // El moderador SOLO marca que debe iniciarse el desarrollo; el Core
      // arranca el grafo y gobierna las aprobaciones humanas. El moderador no
      // ejecuta el flujo ni el Safe Applier.
      return { classification, startDevelopment: true };
    }

    if (category === "assistance") {
      // En esta fase el moderador no crea la tarea por sí mismo (eso lo decide
      // el Core/integrador con el grant adecuado); devuelve la clasificación
      // para que se construya la DelegatedTask con permisos de solo lectura.
      return { classification, startDevelopment: false };
    }

    // Conversación: respuesta directa, sin delegación ni desarrollo.
    return {
      classification,
      startDevelopment: false,
      reply: "Consulta recibida. (El moderador conversacional completo llega en una fase futura.)",
    };
  }
}
