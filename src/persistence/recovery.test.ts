import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../graph.js";
import { createSqliteCheckpointer } from "./checkpointer.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { MapAgentRouter } from "../agents/router.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "../agents/types.js";

/** Develop mock con propuesta estructurada (convencion FILE:). */
class ProposingMock implements AgentAdapter {
  readonly name = "proposing-mock";
  constructor(private readonly content = "module.exports = (a, b) => a + b;") {}
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "develop") {
      return {
        status: "success",
        role: "develop",
        output: `FILE: generated/sum.js\n\`\`\`js\n${this.content}\n\`\`\``,
      };
    }
    return new MockAgentAdapter().run(request);
  }
}
function router(content?: string) {
  const a = new ProposingMock(content);
  return new MapAgentRouter({ analyze: a, develop: a, review: a });
}

let dir: string;
let dbPath: string;
let rootDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-persist-"));
  dbPath = join(dir, "cp.sqlite");
  rootDir = join(dir, "repo");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Simula "reiniciar el proceso": NUEVA instancia del grafo con el mismo
 *  archivo SQLite. Cada llamada crea un checkpointer y un grafo nuevos. */
function freshGraph(opts: { failOnWrite?: (rel: string) => boolean } = {}) {
  return buildGraph({
    router: router(),
    checkpointer: createSqliteCheckpointer(dbPath),
    rootDir,
    failOnWrite: opts.failOnWrite,
  });
}

describe("Fase 7: persistencia durable y recuperacion", () => {
  it("1+3. una ejecucion interrumpida se recupera en una NUEVA instancia (reinicio)", async () => {
    const cfg = { configurable: { thread_id: "run-1" } };

    // Instancia A: arranca y se pausa en la aprobacion.
    const a = freshGraph();
    const paused = await a.invoke({ task: "sumar", failUntil: 0 }, cfg);
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();

    // "Reinicio": instancia B nueva, mismo SQLite. Recupera el estado.
    const b = freshGraph();
    const state = await b.getState(cfg);
    expect(state.values.proposal).not.toBeNull();
    expect(state.values.approvalPhase).toBe("pending"); // sigue pendiente
    expect(state.next).toContain("approvalTask");
  });

  it("2. la propuesta y su hash sobreviven al reinicio", async () => {
    const cfg = { configurable: { thread_id: "run-2" } };
    const a = freshGraph();
    const paused = await a.invoke({ task: "sumar", failUntil: 0 }, cfg);
    const hashBefore = (paused as { proposalHash?: string }).proposalHash;

    const b = freshGraph();
    const state = await b.getState(cfg);
    expect(state.values.proposalHash).toHaveLength(64);
    expect(state.values.proposalHash).toBe(hashBefore);
  });

  it("3b. una propuesta pendiente NO se convierte en aprobada por defecto", async () => {
    const cfg = { configurable: { thread_id: "run-3" } };
    const a = freshGraph();
    await a.invoke({ task: "sumar", failUntil: 0 }, cfg);

    // Reinicio y NO reanudar: debe seguir pendiente, nada aplicado.
    const b = freshGraph();
    const state = await b.getState(cfg);
    expect(state.values.approvalPhase).toBe("pending");
    expect(existsSync(join(rootDir, "generated", "sum.js"))).toBe(false);
  });

  it("4. una aprobacion aplica la propuesta exactamente una vez", async () => {
    const cfg = { configurable: { thread_id: "run-4" } };
    const a = freshGraph();
    await a.invoke({ task: "sumar", failUntil: 0 }, cfg);

    // Reinicio y reanudar con approve en la NUEVA instancia (mismo thread_id).
    const b = freshGraph();
    const final = await b.invoke(new Command({ resume: { action: "approve" } }), cfg);

    expect(final.approvalPhase).toBe("applied");
    expect(final.appliedHash).toHaveLength(64);
    expect(readFileSync(join(rootDir, "generated", "sum.js"), "utf8")).toContain("a + b");
  });

  it("5. un reintento tras reanudacion NO aplica dos veces (idempotencia)", async () => {
    const cfg = { configurable: { thread_id: "run-5" } };
    const a = freshGraph();
    await a.invoke({ task: "sumar", failUntil: 0 }, cfg);
    const b = freshGraph();
    const first = await b.invoke(new Command({ resume: { action: "approve" } }), cfg);
    expect(first.approvalPhase).toBe("applied");

    // El grafo ya termino. Marcamos el archivo para detectar reescritura.
    const target = join(rootDir, "generated", "sum.js");
    // Reanudar de nuevo NO debe reaplicar: el estado ya es terminal y el
    // appliedHash registrado haria noop si se re-ejecutara applyChanges.
    const stateAfter = await b.getState(cfg);
    expect(stateAfter.values.appliedHash).toHaveLength(64);
    expect(stateAfter.next.length).toBe(0); // terminado, no re-ejecuta
    expect(existsSync(target)).toBe(true);
  });
});
