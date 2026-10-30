import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHuGraph, Command } from "../hu/hu-graph.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

function validHuJson(): string {
  return JSON.stringify({
    summary: "Boton suma",
    need: "sumar a+b",
    tasks: [{ order: 1, description: "crear boton" }],
    acceptanceCriteria: [{ id: "AC1", description: "muestra a+b" }],
    assumptions: [],
    openQuestions: [],
    dependencies: [],
  });
}

function techJson(path: string): string {
  return JSON.stringify({
    summary: "Analisis tecnico",
    currentFlow: "el flujo actual es X",
    affectedFiles: [{ path, responsibility: "logica de suma" }],
    proposedChanges: [{ path, change: "agregar boton" }],
    traceability: [{ ref: "AC1", note: "cubre AC1" }],
    dependencies: [],
    risks: [],
    openQuestions: [],
  });
}

/** Mock HU + Tech configurable. */
class FlowMock implements AgentAdapter {
  readonly name = "flow-mock";
  constructor(
    private readonly techMode: "valid" | "invalid" | "fail" = "valid",
    private readonly techPath = "src/existe.ts",
  ) {}
  async run(r: AgentRequest): Promise<AgentResult> {
    if (r.role === "huAnalyst") {
      return { status: "success", role: "huAnalyst", output: validHuJson() };
    }
    if (r.role === "technicalAnalyst") {
      if (this.techMode === "fail") {
        return { status: "failure", role: "technicalAnalyst", output: "", error: "kiro no disponible" };
      }
      if (this.techMode === "invalid") {
        return { status: "success", role: "technicalAnalyst", output: JSON.stringify({ summary: "" }) };
      }
      return { status: "success", role: "technicalAnalyst", output: techJson(this.techPath) };
    }
    return new MockAgentAdapter().run(r);
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-techflow-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "existe.ts"), "export const x = 1;");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function cfg() {
  n += 1;
  return { configurable: { thread_id: `tf-${n}` } };
}

function graph(techMode: "valid" | "invalid" | "fail" = "valid", techPath?: string) {
  const m = new FlowMock(techMode, techPath);
  const router = new MapAgentRouter({
    analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
  });
  return buildHuGraph({ router, checkpointer: createMemoryCheckpointer(), rootDir: root });
}

describe("Fase 10: analista técnico en el flujo de HU", () => {
  it("1. tras APROBAR la HU, corre el análisis técnico y termina en 'tech_analyzed'", async () => {
    const app = graph("valid");
    const c = cfg();
    await app.invoke({ request: "boton suma" }, c);
    await app.invoke(new Command({ resume: { action: "approve" } }), c);
    const state = await app.getState(c);

    // El análisis técnico se produjo y guardó (la fase final ya continúa a dev).
    expect(state.values.technicalAnalysis).not.toBeNull();
    expect(state.values.technicalAnalysis?.affectedFiles[0].path).toBe("src/existe.ts");
  });

  it("2. si la HU se RECHAZA, el análisis técnico NO se ejecuta", async () => {
    const app = graph("valid");
    const c = cfg();
    await app.invoke({ request: "boton" }, c);
    const final = await app.invoke(new Command({ resume: { action: "reject" } }), c);

    expect(final.phase).toBe("rejected");
    expect(final.technicalAnalysis).toBeNull();
  });

  it("3. identifica archivo existente y valida (exists=true, sin unresolved)", async () => {
    // Nota (Fase 11): tras tech_analyzed el flujo continua a clasificacion/dev.
    // Verificamos el analisis tecnico GUARDADO en el estado, no la fase final.
    const app = graph("valid", "src/existe.ts");
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    await app.invoke(new Command({ resume: { action: "approve" } }), c);
    const state = await app.getState(c);

    expect(state.values.technicalAnalysis?.affectedFiles[0].exists).toBe(true);
    expect(state.values.unresolvedPaths).toEqual([]);
  });

  it("4. reporta ruta INEXISTENTE en unresolvedPaths (no la da por buena)", async () => {
    const app = graph("valid", "src/no-existe.ts");
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    await app.invoke(new Command({ resume: { action: "approve" } }), c);
    const state = await app.getState(c);

    expect(state.values.unresolvedPaths).toContain("src/no-existe.ts");
    expect(state.values.technicalAnalysis?.affectedFiles[0].exists).toBe(false);
    // Con rutas no verificables, la viabilidad es partially_ready (pausa).
    expect(state.values.feasibility).toBe("partially_ready");
  });

  it("5a. análisis inválido -> 'tech_failed' con error explícito (sin fallback)", async () => {
    const app = graph("invalid");
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);

    expect(final.phase).toBe("tech_failed");
    expect(final.error).toContain("inválido");
    expect(final.technicalAnalysis).toBeNull();
  });

  it("5b. fallo del agente técnico -> 'tech_failed' con error explícito", async () => {
    const app = graph("fail");
    const c = cfg();
    await app.invoke({ request: "x" }, c);
    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);

    expect(final.phase).toBe("tech_failed");
    expect(final.error).toContain("falló");
  });

  it("6. el análisis técnico persiste y se recupera tras reinicio (mismo thread_id)", async () => {
    const m = new FlowMock("valid", "src/existe.ts");
    const router = new MapAgentRouter({
      analyze: m, develop: m, review: m, huAnalyst: m, technicalAnalyst: m,
    });
    const checkpointer = createMemoryCheckpointer();
    const c = cfg();

    const a = buildHuGraph({ router, checkpointer, rootDir: root });
    await a.invoke({ request: "boton" }, c);
    await a.invoke(new Command({ resume: { action: "approve" } }), c);

    // "Reinicio": nueva instancia, mismo checkpointer + thread_id.
    const b = buildHuGraph({ router, checkpointer, rootDir: root });
    const recovered = await b.getState(c);
    // El análisis técnico persistió (la fase ya avanzó en el flujo de Fase 11).
    expect(recovered.values.technicalAnalysis).not.toBeNull();
    expect(recovered.values.technicalAnalysis?.affectedFiles[0].path).toBe("src/existe.ts");
  });
});
