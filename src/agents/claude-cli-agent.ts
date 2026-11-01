import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
import {
  resolveTimeoutEnv,
  spawnProcessRunner,
  type TimeoutResolution,
  type ProcessRunner,
  type ProcessResult,
  workingDirectoryOf,
} from "./process-runner.js";

/** Opciones de configuracion del adaptador de Claude Code. */
export interface ClaudeCliOptions {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: ProcessRunner;
  /**
   * (Fase 11) Si true, el prompt (request.input) se pasa TAL CUAL, sin envolver
   * con el formato "FILE:" del pipeline develop. Lo usa el flujo de HU, que
   * construye su propio prompt y pide JSON. Por defecto false (compat Fases 5-8).
   */
  rawPrompt?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000; // Claude puede tardar mas que analyze.

/** Variable de entorno con el timeout de cada llamada a Claude Code (ms). */
export const CLAUDE_TIMEOUT_ENV = "SAIKI_CLAUDE_TIMEOUT_MS";
export const DEFAULT_CLAUDE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Timeout de Claude desde el entorno; mismo criterio que `SAIKI_KIRO_TIMEOUT_MS`. Por defecto 120 000 ms. */
export function resolveClaudeTimeoutMs(env: Record<string, string | undefined> = process.env): TimeoutResolution {
  return resolveTimeoutEnv(env, CLAUDE_TIMEOUT_ENV, DEFAULT_TIMEOUT_MS);
}
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

/** Herramientas de solo lectura que Claude puede usar (las únicas de la sesión). */
export const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Flags de Claude Code: solo lectura dentro del directorio de trabajo (ver SEGURIDAD). */
const CLAUDE_READ_ONLY_ARGS = [
  "-p",
  "--tools",
  CLAUDE_READ_TOOLS.join(","), // únicas herramientas built-in de la sesión
  "--allowedTools",
  ...CLAUDE_READ_TOOLS, // sin pedir permiso
  "--permission-mode",
  "dontAsk", // lo no permitido se deniega sin preguntar
  "--restricted", // confina a cwd, sin ejecución de código ni settings externos
  "--strict-mcp-config", // ignora MCP servers (podrian escribir)
  "--disallowedTools",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch", // denegacion explicita (defensa en profundidad)
];

/**
 * Adaptador que conecta el rol `develop` con **Claude Code real** en modo
 * PROPUESTA (genera codigo como texto, NUNCA aplica cambios al repositorio).
 *
 * SEGURIDAD (verificado contra `claude --help` y empíricamente, v2.1.251):
 *  - `-p` (--print): modo no interactivo.
 *  - `--tools Read,Glob,Grep`: las ÚNICAS herramientas built-in disponibles son
 *    de lectura; no existen Write/Edit/Bash en la sesión. Así Claude consulta el
 *    contenido real antes de proponer (E2E: sin lectura proponía fragmentos).
 *  - `--allowedTools Read Glob Grep` + `--permission-mode dontAsk`: esas tres no
 *    piden permiso; cualquier otra se deniega sin preguntar.
 *  - `--restricted`: confina las herramientas de archivos al directorio de
 *    trabajo (el repositorio de la ejecución), ignora settings de usuario y de
 *    proyecto y quita las herramientas que ejecutan código.
 *  - Refuerzo (defensa en profundidad): `--disallowedTools` de escritura,
 *    ejecución y red, y `--strict-mcp-config` (ignora servidores MCP).
 *  Verificado: lee archivos del proyecto, no puede crear ni editar archivos, no
 *  ejecuta comandos y no lee fuera del directorio de trabajo. Escribir sigue
 *  siendo exclusivo del aplicador seguro.
 *
 * La salida se devuelve como PROPUESTA de codigo. Marcar esa salida como "no
 * aplicada" es responsabilidad del nodo `develop` (ver nodes.ts).
 *
 * Cumple el contrato `AgentAdapter`: nunca lanza; los fallos van en el result.
 */
export class ClaudeCliAdapter implements AgentAdapter {
  readonly name = "claude-code";

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: ProcessRunner;
  private readonly rawPrompt: boolean;

  constructor(options: ClaudeCliOptions = {}) {
    this.command = options.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.runner = options.runner ?? spawnProcessRunner;
    this.rawPrompt = options.rawPrompt ?? false;
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const prompt = this.buildPrompt(request);

    // Flags verificados contra `claude --help` (v2.1.251).
    // IMPORTANTE: el prompt se pasa por STDIN, no como argumento posicional.
    // `--disallowedTools <tools...>` es variadico: si el prompt fuera un arg
    // posicional despues de el, Claude interpretaria cada PALABRA del prompt
    // como un nombre de tool a denegar ("Permission deny rule ... matches no
    // known tool"). Pasarlo por stdin elimina esa ambiguedad.
    const proc = await this.runner({
      command: this.command,
      args: CLAUDE_READ_ONLY_ARGS,
      stdin: prompt,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      cwd: workingDirectoryOf(request.context),
    });

    return this.mapToAgentResult(request, proc);
  }

  /** Prompt para que Claude PROPONGA codigo sin intentar aplicarlo. */
  private buildPrompt(request: AgentRequest): string {
    // (Fase 11) El flujo de HU arma su propio prompt (pide JSON); se pasa tal cual.
    if (this.rawPrompt) return request.input;
    return (
      "Eres un desarrollador. Devuelve UNICAMENTE una PROPUESTA de codigo, " +
      "sin aplicar cambios ni crear archivos. Para CADA archivo usa EXACTAMENTE " +
      "este formato (una cabecera FILE: con ruta relativa, seguida de un bloque " +
      "de codigo cercado):\n" +
      "FILE: ruta/relativa/al/archivo.ext\n" +
      "```lenguaje\n<contenido completo del archivo>\n```\n\n" +
      "No incluyas rutas absolutas ni '..'. Implementa el siguiente plan:\n" +
      request.input
    );
  }

  /** Traduce el resultado crudo del proceso a un AgentResult. */
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
        error: `Claude Code excedio el timeout de ${this.timeoutMs} ms.`,
        role,
      };
    }

    if (proc.exitCode !== 0) {
      const detail = proc.stderr.trim() || proc.stdout.trim() || "sin salida";
      return {
        status: "failure",
        output: "",
        error: `Claude Code salio con codigo ${proc.exitCode}: ${detail}`,
        role,
      };
    }

    const output = proc.stdout.trim();
    if (output.length === 0) {
      return {
        status: "failure",
        output: "",
        error: "Claude Code no devolvio salida en stdout.",
        role,
      };
    }

    return {
      status: "success",
      output: proc.truncated ? `${output}\n[salida truncada]` : output,
      role,
    };
  }
}
