import type { AgentRouter } from "../agents/router.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import { extractAgentJson } from "../agents/agent-json.js";
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

/** Ejecuta el análisis técnico para una HU aprobada. */
export async function analyzeTechnical(
  router: AgentRouter,
  hu: AnalyzedHu,
  rootDir: string,
  /** (T8) Contexto congelado de la ejecución; sin él, el prompt es el de siempre. */
  projectContext?: string,
): Promise<TechAnalysisResult> {
  const agent = router.forRole("technicalAnalyst");
  const result = await agent.run({
    role: "technicalAnalyst",
    input: buildTechnicalPrompt(hu, rootDir, projectContext),
    // (Project Registry) El analista lee el repositorio de esta ejecución.
    context: { workingDirectory: rootDir },
  });

  if (result.status === "failure") {
    return { ok: false, error: `El analista técnico falló: ${result.error ?? "error desconocido"}` };
  }

  const parsed = extractAgentJson(result.output, (c) => validateTechnicalAnalysis(c, rootDir).ok);
  if (!parsed.ok) return { ok: false, error: `Análisis técnico no parseable: ${parsed.error}` };

  const validation = validateTechnicalAnalysis(parsed.value, rootDir);
  if (!validation.ok) {
    return { ok: false, error: `Análisis técnico inválido: ${validation.errors.join("; ")}` };
  }

  return { ok: true, analysis: validation.analysis, unresolvedPaths: validation.unresolvedPaths };
}
