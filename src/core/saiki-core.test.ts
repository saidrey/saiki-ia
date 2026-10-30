import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaikiCore } from "./saiki-core.js";
import { CoreStore } from "./core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";
import { LlmModerator } from "../moderator/llm-moderator.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import type { ConversationEngine, ConversationResult } from "../moderator/conversation-engine.js";
import { openDevSession } from "../projects/test-repos.js";
import { execFileSync } from "node:child_process";

// ── Dobles deterministas (sin CLIs reales) ───────────────────────────────────

function huJson(): string {
  return JSON.stringify({
    summary: "Util suma", need: "sumar",
    tasks: [{ order: 1, description: "crear util" }],
    acceptanceCriteria: [{ id: "AC1", description: "suma ok" }],
    assumptions: [], openQuestions: [], dependencies: [],
  });
}
function techJson(): string {
  return JSON.stringify({
    summary: "a", currentFlow: "f",
    affectedFiles: [{ path: "src/util.ts", responsibility: "r" }],
    proposedChanges: [{ path: "src/gen.ts", change: "crear" }],
    traceability: [], dependencies: [], risks: [], openQuestions: [],
  });
}
function devJson(v: number): string {
  return JSON.stringify({
    summary: `Impl v${v}`, technicalDecisions: ["pura"],
    changes: [{ path: "src/gen.ts", operation: "create", content: `export const sum=(a:number,b:number)=>a+b;//v${v}` }],
    traceability: [{ ref: "AC1", note: "impl" }], risks: [], dependencies: [], openQuestions: [],
    coveredCriteria: ["AC1"], uncoveredCriteria: [],
  });
}
function reviewJson(kind: "functional" | "quality"): string {
  if (kind === "functional") {
    return JSON.stringify({
      decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"],
      unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok",
    });
  }
  return JSON.stringify({
    decision: "approved", categories: [{ category: "clean-code", assessment: "ok" }],
    findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok",
  });
}

/** Mock que cubre todos los roles del grafo + assistant. Configurable para fallo. */
class FullMock implements AgentAdapter {
  readonly name = "full-mock";
  devCalls = 0;
  constructor(private readonly opts: { assistantFails?: boolean } = {}) {}
  async run(r: AgentRequest): Promise<AgentResult> {
    switch (r.role) {
      case "huAnalyst": return { status: "success", role: r.role, output: huJson() };
      case "technicalAnalyst": return { status: "success", role: r.role, output: techJson() };
      case "develop": this.devCalls += 1; return { status: "success", role: r.role, output: devJson(this.devCalls) };
      case "functionalReviewer": return { status: "success", role: r.role, output: reviewJson("functional") };
      case "qualityReviewer": return { status: "success", role: r.role, output: reviewJson("quality") };
      case "assistant":
        if (this.opts.assistantFails) return { status: "failure", role: r.role, output: "", error: "opencode no disponible" };
        return { status: "success", role: r.role, output: "Investigación: opción A vs B. Fuente: docs." };
      default: return new MockAgentAdapter().run(r);
    }
  }
}

let root: string;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-core-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
  execFileSync("git", ["init", "-q"], { cwd: root });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fp(d: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) for (const [k, v] of fp(f)) r.set(k, v);
    else { const s = statSync(f); r.set(f, `${s.size}:${s.mtimeMs}`); }
  }
  return r;
}

function makeCore(opts: { assistantFails?: boolean; openCodeAdapter?: AgentAdapter } = {}) {
  const mock = new FullMock({ assistantFails: opts.assistantFails });
  const router = new MapAgentRouter(
    {
      analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock,
      functionalReviewer: mock, qualityReviewer: mock, assistant: opts.openCodeAdapter ?? mock,
    },
    { opencode: opts.openCodeAdapter ?? mock },
  );
  const kb = new KnowledgeStore(":memory:");
  const coreStore = new CoreStore(":memory:");
  const core = new SaikiCore({
    router,
    graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
    coreStore,
    knowledge: kb,
  });
  return { core, mock, kb };
}

