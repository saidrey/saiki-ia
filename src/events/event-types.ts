import type { StageId } from "../core/execution-view.js";

/**
 * Contrato tipado de EVENTOS DE DOMINIO (Fase 20).
 *
 * Los eventos reflejan hechos REALES observados por el Core (inicio/fin de
 * ejecución y etapas, aprobaciones, mensajes de asistencia, propuestas de
 * conocimiento). NO se inventan eventos para "completar" un pipeline: un evento
 * de etapa solo se emite cuando el Core observa que esa etapa cambió de estado.
 *
 * `data` NO contiene secretos, tokens ni stderr crudo (el Core sanea antes de
 * publicar).
 */

/** Tipos de evento soportados inicialmente. */
export type SaikiEventType =
  | "execution.started"
  | "execution.completed"
  | "execution.failed"
  | "execution.stopped"
  | "stage.started"
  | "stage.completed"
  | "stage.failed"
  | "approval.required"
  | "approval.resolved"
  | "assistant.message"
  | "knowledge.proposed";

/** Datos específicos por tipo (tipados). */
export interface StageEventData {
  stageId: StageId;
  label: string;
  detail?: string;
}
export interface ExecutionEventData {
  phase: string;
  status: string;
  /** (Estabilización) Ciclo de vida en el momento del evento. */
  lifecycle?: string;
}
export interface ApprovalRequiredData {
  kind: string;
  proposalHash?: string;
  /** (Fase 21) Hash de la versión que se decide (cualquier tipo de aprobación). */
  decisionHash?: string;
}
export interface ApprovalResolvedData {
  decision: "approve" | "reject" | "request_changes";
  actor: string;
  /**
   * Hash de la versión decidida. En `final_approval` es el de la propuesta; en
   * `hu_review`/`feasibility_partial` (Fase 21) es su `decisionHash`.
   */
  proposalHash: string;
  phase: string;
  /** (Fase 21) Tipo de aprobación resuelta. */
  kind?: string;
}
export interface AssistantMessageData {
  taskId: string;
  status: string;
  /** Texto ya saneado (síntesis o resultado); nunca stderr crudo. */
  summary: string;
}
export interface KnowledgeProposedData {
  docId: string;
  title: string;
  category: string;
}

/** Mapa tipo → forma de `data`. */
export interface EventDataByType {
  "execution.started": ExecutionEventData;
  "execution.completed": ExecutionEventData;
  "execution.failed": ExecutionEventData;
  "execution.stopped": ExecutionEventData;
  "stage.started": StageEventData;
  "stage.completed": StageEventData;
  "stage.failed": StageEventData;
  "approval.required": ApprovalRequiredData;
  "approval.resolved": ApprovalResolvedData;
  "assistant.message": AssistantMessageData;
  "knowledge.proposed": KnowledgeProposedData;
}

/** Un evento de dominio. `seq` lo asigna el store (orden por ejecución). */
export interface SaikiEvent<T extends SaikiEventType = SaikiEventType> {
  eventId: string;
  type: T;
  executionId?: string;
  sessionId?: string;
  timestamp: string;
  /** Secuencia incremental por ejecución (para Last-Event-ID). Lo fija el store. */
  seq?: number;
  data: EventDataByType[T];
}

/** Entrada para publicar un evento (sin seq; lo asigna el store). */
export type NewEvent<T extends SaikiEventType = SaikiEventType> = Omit<SaikiEvent<T>, "seq">;
