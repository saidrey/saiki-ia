import type { Capability } from "../agents/capabilities.js";
import type { RuntimeId } from "../agents/runtime.js";
import type { AgentRole } from "../agents/types.js";

/**
 * Contrato común de DELEGACIÓN de tareas (Fase 14).
 *
 * Una tarea delegada es trabajo que el moderador encarga a un agente auxiliar
 * (p. ej. una investigación con el rol `assistant`), SIN iniciar el flujo de
 * desarrollo. El contrato captura todo lo necesario para ejecutar, auditar y
 * presentar el resultado.
 *
 * REGLA DURA: el resultado de un agente NUNCA es una decisión aprobada por sí
 * mismo. El moderador recibe el resultado y decide cómo presentarlo; promover
 * conocimiento a oficial requiere aprobación humana (ver Knowledge Base).
 */

/** Estado de ejecución de una tarea delegada. */
export type TaskStatus =
  | "pending" // creada, aún no ejecutada
  | "blocked" // bloqueada por permisos insuficientes (NO se ejecutó)
  | "running" // en ejecución
  | "succeeded" // terminó con éxito (resultado disponible)
  | "failed"; // falló (error disponible; no se finge éxito)

/** Fuente/evidencia citada por una investigación (sin secretos). */
export interface Evidence {
  description: string;
  /** URL o referencia (opcional). */
  source?: string;
}

/** Contrato de una tarea delegada. */
export interface DelegatedTask {
  /** Identificador único de la tarea. */
  id: string;
  /** Solicitud original del usuario (texto). */
  request: string;
  /** Objetivo concreto de la tarea. */
  goal: string;
  /** Contexto disponible para el agente (saco de datos serializable). */
  context: Record<string, unknown>;
  /** Rol seleccionado (p. ej. "assistant"). */
  agentRole: AgentRole;
  /** Runtime seleccionado para ejecutar el rol. */
  runtime: RuntimeId;
  /** Capacidades REQUERIDAS por la tarea (se validan antes de ejecutar). */
  requiredCapabilities: Capability[];
  /** Permisos CONCEDIDOS a la tarea (subconjunto autorizado). */
  grantedCapabilities: Capability[];
  /** Referencias a documentos de la Knowledge Base relevantes (por id). */
  memoryRefs: string[];
  /** Estado de ejecución. */
  status: TaskStatus;
  /** Resultado textual estructurado para que el moderador lo presente. */
  result?: string;
  /**
   * (Fase 17) Síntesis natural del resultado producida por el moderador. Se
   * persiste para NO re-sintetizar al recuperar una ejecución interrumpida.
   * Ausente si el moderador no soporta síntesis o si la síntesis falló.
   */
  synthesis?: string;
  /** Evidencias/fuentes (para investigaciones). */
  evidence: Evidence[];
  /** Errores y limitaciones (si los hubo). */
  errors: string[];
  createdAt: string;
  updatedAt: string;
}

/** Parámetros para crear una tarea delegada (los campos derivados se rellenan). */
export interface CreateDelegatedTaskInput {
  id: string;
  request: string;
  goal: string;
  context?: Record<string, unknown>;
  agentRole: AgentRole;
  runtime: RuntimeId;
  requiredCapabilities: Capability[];
  grantedCapabilities: Capability[];
  memoryRefs?: string[];
}

/** Crea una tarea delegada en estado `pending`. */
export function createDelegatedTask(input: CreateDelegatedTaskInput): DelegatedTask {
  const now = new Date().toISOString();
  return {
    id: input.id,
    request: input.request,
    goal: input.goal,
    context: input.context ?? {},
    agentRole: input.agentRole,
    runtime: input.runtime,
    requiredCapabilities: input.requiredCapabilities,
    grantedCapabilities: input.grantedCapabilities,
    memoryRefs: input.memoryRefs ?? [],
    status: "pending",
    evidence: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
  };
}