describe("Fase 15: integración extremo a extremo (SaikiCore)", () => {
  it("1. una solicitud de desarrollo llega al grafo y conserva sus aprobaciones", async () => {
    const { core } = makeCore();
    await openDevSession(core, root, "s1");
    const r = await core.process("s1", "implementa un util de suma");
    expect(r.category).toBe("development");
    expect(r.developmentThreadId).toBeTruthy();
    // El grafo está PAUSADO esperando la aprobación de la HU: la aprobación
    // humana se conserva (no se saltó).
    const status = await core.getFlowStatus(r.developmentThreadId!);
    expect(status?.awaitingApproval).toBe(true);
  });

  it("2. una consulta técnica NO inicia desarrollo (se enruta a conversación)", async () => {
    const before = fp(root);
    const { core } = makeCore();
    const r = await core.process("s2", "¿cómo funciona el checkpointer de LangGraph?");
    expect(r.category).toBe("conversation");
    expect(r.developmentThreadId).toBeUndefined();
    // El repo no cambió.
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
  });

  it("3. una investigación usa OpenCode (assistant) SIN modificar el repositorio", async () => {
    const before = fp(root);
    const { core } = makeCore();
    const r = await core.process("s3", "investiga opciones de colas de mensajes");
    expect(r.category).toBe("assistance");
    expect(r.task?.status).toBe("succeeded");
    expect(r.task?.runtime).toBe("opencode");
    // Solo lectura: nunca apply_changes.
    expect(r.task?.grantedCapabilities).not.toContain("apply_changes");
    // Repo intacto.
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
  });

  it("4. el conocimiento aprobado puede consultarse desde una ejecución", async () => {
    const { core, kb } = makeCore();
    const doc = core.proposeKnowledge({ id: "k1", title: "Convención de rutas", category: "conventions", content: "usar rutas relativas", origin: "human" });
    kb.approve(doc.id, "said"); // aprobación humana
    const found = await core.searchKnowledge({ text: "rutas", status: "approved" });
    expect(found.map((d) => d.id)).toContain("k1");
  });

  it("5. el conocimiento nuevo queda como PROPUESTA hasta aprobación humana", async () => {
    const { core } = makeCore();
    const doc = core.proposeKnowledge({ id: "k2", title: "Idea", category: "research", content: "c", origin: "assistant" });
    expect(doc.status).toBe("proposed");
    // Un agente no puede aprobar.
    await expect(core.requestKnowledgeApproval("k2", "assistant")).rejects.toThrow();
    expect((await core.getKnowledgeDoc("k2"))?.status).toBe("proposed");
    // Un humano sí.
    await core.requestKnowledgeApproval("k2", "said");
    expect((await core.getKnowledgeDoc("k2"))?.status).toBe("approved");
  });

  it("6. una ejecución interrumpida se recupera sin perder su estado", async () => {
    // SQLite temporal real + mismos stores para simular reinicio del proceso.
    const mock = new FullMock();
    const router = new MapAgentRouter({
      analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock,
      functionalReviewer: mock, qualityReviewer: mock, assistant: mock,
    }, { opencode: mock });
    const cpPath = join(dir, "cp.sqlite");
    const corePath = join(dir, "core.sqlite");
    const kbPath = join(dir, "kb.sqlite");
    const { createSqliteCheckpointer } = await import("../persistence/checkpointer.js");

    const coreA = new SaikiCore({
      router,
      graphOptions: { checkpointer: createSqliteCheckpointer(cpPath), rootDir: root, applyDir: root },
      coreStore: new CoreStore(corePath),
      knowledge: new KnowledgeStore(kbPath),
    });
    await openDevSession(coreA, root, "s6");
    const r = await coreA.process("s6", "implementa un util de suma");
    const threadId = r.developmentThreadId!;
    coreA.close();

    // "Reinicio": nuevo Core, mismos archivos SQLite.
    const coreB = new SaikiCore({
      router,
      graphOptions: { checkpointer: createSqliteCheckpointer(cpPath), rootDir: root, applyDir: root },
      coreStore: new CoreStore(corePath),
      knowledge: new KnowledgeStore(kbPath),
    });
    const session = await coreB.getSession("s6");
    expect(session?.developmentThreadId).toBe(threadId);
    const status = await coreB.getFlowStatus(threadId);
    expect(status).not.toBeNull();
    expect(status?.awaitingApproval).toBe(true); // el flujo pausado sobrevivió
    coreB.close();
  });

  it("7. un error de runtime se comunica explícitamente (sin falso éxito)", async () => {
    const { core } = makeCore({ assistantFails: true });
    const r = await core.process("s7", "investiga algo");
    expect(r.category).toBe("assistance");
    expect(r.task?.status).toBe("failed");
    expect(r.task?.result).toBeUndefined(); // no hay resultado exitoso falso
    expect(r.task?.errors.join(" ")).toContain("opencode");
  });

  it("8. ningún camino de integración omite el Safe Applier ni las aprobaciones", async () => {
    const before = fp(root);
    const { core } = makeCore();
    // Desarrollo iniciado: el grafo queda pausado en aprobación de la HU; NO se
    // aplicó nada (no se puede llegar al applier sin pasar por las aprobaciones).
    await openDevSession(core, root, "s8");
    const r = await core.process("s8", "implementa un util de suma");
    const status = await core.getFlowStatus(r.developmentThreadId!);
    expect(status?.awaitingApproval).toBe(true);
    // El Core no expone ningún método que escriba el repo directamente; el repo
    // sigue intacto tras iniciar el flujo.
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(false);
  });

  it("extremo a extremo: desarrollo aprobado end-to-end aplica vía el grafo/applier", async () => {
    const { core } = makeCore();
    await openDevSession(core, root, "s9");
    const r = await core.process("s9", "implementa un util de suma");
    const threadId = r.developmentThreadId!;
    // Aprobar HU -> corre tech+dev+reviews -> pausa en aprobación final.
    await core.submitApproval(threadId, "approve");
    // Aprobación final -> aplica vía Safe Applier.
    await core.submitApproval(threadId, "approve");
    const status = await core.getFlowStatus(threadId);
    expect(status?.phase).toBe("applied");
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(true);
  });
});

