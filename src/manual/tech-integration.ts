/**
 * PRUEBA DE INTEGRACION MANUAL (opt-in) — NO se ejecuta en `npm test`.
 *
 * Valida de punta a punta, con AGENTES REALES (Kiro + Claude), el flujo completo
 * de las Fases 9 a 13:
 *   1. Analista de HU (Kiro) genera una HU estructurada.
 *   2. El usuario la revisa: aprobar / revisar con feedback / rechazar.
 *   3. Tras aprobar, corre el Analista Tecnico (Kiro, solo lectura).
 *   4. Clasificacion de viabilidad; si procede, Claude genera una PROPUESTA.
 *   5. Revisiones automaticas funcional y de calidad (Kiro, solo lectura).
 *   6. APROBACION HUMANA FINAL (Fase 13): approve / reject / request_changes.
 *   7. Si se aprueba, APLICACION SEGURA y verificacion posterior.
 *
 * SEGURIDAD DE ESCRITURA (Fase 13):
 *   - El ANALISIS lee el repo REAL (solo lectura).
 *   - La APLICACION escribe por defecto sobre una COPIA TEMPORAL del repo, NUNCA
 *     sobre el repo real.
 *   - Para aplicar sobre el repo REAL se exigen DOS autorizaciones deliberadas:
 *       (a) variable de entorno  SAIKI_APPLY_TO_REAL_REPO=1
 *       (b) confirmacion interactiva escribiendo exactamente: APLICAR EN REAL
 *     Si falta cualquiera de las dos, se usa la copia temporal.
 *
 * Sin mocks ni fallback: si un agente falla o devuelve algo invalido, termina
 * con error explicito.
 *
 * Requisitos:
 *   - `kiro-cli` instalado y con sesion SSO activa (`kiro-cli login`).
 *   - `claude` (Claude Code) disponible.
 *   - Node 22 (`nvm use 22`).
 *
 * Ejecutar (aplica en copia temporal, seguro por defecto):
 *     nvm use 22
 *     npm run manual:tech
 *
 * El objetivo es que un HUMANO inspeccione la CALIDAD de la salida real. Una
 * ejecucion exitosa NO demuestra por si sola que la propuesta sea buena.
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { readdirSync, statSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "@langchain/langgraph";
import { buildHuGraph } from "../hu/hu-graph.js";
import { createDefaultRouter } from "../agents/router.js";
import { createSqliteCheckpointer } from "../persistence/checkpointer.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";

/** Huella del arbol de archivos para detectar modificaciones (solo lectura). */
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
  for (const [p, s] of after) {
    if (!before.has(p)) changes.push(`NUEVO: ${p}`);
    else if (before.get(p) !== s) changes.push(`MODIFICADO: ${p}`);
  }
  for (const p of before.keys()) if (!after.has(p)) changes.push(`BORRADO: ${p}`);
  return changes;
}

/** Acumula lineas de evidencia (se vuelcan a un archivo al final). */
const evidence: string[] = [];
function log(line = ""): void {
  console.log(line);
  evidence.push(line);
}

function printHu(hu: AnalyzedHu): void {
  log("── Historia de Usuario (generada por Kiro) ──");
  log(`Resumen: ${hu.summary}`);
  log(`Necesidad: ${hu.need}`);
  log("Tareas:");
  hu.tasks.forEach((t) => log(`  ${t.order}. ${t.description}`));
  log("Criterios de aceptacion:");
  hu.acceptanceCriteria.forEach((a) => log(`  [${a.id}] ${a.description}`));
  log(`Supuestos: ${hu.assumptions.join(" | ") || "(ninguno)"}`);
  log(`Preguntas: ${hu.openQuestions.join(" | ") || "(ninguna)"}`);
  log(`Dependencias: ${hu.dependencies.join(" | ") || "(ninguna)"}`);
}

