import type { AgentRouter } from "../agents/router.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import { buildTechnicalPrompt } from "./tech-instructions.js";
import { validateTechnicalAnalysis, type TechnicalAnalysis } from "./tech-schema.js";

/**
 * Analista técnico (Fase 10).
 *
 * Usa el rol `technicalAnalyst` del router (Kiro CLI con fs_read, solo lectura)
 * para producir un análisis técnico estructurado y VALIDADO contra el esquema,
 * incluida la verificación de rutas en disco.
 *
 * Sin fallback silencioso: si el agente falla, la respuesta no es JSON o no
 * cumple el esquema, se devuelve un error explícito.
 */

export type TechAnalysisResult =
  | { ok: true; analysis: TechnicalAnalysis; unresolvedPaths: string[] }
  | { ok: false; error: string };

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("la respuesta no contiene un objeto JSON");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Ejecuta el análisis técnico para una HU aprobada. */
export async function analyzeTechnical(
  router: AgentRouter,
  hu: AnalyzedHu,
  rootDir: string,
): Promise<TechAnalysisResult> {
  const agent = router.forRole("technicalAnalyst");
  const result = await agent.run({
    role: "technicalAnalyst",
    input: buildTechnicalPrompt(hu, rootDir),
    // (Project Registry) El analista lee el repositorio de esta ejecución.
    context: { workingDirectory: rootDir },
  });

  if (result.status === "failure") {
    return { ok: false, error: `El analista técnico falló: ${result.error ?? "error desconocido"}` };
  }

  let candidate: unknown;
  try {
    candidate = extractJson(result.output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Análisis técnico no parseable: ${msg}` };
  }

  const validation = validateTechnicalAnalysis(candidate, rootDir);
  if (!validation.ok) {
    return { ok: false, error: `Análisis técnico inválido: ${validation.errors.join("; ")}` };
  }

  return { ok: true, analysis: validation.analysis, unresolvedPaths: validation.unresolvedPaths };
}
