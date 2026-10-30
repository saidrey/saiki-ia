import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHuGraph, Command } from "../hu/hu-graph.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { hashDevProposal, validateDevProposal } from "./dev-schema.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

// ── Datos de prueba ──────────────────────────────────────────────────────────

function huJson(): string {
  return JSON.stringify({
    summary: "Agregar util de suma", need: "sumar a+b",
    tasks: [{ order: 1, description: "crear util" }],
    acceptanceCriteria: [{ id: "AC1", description: "suma correcta" }],
    assumptions: [], openQuestions: [], dependencies: [],
  });
}

/** Análisis técnico: "ready" (con cambios, sin preguntas) o "blocked"/"partial". */
function techJson(mode: "ready" | "blocked" | "partial"): string {
  const base = {
    summary: "analisis", currentFlow: "flujo",
    affectedFiles: [{ path: "src/util.ts", responsibility: "logica" }],
    proposedChanges: [{ path: "src/util.ts", change: "agregar suma" }],
    traceability: [{ ref: "AC1", note: "cubre" }],
    dependencies: [], risks: [], openQuestions: [],
  };
  if (mode === "blocked") return JSON.stringify({ ...base, proposedChanges: [], affectedFiles: [] });
  if (mode === "partial") return JSON.stringify({ ...base, openQuestions: ["¿de dónde sale a?"] });
  return JSON.stringify(base);
}

function devProposalJson(path = "src/generated-sum.ts"): string {
  return JSON.stringify({
    summary: "Implementar suma",
    technicalDecisions: ["funcion pura"],
    changes: [{ path, operation: "create", content: "export const sum = (a:number,b:number)=>a+b;" }],
    traceability: [{ ref: "AC1", note: "implementa la suma" }],
    risks: [], dependencies: [], openQuestions: [],
    coveredCriteria: ["AC1"], uncoveredCriteria: [],
  });
}

/** Mock unico, configurable por modo de tech y de develop. */
class FlowMock implements AgentAdapter {
  readonly name = "dev-flow-mock";
  constructor(
    private readonly techMode: "ready" | "blocked" | "partial" = "ready",
    private readonly devMode: "valid" | "invalid" | "fail" = "valid",
  ) {}
  async run(r: AgentRequest): Promise<AgentResult> {
    if (r.role === "huAnalyst") return { status: "success", role: "huAnalyst", output: huJson() };
    if (r.role === "technicalAnalyst") return { status: "success", role: "technicalAnalyst", output: techJson(this.techMode) };
    if (r.role === "develop") {
      if (this.devMode === "fail") return { status: "failure", role: "develop", output: "", error: "claude no disponible" };
      if (this.devMode === "invalid") return { status: "success", role: "develop", output: JSON.stringify({ summary: "" }) };
      return { status: "success", role: "develop", output: devProposalJson() };
    }
    // (Fase 12) Revisores: ambos aprueban, para que los tests de Fase 11
    // puedan llegar hasta reviews_passed / aprobación humana.
    if (r.role === "functionalReviewer") {
      return {
        status: "success", role: r.role,
        output: JSON.stringify({
          decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"],
          unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok",
        }),
      };
    }
    if (r.role === "qualityReviewer") {
      return {
        status: "success", role: r.role,
        output: JSON.stringify({
          decision: "approved", categories: [{ category: "clean-code", assessment: "ok" }],
          findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok",
        }),
      };
    }
    return new MockAgentAdapter().run(r);
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-dev-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "util.ts"), "export {};");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function cfg() {
  n += 1;
  return { configurable: { thread_id: `dev-${n}` } };
}

function graph(techMode: "ready" | "blocked" | "partial" = "ready", devMode: "valid" | "invalid" | "fail" = "valid") {
  const m = new FlowMock(techMode, devMode);
  const router = new MapAgentRouter({
    analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
    functionalReviewer: m, qualityReviewer: m,
  });
  return buildHuGraph({ router, checkpointer: createMemoryCheckpointer(), rootDir: root });
}

