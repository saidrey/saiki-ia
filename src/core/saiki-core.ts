import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { buildHuGraph, type BuildHuGraphOptions } from "../hu/hu-graph.js";
import type { AgentRouter } from "../agents/router.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import type {
  Moderator,
  AsyncModerator,
  AssistanceSynthesizer,
  ModeratorSession,
  IntentClassification,
} from "../moderator/moderator-types.js";
import {
  createModeratorSession,
  addUserTurn,
  addModeratorTurn,
  linkDelegatedTask,
  linkDevelopmentThread,
  developmentThreadsOf,
} from "../moderator/session.js";
import { createDelegatedTask, type DelegatedTask } from "../moderator/delegation.js";
import { runDelegatedTask } from "../moderator/delegation-runner.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import type { KnowledgeDoc, KnowledgeQuery, CreateDocInput } from "../knowledge/kb-types.js";
import { CoreStore, type ProjectHistoryRecord, type ProjectStatus } from "./core-store.js";
import {
  ProjectRegistry,
  type ProjectResult,
  type ProjectView,
  type RegisterInput,
  type UpdateInput,
} from "../projects/project-registry.js";
import type {
  JevCorePort,
  FlowStatusView,
  ProposalView,
  HumanDecision,
  DecisionGateKind,
  DecisionGateView,
  DecisionView,
  ProposalHistoryItem,
  ProposalStatus,
} from "./jev-contracts.js";
import {
  projectExecution,
  huReviewHash,
  feasibilityHash,
  type ExecutionView,
  type ExecutionStage,
  type ExecutionProjectView,
} from "./execution-view.js";
import type { ProjectBinding } from "../projects/project-binding.js";
import { createApplyGuard } from "../projects/apply-guard.js";
import { KeyedMutex } from "./approval-lock.js";
import type { ActiveRun, ExecutionLifecycle } from "./execution-lifecycle.js";
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import type { SaikiEvent, SaikiEventType, EventDataByType, NewEvent } from "../events/event-types.js";
import { randomUUID as uuid } from "node:crypto";
import { MAX_HU_REVISIONS, type HuStateType } from "../hu/hu-state.js";
import type { DevProposal } from "../dev/dev-schema.js";

/**
 * SaikiCore (Fase 15): punto de integración EXTREMO A EXTREMO.
 *
 * Conecta, usando los componentes REALES de fases 9-14:
 *   Entrada → Moderador → Core → Runtime/Agente → Grafo de ejecución → KB → Resultado
 *
 * Implementa `JevCorePort`: la misma fachada que una futura interfaz (Jev)
 * usaría. NO reimplementa el grafo, la KB ni el moderador: los orquesta.
 *
 * GARANTÍAS DE SEGURIDAD (heredadas, no debilitadas):
 *  - El flujo de desarrollo corre en el grafo (`buildHuGraph`), que conserva las
 *    aprobaciones humanas (interrupts) y aplica SOLO vía el Safe Applier.
 *  - Las tareas de asistencia se ejecutan con permisos de SOLO LECTURA y NUNCA
 *    con `apply_changes` (el runner las bloquea).
 *  - El Core NO escribe el repositorio por ningún camino: solo el grafo→applier.
 *  - Promover conocimiento a oficial exige actor HUMANO (lo impone la KB).
 */

export interface SaikiCoreOptions {
  router: AgentRouter;
  /** Opciones del grafo de desarrollo (rootDir, applyDir, checkpointer…). */
  graphOptions?: Omit<BuildHuGraphOptions, "router">;
  /** Store de sesiones/tareas (inyectable para tests). */
  coreStore?: CoreStore;
  /** Knowledge Base (inyectable para tests). */
  knowledge?: KnowledgeStore;
  /**
   * Moderador (inyectable). Acepta el síncrono determinista (`Moderator`,
   * Fase 14) o el conversacional asíncrono (`AsyncModerator`, Fase 16). El Core
   * detecta cuál es y actúa igual: las reglas de enrutamiento y seguridad NO
   * cambian según el moderador. Por defecto, el determinista.
   */
  moderator?: Moderator | AsyncModerator;
  /** (Fase 20) Bus de eventos de dominio (opcional). Si se omite, no se emiten. */
  eventBus?: EventBus;
  /** (Fase 20) Store de eventos para reconexión SSE (opcional). */
  eventStore?: EventStore;
  /** (Project Registry) Directorio de datos de Saiki-IA (no registrable como proyecto). Default ".saiki". */
  dataDir?: string;
  /** (Project Registry) Dónde crear el sandbox de cada ejecución. Default: temporal del sistema. */
  sandboxDir?: string;
}

/** Categoría resultante del procesamiento (incluye la aclaración de Fase 16). */
export type HandleCategory = IntentClassification["category"] | "clarification";

/** Resultado de procesar un mensaje de usuario. */
export interface HandleResult {
  sessionId: string;
  category: HandleCategory;
  /** Confianza y justificación (unificada entre moderador síncrono y async). */
  confidence: number;
  reason: string;
  /** Respuesta conversacional (category=conversation). */
  reply?: string;
  /** Pregunta de aclaración (category=clarification, Fase 16). */
  clarifyingQuestion?: string;
  /** Tarea de asistencia ejecutada (category=assistance). */
  task?: DelegatedTask;
  /** thread_id del flujo de desarrollo iniciado (category=development). */
  developmentThreadId?: string;
  /**
   * (Project Registry) Por qué una solicitud de desarrollo NO inició una
   * ejecución (category=clarification): la sesión no tiene proyecto, o su
   * proyecto está desactivado o su repositorio no está disponible.
   */
  blockedReason?: DevelopmentBlockedReason;
}

export type DevelopmentBlockedReason = "project_required" | "project_unavailable";

/** Resultado de `resolveApproval` (Fase 19). */
export type ApprovalResolution =
  | {
      ok: true;
      decision: HumanDecision;
      actor: string;
      proposalHash: string;
      resolvedAt: string;
      phase: string;
    }
  | {
      ok: false;
      reason: "not_found" | "not_awaiting" | "hash_mismatch" | "project_unbound";
      message: string;
      expectedHash?: string;
    };

/** (Project Registry) Resultado de abrir una sesión (opcionalmente con proyecto). */
export type OpenSessionResult =
  | { ok: true; sessionId: string; existed: boolean; projectId?: string }
  | {
      ok: false;
      reason: "project_not_found" | "project_inactive" | "project_unhealthy" | "session_project_mismatch";
      message: string;
    };

/** (Fase 21) Resultado de `resolveGate` (revisión de HU / viabilidad parcial). */
export type GateResolution =
  | {
      ok: true;
      kind: DecisionGateKind;
      decision: HumanDecision;
      actor: string;
      decisionHash: string;
      resolvedAt: string;
      phase: string;
    }
  | {
      ok: false;
      reason: "not_found" | "not_awaiting" | "hash_mismatch" | "unsupported_decision" | "project_unbound";
      message: string;
      expectedHash?: string;
      /** Aprobación que la ejecución espera realmente (si espera alguna). */
      pendingKind?: string;
    };

