/**
 * DEMOSTRACIÓN MANUAL EXTREMO A EXTREMO (opt-in) — NO se ejecuta en `npm test`.
 *
 * Muestra la integración de Fase 15 con los COMPONENTES REALES, recorriendo los
 * tres caminos del moderador sobre un único `SaikiCore`:
 *
 *   Entrada → Moderador → Core → Runtime/Agente → Grafo → Knowledge Base → Resultado
 *
 *   A) CONVERSACIÓN: una pregunta técnica NO inicia desarrollo.
 *   B) ASISTENCIA:   una investigación corre con OpenCode (solo lectura).
 *   C) DESARROLLO:   una solicitud arranca el grafo (HU → ... → aprobación).
 *   D) KNOWLEDGE:    se registra una propuesta y se verifica que NO es oficial
 *                    hasta una aprobación humana explícita.
 *
 * SEGURIDAD (heredada de fases anteriores):
 *   - La aplicación de cambios (si el humano aprobara el desarrollo) ocurre SOLO
 *     vía el Safe Applier y SOLO sobre una COPIA TEMPORAL del repo por defecto.
 *     Para tocar el repo real se exige `SAIKI_APPLY_TO_REAL_REPO=1`.
 *   - El asistente es SOLO LECTURA; nunca escribe el repositorio.
 *
 * Requisitos para la ejecución real:
 *   - `kiro-cli` con sesión SSO, `claude` disponible, `opencode` opcional.
 *   - Node 22 (`nvm use 22`).
 *
 * Ejecutar:
 *     nvm use 22
 *     npm run manual:e2e
 *
 * Esta demo NO espera aprobaciones interactivas: muestra el ESTADO al que llega
 * cada camino (p. ej. el desarrollo queda pausado esperando aprobación humana),
 * que es justamente lo que demuestra que las aprobaciones NO se saltan.
 */
import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaikiCore } from "../core/saiki-core.js";
import { CoreStore } from "../core/core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createSqliteCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { KiroCliAdapter } from "../agents/kiro-cli-agent.js";
import { ClaudeCliAdapter } from "../agents/claude-cli-agent.js";
import { OpenCodeCliAdapter } from "../agents/opencode-cli-agent.js";

function log(line = ""): void {
  console.log(line);
}

/**
 * Router REAL para la demo: roles del grafo con sus runtimes reales, assistant
 * con OpenCode, y el runtime `opencode` registrado. No toca `createDefaultRouter`
 * (que usan las fases previas).
 */
function buildRealRouter(): MapAgentRouter {
  const mock = new MockAgentAdapter();
  const opencode = new OpenCodeCliAdapter({ agent: "assistant" });
  return new MapAgentRouter(
    {
      analyze: new KiroCliAdapter(),
      develop: new ClaudeCliAdapter({ rawPrompt: true }),
      review: mock,
      huAnalyst: new KiroCliAdapter(),
      technicalAnalyst: new KiroCliAdapter({ trustTools: "fs_read" }),
      functionalReviewer: new KiroCliAdapter({ trustTools: "fs_read" }),
      qualityReviewer: new KiroCliAdapter({ trustTools: "fs_read" }),
      assistant: opencode,
    },
    { opencode },
  );
}

/** Resuelve el directorio de aplicación: copia temporal salvo doble opt-in. */
function resolveApplyDir(realRepo: string): { applyDir: string; label: string; temp?: string } {
  if (process.env.SAIKI_APPLY_TO_REAL_REPO === "1") {
    return { applyDir: realRepo, label: "REPO REAL (SAIKI_APPLY_TO_REAL_REPO=1)" };
  }
  const temp = mkdtempSync(join(tmpdir(), "saiki-e2e-apply-"));
  if (existsSync(join(realRepo, "src"))) cpSync(join(realRepo, "src"), join(temp, "src"), { recursive: true });
  return { applyDir: temp, label: "COPIA TEMPORAL (el repo real NO se toca)", temp };
}

