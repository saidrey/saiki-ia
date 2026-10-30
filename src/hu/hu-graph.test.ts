import { describe, it, expect } from "vitest";
import { buildHuGraph, Command } from "./hu-graph.js";
import { MAX_HU_REVISIONS } from "./hu-state.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

/** JSON de HU valido, parametrizable por resumen. */
function validHuJson(summary: string): string {
  return JSON.stringify({
    summary,
    need: "comportamiento esperado",
    tasks: [{ order: 1, description: "implementar algo" }],
    acceptanceCriteria: [{ id: "AC1", description: "se verifica algo" }],
    assumptions: ["asumimos X"],
    openQuestions: [],
    dependencies: [],
  });
}

/**
 * Mock del rol huAnalyst, configurable:
 * - mode "valid": devuelve HU valida (resumen vN segun nº de llamada).
 * - mode "invalid": devuelve JSON que NO cumple el esquema.
 * - mode "fail": el agente falla (status failure).
 */
class HuMock implements AgentAdapter {
  readonly name = "hu-mock";
  calls = 0;
  constructor(private readonly mode: "valid" | "invalid" | "fail" = "valid") {}
  async run(r: AgentRequest): Promise<AgentResult> {
    if (r.role !== "huAnalyst") return new MockAgentAdapter().run(r);
    this.calls += 1;
    if (this.mode === "fail") {
      return { status: "failure", output: "", error: "kiro no disponible", role: "huAnalyst" };
    }
    if (this.mode === "invalid") {
      return { status: "success", output: JSON.stringify({ summary: "", tasks: [] }), role: "huAnalyst" };
    }
    return { status: "success", output: validHuJson(`v${this.calls}`), role: "huAnalyst" };
  }
}

/** Adaptador de technicalAnalyst que falla a proposito: estos tests de Fase 9
 *  se centran en el ciclo de HU, no en el analisis tecnico (probado aparte). */
const techStub: AgentAdapter = {
  name: "tech-stub",
  async run() {
    return { status: "failure", output: "", error: "tech no evaluado en tests de HU", role: "technicalAnalyst" };
  },
};

function huGraph(mode: "valid" | "invalid" | "fail" = "valid") {
  const m = new HuMock(mode);
  const router = new MapAgentRouter({
    analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: techStub,
  });
  return buildHuGraph({ router, checkpointer: createMemoryCheckpointer() });
}

let threadCounter = 0;
function cfg() {
  threadCounter += 1;
  return { configurable: { thread_id: `hu-${threadCounter}` } };
}

describe("Fase 9: flujo huAnalyst", () => {
  it("1. HU valida: se genera, valida y pausa para revision humana", async () => {
    const app = huGraph("valid");
    const c = cfg();
    const paused = await app.invoke({ request: "boton azul suma a+b" }, c);

    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();
    const state = await app.getState(c);
    expect(state.values.phase).toBe("pending_review");
    expect(state.values.hu).not.toBeNull();
    expect(state.values.hu?.tasks.length).toBeGreaterThan(0);
    expect(state.values.hu?.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("2. respuesta invalida -> phase 'failed' con error explicito (sin fallback)", async () => {
    const app = huGraph("invalid");
    const result = await app.invoke({ request: "algo" }, cfg());

    expect(result.phase).toBe("failed");
    expect(result.hu).toBeNull();
    expect(result.error).toContain("HU invalida");
    // No se pauso en revision (no hay HU valida que revisar).
    expect((result as { __interrupt__?: unknown[] }).__interrupt__).toBeUndefined();
  });

  it("2b. fallo del agente -> phase 'failed' con error explicito", async () => {
    const app = huGraph("fail");
    const result = await app.invoke({ request: "algo" }, cfg());
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("fallo");
  });

  it("3. aprobacion de una HU: queda registrada y la HU se conserva", async () => {
    // Nota (Fase 10): tras aprobar, el flujo encadena el analisis tecnico. Este
    // HuMock no produce un analisis tecnico valido (es un mock de HU), asi que
    // la fase final es tech_failed; lo relevante aqui es que la aprobacion de la
    // HU se registro y la HU se conserva. El flujo tecnico se prueba en
    // src/tech/tech-flow.test.ts.
    const app = huGraph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);
    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);

    expect(final.hu).not.toBeNull();
    expect(final.decisions.some((d) => d.action === "approve")).toBe(true);
  });

  it("4. revision con feedback -> nueva version distinta", async () => {
    const app = huGraph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);
    const s1 = await app.getState(c);
    const v1 = s1.values.hu?.summary;

    await app.invoke(new Command({ resume: { action: "revise", feedback: "mejoralo" } }), c);
    const s2 = await app.getState(c);

    expect(s2.values.revisions).toBe(1);
    expect(s2.values.versions.length).toBe(2);
    expect(s2.values.hu?.summary).not.toBe(v1); // nueva version
    expect(s2.next).toContain("approvalTask"); // vuelve a pedir revision
    // El feedback quedo registrado.
    expect(
      s2.values.decisions.some(
        (d: { action: string; feedback?: string }) => d.action === "revise" && d.feedback === "mejoralo",
      ),
    ).toBe(true);
  });

  it("5. rechazo explicito -> phase 'rejected'", async () => {
    const app = huGraph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);
    const final = await app.invoke(new Command({ resume: { action: "reject" } }), c);

    expect(final.phase).toBe("rejected");
    expect(final.decisions.some((d) => d.action === "reject")).toBe(true);
  });

  it("6. limite de revisiones alcanzado -> phase 'revision_limit'", async () => {
    const app = huGraph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);

    // Revisar MAX_HU_REVISIONS veces (consume el cupo).
    for (let i = 0; i < MAX_HU_REVISIONS; i++) {
      await app.invoke(new Command({ resume: { action: "revise", feedback: `fb${i}` } }), c);
    }
    // Una revision mas: debe cortar por limite.
    const final = await app.invoke(new Command({ resume: { action: "revise", feedback: "una mas" } }), c);

    expect(final.phase).toBe("revision_limit");
  });

  it("7. persistencia: el estado sobrevive y se reanuda con el mismo thread_id", async () => {
    // Misma instancia de checkpointer compartida entre dos grafos distintos.
    const m = new HuMock("valid");
    const router = new MapAgentRouter({
      analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: techStub,
    });
    const checkpointer = createMemoryCheckpointer();
    const c = cfg();

    const a = buildHuGraph({ router, checkpointer });
    await a.invoke({ request: "boton" }, c);

    // "Reinicio": nueva instancia del grafo, mismo checkpointer + thread_id.
    const b = buildHuGraph({ router, checkpointer });
    const recovered = await b.getState(c);
    // Lo clave: el estado pendiente SOBREVIVIO al "reinicio".
    expect(recovered.values.phase).toBe("pending_review");
    expect(recovered.values.hu).not.toBeNull();

    // Y se puede reanudar con el mismo thread_id (la aprobacion se registra).
    const final = await b.invoke(new Command({ resume: { action: "approve" } }), c);
    expect(final.decisions.some((d) => d.action === "approve")).toBe(true);
  });

  it("8. sin aprobacion no continua: sigue pausado, no 'approved'", async () => {
    const app = huGraph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);
    // No reanudamos.
    const state = await app.getState(c);
    expect(state.next).toContain("approvalTask");
    expect(state.values.phase).toBe("pending_review");
    expect(state.values.phase).not.toBe("approved");
  });
});
