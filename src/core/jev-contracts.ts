import type { ModeratorSession } from "../moderator/moderator-types.js";
import type { DelegatedTask } from "../moderator/delegation.js";
import type { KnowledgeCategory, KnowledgeDoc, KnowledgeQuery } from "../knowledge/kb-types.js";
import type { KnowledgeErrorCode } from "../knowledge/kb-store.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { ProjectHistoryRecord, ProjectStatus } from "./core-store.js";
import type { ProjectResult, ProjectView, RegisterInput, UpdateInput } from "../projects/project-registry.js";
import type { FileQuery, ScanChangesRecord, ScanMode, ScanStats, ScanStatus, ScanTrigger } from "../context/context-store.js";
import type { ScanTargetErrorCode } from "../context/scan-scheduler.js";
import type { FileKind } from "../context/file-classifier.js";
import type { ProjectSummaryV2 } from "../context/summary-shared.js";

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
  searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeDocView[]>;
  getKnowledgeDoc(id: string): Promise<KnowledgeDocView | null>;
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

/** (Project Context) Estado del contexto de un proyecto (§10). */
export type ProjectContextStatus = "none" | "scanning" | "ready" | "stale" | "failed";

/**
 * (T6) Escaneo tal como lo ve Jev: sin raíz absoluta, huella del repositorio ni
 * firma de frescura (datos internos). `error` va saneado.
 */
export interface ContextScanView {
  id: string;
  projectId: string;
  mode: ScanMode;
  status: ScanStatus;
  trigger: ScanTrigger;
  /** Commit (HEAD) al empezar, si el repositorio tiene commits. */
  gitHead: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: ScanStats | null;
  error: string | null;
}

/** (T6) Detalle de un escaneo: cambios detectados (acotados) y snapshot publicado. */
export interface ContextScanDetailView extends ContextScanView {
  changes: ScanChangesRecord | null;
  snapshotId: string | null;
}

export interface ContextSnapshotView {
  id: string;
  scanId: string;
  createdAt: string;
  summary: ProjectSummaryV2;
}

/** (T6) Archivo indexado: metadatos, sin contenido ni hash. */
export interface ContextFileView {
  path: string;
  kind: FileKind;
  lang: string | null;
  size: number;
  mtimeMs: number;
}

export interface ProjectContextView {
  projectId: string;
  status: ProjectContextStatus;
  /** Último snapshot válido (sigue vigente aunque haya un escaneo en curso o fallido). */
  snapshot: ContextSnapshotView | null;
  /** Escaneo `queued` o `running`. */
  currentScan: ContextScanView | null;
  /** Último escaneo terminado (completado, fallido o interrumpido). */
  lastScan: ContextScanView | null;
  /** Por qué el snapshot puede no reflejar el repositorio (solo si hay snapshot). */
  stale: { reason: "changes_detected" | "project_unavailable"; changedPaths: number | null } | null;
}

export type ContextScanResult =
  | { ok: true; scan: ContextScanView; /** true si se devolvió el escaneo ya activo. */ deduplicated: boolean }
  | { ok: false; code: ScanTargetErrorCode | "scheduler_closed" | "context_disabled"; message: string };

/**
 * (Project Context) Fachada del contexto de proyectos. Solo el humano pide
 * escaneos (vía API); los escaneos automáticos los lanza el Core. Ningún agente
 * tiene acceso. Las consultas devuelven null si el proyecto (o el escaneo o
 * snapshot de ESE proyecto) no existe.
 */
export interface JevContextPort {
  getProjectContext(projectId: string): Promise<ProjectContextView | null>;
  requestContextScan(projectId: string, mode?: ScanMode): Promise<ContextScanResult>;
  listContextScans(projectId: string, limit?: number): Promise<ContextScanView[] | null>;
  getContextScan(projectId: string, scanId: string): Promise<ContextScanDetailView | null>;
  getContextSnapshot(projectId: string, snapshotId: string): Promise<ContextSnapshotView | null>;
  listContextFiles(projectId: string, query?: FileQuery): Promise<{ files: ContextFileView[]; nextCursor: string | null } | null>;
  /** (T9) Texto congelado que recibieron Kiro y Claude en una ejecución. Nunca se reconstruye. */
  getExecutionContextBundles(executionId: string, huVersion?: number): Promise<ExecutionContextBundlesResult>;
}