function printTech(tech: TechnicalAnalysis, unresolved: string[]): void {
  log("── Analisis Tecnico (generado por Kiro, solo lectura) ──");
  log(`Resumen: ${tech.summary}`);
  log(`Flujo actual: ${tech.currentFlow}`);
  log("Archivos afectados:");
  for (const f of tech.affectedFiles) {
    const mark = f.exists ? "EXISTE" : "NO VERIFICADO/NUEVO";
    log(`  [${mark}] ${f.path} — ${f.responsibility}`);
  }
  log("Cambios propuestos:");
  tech.proposedChanges.forEach((c) => log(`  - ${c.path}: ${c.change}`));
  log("Trazabilidad (HU <-> cambios):");
  tech.traceability.forEach((t) => log(`  - ${t.ref}: ${t.note}`));
  log(`Dependencias: ${tech.dependencies.join(" | ") || "(ninguna)"}`);
  log(`Riesgos: ${tech.risks.join(" | ") || "(ninguno)"}`);
  log(`Preguntas pendientes: ${tech.openQuestions.join(" | ") || "(ninguna)"}`);
  if (unresolved.length > 0) {
    log("Rutas NO verificables / inexistentes (reportadas, no inventadas):");
    unresolved.forEach((p) => log(`  - ${p}`));
  } else {
    log("Todas las rutas referenciadas se verificaron en disco.");
  }
}

/**
 * Prompter resiliente: funciona en terminal interactivo Y con stdin por pipe.
 * Encola las lineas que llegan; `ask` espera la siguiente (o "" si stdin cerro).
 */
