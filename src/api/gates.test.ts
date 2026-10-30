import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

/**
 * Fase 21 (backend): resolución HTTP de `hu_review` y `feasibility_partial`.
 *
 * Todo el flujo se conduce SOLO por HTTP contra el grafo real. Los agentes son
 * dobles deterministas (sin CLIs); las aprobaciones NO se simulan: las decide
 * cada test vía la API, con el hash que la propia API entrega.
 */

// ── Dobles deterministas de agentes ──────────────────────────────────────────

function huJson() {
  return JSON.stringify({
    summary: "Util suma", need: "sumar",
    tasks: [{ order: 1, description: "crear util" }],
    acceptanceCriteria: [{ id: "AC1", description: "suma ok" }],
    assumptions: [], openQuestions: [], dependencies: [],
  });
}
/** Con preguntas abiertas, la clasificación es `partially_ready`. */
function techJson(openQuestions: string[]) {
  return JSON.stringify({
    summary: "a", currentFlow: "f",
    affectedFiles: [{ path: "src/util.ts", responsibility: "r" }],
    proposedChanges: [{ path: "src/gen.ts", change: "crear" }],
    traceability: [], dependencies: [], risks: [], openQuestions,
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

class FlowMock implements AgentAdapter {
  readonly name = "flow-mock";
  huCalls = 0;
  devCalls = 0;
  lastHuPrompt = "";
  constructor(private readonly openQuestions: string[] = []) {}
  async run(r: AgentRequest): Promise<AgentResult> {
    switch (r.role) {
      case "huAnalyst":
        this.huCalls += 1;
        this.lastHuPrompt = r.input;
        return { status: "success", role: r.role, output: huJson() };
      case "technicalAnalyst": return { status: "success", role: r.role, output: techJson(this.openQuestions) };
      case "develop": this.devCalls += 1; return { status: "success", role: r.role, output: devJson(this.devCalls) };
      case "functionalReviewer": return { status: "success", role: r.role, output: reviewJson("functional") };
      case "qualityReviewer": return { status: "success", role: r.role, output: reviewJson("quality") };
      default: return new MockAgentAdapter().run(r);
    }
  }
}

let dir: string;
let root: string;
let handle: ApiServerHandle;
let core: SaikiCore;
let mock: FlowMock;

function newCore(agent: FlowMock, persist = false) {
  const router = new MapAgentRouter(
    { analyze: agent, develop: agent, review: agent, huAnalyst: agent, technicalAnalyst: agent, functionalReviewer: agent, qualityReviewer: agent, assistant: agent },
    { opencode: agent },
  );
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
  });
}

async function startServer(agent: FlowMock, persist = false) {
  mock = agent;
  core = newCore(agent, persist);
  handle = createApiServer({ core, humanActor: "said", port: 0 });
  await handle.ready;
}

async function stopServer() {
  await handle.close();
  core.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-gates-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
});
afterEach(async () => {
  await stopServer();
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

type Pending = { required: boolean; kind?: string; decisionHash?: string; proposalHash?: string };

async function startDevelopment(sessionId = "s1"): Promise<string> {
  await api("POST", "/sessions", { sessionId });
  await openDevSession(core, root, sessionId);
  const r = await api("POST", `/sessions/${sessionId}/messages`, { message: "implementa un util de suma" });
  return (r.json.result as { developmentThreadId: string }).developmentThreadId;
}
async function pending(threadId: string) {
  const r = await api("GET", `/executions/${threadId}/approval`);
  return r.json as { pendingApproval: Pending; proposal: { proposalHash: string } | null; gate: Record<string, unknown> | null };
}
async function phase(threadId: string): Promise<string> {
  const r = await api("GET", `/executions/${threadId}`);
  return (r.json.execution as { phase: string }).phase;
}
async function decide(threadId: string, kind: string, body: Record<string, unknown>) {
  return api("POST", `/executions/${threadId}/approval/${kind}`, body);
}

describe("Fase 21: revisión de HU por HTTP", () => {
  it("expone la puerta hu_review con su hash y la HU a revisar", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const p = await pending(t);
    expect(p.pendingApproval).toMatchObject({ required: true, kind: "hu_review" });
    expect(p.pendingApproval.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.proposal).toBeNull();
    expect(p.gate).toMatchObject({
      kind: "hu_review",
      decisionHash: p.pendingApproval.decisionHash,
      version: 1,
      revisionsUsed: 0,
      maxRevisions: 2,
      allowedDecisions: ["approve", "reject", "request_changes"],
    });
    expect((p.gate!.hu as { summary: string }).summary).toBe("Util suma");
    // La vista de ejecución también lo trae (contrato aditivo).
    const v = await api("GET", `/executions/${t}`);
    expect((v.json.execution as { pendingApproval: Pending }).pendingApproval.decisionHash).toBe(p.pendingApproval.decisionHash);
  });

  it("flujo completo SOLO por HTTP: HU aprobada → desarrollo → aprobación final → aplicado", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const hu = await pending(t);

    const r = await decide(t, "hu_review", { decision: "approve", decisionHash: hu.pendingApproval.decisionHash });
    expect(r.status).toBe(200);
    const res = r.json.resolution as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true, kind: "hu_review", decision: "approve", actor: "said", decisionHash: hu.pendingApproval.decisionHash });
    expect(typeof res.resolvedAt).toBe("string");

    // El flujo continuó: análisis, viabilidad, desarrollo y revisiones → aprobación final.
    const fin = await pending(t);
    expect(fin.pendingApproval.kind).toBe("final_approval");
    expect(fin.pendingApproval.decisionHash).toBe(fin.pendingApproval.proposalHash);
    expect(fin.gate).toBeNull();
    expect(mock.devCalls).toBe(1);

    const a = await api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: fin.proposal!.proposalHash });
    expect(a.status).toBe(200);
    expect((a.json.resolution as { phase: string }).phase).toBe("applied");
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(true);

    const result = await api("GET", `/executions/${t}/result`);
    expect(result.json.finalResult).toMatchObject({ available: "available", outcome: "applied" });
  });

  it("request_changes regenera la HU (nueva versión y nuevo hash); el hash viejo queda obsoleto", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const v1 = (await pending(t)).pendingApproval.decisionHash!;

    const r = await decide(t, "hu_review", { decision: "request_changes", decisionHash: v1, feedback: "añade validación de enteros" });
    expect(r.status).toBe(200);
    expect(mock.huCalls).toBe(2);
    expect(mock.lastHuPrompt).toContain("añade validación de enteros");

    const p2 = await pending(t);
    expect(p2.pendingApproval.kind).toBe("hu_review");
    expect(p2.gate).toMatchObject({ version: 2, revisionsUsed: 1 });
    const v2 = p2.pendingApproval.decisionHash!;
    // Mismo contenido regenerado, pero otra versión: el hash cambia.
    expect(v2).not.toBe(v1);

    const stale = await decide(t, "hu_review", { decision: "approve", decisionHash: v1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: "hash_mismatch", expectedHash: v2 });
    expect(mock.devCalls).toBe(0); // nada avanzó con el hash obsoleto

    const ok = await decide(t, "hu_review", { decision: "approve", decisionHash: v2 });
    expect(ok.status).toBe(200);
    expect((await pending(t)).pendingApproval.kind).toBe("final_approval");
  });

  it("request_changes con el cupo de revisiones agotado termina en revision_limit", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    for (let i = 0; i < 2; i++) {
      const h = (await pending(t)).pendingApproval.decisionHash;
      expect((await decide(t, "hu_review", { decision: "request_changes", decisionHash: h })).status).toBe(200);
    }
    const h = (await pending(t)).pendingApproval.decisionHash;
    const r = await decide(t, "hu_review", { decision: "request_changes", decisionHash: h });
    expect(r.status).toBe(200);
    expect((r.json.resolution as { phase: string }).phase).toBe("revision_limit");
    expect((await pending(t)).pendingApproval.required).toBe(false);
  });

  it("reject termina el flujo; repetir la decisión da 409 not_awaiting", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const h = (await pending(t)).pendingApproval.decisionHash;

    const r = await decide(t, "hu_review", { decision: "reject", decisionHash: h });
    expect(r.status).toBe(200);
    expect((r.json.resolution as { phase: string }).phase).toBe("rejected");
    expect(mock.devCalls).toBe(0);

    const again = await decide(t, "hu_review", { decision: "reject", decisionHash: h });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("not_awaiting");
    expect(again.json.pendingKind).toBeUndefined();
    expect((await api("GET", `/executions/${t}/result`)).json.finalResult).toMatchObject({ outcome: "rejected" });
  });

  it("registra actor del servidor, decisión y hash en la sesión (ignora actorId del body)", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment("sess-audit");
    const h = (await pending(t)).pendingApproval.decisionHash;
    const r = await decide(t, "hu_review", { decision: "approve", decisionHash: h, actorId: "intruso" });
    expect((r.json.resolution as { actor: string }).actor).toBe("said");

    const s = await api("GET", "/sessions/sess-audit");
    const turns = (s.json.session as { turns: Array<{ text: string }> }).turns.map((x) => x.text);
    expect(turns).toContain(`Aprobación "approve" (hu_review) por said sobre hash ${h}`);
    expect(turns.join("\n")).not.toContain("intruso");
  });
});

