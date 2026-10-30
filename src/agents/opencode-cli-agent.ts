import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
import {
  spawnProcessRunner,
  type ProcessRunner,
  type ProcessResult,
  workingDirectoryOf,
} from "./process-runner.js";

/**
 * Adaptador de OpenCode como RUNTIME OPCIONAL (Fase 14).
 *
 * OpenCode (https://opencode.ai) es un agente de código open-source,
 * provider-agnóstico, con TUI y CLI. Aquí lo usamos SOLO en modo no interactivo
 * para el rol auxiliar `assistant` (investigar, comparar, redactar, consultar).
 *
 * CLI VERIFICADO contra la documentación oficial (opencode.ai/docs/cli):
 *  - `opencode run <message..>`  → modo no interactivo (imprime a stdout, sale).
 *  - `--agent <nombre>`          → selecciona el agente (su config define permisos).
 *  - `--model provider/model`    → modelo opcional.
 *  - `--format json`             → eventos en JSON crudo (lo usamos para parsear).
 *  El prompt va como argumento posicional (message..).
 *
 * SEGURIDAD — NO escribe el repositorio:
 *  - NO se pasa `--auto` (que auto-aprobaría permisos no denegados).
 *  - El `assistant` debe apuntar a un AGENTE OpenCode configurado SOLO LECTURA
 *    (permisos read/grep/glob/webfetch/websearch; NUNCA edit/bash). OpenCode
 *    deniega por defecto lo no listado en el frontmatter del agente.
 *  - Este adaptador por sí mismo NO concede escritura; el modelo de permisos de
 *    saiki-ia (capabilities.ts) valida la autorización ANTES de ejecutar.
 *  - El Safe Applier sigue siendo el único componente que modifica el repo.
 *
 * Es OPCIONAL: si OpenCode no está instalado, el `run` devuelve `failure`
 * (sin fallback), igual que los demás adaptadores reales. Nada en el Core
 * depende de que exista.
 *
 * Cumple el contrato `AgentAdapter`: nunca lanza; los fallos van en el result.
 */

export interface OpenCodeCliOptions {
  /** Binario a invocar. Por defecto "opencode". */
  command?: string;
  /** Timeout en ms. Por defecto 120000 (investigaciones pueden tardar). */
  timeoutMs?: number;
  /** Tope de bytes de salida. Por defecto 1 MiB. */
  maxOutputBytes?: number;
  /** Runner inyectable (tests deterministas). */
  runner?: ProcessRunner;
  /**
   * Nombre del AGENTE OpenCode a usar (su config define los permisos reales).
   * Por defecto "assistant". Debe estar configurado SOLO LECTURA.
   */
  agent?: string;
  /** Modelo opcional en formato provider/model. */
  model?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export class OpenCodeCliAdapter implements AgentAdapter {
  readonly name = "opencode";

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: ProcessRunner;
  private readonly agent: string;
  private readonly model?: string;

  constructor(options: OpenCodeCliOptions = {}) {
    this.command = options.command ?? "opencode";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.runner = options.runner ?? spawnProcessRunner;
    this.agent = options.agent ?? "assistant";
    this.model = options.model;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const args = ["run", "--format", "json", "--agent", this.agent];
    if (this.model) args.push("--model", this.model);
    // Prompt como argumento posicional (message..). Deliberadamente SIN --auto.
    args.push(request.input);

    const proc = await this.runner({
      command: this.command,
      args,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      cwd: workingDirectoryOf(request.context),
    });

    return this.mapToAgentResult(request, proc);
  }

  private mapToAgentResult(request: AgentRequest, proc: ProcessResult): AgentResult {
    const { role } = request;

    if (proc.startError !== undefined) {
      return {
        status: "failure",
        output: "",
        error: `No se pudo iniciar "${this.command}": ${proc.startError}`,
        role,
      };
    }
    if (proc.timedOut) {
      return {
        status: "failure",
        output: "",
        error: `OpenCode excedió el timeout de ${this.timeoutMs} ms.`,
        role,
      };
    }
    if (proc.exitCode !== 0) {
      const detail = proc.stderr.trim() || proc.stdout.trim() || "sin salida";
      return {
        status: "failure",
        output: "",
        error: `OpenCode salió con código ${proc.exitCode}: ${detail}`,
        role,
      };
    }

    const raw = proc.stdout.trim();
    if (raw.length === 0) {
      return {
        status: "failure",
        output: "",
        error: "OpenCode no devolvió salida en stdout.",
        role,
      };
    }

    // `--format json` emite eventos JSON. Extraemos el texto de forma DEFENSIVA:
    // si no podemos parsear, devolvemos el crudo (no inventamos estructura).
    const output = extractText(raw);
    return {
      status: "success",
      output: proc.truncated ? `${output}\n[salida truncada]` : output,
      role,
    };
  }
}

/**
 * Extrae texto legible de la salida `--format json` de OpenCode de forma
 * tolerante. OpenCode puede emitir una línea JSON por evento (JSONL) o un único
 * objeto. No asumimos un esquema fijo (evitamos acoplarnos a una versión); si
 * no hay nada reconocible, devolvemos el crudo.
 */
export function extractText(raw: string): string {
  const texts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const t = pickText(obj);
      if (t) texts.push(t);
    } catch {
      // Línea no-JSON: la conservamos tal cual (salida mixta).
      texts.push(trimmed);
    }
  }
  const joined = texts.join("\n").trim();
  return joined.length > 0 ? joined : raw;
}

/** Busca campos de texto habituales sin casarse con un esquema concreto. */
function pickText(obj: Record<string, unknown>): string | null {
  for (const key of ["text", "content", "message", "output", "result"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}
