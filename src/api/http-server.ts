import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { SaikiCore } from "../core/saiki-core.js";
import type { HumanDecision, DecisionGateKind, ProjectResult, ContextScanResult, KnowledgeResult } from "../core/jev-contracts.js";
import { PROJECT_KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "../knowledge/kb-types.js";
import type { FileKind } from "../context/file-classifier.js";
import { projectStreamKey, type EventStore } from "../events/event-store.js";
import type { SaikiEvent } from "../events/event-types.js";
import { isTerminalLifecycle } from "../core/execution-lifecycle.js";

/** (Estabilización) Cliente SSE abierto: el servidor lo cierra al apagarse. */
interface SseClient {
  shutdown: () => void;
}

/** Eventos tras los cuales una ejecución no emite nada más (ejecución definitiva). */
const TERMINAL_EVENT_TYPES = new Set(["execution.completed", "execution.failed", "execution.stopped"]);

/**
 * API REST LOCAL sobre `SaikiCore` (Fase 19).
 *
 * Capa HTTP DELGADA con el módulo `http` nativo (sin Express/Fastify). Reutiliza
 * `SaikiCore`/`JevCorePort`: NO duplica lógica de negocio ni persistencia.
 *
 * SEGURIDAD (local):
 *  - Escucha SOLO en 127.0.0.1. No se expone a la red.
 *  - La IDENTIDAD humana la fija el SERVIDOR (`humanActor`), NUNCA el cuerpo de
 *    la petición: el frontend no puede suplantar a otro actor.
 *  - No hay ruta directa al Safe Applier: las aprobaciones reanudan el grafo.
 *  - Las respuestas no filtran stderr crudo ni secretos de runtimes.
 *
 * LIMITACIONES del modelo local (documentadas): identidad única local, sin
 * autenticación multiusuario. Evolución futura: auth real (fuera de alcance).
 */

export const DEFAULT_PORT = 4123;
export const DEFAULT_HOST = "127.0.0.1";
/** Identidad humana por defecto si no se configura una explícita. */
export const DEFAULT_HUMAN_ACTOR = "local-human";

export interface ApiServerOptions {
  core: SaikiCore;
  /** Identidad humana local, validada en el servidor (no en el body). */
  humanActor?: string;
  port?: number;
  host?: string;
  /**
   * (Fase 20) Store de eventos para el endpoint SSE (reconexión por
   * Last-Event-ID). Si se omite, el endpoint SSE responde 501 (no disponible).
   */
  eventStore?: EventStore;
  /** (Fase 20) Intervalo de heartbeat SSE en ms (default 15000). */
  heartbeatMs?: number;
}

/** Handle del servidor con cierre ordenado. */
export interface ApiServerHandle {
  server: Server;
  /** Puerto configurado (puede ser 0 → efímero; usar `ready` + address()). */
  port: number;
  host: string;
  /** Resuelve cuando el servidor está efectivamente escuchando. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/** Error HTTP con código, para el manejo central. */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

type Handler = (
  ctx: { params: Record<string, string>; query: URLSearchParams; body: unknown },
) => Promise<{ status: number; body: unknown }>;

interface Route {
  method: string;
  /** Segmentos del path; los que empiezan por ":" son parámetros. */
  segments: string[];
  handler: Handler;
}

export function createApiServer(options: ApiServerOptions): ApiServerHandle {
  const core = options.core;
  const humanActor = options.humanActor ?? DEFAULT_HUMAN_ACTOR;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.SAIKI_API_PORT ?? DEFAULT_PORT);

  const routes: Route[] = buildRoutes(core, humanActor);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const sseClients = new Set<SseClient>();

  const server = createServer((req, res) => {
    // (Fase 20) El endpoint SSE se maneja aparte (no devuelve JSON de una vez).
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sse = matchSsePath(req.method ?? "GET", url.pathname);
    if (sse !== null) {
      const handle =
        "executionId" in sse
          ? handleSse(req, res, core, options.eventStore, sse.executionId, url, heartbeatMs, sseClients)
          : handleProjectContextSse(req, res, core, options.eventStore, sse.projectId, url, heartbeatMs, sseClients);
      handle.catch((e) => {
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: safeMessage(e) });
      });
      return;
    }
    handleRequest(req, res, routes).catch((e) => {
      // Red de seguridad: ningún error debe tumbar el servidor.
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: safeMessage(e) });
    });
  });

  // Escucha explícitamente en 127.0.0.1 (no 0.0.0.0).
  const ready = new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  server.listen(port, host);

  return {
    server,
    port,
    host,
    ready,
    // (Estabilización) Antes, `server.close()` esperaba a que terminasen los
    // streams SSE, que no terminan nunca: el proceso quedaba colgado. Ahora se
    // avisa a cada cliente (`control: shutdown`), se cierran sus streams y las
    // conexiones restantes, y el cierre termina.
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of [...sseClients]) client.shutdown();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// ── Enrutamiento ──────────────────────────────────────────────────────────────

