import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServerHandle } from "./http-server.js";
import { SaikiCore } from "../core/saiki-core.js";
import { CoreStore } from "../core/core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createMemoryCheckpointer, createSqliteCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";
import { openDevSession } from "../projects/test-repos.js";

/**
 * Mini-fase de estabilización (hallazgos 0, 13, 14 y 15). Grafo, API, SSE y
 * SQLite reales; solo los agentes son dobles deterministas. Las decisiones se
 * toman por HTTP con el hash que entrega la API.
 */

// ── Dobles deterministas de agentes ──────────────────────────────────────────

const huJson = (n: number) =>
  JSON.stringify({
    summary: `HU ${n}`, need: "sumar",
    tasks: [{ order: 1, description: "crear util" }],
    acceptanceCriteria: [{ id: "AC1", description: "suma ok" }],
    assumptions: [], openQuestions: [], dependencies: [],
  });
const techJson = (openQuestions: string[]) =>
  JSON.stringify({
    summary: "a", currentFlow: "f",
    affectedFiles: [{ path: "src/util.ts", responsibility: "r" }],
    proposedChanges: [{ path: "src/gen.ts", change: "crear" }],
    traceability: [], dependencies: [], risks: [], openQuestions,
  });
const devJson = (v: number) =>
  JSON.stringify({
    summary: `Impl v${v}`, technicalDecisions: ["pura"],
    changes: [{ path: "src/gen.ts", operation: "create", content: `export const v=${v};` }],
    traceability: [{ ref: "AC1", note: "impl" }], risks: [`riesgo v${v}`], dependencies: [], openQuestions: [],
    coveredCriteria: ["AC1"], uncoveredCriteria: [],
  });
const reviewJson = (kind: "functional" | "quality", approved: boolean) =>
  kind === "functional"
    ? JSON.stringify({ decision: approved ? "approved" : "rejected", evaluatedCriteria: ["AC1"], metCriteria: approved ? ["AC1"] : [], unmetCriteria: approved ? [] : ["AC1"], findings: [], requiredChanges: approved ? [] : ["arreglar"], openQuestions: [], summary: approved ? "ok" : "falta" })
    : JSON.stringify({ decision: approved ? "approved" : "rejected", categories: [{ category: "clean-code", assessment: "ok" }], findings: [], requiredChanges: approved ? [] : ["arreglar"], acceptedRisks: [], summary: approved ? "ok" : "falta" });

class FlowMock implements AgentAdapter {
  readonly name = "flow-mock";
  huCalls = 0;
  devCalls = 0;
  functionalCalls = 0;
  private readonly holds = new Map<string, { started: () => void; release: Promise<void> }>();
  /** Si >0, la revisión funcional rechaza las N primeras propuestas (ciclo de corrección). */
  constructor(private readonly opts: { openQuestions?: string[]; functionalRejects?: number; failTech?: boolean } = {}) {}

  /**
   * Retiene la PRÓXIMA llamada al rol hasta `release()`: permite consultar la API
   * mientras el agente "trabaja" (ejecución realmente en curso), sin timers.
   */
  hold(role: string): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    this.holds.set(role, { started, release: new Promise<void>((r) => (release = r)) });
    return { started: startedP, release };
  }

  async run(r: AgentRequest): Promise<AgentResult> {
    const h = this.holds.get(r.role);
    if (h) {
      this.holds.delete(r.role);
      h.started();
      await h.release;
    }
    switch (r.role) {
      case "huAnalyst": this.huCalls += 1; return { status: "success", role: r.role, output: huJson(this.huCalls) };
      case "technicalAnalyst":
        if (this.opts.failTech) return { status: "failure", role: r.role, output: "", error: "kiro caído" };
        return { status: "success", role: r.role, output: techJson(this.opts.openQuestions ?? []) };
      case "develop": this.devCalls += 1; return { status: "success", role: r.role, output: devJson(this.devCalls) };
      case "functionalReviewer":
        this.functionalCalls += 1;
        return { status: "success", role: r.role, output: reviewJson("functional", this.functionalCalls > (this.opts.functionalRejects ?? 0)) };
      case "qualityReviewer": return { status: "success", role: r.role, output: reviewJson("quality", true) };
      default: return new MockAgentAdapter().run(r);
    }
  }
}

