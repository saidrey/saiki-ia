import { describe, it, expect } from "vitest";
import { DEFAULT_KIRO_TIMEOUT_MS, KIRO_TIMEOUT_ENV, KiroCliAdapter, resolveKiroTimeoutMs } from "./kiro-cli-agent.js";
import type { ProcessResult, ProcessRunner } from "./process-runner.js";

/**
 * Tests DETERMINISTAS del KiroCliAdapter.
 *
 * Clave: NO se invoca Kiro CLI real. Inyectamos un `ProcessRunner` falso que
 * devuelve un `ProcessResult` controlado. Asi probamos el mapeo a AgentResult
 * en los 4 escenarios exigidos: exito, exit!=0, timeout y fallo al iniciar.
 */

/** Helper: crea un runner falso que siempre devuelve el resultado dado. */
function fakeRunner(result: Partial<ProcessResult>): ProcessRunner {
  const base: ProcessResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  };
  return async () => ({ ...base, ...result });
}

describe("Fase 4: KiroCliAdapter (mapeo determinista con runner inyectable)", () => {
  it("exito: exit 0 con stdout -> status 'success' y output limpio", async () => {
    const agent = new KiroCliAdapter({
      runner: fakeRunner({ stdout: "  1. Paso uno\n2. Paso dos  ", exitCode: 0 }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("success");
    expect(result.role).toBe("analyze");
    expect(result.output).toBe("1. Paso uno\n2. Paso dos"); // trim aplicado
    expect(result.error).toBeUndefined();
  });

  it("exit code != 0 -> status 'failure' con stderr en el error", async () => {
    const agent = new KiroCliAdapter({
      runner: fakeRunner({ stdout: "", stderr: "sesion expirada", exitCode: 1 }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("failure");
    expect(result.output).toBe("");
    expect(result.error).toContain("codigo 1");
    expect(result.error).toContain("sesion expirada");
  });

  it("timeout -> status 'failure' indicando el timeout", async () => {
    const agent = new KiroCliAdapter({
      timeoutMs: 5000,
      runner: fakeRunner({ timedOut: true, exitCode: null }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("timeout");
    expect(result.error).toContain("5000");
  });

  it("fallo al iniciar el proceso -> status 'failure' con el startError", async () => {
    const agent = new KiroCliAdapter({
      command: "kiro-cli",
      runner: fakeRunner({
        exitCode: null,
        startError: "spawn kiro-cli ENOENT",
      }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No se pudo iniciar");
    expect(result.error).toContain("ENOENT");
  });

  it("exit 0 pero stdout vacio -> se trata como 'failure' (no exito vacio)", async () => {
    const agent = new KiroCliAdapter({
      runner: fakeRunner({ stdout: "   ", exitCode: 0 }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("no devolvio salida");
  });

  it("salida truncada -> exito pero marca el truncamiento", async () => {
    const agent = new KiroCliAdapter({
      runner: fakeRunner({ stdout: "plan largo", exitCode: 0, truncated: true }),
    });

    const result = await agent.run({ role: "analyze", input: "tarea X" });

    expect(result.status).toBe("success");
    expect(result.output).toContain("[salida truncada]");
  });

  it("pasa los argumentos correctos a Kiro CLI (no-interactive, trust-tools=read)", async () => {
    let capturedArgs: string[] = [];
    const spyRunner: ProcessRunner = async (req) => {
      capturedArgs = req.args;
      return {
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    };
    const agent = new KiroCliAdapter({ runner: spyRunner });

    await agent.run({ role: "analyze", input: "tarea X" });

    expect(capturedArgs[0]).toBe("chat");
    expect(capturedArgs).toContain("--no-interactive");
    // Verificado contra `kiro-cli chat --help` v2.35.2: trust-tools vacio = sin
    // herramientas (lo mas seguro para un rol que solo genera texto).
    expect(capturedArgs).toContain("--trust-tools=");
    // El prompt (ultimo arg) incluye la tarea de entrada.
    expect(capturedArgs[capturedArgs.length - 1]).toContain("tarea X");
  });
});

describe("SAIKI_KIRO_TIMEOUT_MS", () => {
  it("sin definir o vacía: 60 000 ms predeterminados", () => {
    expect(resolveKiroTimeoutMs({})).toEqual({ ok: true, timeoutMs: 60_000, source: "default" });
    expect(resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: "" })).toEqual({ ok: true, timeoutMs: 60_000, source: "default" });
    expect(resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: "  " })).toMatchObject({ ok: true, source: "default" });
    expect(DEFAULT_KIRO_TIMEOUT_MS).toBe(60_000);
  });

  it("valor personalizado válido", () => {
    expect(resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: "180000" })).toEqual({ ok: true, timeoutMs: 180_000, source: "env" });
    expect(resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: " 300000 " })).toEqual({ ok: true, timeoutMs: 300_000, source: "env" });
  });

  it("valores inválidos: error explícito, sin caer al predeterminado", () => {
    for (const v of ["abc", "0", "-5", "1.5", "1e3", "60s", "12 34", "2147483648", "99999999999999999999"]) {
      const r = resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: v });
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.message).toContain(KIRO_TIMEOUT_ENV);
    }
  });

  it("el adaptador usa el timeout configurado y lo informa al expirar", async () => {
    let received = 0;
    const runner: ProcessRunner = async (req) => {
      received = req.timeoutMs ?? 0;
      return { stdout: "", stderr: "", exitCode: null, timedOut: true, truncated: false };
    };
    const r = resolveKiroTimeoutMs({ [KIRO_TIMEOUT_ENV]: "180000" });
    if (!r.ok) throw new Error(r.message);
    const result = await new KiroCliAdapter({ runner, timeoutMs: r.timeoutMs, trustTools: "fs_read" }).run({ role: "technicalAnalyst", input: "x" });
    expect(received).toBe(180_000);
    expect(result).toMatchObject({ status: "failure", error: "Kiro CLI excedio el timeout de 180000 ms." });
  });

  it("sin configuración, el adaptador mantiene 60 s", async () => {
    let received = 0;
    const runner: ProcessRunner = async (req) => {
      received = req.timeoutMs ?? 0;
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    await new KiroCliAdapter({ runner }).run({ role: "analyze", input: "x" });
    expect(received).toBe(60_000);
  });
});
