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
  | "knowledge.proposed"
  | "knowledge.approved"
  // (Project Context, T6) Eventos de contexto: llevan `projectId` y van en el stream del proyecto.
  | "context.scan.queued"
  | "context.scan.started"
  | "context.scan.progress"
  | "context.scan.completed"
  | "context.scan.failed"
  | "context.scan.interrupted"
  | "context.snapshot.published"
  | "context.freshness.changed"
  // (T11) Project Analyst: en el stream del proyecto.
  | "project.analysis.started"
  | "project.analysis.completed"
  | "project.analysis.failed";

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
  /** (T10) Versión propuesta (1 = documento nuevo). Ausente en eventos anteriores. */
  version?: number;
}
/** (T10) Una persona aprobó una versión: pasa a ser la oficial. */
export interface KnowledgeApprovedData {
  docId: string;
  documentId: string;
  version: number;
  title: string;
  category: string;
  actor: string;
}

/** (T11) Análisis del proyecto (Project Analyst). */
export interface ProjectAnalysisEventData {
  analysisId: string;
  snapshotId: string;
  /** completed: ids de las versiones propuestas y número de documentos omitidos. */
  proposed?: string[];
  skipped?: number;
  /** failed: error ya saneado. */
  error?: string;
}

/** (T6) Datos comunes de los eventos de un escaneo. */
export interface ContextScanEventData {
  scanId: string;
  mode: "full" | "incremental";
  trigger: string;
}
export interface ContextScanProgressData extends ContextScanEventData {
  phase: "hashing";
  listed: number;
  toHash: number;
  hashed: number;
}
export interface ContextScanCompletedData extends ContextScanEventData {
  snapshotId: string;
  stats: Record<string, unknown>;
}
export interface ContextScanEndedData extends ContextScanEventData {
  /** Motivo saneado (sin rutas absolutas ni secretos). */
  error: string;
}
export interface ContextSnapshotData {
  snapshotId: string;
  scanId: string;
  createdAt: string;
}
export interface ContextFreshnessData {
  freshness: "ready" | "stale";
  reason: "changes_detected" | "project_unavailable" | null;
  changedPaths: number | null;
  snapshotId: string;
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
  "knowledge.approved": KnowledgeApprovedData;
  "context.scan.queued": ContextScanEventData;
  "context.scan.started": ContextScanEventData;
  "context.scan.progress": ContextScanProgressData;
  "context.scan.completed": ContextScanCompletedData;
  "context.scan.failed": ContextScanEndedData;
  "context.scan.interrupted": ContextScanEndedData;
  "context.snapshot.published": ContextSnapshotData;
  "context.freshness.changed": ContextFreshnessData;
  "project.analysis.started": ProjectAnalysisEventData;
  "project.analysis.completed": ProjectAnalysisEventData;
  "project.analysis.failed": ProjectAnalysisEventData;
}

/** Un evento de dominio. `seq` lo asigna el store (orden por ejecución). */
export interface SaikiEvent<T extends SaikiEventType = SaikiEventType> {
  eventId: string;
  type: T;
  executionId?: string;
  sessionId?: string;
  /** (T6) Proyecto de un evento de contexto; su `seq` es del stream del proyecto. */
  projectId?: string;
  timestamp: string;
  /** Secuencia incremental por ejecución (para Last-Event-ID). Lo fija el store. */
  seq?: number;
  data: EventDataByType[T];
}

/** Entrada para publicar un evento (sin seq; lo asigna el store). */
export type NewEvent<T extends SaikiEventType = SaikiEventType> = Omit<SaikiEvent<T>, "seq">;
