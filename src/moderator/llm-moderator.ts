import type {
  AsyncModerator,
  AsyncModeratorDecision,
  RichClassification,
  RichIntentCategory,
  RecommendedAction,
  ModeratorSession,
} from "./moderator-types.js";
import type { ConversationEngine } from "./conversation-engine.js";
import type { DelegatedTask } from "./delegation.js";

/**
 * Moderador conversacional basado en un LLM (Fase 16).
 *
 * Usa un `ConversationEngine` (p. ej. Claude) para comprender lenguaje natural,
 * clasificar la intención, pedir aclaraciones y redactar/sintetizar respuestas.
 * Es INDEPENDIENTE del proveedor: depende solo del contrato `ConversationEngine`.
 *
 * GARANTÍAS (sección 7):
 *  - NO escribe el repo, NO aplica propuestas, NO aprueba código ni conocimiento,
 *    NO salta aprobaciones. Solo CLASIFICA y REDACTA; el Core ejecuta y gobierna.
 *  - La confianza del modelo NO autoriza acciones sensibles: el Core decide con
 *    sus reglas (p. ej. desarrollo sigue pasando por aprobaciones humanas).
 *  - NO simula salida: si el motor falla, se propaga el error explícitamente.
 *  - NO inventa resultados de agentes: al sintetizar, parte del texto real.
 */

const CLASSIFY_SYSTEM =
  "Eres el moderador técnico de un equipo. Clasificas el mensaje del usuario y " +
  "respondes ÚNICAMENTE con un objeto JSON válido (sin markdown ni texto extra).";

/** Esquema esperado del JSON de clasificación (el prompt lo describe). */
const CLASSIFY_SCHEMA_HINT = `Devuelve SOLO este JSON:
{
  "intent": "conversation" | "assistance" | "development" | "clarification",
  "confidence": number (0..1),
  "reason": string,
  "missingInfo": string[],
  "recommendedAction": "reply" | "delegate_assistance" | "start_development" | "ask_clarification",
  "proposedFlow": string,
  "clarifyingQuestion": string (solo si intent="clarification", si no "")
}
Reglas:
- "conversation": consulta/pregunta técnica que puedes responder; NO implica desarrollo.
- "assistance": pedir investigar, comparar, redactar o resumir (sin tocar el repo).
- "development": pedir implementar/crear/modificar código en el repositorio.
- "clarification": el mensaje es ambiguo o incompleto; falta información para decidir.
- Una pregunta técnica NUNCA es "development".
- Si dudas entre development y otra cosa, usa "clarification" y pregunta.`;

export class LlmModerator implements AsyncModerator {
  readonly name: string;

  constructor(private readonly engine: ConversationEngine) {
    this.name = `llm-moderator(${engine.name})`;
  }

  // ── Clasificación ──────────────────────────────────────────────────────────

  async classifyAsync(message: string, session: ModeratorSession): Promise<RichClassification> {
    const prompt = this.buildClassifyPrompt(message, session);
    const result = await this.engine.complete({ prompt, systemHint: CLASSIFY_SYSTEM });

    if (!result.ok) {
      // Error del proveedor: se propaga explícitamente (sin simular).
      throw new ModeratorEngineError(result.error);
    }

    const parsed = parseClassification(result.text);
    if (parsed === null) {
      throw new ModeratorEngineError(
        `El motor devolvió una clasificación no válida (no es el JSON esperado): ${truncate(result.text)}`,
      );
    }
    return parsed;
  }

  /** Construye el prompt de clasificación con el CONTEXTO de la sesión. */
  private buildClassifyPrompt(message: string, session: ModeratorSession): string {
    const history = renderHistory(session);
    return [
      CLASSIFY_SCHEMA_HINT,
      history ? `\nHistorial de la conversación (para resolver referencias y correcciones):\n${history}` : "",
      `\nMensaje actual del usuario:\n${message}`,
    ].join("\n");
  }

  // ── Decisión / respuesta ─────────────────────────────────────────────────────

  async respond(message: string, session: ModeratorSession): Promise<AsyncModeratorDecision> {
    const classification = await this.classifyAsync(message, session);

    if (classification.intent === "clarification") {
      const question =
        classification.clarifyingQuestion && classification.clarifyingQuestion.trim().length > 0
          ? classification.clarifyingQuestion
          : "¿Podrías dar más detalles para poder ayudarte mejor?";
      return {
        classification,
        clarifyingQuestion: question,
        delegateAssistance: false,
        startDevelopment: false,
      };
    }

    if (classification.intent === "development") {
      // El moderador SOLO propone; el Core arranca el grafo y gobierna las
      // aprobaciones humanas. La confianza no autoriza nada por sí sola.
      return {
        classification,
        delegateAssistance: false,
        startDevelopment: true,
      };
    }

    if (classification.intent === "assistance") {
      return {
        classification,
        delegateAssistance: true,
        startDevelopment: false,
      };
    }

    // conversation: el moderador redacta una respuesta natural.
    const reply = await this.writeReply(message, session);
    return {
      classification,
      reply,
      delegateAssistance: false,
      startDevelopment: false,
    };
  }

