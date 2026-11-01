import type { HuStateType, HuPhase } from "../hu/hu-state.js";
import type { ModeratorSession } from "../moderator/moderator-types.js";
import { hashHuReview } from "../hu/hu-schema.js";
import { hashFeasibilityDecision } from "../dev/feasibility.js";
import { deriveLifecycle, terminalLifecycle, type ActiveRun, type ExecutionLifecycle } from "./execution-lifecycle.js";

/**
 * Vista NORMALIZADA de una ejecución (Fase 19).
 *
 * Proyecta el estado interno del grafo (`HuState`) a una forma ESTABLE para la
 * API, SIN exponer la estructura interna. Es honesta: distingue información
 * disponible, no disponible y no aplicable, y NO inventa etapas, resultados ni
 * estados para "rellenar" la vista.
 *
 * La estructura está pensada para que la Fase 20 pueda añadir eventos sin romper
 * el contrato (campo `events` reservado, opcional).
 */

/** Disponibilidad de un dato proyectado. */
export type Availability = "available" | "unavailable" | "not_applicable";

/** Estado de una etapa del flujo. */
export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped" | "not_applicable";

/** Identificadores estables de las etapas del flujo de desarrollo. */
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

/** Una etapa proyectada. */
export interface ExecutionStage {
  id: StageId;
  label: string;
  status: StageStatus;
  /** Resumen legible de lo que ocurrió en la etapa (si hay dato). */
  detail?: string;
}

/** Aprobación pendiente, si la hay. */
export interface PendingApprovalView {
  required: boolean;
  /** Tipo de aprobación esperada (p. ej. "final_approval", "hu_review"). */
  kind?: string;
  proposalHash?: string;
  /**
   * (Fase 21) Hash de la versión que se decide, para cualquier tipo de
   * aprobación (en `final_approval` coincide con `proposalHash`). La decisión
   * debe reenviarlo tal cual; si la versión cambió, se rechaza.
   */
  decisionHash?: string;
}

/** Resultado final de la ejecución, si llegó a un estado terminal. */
export interface FinalResultView {
  available: Availability;
  /** Estado terminal (applied, rolled_back, unrecoverable, rejected, etc.). */
  outcome?: string;
  detail?: string;
}

/** Vista normalizada completa de una ejecución. */
export interface ExecutionView {
  executionId: string; // = thread_id del grafo
  sessionId: Availability | string; // id de sesión o "unavailable"
  request: Availability | string;
  category: "development"; // esta vista modela ejecuciones del grafo de desarrollo
  /** Estado general legible, derivado de la fase. */
  status: string;
  /** Fase cruda (string estable), por trazabilidad. */
  phase: string;
  currentStage: StageId | "none";
  stages: ExecutionStage[];
  /** Runtime del rol developer (hoy no se persiste por etapa; se reporta como disponibilidad). */
  runtime: Availability | string;
  errors: string[];
  /** Ciclos de corrección usados (reintentos del desarrollo). */
  retries: number;
  pendingApproval: PendingApprovalView;
  finalResult: FinalResultView;
  /** (Reservado Fase 20) eventos de la ejecución. Opcional para no romper el contrato. */
  events?: unknown[];
  /** (Estabilización) Ciclo de vida: única clasificación fiable del estado. */
  lifecycle: ExecutionLifecycle;
  /** (Estabilización) ¿El backend está ejecutando el grafo de esta ejecución ahora? */
  activity: { active: boolean; since?: string; trigger?: ActiveRun["trigger"] };
  /**
   * (Estabilización) Etapa que se está ejecutando de verdad (solo con
   * `lifecycle: "running"`). A diferencia de `currentStage` (obsoleto, se
   * conserva por compatibilidad), nunca marca una espera humana como actividad.
   */
  activeStage: StageId | "none";
  /**
   * (Estabilización) Decisión humana que se espera, si la hay: en qué etapa
   * (`final_approval`) o tras qué etapa (`hu_review` tras `hu_analysis`,
   * `feasibility_partial` tras `feasibility`).
   */
  awaitingDecision: { kind: string; stageId?: StageId; afterStageId?: StageId } | null;
  /**
   * (Project Registry) Proyecto con el que nació la ejecución (su copia
   * inmutable) y el estado ACTUAL de ese proyecto en el registro. null =
   * ejecución anterior al registro de proyectos.
   */
  project?: ExecutionProjectView | null;
  /** (Project Registry) Directorio donde se aplicó (repo real o sandbox de esta ejecución), si ya se aplicó. */
  applyTarget?: string | null;
  /** (Project Context, T8) Contexto congelado (última versión de la HU). null = sin contexto congelado. */
  context?: ExecutionContextView | null;
}

