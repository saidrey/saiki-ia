import type { AgentRouter } from "../agents/router.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { DevProposal } from "../dev/dev-schema.js";
import { buildFunctionalPrompt, buildQualityPrompt } from "./reviewer-instructions.js";
import {
  validateFunctionalReview,
  validateQualityReview,
  type FunctionalReview,
  type QualityReview,
} from "./reviewer-schemas.js";

/**
 * Analistas revisores (Fase 12). Llaman al rol correspondiente (Kiro, solo
 * lectura), parsean el JSON y validan. Sin fallback: fallo/invalido => error
 * explícito (nunca aprobación).
 */

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("la respuesta no contiene un objeto JSON");
  return JSON.parse(t.slice(s, e + 1));
}

export type FunctionalResult =
  | { ok: true; review: FunctionalReview }
  | { ok: false; error: string };

export async function runFunctionalReview(
  router: AgentRouter,
  hu: AnalyzedHu,
  proposal: DevProposal,
  workingDirectory?: string,
): Promise<FunctionalResult> {
  const agent = router.forRole("functionalReviewer");
  const res = await agent.run({
    role: "functionalReviewer",
    input: buildFunctionalPrompt(hu, proposal),
    context: workingDirectory ? { workingDirectory } : undefined,
  });
  if (res.status === "failure") {
    return { ok: false, error: `Revisor funcional falló: ${res.error ?? "error desconocido"}` };
  }
  let candidate: unknown;
  try {
    candidate = extractJson(res.output);
  } catch (e) {
    return { ok: false, error: `Revisión funcional no parseable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const v = validateFunctionalReview(candidate);
  if (!v.ok) return { ok: false, error: `Revisión funcional inválida: ${v.errors.join("; ")}` };
  return { ok: true, review: v.review };
}

export type QualityResult =
  | { ok: true; review: QualityReview }
  | { ok: false; error: string };

export async function runQualityReview(
  router: AgentRouter,
  proposal: DevProposal,
  technical: TechnicalAnalysis,
  constraints: string[],
  functionalFindings: FunctionalReview["findings"],
  workingDirectory?: string,
): Promise<QualityResult> {
  const agent = router.forRole("qualityReviewer");
  const res = await agent.run({
    role: "qualityReviewer",
    input: buildQualityPrompt(proposal, technical, constraints, functionalFindings),
    context: workingDirectory ? { workingDirectory } : undefined,
  });
  if (res.status === "failure") {
    return { ok: false, error: `Revisor de calidad falló: ${res.error ?? "error desconocido"}` };
  }
  let candidate: unknown;
  try {
    candidate = extractJson(res.output);
  } catch (e) {
    return { ok: false, error: `Revisión de calidad no parseable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const v = validateQualityReview(candidate);
  if (!v.ok) return { ok: false, error: `Revisión de calidad inválida: ${v.errors.join("; ")}` };
  return { ok: true, review: v.review };
}
