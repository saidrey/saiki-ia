import { describe, it, expect } from "vitest";
import { BasicModerator } from "./basic-moderator.js";
import { createModeratorSession, addUserTurn, linkDelegatedTask } from "./session.js";
import { createDelegatedTask } from "./delegation.js";
import { runDelegatedTask } from "./delegation-runner.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import type { AgentAdapter } from "../agents/types.js";

const moderator = new BasicModerator();

describe("Fase 14: moderador (clasificación y límites)", () => {
  it("4. distingue conversation / assistance / development", () => {
    const s = createModeratorSession("s1");
    expect(moderator.classify("¿cómo funciona el checkpointer de LangGraph?", s).category).toBe("conversation");
    expect(moderator.classify("investiga las opciones de colas de mensajes", s).category).toBe("assistance");
    expect(moderator.classify("implementa un endpoint de health check", s).category).toBe("development");
  });

  it("5. una consulta conversacional NO inicia un flujo de desarrollo", () => {
    const s = createModeratorSession("s2");
    const decision = moderator.handle("¿qué patrón usamos para el router de agentes?", s);
    expect(decision.classification.category).toBe("conversation");
    expect(decision.startDevelopment).toBe(false);
    expect(decision.classification.developmentAuthorized).toBe(false);
  });

  it("5b. una conversación evoluciona a desarrollo SOLO con autorización explícita", () => {
    const s = createModeratorSession("s3");
    // Pregunta técnica: no desarrolla.
    expect(moderator.handle("¿sería viable un sistema de colas?", s).startDevelopment).toBe(false);
    // Autorización explícita: ahora sí marca desarrollo.
    const authorized = moderator.handle("autorizo, procede con el desarrollo", s);
    expect(authorized.startDevelopment).toBe(true);
    expect(authorized.classification.developmentAuthorized).toBe(true);
  });

  it("la sesión acumula turnos sin duplicar estado de flujos", () => {
    let s = createModeratorSession("s4");
    s = addUserTurn(s, "hola", moderator.classify("hola", s));
    s = linkDelegatedTask(s, "task-1");
    s = linkDelegatedTask(s, "task-1"); // idempotente
    expect(s.turns).toHaveLength(1);
    expect(s.delegatedTaskIds).toEqual(["task-1"]);
  });
});

describe("Fase 14: delegación de tareas", () => {
  function router(extra?: Record<string, AgentAdapter>) {
    const mock = new MockAgentAdapter();
    return new MapAgentRouter(
      { analyze: mock, develop: mock, review: mock, assistant: mock },
      extra,
    );
  }

  it("6. una tarea auxiliar puede delegarse y ejecutarse (solo lectura)", async () => {
    const task = createDelegatedTask({
      id: "t1", request: "investiga X", goal: "comparar librerías",
      agentRole: "assistant", runtime: "opencode",
      requiredCapabilities: ["read_repo", "external_docs"],
      grantedCapabilities: ["read_repo", "external_docs", "read_kb"],
    });
    const done = await runDelegatedTask(task, router());
    expect(done.status).toBe("succeeded");
    expect(done.result).toBeTruthy();
  });

  it("7. la tarea delegada conserva contexto, rol, runtime y permisos", async () => {
    const task = createDelegatedTask({
      id: "t2", request: "r", goal: "g", context: { projectId: "p42" },
      agentRole: "assistant", runtime: "opencode",
      requiredCapabilities: ["read_kb"], grantedCapabilities: ["read_kb"],
      memoryRefs: ["doc-1"],
    });
    const done = await runDelegatedTask(task, router());
    expect(done.context).toEqual({ projectId: "p42" });
    expect(done.agentRole).toBe("assistant");
    expect(done.runtime).toBe("opencode");
    expect(done.grantedCapabilities).toEqual(["read_kb"]);
    expect(done.memoryRefs).toEqual(["doc-1"]);
  });

  it("13. permisos insuficientes -> BLOQUEADA, no se ejecuta", async () => {
    const task = createDelegatedTask({
      id: "t3", request: "r", goal: "g",
      agentRole: "assistant", runtime: "opencode",
      requiredCapabilities: ["read_repo", "external_docs"],
      grantedCapabilities: ["read_repo"], // falta external_docs
    });
    const done = await runDelegatedTask(task, router());
    expect(done.status).toBe("blocked");
    expect(done.result).toBeUndefined();
    expect(done.errors.join(" ")).toContain("external_docs");
  });

  it("12. una tarea auxiliar NO puede tener apply_changes (no escribe el repo)", async () => {
    const task = createDelegatedTask({
      id: "t4", request: "r", goal: "g",
      agentRole: "assistant", runtime: "opencode",
      requiredCapabilities: ["read_repo"],
      grantedCapabilities: ["read_repo", "apply_changes"], // indebido
    });
    const done = await runDelegatedTask(task, router());
    expect(done.status).toBe("blocked");
    expect(done.errors.join(" ")).toContain("apply_changes");
  });

  it("el resultado de un agente NO es una decisión aprobada por sí mismo", async () => {
    const task = createDelegatedTask({
      id: "t5", request: "r", goal: "g",
      agentRole: "assistant", runtime: "opencode",
      requiredCapabilities: ["read_kb"], grantedCapabilities: ["read_kb"],
    });
    const done = await runDelegatedTask(task, router());
    // El contrato solo tiene 'result' (dato), no hay ningún campo que lo marque
    // como aprobado. La promoción a conocimiento oficial es un paso humano aparte.
    expect(done.status).toBe("succeeded");
    expect(done).not.toHaveProperty("approved");
  });
});
