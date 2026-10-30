/**
 * Contratos de la API de Saiki-IA, COPIADOS de docs/API.md y del handoff
 * (no se importan del Core: el frontend no depende de `src/`).
 */

/** `GET /health` */
export interface HealthResponse {
  ok: boolean;
}

/** Cuerpo de error de la API (`{ error, message, ... }`). */
export interface ApiErrorBody {
  error: string;
  message: string;
  expectedHash?: string;
  pendingKind?: string;
}

// ── Sesiones ────────────────────────────────────────────────────────────────

export type HandleCategory = "conversation" | "assistance" | "development" | "clarification";

export interface ConversationTurn {
  role: "user" | "moderator";
  text: string;
  at: string;
  classification?: unknown;
}

export interface ModeratorSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  delegatedTaskIds: string[];
  /** Ejecución de desarrollo más reciente de la sesión (= executionId). */
  developmentThreadId?: string;
  /** Todas sus ejecuciones, en orden de creación (una por solicitud). Ausente en sesiones antiguas. */
  developmentThreadIds?: string[];
  /** Proyecto de la sesión, fijo desde su creación. Ausente = sesión general (solo conversación). */
  projectId?: string;
}

export type TaskStatus = "pending" | "blocked" | "running" | "succeeded" | "failed";

export interface Evidence {
  description: string;
  source?: string;
}

export interface DelegatedTask {
  id: string;
  request: string;
  goal: string;
  context: Record<string, unknown>;
  agentRole: string;
  runtime: string;
  requiredCapabilities: string[];
  grantedCapabilities: string[];
  memoryRefs: string[];
  status: TaskStatus;
  result?: string;
  synthesis?: string;
  evidence: Evidence[];
  errors: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HandleResult {
  sessionId: string;
  category: HandleCategory;
  confidence: number;
  reason: string;
  reply?: string;
  clarifyingQuestion?: string;
  task?: DelegatedTask;
  /** Solo en `development`: es el executionId. */
  developmentThreadId?: string;
  /** En `clarification`: por qué una solicitud de desarrollo no inició una ejecución. */
  blockedReason?: "project_required" | "project_unavailable";
}

export interface CreateSessionResponse {
  sessionId: string;
  existed: boolean;
  projectId?: string;
}
export interface SessionsResponse {
  sessions: ModeratorSession[];
}
export interface SessionResponse {
  session: ModeratorSession;
  tasks: DelegatedTask[];
}
export interface MessageResponse {
  result: HandleResult;
}

// ── Ejecuciones ─────────────────────────────────────────────────────────────

export type Availability = "available" | "unavailable" | "not_applicable";
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "not_applicable";
export type StageId =
  | "hu_analysis"
  | "technical_analysis"
  | "feasibility"
  | "development"
  | "functional_review"
  | "quality_review"
  | "final_approval"
  | "apply"
  | "verify";

export interface ExecutionStage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
}

export interface PendingApprovalView {
  required: boolean;
  /** "hu_review" | "feasibility_partial" | "final_approval" (u otro que la API añada). */
  kind?: string;
  proposalHash?: string;
  /** Hash de la versión a decidir, para cualquier tipo de aprobación. */
  decisionHash?: string;
}

export interface FinalResultView {
  available: Availability;
  outcome?: string;
  detail?: string;
}

/** Ciclo de vida (única clasificación fiable del estado; la calcula el backend). */
export type ExecutionLifecycle = "running" | "awaiting_decision" | "interrupted" | "completed" | "failed" | "stopped";

export interface ExecutionView {
  executionId: string;
  sessionId: Availability | string;
  request: Availability | string;
  category: "development";
  /** Texto legible del estado general (lo redacta el backend). */
  status: string;
  /** Fase cruda y estable, p. ej. "applied". */
  phase: string;
  currentStage: StageId | "none";
  /** Siempre las 9 etapas. */
  stages: ExecutionStage[];
  runtime: Availability | string;
  errors: string[];
  retries: number;
  pendingApproval: PendingApprovalView;
  finalResult: FinalResultView;
  events?: unknown[];
  lifecycle: ExecutionLifecycle;
  activity: { active: boolean; since?: string; trigger?: "message" | "decision" };
  /** Etapa que se ejecuta de verdad ("none" si no hay actividad). */
  activeStage: StageId | "none";
  /** Decisión humana esperada y su posición en el pipeline. */
  awaitingDecision: { kind: string; stageId?: StageId; afterStageId?: StageId } | null;
  /** Proyecto con el que nació (copia inmutable) y su estado actual. null = anterior al registro. */
  project?: ExecutionProject | null;
  /** Directorio donde se aplicó (repo real o sandbox de la ejecución), si ya se aplicó. */
  applyTarget?: string | null;
}

export interface ExecutionProject {
  id: string;
  /** Nombre al empezar la ejecución. */
  name: string;
  rootPath: string;
  applyMode: ApplyMode;
  boundAt: string;
  current: { name: string; status: ProjectStatus; applyMode: ApplyMode; health: ProjectHealth; healthDetail?: string } | null;
}

// ── Proyectos ───────────────────────────────────────────────────────────────

export type ProjectStatus = "active" | "inactive";
export type ApplyMode = "sandbox" | "real";
export type ProjectHealth = "ok" | "missing" | "moved" | "not_a_repository" | "not_accessible";

export interface Project {
  id: string;
  name: string;
  /** Ruta real del repositorio; no se edita. */
  rootPath: string;
  status: ProjectStatus;
  applyMode: ApplyMode;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** Calculada por el backend al leer. */
  health: ProjectHealth;
  healthDetail?: string;
}

