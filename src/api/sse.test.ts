import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServerHandle } from "./http-server.js";
import { SaikiCore } from "../core/saiki-core.js";
import { CoreStore } from "../core/core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";
import { openDevSession } from "../projects/test-repos.js";
import type { SaikiEvent } from "../events/event-types.js";

// Dobles deterministas (mismo patrón que http-server.test.ts).
function huJson() { return JSON.stringify({ summary: "s", need: "n", tasks: [{ order: 1, description: "d" }], acceptanceCriteria: [{ id: "AC1", description: "x" }], assumptions: [], openQuestions: [], dependencies: [] }); }
function techJson() { return JSON.stringify({ summary: "a", currentFlow: "f", affectedFiles: [{ path: "src/util.ts", responsibility: "r" }], proposedChanges: [{ path: "src/gen.ts", change: "c" }], traceability: [], dependencies: [], risks: [], openQuestions: [] }); }
function devJson(v: number) { return JSON.stringify({ summary: `v${v}`, technicalDecisions: ["p"], changes: [{ path: "src/gen.ts", operation: "create", content: `export const s=1;//v${v}` }], traceability: [{ ref: "AC1", note: "i" }], risks: [], dependencies: [], openQuestions: [], coveredCriteria: ["AC1"], uncoveredCriteria: [] }); }
function revJson(k: "functional" | "quality") { return k === "functional" ? JSON.stringify({ decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"], unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok" }) : JSON.stringify({ decision: "approved", categories: [{ category: "c", assessment: "ok" }], findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok" }); }

class FullMock implements AgentAdapter {
  readonly name = "full-mock";
  devCalls = 0;
  async run(r: AgentRequest): Promise<AgentResult> {
    switch (r.role) {
      case "huAnalyst": return { status: "success", role: r.role, output: huJson() };
      case "technicalAnalyst": return { status: "success", role: r.role, output: techJson() };
      case "develop": this.devCalls += 1; return { status: "success", role: r.role, output: devJson(this.devCalls) };
      case "functionalReviewer": return { status: "success", role: r.role, output: revJson("functional") };
      case "qualityReviewer": return { status: "success", role: r.role, output: revJson("quality") };
      case "assistant": return { status: "success", role: r.role, output: "Investigación A vs B." };
      default: return new MockAgentAdapter().run(r);
    }
  }
}

let dir: string;
let root: string;
let core: SaikiCore;
let bus: EventBus;
let store: EventStore;
let handle: ApiServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "saiki-sse-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
  const mock = new FullMock();
  bus = new EventBus();
  store = new EventStore(":memory:");
  core = new SaikiCore({
    router: new MapAgentRouter({ analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock, functionalReviewer: mock, qualityReviewer: mock, assistant: mock }, { opencode: mock }),
    graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
    coreStore: new CoreStore(":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new BasicModerator(),
    eventBus: bus,
    eventStore: store,
  });
  handle = createApiServer({ core, humanActor: "said", port: 0, eventStore: store, heartbeatMs: 50 });
  await handle.ready;
});
afterEach(async () => {
  await handle.close();
  core.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function base(): string {
  const addr = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}
async function post(path: string, body: unknown) {
  const res = await fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function startDevelopment(sessionId: string): Promise<string> {
  await post("/sessions", { sessionId });
  await openDevSession(core, root, sessionId);
  const r = await post(`/sessions/${sessionId}/messages`, { message: "implementa un util de suma" });
  return (r.json.result as { developmentThreadId: string }).developmentThreadId;
}
function typesOf(evts: SaikiEvent[]): string[] {
  return evts.map((e) => e.type);
}

describe("Fase 20: eventos de dominio emitidos por el Core", () => {
  it("1+2+5. desarrollo emite execution.started, stage.completed y approval.required", async () => {
    const threadId = await startDevelopment("s1");
    const evts = store.getAll(threadId);
    const types = typesOf(evts);
    // En la primera pausa (aprobación de la HU) se observa: inicio de ejecución,
    // la etapa HU completada, y la aprobación requerida. No hay stage.started en
    // este punto porque ninguna etapa queda "en curso" (el grafo está pausado):
    // esto es honesto, no inventamos una etapa running.
    expect(types).toContain("execution.started");
    expect(types).toContain("stage.completed");
    expect(types).toContain("approval.required"); // pausa en aprobación de HU
    // La etapa completada es el análisis de HU.
    const huDone = evts.find((e) => e.type === "stage.completed" && (e.data as { stageId: string }).stageId === "hu_analysis");
    expect(huDone).toBeDefined();
    // Eventos ordenados por seq.
    expect(evts.map((e) => e.seq)).toEqual([...evts.map((e) => e.seq)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("2b. al avanzar el flujo aparecen stage.started/completed de etapas posteriores", async () => {
    const threadId = await startDevelopment("s1b");
    await core.submitApproval(threadId, "approve"); // aprueba HU -> corre tech, dev, reviews
    const r = await (await fetch(`${base()}/executions/${threadId}/approval`)).json() as { proposal?: { proposalHash: string } };
    // Tras aprobar la HU, el flujo corre hasta la aprobación final: deben
    // aparecer etapas completadas posteriores (technical_analysis, development…).
    const completed = store.getAll(threadId).filter((e) => e.type === "stage.completed").map((e) => (e.data as { stageId: string }).stageId);
    expect(completed).toContain("technical_analysis");
    expect(completed).toContain("development");
    expect(r.proposal).toBeDefined(); // y hay propuesta pendiente de aprobación
  });

  it("6+4. aprobar emite approval.resolved y execution.completed al aplicar", async () => {
    const threadId = await startDevelopment("s2");
    await core.submitApproval(threadId, "approve"); // HU (directo, no por API)
    // Aprobar la propuesta final vía el método con eventos.
    const approval = await (await fetch(`${base()}/executions/${threadId}/approval`)).json() as { proposal: { proposalHash: string } };
    await post(`/executions/${threadId}/approval`, { decision: "approve", proposalHash: approval.proposal.proposalHash });
    const types = typesOf(store.getAll(threadId));
    expect(types).toContain("approval.resolved");
    expect(types).toContain("execution.completed");
  });

  it("7. una investigación emite assistant.message", async () => {
    await post("/sessions", { sessionId: "s3" });
    await post("/sessions/s3/messages", { message: "investiga opciones de colas" });
    // assistant.message no tiene executionId (es de sesión): se publica por bus.
    // Lo capturamos suscribiéndonos antes de una segunda investigación.
    const got: string[] = [];
    bus.subscribe((e) => got.push(e.type));
    await post("/sessions/s3/messages", { message: "investiga alternativas de cache" });
    expect(got).toContain("assistant.message");
  });

  it("8. una propuesta de conocimiento emite knowledge.proposed", async () => {
    const got: string[] = [];
    bus.subscribe((e) => got.push(e.type));
    core.proposeKnowledge({ id: "k1", title: "t", category: "research", content: "c", origin: "assistant" });
    expect(got).toContain("knowledge.proposed");
  });

  it("12. una ejecución reanudada NO duplica eventos de etapa ya publicados", async () => {
    const threadId = await startDevelopment("s4");
    const countAfterStart = store.getAll(threadId).filter((e) => e.type.startsWith("stage.")).length;
    // Volver a consultar/emitir progreso (como haría una reanudación) no debe
    // re-emitir etapas en el mismo estado.
    await core.submitApproval(threadId, "approve"); // avanza HU -> re-evalúa
    const r = await (await fetch(`${base()}/executions/${threadId}/approval`)).json() as { proposal: { proposalHash: string } };
    await post(`/executions/${threadId}/approval`, { decision: "approve", proposalHash: r.proposal.proposalHash });
    // Las etapas iniciales (hu_analysis done, etc.) no se repiten: cada
    // (stage, status) se emite una sola vez. Verificamos que no hay dos
    // 'stage.completed' idénticos para la misma etapa.
    const completed = store.getAll(threadId).filter((e) => e.type === "stage.completed").map((e) => (e.data as { stageId: string }).stageId);
    expect(new Set(completed).size).toBe(completed.length); // sin duplicados
    expect(countAfterStart).toBeGreaterThan(0);
  });

  it("14. los eventos no exponen secretos ni stderr crudo", async () => {
    const threadId = await startDevelopment("s5");
    const raw = JSON.stringify(store.getAll(threadId));
    // data solo contiene phase/status/stageId/label/detail: sin tokens ni stderr.
    expect(raw).not.toMatch(/sk-|token|password|secret/i);
  });
});

describe("Fase 20: endpoint SSE", () => {
  it("9+11. un cliente SSE recibe eventos y reconecta con Last-Event-ID", async () => {
    const threadId = await startDevelopment("s6");
    // El historial ya está en el store. Conectamos pidiendo desde el inicio.
    const res = await fetch(`${base()}/executions/${threadId}/events`, { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Leer un fragmento del stream (el historial se envía de inmediato).
    const reader = res.body!.getReader();
    const chunk = await readSome(reader, 500);
    expect(chunk).toContain("event: execution.started");
    expect(chunk).toContain("id: ");

    // Extraer el último id recibido y reconectar desde ahí.
    const lastId = lastEventId(chunk);
    expect(lastId).toBeGreaterThan(0);
    await reader.cancel();

    const res2 = await fetch(`${base()}/executions/${threadId}/events`, {
      headers: { accept: "text/event-stream", "last-event-id": String(lastId) },
    });
    const reader2 = res2.body!.getReader();
    const chunk2 = await readSome(reader2, 300);
    // No debe reenviar el execution.started (seq 1), ya visto.
    const ids2 = allEventIds(chunk2);
    expect(ids2.every((id) => id > lastId)).toBe(true);
    await reader2.cancel();
  });

  it("10. una desconexión del cliente SSE no interrumpe la ejecución", async () => {
    const threadId = await startDevelopment("s7");
    const res = await fetch(`${base()}/executions/${threadId}/events`);
    const reader = res.body!.getReader();
    await readSome(reader, 200);
    await reader.cancel(); // desconexión del cliente
    // La ejecución sigue consultable y operable tras la desconexión.
    const r = await fetch(`${base()}/executions/${threadId}`);
    expect(r.status).toBe(200);
    // Y aún podemos avanzar la aprobación (el proceso no murió).
    await core.submitApproval(threadId, "approve");
    const approval = await (await fetch(`${base()}/executions/${threadId}/approval`)).json() as { proposal: { proposalHash: string } };
    const ok = await post(`/executions/${threadId}/approval`, { decision: "approve", proposalHash: approval.proposal.proposalHash });
    expect((ok.json.resolution as { ok: boolean }).ok).toBe(true);
  });

  it("SSE sobre ejecución inexistente -> 404", async () => {
    const res = await fetch(`${base()}/executions/no-existe/events`);
    expect(res.status).toBe(404);
  });
});

// ── Helpers de lectura de stream SSE ──────────────────────────────────────────

async function readSome(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(10, deadline - Date.now()))),
    ]);
    if (race === null) break;
    if (race.done) break;
    text += decoder.decode(race.value, { stream: true });
    if (text.includes("\n\n")) {
      // Ya hay al menos un bloque completo; seguimos un poco más por si hay más.
      if (Date.now() + 40 < deadline) continue;
      break;
    }
  }
  return text;
}
function allEventIds(sse: string): number[] {
  const ids: number[] = [];
  for (const line of sse.split("\n")) {
    const m = line.match(/^id:\s*(\d+)/);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}
function lastEventId(sse: string): number {
  const ids = allEventIds(sse);
  return ids.length ? ids[ids.length - 1] : 0;
}