function buildRoutes(core: SaikiCore, humanActor: string): Route[] {
  const route = (method: string, path: string, handler: Handler): Route => ({
    method,
    segments: path.split("/").filter((s) => s.length > 0),
    handler,
  });

  /** (T10) Aprobar o rechazar la versión exacta que se revisó (`versionHash`). */
  const knowledgeDecision = async (id: string, decision: "approve" | "reject", body: unknown) => {
    const versionHash = (body as Record<string, unknown> | undefined)?.versionHash;
    if (typeof versionHash !== "string" || versionHash === "") throw new HttpError(400, "versionHash es obligatorio: aprueba o rechaza la versión que revisaste.");
    return knowledgeResponse(await core.decideKnowledge(id, decision, versionHash, humanActor));
  };

  return [
    // ── Sesiones ──
    route("POST", "/sessions", async ({ body }) => {
      const b = (body ?? {}) as { sessionId?: string; projectId?: unknown };
      const sessionId = typeof b.sessionId === "string" && b.sessionId.length > 0 ? b.sessionId : `sess-${cryptoId()}`;
      if (b.projectId !== undefined && (typeof b.projectId !== "string" || b.projectId.length === 0)) {
        throw new HttpError(400, "projectId debe ser el id de un proyecto registrado.");
      }
      // (Project Registry) Con proyecto, la sesión se persiste ligada a él. Sin
      // proyecto, como antes: el primer mensaje crea la sesión (general).
      const r = await core.openSession(sessionId, b.projectId as string | undefined);
      if (!r.ok) {
        const status = r.reason === "project_not_found" ? 404 : r.reason === "project_inactive" ? 400 : 409;
        return { status, body: { error: r.reason, message: r.message } };
      }
      return { status: 201, body: { sessionId, existed: r.existed, ...(r.projectId ? { projectId: r.projectId } : {}) } };
    }),

    route("GET", "/sessions", async ({ query }) => {
      const projectId = query.get("projectId");
      const sessions = await core.listSessions();
      return { status: 200, body: { sessions: projectId ? sessions.filter((s) => s.projectId === projectId) : sessions } };
    }),

    route("GET", "/sessions/:id", async ({ params }) => {
      const session = await core.getSession(params.id);
      if (session === null) throw new HttpError(404, `Sesión "${params.id}" no encontrada.`);
      const tasks = await core.listTasks(params.id);
      return { status: 200, body: { session, tasks } };
    }),

    route("POST", "/sessions/:id/messages", async ({ params, body }) => {
      const b = (body ?? {}) as { message?: unknown };
      if (typeof b.message !== "string" || b.message.trim().length === 0) {
        throw new HttpError(400, "El cuerpo debe incluir 'message' (string no vacío).");
      }
      const result = await core.process(params.id, b.message);
      return { status: 200, body: { result } };
    }),

    // ── Ejecuciones ──
    route("GET", "/executions/:threadId", async ({ params }) => {
      const view = await core.getExecution(params.threadId);
      if (view === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      return { status: 200, body: { execution: view } };
    }),

    // (T9) Bundles congelados de Kiro y Claude. Solo lectura; nunca se reconstruyen.
    route("GET", "/executions/:threadId/context", async ({ params, query }) => {
      const raw = query.get("huVersion");
      const huVersion = raw === null ? undefined : Number(raw);
      if (huVersion !== undefined && (!Number.isInteger(huVersion) || huVersion < 1)) {
        throw new HttpError(400, "huVersion debe ser un entero positivo.");
      }
      const r = await core.getExecutionContextBundles(params.threadId, huVersion);
      if (r.ok) return { status: 200, body: { context: r.context } };
      return { status: r.code === "integrity_failed" ? 409 : 404, body: { error: r.code, message: r.message } };
    }),

    route("GET", "/executions/:threadId/stages", async ({ params }) => {
      const view = await core.getExecution(params.threadId);
      if (view === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      return { status: 200, body: { executionId: view.executionId, currentStage: view.currentStage, stages: view.stages } };
    }),

    route("GET", "/executions/:threadId/result", async ({ params }) => {
      const view = await core.getExecution(params.threadId);
      if (view === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      return { status: 200, body: { executionId: view.executionId, status: view.status, finalResult: view.finalResult } };
    }),

    // ── Aprobaciones ──
    route("GET", "/executions/:threadId/approval", async ({ params }) => {
      const view = await core.getExecution(params.threadId);
      if (view === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      const proposal = view.pendingApproval.required ? await core.getPendingProposal(params.threadId) : null;
      // (Fase 21) Revisión de HU / viabilidad parcial: lo que hay que decidir.
      const gate = view.pendingApproval.required ? await core.getPendingGate(params.threadId) : null;
      return { status: 200, body: { pendingApproval: view.pendingApproval, proposal, gate } };
    }),

    route("POST", "/executions/:threadId/approval", async ({ params, body }) => {
      const b = (body ?? {}) as { decision?: unknown; proposalHash?: unknown; feedback?: unknown };
      const decision = b.decision;
      if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") {
        throw new HttpError(400, "decision debe ser 'approve' | 'reject' | 'request_changes'.");
      }
      if (typeof b.proposalHash !== "string" || b.proposalHash.length === 0) {
        throw new HttpError(400, "Falta 'proposalHash' (debe coincidir con la propuesta pendiente).");
      }
      const feedback = typeof b.feedback === "string" ? b.feedback : undefined;
      // La IDENTIDAD la fija el servidor, NO el body (no se lee ningún actorId).
      const resolution = await core.resolveApproval(params.threadId, {
        decision: decision as HumanDecision,
        proposalHash: b.proposalHash,
        actor: humanActor,
        feedback,
      });
      if (!resolution.ok) {
        const status = resolution.reason === "not_found" ? 404 : resolution.reason === "hash_mismatch" ? 409 : 409;
        return { status, body: { error: resolution.reason, message: resolution.message, expectedHash: resolution.expectedHash } };
      }
      return { status: 200, body: { resolution } };
    }),

    // (Fase 21) Revisión de HU y viabilidad parcial. La aprobación final de la
    // propuesta sigue en POST /executions/:threadId/approval (con proposalHash).
    route("POST", "/executions/:threadId/approval/:kind", async ({ params, body }) => {
      const kind = params.kind;
      if (kind !== "hu_review" && kind !== "feasibility_partial") {
        throw new HttpError(
          400,
          "kind debe ser 'hu_review' | 'feasibility_partial'. La aprobación final se resuelve en POST /executions/:id/approval.",
        );
      }
      const b = (body ?? {}) as { decision?: unknown; decisionHash?: unknown; feedback?: unknown };
      const decision = b.decision;
      if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") {
        throw new HttpError(400, "decision debe ser 'approve' | 'reject' | 'request_changes'.");
      }
      if (typeof b.decisionHash !== "string" || b.decisionHash.length === 0) {
        throw new HttpError(400, "Falta 'decisionHash' (debe coincidir con la versión pendiente).");
      }
      const feedback = typeof b.feedback === "string" ? b.feedback : undefined;
      // La IDENTIDAD la fija el servidor, NO el body (no se lee ningún actorId).
      const resolution = await core.resolveGate(params.threadId, kind as DecisionGateKind, {
        decision: decision as HumanDecision,
        decisionHash: b.decisionHash,
        actor: humanActor,
        feedback,
      });
      if (!resolution.ok) {
        const status =
          resolution.reason === "not_found" ? 404 : resolution.reason === "unsupported_decision" ? 400 : 409;
        return {
          status,
          body: {
            error: resolution.reason,
            message: resolution.message,
            expectedHash: resolution.expectedHash,
            pendingKind: resolution.pendingKind,
          },
        };
      }
      return { status: 200, body: { resolution } };
    }),

    // (Estabilización) Historial inmutable de propuestas y decisiones. Solo lectura.
    route("GET", "/executions/:threadId/proposals", async ({ params }) => {
      const proposals = await core.getProposalHistory(params.threadId);
      if (proposals === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      return { status: 200, body: { executionId: params.threadId, proposals } };
    }),

    route("GET", "/executions/:threadId/proposals/:hash", async ({ params }) => {
      if ((await core.getExecution(params.threadId)) === null) {
        throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      }
      const proposal = await core.getProposal(params.threadId, params.hash);
      if (proposal === null) throw new HttpError(404, `La ejecución no tiene una propuesta con hash "${params.hash}".`);
      return { status: 200, body: { proposal } };
    }),

    route("GET", "/executions/:threadId/decisions", async ({ params }) => {
      const decisions = await core.getDecisionHistory(params.threadId);
      if (decisions === null) throw new HttpError(404, `Ejecución "${params.threadId}" no encontrada.`);
      return { status: 200, body: { executionId: params.threadId, decisions } };
    }),

    // ── (Project Registry) Proyectos. Solo el humano los administra; el actor lo fija el servidor. ──
    route("POST", "/projects", async ({ body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      return projectResponse(await core.registerProject(b, humanActor), 201);
    }),

    route("GET", "/projects", async ({ query }) => {
      const status = query.get("status") ?? undefined;
      if (status !== undefined && status !== "active" && status !== "inactive") {
        throw new HttpError(400, "status debe ser 'active' | 'inactive'.");
      }
      return { status: 200, body: { projects: await core.listProjects(status) } };
    }),

    route("GET", "/projects/:id", async ({ params }) => {
      const project = await core.getProject(params.id);
      if (project === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { project } };
    }),

    route("GET", "/projects/:id/history", async ({ params }) => {
      const history = await core.getProjectHistory(params.id);
      if (history === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { projectId: params.id, history } };
    }),

    route("PATCH", "/projects/:id", async ({ params, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if ("path" in b || "rootPath" in b) {
        return {
          status: 400,
          body: { error: "path_immutable", message: "La ruta de un proyecto no se puede cambiar: registra la nueva ruta como proyecto nuevo." },
        };
      }
      return projectResponse(await core.updateProject(params.id, b, humanActor));
    }),

    route("POST", "/projects/:id/deactivate", async ({ params }) =>
      projectResponse(await core.deactivateProject(params.id, humanActor)),
    ),

    route("POST", "/projects/:id/activate", async ({ params }) =>
      projectResponse(await core.activateProject(params.id, humanActor)),
    ),

    // ── (Project Context) Contexto de proyectos. La API solo usa la fachada del Core. ──
    route("GET", "/projects/:id/context", async ({ params }) => {
      const context = await core.getProjectContext(params.id);
      if (context === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { context } };
    }),

    route("POST", "/projects/:id/context/scan", async ({ params, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const mode = b.mode ?? "incremental";
      if (mode !== "incremental" && mode !== "full") throw new HttpError(400, "mode debe ser 'incremental' | 'full'.");
      return scanResponse(await core.requestContextScan(params.id, mode));
    }),

    route("GET", "/projects/:id/context/scans", async ({ params, query }) => {
      const scans = await core.listContextScans(params.id, parseLimit(query, 20));
      if (scans === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { projectId: params.id, scans } };
    }),

    route("GET", "/projects/:id/context/scans/:scanId", async ({ params }) => {
      if ((await core.getProject(params.id)) === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      const scan = await core.getContextScan(params.id, params.scanId);
      if (scan === null) throw new HttpError(404, `Escaneo "${params.scanId}" no encontrado en este proyecto.`);
      return { status: 200, body: { scan } };
    }),

    route("GET", "/projects/:id/context/snapshots/:snapshotId", async ({ params }) => {
      if ((await core.getProject(params.id)) === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      const snapshot = await core.getContextSnapshot(params.id, params.snapshotId);
      if (snapshot === null) throw new HttpError(404, `Snapshot "${params.snapshotId}" no encontrado en este proyecto.`);
      return { status: 200, body: { snapshot } };
    }),

    route("GET", "/projects/:id/context/files", async ({ params, query }) => {
      const kind = query.get("kind") ?? undefined;
      if (kind !== undefined && !FILE_KINDS.has(kind)) throw new HttpError(400, `kind debe ser uno de: ${[...FILE_KINDS].join(", ")}.`);
      const page = await core.listContextFiles(params.id, {
        prefix: query.get("prefix") ?? undefined,
        kind: kind as FileKind | undefined,
        after: query.get("cursor") ?? undefined,
        limit: parseLimit(query, 200),
      });
      if (page === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { projectId: params.id, ...page } };
    }),

    // ── Knowledge Base ──
    // Sin `projectId`: solo el conocimiento global (como antes). Con él: solo ese proyecto.
    route("GET", "/knowledge", async ({ query }) => {
      const text = query.get("query") ?? query.get("text") ?? undefined;
      const category = query.get("category") ?? undefined;
      const statusQ = query.get("status") ?? undefined;
      const projectId = query.get("projectId") ?? undefined;
      if (projectId !== undefined && (await core.getProject(projectId)) === null) {
        throw new HttpError(404, `Proyecto "${projectId}" no encontrado.`);
      }
      const docs = await core.searchKnowledge({
        text: text ?? undefined,
        category: (category ?? undefined) as never,
        status: (statusQ ?? undefined) as never,
        projectId,
      });
      return { status: 200, body: { documents: docs } };
    }),

    route("GET", "/knowledge/:id", async ({ params }) => {
      const doc = await core.getKnowledgeDoc(params.id);
      if (doc === null) throw new HttpError(404, `Documento "${params.id}" no encontrado.`);
      return { status: 200, body: { document: doc } };
    }),

    // ── (T10) Conocimiento por proyecto y versiones. El actor lo pone el servidor. ──
    route("GET", "/knowledge/:id/versions", async ({ params }) => {
      const versions = await core.getKnowledgeVersions(params.id);
      if (versions === null) throw new HttpError(404, `Documento "${params.id}" no encontrado.`);
      return { status: 200, body: { documentId: versions[0]?.documentId ?? params.id, versions } };
    }),

    route("POST", "/projects/:id/knowledge", async ({ params, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.category !== "string" || !PROJECT_KNOWLEDGE_CATEGORIES.includes(b.category as KnowledgeCategory)) {
        throw new HttpError(400, `category debe ser una de: ${PROJECT_KNOWLEDGE_CATEGORIES.join(", ")}.`);
      }
      if (typeof b.title !== "string" || typeof b.content !== "string") throw new HttpError(400, "title y content son obligatorios (texto).");
      const r = await core.proposeProjectKnowledge(params.id, { category: b.category as KnowledgeCategory, title: b.title, content: b.content }, humanActor);
      return knowledgeResponse(r, 201);
    }),

    route("POST", "/knowledge/:id/versions", async ({ params, body }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if ((b.title !== undefined && typeof b.title !== "string") || (b.content !== undefined && typeof b.content !== "string")) {
        throw new HttpError(400, "title y content deben ser texto.");
      }
      return knowledgeResponse(await core.proposeKnowledgeVersion(params.id, { title: b.title as string | undefined, content: b.content as string | undefined }, humanActor), 201);
    }),

    route("POST", "/knowledge/:id/approve", async ({ params, body }) => knowledgeDecision(params.id, "approve", body)),
    route("POST", "/knowledge/:id/reject", async ({ params, body }) => knowledgeDecision(params.id, "reject", body)),

    route("POST", "/knowledge/:id/archive", async ({ params }) => knowledgeResponse(await core.archiveKnowledge(params.id, humanActor))),

    route("GET", "/projects/:id/knowledge/export", async ({ params }) => {
      const markdown = await core.exportProjectKnowledge(params.id);
      if (markdown === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { projectId: params.id, markdown } };
    }),

    // (T11) Project Analyst: solo a petición humana; las propuestas entran como `proposed`.
    route("POST", "/projects/:id/analysis", async ({ params }) => {
      const r = await core.analyzeProject(params.id, humanActor);
      if (r.ok) return { status: 202, body: { analysis: r.analysis } };
      return { status: SCAN_ERROR_STATUS[r.code] ?? 409, body: { error: r.code, message: r.message } };
    }),

    route("GET", "/projects/:id/analysis", async ({ params }) => {
      if ((await core.getProject(params.id)) === null) throw new HttpError(404, `Proyecto "${params.id}" no encontrado.`);
      return { status: 200, body: { projectId: params.id, analysis: await core.getProjectAnalysis(params.id) } };
    }),
  ];
}

/** (T10) Código de error de la Knowledge Base → estado HTTP. */
const KNOWLEDGE_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  project_not_found: 404,
  invalid: 400,
  agent_forbidden: 403,
  not_proposed: 409,
  not_approved: 409,
  hash_mismatch: 409,
  stale_base: 409,
  pending_exists: 409,
};

function knowledgeResponse(r: KnowledgeResult, okStatus = 200): { status: number; body: unknown } {
  if (r.ok) return { status: okStatus, body: { document: r.document } };
  return { status: KNOWLEDGE_ERROR_STATUS[r.code] ?? 400, body: { error: r.code, message: r.message } };
}

/** (Project Registry) Código de error del registro → estado HTTP. */
const PROJECT_ERROR_STATUS: Partial<Record<string, number>> = {
  not_found: 404,
  already_registered: 409,
  nested_project: 409,
  name_taken: 409,
  project_unhealthy: 409,
  has_active_executions: 409,
};

function projectResponse(r: ProjectResult, okStatus = 200): { status: number; body: unknown } {
  if (r.ok) return { status: okStatus, body: { project: r.project } };
  return {
    status: PROJECT_ERROR_STATUS[r.code] ?? 400,
    body: { error: r.code, message: r.message, ...(r.projectId ? { projectId: r.projectId } : {}) },
  };
}

const FILE_KINDS: ReadonlySet<string> = new Set(["source", "test", "config", "manifest", "doc", "binary", "secret", "other"]);

/** `?limit=` entero entre 1 y 1000. */
function parseLimit(query: URLSearchParams, fallback: number): number {
  const raw = query.get("limit");
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpError(400, "limit debe ser un entero entre 1 y 1000.");
  return n;
}

/** (Project Context) Código de la solicitud de escaneo → estado HTTP. */
const SCAN_ERROR_STATUS: Record<string, number> = {
  project_not_found: 404,
  project_inactive: 409,
  project_unhealthy: 409,
  context_disabled: 501,
  scheduler_closed: 503,
};

function scanResponse(r: ContextScanResult): { status: number; body: unknown } {
  if (r.ok) return { status: 202, body: { scan: r.scan, deduplicated: r.deduplicated } };
  return { status: SCAN_ERROR_STATUS[r.code] ?? 400, body: { error: r.code, message: r.message } };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, routes: Route[]): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathSegments = url.pathname.split("/").filter((s) => s.length > 0);

  // Health check simple.
  if (method === "GET" && pathSegments.length === 1 && pathSegments[0] === "health") {
    return sendJson(res, 200, { ok: true });
  }

  const match = matchRoute(routes, method, pathSegments);
  if (match === null) {
    return sendJson(res, 404, { error: "not_found", message: `Ruta no encontrada: ${method} ${url.pathname}` });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_json", message: "El cuerpo no es JSON válido." });
  }

  try {
    const result = await match.route.handler({ params: match.params, query: url.searchParams, body });
    return sendJson(res, result.status, result.body);
  } catch (e) {
    if (e instanceof HttpError) {
      return sendJson(res, e.status, { error: statusToCode(e.status), message: e.message });
    }
    return sendJson(res, 500, { error: "internal_error", message: safeMessage(e) });
  }
}

function matchRoute(
  routes: Route[],
  method: string,
  pathSegments: string[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(pathSegments[i]);
      else if (seg !== pathSegments[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

// ── SSE (Fase 20) ─────────────────────────────────────────────────────────────

/** ¿La petición es a un endpoint SSE? Devuelve la ejecución o el proyecto, o null. */
function matchSsePath(method: string, pathname: string): { executionId: string } | { projectId: string } | null {
  if (method.toUpperCase() !== "GET") return null;
  const segs = pathname.split("/").filter((s) => s.length > 0);
  // /executions/:executionId/events
  if (segs.length === 3 && segs[0] === "executions" && segs[2] === "events") {
    return { executionId: decodeURIComponent(segs[1]) };
  }
  // (Project Context) /projects/:projectId/context/events
  if (segs.length === 4 && segs[0] === "projects" && segs[2] === "context" && segs[3] === "events") {
    return { projectId: decodeURIComponent(segs[1]) };
  }
  return null;
}

/**
 * Endpoint SSE: `GET /executions/:executionId/events`.
 *
 * - Verifica que la ejecución existe (404 si no).
 * - Reenvía el historial posterior a `Last-Event-ID` (header o ?lastEventId=).
 * - Luego suscribe al bus del Core para los eventos NUEVOS de esa ejecución.
 * - Formato SSE estándar con `id:`/`event:`/`data:` y heartbeat (`: ping`).
 * - Al desconectarse el cliente: desuscribe y limpia el timer. Una desconexión
 *   NUNCA interrumpe la ejecución (solo cierra el stream).
 * - (Estabilización) Ejecución definitiva (completada, fallida o detenida): tras
 *   el historial, o tras el evento terminal en vivo, se envía `control: end` y se
 *   cierra el stream (no habrá más eventos; el cliente no debe reconectar).
 * - (Estabilización) Al apagar el servidor: `control: shutdown` y cierre.
 */
async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  core: SaikiCore,
  eventStore: EventStore | undefined,
  executionId: string,
  url: URL,
  heartbeatMs: number,
  clients: Set<SseClient>,
): Promise<void> {
  // La ejecución debe existir.
  const view = await core.getExecution(executionId);
  if (view === null) {
    return sendJson(res, 404, { error: "not_found", message: `Ejecución "${executionId}" no encontrada.` });
  }
  if (!eventStore || !core.events) {
    return sendJson(res, 501, { error: "sse_unavailable", message: "El servidor no tiene eventos configurados." });
  }
  openStream(req, res, url, {
    eventStore,
    bus: core.events,
    key: executionId,
    accepts: (ev) => ev.executionId === executionId,
    endedNow: isTerminalLifecycle(view.lifecycle),
    endsAfter: (ev) => TERMINAL_EVENT_TYPES.has(ev.type),
    heartbeatMs,
    clients,
  });
}

/**
 * (Project Context) Endpoint SSE: `GET /projects/:projectId/context/events`.
 *
 * Mismo protocolo que el de ejecuciones (historial desde `Last-Event-ID` o
 * `?lastEventId=`, `gap`, heartbeat, `shutdown`), sobre el stream de eventos
 * `context.*` del proyecto, con su propio `seq`. No termina: un proyecto puede
 * volver a escanearse en cualquier momento. 404 si el proyecto no existe.
 */
async function handleProjectContextSse(
  req: IncomingMessage,
  res: ServerResponse,
  core: SaikiCore,
  eventStore: EventStore | undefined,
  projectId: string,
  url: URL,
  heartbeatMs: number,
  clients: Set<SseClient>,
): Promise<void> {
  if ((await core.getProject(projectId)) === null) {
    return sendJson(res, 404, { error: "not_found", message: `Proyecto "${projectId}" no encontrado.` });
  }
  if (!eventStore || !core.events) {
    return sendJson(res, 501, { error: "sse_unavailable", message: "El servidor no tiene eventos configurados." });
  }
  openStream(req, res, url, {
    eventStore,
    bus: core.events,
    key: projectStreamKey(projectId),
    accepts: (ev) => ev.projectId === projectId && ev.executionId === undefined,
    endedNow: false,
    endsAfter: () => false,
    heartbeatMs,
    clients,
  });
}

interface StreamSpec {
  eventStore: EventStore;
  bus: NonNullable<SaikiCore["events"]>;
  /** Clave del stream en el `EventStore` (su `seq` es el `Last-Event-ID`). */
  key: string;
  /** ¿El evento en vivo pertenece a este stream? */
  accepts: (ev: SaikiEvent) => boolean;
  /** El stream ya no tendrá más eventos (se cierra tras el historial). */
  endedNow: boolean;
  /** Tras este evento en vivo no habrá más (se cierra). */
  endsAfter: (ev: SaikiEvent) => boolean;
  heartbeatMs: number;
  clients: Set<SseClient>;
}

/** Abre un stream SSE: historial desde el último id visto y después eventos en vivo. */
function openStream(req: IncomingMessage, res: ServerResponse, url: URL, spec: StreamSpec): void {
  const { eventStore, key, clients } = spec;
  // Último id visto por el cliente (reconexión).
  const lastHeader = req.headers["last-event-id"];
  const lastFromHeader = Array.isArray(lastHeader) ? lastHeader[0] : lastHeader;
  const lastFromQuery = url.searchParams.get("lastEventId") ?? undefined;
  const lastSeenRaw = lastFromHeader ?? lastFromQuery;
  let lastSeen = Number(lastSeenRaw);
  if (!Number.isFinite(lastSeen) || lastSeen < 0) lastSeen = 0;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Comentario inicial para abrir el stream de inmediato.
  res.write(": ok\n\n");

  // Si el cliente pidió eventos anteriores a los disponibles (brecha por
  // retención), avisamos con un evento de control y servimos desde el más
  // antiguo disponible.
  const earliest = eventStore.earliestSeq(key);
  if (earliest !== null && lastSeen > 0 && lastSeen < earliest - 1) {
    writeSse(res, { kind: "gap", from: lastSeen, earliest });
    lastSeen = earliest - 1;
  }

  // 1. Reenviar el historial posterior a lastSeen.
  for (const ev of eventStore.getSince(key, lastSeen)) {
    writeEvent(res, ev);
    if (typeof ev.seq === "number") lastSeen = ev.seq;
  }

  // 1b. Stream definitivo: no habrá más eventos. Fin explícito.
  if (spec.endedNow) {
    writeSse(res, { kind: "end", reason: "terminal", lastSeq: lastSeen });
    res.end();
    return;
  }

  // 2. Suscribirse a los eventos NUEVOS. (Sin await entre el reenvío y la
  //    suscripción: no se pierde ningún evento entre ambos.)
  const unsubscribe = spec.bus.subscribe((ev: SaikiEvent) => {
    if (!spec.accepts(ev)) return;
    if (typeof ev.seq === "number" && ev.seq <= lastSeen) return; // ya enviado
    writeEvent(res, ev);
    if (typeof ev.seq === "number") lastSeen = ev.seq;
    if (spec.endsAfter(ev)) {
      writeSse(res, { kind: "end", reason: "terminal", lastSeq: lastSeen });
      cleanup();
      res.end();
    }
  });

  // 3. Heartbeat para mantener viva la conexión.
  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, spec.heartbeatMs);

  // 4. Limpieza al desconectar. NO afecta la ejecución. Idempotente.
  const client: SseClient = {
    shutdown: () => {
      if (!res.writableEnded) writeSse(res, { kind: "shutdown" });
      cleanup();
      res.end();
    },
  };
  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(client);
  }
  clients.add(client);
  req.on("close", cleanup);
  res.on("close", cleanup);
}

/** Escribe un evento de dominio en formato SSE (id/event/data). */
function writeEvent(res: ServerResponse, ev: SaikiEvent): void {
  if (typeof ev.seq === "number") res.write(`id: ${ev.seq}\n`);
  res.write(`event: ${ev.type}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** Escribe un evento de control SSE (sin id; tipo "control"). */
function writeSse(res: ServerResponse, data: unknown): void {
  res.write(`event: control\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Utilidades ──────────────────────────────────────────────────────────────

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 1024 * 1024; // 1 MiB
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 404: return "not_found";
    case 409: return "conflict";
    default: return "error";
  }
}

/** Mensaje de error saneado: nunca incluye secretos ni volcados crudos. */
function safeMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Trunca para no filtrar grandes volcados (p. ej. stderr de un runtime).
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

function cryptoId(): string {
  // ID corto sin dependencias; suficiente para identificar sesiones/ejecuciones.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
