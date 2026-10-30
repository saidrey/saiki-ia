import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "./graph.js";
import { createSqliteCheckpointer } from "./persistence/checkpointer.js";
import { MockAgentAdapter } from "./agents/mock-agent.js";
import { MapAgentRouter } from "./agents/router.js";
import { MockReviewer } from "./review/mock-reviewer.js";
import type { AgentAdapter, AgentRequest, AgentResult } from "./agents/types.js";

/**
 * Punto de entrada (demo rapida de la Fase 6: human-in-the-loop).
 *
 * IMPORTANTE: esta demo NO llama a Kiro/Claude reales (seria lento, costoso y
 * no determinista) y NO toca el repo: usa un develop simulado que emite una
 * propuesta estructurada y aplica los cambios en un directorio TEMPORAL.
 *
 * Muestra el ciclo completo: el grafo se PAUSA en la aprobacion (interrupt),
 * y se reanuda con Command({ resume }) usando el mismo thread_id, para dos
 * decisiones: approve (aplica) y reject (repo intacto).
 *
 * Las integraciones reales son opt-in: `npm run manual:kiro`, `manual:claude`.
 */

/** Develop simulado que devuelve una propuesta estructurada (convencion FILE:). */
class ProposingMockAdapter implements AgentAdapter {
  readonly name = "mock-proposing";
  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === "develop") {
      const attempt = (request.context?.attempt as number) ?? 1;
      return {
        status: "success",
        role: "develop",
        output: `FILE: generated/sum.js\n\`\`\`js\nmodule.exports = (a, b) => a + b; // v${attempt}\n\`\`\``,
      };
    }
    return new MockAgentAdapter().run(request);
  }
}

function demoRouter() {
  const proposing = new ProposingMockAdapter();
  return new MapAgentRouter({ analyze: proposing, develop: proposing, review: proposing });
}

async function runDemo(
  titulo: string,
  opts: { decision: "approve" | "reject"; rejectUntilAttempt: number },
): Promise<void> {
  // Todo en un directorio temporal: ni el repo ni el .saiki/ real se tocan.
  const dir = mkdtempSync(join(tmpdir(), "saiki-demo-"));
  const dbPath = join(dir, "checkpoints.sqlite");
  const rootDir = join(dir, "repo");
  const cfg = { configurable: { thread_id: `demo-${titulo}` } };

  console.log(`\n=== ${titulo} ===`);

  const base = {
    router: demoRouter(),
    rootDir,
    checkpointer: createSqliteCheckpointer(dbPath),
    reviewer: new MockReviewer({ rejectUntilAttempt: opts.rejectUntilAttempt }),
  };

  // 1. Instancia A: arranca. La REVISION corre primero; si aprueba, PAUSA en
  //    la aprobacion humana. Si rechaza, corrige (develop) y vuelve a revisar.
  const a = buildGraph(base);
  const paused = await a.invoke({ task: "sumar dos numeros" }, cfg);
  const interrupts = (paused as { __interrupt__?: unknown[] }).__interrupt__;
  console.log(`pausado en aprobacion humana: ${interrupts ? "SI" : "NO"}`);

  const stateA = await a.getState(cfg);
  console.log(`decision de revision: ${stateA.values.reviewDecision || "(n/a)"} · intentos: ${stateA.values.attempts}`);

  if (!interrupts) {
    console.log(`status: ${(paused as { status?: string }).status} · review: ${(paused as { review?: string }).review}`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }

  // 2. "Reinicio del proceso": instancia B nueva, mismo SQLite. Recupera estado.
  const b = buildGraph(base);
  const recovered = await b.getState(cfg);
  console.log(`recuperado tras reinicio: pendiente=${recovered.next.includes("approvalTask")}`);

  // 3. Reanuda con la decision humana (mismo thread_id).
  const final = await b.invoke(new Command({ resume: { action: opts.decision } }), cfg);
  const created = join(rootDir, "generated", "sum.js");
  console.log(`decision humana: ${opts.decision} · approvalPhase: ${final.approvalPhase} · status: ${final.status}`);
  console.log(`archivo creado: ${existsSync(created) ? "SI" : "NO"}`);

  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("=== saiki-ia (Fase 8): revision + correccion + aprobacion (demo en dir temporal) ===");
  // Revision aprueba al 1er intento -> aprobacion humana -> aplica.
  await runDemo("A: revision aprueba, humano aprueba", { decision: "approve", rejectUntilAttempt: 0 });
  // Revision rechaza el 1er intento, corrige, aprueba el 2do -> humano aprueba.
  await runDemo("B: revision rechaza, corrige, aprueba; humano aprueba", { decision: "approve", rejectUntilAttempt: 1 });
  // Revision aprueba pero el humano rechaza -> repo intacto.
  await runDemo("C: humano rechaza tras revision aprobada", { decision: "reject", rejectUntilAttempt: 0 });
  // Revision rechaza siempre -> rechazo definitivo por limite.
  await runDemo("D: rechazo persistente -> rechazo definitivo", { decision: "approve", rejectUntilAttempt: 99 });
}

main().catch((error: unknown) => {
  console.error("Error ejecutando el grafo:", error);
  process.exitCode = 1;
});
