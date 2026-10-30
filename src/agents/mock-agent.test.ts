import { describe, it, expect } from "vitest";
import { MockAgentAdapter } from "./mock-agent.js";
import type { AgentAdapter } from "./types.js";

describe("Fase 3: MockAgentAdapter (contrato AgentAdapter)", () => {
  it("cumple el contrato: tiene nombre y metodo run", () => {
    const agent: AgentAdapter = new MockAgentAdapter();
    expect(agent.name).toBe("mock");
    expect(typeof agent.run).toBe("function");
  });

  it("resultado exitoso: devuelve status 'success', output y sin error", async () => {
    const agent = new MockAgentAdapter();

    const result = await agent.run({
      role: "develop",
      input: "Agregar un boton de login",
    });

    expect(result.status).toBe("success");
    expect(result.role).toBe("develop");
    expect(result.output).toContain("Agregar un boton de login");
    expect(result.error).toBeUndefined();
  });

  it("produce un output distinto segun el rol", async () => {
    const agent = new MockAgentAdapter();

    const analyze = await agent.run({ role: "analyze", input: "X" });
    const develop = await agent.run({ role: "develop", input: "X" });
    const review = await agent.run({ role: "review", input: "X" });

    expect(analyze.output).toContain("Plan simulado");
    expect(develop.output).toContain("Implementacion simulada");
    expect(review.output).toContain("Revision simulada");
  });

  it("resultado fallido: el rol configurado para fallar devuelve 'failure' + error", async () => {
    const agent = new MockAgentAdapter({ failRoles: ["review"] });

    const result = await agent.run({
      role: "review",
      input: "Revisar el modulo de pagos",
    });

    expect(result.status).toBe("failure");
    expect(result.role).toBe("review");
    expect(result.output).toBe("");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("review");
  });

  it("el fallo es selectivo por rol: otros roles siguen teniendo exito", async () => {
    const agent = new MockAgentAdapter({ failRoles: ["review"] });

    const ok = await agent.run({ role: "analyze", input: "X" });
    const bad = await agent.run({ role: "review", input: "X" });

    expect(ok.status).toBe("success");
    expect(bad.status).toBe("failure");
  });

  it("no lanza excepciones en el camino de fallo (las reporta como AgentResult)", async () => {
    const agent = new MockAgentAdapter({ failRoles: ["analyze"] });

    // No debe lanzar: el fallo viaja dentro del resultado.
    await expect(
      agent.run({ role: "analyze", input: "X" }),
    ).resolves.toMatchObject({ status: "failure" });
  });
});