/**
 * (Fase 21) Traducción de la decisión humana a la acción que entiende cada
 * puerta del grafo. Una decisión ausente del mapa NO está soportada por esa
 * puerta (p. ej. la viabilidad parcial no tiene ruta de "pedir cambios").
 */
const GATE_ACTIONS: Record<string, Partial<Record<HumanDecision, string>>> = {
  final_approval: { approve: "approve", reject: "reject", request_changes: "request_changes" },
  hu_review: { approve: "approve", reject: "reject", request_changes: "revise" },
  feasibility_partial: { approve: "proceed", reject: "reject" },
};

/** Decisiones que admite una puerta, en el orden del mapa. */
function allowedDecisions(kind: string): HumanDecision[] {
  return Object.keys(GATE_ACTIONS[kind] ?? {}) as HumanDecision[];
}

/** (Estabilización) Evento terminal por ciclo de vida. */
const TERMINAL_EVENT: Partial<Record<ExecutionLifecycle, "execution.completed" | "execution.failed" | "execution.stopped">> = {
  completed: "execution.completed",
  failed: "execution.failed",
  stopped: "execution.stopped",
};

/** Decisión normalizada: unifica el moderador síncrono y el asíncrono. */
interface NormalizedDecision {
  category: HandleCategory;
  confidence: number;
  reason: string;
  startDevelopment: boolean;
  delegateAssistance: boolean;
  reply?: string;
  clarifyingQuestion?: string;
}

/** ¿El moderador es el conversacional asíncrono (Fase 16)? */
function isAsyncModerator(m: Moderator | AsyncModerator): m is AsyncModerator {
  return typeof (m as AsyncModerator).respond === "function";
}

/** (Fase 17) ¿El moderador sabe sintetizar resultados de asistencia? */
function canSynthesize(m: unknown): m is AssistanceSynthesizer {
  return typeof (m as AssistanceSynthesizer).synthesizeAssistance === "function";
}

export class SaikiCore implements JevCorePort {
  private readonly router: AgentRouter;
  private readonly graphOptions: Omit<BuildHuGraphOptions, "router">;
  private readonly store: CoreStore;
  /** (Project Registry) Registro de proyectos; solo lo administra el humano vía API. */
  private readonly projects: ProjectRegistry;
  private readonly kb: KnowledgeStore;
  private readonly moderator: Moderator | AsyncModerator;
  /** Grafo de desarrollo compilado (reutilizable; reanuda por thread_id). */
  private readonly graph: ReturnType<typeof buildHuGraph>;
  /** (Fase 19) Lock de aprobaciones POR ejecución (no global). */
  private readonly approvalMutex = new KeyedMutex();
  /**
   * (Estabilización) Ejecuciones del grafo EN CURSO en este proceso. Es la única
   * fuente de "está trabajando ahora": el checkpoint no lo sabe. Vive en memoria
   * a propósito: una ejecución no sobrevive al proceso; tras un reinicio, el
   * trabajo pendiente se reporta como `interrupted`.
   */
  private readonly activeRuns = new Map<string, ActiveRun>();
  /** (Fase 20) Bus y store de eventos (opcionales). */
  private readonly eventBus?: EventBus;
  private readonly eventStore?: EventStore;
  /**
   * (Fase 20) Último estado conocido de cada etapa por ejecución, para emitir
   * solo las etapas que CAMBIARON (diff) y NO duplicar al reanudar desde SQLite.
   * Clave: executionId → (stageId → status).
   */
  private readonly lastStageStatus = new Map<string, Map<string, string>>();

  constructor(options: SaikiCoreOptions) {
    this.router = options.router;
    this.graphOptions = options.graphOptions ?? {};
    this.store = options.coreStore ?? new CoreStore();
    this.projects = new ProjectRegistry(this.store, { dataDir: options.dataDir ?? ".saiki" });
    this.kb = options.knowledge ?? new KnowledgeStore();
    this.moderator = options.moderator ?? new BasicModerator();
    // (Project Registry) Cada ejecución trabaja sobre el repositorio de su
    // proyecto (state.project) y aplica solo tras la guardia.
    this.graph = buildHuGraph({
      router: this.router,
      ...this.graphOptions,
      requireProject: true,
      applyGuard: createApplyGuard({ store: this.store, sandboxDir: options.sandboxDir }),
    });
    this.eventBus = options.eventBus;
    this.eventStore = options.eventStore;
  }

  /** ¿Hay observabilidad de eventos configurada? */
  get events(): EventBus | undefined {
    return this.eventBus;
  }

  // ── Entrada principal: procesar un mensaje ─────────────────────────────────

