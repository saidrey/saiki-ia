import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawnProcessRunner, type ProcessRunner } from "../agents/process-runner.js";
import { gitEnv } from "./project-scanner.js";

/**
 * (Project Context, T5) Firma de frescura (§8.3): hash de `HEAD`, de
 * `git status --porcelain`, del (tamaño, mtime) de cada ruta que lista ese
 * status (así se detecta una segunda edición de un archivo ya modificado) y de
 * los manifiestos de la raíz.
 * Si coincide con la del escaneo que produjo el último snapshot, el contexto está
 * al día. Sin git, solo cuentan los manifiestos.
 *
 * Solo lectura: `--no-optional-locks` evita que `git status` reescriba el índice
 * del repositorio, y el entorno no hereda variables `GIT_*`.
 */

export interface Freshness {
  signature: string;
  gitHead: string | null;
  /** Entradas de `git status` (aprox. rutas cambiadas respecto a HEAD); null sin git. */
  changedPaths: number | null;
  gitError?: string;
}

export interface FreshnessOptions {
  runner?: ProcessRunner;
  gitCommand?: string;
  timeoutMs?: number;
}

const ROOT_MANIFESTS = [
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "angular.json", "ionic.config.json", "capacitor.config.json", "capacitor.config.ts",
  "pubspec.yaml", "pubspec.lock", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json",
];
const STATUS_MAX_OUTPUT = 16 * 1024 * 1024;
/** Rutas de `git status` de las que se toma (tamaño, mtime); el resto cuenta solo por su texto. */
const MAX_STAT_PATHS = 5000;

async function statLine(rootPath: string, rel: string): Promise<string> {
  try {
    const st = await lstat(join(rootPath, rel));
    return `${rel}\0${st.size}\0${Math.trunc(st.mtimeMs)}\n`;
  } catch {
    return `${rel}\0-\n`;
  }
}

async function git(root: string, args: string[], o: FreshnessOptions): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const r = await (o.runner ?? spawnProcessRunner)({
    command: o.gitCommand ?? "git",
    args: ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args],
    cwd: root,
    env: gitEnv(),
    timeoutMs: o.timeoutMs ?? 30_000,
    maxOutputBytes: STATUS_MAX_OUTPUT,
  });
  if (r.startError) return { ok: false, error: `git no disponible: ${r.startError}` };
  if (r.timedOut) return { ok: false, error: `git ${args[0]} superó el tiempo límite` };
  if (r.exitCode !== 0) return { ok: false, error: `git ${args[0]} falló (${r.exitCode})` };
  return { ok: true, out: r.stdout };
}

export async function computeFreshness(rootPath: string, o: FreshnessOptions = {}): Promise<Freshness> {
  const h = createHash("sha256");
  let gitHead: string | null = null;
  let changedPaths: number | null = null;
  let gitError: string | undefined;

  // Un repositorio sin commits no tiene HEAD: no es un error de git.
  const head = await git(rootPath, ["rev-parse", "--verify", "-q", "HEAD"], o);
  if (head.ok) gitHead = head.out.trim() || null;
  const status = await git(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], o);
  if (status.ok) {
    // Con -z, un renombrado añade un campo sin prefijo de estado (la ruta de origen).
    const paths = status.out.split("\0").filter((e) => /^.. /.test(e)).map((e) => e.slice(3));
    changedPaths = paths.length;
    h.update(`git\0${gitHead ?? ""}\0${status.out}\0`);
    for (const rel of paths.slice(0, MAX_STAT_PATHS)) h.update(await statLine(rootPath, rel));
  } else {
    gitError = status.error;
    h.update("nogit\0");
  }

  for (const name of ROOT_MANIFESTS) {
    try {
      const st = await lstat(join(rootPath, name));
      h.update(`${name}\0${st.size}\0${Math.trunc(st.mtimeMs)}\n`);
    } catch {
      // ausente
    }
  }
  return { signature: h.digest("hex"), gitHead, changedPaths, ...(gitError ? { gitError } : {}) };
}
