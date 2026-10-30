import { spawn } from "node:child_process";

/**
 * Abstraccion para ejecutar un proceso externo.
 *
 * Separar "COMO se ejecuta un proceso" del adaptador es lo que hace que los
 * tests sean deterministas: en produccion usamos `spawnProcessRunner` (lanza
 * kiro-cli de verdad); en tests inyectamos un runner falso que simula la
 * salida sin tocar la red ni consumir creditos.
 */

/** Peticion para ejecutar un proceso: binario, argumentos y opciones. */
export interface ProcessRequest {
  command: string;
  args: string[];
  /** Milisegundos antes de abortar el proceso por timeout. */
  timeoutMs: number;
  /** Tope de bytes a acumular de stdout+stderr (evita crecer sin limite). */
  maxOutputBytes: number;
  /**
   * Texto opcional a escribir por stdin del proceso. Util cuando el prompt no
   * debe ir como argumento (p. ej. para evitar que flags variadicos como
   * `--disallowedTools <tools...>` se "coman" el prompt).
   */
  stdin?: string;
  /**
   * (Project Registry) Directorio de trabajo del proceso. Sin él, hereda el del
   * backend (comportamiento anterior; solo flujos sin proyecto).
   */
  cwd?: string;
}

/**
 * Resultado de ejecutar un proceso. Es un resultado "crudo": el adaptador lo
 * traducira a un AgentResult. Nunca lanza; los problemas se reportan en los
 * campos (`exitCode`, `timedOut`, `startError`).
 */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Codigo de salida; null si el proceso no llego a terminar normalmente. */
  exitCode: number | null;
  /** true si se abortó por superar `timeoutMs`. */
  timedOut: boolean;
  /** Mensaje si el proceso NO pudo iniciarse (p. ej. binario inexistente). */
  startError?: string;
  /** true si la salida fue truncada por superar `maxOutputBytes`. */
  truncated: boolean;
}

/** Firma de un runner: recibe una peticion y promete un resultado crudo. */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

/**
 * Runner real basado en `child_process.spawn`.
 *
 * Decisiones de seguridad/robustez:
 * - `spawn` SIN shell y con args como array: evita inyeccion de comandos.
 * - Acumula stdout/stderr con un tope de bytes (`maxOutputBytes`): si se
 *   supera, se trunca y se marca `truncated` para no agotar memoria.
 * - Timeout: si el proceso tarda mas de `timeoutMs`, se mata (SIGKILL) y se
 *   marca `timedOut`.
 * - No lanza excepciones: cualquier fallo (incl. "no se pudo iniciar") viaja
 *   dentro del ProcessResult.
 */
export const spawnProcessRunner: ProcessRunner = (request) => {
  const { command, args, timeoutMs, maxOutputBytes, stdin, cwd } = request;

  return new Promise<ProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const child = spawn(command, args, { shell: false, cwd });

    // Si hay stdin, lo escribimos y cerramos el flujo para que el proceso
    // sepa que no llega mas entrada.
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    const finish = (partial: Omit<ProcessResult, "stdout" | "stderr" | "truncated">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, truncated, ...partial });
    };

    // Acumulacion con tope. Una vez alcanzado el limite, dejamos de concatenar.
    const appendCapped = (chunk: Buffer, target: "out" | "err") => {
      const current = target === "out" ? stdout : stderr;
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - current.length;
      const text = chunk.toString("utf8");
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (target === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (c: Buffer) => appendCapped(c, "out"));
    child.stderr?.on("data", (c: Buffer) => appendCapped(c, "err"));

    // Fallo al iniciar el proceso (p. ej. binario no encontrado -> ENOENT).
    child.on("error", (err: Error) => {
      finish({ exitCode: null, timedOut: false, startError: err.message });
    });

    // Terminacion normal del proceso.
    child.on("close", (code: number | null) => {
      finish({ exitCode: code, timedOut: false });
    });

    // Timeout: matar el proceso y reportarlo.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);
  });
};

/**
 * (Project Registry) Directorio de trabajo pedido por el llamador en
 * `AgentRequest.context.workingDirectory` (el repositorio de la ejecución, o un
 * directorio vacío para conversaciones sin proyecto).
 */
export function workingDirectoryOf(context?: Record<string, unknown>): string | undefined {
  const dir = context?.workingDirectory;
  return typeof dir === "string" && dir.length > 0 ? dir : undefined;
}
