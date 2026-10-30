import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHuGraph, Command } from "../hu/hu-graph.js";
import { MAX_REVIEW_CYCLES } from "../hu/hu-state.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

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
    proposedChanges: [{ path: "src/util.ts", change: "c" }],
    traceability: [], dependencies: [], risks: [], openQuestions: [],
  });
}
/** Propuesta de Claude; varía con `version` para que el hash cambie. */
function devJson(version: number): string {
  return JSON.stringify({
    summary: `Impl v${version}`, technicalDecisions: ["pura"],
    changes: [{ path: "src/gen.ts", operation: "create", content: `export const sum=(a,b)=>a+b;//v${version}` }],
    traceability: [{ ref: "AC1", note: "impl" }],
    risks: [], dependencies: [], openQuestions: [],
    coveredCriteria: ["AC1"], uncoveredCriteria: [],
  });
}
function reviewJson(kind: "functional" | "quality", decision: "approved" | "rejected"): string {
  if (kind === "functional") {
    return JSON.stringify({
      decision, evaluatedCriteria: ["AC1"],
      metCriteria: decision === "approved" ? ["AC1"] : [],
      unmetCriteria: decision === "approved" ? [] : ["AC1"],
      findings: decision === "approved" ? [] : [{ id: "F1", severity: "high", description: "falta X" }],
      requiredChanges: decision === "approved" ? [] : ["agregar X"],
      openQuestions: [], summary: `func ${decision}`,
    });
  }
  return JSON.stringify({
    decision, categories: [{ category: "clean-code", assessment: "ok" }],
    findings: decision === "approved" ? [] : [{ id: "Q1", severity: "medium", description: "refactor" }],
    requiredChanges: decision === "approved" ? [] : ["refactorizar Y"],
    acceptedRisks: [], summary: `quality ${decision}`,
  });
}

/**
 * Mock configurable:
 * - funcApproveAt / qualApproveAt: nº de ejecución de cada revisor a partir del
 *   cual aprueba (1 = aprueba a la primera). 99 = nunca.
 * - funcFail / qualFail: el revisor devuelve status failure.
 */
interface Cfg {
  funcApproveAt?: number;
  qualApproveAt?: number;
  funcFail?: boolean;
  qualFail?: boolean;
}
class FlowMock implements AgentAdapter {
  readonly name = "review-flow-mock";
  devCalls = 0;
  funcCalls = 0;
  qualCalls = 0;
  constructor(private readonly cfg: Cfg = {}) {}
  async run(r: AgentRequest): Promise<AgentResult> {
    if (r.role === "huAnalyst") return { status: "success", role: r.role, output: huJson() };
    if (r.role === "technicalAnalyst") return { status: "success", role: r.role, output: techJson() };
    if (r.role === "develop") {
      this.devCalls += 1;
      return { status: "success", role: r.role, output: devJson(this.devCalls) };
    }
    if (r.role === "functionalReviewer") {
      this.funcCalls += 1;
      if (this.cfg.funcFail) return { status: "failure", role: r.role, output: "", error: "kiro fallo" };
      const dec = this.funcCalls >= (this.cfg.funcApproveAt ?? 1) ? "approved" : "rejected";
      return { status: "success", role: r.role, output: reviewJson("functional", dec) };
    }
    if (r.role === "qualityReviewer") {
      this.qualCalls += 1;
      if (this.cfg.qualFail) return { status: "failure", role: r.role, output: "", error: "kiro fallo" };
      const dec = this.qualCalls >= (this.cfg.qualApproveAt ?? 1) ? "approved" : "rejected";
      return { status: "success", role: r.role, output: reviewJson("quality", dec) };
    }
    return new MockAgentAdapter().run(r);
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-rev-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function cfg() { n += 1; return { configurable: { thread_id: `rev-${n}` } }; }

function graph(c: Cfg = {}) {
  const m = new FlowMock(c);
  const router = new MapAgentRouter({
    analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
    functionalReviewer: m, qualityReviewer: m,
  });
  return { app: buildHuGraph({ router, checkpointer: createMemoryCheckpointer(), rootDir: root }), mock: m };
}

/** Aprueba la HU y deja el flujo correr hasta donde pueda sin más input. */
async function toReviews(app: ReturnType<typeof buildHuGraph>, c: ReturnType<typeof cfg>) {
  await app.invoke({ request: "sumar" }, c);
  return app.invoke(new Command({ resume: { action: "approve" } }), c);
}

function fp(dir: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) for (const [k, v] of fp(f)) r.set(k, v);
    else { const s = statSync(f); r.set(f, `${s.size}:${s.mtimeMs}`); }
  }
  return r;
}

