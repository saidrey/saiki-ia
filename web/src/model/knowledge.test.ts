import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, labelOf, STATUS_LABEL, validFilter } from "./knowledge";

describe("knowledge", () => {
  it("etiquetas en español; un valor desconocido se muestra tal cual", () => {
    expect(labelOf(CATEGORY_LABEL, "decisions")).toBe("Decisiones");
    expect(labelOf(STATUS_LABEL, "approved")).toBe("Aprobado");
    expect(labelOf(CATEGORY_LABEL, "otra")).toBe("otra");
  });
  it("un filtro de la URL inválido se ignora (no se envía a la API)", () => {
    expect(validFilter(STATUS_LABEL, "approved")).toBe("approved");
    expect(validFilter(STATUS_LABEL, "<script>")).toBe("");
    expect(validFilter(STATUS_LABEL, null)).toBe("");
  });
});

// ── (T10) Conocimiento por proyecto: respuestas REALES del backend (script de validación de T10). ──
import type { ExecutionContextResponse, KnowledgeSearchResponse, KnowledgeVersionsResponse } from "../api/types";
import { compareBundles } from "./context";
import { groupDocuments, knowledgeErrorHint } from "./knowledge";
import project from "./fixtures/knowledge-project.json";
import versions from "./fixtures/knowledge-versions.json";
import exported from "./fixtures/knowledge-export.json";
import frozen from "./fixtures/execution-knowledge-context.json";

describe("conocimiento por proyecto", () => {
  const docs = (project as unknown as KnowledgeSearchResponse).documents;

  it("agrupa por documento: pendientes primero, luego convenciones, arquitectura y decisiones", () => {
    const g = groupDocuments(docs);
    expect(g.map((d) => [d.title, d.official?.version ?? null, d.pending?.version ?? null])).toEqual([
      ["Importes en céntimos", 1, 2],
      ["Usar Stripe para pagos", null, 1],
      ["Capas de la API", 1, null],
      ["Moneda única", null, null],
    ]);
    expect(g[0].versions.map((v) => v.status)).toEqual(["approved", "proposed"]);
    expect(g[3].versions[0].status).toBe("archived");
  });

  it("cada versión trae el hash que se aprueba; el historial va de la 1 a la última", () => {
    for (const d of docs) expect(d.versionHash).toMatch(/^[0-9a-f]{64}$/);
    const v = (versions as unknown as KnowledgeVersionsResponse).versions;
    expect(v.map((x) => [x.version, x.status, x.basedOn === null])).toEqual([
      [1, "approved", true],
      [2, "proposed", false],
    ]);
  });

  it("la exportación y el contexto congelado solo llevan lo aprobado, convenciones primero", () => {
    const md = (exported as { markdown: string }).markdown;
    expect(md.indexOf("## Importes en céntimos")).toBeLessThan(md.indexOf("## Capas de la API"));
    expect(md).not.toContain("Stripe");
    expect(md).not.toContain("Moneda única");
    const c = (frozen as unknown as ExecutionContextResponse).context;
    expect(c.technicalBundle).toContain("#### Importes en céntimos (convenciones, versión 1)");
    expect(c.technicalBundle).not.toContain("Stripe");
    // Claude recibe también la sección de conocimiento aprobado.
    expect(compareBundles(c.technicalBundle, c.developerBundle).find((s) => s.title === "Conocimiento aprobado")?.inDeveloper).toBe(true);
  });

  it("pistas para los errores que requieren una acción", () => {
    expect(knowledgeErrorHint("hash_mismatch")).toMatch(/Recarga/);
    expect(knowledgeErrorHint("stale_base")).toMatch(/vigente/);
    expect(knowledgeErrorHint("not_found")).toBeNull();
  });
});

// ── (T11) Project Analyst: respuesta REAL del backend con Kiro real (sandbox de betsweb). ──
import type { ProjectAnalysis, ProjectAnalysisResponse } from "../api/types";
import analysisFixture from "./fixtures/project-analysis-completed.json";
import { analysisSummary, originLabel } from "./knowledge";

describe("Project Analyst", () => {
  const real = (analysisFixture as ProjectAnalysisResponse).analysis!;

  it("resumen del análisis real: propuestas y referencias", () => {
    expect(real.status).toBe("completed");
    expect(analysisSummary(real)).toBe(`El análisis propuso ${real.proposed.length} documentos; revísalos abajo.`);
    expect(real.proposed.every((p) => p.citedFiles.length > 0 && p.version === 1 && p.basedOn === null)).toBe(true);
  });

  it("en curso, fallido, sin propuestas y con omitidos", () => {
    const base: ProjectAnalysis = { ...real, proposed: [], skipped: [] };
    expect(analysisSummary({ ...base, status: "running" })).toBe("Analizando el repositorio en solo lectura…");
    expect(analysisSummary({ ...base, status: "failed", error: "x" })).toBe("El análisis falló; no se guardó ninguna propuesta.");
    expect(analysisSummary(base)).toBe("El análisis terminó sin propuestas.");
    expect(analysisSummary({ ...base, proposed: real.proposed.slice(0, 1), skipped: [{ title: "t", basedOn: "b", reason: "r" }] })).toBe(
      "El análisis propuso 1 documento; revísalo abajo. 1 omitido porque ya tenía una propuesta pendiente.",
    );
  });

  it("el autor de agente se distingue de una persona; pistas de error del análisis", () => {
    expect(originLabel("projectAnalyst")).toBe("Project Analyst (agente)");
    expect(originLabel("said")).toBe("said");
    expect(knowledgeErrorHint("no_snapshot")).toMatch(/Escanea/);
    expect(knowledgeErrorHint("analysis_running")).toMatch(/Espera/);
  });
});
