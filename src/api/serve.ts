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
 *   SAIKI_DATA_DIR           directorio de datos, ruta absoluta (default ./.saiki)
 *   SAIKI_CONTEXT_REFRESH_MS espera máxima de una ejecución a un escaneo (default 30000)
 *   SAIKI_KIRO_TIMEOUT_MS    timeout de cada llamada a Kiro CLI, entero positivo en ms (default 60000)
 *   SAIKI_CLAUDE_TIMEOUT_MS  timeout de cada llamada a Claude Code (desarrollo), entero positivo en ms (default 120000)
 *   (SAIKI_APPLY_TO_REAL_REPO ya no se usa: el modo de aplicación es por proyecto.)
 *
 * Ejecutar:
 *     nvm use 22
 *     npm run serve
 */
import { registerHomeProject } from "../projects/home-project.js";
import { SaikiCore } from "../core/saiki-core.js";
import { legacyDataNotice, openDataStores, resolveDataPaths } from "../persistence/data-dir.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { KIRO_TIMEOUT_ENV, KiroCliAdapter, resolveKiroTimeoutMs } from "../agents/kiro-cli-agent.js";
import { CLAUDE_TIMEOUT_ENV, ClaudeCliAdapter, resolveClaudeTimeoutMs } from "../agents/claude-cli-agent.js";
import { OpenCodeCliAdapter } from "../agents/opencode-cli-agent.js";
import { LlmModerator } from "../moderator/llm-moderator.js";
import { ClaudeConversationEngine } from "../moderator/claude-conversation-engine.js";
import { EventBus } from "../events/event-bus.js";
import { createApiServer, DEFAULT_PORT, DEFAULT_HUMAN_ACTOR } from "./http-server.js";

function buildRealRouter(kiroTimeoutMs: number, claudeTimeoutMs: number): MapAgentRouter {
  const mock = new MockAgentAdapter();
  const kiro = (trustTools?: string) => new KiroCliAdapter({ timeoutMs: kiroTimeoutMs, ...(trustTools ? { trustTools } : {}) });
  const opencode = new OpenCodeCliAdapter({ agent: "assistant" });
  return new MapAgentRouter(
    {
      analyze: kiro(),
      develop: new ClaudeCliAdapter({ rawPrompt: true, timeoutMs: claudeTimeoutMs }),
      review: mock,
      huAnalyst: kiro(),
      technicalAnalyst: kiro("fs_read"),
      functionalReviewer: kiro("fs_read"),
      qualityReviewer: kiro("fs_read"),
      projectAnalyst: kiro("fs_read"),
      assistant: opencode,
    },
    { opencode },
  );
}

/** Una línea para el log de arranque: escaneos recuperados y encolados. */
function describeContextStart(core: SaikiCore): string {
  const r = core.contextStartReport;
  if (!r) return "sin configurar.";
  const requeued = r.recovered.filter((e) => e.outcome === "requeued").length;
  const skipped = r.recovered.length - requeued;
  const parts = [
    `${r.initial.length} proyecto(s) sin snapshot encolado(s) al arrancar (un proyecto nuevo se escanea al registrarse)`,
    `${requeued} escaneo(s) interrumpido(s) reanudado(s)`,
    ...(skipped > 0 ? [`${skipped} no reanudado(s) (proyecto no disponible o recuperación repetida)`] : []),
  ];
  return `${parts.join(", ")}; context.sqlite en el directorio de datos.`;
}

function main(): void {
  const realRepo = process.cwd();
  if (process.env.SAIKI_APPLY_TO_REAL_REPO !== undefined) {
    console.warn("SAIKI_APPLY_TO_REAL_REPO ya no tiene efecto: el modo de aplicación se elige por proyecto.");
  }

  const humanActor = process.env.SAIKI_HUMAN_ACTOR ?? DEFAULT_HUMAN_ACTOR;
  const port = Number(process.env.SAIKI_API_PORT ?? DEFAULT_PORT);
  const refreshMs = Number(process.env.SAIKI_CONTEXT_REFRESH_MS);
  const contextRefreshMs = Number.isInteger(refreshMs) && refreshMs > 0 ? refreshMs : undefined;
  if (process.env.SAIKI_CONTEXT_REFRESH_MS && contextRefreshMs === undefined) {
    console.warn("SAIKI_CONTEXT_REFRESH_MS debe ser un entero positivo (ms); se usa el valor por defecto (30000).");
  }

  const kiroTimeout = resolveKiroTimeoutMs();
  const claudeTimeout = resolveClaudeTimeoutMs();
  if (!kiroTimeout.ok || !claudeTimeout.ok) {
    for (const t of [kiroTimeout, claudeTimeout]) if (!t.ok) console.error(t.message);
    process.exitCode = 1;
    return;
  }

  const data = resolveDataPaths();
  if (!data.ok) {
    console.error(data.message);
    process.exitCode = 1;
    return;
  }
  const notice = legacyDataNotice(data.paths);
  if (notice) console.warn(notice);
  const { coreStore, checkpointer, eventStore, knowledge, contextStore } = openDataStores(data.paths);

  const eventBus = new EventBus();
  const core = new SaikiCore({
    router: buildRealRouter(kiroTimeout.timeoutMs, claudeTimeout.timeoutMs),
    // Sin rootDir/applyDir: cada ejecución usa el repositorio de su proyecto.
    graphOptions: { checkpointer },
    coreStore,
    knowledge,
    moderator: new LlmModerator(new ClaudeConversationEngine()),
    eventBus,
    eventStore,
    dataDir: data.paths.dir,
    // (Project Context) Escaneos en segundo plano sobre context.sqlite del directorio de datos.
    contextStore,
    contextRefreshMs,
  });

  const handle = createApiServer({ core, humanActor, port, eventStore });
  handle.ready
    .then(async () => {
      console.log(`Saiki-IA API escuchando en http://127.0.0.1:${port}`);
      console.log(`Identidad humana local: ${humanActor}`);
      console.log(`Datos: ${data.paths.dir}${data.paths.source === "env" ? " (SAIKI_DATA_DIR)" : ""}`);
      console.log(`Proyectos: ${await registerHomeProject(core, realRepo)}`);
      console.log(`Contexto: ${describeContextStart(core)}`);
      console.log(`Kiro: timeout de ${kiroTimeout.timeoutMs} ms${kiroTimeout.source === "env" ? ` (${KIRO_TIMEOUT_ENV})` : " (predeterminado)"}.`);
      console.log(`Claude: timeout de ${claudeTimeout.timeoutMs} ms${claudeTimeout.source === "env" ? ` (${CLAUDE_TIMEOUT_ENV})` : " (predeterminado)"}.`);
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
