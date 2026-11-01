import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServerHandle } from "../api/http-server.js";
import { SaikiCore, type SaikiCoreOptions } from "../core/saiki-core.js";
import { CoreStore } from "../core/core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createMemoryCheckpointer, createSqliteCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import { openDataStores, type DataPaths } from "../persistence/data-dir.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

/**
 * Apoyo de pruebas del registro de proyectos: agente determinista que anota el
 * directorio de trabajo que recibe cada llamada, y un servidor HTTP real sobre
 * SQLite (grafo, Core, API y eventos reales).
 */

export interface AgentCall {
  role: string;
  cwd: string | undefined;
  input: string;
  /** Marca de la solicitud (`[P:A]` en el mensaje → "A"); viaja en todos los prompts del flujo. */
  marker: string;
}

/** Contenido que el agente de desarrollo propone para `path` (create). */
export type DevFile = { path: string; content: string };

/** Por marca: archivo existente que cita el análisis técnico y archivo que se propone crear. */
export type FlowPlan = (marker: string) => { affected: string; create: DevFile; /** Resumen de la HU (contexto, T8). */ hu?: string };

const DEFAULT_PLAN: FlowPlan = () => ({ affected: "README.md", create: { path: "src/gen.ts", content: "export const v = 1;\n" } });

function markerOf(input: string): string {
  return /\[P:([A-Za-z0-9_-]+)\]/.exec(input)?.[1] ?? "";
}

export class FlowAgent implements AgentAdapter {
  readonly name = "flow-agent";
  readonly calls: AgentCall[] = [];
  private readonly holds = new Map<string, { started: () => void; release: Promise<void> }>();
  /** (T11) Respuesta del rol `projectAnalyst`: texto o resultado completo (fallos, timeouts). */
  projectAnalysis: string | AgentResult = JSON.stringify({ documents: [] });

  constructor(private readonly plan: FlowPlan = DEFAULT_PLAN) {}

  /** Retiene la próxima llamada al rol hasta `release()`. */
  hold(role: string): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    this.holds.set(role, { started, release: new Promise<void>((r) => (release = r)) });
    return { started: startedP, release };
  }

  cwdsOf(role: string, marker?: string): Array<string | undefined> {
    return this.calls.filter((c) => c.role === role && (marker === undefined || c.marker === marker)).map((c) => c.cwd);
  }

  async run(r: AgentRequest): Promise<AgentResult> {
    const cwd = typeof r.context?.workingDirectory === "string" ? r.context.workingDirectory : undefined;
    const marker = markerOf(r.input);
    this.calls.push({ role: r.role, cwd, input: r.input, marker });
    const plan = this.plan(marker);
    const h = this.holds.get(r.role);
    if (h) {
      this.holds.delete(r.role);
      h.started();
      await h.release;
    }
    const ok = (output: string): AgentResult => ({ status: "success", role: r.role, output });
    switch (r.role) {
      case "huAnalyst":
        return ok(
          JSON.stringify({
            summary: `${plan.hu ?? "HU"} [P:${marker}]`, need: "util",
            tasks: [{ order: 1, description: "crear util" }],
            acceptanceCriteria: [{ id: "AC1", description: "funciona" }],
            assumptions: [], openQuestions: [], dependencies: [],
          }),
        );
      case "technicalAnalyst":
        return ok(
          JSON.stringify({
            summary: `análisis [P:${marker}]`, currentFlow: "f",
            affectedFiles: [{ path: plan.affected, responsibility: "r" }],
            proposedChanges: [{ path: plan.create.path, change: "crear" }],
            traceability: [], dependencies: [], risks: [], openQuestions: [],
          }),
        );
      case "develop": {
        const f = plan.create;
        return ok(
          JSON.stringify({
            summary: `crear ${f.path} [P:${marker}]`, technicalDecisions: ["pura"],
            changes: [{ path: f.path, operation: "create", content: f.content }],
            traceability: [{ ref: "AC1", note: "impl" }], risks: [], dependencies: [], openQuestions: [],
            coveredCriteria: ["AC1"], uncoveredCriteria: [],
          }),
        );
      }
      case "functionalReviewer":
        return ok(JSON.stringify({ decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"], unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok" }));
      case "qualityReviewer":
        return ok(JSON.stringify({ decision: "approved", categories: [{ category: "clean-code", assessment: "ok" }], findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok" }));
      case "projectAnalyst":
        return typeof this.projectAnalysis === "string" ? ok(this.projectAnalysis) : this.projectAnalysis;
      default:
        return ok("resultado de asistencia");
    }
  }
}

export interface TestServer {
  core: SaikiCore;
  handle: ApiServerHandle;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, any> }>;
  stop: () => Promise<void>;
}

/**
 * Servidor real. Con `persist`, SQLite en `dir` (sobrevive a reiniciar con otro `startTestServer`).
 * Con `data`, las bases de datos se abren como en `serve.ts` (directorio de datos resuelto).
 */
export async function startTestServer(opts: {
  dir: string;
  agent: FlowAgent;
  persist?: boolean;
  sandboxDir?: string;
  data?: DataPaths;
  contextScan?: SaikiCoreOptions["contextScan"];
  contextRefreshMs?: number;
  /** Con `data`, abre las bases de datos pero sin contexto (Core anterior a Project Context). */
  withoutContext?: boolean;
}): Promise<TestServer> {
  const { dir, agent, persist = false, sandboxDir, data, contextScan, contextRefreshMs, withoutContext } = opts;
  const router = new MapAgentRouter(
    { analyze: agent, develop: agent, review: agent, huAnalyst: agent, technicalAnalyst: agent, functionalReviewer: agent, qualityReviewer: agent, assistant: agent, projectAnalyst: agent },
    { opencode: agent },
  );
  const stores = data
    ? openDataStores(data)
    : {
        eventStore: new EventStore(persist ? join(dir, "events.sqlite") : ":memory:"),
        checkpointer: persist ? createSqliteCheckpointer(join(dir, "checkpoints.sqlite")) : createMemoryCheckpointer(),
        coreStore: new CoreStore(persist ? join(dir, "core.sqlite") : ":memory:"),
        knowledge: new KnowledgeStore(":memory:"),
        contextStore: undefined,
      };
  const { eventStore } = stores;
  const core = new SaikiCore({
    router,
    graphOptions: { checkpointer: stores.checkpointer },
    coreStore: stores.coreStore,
    knowledge: stores.knowledge,
    moderator: new BasicModerator(),
    eventBus: new EventBus(),
    eventStore,
    dataDir: data ? data.dir : join(dir, ".saiki"),
    contextStore: withoutContext ? undefined : stores.contextStore,
    contextScan,
    contextRefreshMs,
    sandboxDir,
  });
  const handle = createApiServer({ core, humanActor: "said", port: 0, eventStore });
  await handle.ready;
  const api = async (method: string, path: string, body?: unknown) => {
    const { port } = handle.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return {
    core,
    handle,
    api,
    stop: async () => {
      await handle.close();
      core.close();
      if (withoutContext) stores.contextStore?.close();
    },
  };
}
