import type { AgentRouter } from "../agents/router.js";
import { extractAgentJson } from "../agents/agent-json.js";
import { buildHuPrompt, buildHuRevisionPrompt } from "./hu-instructions.js";
import { validateHu, type AnalyzedHu } from "./hu-schema.js";

/**
 * Analista de HU (Fase 9).
 *
 * Usa el rol GENERICO `huAnalyst` del router (hoy Kiro CLI) para convertir una
 * solicitud en texto libre en una HU estructurada y VALIDADA contra el esquema.
 *
 * No hay fallback silencioso: si el agente falla, o la respuesta no es JSON, o
 * no cumple el esquema, se devuelve un error explicito.
 */

export type HuAnalysisResult =
  | { ok: true; hu: AnalyzedHu }
  | { ok: false; error: string };

async function runAndValidate(
  router: AgentRouter,
  prompt: string,
  workingDirectory?: string,
): Promise<HuAnalysisResult> {
  const agent = router.forRole("huAnalyst");
  const result = await agent.run({ role: "huAnalyst", input: prompt, context: workingDirectory ? { workingDirectory } : undefined });

  // Fallo de ejecucion del agente (p. ej. Kiro no disponible). Explicito.
  if (result.status === "failure") {
    return { ok: false, error: `El analista de HU fallo: ${result.error ?? "error desconocido"}` };
  }

  // Parseo del JSON de la respuesta.
  const parsed = extractAgentJson(result.output, (c) => validateHu(c).ok);
  if (!parsed.ok) return { ok: false, error: `Respuesta de HU no parseable: ${parsed.error}` };

  // Validacion contra el esquema. Un invalido NO se acepta.
  const validation = validateHu(parsed.value);
  if (!validation.ok) {
    return { ok: false, error: `HU invalida: ${validation.errors.join("; ")}` };
  }

  return { ok: true, hu: validation.hu };
}

/** Genera una HU estructurada a partir de una solicitud en texto libre. */
export function analyzeHu(router: AgentRouter, userStory: string, workingDirectory?: string): Promise<HuAnalysisResult> {
  return runAndValidate(router, buildHuPrompt(userStory), workingDirectory);
}

/** Regenera una HU a partir de la version previa y el feedback humano. */
export function reviseHu(
  router: AgentRouter,
  previousHu: AnalyzedHu,
  feedback: string,
  workingDirectory?: string,
): Promise<HuAnalysisResult> {
  return runAndValidate(router, buildHuRevisionPrompt(JSON.stringify(previousHu), feedback), workingDirectory);
}