/** (T9) Bundles congelados de una ejecución: el texto exacto y lo justo para identificarlos (sin hashes). */
export interface ExecutionContextBundlesView {
  executionId: string;
  projectId: string;
  huVersion: number;
  snapshotId: string | null;
  builtAt: string;
  stale: boolean;
  staleReason: string | null;
  /** Texto entregado al analista técnico (Kiro). */
  technicalBundle: string;
  /** Subconjunto entregado al desarrollador (Claude). */
  developerBundle: string;
}

export type ExecutionContextBundlesResult =
  | { ok: true; context: ExecutionContextBundlesView }
  | { ok: false; code: "not_found" | "not_frozen" | "integrity_failed"; message: string };

/**
 * Fachada completa que el Core ofrece a Jev: consulta + acción. Jev depende
 * SOLO de esta interfaz, no de los módulos internos (agentes, runtimes, grafo).
 */
/** (T10) Versión de un documento tal como la ve Jev: con el hash que se aprueba. */
export type KnowledgeDocView = KnowledgeDoc & { versionHash: string };

export type KnowledgeResult =
  | { ok: true; document: KnowledgeDocView }
  | { ok: false; code: KnowledgeErrorCode | "project_not_found"; message: string };

/**
 * (T10) Conocimiento por proyecto y versionado. Proponer lo puede hacer una
 * persona (vía API) o un proceso existente; aprobar, rechazar y archivar, solo
 * la identidad humana local. Global (projectId null) y proyecto no se mezclan.
 */
export interface JevKnowledgePort {
  /** Versiones de un documento; null si no existe. */
  getKnowledgeVersions(docId: string): Promise<KnowledgeDocView[] | null>;
  proposeProjectKnowledge(
    projectId: string,
    input: { category: KnowledgeCategory; title: string; content: string },
    actor: string,
  ): Promise<KnowledgeResult>;
  proposeKnowledgeVersion(docId: string, changes: { title?: string; content?: string }, actor: string): Promise<KnowledgeResult>;
  /** Aprobar o rechazar EXACTAMENTE la versión revisada (`versionHash`). */
  decideKnowledge(docId: string, decision: "approve" | "reject", versionHash: string, humanActor: string): Promise<KnowledgeResult>;
  archiveKnowledge(docId: string, humanActor: string): Promise<KnowledgeResult>;
  /** Conocimiento aprobado del proyecto en Markdown; null si el proyecto no existe. */
  exportProjectKnowledge(projectId: string): Promise<string | null>;
}

/**
 * (T11) Project Analyst: análisis manual del proyecto que solo PROPONE
 * conocimiento (`proposed`). El estado del último análisis vive en memoria; las
 * propuestas, en la KB.
 */
export interface ProjectAnalysisView {
  id: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  snapshotId: string;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
  /** Versiones creadas como `proposed`. */
  proposed: Array<{ docId: string; documentId: string; version: number; title: string; category: string; basedOn: string | null; citedFiles: string[] }>;
  /** Documentos omitidos (p. ej. el documento base ya tiene una propuesta pendiente). */
  skipped: Array<{ title: string; basedOn: string | null; reason: string }>;
  error: string | null;
}

export type ProjectAnalysisResult =
  | { ok: true; analysis: ProjectAnalysisView }
  | { ok: false; code: ScanTargetErrorCode | "context_disabled" | "no_snapshot" | "analysis_running" | "index_mismatch"; message: string };

export interface JevProjectAnalysisPort {
  /** Lanza el análisis (una llamada al agente) y devuelve enseguida su estado `running`. */
  analyzeProject(projectId: string, actor: string): Promise<ProjectAnalysisResult>;
  /** Último análisis del proyecto en este proceso; null si no hay o el proyecto no existe. */
  getProjectAnalysis(projectId: string): Promise<ProjectAnalysisView | null>;
}

export interface JevCorePort extends JevQueryPort, JevCommandPort, JevProjectPort, JevContextPort, JevKnowledgePort, JevProjectAnalysisPort {}
