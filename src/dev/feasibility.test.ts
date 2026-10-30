import { describe, it, expect } from "vitest";
import { classifyFeasibility } from "./feasibility.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";

function analysis(partial: Partial<TechnicalAnalysis>): TechnicalAnalysis {
  return {
    summary: "s",
    currentFlow: "f",
    affectedFiles: [{ path: "src/x.ts", responsibility: "r", exists: true }],
    proposedChanges: [{ path: "src/x.ts", change: "c" }],
    traceability: [],
    dependencies: [],
    risks: [],
    openQuestions: [],
    ...partial,
  };
}

describe("Fase 11: classifyFeasibility (derivada del contenido)", () => {
  it("ready: hay cambios, sin preguntas ni rutas no verificables", () => {
    const r = classifyFeasibility(analysis({}), []);
    expect(r.feasibility).toBe("ready");
  });

  it("blocked: no hay cambios propuestos", () => {
    const r = classifyFeasibility(analysis({ proposedChanges: [] }), []);
    expect(r.feasibility).toBe("blocked");
    expect(r.reasons.join()).toContain("no propone cambios");
  });

  it("partially_ready: hay cambios pero tambien preguntas pendientes", () => {
    const r = classifyFeasibility(analysis({ openQuestions: ["¿de dónde sale a?"] }), []);
    expect(r.feasibility).toBe("partially_ready");
  });

  it("partially_ready: hay cambios pero rutas no verificables", () => {
    const r = classifyFeasibility(analysis({}), ["src/no-existe.ts"]);
    expect(r.feasibility).toBe("partially_ready");
  });

  it("las razones respaldan la clasificación (no son arbitrarias)", () => {
    const r = classifyFeasibility(analysis({ openQuestions: ["q1"] }), ["p1"]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
