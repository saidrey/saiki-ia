import type { ModeratorSession } from "../moderator/moderator-types.js";
import type { DelegatedTask } from "../moderator/delegation.js";
import type { KnowledgeDoc, KnowledgeQuery } from "../knowledge/kb-types.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { ProjectHistoryRecord, ProjectStatus } from "./core-store.js";
import type { ProjectResult, ProjectView, RegisterInput, UpdateInput } from "../projects/project-registry.js";

export type { ProjectView, ProjectResult } from "../projects/project-registry.js";

/**
 * Contratos de integración para la futura interfaz JEV (Fase 14 — solo límites).
 *
 * Jev será ÚNICAMENTE la interfaz (conversaciones, sesiones, tareas, estado de
 * flujos, aprobaciones humanas, consulta de memoria, propuestas/resultados,
 * historial). NO implementa reglas de negocio, NO ejecuta agentes directamente
 * y NO contiene lógica de aprobación.
 *
 * Por eso aquí NO se construye frontend, chat, voz ni WebSockets. Se definen los
 * PUERTOS (interfaces) que el Core expone: una fachada estable para que Jev
 * consulte y dispare acciones que el Core gobierna. Jev no conoce los detalles
 * internos de los agentes ni de los runtimes.
 *
 * Separación: las consultas son de SOLO LECTURA; las acciones (enviar mensaje,
 * resolver una aprobación) las EJECUTA EL CORE, no Jev.
 */

/** Vista mínima del estado de un flujo de desarrollo (sin internals de agentes). */
export interface FlowStatusView {
  threadId: string;
  phase: string;
  /** Resumen legible de en qué punto está el flujo. */
  summary: string;
  /** ¿Está esperando una aprobación humana ahora mismo? */
  awaitingApproval: boolean;
}

/** Vista de una propuesta pendiente de aprobación (lo que Jev mostraría). */
export interface ProposalView {
  threadId: string;
  proposalHash: string;
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  risks: string[];
}

/** Decisión humana que Jev transmite (NO la decide Jev; la recoge del usuario). */
export type HumanDecision = "approve" | "reject" | "request_changes";

/**
 * (Fase 21) Puertas de decisión humana distintas de la aprobación final de la
 * propuesta (que sigue resolviéndose con `proposalHash`).
 */
export type DecisionGateKind = "hu_review" | "feasibility_partial";

/** (Fase 21) Revisión de la HU pendiente: lo que el humano necesita para decidir. */
export interface HuReviewGateView {
  kind: "hu_review";
  threadId: string;
  /** Hash de la versión en revisión; la decisión debe reenviarlo tal cual. */
  decisionHash: string;
  /** Número de versión de la HU (1 = inicial; aumenta con cada revisión). */
  version: number;
  revisionsUsed: number;
  maxRevisions: number;
  /** `request_changes` con el cupo agotado termina el flujo (revision_limit). */
  allowedDecisions: HumanDecision[];
  hu: AnalyzedHu;
}

/** (Fase 21) Decisión de viabilidad parcial pendiente. */
export interface FeasibilityGateView {
  kind: "feasibility_partial";
  threadId: string;
  decisionHash: string;
  feasibility: string;
  reasons: string[];
  unresolvedPaths: string[];
  /** `approve` = proceder con lo implementable; `reject` = no desarrollar. */
  allowedDecisions: HumanDecision[];
  technicalAnalysis: TechnicalAnalysis | null;
}

export type DecisionGateView = HuReviewGateView | FeasibilityGateView;

/** (Estabilización) Decisión humana registrada (inmutable). */
export interface DecisionView {
  id: string;
  executionId: string;
  kind: string;
  /** Hash exacto de la versión decidida. */
  subjectHash: string;
  decision: HumanDecision;
  actor: string;
  /** Observaciones; null si no hubo o si la decisión se reconstruyó de eventos. */
  feedback: string | null;
  resolvedAt: string;
  phaseAfter: string;
  source: "recorded" | "events";
}