function makePrompter() {
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;

  const rl = createInterface({ input: stdin });
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) (waiters.shift() as (l: string) => void)("");
  });

  return {
    async ask(prompt: string): Promise<string> {
      stdout.write(prompt);
      if (queue.length) return queue.shift() as string;
      if (closed) return "";
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

function printDev(p: import("../dev/dev-schema.js").DevProposal, newF: string[], existF: string[], unver: string[]): void {
  log("── Propuesta de implementacion (generada por Claude) ──");
  log(`Resumen: ${p.summary}`);
  log("Decisiones tecnicas:");
  p.technicalDecisions.forEach((d) => log(`  - ${d}`));
  log("Cambios propuestos:");
  for (const ch of p.changes) {
    const mark = ch.exists ? "MODIFICA EXISTENTE" : "NUEVO";
    log(`  [${ch.operation}/${mark}] ${ch.path} (${ch.content.length} bytes)`);
  }
  log(`Archivos nuevos: ${newF.join(", ") || "(ninguno)"}`);
  log(`Archivos existentes: ${existF.join(", ") || "(ninguno)"}`);
  log(`Rutas no verificables: ${unver.join(", ") || "(ninguna)"}`);
  log("Trazabilidad:");
  p.traceability.forEach((t) => log(`  - ${t.ref}: ${t.note}`));
  log(`Criterios cubiertos: ${p.coveredCriteria.join(", ") || "(ninguno)"}`);
  log("Criterios NO cubiertos:");
  p.uncoveredCriteria.forEach((u) => log(`  - ${u.id}: ${u.reason}`));
  log(`Riesgos: ${p.risks.join(" | ") || "(ninguno)"}`);
  log(`Preguntas: ${p.openQuestions.join(" | ") || "(ninguna)"}`);
}

/** Separa las rutas de la propuesta por operacion (para presentarlas). */
function splitProposalChanges(p: import("../dev/dev-schema.js").DevProposal): {
  created: string[];
  modified: string[];
  deleted: string[];
} {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const ch of p.changes) {
    if (ch.operation === "create") created.push(ch.path);
    else if (ch.operation === "modify") modified.push(ch.path);
    else deleted.push(ch.path);
  }
  return { created, modified, deleted };
}

/** Informa el resultado de la aplicacion y la verificacion posterior. */
function reportApplication(
  fin: Record<string, unknown>,
  target: ApplyTarget,
): void {
  const phase = fin.phase as string;
  log("\n── Resultado de la aplicacion (Fase 13) ──");
  switch (phase) {
    case "applied":
      log("APLICADO con exito. La verificacion posterior confirma que el repo");
      log("coincide con la propuesta aprobada.");
      break;
    case "applied_with_test_failures":
      log("APLICADO, pero los tests/typecheck del proyecto FALLARON. La escritura");
      log("fue correcta; revisa los checks del proyecto.");
      break;
    case "rolled_back":
      log("FALLO al aplicar. Se REVIRTIERON los cambios parciales (rollback OK):");
      log("el destino quedo en su estado anterior.");
      break;
    case "unrecoverable":
      log("FALLO al aplicar Y el rollback NO se completo (UNRECOVERABLE).");
      log("Revision manual requerida. NO se reporta exito.");
      break;
    case "apply_blocked":
      log("BLOQUEADO antes de escribir (hash no coincide / propuesta invalida).");
      break;
    case "final_approval_rejected":
      log("Propuesta RECHAZADA en la aprobacion final. No se aplico nada.");
      break;
    case "dev_proposed":
      log("Se solicitaron CAMBIOS: la propuesta volvio al desarrollador y se");
      log("re-revisara. No se aplico nada.");
      break;
    default:
      log(`Estado: ${phase}`);
  }

  const audit = fin.auditRecord as Record<string, unknown> | null;
  if (audit) {
    log("\n── Auditoria (sin secretos) ──");
    log(`  applicationId: ${audit.applicationId}`);
    log(`  approvedHash: ${audit.approvedHash}`);
    log(`  decision humana: ${audit.humanDecision}`);
    log(`  outcome: ${audit.applyOutcome}`);
    log(`  archivos afectados: ${(audit.affectedFiles as string[]).join(", ") || "(ninguno)"}`);
    if (audit.verificationSummary) log(`  verificacion: ${audit.verificationSummary}`);
    if (audit.rollbackSummary) log(`  rollback: ${audit.rollbackSummary}`);
  }

  const verification = fin.verification as Record<string, unknown> | null;
  if (verification) {
    log("\n── Verificacion de contenido ──");
    log(`  coincide con lo aprobado: ${verification.filesMatch ? "SI" : "NO"}`);
    const mismatches = verification.mismatches as string[];
    if (mismatches.length) mismatches.forEach((m) => log(`  discrepancia: ${m}`));
  }

  if (!target.isRealRepo && target.tempDir) {
    log(`\nLos cambios se aplicaron en la COPIA TEMPORAL: ${target.tempDir}`);
    log("Puedes inspeccionarla manualmente. El repo real NO fue modificado.");
  }
}

/** Resultado de resolver el destino de aplicacion (copia temporal o repo real). */
interface ApplyTarget {
  applyDir: string;
  label: string;
  isRealRepo: boolean;
  /** Si es copia temporal, directorio a limpiar al final (o conservar). */
  tempDir?: string;
}

/**
 * (Fase 13) Decide DONDE se aplican los cambios con PROTECCION explicita contra
 * el repo real. Por defecto crea una copia temporal del repo (subset relevante:
 * `src`, para que modify/delete tengan base) y aplica alli.
 *
 * Para aplicar sobre el repo REAL exige DOS autorizaciones deliberadas:
 *   (a) SAIKI_APPLY_TO_REAL_REPO=1 en el entorno, y
 *   (b) escribir exactamente "APLICAR EN REAL" cuando se pregunte.
 * Si falta cualquiera, cae a la copia temporal (seguro por defecto).
 */
async function resolveApplyTarget(
  rl: ReturnType<typeof makePrompter>,
  realRepo: string,
): Promise<ApplyTarget> {
  const envOptIn = process.env.SAIKI_APPLY_TO_REAL_REPO === "1";

  if (envOptIn) {
    log("[AVISO] SAIKI_APPLY_TO_REAL_REPO=1 detectado: se solicita aplicar en el REPO REAL.");
    const confirm = (await rl.ask('Para aplicar en el repo REAL escribe exactamente "APLICAR EN REAL": ')).trim();
    if (confirm === "APLICAR EN REAL") {
      return { applyDir: realRepo, label: "REPO REAL (doble autorizacion confirmada)", isRealRepo: true };
    }
    log("Confirmacion no coincide. Se usara una copia temporal (seguro por defecto).");
  }

  // Copia temporal: clonamos el arbol `src/` (estado base para modify/delete).
  const tempDir = mkdtempSync(join(tmpdir(), "saiki-apply-copy-"));
  const srcReal = join(realRepo, "src");
  if (existsSync(srcReal)) {
    cpSync(srcReal, join(tempDir, "src"), { recursive: true });
  }
  return {
    applyDir: tempDir,
    label: "COPIA TEMPORAL del repo (el repo real NO se toca)",
    isRealRepo: false,
    tempDir,
  };
}

async function main(): Promise<void> {
  log("=== Integracion manual Fases 9-13: HU + Tecnico + Desarrollo + Revisiones + Aplicacion ===");
  log(`Fecha: ${new Date().toISOString()}`);
  log("");

  const rl = makePrompter();

  // Pedimos la solicitud (o usamos un ejemplo por defecto).
  const defaultRequest = "Agrega un boton azul que calcule la suma de a+b";
  const typed = (await rl.ask(`Solicitud de HU [${defaultRequest}]: `)).trim();
  const request = typed.length > 0 ? typed : defaultRequest;
  log(`Solicitud: ${request}`);

  // Integridad del repo: huella ANTES (solo lectura, no debe cambiar).
  const watchedDir = "src";
  const before = fingerprint(watchedDir);
  log(`Huella de ${before.size} archivos en ${watchedDir}/ (ANTES).`);
  log("");

  // El analisis tecnico LEE el repo REAL (solo lectura). rootDir = cwd.
  // El checkpointer SQLite va a un dir TEMPORAL para no dejar estado de prueba
  // en el repo (persistencia real reutilizada, pero aislada de esta corrida).
  const cpDir = mkdtempSync(join(tmpdir(), "saiki-tech-cp-"));

  // (Fase 13) Resolvemos DONDE se aplicaran los cambios ANTES de construir el
  // grafo. Por defecto: una COPIA TEMPORAL del repo. Solo con doble
  // autorizacion deliberada se escribe sobre el repo real.
  const applyTarget = await resolveApplyTarget(rl, process.cwd());
  log(`Destino de aplicacion: ${applyTarget.label}`);
  log(`  (ruta: ${applyTarget.applyDir})`);
  log("");

  const app = buildHuGraph({
    router: createDefaultRouter(),
    checkpointer: createSqliteCheckpointer(join(cpDir, "cp.sqlite")),
    rootDir: process.cwd(),
    applyDir: applyTarget.applyDir,
  });
  const cfg = { configurable: { thread_id: `manual-tech-${Date.now()}` } };

  // Lanza el flujo; se detiene en la aprobacion de la HU.
  await app.invoke({ request }, cfg);
  let guard = 0;

  // Ciclo de revision humana de la HU.
  while (guard < 10) {
    guard += 1;
    const state = await app.getState(cfg);
    const phase = state.values.phase;

    if (phase === "failed") {
      log(`\n[ERROR] El analista de HU fallo: ${state.values.error}`);
      log("Termino con error explicito (sin fallback).");
      await rl.close();
      finishEvidence(1, cpDir);
      return;
    }

    if (phase !== "pending_review") break; // ya no espera decision de HU

    printHu(state.values.hu as AnalyzedHu);
    log("");
    const decision = (await rl.ask("Decision [approve / revise / reject]: ")).trim().toLowerCase();

    if (decision === "approve") {
      log("Decision: approve");
      await app.invoke(new Command({ resume: { action: "approve" } }), cfg);
      break;
    }
    if (decision === "revise") {
      const feedback = (await rl.ask("Feedback para la revision: ")).trim();
      log(`Decision: revise — feedback: ${feedback}`);
      await app.invoke(new Command({ resume: { action: "revise", feedback } }), cfg);
      continue;
    }
    log("Decision: reject");
    await app.invoke(new Command({ resume: { action: "reject" } }), cfg);
    break;
  }

  // Mantenemos el prompter abierto: aun podemos necesitar decisiones (partial,
  // aprobacion de propuesta). Alias para legibilidad del resto del flujo.
  const rl2 = rl;

  const finalState = await app.getState(cfg);
  const phase = finalState.values.phase;
  log("");

  if (phase === "rejected" || phase === "revision_limit") {
    log(`HU no aprobada (phase=${phase}). El analisis tecnico NO se ejecuta.`);
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(0, cpDir);
    return;
  }

  if (phase === "tech_failed") {
    log(`[ERROR] El analista tecnico fallo: ${finalState.values.error}`);
    log("Termino con error explicito (sin fallback ni mock).");
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(1, cpDir);
    return;
  }

  // A partir de aquí la HU fue aprobada: mostramos el análisis técnico y la
  // clasificación de viabilidad, y continuamos segun corresponda.
  if (finalState.values.technicalAnalysis) {
    log("HU aprobada -> analisis tecnico ejecutado.\n");
    printTech(
      finalState.values.technicalAnalysis as TechnicalAnalysis,
      finalState.values.unresolvedPaths,
    );
    log(`\nViabilidad: ${finalState.values.feasibility}`);
    finalState.values.feasibilityReasons.forEach((r: string) => log(`  - ${r}`));
  }

  // Si quedó pausado pidiendo decisión por partially_ready, la tomamos.
  if (finalState.next.includes("partialDecisionTask")) {
    const dec = (await rl2.ask("\nViabilidad partially_ready. [proceed / cancel]: ")).trim().toLowerCase();
    log(`Decision partial: ${dec}`);
    await app.invoke(new Command({ resume: { action: dec === "proceed" ? "proceed" : "cancel" } }), cfg);
  }

  const afterDev = await app.getState(cfg);
  const dphase = afterDev.values.phase;
  log("");

  if (dphase === "blocked") {
    log("Flujo DETENIDO: viabilidad no habilita desarrollo. Claude NO se ejecuto.");
    if (afterDev.values.error) log(`Motivo: ${afterDev.values.error}`);
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(0, cpDir);
    return;
  }

  if (dphase === "dev_failed") {
    log(`[ERROR] El desarrollador (Claude) fallo: ${afterDev.values.error}`);
    log("Termino con error explicito (sin fallback ni mock).");
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(1, cpDir);
    return;
  }

  if (dphase === "dev_proposed") {
    log("Claude genero una PROPUESTA valida.\n");
    printDev(
      afterDev.values.devProposal as import("../dev/dev-schema.js").DevProposal,
      afterDev.values.devNewFiles,
      afterDev.values.devExistingFiles,
      afterDev.values.devUnverifiablePaths,
    );
  }

  // (Fase 12) Mostrar las revisiones que se hayan ejecutado.
  if (afterDev.values.functionalReview) {
    const fr = afterDev.values.functionalReview;
    log(`\n── Revision FUNCIONAL: ${fr.decision} ──`);
    log(`  Resumen: ${fr.summary}`);
    if (fr.unmetCriteria.length) log(`  Incumplidos: ${fr.unmetCriteria.join(", ")}`);
    if (fr.requiredChanges.length) log(`  Cambios requeridos: ${fr.requiredChanges.join("; ")}`);
  }
  if (afterDev.values.qualityReview) {
    const qr = afterDev.values.qualityReview;
    log(`\n── Revision de CALIDAD: ${qr.decision} ──`);
    log(`  Resumen: ${qr.summary}`);
    if (qr.requiredChanges.length) log(`  Cambios requeridos: ${qr.requiredChanges.join("; ")}`);
  }
  log(`\nCiclos de correccion usados: ${afterDev.values.reviewCycles}`);

  if (dphase === "review_failed") {
    log(`\n[ERROR] Una revision fallo: ${afterDev.values.error} (sin fallback).`);
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(1, cpDir);
    return;
  }
  if (dphase === "reviews_exhausted") {
    log(`\nLIMITE de ciclos alcanzado: ${afterDev.values.error}`);
    log("NO se aprueba automaticamente. Decision humana requerida (modificar HU, etc.).");
    await rl2.close();
    verifyIntegrity(before, watchedDir);
    finishEvidence(0, cpDir);
    return;
  }
  if (dphase === "reviews_passed") {
    log("\nAMBAS revisiones aprobaron la MISMA version. APROBACION HUMANA FINAL (Fase 13).");
    log(`Hash SHA-256 aprobado por ambas revisiones: ${afterDev.values.devProposalHash}`);
    log(`Los cambios se aplicaran en: ${applyTarget.label}`);
    const { created, modified, deleted } = splitProposalChanges(
      afterDev.values.devProposal as import("../dev/dev-schema.js").DevProposal,
    );
    log(`  Crear: ${created.join(", ") || "(ninguno)"}`);
    log(`  Modificar: ${modified.join(", ") || "(ninguno)"}`);
    log(`  Eliminar: ${deleted.join(", ") || "(ninguno)"}`);

    const dec = (await rl2.ask("\nDecision final [approve / reject / request_changes]: ")).trim().toLowerCase();
    log(`Decision final: ${dec}`);
    const action =
      dec === "approve" ? "approve" : dec === "request_changes" ? "request_changes" : "reject";
    const feedback =
      action === "request_changes" ? (await rl2.ask("Cambios solicitados: ")).trim() : undefined;

    const fin = await app.invoke(new Command({ resume: { action, feedback } }), cfg);
    log(`\nResultado: phase=${fin.phase}`);
    reportApplication(fin, applyTarget);
    await rl2.close();
    // El repo REAL (rootDir) debe seguir intacto salvo que se autorizara aplicar
    // en el (isRealRepo). La verificacion de integridad lo comprueba.
    if (!applyTarget.isRealRepo) verifyIntegrity(before, watchedDir);
    finishEvidence(0, cpDir, applyTarget);
    return;
  }

  log(`[estado] phase=${dphase}`);
  await rl2.close();
  verifyIntegrity(before, watchedDir);
  finishEvidence(1, cpDir);
}

/** Verifica que el repo no cambio (acceso de solo lectura). */
function verifyIntegrity(before: Map<string, string>, dir: string): void {
  const changes = diff(before, fingerprint(dir));
  log("\n── Integridad del repositorio (solo lectura) ──");
  if (changes.length === 0) {
    log("OK: el repositorio permanece INTACTO (ningun archivo modificado).");
  } else {
    log("FALLO DE SEGURIDAD: el repositorio cambio:");
    changes.forEach((c) => log(`  - ${c}`));
    process.exitCode = 1;
  }
}

/** Vuelca la evidencia a un archivo temporal (sin secretos: solo salida del flujo). */
function finishEvidence(code: number, cleanupDir?: string, applyTarget?: ApplyTarget): void {
  const dir = mkdtempSync(join(tmpdir(), "saiki-evidence-"));
  const file = join(dir, "manual-tech-evidence.log");
  writeFileSync(file, evidence.join("\n"), "utf8");
  console.log(`\nEvidencia registrada en: ${file}`);
  // Limpia el checkpoint temporal de esta corrida (no deja estado ambiguo).
  if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
  // La COPIA TEMPORAL de aplicacion se CONSERVA a proposito para que el humano
  // inspeccione los cambios aplicados. Se informa su ruta arriba.
  if (applyTarget && !applyTarget.isRealRepo && applyTarget.tempDir) {
    console.log(`Copia temporal con los cambios aplicados: ${applyTarget.tempDir}`);
  }
  if (code !== 0) process.exitCode = code;
}

main().catch((error: unknown) => {
  console.error("Error en la integracion manual (tech):", error);
  process.exitCode = 1;
});
