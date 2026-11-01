import { describe, it, expect } from "vitest";
import { CLAUDE_READ_TOOLS, CLAUDE_TIMEOUT_ENV, ClaudeCliAdapter, DEFAULT_CLAUDE_TIMEOUT_MS, resolveClaudeTimeoutMs } from "./claude-cli-agent.js";
import { spawnProcessRunner } from "./process-runner.js";
import type { ProcessResult, ProcessRunner } from "./process-runner.js";

/**
 * Tests DETERMINISTAS del ClaudeCliAdapter.
 *
 * NO se invoca Claude real. Inyectamos un `ProcessRunner` falso. Probamos el
 * mapeo a AgentResult y, sobre todo, que se pasan los flags de SEGURIDAD
 * verificados que impiden escritura/ejecucion.
 */

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

describe("Fase 5: ClaudeCliAdapter (mapeo determinista)", () => {
  it("exito: exit 0 con stdout -> status 'success' y output limpio", async () => {
    const agent = new ClaudeCliAdapter({
      runner: fakeRunner({ stdout: "  ```ts\nconst x = 1;\n```  ", exitCode: 0 }),
    });

    const result = await agent.run({ role: "develop", input: "plan X" });

    expect(result.status).toBe("success");
    expect(result.role).toBe("develop");
    expect(result.output).toContain("const x = 1;");
    expect(result.error).toBeUndefined();
  });

  it("exit code != 0 -> status 'failure' con detalle", async () => {
    const agent = new ClaudeCliAdapter({
      runner: fakeRunner({ stderr: "error de auth", exitCode: 1 }),
    });

    const result = await agent.run({ role: "develop", input: "plan X" });

    expect(result.status).toBe("failure");
    expect(result.output).toBe("");
    expect(result.error).toContain("codigo 1");
    expect(result.error).toContain("error de auth");
  });

  it("timeout -> status 'failure' indicando el timeout", async () => {
    const agent = new ClaudeCliAdapter({
      timeoutMs: 120000,
      runner: fakeRunner({ timedOut: true, exitCode: null }),
    });

    const result = await agent.run({ role: "develop", input: "plan X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("timeout");
  });

  it("fallo al iniciar -> status 'failure' con el startError", async () => {
    const agent = new ClaudeCliAdapter({
      command: "claude",
      runner: fakeRunner({ exitCode: null, startError: "spawn claude ENOENT" }),
    });

    const result = await agent.run({ role: "develop", input: "plan X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No se pudo iniciar");
    expect(result.error).toContain("ENOENT");
  });

  it("stdout vacio con exit 0 -> 'failure' (no exito vacio)", async () => {
    const agent = new ClaudeCliAdapter({
      runner: fakeRunner({ stdout: "  ", exitCode: 0 }),
    });

    const result = await agent.run({ role: "develop", input: "plan X" });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("no devolvio salida");
  });

  it("SEGURIDAD: solo lectura (Read/Glob/Grep), sin escritura/ejecucion, y el prompt por stdin", async () => {
    let capturedArgs: string[] = [];
    let capturedStdin: string | undefined;
    const spyRunner: ProcessRunner = async (req) => {
      capturedArgs = req.args;
      capturedStdin = req.stdin;
      return {
        stdout: "propuesta",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    };
    const agent = new ClaudeCliAdapter({ runner: spyRunner });

    await agent.run({ role: "develop", input: "plan X" });

    // Modo no interactivo.
    expect(capturedArgs).toContain("-p");
    // Solo lectura: las únicas herramientas built-in de la sesión son Read, Glob y Grep.
    const valueOf = (flag: string) => capturedArgs[capturedArgs.indexOf(flag) + 1];
    expect(valueOf("--tools")).toBe("Read,Glob,Grep");
    expect(valueOf("--tools").split(",")).toEqual([...CLAUDE_READ_TOOLS]);
    // Pre-aprobadas solo las de lectura; el resto se deniega sin preguntar.
    const allowed = capturedArgs.slice(capturedArgs.indexOf("--allowedTools") + 1, capturedArgs.indexOf("--permission-mode"));
    expect(allowed).toEqual(["Read", "Glob", "Grep"]);
    expect(valueOf("--permission-mode")).toBe("dontAsk");
    // Confinado al directorio de trabajo y sin MCP.
    expect(capturedArgs).toContain("--restricted");
    expect(capturedArgs).toContain("--strict-mcp-config");
    // Defensa en profundidad: escritura, ejecución y red denegadas explícitamente.
    const denied = capturedArgs.slice(capturedArgs.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"]));
    // Ninguna herramienta de escritura o ejecución aparece como disponible ni permitida.
    for (const t of ["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"]) {
      expect(valueOf("--tools").split(",")).not.toContain(t);
      expect(allowed).not.toContain(t);
    }
    expect(capturedArgs).not.toContain("--dangerously-skip-permissions");
    // CLAVE: el prompt va por STDIN, no como argumento posicional (evita que
    // --disallowedTools variadico se coma las palabras del prompt).
    expect(capturedStdin).toBeDefined();
    expect(capturedStdin).toContain("PROPUESTA");
    expect(capturedStdin).toContain("plan X");
    // El prompt NO debe estar en los args.
    expect(capturedArgs.some((a) => a.includes("plan X"))).toBe(false);
  });
});

describe("SAIKI_CLAUDE_TIMEOUT_MS", () => {
  it("sin definir o vacía: 120 000 ms predeterminados", () => {
    expect(resolveClaudeTimeoutMs({})).toEqual({ ok: true, timeoutMs: 120_000, source: "default" });
    expect(resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: "" })).toEqual({ ok: true, timeoutMs: 120_000, source: "default" });
    expect(resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: "   " })).toMatchObject({ ok: true, source: "default" });
    expect(DEFAULT_CLAUDE_TIMEOUT_MS).toBe(120_000);
  });

  it("valor personalizado válido (mismo máximo que Kiro)", () => {
    expect(resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: "600000" })).toEqual({ ok: true, timeoutMs: 600_000, source: "env" });
    expect(resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: "2147483647" })).toMatchObject({ ok: true, timeoutMs: 2_147_483_647 });
  });

  it("valores inválidos: error explícito que nombra la variable", () => {
    for (const v of ["abc", "0", "-1", "1.5", "1e5", "120s", "2147483648"]) {
      const r = resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: v });
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.message).toContain(CLAUDE_TIMEOUT_ENV);
    }
  });

  it("sin configuración el adaptador mantiene 120 s; con ella pasa el valor al proceso", async () => {
    const seen: number[] = [];
    const runner: ProcessRunner = async (req) => {
      seen.push(req.timeoutMs);
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    await new ClaudeCliAdapter({ runner }).run({ role: "develop", input: "x" });
    const r = resolveClaudeTimeoutMs({ [CLAUDE_TIMEOUT_ENV]: "600000" });
    if (!r.ok) throw new Error(r.message);
    await new ClaudeCliAdapter({ runner, timeoutMs: r.timeoutMs }).run({ role: "develop", input: "x" });
    expect(seen).toEqual([120_000, 600_000]);
  });

  it("expiración real: el proceso se corta y el error informa el timeout configurado", async () => {
    // Proceso real que tarda más que el timeout (sin llamar a Claude).
    const sleeper: ProcessRunner = (req) => spawnProcessRunner({ ...req, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] });
    const started = Date.now();
    const result = await new ClaudeCliAdapter({ runner: sleeper, timeoutMs: 300 }).run({ role: "develop", input: "x" });
    expect(result).toMatchObject({ status: "failure", error: "Claude Code excedio el timeout de 300 ms." });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