describe("Fase 21: viabilidad parcial por HTTP", () => {
  async function toFeasibilityGate(): Promise<{ t: string; hash: string }> {
    await startServer(new FlowMock(["¿Qué hacer con decimales?"]));
    const t = await startDevelopment();
    const hu = (await pending(t)).pendingApproval.decisionHash;
    expect((await decide(t, "hu_review", { decision: "approve", decisionHash: hu })).status).toBe(200);
    const p = await pending(t);
    expect(p.pendingApproval.kind).toBe("feasibility_partial");
    return { t, hash: p.pendingApproval.decisionHash! };
  }

  it("expone la decisión con motivos, análisis y decisiones permitidas", async () => {
    const { t, hash } = await toFeasibilityGate();
    const p = await pending(t);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.gate).toMatchObject({
      kind: "feasibility_partial",
      decisionHash: hash,
      feasibility: "partially_ready",
      allowedDecisions: ["approve", "reject"],
    });
    expect((p.gate!.reasons as string[]).join(" ")).toContain("pregunta");
    expect((p.gate!.technicalAnalysis as { openQuestions: string[] }).openQuestions).toEqual(["¿Qué hacer con decimales?"]);
    expect(await phase(t)).toBe("tech_analyzed");
  });

  it("approve = proceder: el flujo desarrolla y llega a la aprobación final", async () => {
    const { t, hash } = await toFeasibilityGate();
    const r = await decide(t, "feasibility_partial", { decision: "approve", decisionHash: hash });
    expect(r.status).toBe(200);
    expect(r.json.resolution).toMatchObject({ ok: true, kind: "feasibility_partial", decision: "approve", actor: "said" });
    expect(mock.devCalls).toBe(1);
    expect((await pending(t)).pendingApproval.kind).toBe("final_approval");
  });

  it("reject detiene sin desarrollar (blocked)", async () => {
    const { t, hash } = await toFeasibilityGate();
    const r = await decide(t, "feasibility_partial", { decision: "reject", decisionHash: hash });
    expect(r.status).toBe(200);
    expect((r.json.resolution as { phase: string }).phase).toBe("blocked");
    expect(mock.devCalls).toBe(0);
    expect((await pending(t)).pendingApproval.required).toBe(false);
  });

  it("request_changes no existe en esta puerta: 400 unsupported_decision y el estado no cambia", async () => {
    const { t, hash } = await toFeasibilityGate();
    const r = await decide(t, "feasibility_partial", { decision: "request_changes", decisionHash: hash });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("unsupported_decision");
    const p = await pending(t);
    expect(p.pendingApproval).toMatchObject({ kind: "feasibility_partial", decisionHash: hash });
  });

  it("un hash incorrecto se rechaza con 409 y no avanza", async () => {
    const { t, hash } = await toFeasibilityGate();
    const r = await decide(t, "feasibility_partial", { decision: "approve", decisionHash: "0".repeat(64) });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "hash_mismatch", expectedHash: hash });
    expect(mock.devCalls).toBe(0);
  });
});