// ── Fase 16: moderador conversacional integrado en el Core ────────────────────

/** Engine falso configurable por palabra clave (clasificación JSON + respuesta). */
function fakeEngine(impl: (prompt: string, isClassify: boolean) => ConversationResult): ConversationEngine {
  return {
    name: "fake",
    async complete(req) {
      const isClassify = !!req.systemHint && req.systemHint.includes("Clasificas");
      return impl(req.prompt, isClassify);
    },
  };
}

function classify(intent: string, extra: Record<string, unknown> = {}): ConversationResult {
  return {
    ok: true,
    text: JSON.stringify({
      intent, confidence: 0.85, reason: "r", missingInfo: [],
      recommendedAction: "reply", proposedFlow: "f", clarifyingQuestion: "", ...extra,
    }),
  };
}

function makeCoreWithModerator(engine: ConversationEngine) {
  const mock = new FullMock();
  const router = new MapAgentRouter(
    {
      analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock,
      functionalReviewer: mock, qualityReviewer: mock, assistant: mock,
    },
    { opencode: mock },
  );
  return new SaikiCore({
    router,
    graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
    coreStore: new CoreStore(":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new LlmModerator(engine),
  });
}

describe("Fase 16: Core con moderador conversacional (LlmModerator)", () => {
  it("el Core enruta development con el moderador async (grafo + aprobaciones)", async () => {
    const engine = fakeEngine((_p, isClassify) => (isClassify ? classify("development") : { ok: true, text: "x" }));
    const core = makeCoreWithModerator(engine);
    await openDevSession(core, root, "m1");
    const r = await core.process("m1", "implementa un util");
    expect(r.category).toBe("development");
    const status = await core.getFlowStatus(r.developmentThreadId!);
    expect(status?.awaitingApproval).toBe(true); // aprobaciones conservadas
  });

  it("el Core maneja clarification: pregunta y NO ejecuta nada", async () => {
    const before = fp(root);
    const engine = fakeEngine((_p, isClassify) =>
      isClassify ? classify("clarification", { clarifyingQuestion: "¿qué exactamente?" }) : { ok: true, text: "x" },
    );
    const core = makeCoreWithModerator(engine);
    const r = await core.process("m2", "arregla eso");
    expect(r.category).toBe("clarification");
    expect(r.clarifyingQuestion).toBeTruthy();
    expect(r.developmentThreadId).toBeUndefined();
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
  });

  it("10. cambiar de proveedor = cambiar el engine, SIN tocar el Core", async () => {
    // Dos 'proveedores' distintos (engines) producen el mismo enrutamiento. El
    // Core no cambia: solo se inyecta otro ConversationEngine.
    const engineA = fakeEngine((_p, c) => (c ? classify("assistance") : { ok: true, text: "A" }));
    const engineB = fakeEngine((_p, c) => (c ? classify("assistance") : { ok: true, text: "B" }));
    const coreA = makeCoreWithModerator(engineA);
    const coreB = makeCoreWithModerator(engineB);
    const ra = await coreA.process("mA", "investiga algo");
    const rb = await coreB.process("mB", "investiga algo");
    expect(ra.category).toBe("assistance");
    expect(rb.category).toBe("assistance");
    expect(ra.task?.runtime).toBe("opencode");
    expect(rb.task?.runtime).toBe("opencode");
  });

  it("error del proveedor en el Core: se propaga explícitamente (sin falso éxito)", async () => {
    const engine = fakeEngine(() => ({ ok: false, error: "proveedor caído" }));
    const core = makeCoreWithModerator(engine);
    await expect(core.process("m3", "hola")).rejects.toThrow();
  });
});

// ── Fase 17: síntesis de asistencia integrada en el Core ──────────────────────

/** Core con LlmModerator cuyo engine clasifica 'assistance' y sintetiza. */
function makeAssistCore(opts: { assistantFails?: boolean; synthFails?: boolean } = {}) {
  const engine: ConversationEngine = {
    name: "fake-assist",
    async complete(req) {
      const isClassify = !!req.systemHint && req.systemHint.includes("Clasificas");
      if (isClassify) {
        // Clasificar según el MENSAJE del usuario, no según el esquema (que
        // contiene la palabra "investigar"). Mismo gotcha que en Fase 16.
        const marker = "Mensaje actual del usuario:";
        const idx = req.prompt.indexOf(marker);
        const msg = (idx === -1 ? req.prompt : req.prompt.slice(idx + marker.length)).toLowerCase();
        if (msg.includes("investiga")) return classify("assistance");
        return classify("conversation");
      }
      // Petición de síntesis o de respuesta conversacional.
      if (req.prompt.includes("Resume el siguiente resultado")) {
        if (opts.synthFails) return { ok: false, error: "síntesis caída" };
        return { ok: true, text: "HALLAZGOS: X. CONCLUSIÓN: Y. RECOMENDACIÓN: Z. LIMITACIÓN: W." };
      }
      return { ok: true, text: "respuesta conversacional" };
    },
  };
  const mock = new FullMock({ assistantFails: opts.assistantFails });
  const router = new MapAgentRouter(
    {
      analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock,
      functionalReviewer: mock, qualityReviewer: mock, assistant: mock,
    },
    { opencode: mock },
  );
  return new SaikiCore({
    router,
    graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
    coreStore: new CoreStore(":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new LlmModerator(engine),
  });
}

describe("Fase 17: síntesis de asistencia integrada", () => {
  it("1. una investigación exitosa genera síntesis automática", async () => {
    const core = makeAssistCore();
    const r = await core.process("a1", "investiga opciones de colas");
    expect(r.category).toBe("assistance");
    expect(r.task?.status).toBe("succeeded");
    expect(r.task?.synthesis).toBeTruthy();
    expect(r.reply).toContain("HALLAZGOS");
  });

  it("2. la síntesis conserva la referencia al resultado original (task.id)", async () => {
    const core = makeAssistCore();
    const r = await core.process("a2", "investiga X");
    expect(r.reply).toContain(r.task!.id); // synthesizeAssistance añade [... task <id>]
  });

  it("3. una consulta que no requiere investigación NO dispara síntesis", async () => {
    const core = makeAssistCore();
    const r = await core.process("a3", "¿qué tal todo?");
    expect(r.category).toBe("conversation");
    expect(r.task).toBeUndefined();
  });

  it("4. un fallo del runtime de asistencia se comunica (sin falso éxito)", async () => {
    const core = makeAssistCore({ assistantFails: true });
    const r = await core.process("a4", "investiga Y");
    expect(r.category).toBe("assistance");
    expect(r.task?.status).toBe("failed");
    expect(r.task?.synthesis).toBeUndefined(); // no se sintetiza un fallo
    expect(r.reply).toContain("no se completó");
  });

  it("5. un fallo de síntesis NO destruye el resultado de investigación", async () => {
    const core = makeAssistCore({ synthFails: true });
    const r = await core.process("a5", "investiga Z");
    expect(r.task?.status).toBe("succeeded");
    // Se conserva el resultado crudo (de FullMock) aunque la síntesis falle.
    expect(r.task?.result).toBeTruthy();
    expect(r.reply).toBe(r.task?.result); // reply = crudo, no se perdió
  });

  it("6. una ejecución recuperada NO re-sintetiza (idempotencia)", async () => {
    // SQLite temporal real: primera corrida sintetiza; al recuperar la tarea ya
    // tiene synthesis y no se vuelve a llamar al engine.
    let synthCalls = 0;
    const engine: ConversationEngine = {
      name: "count-engine",
      async complete(req) {
        const isClassify = !!req.systemHint && req.systemHint.includes("Clasificas");
        if (isClassify) return classify("assistance");
        if (req.prompt.includes("Resume el siguiente resultado")) { synthCalls++; return { ok: true, text: "SÍNTESIS" }; }
        return { ok: true, text: "x" };
      },
    };
    const mock = new FullMock();
    const router = new MapAgentRouter(
      { analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock, functionalReviewer: mock, qualityReviewer: mock, assistant: mock },
      { opencode: mock },
    );
    const corePath = join(dir, "core17.sqlite");
    const coreA = new SaikiCore({
      router,
      graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
      coreStore: new CoreStore(corePath),
      knowledge: new KnowledgeStore(":memory:"),
      moderator: new LlmModerator(engine),
    });
    const r1 = await coreA.process("a6", "investiga algo");
    expect(synthCalls).toBe(1);
    const taskId = r1.task!.id;
    coreA.close();

    // Recuperación: la tarea persistida ya tiene synthesis; re-sintetizar la
    // tarea NO debe volver a llamar al engine.
    const coreB = new SaikiCore({
      router,
      graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
      coreStore: new CoreStore(corePath),
      knowledge: new KnowledgeStore(":memory:"),
      moderator: new LlmModerator(engine),
    });
    const recovered = (await coreB.listTasks("a6")).find((t) => t.id === taskId);
    expect(recovered?.synthesis).toBeTruthy();
    // trySynthesize sobre la tarea recuperada no incrementa synthCalls.
    const again = await (coreB as unknown as { trySynthesize(t: unknown): Promise<{ text: string }> }).trySynthesize(recovered);
    expect(again.text).toBe(recovered?.synthesis);
    expect(synthCalls).toBe(1); // no re-sintetizó
    coreB.close();
  });

  it("7. la respuesta final conserva el contexto de la conversación", async () => {
    const core = makeAssistCore();
    await core.process("a7", "investiga opciones de X");
    const session = await core.getSession("a7");
    // La sesión tiene el turno del usuario y el del moderador con la síntesis.
    expect(session?.turns.some((t) => t.role === "user")).toBe(true);
    expect(session?.turns.some((t) => t.role === "moderator" && t.text.includes("HALLAZGOS"))).toBe(true);
    expect(session?.delegatedTaskIds.length).toBe(1);
  });

  it("8. los escenarios de desarrollo mantienen sus garantías (síntesis no interfiere)", async () => {
    const before = fp(root);
    // Moderador determinista (no sintetiza) + desarrollo: el grafo se comporta igual.
    const mock = new FullMock();
    const router = new MapAgentRouter(
      { analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock, functionalReviewer: mock, qualityReviewer: mock, assistant: mock },
      { opencode: mock },
    );
    const core = new SaikiCore({
      router,
      graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
      coreStore: new CoreStore(":memory:"),
      knowledge: new KnowledgeStore(":memory:"),
      moderator: new BasicModerator(),
    });
    await openDevSession(core, root, "a8");
    const r = await core.process("a8", "implementa un util de suma");
    const status = await core.getFlowStatus(r.developmentThreadId!);
    expect(status?.awaitingApproval).toBe(true);
    expect([...fp(root).entries()]).toEqual([...before.entries()]); // nada aplicado
  });

  it("moderador sin síntesis (determinista): entrega resultado crudo con nota", async () => {
    const mock = new FullMock();
    const router = new MapAgentRouter(
      { analyze: mock, develop: mock, review: mock, huAnalyst: mock, technicalAnalyst: mock, functionalReviewer: mock, qualityReviewer: mock, assistant: mock },
      { opencode: mock },
    );
    const core = new SaikiCore({
      router,
      graphOptions: { checkpointer: createMemoryCheckpointer(), rootDir: root, applyDir: root },
      coreStore: new CoreStore(":memory:"),
      knowledge: new KnowledgeStore(":memory:"),
      moderator: new BasicModerator(),
    });
    const r = await core.process("a9", "investiga opciones");
    expect(r.category).toBe("assistance");
    expect(r.reply).toContain("sin sintetizar");
  });
});
