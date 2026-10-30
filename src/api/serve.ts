/**
 * Arranque LOCAL de la API REST de Saiki-IA (Fase 19).
 *
 * Instancia un `SaikiCore` real y expone la API HTTP en 127.0.0.1. Opt-in: NO
 * se ejecuta en `npm test`.
 *
 * SEGURIDAD:
 *  - Escucha SOLO en 127.0.0.1 (no accesible desde la red).
 *  - (Project Registry) Cada ejecución trabaja sobre el repositorio de SU
 *    proyecto y aplica en un sandbox propio, salvo que el proyecto esté en modo
 *    `real` (con confirmación explícita al registrarlo o editarlo).
 *  - Identidad humana local: `SAIKI_HUMAN_ACTOR` (default "local-human").
 *
 * Variables de entorno:
 *   SAIKI_API_PORT           puerto (default 4123)
 *   SAIKI_HUMAN_ACTOR        identidad humana local
 *   (SAIKI_APPLY_TO_REAL_REPO ya no se usa: el modo de aplicación es por proyecto.)
 *
 * Ejecutar:
 *     nvm use 22
 *     npm run serve
 */
import { registerHomeProject } from "../projects/home-project.js";
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
import { EventBus } from "../events/event-bus.js";
import { EventStore } from "../events/event-store.js";
import { createApiServer, DEFAULT_PORT, DEFAULT_HUMAN_ACTOR } from "./http-server.js";

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

function main(): void {
  const realRepo = process.cwd();
  if (process.env.SAIKI_APPLY_TO_REAL_REPO !== undefined) {
    console.warn("SAIKI_APPLY_TO_REAL_REPO ya no tiene efecto: el modo de aplicación se elige por proyecto.");
  }

  const humanActor = process.env.SAIKI_HUMAN_ACTOR ?? DEFAULT_HUMAN_ACTOR;
  const port = Number(process.env.SAIKI_API_PORT ?? DEFAULT_PORT);

  const eventBus = new EventBus();
  const eventStore = new EventStore(".saiki/events.sqlite");
  const core = new SaikiCore({
    router: buildRealRouter(),
    // Sin rootDir/applyDir: cada ejecución usa el repositorio de su proyecto.
    graphOptions: { checkpointer: createSqliteCheckpointer(".saiki/checkpoints.sqlite") },
    coreStore: new CoreStore(".saiki/core.sqlite"),
    knowledge: new KnowledgeStore(".saiki/knowledge.sqlite"),
    moderator: new LlmModerator(new ClaudeConversationEngine()),
    eventBus,
    eventStore,
    dataDir: ".saiki",
  });

  const handle = createApiServer({ core, humanActor, port, eventStore });
  handle.ready
    .then(async () => {
      console.log(`Saiki-IA API escuchando en http://127.0.0.1:${port}`);
      console.log(`Identidad humana local: ${humanActor}`);
      console.log(`Proyectos: ${await registerHomeProject(core, realRepo)}`);
      console.log("Ctrl+C para detener.");
    })
    .catch((e) => {
      console.error("No se pudo iniciar la API:", e);
      process.exitCode = 1;
    });

  // Cierre ordenado ante SIGINT/SIGTERM. `handle.close()` cierra los streams SSE
  // abiertos (antes el proceso quedaba colgado con Jev abierto). Plazo máximo de
  // 5 s y una segunda señal fuerza la salida.
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      console.log("Cierre forzado.");
      process.exit(1);
    }
    closing = true;
    console.log("\nCerrando API…");
    const timer = setTimeout(() => {
      console.error("El cierre superó 5 s; se fuerza la salida.");
      process.exit(1);
    }, 5_000);
    timer.unref();
    try {
      await handle.close();
    } catch (e) {
      console.error("Error al cerrar el servidor:", e);
    }
    core.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