/** (Project Context, T8) Qué contexto recibió la ejecución y de dónde salió (sin el texto ni hashes internos). */
export interface ExecutionContextView {
  huVersion: number;
  snapshotId: string | null;
  builtAt: string;
  stale: boolean;
  staleReason: string | null;
  sources: Array<{ kind: string; ref: string; version?: number; title?: string; included?: string }>;
  files: Array<{ path: string; score: number; reasons: string[] }>;
  /** false si el texto congelado no coincide con su hash. */
  intact: boolean;
}

/** (Project Registry) Proyecto de una ejecución. */
export interface ExecutionProjectView {
  id: string;
  /** Nombre al empezar la ejecución. */
  name: string;
  rootPath: string;
  applyMode: "sandbox" | "real";
  boundAt: string;
  /** El proyecto hoy en el registro: si se renombró, se desactivó o su repositorio cambió. */
  current: {
    name: string;
    status: "active" | "inactive";
    /** Modo actual: se aplica en el repo real solo si este Y el de la copia son `real`. */
    applyMode: "sandbox" | "real";
    health: string;
    healthDetail?: string;
  } | null;
}

/** (Estabilización) Información del proceso que el checkpoint no contiene. */
export interface ExecutionRuntimeInfo {
  /** Puerta en la que el grafo está pausado (interrupt real), o null. */
  pausedKind: string | null;
  /** Ejecución del grafo en curso en este proceso, o null. */
  active: ActiveRun | null;
}

const TERMINAL_OK: HuPhase[] = ["applied", "applied_with_test_failures"];

function isTerminal(phase: HuPhase): boolean {
  return terminalLifecycle(phase) !== null;
}

/** Sin información del proceso (llamadas antiguas): la pausa se deduce del siguiente nodo. */
function legacyPausedKind(next: string[], phase: HuPhase): string | null {
  const n = new Set(next);
  if (n.has("finalApprovalTask") || phase === "reviews_passed") return "final_approval";
  if (n.has("approvalTask")) return "hu_review";
  if (n.has("partialDecisionTask")) return "feasibility_partial";
  return null;
}

/**
 * Proyecta el estado del grafo a una `ExecutionView`. `values` es el estado del
 * grafo (parcial; puede faltar si la ejecución no existe). `next` son los nodos
 * pendientes (de `getState().next`). `session` (opcional) aporta request/sessionId.
 */
export function projectExecution(
  executionId: string,
  values: Partial<HuStateType>,
  next: string[],
  session?: ModeratorSession | null,
  runtime?: ExecutionRuntimeInfo,
): ExecutionView {
  const phase = (values.phase as HuPhase | undefined) ?? "none";
  const pausedKind = runtime ? runtime.pausedKind : legacyPausedKind(next, phase);
  const active = runtime?.active ?? null;
  const lifecycle = deriveLifecycle({ phase, active: active !== null, pausedKind, next });

  const stages = buildStages(values, phase, next, lifecycle);
  const current = stages.find((s) => s.status === "running")?.id ?? "none";
  const activeStage = lifecycle === "running" ? current : "none";
  const awaitingDecision = lifecycle === "awaiting_decision" && pausedKind !== null ? decisionPlace(pausedKind) : null;

  return {
    executionId,
    sessionId: session?.sessionId ?? "unavailable",
    request: deriveRequest(values, session),
    category: "development",
    status: describeStatus(lifecycle, phase, stages.find((s) => s.id === activeStage)?.label, pausedKind),
    phase,
    currentStage: current,
    stages,
    // El runtime del developer no se persiste por etapa (brecha documentada en
    // la auditoría): se reporta como no disponible en la vista, sin inventarlo.
    runtime: "unavailable",
    errors: values.error ? [values.error] : [],
    retries: typeof values.reviewCycles === "number" ? values.reviewCycles : 0,
    pendingApproval: lifecycle === "awaiting_decision" ? derivePendingApproval(values, pausedKind) : { required: false },
    finalResult: deriveFinalResult(values, phase),
    lifecycle,
    activity: active ? { active: true, since: active.since, trigger: active.trigger } : { active: false },
    activeStage,
    awaitingDecision,
  };
}

