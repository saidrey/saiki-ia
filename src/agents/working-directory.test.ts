import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroCliAdapter } from "./kiro-cli-agent.js";
import { ClaudeCliAdapter } from "./claude-cli-agent.js";
import { OpenCodeCliAdapter } from "./opencode-cli-agent.js";
import { spawnProcessRunner, type ProcessRequest, type ProcessRunner } from "./process-runner.js";
import { ClaudeConversationEngine } from "../moderator/claude-conversation-engine.js";

/** (Project Registry) El directorio de la ejecución llega hasta el proceso del agente. */

function observedRunner(): { runner: ProcessRunner; requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  return {
    requests,
    runner: async (req) => {
      requests.push(req);
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    },
  };
}

describe("cwd de los agentes", () => {
  it("Kiro, Claude y OpenCode pasan context.workingDirectory como cwd del proceso", async () => {
    for (const make of [
      (runner: ProcessRunner) => new KiroCliAdapter({ runner, trustTools: "fs_read" }),
      (runner: ProcessRunner) => new ClaudeCliAdapter({ runner, rawPrompt: true }),
      (runner: ProcessRunner) => new OpenCodeCliAdapter({ runner }),
    ]) {
      const { runner, requests } = observedRunner();
      const adapter = make(runner);
      await adapter.run({ role: "technicalAnalyst", input: "x", context: { workingDirectory: "/repos/app" } });
      await adapter.run({ role: "technicalAnalyst", input: "x" });
      expect(requests.map((r) => r.cwd), adapter.name).toEqual(["/repos/app", undefined]);
    }
  });

  it("spawn real: el proceso arranca en ese directorio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saiki-cwd-"));
    try {
      const r = await spawnProcessRunner({ command: "pwd", args: [], timeoutMs: 5_000, maxOutputBytes: 10_000, cwd: dir });
      expect(r.exitCode).toBe(0);
      expect(realpathSync(r.stdout.trim())).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cwd del moderador (D8)", () => {
  it("cada llamada corre en un directorio vacío propio, que se borra al terminar; nunca el del backend", async () => {
    const seen: Array<{ cwd: string | undefined; existed: boolean; entries: number }> = [];
    const runner: ProcessRunner = async (req) => {
      const { existsSync, readdirSync } = await import("node:fs");
      seen.push({ cwd: req.cwd, existed: !!req.cwd && existsSync(req.cwd), entries: req.cwd ? readdirSync(req.cwd).length : -1 });
      return { stdout: "respuesta", stderr: "", exitCode: 0, timedOut: false, truncated: false };
    };
    const engine = new ClaudeConversationEngine({ runner });
    await engine.complete({ prompt: "hola" });
    await engine.complete({ prompt: "hola otra vez" });
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.cwd).toMatch(/saiki-moderator-/);
      expect(s.cwd).not.toBe(process.cwd());
      expect(s).toMatchObject({ existed: true, entries: 0 });
      expect((await import("node:fs")).existsSync(s.cwd!)).toBe(false);
    }
    expect(seen[0].cwd).not.toBe(seen[1].cwd);
  });
});
