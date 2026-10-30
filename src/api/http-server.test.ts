import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";
import { openDevSession } from "../projects/test-repos.js";

// ── Dobles deterministas (sin CLIs reales) ───────────────────────────────────

function huJson() {
  return JSON.stringify({
    summary: "Util suma", need: "sumar",
    tasks: [{ order: 1, description: "crear util" }],
    acceptanceCriteria: [{ id: "AC1", description: "suma ok" }],
    assumptions: [], openQuestions: [], dependencies: [],
  });
}
function techJson() {
  return JSON.stringify({
    summary: "a", currentFlow: "f",
    affectedFiles: [{ path: "src/util.ts", responsibility: "r" }],
    proposedChanges: [{ path: "src/gen.ts", change: "crear" }],
    traceability: [], dependencies: [], risks: [], openQuestions: [],
  });
}
function devJson(v: number) {
  return JSON.stringify({
    summary: `Impl v${v}`, technicalDecisions: ["pura"],
    changes: [{ path: "src/gen.ts", operation: "create", content: `export const sum=(a:number,b:number)=>a+b;//v${v}` }],
    traceability: [{ ref: "AC1", note: "impl" }], risks: [], dependencies: [], openQuestions: [],
    coveredCriteria: ["AC1"], uncoveredCriteria: [],
  });
}
function reviewJson(kind: "functional" | "quality") {
  if (kind === "functional") {
    return JSON.stringify({ decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"], unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok" });
  }
  return JSON.stringify({ decision: "approved", categories: [{ category: "clean-code", assessment: "ok" }], findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok" });
}

class FullMock implements AgentAdapter {
  readonly name = "full-mock";
  devCalls = 0;
  async run(r: AgentRequest): Promise<AgentResult> {
    switch (r.role) {
      case "huAnalyst": return { status: "success", role: r.role, output: huJson() };
      case "technicalAnalyst": return { status: "success", role: r.role, output: techJson() };
      case "develop": this.devCalls += 1; return { status: "success", role: r.role, output: devJson(this.devCalls) };
      case "functionalReviewer": return { status: "success", role: r.role, output: reviewJson("functional") };
      case "qualityReviewer": return { status: "success", role: r.role, output: reviewJson("quality") };
      case "assistant": return { status: "success", role: r.role, output: "Investigación: A vs B. Fuente: docs." };
      default: return new MockAgentAdapter().run(r);
    }
  }
}

let dir: string;
let root: string;
let handle: ApiServerHandle;
let core: SaikiCore;

function newCore(checkpointerPath?: string, corePath?: string) {
  const mock = new FullMock();
  const router = new MapAgentRouter(
    { analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock, functionalReviewer: mock, qualityReviewer: mock, assistant: mock },
    { opencode: mock },
  );
  return new SaikiCore({
    router,
    graphOptions: {
      checkpointer: checkpointerPath ? createSqliteCheckpointer(checkpointerPath) : createMemoryCheckpointer(),
      rootDir: root,
      applyDir: root,
    },
    coreStore: new CoreStore(corePath ?? ":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new BasicModerator(),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "saiki-api-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
  core = newCore();
  handle = createApiServer({ core, humanActor: "said", port: 0 });
  await handle.ready;
});
afterEach(async () => {
  await handle.close();
  core.close();
  rmSync(dir, { recursive: true, force: true });
});

function baseUrl(): string {
  const addr = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
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

function fp(d: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) for (const [k, v] of fp(f)) r.set(k, v);
    else { const s = statSync(f); r.set(f, `${s.size}:${s.mtimeMs}`); }
  }
  return r;
}

/** Crea sesión, envía "implementa..." y devuelve el threadId de la ejecución. */
async function startDevelopment(sessionId = "s1"): Promise<string> {
  await api("POST", "/sessions", { sessionId });
  await openDevSession(core, root, sessionId);
  const r = await api("POST", `/sessions/${sessionId}/messages`, { message: "implementa un util de suma" });
  const result = r.json.result as { developmentThreadId?: string };
  return result.developmentThreadId!;
}

describe("Fase 19: API REST local", () => {
  it("1. el servidor inicia y escucha en localhost", async () => {
    const addr = handle.server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    const r = await api("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it("2. puede crearse una sesión por HTTP", async () => {
    const r = await api("POST", "/sessions", { sessionId: "sess-a" });
    expect(r.status).toBe(201);
    expect(r.json.sessionId).toBe("sess-a");
  });

  it("3+4. enviar un mensaje de consulta devuelve respuesta (conversación)", async () => {
    await api("POST", "/sessions", { sessionId: "sess-b" });
    const r = await api("POST", "/sessions/sess-b/messages", { message: "¿cómo estás?" });
    expect(r.status).toBe(200);
    const result = r.json.result as { category: string; reply?: string };
    expect(result.category).toBe("conversation");
    expect(result.reply).toBeTruthy();
  });

  it("5. una investigación permite consultar su estado y resultado", async () => {
    await api("POST", "/sessions", { sessionId: "sess-c" });
    const r = await api("POST", "/sessions/sess-c/messages", { message: "investiga opciones de colas" });
    const result = r.json.result as { category: string; task?: { status: string } };
    expect(result.category).toBe("assistance");
    expect(result.task?.status).toBe("succeeded");
    // Consultable en la sesión.
    const s = await api("GET", "/sessions/sess-c");
    expect((s.json.tasks as unknown[]).length).toBe(1);
  });

  it("6. una solicitud de desarrollo expone su ExecutionView normalizada", async () => {
    const threadId = await startDevelopment("sess-d");
    const r = await api("GET", `/executions/${threadId}`);
    expect(r.status).toBe(200);
    const view = r.json.execution as { executionId: string; stages: unknown[]; phase: string; category: string };
    expect(view.executionId).toBe(threadId);
    expect(view.category).toBe("development");
    expect(view.stages.length).toBe(9); // vista normalizada, no HuState crudo
    // La vista NO expone el estado interno (no hay 'devProposal' crudo, etc.).
    expect((view as Record<string, unknown>).devProposal).toBeUndefined();
  });

  it("7. una aprobación pendiente puede consultarse", async () => {
    const threadId = await startDevelopment("sess-e");
    // Aprobar la HU para que avance hasta la aprobación final de la propuesta.
    const hu = await api("GET", `/executions/${threadId}/approval`);
    expect((hu.json.pendingApproval as { required: boolean }).required).toBe(true);
  });

  it("8+12. una aprobación válida reanuda el grafo y registra la identidad", async () => {
    const threadId = await startDevelopment("sess-f");
    // 1ª aprobación: la HU. Necesitamos el hash sólo para la propuesta final.
    // Avanzamos aprobando la HU (kind hu_review no exige hash de propuesta).
    const huApproval = await api("GET", `/executions/${threadId}/approval`);
    const huKind = (huApproval.json.pendingApproval as { kind?: string }).kind;
    if (huKind === "hu_review") {
      // La HU se aprueba vía submitApproval directo del grafo; usamos el endpoint
      // de aprobación igualmente, pero sin hash la resolución exige propuesta.
      // En su lugar, usamos el método del core directo para la HU (no es la
      // aprobación de propuesta, que es la que protege el hash).
      await core.submitApproval(threadId, "approve");
    }
    // Ahora debe estar en la aprobación FINAL de la propuesta (con hash).
    const approval = await api("GET", `/executions/${threadId}/approval`);
    const proposal = approval.json.proposal as { proposalHash: string } | null;
    expect(proposal).not.toBeNull();
    const r = await api("POST", `/executions/${threadId}/approval`, { decision: "approve", proposalHash: proposal!.proposalHash });
    expect(r.status).toBe(200);
    const resolution = r.json.resolution as { ok: boolean; actor: string; phase: string };
    expect(resolution.ok).toBe(true);
    expect(resolution.actor).toBe("said"); // identidad del servidor, no del body
    expect(resolution.phase).toBe("applied");
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(true);
  });

  it("9. un hash incorrecto es rechazado (409)", async () => {
    const threadId = await startDevelopment("sess-g");
    await core.submitApproval(threadId, "approve"); // aprueba HU
    const r = await api("POST", `/executions/${threadId}/approval`, { decision: "approve", proposalHash: "hash-que-no-coincide" });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("hash_mismatch");
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(false); // no se aplicó
  });

  it("10. dos aprobaciones simultáneas de la misma ejecución no se procesan dos veces", async () => {
    const threadId = await startDevelopment("sess-h");
    await core.submitApproval(threadId, "approve"); // aprueba HU
    const approval = await api("GET", `/executions/${threadId}/approval`);
    const hash = (approval.json.proposal as { proposalHash: string }).proposalHash;
    // Disparar dos aprobaciones en paralelo con el mismo hash.
    const [a, b] = await Promise.all([
      api("POST", `/executions/${threadId}/approval`, { decision: "approve", proposalHash: hash }),
      api("POST", `/executions/${threadId}/approval`, { decision: "approve", proposalHash: hash }),
    ]);
    // Una tiene éxito (200); la otra NO puede re-aplicar: el estado ya avanzó, la
    // segunda ve que no hay aprobación pendiente con ese hash → 409.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("11. dos ejecuciones distintas avanzan independientemente", async () => {
    const t1 = await startDevelopment("sess-i");
    const t2 = await startDevelopment("sess-j");
    expect(t1).not.toBe(t2);
    const e1 = await api("GET", `/executions/${t1}`);
    const e2 = await api("GET", `/executions/${t2}`);
    expect((e1.json.execution as { executionId: string }).executionId).toBe(t1);
    expect((e2.json.execution as { executionId: string }).executionId).toBe(t2);
  });

  it("13. errores: ruta inexistente 404, body inválido 400", async () => {
    const r404 = await api("GET", "/no-existe");
    expect(r404.status).toBe(404);
    const rNoMsg = await api("POST", "/sessions/x/messages", {});
    expect(rNoMsg.status).toBe(400);
    const rExec = await api("GET", "/executions/inexistente");
    expect(rExec.status).toBe(404);
  });

  it("14. reiniciar el servidor NO destruye las ejecuciones persistidas", async () => {
    const cpPath = join(dir, "cp.sqlite");
    const corePath = join(dir, "core.sqlite");
    // Core persistente + su propio servidor.
    await handle.close();
    core.close();
    core = newCore(cpPath, corePath);
    handle = createApiServer({ core, humanActor: "said", port: 0 });
    await handle.ready;
    const threadId = await startDevelopment("sess-k");

    // "Reinicio": nuevo core + servidor, mismos archivos SQLite.
    await handle.close();
    core.close();
    core = newCore(cpPath, corePath);
    handle = createApiServer({ core, humanActor: "said", port: 0 });
    await handle.ready;
    const r = await api("GET", `/executions/${threadId}`);
    expect(r.status).toBe(200);
    expect((r.json.execution as { executionId: string }).executionId).toBe(threadId);
  });

  it("15. ningún endpoint salta el Safe Applier ni las aprobaciones", async () => {
    await openDevSession(core, root, "sess-l"); // crea .git antes de tomar la huella
    const before = fp(root);
    const threadId = await startDevelopment("sess-l");
    // Sin aprobar, el repo sigue intacto: no hay ruta HTTP que escriba el repo.
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
    // No existe endpoint para aplicar directamente.
    const r = await api("POST", `/executions/${threadId}/apply`, {});
    expect(r.status).toBe(404);
  });
});
