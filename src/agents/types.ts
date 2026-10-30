/**
 * Contrato de agentes (Fase 3).
 *
 * Este archivo define la ABSTRACCION sobre la que se apoyaran los nodos del
 * grafo. La idea central es la "inversion de dependencias": los nodos NO deben
 * conocer a Kiro, Claude ni Codex directamente; solo conocen este contrato.
 *
 * Asi, conectar un agente real en el futuro = escribir una clase nueva que
 * implemente `AgentAdapter`, sin tocar los nodos ni el grafo.
 *
 * En esta fase NO se ejecuta nada externo: solo se define el contrato y se
 * provee una implementacion simulada (ver `mock-agent.ts`).
 */

/**
 * Roles iniciales del sistema. Cada rol corresponde a una etapa del flujo de
 * desarrollo que ya modela el grafo (analyze -> develop -> review).
 *
 * Es un union de strings (no un enum) por simplicidad y porque serializa
 * directo a JSON sin capas extra. KISS.
 */
export type AgentRole =
  | "analyze"
  | "develop"
  | "review"
  | "huAnalyst"
  | "technicalAnalyst"
  | "functionalReviewer"
  | "qualityReviewer"
  // (Fase 14) Rol auxiliar GENÉRICO y extensible. Apoya tareas que NO inician
  // el flujo de desarrollo (investigar, comparar, redactar, consultar la KB).
  // No es un runtime concreto: por defecto se ejecuta con OpenCode (opcional),
  // pero el rol no está acoplado a él.
  | "assistant";

/** Estado del resultado de ejecutar una tarea con un agente. */
export type AgentStatus = "success" | "failure";

/**
 * Peticion que se le pasa a un agente para ejecutar una tarea.
 *
 * `role` indica QUE etapa se esta ejecutando; `input` es el texto de entrada
 * (p. ej. la tarea para analyze, o el plan para develop). `context` es un
 * saco opcional de datos extra para el futuro (sin uso obligatorio ahora).
 */
export interface AgentRequest {
  role: AgentRole;
  input: string;
  context?: Record<string, unknown>;
}

/**
 * Resultado estructurado que devuelve un agente.
 *
 * Campos minimos exigidos por la fase:
 * - `status`: exito o fallo de la ejecucion.
 * - `output`: resultado textual (el "entregable" de esa etapa).
 * - `error`: detalle opcional; presente normalmente cuando status = "failure".
 *
 * `role` se incluye para trazabilidad (saber que agente produjo el resultado).
 */
export interface AgentResult {
  status: AgentStatus;
  output: string;
  error?: string;
  role: AgentRole;
}

/**
 * EL CONTRATO. Cualquier agente (simulado o real) debe implementar esto.
 *
 * `run` es asincrono a proposito: los agentes reales haran trabajo lento
 * (lanzar un CLI, llamar a un modelo). Dejarlo async desde ya evita reescribir
 * los nodos cuando lleguen los agentes reales.
 *
 * Contrato de comportamiento esperado de las implementaciones:
 * - Un fallo de ejecucion se refleja devolviendo `status: "failure"` con
 *   `error`, NO lanzando una excepcion. Esto mantiene el flujo del grafo
 *   predecible (el nodo siempre recibe un AgentResult).
 */
export interface AgentAdapter {
  /** Identificador legible del adaptador (p. ej. "mock", "claude-code"). */
  readonly name: string;

  /** Ejecuta una tarea para un rol y devuelve un resultado estructurado. */
  run(request: AgentRequest): Promise<AgentResult>;
}