describe("Fase 12: revisiones funcional y calidad", () => {
  it("2+6. func revisa; calidad solo corre TRAS aprobar func", async () => {
    const { app, mock } = graph({ funcApproveAt: 1, qualApproveAt: 1 });
    const c = cfg();
    const final = await toReviews(app, c);
    expect(mock.funcCalls).toBeGreaterThanOrEqual(1);
    expect(mock.qualCalls).toBe(1);
    // ambas aprobaron el mismo hash -> pausa en aprobación humana FINAL (Fase 13).
    const state = await app.getState(c);
    expect(state.next).toContain("finalApprovalTask");
    expect(final.phase === "reviews_passed" || state.values.phase === "reviews_passed").toBe(true);
  });

  it("3+4+5. func rechaza criterio -> hallazgos a Claude -> corrige -> re-revisa func", async () => {
    const { app, mock } = graph({ funcApproveAt: 2, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    // func rechazó la 1a, Claude re-desarrolló, func aprobó la 2a.
    expect(mock.funcCalls).toBe(2);
    expect(mock.devCalls).toBe(2);
  });

  it("6b. calidad NO corre si func nunca aprueba dentro del límite", async () => {
    const { app, mock } = graph({ funcApproveAt: 99, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    expect(mock.qualCalls).toBe(0);
  });

  it("8+9. calidad rechaza -> corrige -> re-revisa AMBAS", async () => {
    const { app, mock } = graph({ funcApproveAt: 1, qualApproveAt: 2 });
    const c = cfg();
    await toReviews(app, c);
    // func aprobó dos veces (una por cada versión), calidad rechazó la 1a y aprobó la 2a.
    expect(mock.qualCalls).toBe(2);
    expect(mock.funcCalls).toBe(2); // se re-revisó funcional tras la corrección
    expect(mock.devCalls).toBe(2);
  });

  it("10. una aprobación corresponde al hash exacto; ambas al mismo hash", async () => {
    const { app } = graph({ funcApproveAt: 1, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    const state = await app.getState(c);
    const h = state.values.devProposalHash;
    expect(state.values.functionalApprovedHash).toBe(h);
    expect(state.values.qualityApprovedHash).toBe(h);
    expect(state.values.phase).toBe("reviews_passed");
  });

  it("12+13. agotar ciclos NO aprueba automáticamente (reviews_exhausted)", async () => {
    const { app } = graph({ funcApproveAt: 99 }); // nunca aprueba func
    const c = cfg();
    const final = await toReviews(app, c);
    expect(final.phase).toBe("reviews_exhausted");
    expect(final.reviewCycles).toBe(MAX_REVIEW_CYCLES);
    // No llegó a aprobación humana.
    const state = await app.getState(c);
    expect(state.next.includes("finalApprovalTask")).toBe(false);
  });

  it("14a. error del revisor funcional -> review_failed explícito (sin fallback)", async () => {
    const { app } = graph({ funcFail: true });
    const c = cfg();
    const final = await toReviews(app, c);
    expect(final.phase).toBe("review_failed");
    expect(final.error).toContain("funcional");
  });

  it("14b. error del revisor de calidad -> review_failed explícito", async () => {
    const { app } = graph({ funcApproveAt: 1, qualFail: true });
    const c = cfg();
    const final = await toReviews(app, c);
    expect(final.phase).toBe("review_failed");
    expect(final.error).toContain("calidad");
  });

  it("11+15. resultados persisten y se recuperan tras reinicio (mismo thread_id)", async () => {
    const m = new FlowMock({ funcApproveAt: 1, qualApproveAt: 1 });
    const router = new MapAgentRouter({
      analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
      functionalReviewer: m, qualityReviewer: m,
    });
    const checkpointer = createMemoryCheckpointer();
    const c = cfg();
    const a = buildHuGraph({ router, checkpointer, rootDir: root });
    await toReviews(a, c);

    const b = buildHuGraph({ router, checkpointer, rootDir: root });
    const recovered = await b.getState(c);
    expect(recovered.values.functionalReview).not.toBeNull();
    expect(recovered.values.qualityReview).not.toBeNull();
    expect(recovered.values.reviewHistory.length).toBeGreaterThan(0);
    expect(recovered.next).toContain("finalApprovalTask");
  });

  it("16. seguridad: las revisiones no modifican el repositorio (dir intacto)", async () => {
    const before = fp(root);
    const { app } = graph({ funcApproveAt: 1, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
  });

  it("aprobación final tras reviews_passed -> aplica y verifica (Fase 13)", async () => {
    const { app } = graph({ funcApproveAt: 1, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    // Aprobación humana FINAL: ahora SÍ aplica (Fase 13). La propuesta del mock
    // crea src/gen.ts en el repo temporal.
    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);
    expect(final.phase).toBe("applied");
    expect(existsSync(join(root, "src", "gen.ts"))).toBe(true);
    expect(final.verification?.filesMatch).toBe(true);
  });

  it("rechazo en la aprobación final -> final_approval_rejected, repo intacto", async () => {
    const before = fp(root);
    const { app } = graph({ funcApproveAt: 1, qualApproveAt: 1 });
    const c = cfg();
    await toReviews(app, c);
    const final = await app.invoke(new Command({ resume: { action: "reject" } }), c);
    expect(final.phase).toBe("final_approval_rejected");
    expect([...fp(root).entries()]).toEqual([...before.entries()]);
  });
});