/** Dónde se sitúa en el pipeline la decisión que se espera. */
function decisionPlace(kind: string): { kind: string; stageId?: StageId; afterStageId?: StageId } {
  if (kind === "final_approval") return { kind, stageId: "final_approval" };
  if (kind === "hu_review") return { kind, afterStageId: "hu_analysis" };
  if (kind === "feasibility_partial") return { kind, afterStageId: "feasibility" };
  return { kind };
}

function deriveRequest(values: Partial<HuStateType>, session?: ModeratorSession | null): string {
  if (typeof values.request === "string" && values.request.length > 0) return values.request;
  const firstUser = session?.turns.find((t) => t.role === "user");
  return firstUser?.text ?? "unavailable";
}

const KIND_TEXT: Record<string, string> = {
  hu_review: "revisión de la HU",
  feasibility_partial: "decisión de viabilidad parcial",
  final_approval: "aprobación final de la propuesta",
};

/** Texto legible del estado, derivado SOLO del ciclo de vida (nunca de "hay un nodo pendiente"). */
function describeStatus(lifecycle: ExecutionLifecycle, phase: HuPhase, activeLabel: string | undefined, pausedKind: string | null): string {
  switch (lifecycle) {
    case "running":
      return activeLabel ? `en curso: ${activeLabel} (${phase})` : `en curso (${phase})`;
    case "awaiting_decision":
      return `esperando decisión humana: ${KIND_TEXT[pausedKind ?? ""] ?? pausedKind} (${phase})`;
    case "interrupted":
      return `interrumpida: quedó trabajo pendiente sin ejecución activa (${phase})`;
    case "completed":
      return `terminada (${phase})`;
    case "failed":
      return `fallida (${phase})`;
    case "stopped":
      return `detenida (${phase})`;
  }
}

/**
 * Construye la lista de etapas con su estado, derivado de la fase y de los
 * artefactos presentes. NO inventa: si un artefacto no existe, la etapa queda
 * pending/skipped/not_applicable según corresponda.
 */