/**
 * (Estabilización) Estado de una versión de propuesta en el historial:
 * pending (espera la aprobación final), approved, rejected, changes_requested
 * (decisión humana); rejected_by_review (una revisión automática la rechazó y se
 * rehízo); current (vigente sin decisión, p. ej. en revisión o ejecución
 * detenida); superseded (reemplazada sin decisión ni rechazo registrado).
 */
export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "rejected_by_review"
  | "current"
  | "superseded";

/** (Estabilización) Una versión de propuesta tal como existió, con su revisión y decisión. */
export interface ProposalHistoryItem {
  /** `${executionId}:v${version}` */
  id: string;
  executionId: string;
  version: number;
  proposalHash: string;
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  risks: string[];
  createdAt: string;
  status: ProposalStatus;
  /** Es la versión que el Safe Applier aplicó. */
  applied: boolean;
  reviews: Array<{ kind: "functional" | "quality"; cycle: number; decision: string }>;
  /** Decisión humana final sobre esta versión, si la hubo. */
  decision: DecisionView | null;
}

/**
 * Puerto de CONSULTA (solo lectura) que el Core expone a Jev. Todo lo que Jev
 * necesita MOSTRAR pasa por aquí. No hay escritura ni ejecución.
 */
export interface JevQueryPort {
  listSessions(): Promise<ModeratorSession[]>;
  getSession(sessionId: string): Promise<ModeratorSession | null>;
  listTasks(sessionId: string): Promise<DelegatedTask[]>;
  getFlowStatus(threadId: string): Promise<FlowStatusView | null>;
  getPendingProposal(threadId: string): Promise<ProposalView | null>;
  searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeDoc[]>;
  getKnowledgeDoc(id: string): Promise<KnowledgeDoc | null>;
}

/**
 * Puerto de ACCIÓN que Jev invoca pero el CORE ejecuta. Jev solo transmite la
 * intención del usuario; el Core aplica las reglas de negocio y las
 * aprobaciones. Jev NUNCA ejecuta agentes ni el Safe Applier.
 */
export interface JevCommandPort {
  /** Enruta un mensaje del usuario al moderador (el Core decide qué hacer). */
  sendMessage(sessionId: string, message: string): Promise<void>;
  /**
   * Transmite una decisión humana sobre una aprobación. El Core la valida y
   * reanuda el flujo; Jev no contiene la lógica de aprobación.
   */
  submitApproval(threadId: string, decision: HumanDecision, feedback?: string): Promise<void>;
  /**
   * Solicita promover conocimiento a oficial. El Core exige actor humano; Jev
   * solo transmite la solicitud, no aprueba por sí mismo.
   */
  requestKnowledgeApproval(docId: string, humanActor: string): Promise<void>;
}

/**
 * (Project Registry) Administración del registro de proyectos. Solo el humano la
 * usa, a través de la API (el actor lo fija el servidor). Ningún agente, ni el
 * moderador ni el grafo, tiene acceso a estas operaciones.
 */
export interface JevProjectPort {
  listProjects(status?: ProjectStatus): Promise<ProjectView[]>;
  getProject(projectId: string): Promise<ProjectView | null>;
  getProjectHistory(projectId: string): Promise<ProjectHistoryRecord[] | null>;
  registerProject(input: RegisterInput, actor: string): Promise<ProjectResult>;
  updateProject(projectId: string, input: UpdateInput, actor: string): Promise<ProjectResult>;
  deactivateProject(projectId: string, actor: string): Promise<ProjectResult>;
  activateProject(projectId: string, actor: string): Promise<ProjectResult>;
}

/**
 * Fachada completa que el Core ofrece a Jev: consulta + acción. Jev depende
 * SOLO de esta interfaz, no de los módulos internos (agentes, runtimes, grafo).
 */
export interface JevCorePort extends JevQueryPort, JevCommandPort, JevProjectPort {}
