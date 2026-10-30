import { describe, it, expect } from "vitest";
import { ClaudeCliAdapter } from "./claude-cli-agent.js";
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

  it("SEGURIDAD: pasa flags que impiden escritura/ejecucion y el prompt por stdin", async () => {
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
    // Sin herramientas built-in: tras "--tools" viene "" (cadena vacia).
    const toolsIdx = capturedArgs.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[toolsIdx + 1]).toBe("");
    // Defensa en profundidad.
    expect(capturedArgs).toContain("--restricted");
    expect(capturedArgs).toContain("--strict-mcp-config");
    expect(capturedArgs).toContain("--disallowedTools");
    expect(capturedArgs).toContain("Write");
    expect(capturedArgs).toContain("Edit");
    expect(capturedArgs).toContain("Bash");
    // CLAVE: el prompt va por STDIN, no como argumento posicional (evita que
    // --disallowedTools variadico se coma las palabras del prompt).
    expect(capturedStdin).toBeDefined();
    expect(capturedStdin).toContain("PROPUESTA");
    expect(capturedStdin).toContain("plan X");
    // El prompt NO debe estar en los args.
    expect(capturedArgs.some((a) => a.includes("plan X"))).toBe(false);
  });
});
