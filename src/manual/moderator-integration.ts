/**
 * DEMOSTRACIÓN MANUAL DEL MODERADOR CONVERSACIONAL (opt-in) — NO en `npm test`.
 *
 * Ejecuta el moderador con LLM REAL (Claude vía `ClaudeConversationEngine`)
 * integrado en `SaikiCore`, recorriendo varios mensajes de una MISMA sesión
 * para mostrar: clasificación en lenguaje natural, contexto entre turnos,
 * aclaración de ambigüedades y enrutamiento (conversación / asistencia /
 * desarrollo), SIN saltarse ninguna aprobación ni tocar el repo real.
 *
 * SEGURIDAD:
 *  - El moderador solo clasifica y redacta TEXTO: no escribe, no aplica, no
 *    aprueba. El desarrollo queda pausado esperando aprobación humana.
 *  - La aplicación (si se aprobara) iría a una COPIA TEMPORAL salvo
 *    `SAIKI_APPLY_TO_REAL_REPO=1` (protección de Fase 13).
 *
 * Requisitos: `claude` disponible; Kiro/OpenCode para los flujos reales. Node 22.
 *
 * Ejecutar:
 *     nvm use 22
 *     npm run manual:moderator
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
import { LlmModerator } from "../moderator/llm-moderator.js";
import { ClaudeConversationEngine } from "../moderator/claude-conversation-engine.js";

function log(line = ""): void {
  console.log(line);
}

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

async function main(): Promise<void> {
  log("=== Fase 16: demo del moderador conversacional (Claude real) ===");
  log(`Fecha: ${new Date().toISOString()}`);

  const realRepo = process.cwd();
  const applyToReal = process.env.SAIKI_APPLY_TO_REAL_REPO === "1";
  let applyDir = realRepo;
  let temp: string | undefined;
  if (!applyToReal) {
    temp = mkdtempSync(join(tmpdir(), "saiki-mod-apply-"));
    if (existsSync(join(realRepo, "src"))) cpSync(join(realRepo, "src"), join(temp, "src"), { recursive: true });
    applyDir = temp;
  }
  log(`Destino de aplicación: ${applyToReal ? "REPO REAL" : "COPIA TEMPORAL"}`);

  const cpDir = mkdtempSync(join(tmpdir(), "saiki-mod-"));
  const core = new SaikiCore({
    router: buildRealRouter(),
    graphOptions: {
      checkpointer: createSqliteCheckpointer(join(cpDir, "cp.sqlite")),
      rootDir: realRepo,
      applyDir,
    },
    coreStore: new CoreStore(join(cpDir, "core.sqlite")),
    knowledge: new KnowledgeStore(join(cpDir, "kb.sqlite")),
    // ← AQUÍ se inyecta el moderador conversacional con el motor REAL.
    moderator: new LlmModerator(new ClaudeConversationEngine()),
  });

  const sid = "demo-moderator";
  // Conversación con CONTEXTO: varios turnos de la misma sesión.
  const messages = [
    "¿cómo está organizado el router de agentes en este proyecto?", // conversación
    "investiga qué alternativas hay a SQLite para esto", // asistencia
    "oye, mejor hazlo", // ambiguo -> debería pedir aclaración
    "implementa un pequeño util de suma en src/", // desarrollo
  ];

  for (const msg of messages) {
    log(`\n──────────────\nUsuario: ${msg}`);
    try {
      const r = await core.process(sid, msg);
      log(`→ categoría: ${r.category} (confianza ${r.confidence.toFixed(2)}) · ${r.reason}`);
      if (r.clarifyingQuestion) log(`  aclaración solicitada: ${r.clarifyingQuestion}`);
      if (r.task) {
        log(`  asistencia: estado=${r.task.status} runtime=${r.task.runtime}`);
        if (r.task.synthesis) log(`  SÍNTESIS automática (Fase 17): ${r.task.synthesis.slice(0, 400)}`);
        else if (r.task.result) log(`  resultado (crudo, sin síntesis): ${r.task.result.slice(0, 300)}`);
      } else if (r.reply) {
        log(`  respuesta: ${r.reply.slice(0, 300)}`);
      }
      if (r.developmentThreadId) {
        const status = await core.getFlowStatus(r.developmentThreadId);
        log(`  desarrollo: fase=${status?.phase} · esperando aprobación=${status?.awaitingApproval ? "SÍ" : "no"}`);
        log("  (el moderador NO aprueba ni aplica: el flujo se detiene aquí)");
      }
    } catch (e) {
      log(`  [ERROR explícito del proveedor] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  core.close();
  rmSync(cpDir, { recursive: true, force: true });
  if (temp) log(`\nCopia temporal de aplicación: ${temp} (el repo real NO se tocó)`);
  log("\n=== Fin de la demo ===");
}

main().catch((error: unknown) => {
  console.error("Error en la demo del moderador:", error);
  process.exitCode = 1;
});