  /**
   * Procesa un mensaje del usuario de extremo a extremo. Crea la sesión si no
   * existe, clasifica con el moderador y enruta según la categoría.
   */
  async process(sessionId: string, message: string): Promise<HandleResult> {
    let session = this.store.getSession(sessionId) ?? createModeratorSession(sessionId);

    // Obtiene una decisión NORMALIZADA del moderador (síncrono o conversacional).
    // Las reglas de enrutamiento/seguridad son idénticas en ambos casos.
    const decision = await this.decide(message, session);
    session = addUserTurn(session, message, this.toLegacyClassification(decision));

    // 0. ACLARACIÓN (Fase 16): el mensaje es ambiguo; el moderador pregunta y NO
    //    ejecuta nada. No inicia desarrollo ni delega.
    if (decision.category === "clarification") {
      const question = decision.clarifyingQuestion ?? "¿Puedes dar más detalles?";
      session = addModeratorTurn(session, question);
      this.store.saveSession(session);
      return {
        sessionId,
        category: "clarification",
        confidence: decision.confidence,
        reason: decision.reason,
        clarifyingQuestion: question,
      };
    }

    // 1. DESARROLLO: arranca el grafo (que gobierna aprobaciones + Safe Applier).
    if (decision.startDevelopment) {
      // (Project Registry) Solo en una sesión con proyecto, y con el proyecto
      // revalidado ahora (activo y repositorio sano). Si no, se explica y no se
      // crea ninguna ejecución (D6: aclaración, no error HTTP).
      const blocked = this.developmentBlocker(session);
      if (blocked) {
        session = addModeratorTurn(session, blocked.message);
        this.store.saveSession(session);
        return {
          sessionId,
          category: "clarification",
          confidence: decision.confidence,
          reason: decision.reason,
          clarifyingQuestion: blocked.message,
          blockedReason: blocked.reason,
        };
      }
      // Cada solicitud de desarrollo es una ejecución NUEVA e independiente: no
      // se reutiliza el hilo de la sesión (reutilizarlo reiniciaba una ejecución
      // pausada y reactivaba una terminada). Las anteriores no se tocan.
      const threadId = `dev-${randomUUID()}`;
      session = linkDevelopmentThread(session, threadId);
      // La sesión debe quedar enlazada ANTES de emitir, para que getExecution
      // pueda resolver sessionId/request al proyectar la vista.
      this.store.saveSession(session);
      // (Project Registry) La ejecución nace atada a una copia inmutable de su
      // proyecto: en la tabla de solo inserción y en el estado inicial del grafo.
      const project = this.bindExecution(threadId, session.projectId!);
      await this.runGraph(threadId, { request: message, project }, "message");
      // Releer: durante el invoke (minutos) pudo llegar otro mensaje a la sesión.
      session = addModeratorTurn(this.store.getSession(sessionId) ?? session, `Flujo de desarrollo iniciado (thread ${threadId}).`);
      this.store.saveSession(session);
      // (Fase 20) Eventos reales derivados del estado observado tras el invoke.
      await this.emitExecutionProgress(threadId, true);
      return {
        sessionId,
        category: "development",
        confidence: decision.confidence,
        reason: decision.reason,
        developmentThreadId: threadId,
      };
    }

    // 2. ASISTENCIA: el Core construye la tarea con grant de SOLO LECTURA, la
    //    ejecuta (OpenCode) y, si tuvo éxito, SINTETIZA el resultado (Fase 17).
    if (decision.delegateAssistance) {
      // (Project Registry) La asistencia lee el repositorio del proyecto de la
      // sesión; una conversación general no tiene acceso a ninguno (D8).
      const workspace = this.assistanceWorkspace(session);
      const task = createDelegatedTask({
        id: `task-${randomUUID()}`,
        request: message,
        goal: message,
        agentRole: "assistant",
        runtime: "opencode",
        // Solo lectura: nunca apply_changes.
        requiredCapabilities: ["read_repo", "read_kb", "external_docs"],
        grantedCapabilities: ["read_repo", "read_kb", "external_docs"],
        context: { workingDirectory: workspace.dir },
      });
      // Guardar el turno del usuario antes de la tarea (puede tardar minutos) y
      // releer después: otro mensaje pudo modificar la sesión mientras tanto.
      this.store.saveSession(session);
      let done: DelegatedTask;
      try {
        done = await runDelegatedTask(task, this.router);
      } finally {
        workspace.cleanup();
      }
      session = linkDelegatedTask(this.store.getSession(sessionId) ?? session, done.id);

      // (Fase 17) Cierre del ciclo: síntesis AUTOMÁTICA al finalizar con éxito.
      // Si la investigación falló, se comunica el error (sin síntesis). Si la
      // síntesis falla, se CONSERVA el resultado crudo y se avisa (no se pierde).
      let reply: string;
      if (done.status === "succeeded") {
        const synth = await this.trySynthesize(done);
        done = { ...done, synthesis: synth.text };
        reply = synth.text;
        session = addModeratorTurn(session, synth.text);
        if (synth.error) {
          session = addModeratorTurn(session, `(nota: no se pudo sintetizar: ${synth.error})`);
        }
      } else {
        // Investigación fallida: NO se presenta como exitosa.
        reply = `La tarea de asistencia no se completó (estado: ${done.status}). ${done.errors.join(" | ")}`.trim();
        session = addModeratorTurn(session, reply);
      }

      this.store.saveTask(sessionId, done);
      this.store.saveSession(session);
      // (Fase 20) Mensaje de asistencia (texto ya saneado: síntesis o reply).
      this.emit(
        "assistant.message",
        { taskId: done.id, status: done.status, summary: reply },
        { sessionId },
      );
      return {
        sessionId,
        category: "assistance",
        confidence: decision.confidence,
        reason: decision.reason,
        reply,
        task: done,
      };
    }

    // 3. CONVERSACIÓN: respuesta directa. No inicia desarrollo ni delega.
    const reply = decision.reply ?? "Consulta recibida.";
    session = addModeratorTurn(session, reply);
    this.store.saveSession(session);
    return {
      sessionId,
      category: "conversation",
      confidence: decision.confidence,
      reason: decision.reason,
      reply,
    };
  }

