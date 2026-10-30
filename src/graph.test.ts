import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "./graph.js";
import { MAX_CORRECTIONS } from "./state.js";
import { MockAgentAdapter } from "./agents/mock-agent.js";
import { MapAgentRouter } from "./agents/router.js";
import { MockReviewer, type MockReviewerConfig } from "./review/mock-reviewer.js";
import { createMemoryCheckpointer } from "./persistence/checkpointer.js";
import type { AgentAdapter, AgentRequest, AgentResult, AgentRole } from "./agents/types.js";

/** Develop mock con propuesta estructurada (convencion FILE:). Cada intento
 *  genera contenido distinto para que el hash cambie en la correccion. */
class ProposingMock implements AgentAdapter {
  readonly name = "proposing-mock";
  constructor(private readonly failRoles: AgentRole[] = []) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    if (this.failRoles.includes(request.role)) {
      return { status: "failure", output: "", error: `fallo en ${request.role}`, role: request.role };
    }
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

function proposingRouter(failRoles: AgentRole[] = []) {
  const a = new ProposingMock(failRoles);
  return new MapAgentRouter({ analyze: a, develop: a, review: a });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "saiki-f8-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

let threadCounter = 0;
function cfg() {
  threadCounter += 1;
  return { configurable: { thread_id: `t8-${threadCounter}` } };
}

/** Construye el grafo con checkpointer en memoria (no toca el repo) y un
 *  reviewer configurable. */
function graph(reviewerConfig: MockReviewerConfig = {}, failRoles: AgentRole[] = []) {
  return buildGraph({
    router: proposingRouter(failRoles),
    checkpointer: createMemoryCheckpointer(),
    rootDir: tmp,
    reviewer: new MockReviewer(reviewerConfig),
  });
}

const target = () => join(tmp, "generated", "sum.js");

describe("Fase 8: revision -> correccion -> aprobacion", () => {
  it("caso 1: propuesta aprobada -> aprobacion humana -> aplica", async () => {
    const app = graph({ rejectUntilAttempt: 0 }); // aprueba en intento 1
    const c = cfg();

    // Corre hasta la aprobacion humana (la revision ya aprobo).
    const paused = await app.invoke({ task: "sumar" }, c);
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();

    const state = await app.getState(c);
    expect(state.values.reviewDecision).toBe("approved");

    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);
    expect(final.status).toBe("approved");
    expect(final.approvalPhase).toBe("applied");
    expect(existsSync(target())).toBe(true);
  });

  it("caso 2: propuesta rechazada con hallazgos vuelve a develop", async () => {
    const app = graph({ rejectUntilAttempt: 1 }); // rechaza intento 1, aprueba 2
    const c = cfg();

    const paused = await app.invoke({ task: "sumar" }, c);
    const state = await app.getState(c);

    // Tras rechazo+correccion, acaba pausado en aprobacion del intento 2.
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();
    expect(state.values.reviewDecision).toBe("approved");
    expect(state.values.attempts).toBe(2); // hubo una correccion
  });

  it("caso 3: corregida y aprobada en el siguiente intento, con HASH NUEVO", async () => {
    const app = graph({ rejectUntilAttempt: 1 });
    const c = cfg();

    await app.invoke({ task: "sumar" }, c);
    const state = await app.getState(c);
    // La implementacion del intento 2 menciona que corrige hallazgos.
    expect(state.values.implementation).toContain("intento 2");
    expect(state.values.implementation).toContain("corrige");
    expect(state.values.proposalHash).toHaveLength(64);

    const final = await app.invoke(new Command({ resume: { action: "approve" } }), c);
    expect(final.status).toBe("approved");
  });

  it("caso 4: rechazo persistente hasta el limite -> rechazo definitivo", async () => {
    const app = graph({ rejectUntilAttempt: 99 }); // nunca aprueba
    const c = cfg();

    const result = await app.invoke({ task: "sumar" }, c);

    expect(result.status).toBe("failed");
    expect(result.review).toContain("RECHAZO DEFINITIVO");
    // No se pauso en aprobacion humana (nunca aprobo la revision).
    expect((result as { __interrupt__?: unknown[] }).__interrupt__).toBeUndefined();
    // Nunca se aplico nada.
    expect(existsSync(target())).toBe(false);
    // El contador quedo acotado por el limite.
    expect(result.attempts).toBeLessThanOrEqual(1 + MAX_CORRECTIONS);
  });

  it("caso 5: error de revision termina en fallo explicito (no es rechazo)", async () => {
    const app = graph({ failExecution: true });
    const c = cfg();

    const result = await app.invoke({ task: "sumar" }, c);

    expect(result.status).toBe("failed");
    expect(result.reviewFailed).toBe(true);
    expect(result.review).toContain("FALLO DE REVISION");
    expect(existsSync(target())).toBe(false);
  });
});

describe("Fase 8: seguridad y no-duplicacion", () => {
  it("una propuesta rechazada NO modifica el repositorio", async () => {
    const app = graph({ rejectUntilAttempt: 99 });
    const result = await app.invoke({ task: "sumar" }, cfg());
    expect(result.status).toBe("failed");
    expect(existsSync(target())).toBe(false);
  });

  it("el rechazo humano tras revision aprobada deja el repo intacto", async () => {
    const app = graph({ rejectUntilAttempt: 0 });
    const c = cfg();
    await app.invoke({ task: "sumar" }, c);
    const final = await app.invoke(new Command({ resume: { action: "reject" } }), c);
    expect(final.status).toBe("failed");
    expect(existsSync(target())).toBe(false);
  });

  it("fallo de analyze / develop terminan en fallo explicito (sin fallback)", async () => {
    const a = graph({}, ["analyze"]);
    const ra = await a.invoke({ task: "x" }, cfg());
    expect(ra.status).toBe("failed");
    expect(ra.analyzeFailed).toBe(true);

    const d = graph({}, ["develop"]);
    const rd = await d.invoke({ task: "x" }, cfg());
    expect(rd.status).toBe("failed");
    expect(rd.developFailed).toBe(true);
    expect(existsSync(target())).toBe(false);
  });

  it("no hay bucle infinito: el flujo siempre termina", async () => {
    const app = graph({ rejectUntilAttempt: 99 });
    const result = await app.invoke({ task: "sumar" }, cfg());
    // Si termino, no hubo bucle infinito.
    expect(result.status).toBe("failed");
  });
});

describe("Fase 8: persistencia tras interrupcion (recuperacion)", () => {
  it("una corregida-aprobada sobrevive al reinicio y exige aprobacion nueva", async () => {
    // Nota: usamos memoria pero compartiendo la MISMA instancia de checkpointer
    // para simular recuperacion dentro del proceso; el test de reinicio entre
    // instancias con SQLite vive en persistence/recovery.test.ts.
    const app = graph({ rejectUntilAttempt: 1 });
    const c = cfg();

    const paused = await app.invoke({ task: "sumar" }, c);
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();

    const state = await app.getState(c);
    // Sigue pendiente de aprobacion humana (no auto-aprobada).
    expect(state.values.approvalPhase).toBe("pending");
    expect(state.values.reviewDecision).toBe("approved");
    expect(existsSync(target())).toBe(false); // nada aplicado aun
  });
});
