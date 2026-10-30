/**
 * Motor conversacional (Fase 16): abstracción del RUNTIME que da inteligencia
 * de lenguaje al moderador.
 *
 * PRINCIPIO: el moderador NO se acopla a Claude. Depende de este contrato; un
 * proveedor nuevo = una clase que lo implemente, sin tocar el moderador ni el
 * Core. Es análogo a `AgentAdapter` pero para el ROL conversacional, separado
 * del rol `develop` (que usa su propio adaptador).
 */

/** Petición al motor conversacional. */
export interface ConversationRequest {
  /** Prompt completo (el moderador arma el contenido: historial + instrucciones). */
  prompt: string;
  /** Pista de sistema opcional (p. ej. "responde SOLO JSON"). */
  systemHint?: string;
}

/**
 * Resultado del motor. NUNCA lanza: los fallos viajan en `ok:false` + `error`,
 * igual que el contrato `AgentAdapter`. Esto mantiene el flujo predecible y
 * permite comunicar errores del proveedor explícitamente (sin simular salida).
 */
export type ConversationResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** EL CONTRATO del motor conversacional. */
export interface ConversationEngine {
  /** Identificador legible (p. ej. "claude-conversation"). */
  readonly name: string;
  /** Completa un prompt y devuelve texto (o un error explícito). */
  complete(request: ConversationRequest): Promise<ConversationResult>;
}