  /**
   * (Project Registry) Directorio de trabajo de una tarea de asistencia: el
   * repositorio del proyecto si está activo y sano; si no (o en una sesión
   * general), un directorio vacío propio que se borra al terminar. Nunca el
   * directorio del backend.
   */
  private assistanceWorkspace(session: ModeratorSession): { dir: string; cleanup: () => void } {
    const project = session.projectId ? this.projects.get(session.projectId) : null;
    if (project && project.status === "active" && project.health === "ok") {
      return { dir: project.rootPath, cleanup: () => undefined };
    }
    const dir = mkdtempSync(join(tmpdir(), "saiki-general-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** (Project Registry) Copia del proyecto para una ejecución nueva, registrada en `execution_projects`. */
  private bindExecution(threadId: string, projectId: string): ProjectBinding {
    const p = this.projects.record(projectId);
    if (!p) throw new Error(`El proyecto "${projectId}" no existe.`);
    const binding: ProjectBinding = {
      projectId: p.id,
      projectName: p.name,
      rootPath: p.rootPath,
      applyMode: p.applyMode,
      fingerprint: p.fingerprint,
      boundAt: new Date().toISOString(),
    };
    this.store.insertExecutionProject(threadId, binding);
    return binding;
  }

  /** (Project Registry) Motivo por el que la sesión no puede iniciar un desarrollo ahora, o null. */
  private developmentBlocker(session: ModeratorSession): { reason: DevelopmentBlockedReason; message: string } | null {
    if (!session.projectId) {
      return {
        reason: "project_required",
        message: "Para desarrollar necesito un proyecto. Inicia una sesión nueva eligiendo el proyecto sobre el que quieres trabajar.",
      };
    }
    const project = this.projects.get(session.projectId);
    if (!project) {
      return { reason: "project_unavailable", message: "El proyecto de esta sesión ya no existe en el registro. No se inició ningún desarrollo." };
    }
    if (project.status !== "active") {
      return {
        reason: "project_unavailable",
        message: `El proyecto "${project.name}" está desactivado. Actívalo para desarrollar en esta sesión.`,
      };
    }
    if (project.health !== "ok") {
      return {
        reason: "project_unavailable",
        message: `El repositorio de "${project.name}" no está disponible (${project.healthDetail ?? project.health}). No se inició ningún desarrollo.`,
      };
    }
    return null;
  }

  /**
   * Obtiene una decisión normalizada del moderador, sea síncrono (Fase 14) o
   * conversacional asíncrono (Fase 16). NO cambia las reglas de seguridad: solo
   * unifica la forma de la decisión. Los errores del moderador async (p. ej.
   * fallo del proveedor) se propagan explícitamente (sin simular).
   */
  private async decide(message: string, session: ModeratorSession): Promise<NormalizedDecision> {
    if (isAsyncModerator(this.moderator)) {
      const d = await this.moderator.respond(message, session);
      const c = d.classification;
      const category: HandleCategory =
        c.intent === "clarification"
          ? "clarification"
          : c.intent === "development"
            ? "development"
            : c.intent === "assistance"
              ? "assistance"
              : "conversation";
      return {
        category,
        confidence: c.confidence,
        reason: c.reason,
        startDevelopment: d.startDevelopment,
        delegateAssistance: d.delegateAssistance,
        reply: d.reply,
        clarifyingQuestion: d.clarifyingQuestion,
      };
    }

    // Moderador síncrono (determinista).
    const d = this.moderator.handle(message, session);
    const c = d.classification;
    return {
      category: c.category,
      confidence: c.confidence,
      reason: c.reason,
      startDevelopment: d.startDevelopment,
      delegateAssistance: c.category === "assistance",
      reply: d.reply,
    };
  }

  /**
   * (Fase 17) Intenta sintetizar el resultado de una tarea de asistencia.
   *
   * Reglas de robustez:
   *  - Si la tarea YA tiene `synthesis` (ejecución recuperada), NO re-sintetiza.
   *  - Si el moderador no soporta síntesis, devuelve el resultado CRUDO con nota.
   *  - Si la síntesis falla, CONSERVA el resultado crudo y reporta el error (no
   *    se pierde la investigación ni se finge una síntesis).
   */
  private async trySynthesize(task: DelegatedTask): Promise<{ text: string; error?: string }> {
    // Idempotencia: ya sintetizada (recuperación interrumpida) → no repetir.
    if (typeof task.synthesis === "string" && task.synthesis.length > 0) {
      return { text: task.synthesis };
    }

    const raw = task.result ?? "(sin resultado)";

    if (!canSynthesize(this.moderator)) {
      // Degradación honesta: sin motor de síntesis, se entrega el crudo.
      return { text: `${raw}\n\n[resultado sin sintetizar: el moderador actual no soporta síntesis]` };
    }

    try {
      const text = await this.moderator.synthesizeAssistance(task);
      return { text };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // La síntesis falló: conservamos el resultado original.
      return { text: raw, error };
    }
  }

  /** Clasificación legacy para registrar en el turno (compat con el historial). */
  private toLegacyClassification(d: NormalizedDecision): IntentClassification | undefined {
    if (d.category === "clarification") {
      // El historial usa las 3 categorías clásicas; una aclaración se anota como
      // conversación a efectos del turno (el detalle rico va en el reason).
      return {
        category: "conversation",
        confidence: d.confidence,
        reason: `[clarification] ${d.reason}`,
        developmentAuthorized: false,
      };
    }
    return {
      category: d.category,
      confidence: d.confidence,
      reason: d.reason,
      developmentAuthorized: d.startDevelopment,
    };
  }

  // ── Knowledge Base (consulta/registro durante la ejecución) ────────────────

  /** Registra conocimiento NUEVO como PROPUESTA (nunca aprobado directamente). */
  proposeKnowledge(input: CreateDocInput): KnowledgeDoc {
    const doc = this.kb.create(input);
    // (Fase 20) Evento real: una propuesta de conocimiento se creó.
    this.emit("knowledge.proposed", { docId: doc.id, title: doc.title, category: doc.category }, {});
    return doc;
  }

  // ── JevCorePort: consultas (solo lectura) ──────────────────────────────────

  /** Sesión a la que pertenece una ejecución (cualquiera de sus ejecuciones). */
  private sessionOfExecution(threadId: string): ModeratorSession | null {
    return this.store.listSessions().find((s) => developmentThreadsOf(s).includes(threadId)) ?? null;
  }

  /**
   * (Project Registry) Abre una sesión. Con `projectId`, la persiste ligada a un
   * proyecto activo y sano; ese proyecto ya no cambia (regla 8). Sin él, la sesión
   * es general y, como antes, se crea con el primer mensaje.
   */
  async openSession(sessionId: string, projectId?: string): Promise<OpenSessionResult> {
    const existing = this.store.getSession(sessionId);
    if (existing) {
      if (projectId !== undefined && projectId !== existing.projectId) {
        return {
          ok: false,
          reason: "session_project_mismatch",
          message: existing.projectId
            ? "La sesión ya pertenece a otro proyecto; el proyecto de una sesión no cambia. Abre una sesión nueva."
            : "La sesión es general (sin proyecto) y no puede pasar a un proyecto. Abre una sesión nueva.",
        };
      }
      return { ok: true, sessionId, existed: true, ...(existing.projectId ? { projectId: existing.projectId } : {}) };
    }
    if (projectId === undefined) return { ok: true, sessionId, existed: false };

    const project = this.projects.get(projectId);
    if (!project) return { ok: false, reason: "project_not_found", message: `El proyecto "${projectId}" no existe.` };
    if (project.status !== "active") {
      return { ok: false, reason: "project_inactive", message: `El proyecto "${project.name}" está desactivado.` };
    }
    if (project.health !== "ok") {
      return { ok: false, reason: "project_unhealthy", message: `El proyecto "${project.name}" no está disponible: ${project.healthDetail ?? project.health}.` };
    }
    this.store.saveSession(createModeratorSession(sessionId, projectId));
    return { ok: true, sessionId, existed: false, projectId };
  }

  async listSessions(): Promise<ModeratorSession[]> {
    return this.store.listSessions();
  }

  async getSession(sessionId: string): Promise<ModeratorSession | null> {
    return this.store.getSession(sessionId);
  }

  async listTasks(sessionId: string): Promise<DelegatedTask[]> {
    return this.store.listTasks(sessionId);
  }

  // ── (Project Registry) Administración del registro (solo humano, vía API) ───

  async listProjects(status?: ProjectStatus): Promise<ProjectView[]> {
    return this.projects.list(status);
  }

  async getProject(projectId: string): Promise<ProjectView | null> {
    return this.projects.get(projectId);
  }

  async getProjectHistory(projectId: string): Promise<ProjectHistoryRecord[] | null> {
    return this.projects.record(projectId) ? this.projects.history(projectId) : null;
  }

  async registerProject(input: RegisterInput, actor: string): Promise<ProjectResult> {
    return this.projects.register(input, actor);
  }

  async updateProject(projectId: string, input: UpdateInput, actor: string): Promise<ProjectResult> {
    return this.projects.update(projectId, input, actor);
  }

  /**
   * D5: se permite con ejecuciones pausadas (la guardia bloqueará sus
   * aplicaciones), pero no mientras una ejecución del proyecto está trabajando.
   */
  async deactivateProject(projectId: string, actor: string): Promise<ProjectResult> {
    const running = [...this.activeRuns.keys()].filter((id) => this.store.getExecutionProject(id)?.projectId === projectId);
    if (running.length > 0) {
      return {
        ok: false,
        code: "has_active_executions",
        message: `Hay ${running.length} ejecución(es) de este proyecto trabajando ahora. Espera a que se detengan en una decisión y vuelve a intentarlo.`,
      };
    }
    return this.projects.deactivate(projectId, actor);
  }

  async activateProject(projectId: string, actor: string): Promise<ProjectResult> {
    return this.projects.activate(projectId, actor);
  }

  async getFlowStatus(threadId: string): Promise<FlowStatusView | null> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    if (state.values === undefined || Object.keys(state.values).length === 0) return null;
    const phase = (state.values.phase as string) ?? "unknown";
    // Esperando aprobación = pausa real del grafo (interrupt) y nada en marcha.
    // (Antes: "hay un nodo pendiente", que también es cierto a mitad de ejecución.)
    const pausedKind = this.activeRuns.has(threadId) ? null : pausedGateKind(state.tasks);
    const awaitingApproval = pausedKind !== null;
    return {
      threadId,
      phase,
      summary: `Fase actual: ${phase}. ${awaitingApproval ? `Esperando: ${pausedKind}.` : "Sin decisión pendiente."}`,
      awaitingApproval,
    };
  }

  /**
   * (Project Registry, precisión 6) Una ejecución anterior al registro no tiene
   * un destino identificable: no se reanuda ningún trabajo (aprobar o pedir
   * cambios) y nunca se aplica sobre el directorio actual del backend. Rechazar
   * sí se permite: detiene la ejecución sin tocar ningún repositorio.
   */
  private async unboundBlock(
    threadId: string,
    decision: HumanDecision,
  ): Promise<{ ok: false; reason: "project_unbound"; message: string } | null> {
    if (decision === "reject") return null;
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    if ((state.values as Partial<HuStateType>).project) return null;
    return {
      ok: false,
      reason: "project_unbound",
      message:
        "Esta ejecución es anterior al registro de proyectos y no consta en qué repositorio debe trabajar ni aplicar. " +
        "Solo puede rechazarse. Para continuar, repite la solicitud en una sesión con proyecto.",
    };
  }

  /** Respuesta para una decisión que llega mientras la ejecución trabaja. */
  private busy(threadId: string): { ok: false; reason: "not_awaiting"; message: string } {
    return {
      ok: false,
      reason: "not_awaiting",
      message: `La ejecución "${threadId}" está trabajando ahora; no espera ninguna decisión.`,
    };
  }

  /**
   * (Estabilización) Único punto de entrada al grafo: registra la ejecución como
   * activa mientras dura el `invoke` (incluso si falla).
   */
  private async runGraph(threadId: string, input: unknown, trigger: ActiveRun["trigger"]): Promise<void> {
    this.activeRuns.set(threadId, { since: new Date().toISOString(), trigger });
    try {
      await this.graph.invoke(input as never, { configurable: { thread_id: threadId } });
    } finally {
      this.activeRuns.delete(threadId);
      // (Estabilización) Registrar cada versión de propuesta que apareció en este
      // tramo (también las rehechas en ciclos de corrección). No debe tumbar el flujo.
      await this.captureProposalVersions(threadId).catch(() => undefined);
    }
  }

  // ── (Estabilización) Historial de propuestas y decisiones ───────────────────

  /**
   * Recorre el historial de checkpoints (persistido por LangGraph) y registra
   * cada versión de propuesta nueva. Idempotente: una versión ya registrada no
   * se toca. Sirve también para reconstruir ejecuciones anteriores a este cambio.
   */
  private async captureProposalVersions(threadId: string): Promise<void> {
    const snapshots: Array<{ values: Partial<HuStateType>; createdAt?: string }> = [];
    for await (const snap of this.graph.getStateHistory({ configurable: { thread_id: threadId } })) {
      snapshots.push({ values: snap.values as Partial<HuStateType>, createdAt: snap.createdAt });
    }
    for (const snap of snapshots.reverse()) {
      const p = snap.values.devProposal;
      const hash = snap.values.devProposalHash;
      if (!p || typeof hash !== "string" || hash === "") continue;
      const files = splitChanges(p);
      this.store.recordProposalVersion({
        executionId: threadId,
        proposalHash: hash,
        summary: p.summary,
        ...files,
        risks: p.risks ?? [],
        createdAt: snap.createdAt ?? new Date().toISOString(),
      });
    }
  }

  /** Reconstruye decisiones de ejecuciones anteriores a partir de `approval.resolved` (sin observaciones). */
  private backfillDecisionsFromEvents(threadId: string): void {
    for (const ev of this.storedEvents(threadId)) {
      if (ev.type !== "approval.resolved") continue;
      const d = ev.data as { decision: HumanDecision; actor: string; proposalHash: string; phase: string; kind?: string };
      this.store.recordDecision({
        id: ev.eventId,
        executionId: threadId,
        // Antes de la Fase 21 solo la aprobación final se resolvía por la API.
        kind: d.kind ?? "final_approval",
        subjectHash: d.proposalHash,
        decision: d.decision,
        actor: d.actor,
        feedback: null,
        resolvedAt: ev.timestamp,
        phaseAfter: d.phase,
        source: "events",
      });
    }
  }

  /** (Estabilización) Decisiones humanas de una ejecución (null si no existe). */
  async getDecisionHistory(threadId: string): Promise<DecisionView[] | null> {
    if ((await this.getFlowStatus(threadId)) === null) return null;
    this.backfillDecisionsFromEvents(threadId);
    return this.store.listDecisions(threadId);
  }

  /** (Estabilización) Historial de versiones de propuesta (null si la ejecución no existe). */
  async getProposalHistory(threadId: string): Promise<ProposalHistoryItem[] | null> {
    const view = await this.getExecution(threadId);
    if (view === null) return null;
    await this.captureProposalVersions(threadId);
    const decisions = (await this.getDecisionHistory(threadId)) ?? [];
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    const values = state.values as Partial<HuStateType>;
    const reviewHistory = values.reviewHistory ?? [];
    return this.store.listProposalVersions(threadId).map((v) => {
      const decision = decisions.filter((d) => d.kind === "final_approval" && d.subjectHash === v.proposalHash).at(-1) ?? null;
      const reviews = reviewHistory
        .filter((r) => r.hash === v.proposalHash)
        .map((r) => ({ kind: r.kind, cycle: r.cycle, decision: r.decision }));
      return {
        id: `${threadId}:v${v.version}`,
        ...v,
        status: proposalStatus(v.proposalHash, decision, reviews, view, values.devProposalHash ?? ""),
        applied: values.appliedHash === v.proposalHash,
        reviews,
        decision,
      };
    });
  }

  async getProposal(threadId: string, proposalHash: string): Promise<ProposalHistoryItem | null> {
    const all = await this.getProposalHistory(threadId);
    return all?.find((p) => p.proposalHash === proposalHash) ?? null;
  }

  /**
   * (Fase 19) Vista NORMALIZADA de una ejecución para la API. Proyecta el estado
   * del grafo sin exponer `HuState`. Devuelve null si la ejecución no existe.
   */
  async getExecution(threadId: string): Promise<ExecutionView | null> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    if (state.values === undefined || Object.keys(state.values).length === 0) return null;
    // Busca la sesión que referencia este thread (para request/sessionId).
    const session = this.sessionOfExecution(threadId);
    const values = state.values as Partial<HuStateType>;
    const view = projectExecution(threadId, values, [...state.next], session, {
      pausedKind: pausedGateKind(state.tasks),
      active: this.activeRuns.get(threadId) ?? null,
    });
    return { ...view, project: this.executionProjectView(values.project ?? null), applyTarget: values.applyTarget || null };
  }

  /** (Project Registry) Copia de la ejecución + el proyecto tal como está hoy en el registro. */
  private executionProjectView(b: ProjectBinding | null): ExecutionProjectView | null {
    if (!b) return null;
    const now = this.projects.get(b.projectId);
    return {
      id: b.projectId,
      name: b.projectName,
      rootPath: b.rootPath,
      applyMode: b.applyMode,
      boundAt: b.boundAt,
      current: now
        ? {
            name: now.name,
            status: now.status,
            applyMode: now.applyMode,
            health: now.health,
            ...(now.healthDetail ? { healthDetail: now.healthDetail } : {}),
          }
        : null,
    };
  }

  async getPendingProposal(threadId: string): Promise<ProposalView | null> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    const proposal = state.values?.devProposal as DevProposal | null | undefined;
    if (!proposal) return null;
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const ch of proposal.changes) {
      if (ch.operation === "create") created.push(ch.path);
      else if (ch.operation === "modify") modified.push(ch.path);
      else deleted.push(ch.path);
    }
    return {
      threadId,
      proposalHash: (state.values.devProposalHash as string) ?? "",
      summary: proposal.summary,
      filesToCreate: created,
      filesToModify: modified,
      filesToDelete: deleted,
      risks: proposal.risks,
    };
  }

  /**
   * (Fase 21) Puerta de decisión pendiente (revisión de HU o viabilidad parcial)
   * con lo que el humano necesita para decidir y el hash a reenviar. Devuelve
   * null si la ejecución no está pausada en una de esas puertas.
   */
  async getPendingGate(threadId: string): Promise<DecisionGateView | null> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    const values = state.values as Partial<HuStateType> | undefined;
    if (values === undefined || Object.keys(values).length === 0) return null;
    const kind = pausedGateKind(state.tasks);
    if (kind === "hu_review" && values.hu != null) {
      return {
        kind,
        threadId,
        decisionHash: huReviewHash(values) ?? "",
        version: values.versions?.length ?? 0,
        revisionsUsed: values.revisions ?? 0,
        maxRevisions: MAX_HU_REVISIONS,
        allowedDecisions: allowedDecisions(kind),
        hu: values.hu,
      };
    }
    if (kind === "feasibility_partial") {
      return {
        kind,
        threadId,
        decisionHash: feasibilityHash(values),
        feasibility: values.feasibility ?? "",
        reasons: values.feasibilityReasons ?? [],
        unresolvedPaths: values.unresolvedPaths ?? [],
        allowedDecisions: allowedDecisions(kind),
        technicalAnalysis: values.technicalAnalysis ?? null,
      };
    }
    return null;
  }

  async searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeDoc[]> {
    return this.kb.search(query);
  }

  async getKnowledgeDoc(id: string): Promise<KnowledgeDoc | null> {
    return this.kb.get(id);
  }

  // ── JevCorePort: acciones (el Core ejecuta; una UI solo transmite) ─────────

  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.process(sessionId, message);
  }

  /**
   * Transmite una decisión humana sobre una aprobación: reanuda el grafo con el
   * `Command({resume})`. El Core NO decide por el humano; solo reanuda el flujo,
   * que gobierna el Safe Applier. La decisión se traduce a la acción de la
   * puerta pendiente (Fase 21): en la HU request_changes = "revise"; en la
   * viabilidad parcial approve = "proceed". Una decisión que la puerta no
   * admite se rechaza (antes se interpretaba en silencio como rechazo).
   */
  async submitApproval(threadId: string, decision: HumanDecision, feedback?: string): Promise<void> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    const kind = pausedGateKind(state.tasks);
    const action = kind !== null ? GATE_ACTIONS[kind]?.[decision] : decision;
    if (action === undefined) {
      throw new Error(`La decisión "${decision}" no es válida para la aprobación "${kind}".`);
    }
    await this.runGraph(threadId, new Command({ resume: { action, feedback } }), "decision");
    // (Fase 20) Cualquier reanudación del flujo (HU, viabilidad parcial o
    // propuesta) emite el progreso observado: stage.*, nueva approval.required o
    // execution.completed/failed. El diff evita duplicar etapas ya publicadas.
    await this.emitExecutionProgress(threadId, false);
  }

  /**
   * (Fase 19) Resolución de aprobación SEGURA y SERIALIZADA por ejecución.
   *
   * Garantías:
   *  - Exclusión mutua POR `threadId` (dos resoluciones simultáneas de la MISMA
   *    ejecución NO se procesan a la vez; la segunda ve el estado ya avanzado).
   *  - Verifica que la ejecución ESTÁ esperando aprobación (si no, rechaza).
   *  - Verifica que el `proposalHash` enviado coincide con la propuesta pendiente
   *    (hash desactualizado/incorrecto → rechazo; la aprobación va atada al hash).
   *  - Registra la identidad del actor HUMANO (validada por el llamador/servidor,
   *    no por el frontend) junto con decisión, fecha, hash y observaciones.
   *  - NO escribe el repo: solo reanuda el grafo, que gobierna el Safe Applier.
   */
  async resolveApproval(
    threadId: string,
    input: { decision: HumanDecision; proposalHash: string; actor: string; feedback?: string },
  ): Promise<ApprovalResolution> {
    // (Estabilización) Si el grafo está trabajando no hay nada que aprobar: 409
    // inmediato en lugar de esperar al lock durante toda la ejecución.
    if (this.activeRuns.has(threadId)) return this.busy(threadId);
    return this.approvalMutex.runExclusive(threadId, async () => {
      // 1. ¿Existe y está esperando aprobación?
      const pending = await this.getPendingProposal(threadId);
      const status = await this.getFlowStatus(threadId);
      if (status === null) {
        return { ok: false, reason: "not_found", message: `No existe la ejecución "${threadId}".` };
      }
      // Debe estar PAUSADA en la aprobación final (no a mitad de ejecución).
      const paused = await this.graph.getState({ configurable: { thread_id: threadId } });
      if (pending === null || !status.awaitingApproval || pausedGateKind(paused.tasks) !== "final_approval") {
        return {
          ok: false,
          reason: "not_awaiting",
          message: "La ejecución no está esperando una aprobación de propuesta.",
        };
      }
      // 2. El hash debe coincidir EXACTAMENTE con la propuesta pendiente.
      if (input.proposalHash !== pending.proposalHash) {
        return {
          ok: false,
          reason: "hash_mismatch",
          message: "El hash enviado no coincide con la propuesta pendiente. Aprobación rechazada.",
          expectedHash: pending.proposalHash,
        };
      }
      // (Project Registry) Sin proyecto vinculado no se reanuda trabajo (precisión 6).
      const unbound = await this.unboundBlock(threadId, input.decision);
      if (unbound) return unbound;
      // 3. Reanudar el grafo (que aplica las garantías: Safe Applier, etc.).
      // Momento en que se ACEPTA la decisión humana (antes de reanudar el grafo,
      // que puede tardar minutos): es la fecha de resolución que se registra.
      const decidedAt = new Date().toISOString();
      await this.submitApproval(threadId, input.decision, input.feedback);

      // 4. Auditoría en la sesión + evento approval.resolved.
      const { phase, resolvedAt } = await this.recordHumanDecision(threadId, {
        kind: "final_approval",
        decision: input.decision,
        actor: input.actor,
        hash: input.proposalHash,
        feedback: input.feedback,
        decidedAt,
      });

      return {
        ok: true,
        decision: input.decision,
        actor: input.actor,
        proposalHash: input.proposalHash,
        resolvedAt,
        phase,
      };
    });
  }

  /**
   * (Fase 21) Resolución SEGURA de la revisión de HU o de la viabilidad parcial.
   * Mismas garantías que `resolveApproval`, con el mismo lock por ejecución:
   *  - La ejecución debe estar PAUSADA en esa puerta (interrupt real del grafo,
   *    no solo "siguiente nodo"); una decisión ya resuelta o de otra puerta se
   *    rechaza (not_awaiting).
   *  - La decisión debe estar soportada por la puerta (unsupported_decision).
   *  - El `decisionHash` debe coincidir con la versión pendiente (hash_mismatch).
   *  - La identidad la fija el llamador (servidor), nunca el frontend.
   */
  async resolveGate(
    threadId: string,
    kind: DecisionGateKind,
    input: { decision: HumanDecision; decisionHash: string; actor: string; feedback?: string },
  ): Promise<GateResolution> {
    if (this.activeRuns.has(threadId)) return this.busy(threadId);
    return this.approvalMutex.runExclusive(threadId, async () => {
      const status = await this.getFlowStatus(threadId);
      if (status === null) {
        return { ok: false, reason: "not_found", message: `No existe la ejecución "${threadId}".` };
      }
      if (GATE_ACTIONS[kind]?.[input.decision] === undefined) {
        return {
          ok: false,
          reason: "unsupported_decision",
          message: `La decisión "${input.decision}" no es válida para "${kind}". Permitidas: ${allowedDecisions(kind).join(", ")}.`,
        };
      }
      const gate = await this.getPendingGate(threadId);
      if (gate === null || gate.kind !== kind) {
        const view = await this.getExecution(threadId);
        const pendingKind = view?.pendingApproval.required ? view.pendingApproval.kind : undefined;
        return {
          ok: false,
          reason: "not_awaiting",
          message: `La ejecución no está esperando la decisión "${kind}".`,
          pendingKind,
        };
      }
      if (input.decisionHash !== gate.decisionHash) {
        return {
          ok: false,
          reason: "hash_mismatch",
          message: "El hash enviado no coincide con la versión pendiente. Decisión rechazada.",
          expectedHash: gate.decisionHash,
        };
      }
      const unbound = await this.unboundBlock(threadId, input.decision);
      if (unbound) return unbound;

      // Momento en que se ACEPTA la decisión humana (antes de reanudar el grafo,
      // que puede tardar minutos): es la fecha de resolución que se registra.
      const decidedAt = new Date().toISOString();
      await this.submitApproval(threadId, input.decision, input.feedback);
      const { phase, resolvedAt } = await this.recordHumanDecision(threadId, {
        kind,
        decision: input.decision,
        actor: input.actor,
        hash: input.decisionHash,
        feedback: input.feedback,
        decidedAt,
      });

      return {
        ok: true,
        kind,
        decision: input.decision,
        actor: input.actor,
        decisionHash: input.decisionHash,
        resolvedAt,
        phase,
      };
    });
  }

  /**
   * Registra una decisión humana ya aplicada: turno de auditoría en la sesión
   * (actor, decisión, hash, observaciones) y evento `approval.resolved`.
   * Devuelve la fase tras reanudar. submitApproval ya emitió el progreso de
   * etapas/ejecución; aquí solo se añade la resolución humana.
   */
  private async recordHumanDecision(
    threadId: string,
    d: { kind: string; decision: HumanDecision; actor: string; hash: string; feedback?: string; decidedAt: string },
  ): Promise<{ phase: string; resolvedAt: string }> {
    const resolvedAt = d.decidedAt;
    const session = this.sessionOfExecution(threadId) ?? undefined;
    if (session) {
      const label = d.kind === "final_approval" ? "" : ` (${d.kind})`;
      const noted = addModeratorTurn(
        session,
        `Aprobación "${d.decision}"${label} por ${d.actor} sobre hash ${d.hash}` +
          (d.feedback ? ` — "${d.feedback}"` : ""),
      );
      this.store.saveSession(noted);
    }

    const after = await this.getFlowStatus(threadId);
    const phase = after?.phase ?? "unknown";
    const ev = this.emit(
      "approval.resolved",
      { decision: d.decision, actor: d.actor, proposalHash: d.hash, phase, kind: d.kind },
      { executionId: threadId, sessionId: session?.sessionId },
    );
    // (Estabilización) Historial inmutable de decisiones, con observaciones. El id
    // es el del evento: la reconstrucción desde eventos no la duplica.
    this.store.recordDecision({
      id: ev?.eventId ?? uuid(),
      executionId: threadId,
      kind: d.kind,
      subjectHash: d.hash,
      decision: d.decision,
      actor: d.actor,
      feedback: d.feedback ?? null,
      resolvedAt,
      phaseAfter: phase,
      source: "recorded",
    });
    return { phase, resolvedAt };
  }

  /**
   * Promueve conocimiento a oficial. La KB EXIGE actor humano: si `humanActor`
   * es un agente, `approve()` lanza. El Core no relaja esa regla.
   */
  async requestKnowledgeApproval(docId: string, humanActor: string): Promise<void> {
    this.kb.approve(docId, humanActor);
  }

  // ── (Fase 20) Emisión de eventos de dominio ────────────────────────────────

  /** Persiste (si hay store) y publica (si hay bus) un evento. No lanza. */
  private emit<T extends SaikiEventType>(
    type: T,
    data: EventDataByType[T],
    ctx: { executionId?: string; sessionId?: string },
  ): SaikiEvent | undefined {
    if (!this.eventBus && !this.eventStore) return undefined;
    const base: NewEvent<T> = {
      eventId: uuid(),
      type,
      executionId: ctx.executionId,
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      data,
    };
    // El store asigna `seq` por ejecución; si no hay store, seq queda sin fijar.
    const full: SaikiEvent = this.eventStore ? this.eventStore.append(base) : ({ ...base } as SaikiEvent);
    this.eventBus?.publish(full);
    return full;
  }

  /**
   * Emite los eventos de etapa que CAMBIARON entre el estado conocido y el
   * actual de la ejecución. Idempotente por (executionId, stageId, status): una
   * etapa en el mismo estado no re-emite, por lo que reanudar desde SQLite no
   * duplica eventos ya publicados.
   *
   * Reglas de mapeo etapa→evento:
   *  - running (desde otro estado) → stage.started
   *  - done    (desde otro estado) → stage.completed
   *  - failed  (desde otro estado) → stage.failed
   *  (pending/skipped/not_applicable no generan evento).
   */
  private emitStageDiff(view: ExecutionView): void {
    if (!this.eventBus && !this.eventStore) return;
    // (Estabilización) Tras un reinicio, lo ya emitido se reconstruye del EventStore
    // (persistente): antes vivía solo en memoria y se re-emitían etapas publicadas.
    const known = this.lastStageStatus.get(view.executionId) ?? this.emittedStageStatuses(view.executionId);
    for (const stage of view.stages) {
      const prev = known.get(stage.id);
      if (prev === stage.status) continue; // sin cambio → no re-emitir
      known.set(stage.id, stage.status);
      const evType = stageStatusToEvent(stage.status);
      if (evType === null) continue; // estados que no generan evento
      this.emit(evType, { stageId: stage.id, label: stage.label, detail: stage.detail }, {
        executionId: view.executionId,
        sessionId: typeof view.sessionId === "string" ? view.sessionId : undefined,
      });
    }
    this.lastStageStatus.set(view.executionId, known);
  }

  /**
   * Emite eventos de alto nivel de una ejecución (started/completed/failed,
   * approval.required) comparando con lo ya conocido, y delega el diff de etapas.
   * `firstObservation` marca el momento inicial (emite execution.started).
   */
  private async emitExecutionProgress(threadId: string, firstObservation: boolean): Promise<void> {
    if (!this.eventBus && !this.eventStore) return;
    const view = await this.getExecution(threadId);
    if (view === null) return;
    const sessionId = typeof view.sessionId === "string" ? view.sessionId : undefined;

    if (firstObservation) {
      this.emit(
        "execution.started",
        { phase: view.phase, status: view.status, lifecycle: view.lifecycle },
        { executionId: threadId, sessionId },
      );
    }

    // Etapas reales observadas.
    this.emitStageDiff(view);

    // Aprobación requerida (si el flujo quedó pausado esperando al humano). No se
    // repite si el último aviso de aprobación de esta ejecución es el mismo.
    if (view.pendingApproval.required && !this.isLastApprovalRequired(threadId, view.pendingApproval)) {
      this.emit(
        "approval.required",
        {
          kind: view.pendingApproval.kind ?? "unknown",
          proposalHash: view.pendingApproval.proposalHash,
          decisionHash: view.pendingApproval.decisionHash,
        },
        { executionId: threadId, sessionId },
      );
    }

    // Terminal, según el ciclo de vida (única clasificación): una parada humana o
    // de política es `execution.stopped`, no un fallo.
    const terminalType = TERMINAL_EVENT[view.lifecycle];
    if (terminalType !== undefined) this.lastStageStatus.delete(threadId); // ya no habrá más diffs
    if (terminalType !== undefined && !this.hasTerminalEvent(threadId)) {
      this.emit(terminalType, { phase: view.phase, status: view.status, lifecycle: view.lifecycle }, {
        executionId: threadId,
        sessionId,
      });
    }
  }

  // ── (Estabilización) Idempotencia de la emisión a partir del EventStore ──────

  private storedEvents(executionId: string): SaikiEvent[] {
    return this.eventStore ? this.eventStore.getAll(executionId) : [];
  }

  /** Último estado de cada etapa YA emitido (persistido), por tipo de evento. */
  private emittedStageStatuses(executionId: string): Map<string, string> {
    const known = new Map<string, string>();
    for (const ev of this.storedEvents(executionId)) {
      const status = EVENT_TO_STAGE_STATUS[ev.type];
      if (status !== undefined) known.set((ev.data as { stageId: string }).stageId, status);
    }
    return known;
  }

  /** ¿El último evento de aprobación de la ejecución es este mismo aviso? */
  private isLastApprovalRequired(executionId: string, p: { kind?: string; decisionHash?: string }): boolean {
    const last = this.storedEvents(executionId)
      .filter((e) => e.type === "approval.required" || e.type === "approval.resolved")
      .at(-1);
    if (last?.type !== "approval.required") return false;
    const d = last.data as { kind: string; decisionHash?: string };
    return d.kind === (p.kind ?? "unknown") && d.decisionHash === p.decisionHash;
  }

  private hasTerminalEvent(executionId: string): boolean {
    return this.storedEvents(executionId).some((e) => Object.values(TERMINAL_EVENT).includes(e.type as never));
  }

  /** Cierra recursos (stores SQLite). */
  close(): void {
    this.store.close();
    this.kb.close();
    this.eventStore?.close();
  }
}

