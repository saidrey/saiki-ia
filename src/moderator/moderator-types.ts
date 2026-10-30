import type { DelegatedTask } from "./delegation.js";

/**
 * Contrato del MODERADOR (Fase 14 — solo contrato, estado e integración).
 *
 * El Moderador es el "cerebro conversacional" (futuro Tech Lead). Es
 * INDEPENDIENTE de Kiro, Claude y OpenCode: no es un runtime, es quien decide
 * QUÉ hacer con un mensaje del usuario.
 *
 * En esta fase NO se construye la experiencia conversacional completa ni un
 * moderador basado en LLM. Se definen: el contrato, el estado de sesión, la
 * clasificación de intención y el punto de integración con el Core.
 *
 * LÍMITES DUROS (no se pueden violar):
 *  - El moderador NO inicia un flujo de desarrollo solo porque el usuario haga
 *    una pregunta técnica.
 *  - El moderador NO salta aprobaciones humanas.
 *  - El moderador NO ejecuta el Safe Applier ni escribe el repositorio.
 *  - Un resultado de agente NUNCA es una decisión aprobada por sí mismo.
 */

/**
 * Categorías de intención que el moderador distingue inicialmente:
 *  - conversation: consulta/respuesta sin delegación.
 *  - assistance:   tarea auxiliar delegable (investigar, comparar, redactar…).
 *  - development:  solicitud que debe iniciar el flujo de desarrollo existente.
 */
export type IntentCategory = "conversation" | "assistance" | "development";

/** Resultado de clasificar un mensaje del usuario. */
export interface IntentClassification {
  category: IntentCategory;
  /** Confianza heurística 0..1 (en esta fase, clasificador determinista). */
  confidence: number;
  /** Explicación legible de por qué se clasificó así (auditable). */
  reason: string;
  /**
   * true si el usuario AUTORIZÓ explícitamente escalar a desarrollo. Una
   * conversación puede evolucionar a `development` SOLO con esta autorización.
   */
  developmentAuthorized: boolean;
}

/** Un turno en la conversación con el moderador. */
export interface ConversationTurn {
  role: "user" | "moderator";
  text: string;
  at: string; // ISO timestamp
  classification?: IntentClassification;
}

/**
 * Estado persistible de una sesión del moderador. Se guarda aparte del estado
 * de LangGraph (que administra los flujos de desarrollo). No duplica ese estado:
 * solo referencia los flujos/tareas por id.
 */
export interface ModeratorSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  /** Tareas auxiliares delegadas en esta sesión (por id). */
  delegatedTaskIds: string[];
  /** Id del flujo de desarrollo (thread_id de LangGraph) más reciente, si se inició uno. */
  developmentThreadId?: string;
  /**
   * Todas las ejecuciones de desarrollo de la sesión, en orden de creación (una
   * por solicitud). Las sesiones anteriores a este campo solo tienen
   * `developmentThreadId`: usar `developmentThreadsOf()`.
   */
  developmentThreadIds?: string[];
  /**
   * (Project Registry) Proyecto de la sesión, fijado al crearla y nunca
   * reasignado. Sin él, la sesión es general: conversa, pero no desarrolla.
   */
  projectId?: string;
}

/**
 * Lo que el moderador decide hacer con un mensaje. NO ejecuta nada por sí mismo
 * que viole los límites: devuelve una intención y, a lo sumo, una tarea de
 * asistencia a delegar o la señal de iniciar desarrollo (que el Core gobierna).
 */
export interface ModeratorDecision {
  classification: IntentClassification;
  /** Respuesta conversacional directa (cuando category=conversation). */
  reply?: string;
  /** Tarea auxiliar a delegar (cuando category=assistance). */
  delegate?: DelegatedTask;
  /**
   * true si corresponde INICIAR el flujo de desarrollo. El moderador solo lo
   * marca; es el Core quien arranca el grafo y gobierna las aprobaciones.
   */
  startDevelopment: boolean;
}

