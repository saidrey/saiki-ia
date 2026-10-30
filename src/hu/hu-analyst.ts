import type { AgentRouter } from "../agents/router.js";
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

/** Extrae el primer objeto JSON de un texto (tolera ```json o texto extra). */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Quita cercas de codigo si las hubiera.
  const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("la respuesta no contiene un objeto JSON");
  }
  return JSON.parse(withoutFences.slice(start, end + 1));
}

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
  let candidate: unknown;
  try {
    candidate = extractJson(result.output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Respuesta de HU no parseable: ${msg}` };
  }

  // Validacion contra el esquema. Un invalido NO se acepta.
  const validation = validateHu(candidate);
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