/**
 * (Fase 21) Tipo de la puerta en la que el grafo está PAUSADO (interrupt real),
 * leído del payload del interrupt (`kind`). null si no hay interrupt pendiente:
 * un "siguiente nodo" a mitad de una ejecución no cuenta como pausa.
 */
function pausedGateKind(tasks: ReadonlyArray<{ interrupts: ReadonlyArray<{ value?: unknown }> }>): string | null {
  for (const t of tasks) {
    for (const i of t.interrupts) {
      const kind = (i.value as { kind?: unknown } | undefined)?.kind;
      if (typeof kind === "string") return kind;
    }
  }
  return null;
}

/** Archivos de una propuesta, por operación. */
function splitChanges(p: DevProposal): { filesToCreate: string[]; filesToModify: string[]; filesToDelete: string[] } {
  const filesToCreate: string[] = [];
  const filesToModify: string[] = [];
  const filesToDelete: string[] = [];
  for (const ch of p.changes) {
    if (ch.operation === "create") filesToCreate.push(ch.path);
    else if (ch.operation === "modify") filesToModify.push(ch.path);
    else filesToDelete.push(ch.path);
  }
  return { filesToCreate, filesToModify, filesToDelete };
}

/** Estado de una versión de propuesta en el historial (ver `ProposalStatus`). */
function proposalStatus(
  hash: string,
  decision: DecisionView | null,
  reviews: Array<{ decision: string }>,
  view: ExecutionView,
  currentHash: string,
): ProposalStatus {
  if (decision) {
    return decision.decision === "approve" ? "approved" : decision.decision === "reject" ? "rejected" : "changes_requested";
  }
  if (view.pendingApproval.kind === "final_approval" && view.pendingApproval.proposalHash === hash) return "pending";
  if (reviews.some((r) => r.decision !== "approved")) return "rejected_by_review";
  if (hash === currentHash) return "current";
  return "superseded";
}

/** Estado de etapa que representa cada evento de etapa (inverso de stageStatusToEvent). */
const EVENT_TO_STAGE_STATUS: Record<string, string> = {
  "stage.started": "running",
  "stage.completed": "done",
  "stage.failed": "failed",
};

/** Mapea el estado de una etapa al tipo de evento, o null si no genera evento. */
function stageStatusToEvent(status: ExecutionStage["status"]): SaikiEventType | null {
  switch (status) {
    case "running":
      return "stage.started";
    case "done":
      return "stage.completed";
    case "failed":
      return "stage.failed";
    default:
      return null; // pending, skipped, not_applicable
  }
}