/**
 * EL CONTRATO del moderador. En esta fase se implementa una versión mínima y
 * determinista; la conversacional completa llega en una fase futura.
 */
export interface Moderator {
  readonly name: string;
  /** Clasifica un mensaje del usuario dentro de una sesión. */
  classify(message: string, session: ModeratorSession): IntentClassification;
  /** Decide qué hacer con un mensaje (sin violar los límites duros). */
  handle(message: string, session: ModeratorSession): ModeratorDecision;
}

// ── (Fase 16) Moderador conversacional asíncrono (LLM) ──────────────────────
//
// Aditivo: NO reemplaza `Moderator` (síncrono/determinista), que sigue válido.
// Un moderador con LLM es asíncrono (llama a un proceso) y produce una
// clasificación más rica. El Core detecta cuál recibió y actúa en consecuencia.

/**
 * Categorías enriquecidas. Añade:
 *  - clarification: el mensaje es ambiguo/incompleto y requiere una pregunta.
 * Las tres originales se conservan con el mismo significado.
 */
export type RichIntentCategory = IntentCategory | "clarification";

/** Acción recomendada por el moderador (NO la ejecuta él; la propone al Core). */
export type RecommendedAction =
  | "reply" // responder directamente (conversación)
  | "delegate_assistance" // delegar una investigación/asistencia
  | "start_development" // enviar al flujo de desarrollo
  | "ask_clarification"; // pedir una aclaración al usuario

/**
 * Clasificación RICA (sección 3 de la fase). Estructura tipada que el LLM
 * produce y el moderador valida.
 */
export interface RichClassification {
  intent: RichIntentCategory;
  /** Confianza 0..1. NO autoriza por sí sola acciones sensibles. */
  confidence: number;
  /** Justificación breve. */
  reason: string;
  /** Información que falta para poder actuar (vacío si no falta nada). */
  missingInfo: string[];
  /** Acción recomendada (propuesta, no ejecutada). */
  recommendedAction: RecommendedAction;
  /** Flujo/destino propuesto en texto legible. */
  proposedFlow: string;
  /** Pregunta de aclaración cuando intent=clarification. */
  clarifyingQuestion?: string;
}

/** Decisión del moderador conversacional (extiende la síncrona con aclaración). */
export interface AsyncModeratorDecision {
  classification: RichClassification;
  /** Respuesta conversacional directa (intent=conversation). */
  reply?: string;
  /** Pregunta de aclaración (intent=clarification). */
  clarifyingQuestion?: string;
  /** true si corresponde delegar asistencia. */
  delegateAssistance: boolean;
  /** true si corresponde iniciar desarrollo. */
  startDevelopment: boolean;
}

/**
 * Contrato del moderador conversacional (LLM). Asíncrono. Mantiene el contexto
 * usando `session.turns`. La confianza NUNCA autoriza acciones sensibles: el
 * Core aplica las reglas y las aprobaciones humanas.
 */
export interface AsyncModerator {
  readonly name: string;
  /** Clasifica un mensaje (con contexto de la sesión) de forma asíncrona. */
  classifyAsync(message: string, session: ModeratorSession): Promise<RichClassification>;
  /** Decide qué proponer (clasifica + redacta respuesta/aclaración). */
  respond(message: string, session: ModeratorSession): Promise<AsyncModeratorDecision>;
}

/**
 * (Fase 17) Capacidad OPCIONAL de sintetizar el resultado de una tarea de
 * asistencia en una respuesta natural y fundamentada. Es ADITIVA: un moderador
 * puede implementarla o no. El Core la detecta por type-guard; si el moderador
 * no la soporta (p. ej. el determinista), entrega el resultado crudo con una
 * nota (degradación honesta, no error).
 *
 * `task` es un `DelegatedTask` ya ejecutado (ver src/moderator/delegation.ts).
 * Se tipa como `unknown` aquí para evitar un import circular del contrato; el
 * implementador lo refina a `DelegatedTask`.
 */
export interface AssistanceSynthesizer {
  synthesizeAssistance(task: unknown): Promise<string>;
}
