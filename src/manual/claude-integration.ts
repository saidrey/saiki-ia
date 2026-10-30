/**
 * PRUEBA DE INTEGRACION MANUAL (opt-in) — NO se ejecuta en `npm test`.
 *
 * Valida el rol `develop` contra Claude Code REAL en modo PROPUESTA:
 *  - Kiro CLI analiza (real).
 *  - Claude Code desarrolla: genera una PROPUESTA de codigo (real), SIN escribir.
 *  - review simulado.
 *
 * CRITERIO DE APROBACION (del PO): Claude genera una propuesta real y el
 * repositorio permanece INTACTO. Este script lo verifica tomando una "huella"
 * (ruta + tamaño + mtime) de todos los archivos de src/ ANTES y DESPUES, y
 * comparandolas. Si algo cambio, falla.
 *
 * Requisitos:
 *  - `claude` instalado y autenticado (ver `claude --version`).
 *  - `kiro-cli` con sesion SSO activa (`kiro-cli login`).
 *  - Node 22 (`nvm use 22`).
 *
 * Ejecutar:
 *     nvm use 22
 *     npm run manual:claude
 */
import { readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "@langchain/langgraph";
import { buildGraph } from "../graph.js";
import { createDefaultRouter } from "../agents/router.js";

/** Huella de un arbol de archivos: ruta -> "tamaño:mtimeMs". */
function fingerprint(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of fingerprint(full)) result.set(k, v);
    } else {
      const st = statSync(full);
      result.set(full, `${st.size}:${st.mtimeMs}`);
    }
  }
  return result;
}

function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, sig] of after) {
    if (!before.has(path)) changes.push(`NUEVO: ${path}`);
    else if (before.get(path) !== sig) changes.push(`MODIFICADO: ${path}`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`BORRADO: ${path}`);
  }
  return changes;
}

async function main(): Promise<void> {
  console.log("=== Integracion manual: develop con Claude real + aprobacion (Fase 6) ===\n");

  // El repo real NO debe cambiar nunca; los cambios aprobados van a un dir temporal.
  const watchedDir = "src";
  const before = fingerprint(watchedDir);
  console.log(`Huella tomada de ${before.size} archivos en ${watchedDir}/ (ANTES)\n`);

  const rootDir = mkdtempSync(join(tmpdir(), "saiki-claude-"));
  const app = buildGraph({ router: createDefaultRouter(), rootDir });
  const cfg = { configurable: { thread_id: "manual-claude" } };

  // 1. Arranca: Kiro analiza, Claude propone, y el grafo PAUSA en la aprobacion.
  const paused = await app.invoke(
    { task: "Agregar una funcion sum(a, b) en JavaScript", failUntil: 0 },
    cfg,
  );
  const interrupted = Boolean((paused as { __interrupt__?: unknown[] }).__interrupt__);
  console.log(`pausado en aprobacion: ${interrupted ? "SI" : "NO"}`);

  // Durante la pausa, el repo debe estar intacto (Claude no escribe).
  const duringPause = diff(before, fingerprint(watchedDir));
  console.log(
    duringPause.length === 0
      ? "Durante la pausa: repo INTACTO."
      : `FALLO: repo cambio durante la pausa: ${duringPause.join(", ")}`,
  );

  if (!interrupted) {
    console.log(`\n[nota] No se llego a aprobacion. status=${(paused as { status?: string }).status}`);
    console.log(`review: ${(paused as { review?: string }).review}`);
    rmSync(rootDir, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  // 2. Aprueba: aplica SOLO en el dir temporal, nunca en el repo.
  const final = await app.invoke(new Command({ resume: { action: "approve" } }), cfg);
  console.log(`\napprovalPhase: ${final.approvalPhase}`);
  console.log(`status:        ${final.status}`);
  console.log(`appliedFiles (en dir temporal): ${JSON.stringify(final.appliedFiles)}`);

  // 3. Verificacion final: el REPO sigue intacto pese a la aplicacion.
  const afterApply = diff(before, fingerprint(watchedDir));
  console.log("\n--- Integridad del repositorio ---");
  if (afterApply.length === 0) {
    console.log("OK: el repositorio permanece INTACTO (los cambios fueron al dir temporal).");
  } else {
    console.log("FALLO DE SEGURIDAD: el repo cambio:");
    for (const c of afterApply) console.log(`  - ${c}`);
    process.exitCode = 1;
  }

  rmSync(rootDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error("Error en la integracion manual con Claude:", error);
  process.exitCode = 1;
});
