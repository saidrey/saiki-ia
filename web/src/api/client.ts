import type {
  ApiErrorBody,
  ApprovalResponse,
  DecisionGateKind,
  GateResolution,
  HumanDecision,
  ProposalResolution,
  ResolutionResponse,
  CreateSessionResponse,
  ExecutionResponse,
  DecisionsResponse,
  HealthResponse,
  ProposalsResponse,
  KnowledgeDocResponse,
  KnowledgeSearchResponse,
  MessageResponse,
  SessionResponse,
  SessionsResponse,
  ApplyMode,
  ProjectHistoryResponse,
  ProjectResponse,
  ProjectsResponse,
} from "./types";

/**
 * Error de la API normalizado.
 * - `status` 0 + `code` "unreachable": no hubo respuesta del backend (proxy sin
 *   destino, backend parado o red caída).
 * - Resto: el `error`/`message` que devolvió la API, sin reinterpretarlos.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body?: ApiErrorBody;

  constructor(status: number, code: string, message: string, body?: ApiErrorBody) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Respuestas que el proxy de Vite da cuando no alcanza el backend. */
const PROXY_UNREACHABLE = new Set([502, 503, 504]);

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === "object" && v !== null && typeof (v as ApiErrorBody).error === "string";
}

export function createApiClient(baseUrl: string) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "unreachable", "No se pudo conectar con la API de Saiki-IA.");
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    if (res.ok) {
      if (data === undefined) {
        throw new ApiError(res.status, "invalid_response", "La API devolvió una respuesta que no es JSON.");
      }
      return data as T;
    }
    if (isApiErrorBody(data)) {
      throw new ApiError(res.status, data.error, data.message, data);
    }
    if (PROXY_UNREACHABLE.has(res.status) || res.status >= 500) {
      throw new ApiError(0, "unreachable", "No se pudo conectar con la API de Saiki-IA.");
    }
    throw new ApiError(res.status, "http_error", `La API respondió con HTTP ${res.status}.`);
  }

  const enc = encodeURIComponent;
  return {
    health: () => request<HealthResponse>("GET", "/health"),
    listSessions: () => request<SessionsResponse>("GET", "/sessions"),
    getSession: (sessionId: string) => request<SessionResponse>("GET", `/sessions/${enc(sessionId)}`),
    /**
     * Con proyecto, la sesión queda ligada a él para siempre. Sin proyecto solo
     * reserva un id (sesión general: se persiste con el primer mensaje).
     */
    createSession: (projectId?: string) =>
      request<CreateSessionResponse>("POST", "/sessions", projectId ? { projectId } : {}),
    /** Bloquea hasta que el moderador responde o el grafo se pausa (puede tardar minutos). */
    sendMessage: (sessionId: string, message: string) =>
      request<MessageResponse>("POST", `/sessions/${enc(sessionId)}/messages`, { message }),
    getExecution: (executionId: string) => request<ExecutionResponse>("GET", `/executions/${enc(executionId)}`),
    /** Búsqueda por texto (título y contenido), categoría y estado. Máx. 50, más recientes primero. */
    searchKnowledge: (q: { query?: string; category?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (q.query) params.set("query", q.query);
      if (q.category) params.set("category", q.category);
      if (q.status) params.set("status", q.status);
      const qs = params.toString();
      return request<KnowledgeSearchResponse>("GET", `/knowledge${qs ? `?${qs}` : ""}`);
    },
    getKnowledgeDoc: (id: string) => request<KnowledgeDocResponse>("GET", `/knowledge/${enc(id)}`),
    /** Historial inmutable de versiones de propuesta (con revisión y decisión). */
    getProposals: (executionId: string) => request<ProposalsResponse>("GET", `/executions/${enc(executionId)}/proposals`),
    /** Decisiones humanas de la ejecución (HU, viabilidad y final), con observaciones. */
    getDecisions: (executionId: string) => request<DecisionsResponse>("GET", `/executions/${enc(executionId)}/decisions`),
    getApproval: (executionId: string) => request<ApprovalResponse>("GET", `/executions/${enc(executionId)}/approval`),
    /** Aprobación final de la propuesta: reenvía el `proposalHash` recibido tal cual. Sin actorId. */
    resolveProposal: (executionId: string, body: { decision: HumanDecision; proposalHash: string; feedback?: string }) =>
      request<ResolutionResponse<ProposalResolution>>("POST", `/executions/${enc(executionId)}/approval`, body),
    /** Revisión de HU / viabilidad parcial: reenvía el `decisionHash` recibido tal cual. Sin actorId. */
    listProjects: () => request<ProjectsResponse>("GET", "/projects"),
    getProjectHistory: (projectId: string) => request<ProjectHistoryResponse>("GET", `/projects/${enc(projectId)}/history`),
    /** El backend valida la ruta (texto); el frontend no toca el sistema de archivos. */
    registerProject: (body: { name: string; path: string; applyMode: ApplyMode; confirmRealApply?: boolean }) =>
      request<ProjectResponse>("POST", "/projects", body),
    updateProject: (projectId: string, body: { name?: string; applyMode?: ApplyMode; confirmRealApply?: boolean }) =>
      request<ProjectResponse>("PATCH", `/projects/${enc(projectId)}`, body),
    setProjectActive: (projectId: string, active: boolean) =>
      request<ProjectResponse>("POST", `/projects/${enc(projectId)}/${active ? "activate" : "deactivate"}`),
    resolveGate: (
      executionId: string,
      kind: DecisionGateKind,
      body: { decision: HumanDecision; decisionHash: string; feedback?: string },
    ) => request<ResolutionResponse<GateResolution>>("POST", `/executions/${enc(executionId)}/approval/${kind}`, body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Cliente de la app: siempre a través del proxy `/api` (ver vite.config.ts). */
export const api = createApiClient("/api");