/** Lleva el flujo hasta aprobar la HU (deja el grafo tras tech+clasificación). */
async function approveHu(app: ReturnType<typeof buildHuGraph>, c: ReturnType<typeof cfg>) {
  await app.invoke({ request: "sumar" }, c);
  return app.invoke(new Command({ resume: { action: "approve" } }), c);
}

function fingerprint(dir: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) for (const [k, v] of fingerprint(full)) r.set(k, v);
    else { const st = statSync(full); r.set(full, `${st.size}:${st.mtimeMs}`); }
  }
  return r;
}

describe("Fase 11: desarrollador Claude en el flujo", () => {
  it("1. HU rechazada NO llega a tech ni a develop", async () => {
    const app = graph();
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    const final = await app.invoke(new Command({ resume: { action: "reject" } }), c);
    expect(final.phase).toBe("rejected");
    expect(final.technicalAnalysis).toBeNull();
    expect(final.devProposal).toBeNull();
  });

  it("2. HU sin aprobación no llega a develop (sigue pausada)", async () => {
    const app = graph();
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    const state = await app.getState(c);
    expect(state.next).toContain("approvalTask");
    expect(state.values.devProposal).toBeNull();
  });

  it("3. si el análisis técnico falla, Claude no se ejecuta", async () => {
    // tech devuelve algo inválido -> tech_failed.
    const m = new FlowMock("ready", "valid");
    const badTech: AgentAdapter = {
      name: "bad", async run(r) {
        if (r.role === "technicalAnalyst") return { status: "failure", role: "technicalAnalyst", output: "", error: "fallo" };
        return m.run(r);
      },
    };
    const router = new MapAgentRouter({ analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: badTech });
    const app = buildHuGraph({ router, checkpointer: createMemoryCheckpointer(), rootDir: root });
    const c = cfg();
    const final = await approveHu(app, c);
    expect(final.phase).toBe("tech_failed");
    expect(final.devProposal).toBeNull();
  });

  it("4. viabilidad blocked: Claude no se ejecuta, flujo se detiene con motivos", async () => {
    const app = graph("blocked");
    const c = cfg();
    const final = await approveHu(app, c);
    expect(final.feasibility).toBe("blocked");
    expect(final.phase).toBe("tech_analyzed"); // clasificó pero no desarrolló
    expect(final.devProposal).toBeNull();
    expect(final.feasibilityReasons.length).toBeGreaterThan(0);
  });

  it("5. viabilidad partially_ready: exige decisión humana (pausa)", async () => {
    const app = graph("partial");
    const c = cfg();
    await approveHu(app, c);
    const state = await app.getState(c);
    expect(state.values.feasibility).toBe("partially_ready");
    expect(state.next).toContain("partialDecisionTask");
    expect(state.values.devProposal).toBeNull(); // aún no desarrolló
  });

  it("5b. partially_ready + proceed -> desarrolla; + reject -> no desarrolla", async () => {
    const appP = graph("partial");
    const cP = cfg();
    await approveHu(appP, cP);
    const proceeded = await appP.invoke(new Command({ resume: { action: "proceed" } }), cP);
    // (Fase 12) tras desarrollar, pasa por revisiones (que aprueban aquí).
    expect(proceeded.devProposal).not.toBeNull();
    expect(["dev_proposed", "reviews_passed"]).toContain(proceeded.phase);

    const appR = graph("partial");
    const cR = cfg();
    await approveHu(appR, cR);
    const rejected = await appR.invoke(new Command({ resume: { action: "cancel" } }), cR);
    expect(rejected.phase).toBe("blocked");
    expect(rejected.devProposal).toBeNull();
  });

  it("6. viabilidad ready: Claude recibe HU+tech y genera propuesta", async () => {
    const app = graph("ready", "valid");
    const c = cfg();
    const final = await approveHu(app, c);
    expect(final.feasibility).toBe("ready");
    expect(final.devProposal).not.toBeNull();
    expect(final.devProposalHash).toHaveLength(64);
    // (Fase 12) con revisores que aprueban, termina en reviews_passed.
    expect(["dev_proposed", "reviews_passed"]).toContain(final.phase);
  });

  it("7. propuesta válida llega al punto de aprobación humana (final, Fase 13)", async () => {
    const app = graph("ready", "valid");
    const c = cfg();
    await approveHu(app, c);
    const state = await app.getState(c);
    expect(state.next).toContain("finalApprovalTask");
  });

  it("8. propuesta inválida -> dev_failed (no aprobable ni aplicable)", async () => {
    const app = graph("ready", "invalid");
    const c = cfg();
    const final = await approveHu(app, c);
    expect(final.phase).toBe("dev_failed");
    expect(final.devProposal).toBeNull();
  });

  it("9. error real de Claude se muestra explícito, sin fallback", async () => {
    const app = graph("ready", "fail");
    const c = cfg();
    const final = await approveHu(app, c);
    expect(final.phase).toBe("dev_failed");
    expect(final.error).toContain("falló");
  });

  it("10. Claude no modifica archivos del repositorio (dir intacto)", async () => {
    const before = fingerprint(root);
    const app = graph("ready", "valid");
    const c = cfg();
    await approveHu(app, c);
    const after = fingerprint(root);
    expect([...after.entries()]).toEqual([...before.entries()]);
  });

  it("11. propuesta y hash persisten tras reinicio (mismo thread_id)", async () => {
    const m = new FlowMock("ready", "valid");
    const router = new MapAgentRouter({
      analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
      functionalReviewer: m, qualityReviewer: m,
    });
    const checkpointer = createMemoryCheckpointer();
    const c = cfg();
    const a = buildHuGraph({ router, checkpointer, rootDir: root });
    await approveHu(a, c);

    const b = buildHuGraph({ router, checkpointer, rootDir: root });
    const recovered = await b.getState(c);
    // La propuesta y su hash persisten tras el "reinicio" (la fase ya avanzó a
    // reviews en Fase 12; lo esencial es que propuesta+hash sobreviven).
    expect(recovered.values.devProposalHash).toHaveLength(64);
    expect(recovered.values.devProposal).not.toBeNull();
  });

  it("12. una modificación de la propuesta cambia el hash (invalida aprobación previa)", () => {
    const p1 = validateDevProposal(JSON.parse(devProposalJson("src/a.ts")), root);
    const p2 = validateDevProposal(JSON.parse(devProposalJson("src/b.ts")), root);
    expect(p1.ok && p2.ok).toBe(true);
    if (p1.ok && p2.ok) {
      expect(hashDevProposal(p1.proposal)).not.toBe(hashDevProposal(p2.proposal));
    }
  });

  it("13. protección de rutas: traversal en la propuesta se marca no verificable", () => {
    const evil = {
      summary: "x", technicalDecisions: [],
      changes: [{ path: "../escape.ts", operation: "create", content: "x" }],
      traceability: [], risks: [], dependencies: [], openQuestions: [],
      coveredCriteria: [], uncoveredCriteria: [],
    };
    const r = validateDevProposal(evil, root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unverifiablePaths.some((p) => p.includes("traversal"))).toBe(true);
  });

  it("Claude NO escribe por sí mismo: el repo solo cambia tras aprobación (aplicador)", async () => {
    const before = fingerprint(root);
    const app = graph("ready", "valid");
    const c = cfg();
    await approveHu(app, c);
    // Tras generar la propuesta y pasar revisiones, ANTES de aprobar, el repo
    // sigue intacto: Claude nunca escribe.
    expect([...fingerprint(root).entries()]).toEqual([...before.entries()]);
    // La aplicación la realiza EXCLUSIVAMENTE el aplicador tras la aprobación
    // humana final (Fase 13).
    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);
    expect(final.phase).toBe("applied");
    expect(final.appliedFiles).toContain("src/generated-sum.ts");
  });
});