function buildStages(
  values: Partial<HuStateType>,
  phase: HuPhase,
  next: string[],
  lifecycle: ExecutionLifecycle,
): ExecutionStage[] {
  const ended = lifecycle === "completed" || lifecycle === "failed" || lifecycle === "stopped";
  const has = {
    hu: values.hu != null,
    tech: values.technicalAnalysis != null,
    feasibility: typeof values.feasibility === "string" && values.feasibility.length > 0,
    dev: values.devProposal != null,
    func: values.functionalReview != null,
    qual: values.qualityReview != null,
    applied: TERMINAL_OK.includes(phase),
    verification: values.verification != null,
  };
  const nextSet = new Set(next);

  const stage = (id: StageId, label: string, status: StageStatus, detail?: string): ExecutionStage => ({
    id, label, status, detail,
  });

  // HU analysis. Al regenerarla tras "pedir cambios" vuelve a estar en curso
  // aunque exista la versión anterior.
  const huStatus: StageStatus =
    phase === "failed" ? "failed" : nextSet.has("generateHuTask") ? "running" : has.hu ? "done" : "pending";

  // Technical analysis.
  const techStatus: StageStatus =
    phase === "tech_failed" ? "failed"
      : has.tech ? "done"
      : nextSet.has("technicalAnalysisTask") ? "running"
      : has.hu && phase !== "rejected" && phase !== "revision_limit" ? "pending" : "pending";

  // Feasibility.
  const feasStatus: StageStatus = has.feasibility ? "done" : has.tech ? "pending" : "pending";

  // Development. En un ciclo de corrección se rehace: en curso aunque exista
  // la propuesta anterior.
  const devStatus: StageStatus =
    phase === "dev_failed" ? "failed"
      : phase === "blocked" ? "skipped"
      : nextSet.has("developTask") ? "running"
      : has.dev ? "done"
      : "pending";

  // Revisiones: "done" solo si aprobaron la versión VIGENTE (hash). Una revisión
  // rechazada que se repetirá queda pendiente; si la ejecución terminó (p. ej.
  // reviews_exhausted) o falló el revisor, queda fallida.
  const currentHash = values.devProposalHash ?? "";
  const funcApproved = currentHash !== "" && values.functionalApprovedHash === currentHash;
  const qualApproved = currentHash !== "" && values.qualityApprovedHash === currentHash;
  const funcStatus: StageStatus =
    funcApproved ? "done"
      : nextSet.has("functionalReviewTask") ? "running"
      : phase === "review_failed" || (ended && has.func) ? "failed"
      : "pending";
  const qualStatus: StageStatus =
    qualApproved ? "done"
      : nextSet.has("qualityReviewTask") ? "running"
      : funcApproved && (phase === "review_failed" || (ended && has.qual)) ? "failed"
      : "pending";

  // Final approval.
  const finalStatus: StageStatus =
    phase === "final_approval_rejected" ? "failed"
      : phase === "ready_to_apply" || TERMINAL_OK.includes(phase) || phase === "rolled_back" || phase === "unrecoverable" ? "done"
      : nextSet.has("finalApprovalTask") ? "running"
      : "pending";

  // Apply.
  const applyStatus: StageStatus =
    phase === "rolled_back" || phase === "unrecoverable" || phase === "apply_blocked" ? "failed"
      : has.applied ? "done"
      : nextSet.has("applyTask") ? "running"
      : "pending";

  // Verify.
  const verifyStatus: StageStatus =
    has.verification && has.applied ? "done"
      : nextSet.has("verifyTask") ? "running"
      : "pending";

  return [
    stage("hu_analysis", "Análisis de HU", huStatus, values.hu?.summary),
    stage("technical_analysis", "Análisis técnico", techStatus, values.technicalAnalysis?.summary),
    stage("feasibility", "Clasificación de viabilidad", feasStatus, has.feasibility ? String(values.feasibility) : undefined),
    stage("development", "Desarrollo (propuesta)", devStatus, values.devProposal?.summary),
    stage("functional_review", "Revisión funcional", funcStatus, values.functionalReview?.summary),
    stage("quality_review", "Revisión de calidad", qualStatus, values.qualityReview?.summary),
    stage("final_approval", "Aprobación humana final", finalStatus),
    stage("apply", "Aplicación segura", applyStatus, values.applyOutcome || undefined),
    stage("verify", "Verificación posterior", verifyStatus),
  ];
}

/** Aprobación pendiente de la puerta en la que el grafo está PAUSADO. */
function derivePendingApproval(values: Partial<HuStateType>, pausedKind: string | null): PendingApprovalView {
  if (pausedKind === "final_approval") {
    const proposalHash = typeof values.devProposalHash === "string" ? values.devProposalHash : undefined;
    return { required: true, kind: "final_approval", proposalHash, decisionHash: proposalHash };
  }
  if (pausedKind === "hu_review") return { required: true, kind: "hu_review", decisionHash: huReviewHash(values) };
  if (pausedKind === "feasibility_partial") {
    return { required: true, kind: "feasibility_partial", decisionHash: feasibilityHash(values) };
  }
  return pausedKind === null ? { required: false } : { required: true, kind: pausedKind };
}

/** (Fase 21) Hash de la HU en revisión, o undefined si no hay HU. */
export function huReviewHash(values: Partial<HuStateType>): string | undefined {
  if (values.hu == null) return undefined;
  return hashHuReview(values.hu, values.versions?.length ?? 0);
}

/** (Fase 21) Hash de la decisión de viabilidad parcial pendiente. */
export function feasibilityHash(values: Partial<HuStateType>): string {
  return hashFeasibilityDecision({
    huVersion: values.versions?.length ?? 0,
    feasibility: values.feasibility ?? "",
    reasons: values.feasibilityReasons ?? [],
    unresolvedPaths: values.unresolvedPaths ?? [],
    analysis: values.technicalAnalysis ?? null,
  });
}

function deriveFinalResult(values: Partial<HuStateType>, phase: HuPhase): FinalResultView {
  if (!isTerminal(phase)) return { available: "not_applicable" };
  return {
    available: "available",
    outcome: phase,
    detail: values.error || (values.verification ? "verificación disponible" : undefined),
  };
}
