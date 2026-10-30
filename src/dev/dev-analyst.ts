import type { AgentRouter } from "../agents/router.js";
import { buildDevPrompt } from "./dev-instructions.js";
import {
  validateDevProposal,
  type DevContext,
  type DevProposal,
} from "./dev-schema.js";

/**
 * Desarrollador (Claude) — Fase 11.
 *
 * Usa el rol `develop` del router (Claude Code real, SIN escritura) para
 * generar una propuesta de implementación a partir del contexto estructurado.
 * Valida la propuesta contra el esquema y clasifica rutas. Sin fallback: si
 * Claude falla, la respuesta no es JSON o no cumple el esquema, error explícito.
 */

export type DevResult =
  | {
      ok: true;
      proposal: DevProposal;
      newFiles: string[];
      existingFiles: string[];
      unverifiablePaths: string[];
    }
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

export async function developProposal(
  router: AgentRouter,
  ctx: DevContext,
  rootDir: string,
): Promise<DevResult> {
  const agent = router.forRole("develop");
  const result = await agent.run({ role: "develop", input: buildDevPrompt(ctx), context: { workingDirectory: rootDir } });

  if (result.status === "failure") {
    return { ok: false, error: `El desarrollador (Claude) falló: ${result.error ?? "error desconocido"}` };
  }

  let candidate: unknown;
  try {
    candidate = extractJson(result.output);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Propuesta de desarrollo no parseable: ${msg}` };
  }

  const validation = validateDevProposal(candidate, rootDir);
  if (!validation.ok) {
    return { ok: false, error: `Propuesta de desarrollo inválida: ${validation.errors.join("; ")}` };
  }

  return {
    ok: true,
    proposal: validation.proposal,
    newFiles: validation.newFiles,
    existingFiles: validation.existingFiles,
    unverifiablePaths: validation.unverifiablePaths,
  };
}