// ── Entorno ──────────────────────────────────────────────────────────────────

let dir: string;
let root: string;
let handle: ApiServerHandle;
let core: SaikiCore;
let mock: FlowMock;
let eventStore: EventStore | undefined;

function newCore(agent: FlowMock, persist: boolean, withEvents: boolean) {
  const router = new MapAgentRouter(
    { analyze: agent, develop: agent, review: agent, huAnalyst: agent, technicalAnalyst: agent, functionalReviewer: agent, qualityReviewer: agent, assistant: agent },
    { opencode: agent },
  );
  eventStore = withEvents ? new EventStore(persist ? join(dir, "events.sqlite") : ":memory:") : undefined;
  return new SaikiCore({
    router,
    graphOptions: {
      checkpointer: persist ? createSqliteCheckpointer(join(dir, "checkpoints.sqlite")) : createMemoryCheckpointer(),
      rootDir: root,
      applyDir: root,
    },
    coreStore: new CoreStore(persist ? join(dir, "core.sqlite") : ":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new BasicModerator(),
    eventBus: withEvents ? new EventBus() : undefined,
    eventStore,
  });
}

async function startServer(agent: FlowMock, opts: { persist?: boolean; events?: boolean; heartbeatMs?: number } = {}) {
  mock = agent;
  core = newCore(agent, opts.persist ?? false, opts.events ?? false);
  handle = createApiServer({ core, humanActor: "said", port: 0, eventStore, heartbeatMs: opts.heartbeatMs });
  await handle.ready;
}

async function stopServer() {
  await handle.close();
  core.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-stab-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
});
afterEach(async () => {
  await stopServer().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

function baseUrl(): string {
  return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, unknown> };
}

type View = Record<string, unknown> & {
  phase: string;
  request: string;
  sessionId: string;
  pendingApproval: { required: boolean; kind?: string; decisionHash?: string; proposalHash?: string };
  stages: Array<{ id: string; status: string; detail?: string }>;
};
async function send(sessionId: string, message: string): Promise<string> {
  await openDevSession(core, root, sessionId);
  const r = await api("POST", `/sessions/${sessionId}/messages`, { message });
  return (r.json.result as { developmentThreadId: string }).developmentThreadId;
}
async function view(t: string): Promise<View> {
  return (await api("GET", `/executions/${t}`)).json.execution as View;
}
async function decideGate(t: string, kind: string, decision: string, feedback?: string) {
  const hash = (await view(t)).pendingApproval.decisionHash;
  return api("POST", `/executions/${t}/approval/${kind}`, { decision, decisionHash: hash, feedback });
}
async function decideFinal(t: string, decision: string, feedback?: string) {
  const hash = (await view(t)).pendingApproval.proposalHash;
  return api("POST", `/executions/${t}/approval`, { decision, proposalHash: hash, feedback });
}

// ── Bloque 0: una ejecución por solicitud ────────────────────────────────────

describe("Bloque 0: cada solicitud de desarrollo es una ejecución independiente", () => {
  it("con una ejecución pausada, un nuevo mensaje crea otra y no toca la anterior", async () => {
    await startServer(new FlowMock());
    const t1 = await send("s1", "implementa un util de suma");
    const before = await view(t1);
    expect(before.pendingApproval.kind).toBe("hu_review");

    const t2 = await send("s1", "implementa un util de resta");
    expect(t2).not.toBe(t1);

    const after = await view(t1);
    expect(after.phase).toBe(before.phase);
    expect(after.request).toBe("implementa un util de suma");
    expect(after.stages[0].detail).toBe("HU 1");
    expect(after.pendingApproval.decisionHash).toBe(before.pendingApproval.decisionHash);

    const v2 = await view(t2);
    expect(v2.request).toBe("implementa un util de resta");
    expect(v2.stages[0].detail).toBe("HU 2");

    const s = (await api("GET", "/sessions/s1")).json.session as { developmentThreadId: string; developmentThreadIds: string[] };
    expect(s.developmentThreadIds).toEqual([t1, t2]);
    expect(s.developmentThreadId).toBe(t2);
    expect(after.sessionId).toBe("s1");
    expect(v2.sessionId).toBe("s1");

    // La pausada sigue resolviéndose con su propio hash.
    expect((await decideGate(t1, "hu_review", "approve")).status).toBe(200);
  });

  it("una ejecución terminada es definitiva: un mensaje posterior no la reactiva", async () => {
    await startServer(new FlowMock());
    const t1 = await send("s2", "implementa un util de suma");
    expect((await decideGate(t1, "hu_review", "reject")).status).toBe(200);
    const done = await view(t1);
    expect(done.phase).toBe("rejected");

    const t2 = await send("s2", "implementa otra cosa");
    expect(t2).not.toBe(t1);
    const still = await view(t1);
    expect(still.phase).toBe("rejected");
    expect(still.stages[0].detail).toBe("HU 1");
    expect(still.request).toBe("implementa un util de suma");
    expect(mock.huCalls).toBe(2); // una HU por ejecución; la terminada no regeneró nada
  });

  it("dos mensajes simultáneos en la misma sesión conservan ambas ejecuciones", async () => {
    await startServer(new FlowMock());
    const [a, b] = await Promise.all([send("s3", "implementa A"), send("s3", "implementa B")]);
    expect(a).not.toBe(b);
    const s = (await api("GET", "/sessions/s3")).json.session as { developmentThreadIds: string[] };
    expect([...s.developmentThreadIds].sort()).toEqual([a, b].sort());
  });

  it("compatibilidad: una sesión antigua (solo developmentThreadId) sigue resolviendo su ejecución", async () => {
    await startServer(new FlowMock());
    const t1 = await send("s4", "implementa un util de suma");
    // Simula el formato anterior: sin developmentThreadIds.
    const store = (core as unknown as { store: CoreStore }).store;
    const legacy = store.getSession("s4")!;
    store.saveSession({ ...legacy, developmentThreadIds: undefined });
    expect((await view(t1)).sessionId).toBe("s4");
    const t2 = await send("s4", "implementa otra");
    const s = (await api("GET", "/sessions/s4")).json.session as { developmentThreadIds: string[] };
    expect(s.developmentThreadIds).toEqual([t1, t2]);
  });
});

// ── Bloque 13: estado fiel (ciclo de vida) ───────────────────────────────────

type Lv = View & {
  lifecycle: string;
  activity: { active: boolean; since?: string; trigger?: string };
  activeStage: string;
  awaitingDecision: { kind: string; stageId?: string; afterStageId?: string } | null;
  status: string;
};
const lv = (t: string) => view(t) as Promise<Lv>;
const eventTypes = (t: string) => (eventStore?.getSince(t, 0) ?? []).map((e) => e.type);

describe("Bloque 13: el estado expone el ciclo de vida real", () => {
  it("activa: mientras el grafo trabaja es running (etapa, disparador) y no admite decisiones", async () => {
    await startServer(new FlowMock());
    const t = await send("a1", "implementa un util de suma");
    const huHash = (await view(t)).pendingApproval.decisionHash;
    const tech = mock.hold("technicalAnalyst");
    const approving = decideGate(t, "hu_review", "approve");
    await tech.started;

    const v = await lv(t);
    expect(v.lifecycle).toBe("running");
    expect(v.activity).toMatchObject({ active: true, trigger: "decision" });
    expect(typeof v.activity.since).toBe("string");
    expect(v.activeStage).toBe("technical_analysis");
    expect(v.status).toMatch(/^en curso: Análisis técnico/);
    expect(v.status).not.toMatch(/esperando/);
    expect(v.pendingApproval.required).toBe(false);
    expect(v.awaitingDecision).toBeNull();
    // Mientras trabaja, ninguna decisión se acepta (ni repetida ni de otra puerta).
    const dup = await api("POST", `/executions/${t}/approval/hu_review`, { decision: "approve", decisionHash: huHash });
    expect(dup.status).toBe(409);

    tech.release();
    expect((await approving).status).toBe(200);
    const after = await lv(t);
    expect(after.activity.active).toBe(false);
    expect(after.activeStage).toBe("none");
  });

  it("esperando decisión: lifecycle awaiting_decision con su posición en el pipeline", async () => {
    await startServer(new FlowMock({ openQuestions: ["¿decimales?"] }));
    const t = await send("a2", "implementa un util de suma");
    let v = await lv(t);
    expect(v.lifecycle).toBe("awaiting_decision");
    expect(v.awaitingDecision).toEqual({ kind: "hu_review", afterStageId: "hu_analysis" });
    expect(v.status).toBe("esperando decisión humana: revisión de la HU (pending_review)");
    expect(v.activeStage).toBe("none");

    await decideGate(t, "hu_review", "approve");
    v = await lv(t);
    expect(v.awaitingDecision).toEqual({ kind: "feasibility_partial", afterStageId: "feasibility" });

    await decideGate(t, "feasibility_partial", "approve");
    v = await lv(t);
    expect(v.lifecycle).toBe("awaiting_decision");
    expect(v.awaitingDecision).toEqual({ kind: "final_approval", stageId: "final_approval" });
    expect(v.activeStage).toBe("none"); // final_approval sigue en "running" (compatibilidad) pero no es actividad
  });

  it("completada: lifecycle completed y evento execution.completed", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("a3", "implementa un util de suma");
    await decideGate(t, "hu_review", "approve");
    expect((await decideFinal(t, "approve")).status).toBe(200);
    const v = await lv(t);
    expect(v.lifecycle).toBe("completed");
    expect(v.status).toBe("terminada (applied)");
    expect(eventTypes(t)).toContain("execution.completed");
  });

  it("fallida: un fallo técnico es lifecycle failed y evento execution.failed", async () => {
    await startServer(new FlowMock({ failTech: true }), { events: true });
    const t = await send("a4", "implementa un util de suma");
    await decideGate(t, "hu_review", "approve");
    const v = await lv(t);
    expect(v.phase).toBe("tech_failed");
    expect(v.lifecycle).toBe("failed");
    expect(v.status).toBe("fallida (tech_failed)");
    expect(v.stages.find((s) => s.id === "technical_analysis")?.status).toBe("failed");
    expect(eventTypes(t)).toContain("execution.failed");
  });

  it("detenida: un rechazo humano es lifecycle stopped y evento execution.stopped (no failed)", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("a5", "implementa un util de suma");
    await decideGate(t, "hu_review", "reject");
    const v = await lv(t);
    expect(v.lifecycle).toBe("stopped");
    expect(v.status).toBe("detenida (rejected)");
    expect(eventTypes(t)).toContain("execution.stopped");
    expect(eventTypes(t)).not.toContain("execution.failed");
  });

  it("revisiones agotadas: la revisión rechazada queda failed, no running", async () => {
    await startServer(new FlowMock({ functionalRejects: 99 }));
    const t = await send("a6", "implementa un util de suma");
    await decideGate(t, "hu_review", "approve");
    const v = await lv(t);
    expect(v.phase).toBe("reviews_exhausted");
    expect(v.lifecycle).toBe("stopped");
    expect(v.stages.find((s) => s.id === "functional_review")?.status).toBe("failed");
    expect(v.stages.some((s) => s.status === "running")).toBe(false);
  });

  it("ciclo de corrección: al terminar, desarrollo y revisiones reflejan la versión vigente", async () => {
    await startServer(new FlowMock({ functionalRejects: 1 }));
    const t = await send("a7", "implementa un util de suma");
    const dev = mock.hold("develop");
    const approving = decideGate(t, "hu_review", "approve");
    await dev.started; // primera propuesta
    dev.release();
    await approving;
    const v = await lv(t);
    expect(mock.devCalls).toBe(2);
    expect(v.awaitingDecision?.kind).toBe("final_approval");
    expect(v.stages.filter((s) => ["development", "functional_review", "quality_review"].includes(s.id)).map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("al regenerar la HU (pedir cambios) la etapa vuelve a estar en curso", async () => {
    await startServer(new FlowMock());
    const t = await send("a8", "implementa un util de suma");
    const hu = mock.hold("huAnalyst");
    const revising = decideGate(t, "hu_review", "request_changes", "más detalle");
    await hu.started;
    const v = await lv(t);
    expect(v.lifecycle).toBe("running");
    expect(v.activeStage).toBe("hu_analysis");
    expect(v.stages[0].status).toBe("running");
    hu.release();
    await revising;
    expect((await lv(t)).awaitingDecision?.kind).toBe("hu_review");
  });

  it("interrumpida: tras reiniciar con trabajo a medias no se finge actividad ni espera", async () => {
    await startServer(new FlowMock(), { persist: true });
    const t = await send("a9", "implementa un util de suma");
    const tech = mock.hold("technicalAnalyst");
    const oldCore = core;
    const oldHandle = handle;
    const approving = decideGate(t, "hu_review", "approve");
    await tech.started;
    // "Reinicio": un proceso nuevo sobre los mismos SQLite, con el anterior a mitad.
    await startServer(new FlowMock(), { persist: true });
    const v = await lv(t);
    expect(v.lifecycle).toBe("interrupted");
    expect(v.activity.active).toBe(false);
    expect(v.pendingApproval.required).toBe(false);
    expect(v.status).toMatch(/^interrumpida/);
    // Limpieza del proceso "anterior".
    tech.release();
    await approving;
    await oldHandle.close();
    oldCore.close();
  });
});

// ── Bloque 14: cierre, fin de stream y reinicios ─────────────────────────────

interface Frame { event: string; id?: string; data: Record<string, unknown> }

/** Lee un stream SSE real hasta `until(frames)` o hasta que el servidor lo cierra. */
async function readSse(path: string, until: (f: Frame[]) => boolean, headers: Record<string, string> = {}, timeoutMs = 5_000) {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl()}${path}`, { headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  let closedByServer = false;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { closedByServer = true; break; }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Partial<Frame> = {};
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("id: ")) f.id = line.slice(4);
          else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
        }
        if (f.event) frames.push(f as Frame);
      }
      if (until(frames)) break;
    }
  } catch {
    /* abortado por timeout o por el test */
  } finally {
    clearTimeout(timer);
  }
  return { frames, closedByServer, abort: () => ctrl.abort(), reader };
}
const isControl = (kind: string) => (f: Frame) => f.event === "control" && f.data.kind === kind;

describe("Bloque 14: el servidor cierra bien y los streams terminan cuando corresponde", () => {
  it("apagar con un cliente SSE conectado termina rápido y avisa al cliente", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("c1", "implementa un util de suma");
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl()}/executions/${t}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // stream abierto (": ok" + historial)
    const started = Date.now();
    await handle.close(); // antes: no terminaba nunca con un stream abierto
    expect(Date.now() - started).toBeLessThan(2_000);
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"kind":"shutdown"');
    core.close();
    // afterEach no debe volver a cerrar
    handle = { ...handle, close: async () => undefined };
    core = { close: () => undefined } as unknown as SaikiCore;
  });

  it("una ejecución terminada: historial completo, control end y cierre del stream", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("c2", "implementa un util de suma");
    await decideGate(t, "hu_review", "reject");
    const r = await readSse(`/executions/${t}/events`, () => false);
    expect(r.closedByServer).toBe(true);
    const types = r.frames.map((f) => f.event);
    expect(types).toContain("execution.stopped");
    expect(r.frames.at(-1)).toMatchObject({ event: "control", data: { kind: "end", reason: "terminal" } });
  });

  it("en vivo: tras el evento terminal llega control end y el stream se cierra", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("c3", "implementa un util de suma");
    await decideGate(t, "hu_review", "approve");
    const reading = readSse(`/executions/${t}/events`, (f) => f.some(isControl("end")));
    await new Promise((r) => setTimeout(r, 100));
    expect((await decideFinal(t, "approve")).status).toBe(200);
    const r = await reading;
    const types = r.frames.map((f) => f.event);
    expect(types.indexOf("execution.completed")).toBeGreaterThan(-1);
    expect(types.at(-1)).toBe("control");
  });

  it("una ejecución activa o pausada mantiene el stream abierto (no recibe end)", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("c4", "implementa un util de suma");
    const r = await readSse(`/executions/${t}/events`, () => false, {}, 600);
    expect(r.closedByServer).toBe(false);
    expect(r.frames.some(isControl("end"))).toBe(false);
  });

  it("reconexión con Last-Event-ID: solo llegan los eventos posteriores", async () => {
    await startServer(new FlowMock(), { events: true });
    const t = await send("c5", "implementa un util de suma");
    const first = await readSse(`/executions/${t}/events`, (f) => f.some((x) => x.event === "approval.required"));
    first.abort();
    const lastId = Number(first.frames.filter((f) => f.id).at(-1)!.id);
    await decideGate(t, "hu_review", "approve");
    const second = await readSse(`/executions/${t}/events`, (f) => f.some((x) => x.event === "approval.required"), {
      "last-event-id": String(lastId),
    });
    second.abort();
    const ids = second.frames.filter((f) => f.id).map((f) => Number(f.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id > lastId)).toBe(true);
  });

  it("reinicio del backend: no se re-emiten etapas ni avisos ya publicados", async () => {
    await startServer(new FlowMock({ openQuestions: ["¿decimales?"] }), { persist: true, events: true });
    const t = await send("c6", "implementa un util de suma");
    await stopServer();
    // Proceso nuevo sobre los mismos SQLite: su memoria está vacía.
    await startServer(new FlowMock({ openQuestions: ["¿decimales?"] }), { persist: true, events: true });
    await decideGate(t, "hu_review", "approve"); // → viabilidad parcial
    await stopServer();
    await startServer(new FlowMock({ openQuestions: ["¿decimales?"] }), { persist: true, events: true });
    await decideGate(t, "feasibility_partial", "approve"); // → aprobación final

    const evs = eventStore!.getAll(t);
    const stageEvents = evs.filter((e) => e.type.startsWith("stage."));
    const keys = stageEvents.map((e) => `${e.type}:${(e.data as { stageId: string }).stageId}`);
    expect(new Set(keys).size).toBe(keys.length); // ninguna etapa re-emitida
    expect(keys.filter((k) => k === "stage.completed:hu_analysis")).toHaveLength(1);
    const required = evs.filter((e) => e.type === "approval.required").map((e) => (e.data as { kind: string }).kind);
    expect(required).toEqual(["hu_review", "feasibility_partial", "final_approval"]);
    const seqs = evs.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

// ── Bloque 15: historial inmutable de propuestas y decisiones ────────────────

type Prop = {
  id: string; version: number; proposalHash: string; summary: string; risks: string[];
  filesToCreate: string[]; filesToModify: string[]; filesToDelete: string[]; createdAt: string;
  status: string; applied: boolean; reviews: Array<{ kind: string; decision: string }>;
  decision: null | { decision: string; actor: string; feedback: string | null; resolvedAt: string; phaseAfter: string; source: string; subjectHash: string };
};
const proposals = async (t: string) => ((await api("GET", `/executions/${t}/proposals`)).json.proposals as Prop[]);
const decisions = async (t: string) =>
  ((await api("GET", `/executions/${t}/decisions`)).json.decisions as Array<Record<string, unknown>>);

async function toFinal(sessionId: string): Promise<string> {
  const t = await send(sessionId, "implementa un util de suma");
  await decideGate(t, "hu_review", "approve", "ok la HU");
  return t;
}

describe("Bloque 15: las propuestas y decisiones se pueden consultar siempre", () => {
  it("pendiente: la versión vigente, con hash exacto, archivos y riesgos", async () => {
    await startServer(new FlowMock());
    const t = await toFinal("p1");
    const v = await view(t);
    const [p] = await proposals(t);
    expect(p).toMatchObject({
      id: `${t}:v1`, version: 1, status: "pending", applied: false, decision: null,
      proposalHash: v.pendingApproval.proposalHash, summary: "Impl v1",
      filesToCreate: ["src/gen.ts"], filesToModify: [], filesToDelete: [], risks: ["riesgo v1"],
    });
    expect(Date.parse(p.createdAt)).not.toBeNaN();
    expect(p.reviews.map((r) => `${r.kind}:${r.decision}`)).toEqual(["functional:approved", "quality:approved"]);
    const one = await api("GET", `/executions/${t}/proposals/${p.proposalHash}`);
    expect((one.json.proposal as Prop).id).toBe(p.id);
  });

  it("aprobada: sigue consultable tras aplicar, con decisión, actor y observaciones", async () => {
    await startServer(new FlowMock());
    const t = await toFinal("p2");
    const hash = (await view(t)).pendingApproval.proposalHash;
    expect((await decideFinal(t, "approve", "adelante")).status).toBe(200);
    const [p] = await proposals(t);
    expect(p.status).toBe("approved");
    expect(p.applied).toBe(true);
    expect(p.proposalHash).toBe(hash);
    expect(p.filesToCreate).toEqual(["src/gen.ts"]);
    expect(p.decision).toMatchObject({ decision: "approve", actor: "said", feedback: "adelante", phaseAfter: "applied", source: "recorded", subjectHash: hash });
  });

  it("rechazada: queda registrada con su decisión y no se aplica", async () => {
    await startServer(new FlowMock());
    const t = await toFinal("p3");
    expect((await decideFinal(t, "reject", "no me convence")).status).toBe(200);
    const [p] = await proposals(t);
    expect(p).toMatchObject({ status: "rejected", applied: false });
    expect(p.decision).toMatchObject({ decision: "reject", feedback: "no me convence", phaseAfter: "final_approval_rejected" });
  });

  it("con cambios pedidos: la versión anterior se conserva intacta y la nueva no la sobrescribe", async () => {
    await startServer(new FlowMock());
    const t = await toFinal("p4");
    const h1 = (await view(t)).pendingApproval.proposalHash;
    expect((await decideFinal(t, "request_changes", "añade validación")).status).toBe(200);
    const h2 = (await view(t)).pendingApproval.proposalHash;
    expect(h2).not.toBe(h1);
    const [p1, p2] = await proposals(t);
    expect(p1).toMatchObject({ version: 1, proposalHash: h1, summary: "Impl v1", risks: ["riesgo v1"], status: "changes_requested" });
    expect(p1.decision).toMatchObject({ decision: "request_changes", feedback: "añade validación" });
    expect(p2).toMatchObject({ version: 2, proposalHash: h2, summary: "Impl v2", status: "pending", decision: null });
    // La fecha de resolución es la de la decisión humana, anterior a la versión que la rehízo.
    expect(Date.parse(p1.decision!.resolvedAt)).toBeLessThanOrEqual(Date.parse(p2.createdAt));
  });

  it("rehecha por una revisión automática: la versión rechazada queda en el historial", async () => {
    await startServer(new FlowMock({ functionalRejects: 1 }));
    const t = await toFinal("p5");
    const [p1, p2] = await proposals(t);
    expect(p1.status).toBe("rejected_by_review");
    expect(p1.reviews.map((r) => `${r.kind}:${r.decision}`)).toEqual(["functional:rejected"]);
    expect(p2.status).toBe("pending");
  });

  it("decisiones: incluye HU y viabilidad con su hash exacto y observaciones", async () => {
    await startServer(new FlowMock({ openQuestions: ["¿decimales?"] }));
    const t = await send("p6", "implementa un util de suma");
    const huHash = (await view(t)).pendingApproval.decisionHash;
    await decideGate(t, "hu_review", "approve", "ok la HU");
    const feasHash = (await view(t)).pendingApproval.decisionHash;
    await decideGate(t, "feasibility_partial", "approve", "procede");
    const ds = await decisions(t);
    expect(ds.map((d) => [d.kind, d.subjectHash, d.feedback, d.actor])).toEqual([
      ["hu_review", huHash, "ok la HU", "said"],
      ["feasibility_partial", feasHash, "procede", "said"],
    ]);
  });

  it("inmutable: la base de datos rechaza modificar o borrar el historial", async () => {
    await startServer(new FlowMock());
    const t = await toFinal("p7");
    await decideFinal(t, "approve");
    const store = (core as unknown as { store: CoreStore }).store;
    const db = (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } }).db;
    expect(() => db.prepare("UPDATE proposal_versions SET summary='x'").run()).toThrow(/inmutable/);
    expect(() => db.prepare("DELETE FROM proposal_versions").run()).toThrow(/inmutable/);
    expect(() => db.prepare("UPDATE human_decisions SET decision='reject'").run()).toThrow(/inmutable/);
    // Registrar otra vez el mismo hash con otro contenido no cambia nada.
    const [p] = await proposals(t);
    expect(store.recordProposalVersion({ ...p, executionId: t, summary: "otra cosa" })).toBe(false);
    expect((await proposals(t))[0].summary).toBe("Impl v1");
  });

  it("persistente: tras reiniciar el backend el historial es idéntico", async () => {
    await startServer(new FlowMock(), { persist: true, events: true });
    const t = await toFinal("p8");
    await decideFinal(t, "request_changes", "otra vuelta");
    await decideFinal(t, "approve", "ahora sí");
    const before = { p: await proposals(t), d: await decisions(t) };
    await stopServer();
    await startServer(new FlowMock(), { persist: true, events: true });
    expect(await proposals(t)).toEqual(before.p);
    expect(await decisions(t)).toEqual(before.d);
    expect(before.p.map((p) => p.status)).toEqual(["changes_requested", "approved"]);
  });

  it("ejecuciones anteriores al cambio: se reconstruyen de checkpoints y eventos", async () => {
    await startServer(new FlowMock(), { persist: true, events: true });
    const t = await toFinal("p9");
    const hash = (await view(t)).pendingApproval.proposalHash;
    await decideFinal(t, "approve", "obs");
    await stopServer();
    // Simula una BD del Core sin el historial (como antes de esta mini-fase).
    rmSync(join(dir, "core.sqlite"), { force: true });
    rmSync(join(dir, "core.sqlite-wal"), { force: true });
    rmSync(join(dir, "core.sqlite-shm"), { force: true });
    await startServer(new FlowMock(), { persist: true, events: true });
    const [p] = await proposals(t);
    expect(p).toMatchObject({ proposalHash: hash, summary: "Impl v1", status: "approved", applied: true });
    expect(p.decision).toMatchObject({ decision: "approve", source: "events", feedback: null, actor: "said" });
    const ds = await decisions(t);
    expect(ds.map((d) => d.kind)).toEqual(["hu_review", "final_approval"]);
  });

  it("404: ejecución inexistente o hash desconocido", async () => {
    await startServer(new FlowMock());
    expect((await api("GET", "/executions/dev-nope/proposals")).status).toBe(404);
    expect((await api("GET", "/executions/dev-nope/decisions")).status).toBe(404);
    const t = await toFinal("p10");
    expect((await api("GET", `/executions/${t}/proposals/${"0".repeat(64)}`)).status).toBe(404);
  });
});
