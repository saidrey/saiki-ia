import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
import {
  spawnProcessRunner,
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
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

/**
 * Adaptador que conecta el rol `develop` con **Claude Code real** en modo
 * PROPUESTA (genera codigo como texto, NUNCA aplica cambios al repositorio).
 *
 * SEGURIDAD (verificado contra `claude --help`, v2.1.251):
 *  - `-p` (--print): modo no interactivo.
 *  - `--tools ""`: desactiva TODAS las herramientas built-in (Bash/Write/Edit/
 *    Read/REPL...). Claude solo puede generar texto. Verificado empiricamente:
 *    al pedirle crear/modificar archivos, el repo quedo INTACTO.
 *  - Refuerzo (defensa en profundidad, no confiar solo en el prompt):
 *    `--restricted` (quita herramientas de ejecucion de codigo),
 *    `--disallowedTools Write Edit Bash` (deniega escritura/ejecucion explicita),
 *    `--strict-mcp-config` (ignora servidores MCP que podrian escribir).
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
      args: [
        "-p",
        "--tools",
        "", // sin herramientas built-in: no puede leer/escribir/ejecutar
        "--restricted", // quita herramientas de ejecucion de codigo
        "--strict-mcp-config", // ignora MCP servers (podrian escribir)
        "--disallowedTools",
        "Write",
        "Edit",
        "Bash", // denegacion explicita (defensa en profundidad)
      ],
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