describe("Fase 21: conflictos, duplicados y validación", () => {
  it("decisión de otra puerta: 409 not_awaiting con la puerta realmente pendiente", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const h = (await pending(t)).pendingApproval.decisionHash;

    const wrong = await decide(t, "feasibility_partial", { decision: "approve", decisionHash: h });
    expect(wrong.status).toBe(409);
    expect(wrong.json).toMatchObject({ error: "not_awaiting", pendingKind: "hu_review" });

    // El endpoint de propuestas sigue sin resolver la HU (contrato intacto).
    const proposalEndpoint = await api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: h });
    expect(proposalEndpoint.status).toBe(409);
    expect(proposalEndpoint.json.error).toBe("not_awaiting");

    await decide(t, "hu_review", { decision: "approve", decisionHash: h });
    const atFinal = await decide(t, "hu_review", { decision: "approve", decisionHash: h });
    expect(atFinal.status).toBe(409);
    expect(atFinal.json).toMatchObject({ error: "not_awaiting", pendingKind: "final_approval" });
  });

  it("dos decisiones simultáneas: solo una se aplica; la otra recibe 409", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const h = (await pending(t)).pendingApproval.decisionHash;
    const [a, b] = await Promise.all([
      decide(t, "hu_review", { decision: "approve", decisionHash: h }),
      decide(t, "hu_review", { decision: "approve", decisionHash: h }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.json.error, b.json.error]).toContain("not_awaiting");
    expect(mock.devCalls).toBe(1); // el flujo avanzó una sola vez
  });

  it("valida el cuerpo, el tipo de puerta y la ejecución", async () => {
    await startServer(new FlowMock());
    const t = await startDevelopment();
    const h = (await pending(t)).pendingApproval.decisionHash;

    const noHash = await decide(t, "hu_review", { decision: "approve" });
    expect(noHash.status).toBe(400);
    const badDecision = await decide(t, "hu_review", { decision: "proceed", decisionHash: h });
    expect(badDecision.status).toBe(400);
    const finalKind = await decide(t, "final_approval", { decision: "approve", decisionHash: h });
    expect(finalKind.status).toBe(400);
    const unknown = await decide("dev-inexistente", "hu_review", { decision: "approve", decisionHash: h });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe("not_found");
    // Nada de lo anterior resolvió la puerta.
    expect((await pending(t)).pendingApproval).toMatchObject({ kind: "hu_review", decisionHash: h });
  });
});

