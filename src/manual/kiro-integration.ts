/**
 * PRUEBA DE INTEGRACION MANUAL (opt-in) — NO se ejecuta en `npm test`.
 *
 * Valida el rol `analyze` contra Kiro CLI REAL (sesion SSO del entorno) dentro
 * del flujo completo de la Fase 6. develop usa Claude real; la aplicacion de
 * cambios va a un directorio TEMPORAL (nunca el repo), con aprobacion humana
 * simulada como "approve".
 *
 * Requisitos:
 *  1. `kiro-cli` instalado y con sesion SSO activa (`kiro-cli login`).
 *  2. `claude` instalado y autenticado.
 *
 * Ejecutar:  nvm use 22 && npm run manual:kiro
 *
 * Que esperar:
 *  - Sesion activa: el plan lo genera Kiro CLI real; el grafo PAUSA en la
 *    aprobacion; al aprobar, aplica en el dir temporal; status "approved".
 *  - Si Kiro falla: status "failed" con el error en `review` (sin fallback).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../graph.js";
import { createDefaultRouter } from "../agents/router.js";

async function main(): Promise<void> {
  console.log("=== Integracion manual: analyze con Kiro CLI real (flujo Fase 6) ===\n");

  const rootDir = mkdtempSync(join(tmpdir(), "saiki-kiro-"));
  const app = buildGraph({ router: createDefaultRouter(), rootDir });
  const cfg = { configurable: { thread_id: "manual-kiro" } };

  const paused = await app.invoke(
    { task: "Agregar una funcion sum(a, b) en JavaScript", failUntil: 0 },
    cfg,
  );

  const interrupted = Boolean((paused as { __interrupt__?: unknown[] }).__interrupt__);
  const state = await app.getState(cfg);
  console.log(`plan (Kiro real):\n${state.values.plan}\n`);
  console.log(`pausado en aprobacion: ${interrupted ? "SI" : "NO"}`);

  if (!interrupted) {
    console.log("\n[nota] No se llego a la aprobacion. Revisa kiro-cli login / salida de develop.");
    console.log(`status: ${(paused as { status?: string }).status}`);
    console.log(`review: ${(paused as { review?: string }).review}`);
    rmSync(rootDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  const final = await app.invoke(new Command({ resume: { action: "approve" } }), cfg);
  console.log(`\napprovalPhase: ${final.approvalPhase}`);
  console.log(`status:        ${final.status}`);
  console.log(`appliedFiles:  ${JSON.stringify(final.appliedFiles)}`);

  rmSync(rootDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error("Error en la prueba de integracion manual:", error);
  process.exitCode = 1;
});