  /** Redacta una respuesta conversacional natural (sin inventar herramientas). */
  private async writeReply(message: string, session: ModeratorSession): Promise<string> {
    const history = renderHistory(session);
    const prompt = [
      "Responde de forma clara y breve a la consulta del usuario, como un tech lead.",
      "No inventes resultados de herramientas ni de agentes. Si no sabes algo, dilo.",
      history ? `\nHistorial:\n${history}` : "",
      `\nConsulta:\n${message}`,
    ].join("\n");
    const result = await this.engine.complete({ prompt });
    if (!result.ok) throw new ModeratorEngineError(result.error);
    return result.text;
  }

  // ── Síntesis de resultados de asistencia ─────────────────────────────────────

  /**
   * Sintetiza el resultado de una tarea de asistencia en una respuesta legible,
   * diferenciando hechos, hipótesis y recomendaciones, y CONSERVANDO referencia
   * al resultado original. No inventa: parte del `task.result` real.
   */
  async synthesizeAssistance(task: DelegatedTask): Promise<string> {
    if (task.status !== "succeeded" || !task.result) {
      // No hay resultado real: no se inventa nada.
      return `La tarea de asistencia no produjo un resultado utilizable (estado: ${task.status}).`;
    }
    const prompt = [
      "Resume el siguiente resultado de una investigación para el usuario.",
      "Diferencia explícitamente: HECHOS verificados, HIPÓTESIS y RECOMENDACIONES.",
      "No agregues información que no esté en el resultado. Conserva las fuentes si las hay.",
      `\nResultado original (no lo inventes, básate SOLO en esto):\n${task.result}`,
    ].join("\n");
    const result = await this.engine.complete({ prompt });
    if (!result.ok) throw new ModeratorEngineError(result.error);
    // Conservamos referencia al resultado original (trazabilidad).
    return `${result.text}\n\n[síntesis basada en el resultado de la tarea ${task.id}]`;
  }
}

/** Error explícito del motor conversacional (no se enmascara como éxito). */
export class ModeratorEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeratorEngineError";
  }
}

// ── Helpers de parseo/validación (deterministas) ──────────────────────────────

function renderHistory(session: ModeratorSession): string {
  if (session.turns.length === 0) return "";
  // Limitamos a los últimos turnos para acotar tokens; el contexto reciente es
  // el más relevante para referencias y correcciones.
  const recent = session.turns.slice(-8);
  return recent.map((t) => `${t.role === "user" ? "Usuario" : "Moderador"}: ${t.text}`).join("\n");
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const VALID_INTENTS: RichIntentCategory[] = [
  "conversation",
  "assistance",
  "development",
  "clarification",
];
const VALID_ACTIONS: RecommendedAction[] = [
  "reply",
  "delegate_assistance",
  "start_development",
  "ask_clarification",
];

/**
 * Parsea y VALIDA la clasificación JSON del modelo. Tolerante a que el modelo
 * envuelva el JSON en texto/markdown: extrae el primer objeto `{...}`. Si no es
 * válido, devuelve null (el llamador lo trata como error explícito, sin simular).
 */
export function parseClassification(raw: string): RichClassification | null {
  const json = extractJsonObject(raw);
  if (json === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  const intent = obj.intent;
  if (typeof intent !== "string" || !VALID_INTENTS.includes(intent as RichIntentCategory)) return null;

  const confidence = typeof obj.confidence === "number" ? clamp01(obj.confidence) : 0;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const missingInfo = Array.isArray(obj.missingInfo)
    ? obj.missingInfo.filter((x): x is string => typeof x === "string")
    : [];
  const recommendedAction =
    typeof obj.recommendedAction === "string" &&
    VALID_ACTIONS.includes(obj.recommendedAction as RecommendedAction)
      ? (obj.recommendedAction as RecommendedAction)
      : defaultActionFor(intent as RichIntentCategory);
  const proposedFlow = typeof obj.proposedFlow === "string" ? obj.proposedFlow : "";
  const clarifyingQuestion =
    typeof obj.clarifyingQuestion === "string" ? obj.clarifyingQuestion : undefined;

  return {
    intent: intent as RichIntentCategory,
    confidence,
    reason,
    missingInfo,
    recommendedAction,
    proposedFlow,
    clarifyingQuestion,
  };
}

function defaultActionFor(intent: RichIntentCategory): RecommendedAction {
  switch (intent) {
    case "development":
      return "start_development";
    case "assistance":
      return "delegate_assistance";
    case "clarification":
      return "ask_clarification";
    default:
      return "reply";
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Extrae el primer objeto JSON balanceado de un texto (tolerante a envoltura). */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