describe("Fase 21: persistencia y recuperación tras reiniciar el servidor", () => {
  it("la puerta y su hash sobreviven al reinicio y el flujo se completa por HTTP", async () => {
    await startServer(new FlowMock(["¿Qué hacer con decimales?"]), true);
    const t = await startDevelopment("sess-restart");
    const huHash = (await pending(t)).pendingApproval.decisionHash!;

    // Reinicio 1: pausado en hu_review.
    await stopServer();
    await startServer(new FlowMock(["¿Qué hacer con decimales?"]), true);
    const p1 = await pending(t);
    expect(p1.pendingApproval).toMatchObject({ kind: "hu_review", decisionHash: huHash });
    expect((await decide(t, "hu_review", { decision: "approve", decisionHash: huHash })).status).toBe(200);

    // Reinicio 2: pausado en feasibility_partial; una decisión repetida sobre la HU ya no vale.
    const feasHash = (await pending(t)).pendingApproval.decisionHash!;
    await stopServer();
    await startServer(new FlowMock(["¿Qué hacer con decimales?"]), true);
    expect((await pending(t)).pendingApproval).toMatchObject({ kind: "feasibility_partial", decisionHash: feasHash });
    const dup = await decide(t, "hu_review", { decision: "approve", decisionHash: huHash });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ error: "not_awaiting", pendingKind: "feasibility_partial" });

    expect((await decide(t, "feasibility_partial", { decision: "approve", decisionHash: feasHash })).status).toBe(200);
    const fin = await pending(t);
    expect(fin.pendingApproval.kind).toBe("final_approval");
    const a = await api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: fin.proposal!.proposalHash });
    expect((a.json.resolution as { phase: string }).phase).toBe("applied");

    // La auditoría de ambas decisiones persiste en la sesión.
    const turns = ((await api("GET", "/sessions/sess-restart")).json.session as { turns: Array<{ text: string }> }).turns.map((x) => x.text);
    expect(turns).toContain(`Aprobación "approve" (hu_review) por said sobre hash ${huHash}`);
    expect(turns).toContain(`Aprobación "approve" (feasibility_partial) por said sobre hash ${feasHash}`);
  });
});
