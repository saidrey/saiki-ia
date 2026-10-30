import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnProcessRunner,
  type ProcessRunner,
  type ProcessResult,
} from "../agents/process-runner.js";
import type {
  ConversationEngine,
  ConversationRequest,
  ConversationResult,
} from "./conversation-engine.js";

/**
 * Motor conversacional basado en Claude Code (Fase 16).
 *
 * Reutiliza el `ProcessRunner` (mismo mecanismo que `ClaudeCliAdapter`), SIN
 * duplicar el spawn. Es un runtime conversacional SEPARADO del rol `develop`:
 * aquí Claude solo GENERA TEXTO para el moderador (clasificar, aclarar,
 * redactar, sintetizar). No tiene nada que ver con proponer código.
 *
 * SEGURIDAD (verificado contra `claude --help`): modo texto puro.
 *  - `-p` no interactivo; `--tools ""` (sin herramientas); `--restricted`;
 *    `--strict-mcp-config`; `--disallowedTools Write Edit Bash`.
 *  - El prompt va por STDIN (igual que el adaptador de develop, por la misma
 *    razón: los flags variádicos se comerían un arg posicional).
 *  - El moderador NO puede escribir el repo ni ejecutar nada: solo texto.
 *  - (Project Registry, D8) Cada llamada corre en un directorio VACÍO propio que
 *    se borra al terminar: el moderador no lee ningún repositorio ni el
 *    directorio del backend (Claude CLI carga el CLAUDE.md del directorio en que
 *    arranca).
 *
 * NUNCA simula salida: si Claude falla, devuelve `ok:false` con el error real.
 */

export interface ClaudeConversationOptions {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: ProcessRunner;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024; // 512 KiB basta para respuestas de texto

export class ClaudeConversationEngine implements ConversationEngine {
  readonly name = "claude-conversation";

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: ProcessRunner;

  constructor(options: ClaudeConversationOptions = {}) {
    this.command = options.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.runner = options.runner ?? spawnProcessRunner;
  }

  async complete(request: ConversationRequest): Promise<ConversationResult> {
    const prompt = request.systemHint
      ? `${request.systemHint}\n\n${request.prompt}`
      : request.prompt;

    const cwd = mkdtempSync(join(tmpdir(), "saiki-moderator-"));
    try {
      const proc = await this.runner({
        command: this.command,
        args: [
          "-p",
          "--tools",
          "", // sin herramientas built-in: solo texto
          "--restricted",
          "--strict-mcp-config",
          "--disallowedTools",
          "Write",
          "Edit",
          "Bash",
        ],
        stdin: prompt,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        cwd,
      });
      return this.mapResult(proc);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private mapResult(proc: ProcessResult): ConversationResult {
    if (proc.startError !== undefined) {
      return { ok: false, error: `No se pudo iniciar "${this.command}": ${proc.startError}` };
    }
    if (proc.timedOut) {
      return { ok: false, error: `El motor conversacional excedió el timeout de ${this.timeoutMs} ms.` };
    }
    if (proc.exitCode !== 0) {
      const detail = proc.stderr.trim() || proc.stdout.trim() || "sin salida";
      return { ok: false, error: `Claude salió con código ${proc.exitCode}: ${detail}` };
    }
    const text = proc.stdout.trim();
    if (text.length === 0) {
      return { ok: false, error: "El motor conversacional no devolvió salida." };
    }
    return { ok: true, text: proc.truncated ? `${text}\n[salida truncada]` : text };
  }
}
