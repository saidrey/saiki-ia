import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractAgentJson, jsonObjectCandidates } from "./agent-json.js";
import { MapAgentRouter } from "./router.js";
import type { AgentAdapter } from "./types.js";
import { runQualityReview } from "../reviewers/reviewers.js";
import { validateQualityReview } from "../reviewers/reviewer-schemas.js";
import { analyzeTechnical } from "../tech/tech-analyst.js";
import type { DevProposal } from "../dev/dev-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";

/**
 * Extracción de la respuesta JSON de un agente. Los casos reales son salidas
 * literales de Kiro capturadas en la validación E2E de Project Context.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const hasDecision = (c: unknown) => typeof c === "object" && c !== null && "decision" in c;

describe("extractAgentJson", () => {
  it("JSON solo, o con texto antes y después", () => {
    expect(extractAgentJson('{"decision":"approved"}', hasDecision)).toEqual({ ok: true, value: { decision: "approved" } });
    expect(extractAgentJson('Reviso el código.\n{"decision":"approved"}\nFin del análisis.', hasDecision)).toEqual({
      ok: true,
      value: { decision: "approved" },
    });
  });

  it("llaves en la prosa previa y posterior no interfieren", () => {
    const text = 'El payload emite `{ bookmakers, sports }` y no `{a:1}`.\n{"decision":"approved"}\nVer también { notas }.';
    expect(extractAgentJson(text, hasDecision)).toEqual({ ok: true, value: { decision: "approved" } });
  });

  it("llaves y comillas escapadas dentro de cadenas del JSON", () => {
    const json = '{"decision":"approved","summary":"usa \\"{\\" y } en el código {x}"}';
    expect(extractAgentJson(`Prefacio { roto\n${json}`, hasDecision)).toEqual({ ok: true, value: JSON.parse(json) });
  });

  it("bloques Markdown, con o sin etiqueta json y con texto alrededor", () => {
    const value = { decision: "rejected", findings: [{ a: 1 }] };
    for (const fence of ["```json", "```", "```JSON"]) {
      const text = `Resultado:\n\n${fence}\n${JSON.stringify(value, null, 2)}\n\`\`\`\nGracias.`;
      expect(extractAgentJson(text, hasDecision)).toEqual({ ok: true, value });
    }
  });

  it("varios objetos: se elige el que cumple el esquema; los internos no compiten", () => {
    const text = 'Ejemplo de formato: {"campo":"x"}\nRespuesta: {"decision":"approved","nested":{"decision":"otro"}}';
    expect(jsonObjectCandidates(text)).toHaveLength(2);
    expect(extractAgentJson(text, hasDecision)).toEqual({ ok: true, value: { decision: "approved", nested: { decision: "otro" } } });
  });

  it("dos objetos válidos distintos: ambiguo, se rechaza; repetidos idénticos: se acepta", () => {
    const amb = extractAgentJson('{"decision":"approved"} y luego {"decision":"rejected"}', hasDecision);
    expect(amb).toEqual({ ok: false, error: "la respuesta contiene 2 objetos JSON válidos distintos; no se elige uno" });
    expect(extractAgentJson('{"decision":"approved"}\n{"decision":"approved"}', hasDecision)).toEqual({ ok: true, value: { decision: "approved" } });
  });

  it("una comilla suelta en la prosa no oculta el JSON de las líneas siguientes", () => {
    const text = 'El campo se llama "status y acepta { valores }\n{"decision":"approved"}';
    expect(extractAgentJson(text, hasDecision)).toEqual({ ok: true, value: { decision: "approved" } });
  });

  it("salida de 1 MiB con miles de llaves sin cerrar: lineal y encuentra el JSON", () => {
    const prose = `texto { sin cerrar ${"x".repeat(180)}\n`.repeat(5_200);
    const started = performance.now();
    expect(extractAgentJson(`${prose}{"decision":"approved"}`, hasDecision)).toEqual({ ok: true, value: { decision: "approved" } });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("respuesta incompleta o sin JSON: error explícito", () => {
    const missing = { ok: false, error: "la respuesta no contiene un objeto JSON completo" };
    expect(extractAgentJson('{"decision":"approved","findings":[', hasDecision)).toEqual(missing);
    expect(extractAgentJson('{"decision":"approved","findings":[{"a":1},', hasDecision)).toEqual({
      ok: false,
      error: "la respuesta contiene un objeto JSON incompleto o mal cerrado",
    });
    expect(extractAgentJson("No pude completar la revisión.", hasDecision)).toEqual(missing);
    expect(extractAgentJson("[1,2,3]", hasDecision)).toEqual(missing);
    expect(extractAgentJson("{ esto no es json }", hasDecision)).toEqual(missing);
  });

  it("ningún objeto cumple el esquema: se devuelve el último para que el consumidor lo rechace", () => {
    expect(extractAgentJson('{"a":1} texto {"b":2}', hasDecision)).toEqual({ ok: true, value: { b: 2 } });
  });
});

// ── Consumidores con salidas reales ─────────────────────────────────────────

function routerReturning(role: string, output: string): MapAgentRouter {
  const agent: AgentAdapter = { name: "real-output", run: async (r) => ({ status: "success", role: r.role, output }) };
  return new MapAgentRouter({ analyze: agent, develop: agent, review: agent, [role]: agent });
}

const proposal: DevProposal = {
  summary: "s", technicalDecisions: [], changes: [], traceability: [], risks: [], dependencies: [], openQuestions: [], coveredCriteria: [], uncoveredCriteria: [],
};
const technical: TechnicalAnalysis = {
  summary: "t", currentFlow: "f", affectedFiles: [], proposedChanges: [], traceability: [], dependencies: [], risks: [], openQuestions: [],
} as unknown as TechnicalAnalysis;

describe("casos reales (salidas literales de Kiro en la validación E2E)", () => {
  it("revisor de calidad con `{ bookmakers, sports }` en la prosa: antes 'no parseable', ahora aprobado", async () => {
    const output = fixture("kiro-quality-review-braces.txt");
    expect(output).toContain("`{ bookmakers, sports }`");
    // El extractor anterior (de la primera `{` a la última `}`) fallaba con esta salida.
    expect(() => JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1))).toThrow();

    const r = await runQualityReview(routerReturning("qualityReviewer", output), proposal, technical, [], []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.review.decision).toBe("approved");
  });

  it("la misma respuesta truncada se rechaza explícitamente (nunca aprobación)", async () => {
    const output = fixture("kiro-quality-review-braces.txt");
    const cut = output.slice(0, output.lastIndexOf('"summary"'));
    const r = await runQualityReview(routerReturning("qualityReviewer", cut), proposal, technical, [], []);
    expect(r).toEqual({ ok: false, error: "Revisión de calidad no parseable: la respuesta contiene un objeto JSON incompleto o mal cerrado" });
  });

  it("un objeto con la forma incorrecta se rechaza con los errores del esquema", async () => {
    const r = await runQualityReview(routerReturning("qualityReviewer", 'Listo.\n{"decision":"maybe"}'), proposal, technical, [], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Revisión de calidad inválida: /);
    expect(validateQualityReview({ decision: "maybe" }).ok).toBe(false);
  });

  it("analista técnico: 11 bloques de texto con código en línea antes del JSON", async () => {
    const output = fixture("kiro-technical-analysis.txt");
    const hu = { summary: "s", need: "n", tasks: [], acceptanceCriteria: [], assumptions: [], openQuestions: [], dependencies: [] } as unknown as AnalyzedHu;
    const r = await analyzeTechnical(routerReturning("technicalAnalyst", output), hu, process.cwd());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.analysis.affectedFiles.map((f) => f.path)).toContain("src/context/context-store.ts");
  });
});