async function main(): Promise<void> {
  log("=== Fase 15: demo de integración extremo a extremo (componentes reales) ===");
  log(`Fecha: ${new Date().toISOString()}`);

  const realRepo = process.cwd();
  const apply = resolveApplyDir(realRepo);
  log(`Destino de aplicación: ${apply.label}`);

  // Persistencia en un dir temporal para no dejar estado en el repo.
  const cpDir = mkdtempSync(join(tmpdir(), "saiki-e2e-"));
  const core = new SaikiCore({
    router: buildRealRouter(),
    graphOptions: {
      checkpointer: createSqliteCheckpointer(join(cpDir, "cp.sqlite")),
      rootDir: realRepo, // análisis en solo lectura sobre el repo real
      applyDir: apply.applyDir, // escritura SOLO aquí
    },
    coreStore: new CoreStore(join(cpDir, "core.sqlite")),
    knowledge: new KnowledgeStore(join(cpDir, "kb.sqlite")),
  });

  // A) CONVERSACIÓN.
  log("\n── A) Consulta técnica (debe quedarse en conversación) ──");
  const a = await core.process("demo", "¿cómo funciona el checkpointer de LangGraph?");
  log(`categoría: ${a.category} · inició desarrollo: ${a.developmentThreadId ? "SÍ (MAL)" : "no"}`);
  log(`respuesta: ${a.reply}`);

  // B) ASISTENCIA (OpenCode, solo lectura).
  log("\n── B) Investigación (asistencia, OpenCode solo lectura) ──");
  const b = await core.process("demo", "investiga opciones de colas de mensajes en Node");
  log(`categoría: ${b.category} · runtime: ${b.task?.runtime} · estado: ${b.task?.status}`);
  log(`permisos concedidos: ${b.task?.grantedCapabilities.join(", ")}`);
  if (b.task?.status === "failed") log(`(error explícito, sin falso éxito): ${b.task.errors.join(" | ")}`);
  else log(`resultado (extracto): ${(b.task?.result ?? "").slice(0, 300)}`);

  // C) DESARROLLO (arranca el grafo; queda esperando aprobación humana).
  log("\n── C) Solicitud de desarrollo (arranca el grafo) ──");
  const c = await core.process("demo", "implementa un util de suma a+b en src/");
  log(`categoría: ${c.category} · thread: ${c.developmentThreadId}`);
  if (c.developmentThreadId) {
    const status = await core.getFlowStatus(c.developmentThreadId);
    log(`estado del flujo: ${status?.phase} · esperando aprobación: ${status?.awaitingApproval ? "SÍ" : "no"}`);
    log("(las aprobaciones humanas NO se saltan: el flujo se detiene aquí)");
  }

  // D) KNOWLEDGE BASE (propuesta vs. aprobación humana).
  log("\n── D) Knowledge Base (propuesta → aprobación humana) ──");
  const doc = core.proposeKnowledge({
    id: `demo-${Date.now()}`,
    title: "Hallazgo de la investigación",
    category: "research",
    content: "Resumen provisional de la investigación B.",
    origin: "assistant",
  });
  log(`documento creado con estado: ${doc.status} (debe ser 'proposed')`);
  try {
    await core.requestKnowledgeApproval(doc.id, "assistant");
    log("ERROR: un agente aprobó conocimiento (NO debería ocurrir)");
  } catch {
    log("OK: un agente NO puede aprobar conocimiento oficial.");
  }
  await core.requestKnowledgeApproval(doc.id, "humano-demo");
  log(`tras aprobación HUMANA, estado: ${(await core.getKnowledgeDoc(doc.id))?.status}`);

  core.close();
  rmSync(cpDir, { recursive: true, force: true });
  log(`\nPersistencia temporal limpiada: ${cpDir}`);
  if (apply.temp) log(`Copia temporal de aplicación (conservada): ${apply.temp}`);
  log("\n=== Fin de la demo ===");
}

main().catch((error: unknown) => {
  console.error("Error en la demo e2e:", error);
  process.exitCode = 1;
});
