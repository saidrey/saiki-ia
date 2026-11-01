import type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";
import {
  resolveTimeoutEnv,
  spawnProcessRunner,
  type TimeoutResolution,
  type ProcessRunner,
  type ProcessResult,
  workingDirectoryOf,
} from "./process-runner.js";

/** Opciones de configuracion del adaptador de Kiro CLI. */
export interface KiroCliOptions {
  /** Binario a invocar. Por defecto "kiro-cli". */
  command?: string;
  /** Timeout en ms para la llamada. Por defecto 60000 (60s). */
  timeoutMs?: number;
  /** Tope de bytes de salida acumulada. Por defecto 1 MiB. */
  maxOutputBytes?: number;
  /**
   * Runner de proceso. Por defecto el real (`spawnProcessRunner`).
   * En tests se inyecta uno falso para ser deterministas sin llamar a Kiro.
   */
  runner?: ProcessRunner;
  /**
   * Valor de `--trust-tools`. Por defecto "" (sin herramientas), apto para
   * roles que solo generan texto (analyze, huAnalyst). Para el analista tecnico
   * se usa "fs_read" (solo lectura, verificado contra `kiro-cli chat --help`).
   * NUNCA escritura/ejecucion arbitraria.
   */
  trustTools?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

/** Variable de entorno con el timeout de cada llamada a Kiro CLI (ms). */
export const KIRO_TIMEOUT_ENV = "SAIKI_KIRO_TIMEOUT_MS";
export const DEFAULT_KIRO_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * Timeout de Kiro desde el entorno. Sin definir (o vacía): 60 000 ms. Debe ser
 * un entero positivo de milisegundos; cualquier otro valor es un error (no se
 * sustituye en silencio por el predeterminado).
 */
export function resolveKiroTimeoutMs(env: Record<string, string | undefined> = process.env): TimeoutResolution {
  return resolveTimeoutEnv(env, KIRO_TIMEOUT_ENV, DEFAULT_TIMEOUT_MS);
}

/**
 * Adaptador que conecta un rol con **Kiro CLI real** vía
 * `kiro-cli chat --no-interactive`.
 *
 * Reutiliza la autenticacion SSO ya configurada en el entorno: NO inicia
 * sesion ni guarda credenciales. Si la sesion no esta activa, Kiro CLI fallara
 * y ese fallo se reporta como `status: "failure"` (sin fallback al mock).
 *
 * Seguridad: se invoca con `--trust-tools=read` (solo lectura). Un rol que solo
 * genera texto (como `analyze`) no necesita permisos de escritura/ejecucion.
 * NO se usa `--trust-all-tools`.
 *
 * Cumple el contrato `AgentAdapter`: nunca lanza; los fallos van en el result.
 */
export class KiroCliAdapter implements AgentAdapter {
  readonly name = "kiro-cli";

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: ProcessRunner;
  private readonly trustTools: string;

  constructor(options: KiroCliOptions = {}) {
    this.command = options.command ?? "kiro-cli";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.runner = options.runner ?? spawnProcessRunner;
    this.trustTools = options.trustTools ?? "";
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const prompt = this.buildPrompt(request);

    // Sintaxis verificada contra `kiro-cli chat --help` (v2.35.2):
    // - El prompt va como argumento posicional [INPUT] (ultimo arg).
    // - `--no-interactive`: no espera entrada del usuario.
    // - `--trust-tools=` VACIO: no confia en ninguna herramienta. Es lo mas
    //   seguro para `analyze`, que solo debe generar texto (no leer/escribir
    //   archivos ni ejecutar comandos). La doc oficial muestra este valor
    //   vacio como "trust no tools".
    const proc = await this.runner({
      command: this.command,
      args: ["chat", "--no-interactive", `--trust-tools=${this.trustTools}`, prompt],
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      cwd: workingDirectoryOf(request.context),
    });

    return this.mapToAgentResult(request, proc);
  }

  /** Construye el prompt que recibira Kiro CLI segun el rol. */
  private buildPrompt(request: AgentRequest): string {
    // Para `analyze` pedimos un plan corto y sin preambulo (validado a mano).
    if (request.role === "analyze") {
      return (
        "Eres un analista de software. Genera un plan corto " +
        "(3 pasos numerados) para esta tarea, sin preambulo ni texto extra: " +
        request.input
      );
    }
    // (Fase 9/10/12) Para estos roles el prompt ya viene construido por el
    // llamador (instrucciones separadas); se pasa tal cual.
    if (
      request.role === "huAnalyst" ||
      request.role === "technicalAnalyst" ||
      request.role === "functionalReviewer" ||
      request.role === "qualityReviewer"
    ) {
      return request.input;
    }

    // Otros roles no usan este adaptador en Fase 4, pero dejamos un prompt
    // generico por completitud del contrato.
    return `Rol ${request.role}. Entrada: ${request.input}`;
  }

  /** Traduce el resultado crudo del proceso a un AgentResult del contrato. */
  private mapToAgentResult(request: AgentRequest, proc: ProcessResult): AgentResult {
    const { role } = request;

    // 1. No se pudo iniciar el proceso (binario inexistente, etc.).
    if (proc.startError !== undefined) {
      return {
        status: "failure",
        output: "",
        error: `No se pudo iniciar "${this.command}": ${proc.startError}`,
        role,
      };
    }

    // 2. Timeout.
    if (proc.timedOut) {
      return {
        status: "failure",
        output: "",
        error: `Kiro CLI excedio el timeout de ${this.timeoutMs} ms.`,
        role,
      };
    }

    // 3. Codigo de salida distinto de cero -> fallo de ejecucion.
    if (proc.exitCode !== 0) {
      const detail = proc.stderr.trim() || proc.stdout.trim() || "sin salida";
      return {
        status: "failure",
        output: "",
        error: `Kiro CLI salio con codigo ${proc.exitCode}: ${detail}`,
        role,
      };
    }

    // 4. Exito pero sin contenido util en stdout -> lo tratamos como fallo
    //    para no propagar un "exito vacio" al resto del grafo.
    const output = proc.stdout.trim();
    if (output.length === 0) {
      return {
        status: "failure",
        output: "",
        error: "Kiro CLI no devolvio salida en stdout.",
        role,
      };
    }

    // 5. Exito.
    return {
      status: "success",
      output: proc.truncated ? `${output}\n[salida truncada]` : output,
      role,
    };
  }
}