export interface ProjectHistoryEntry {
  id: string;
  projectId: string;
  action: "registered" | "renamed" | "apply_mode_changed" | "deactivated" | "reactivated";
  actor: string;
  at: string;
  details: Record<string, unknown>;
}

export interface ProjectsResponse {
  projects: Project[];
}
export interface ProjectResponse {
  project: Project;
}
export interface ProjectHistoryResponse {
  projectId: string;
  history: ProjectHistoryEntry[];
}

export interface ExecutionResponse {
  execution: ExecutionView;
}

// ── Eventos (SSE) — docs/EVENTS.md ──────────────────────────────────────────

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

export const EXECUTION_EVENT_TYPES: readonly SaikiEventType[] = [
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.stopped",
  "stage.started",
  "stage.completed",
  "stage.failed",
  "approval.required",
  "approval.resolved",
];

export interface ExecutionEventData {
  phase: string;
  status: string;
  lifecycle?: ExecutionLifecycle;
}
export interface StageEventData {
  stageId: StageId;
  label: string;
  detail?: string;
}
export interface ApprovalRequiredData {
  kind: string;
  proposalHash?: string;
  decisionHash?: string;
}
export interface ApprovalResolvedData {
  decision: "approve" | "reject" | "request_changes";
  actor: string;
  /** Hash de la versión decidida (en HU/viabilidad, su decisionHash). */
  proposalHash: string;
  phase: string;
  kind?: string;
}

export interface SaikiEvent {
  eventId: string;
  type: SaikiEventType;
  executionId?: string;
  sessionId?: string;
  timestamp: string;
  seq?: number;
  data: ExecutionEventData | StageEventData | ApprovalRequiredData | ApprovalResolvedData | Record<string, unknown>;
}

/**
 * Evento de control `event: control`: `gap` (eventos fuera de la retención),
 * `end` (ejecución definitiva: no habrá más eventos), `shutdown` (el servidor se apaga).
 */
export interface ControlEventData {
  kind: string;
  from?: number;
  earliest?: number;
  reason?: string;
  lastSeq?: number;
}

// ── Aprobaciones — docs/API.md §5.1 ─────────────────────────────────────────

export type HumanDecision = "approve" | "reject" | "request_changes";
export type DecisionGateKind = "hu_review" | "feasibility_partial";

export interface AnalyzedHu {
  summary: string;
  need: string;
  tasks: Array<{ order: number; description: string }>;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  assumptions: string[];
  openQuestions: string[];
  dependencies: string[];
}

export interface TechnicalAnalysis {
  summary: string;
  currentFlow: string;
  affectedFiles: Array<{ path: string; responsibility: string; exists?: boolean }>;
  proposedChanges: Array<{ path: string; change: string }>;
  traceability: Array<{ ref: string; note: string }>;
  dependencies: string[];
  risks: string[];
  openQuestions: string[];
}

export interface HuReviewGateView {
  kind: "hu_review";
  threadId: string;
  decisionHash: string;
  version: number;
  revisionsUsed: number;
  maxRevisions: number;
  allowedDecisions: HumanDecision[];
  hu: AnalyzedHu;
}

export interface FeasibilityGateView {
  kind: "feasibility_partial";
  threadId: string;
  decisionHash: string;
  feasibility: string;
  reasons: string[];
  unresolvedPaths: string[];
  allowedDecisions: HumanDecision[];
  technicalAnalysis: TechnicalAnalysis | null;
}

export type DecisionGateView = HuReviewGateView | FeasibilityGateView;

export interface ProposalView {
  threadId: string;
  proposalHash: string;
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  risks: string[];
}

/** `GET /executions/:id/approval` */
export interface ApprovalResponse {
  pendingApproval: PendingApprovalView;
  proposal: ProposalView | null;
  gate: DecisionGateView | null;
}

/** Resolución correcta (200). La identidad la fija el servidor. */
export interface ResolutionBase {
  ok: true;
  decision: HumanDecision;
  actor: string;
  resolvedAt: string;
  phase: string;
}
export interface ProposalResolution extends ResolutionBase {
  proposalHash: string;
}
export interface GateResolution extends ResolutionBase {
  kind: DecisionGateKind;
  decisionHash: string;
}
export interface ResolutionResponse<R> {
  resolution: R;
}

// ── Knowledge Base (solo lectura) ───────────────────────────────────────────

export type KnowledgeCategory = "architecture" | "projects" | "research" | "decisions" | "lessons" | "conventions";
export type KnowledgeStatus = "proposed" | "approved" | "superseded" | "archived";

export interface KnowledgeDoc {
  id: string;
  title: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  content: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

export interface KnowledgeSearchResponse {
  documents: KnowledgeDoc[];
}
export interface KnowledgeDocResponse {
  document: KnowledgeDoc;
}

// ── Historial de propuestas y decisiones (inmutable) ────────────────────────

export interface DecisionView {
  id: string;
  executionId: string;
  kind: string;
  subjectHash: string;
  decision: HumanDecision;
  actor: string;
  feedback: string | null;
  resolvedAt: string;
  phaseAfter: string;
  /** "events": reconstruida de eventos antiguos (sin observaciones). */
  source: "recorded" | "events";
}

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "rejected_by_review"
  | "current"
  | "superseded";

export interface ProposalHistoryItem {
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
  applied: boolean;
  reviews: Array<{ kind: "functional" | "quality"; cycle: number; decision: string }>;
  decision: DecisionView | null;
}

export interface ProposalsResponse {
  executionId: string;
  proposals: ProposalHistoryItem[];
}
export interface DecisionsResponse {
  executionId: string;
  decisions: DecisionView[];
}
