import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { SaikiCore } from "../core/saiki-core.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Apoyo de pruebas: repositorios git REALES en un directorio temporal.
 * (`git init` de verdad; sin commits, que no hacen falta para la validación.)
 */
export class TempRepos {
  readonly base = mkdtempSync(join(tmpdir(), "saiki-projects-"));

  /** Crea `name` como repositorio git con los archivos indicados. */
  repo(name: string, files: Record<string, string> = {}): string {
    const dir = join(this.base, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  /** Directorio normal (sin git). */
  dir(name: string): string {
    const dir = join(this.base, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}

/**
 * Apoyo de pruebas del Core: registra `root` como proyecto (lo convierte en repo
 * git si hace falta) con aplicación REAL, para que las pruebas comprueben las
 * escrituras en `root`, y abre `sessionId` ligada a él. Idempotente.
 */
export async function openDevSession(core: SaikiCore, root: string, sessionId: string): Promise<string> {
  if (!existsSync(join(root, ".git"))) execFileSync("git", ["init", "-q"], { cwd: root });
  const r = await core.registerProject({ name: "repo de prueba", path: root, applyMode: "real", confirmRealApply: true }, "test");
  const projectId = r.ok ? r.project.id : r.code === "already_registered" ? r.projectId : undefined;
  if (!projectId) throw new Error(`no se pudo registrar el proyecto de prueba: ${!r.ok ? r.message : ""}`);
  await core.openSession(sessionId, projectId);
  return projectId;
}
