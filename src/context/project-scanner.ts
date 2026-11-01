import { open, lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectFingerprint } from "../core/core-store.js";
import { spawnProcessRunner, type ProcessRunner } from "../agents/process-runner.js";
import { checkProjectHealth, isWithin } from "../projects/project-fs.js";
import { classifyPath, exclusionOf, EXCLUDED_DIRS, type FileKind } from "./file-classifier.js";

/**
 * (Project Context, T1) Project Scanner: lista y clasifica los archivos de un
 * proyecto registrado.
 *
 * Garantías:
 * - SOLO LECTURA. No escribe en el repositorio: `git ls-files` no toca el índice
 *   ni ejecuta hooks, y se desactiva `core.fsmonitor` (que podría lanzar un
 *   programa configurado en el repositorio).
 * - `git` se lanza sin variables `GIT_*` heredadas: un `GIT_DIR` del entorno no
 *   puede redirigir el listado a otro repositorio.
 * - Identidad: comprueba salud y huella del proyecto ANTES y DESPUÉS de listar;
 *   si cambian, el resultado se descarta.
 * - No sigue enlaces simbólicos (se informan, no se recorren) ni lista nada
 *   dentro del directorio de datos de Saiki-IA (`excludePaths`).
 * - Secretos: se registra su nombre; su contenido nunca se abre.
 * - Determinista: mismo disco, mismo resultado (rutas ordenadas).
 *
 * Fuera de T1: hashes y detección incremental (T3), extractores (T4).
 */

export interface ScanOptions {
  /** Raíz real del proyecto (`rootPath` del registro). */
  rootPath: string;
  /** Huella registrada: se exige igual antes y después de listar. */
  fingerprint: ProjectFingerprint;
  /** Rutas absolutas que nunca se listan (directorio de datos de Saiki-IA). */
  excludePaths?: string[];
  /** Tope de archivos indexados (D10). Por defecto 50 000. */
  maxFiles?: number;
  /** Ejecutor de procesos (inyectable en pruebas). */
  runner?: ProcessRunner;
  /** Comando git (pruebas: forzar la alternativa sin git). */
  gitCommand?: string;
  gitTimeoutMs?: number;
}

export interface ScannedFile {
  /** Ruta relativa POSIX desde la raíz. */
  path: string;
  kind: FileKind;
  lang: string | null;
  size: number;
  mtimeMs: number;
}

export type SkipReason =
  | "excluded_dir"
  | "excluded_file"
  | "data_dir"
  | "symlink"
  | "symlink_outside"
  | "not_regular"
  | "missing"
  | "invalid_path"
  | "unreadable";

export interface SkipSummary {
  reason: SkipReason;
  count: number;
  /** Primeras rutas (orden alfabético), como mucho `MAX_EXAMPLES`. */
  examples: string[];
}

export interface FileListing {
  rootPath: string;
  /** Cómo se obtuvo la lista: git (respeta .gitignore) o recorrido propio. */
  source: "git" | "walk";
  /** Por qué no se usó git, si se recurrió al recorrido propio. */
  gitError?: string;
  files: ScannedFile[];
  skipped: SkipSummary[];
  /** true si se alcanzó `maxFiles` (se indexan los primeros por orden de ruta). */
  truncated: boolean;
  startedAt: string;
  finishedAt: string;
}

export type ScanErrorCode = "project_unhealthy" | "project_identity_changed";

export type ScanResult =
  | { ok: true; listing: FileListing }
  | { ok: false; code: ScanErrorCode; message: string };

export const DEFAULT_MAX_FILES = 50_000;
const MAX_EXAMPLES = 20;
/** Bytes que se miran para distinguir texto de binario (extensión desconocida). */
const SNIFF_BYTES = 8192;
/** Salida máxima de `git ls-files` (~50 000 rutas caben de sobra). */
const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

/** Entorno para git: el del backend sin ninguna variable `GIT_*`. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_")) env[k] = v;
  return env;
}

class Skips {
  private readonly byReason = new Map<SkipReason, string[]>();
  add(reason: SkipReason, path: string): void {
    const list = this.byReason.get(reason) ?? [];
    list.push(path);
    this.byReason.set(reason, list);
  }
  summary(): SkipSummary[] {
    return [...this.byReason.entries()]
      .map(([reason, paths]) => ({ reason, count: paths.length, examples: paths.sort().slice(0, MAX_EXAMPLES) }))
      .sort((a, b) => (a.reason < b.reason ? -1 : 1));
  }
}

/** Ruta relativa aceptable: POSIX, sin `..`, sin absolutas, sin NUL. */
function validRelative(p: string): boolean {
  return p !== "" && !p.startsWith("/") && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === "." || s === "");
}

/** Lista con git: archivos versionados + no versionados no ignorados. */
async function listWithGit(
  root: string,
  runner: ProcessRunner,
  command: string,
  timeoutMs: number,
): Promise<{ ok: true; paths: string[]; truncated: boolean } | { ok: false; error: string }> {
  const r = await runner({
    command,
    args: ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    cwd: root,
    env: gitEnv(),
    timeoutMs,
    maxOutputBytes: GIT_MAX_OUTPUT,
  });
  if (r.startError) return { ok: false, error: `git no disponible: ${r.startError}` };
  if (r.timedOut) return { ok: false, error: "git ls-files superó el tiempo límite" };
  if (r.exitCode !== 0) return { ok: false, error: `git ls-files falló (${r.exitCode}): ${r.stderr.trim().slice(0, 300)}` };
  let out = r.stdout;
  // Salida truncada: descartar la última ruta, que puede estar cortada.
  if (r.truncated) out = out.slice(0, out.lastIndexOf("\0") + 1);
  // `--cached` repite rutas en conflicto; un directorio anidado llega con "/".
  const paths = [...new Set(out.split("\0").filter((p) => p !== ""))];
  return { ok: true, paths, truncated: r.truncated };
}

/**
 * Recorrido propio, sin git: solo exclusiones fijas (no interpreta .gitignore).
 * No entra en enlaces simbólicos ni en directorios excluidos o de datos.
 */
async function listWithWalk(root: string, excluded: string[], skips: Skips): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      skips.add("unreadable", rel || ".");
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (rel === "" && e.name === ".git") continue;
        if (EXCLUDED_DIRS.has(e.name)) skips.add("excluded_dir", `${child}/`);
        else if (excluded.some((x) => isWithin(join(root, child), x))) skips.add("data_dir", `${child}/`);
        else pending.push(child);
      } else {
        out.push(child); // archivos, enlaces y especiales: se deciden después con lstat
      }
    }
  }
  return out;
}

/** ¿Contenido binario? (byte NUL en los primeros bytes) */
async function looksBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** Lista y clasifica los archivos del proyecto. Nunca escribe en él. */
export async function scanProjectFiles(options: ScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const root = options.rootPath;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const before = checkProjectHealth(root, options.fingerprint);
  if (before.health !== "ok") {
    return { ok: false, code: "project_unhealthy", message: `No se puede escanear el proyecto: ${before.detail}` };
  }

  const excluded = await Promise.all((options.excludePaths ?? []).map(realpathOrSelf));
  const skips = new Skips();

  const git = await listWithGit(
    root,
    options.runner ?? spawnProcessRunner,
    options.gitCommand ?? "git",
    options.gitTimeoutMs ?? 60_000,
  );
  const source: FileListing["source"] = git.ok ? "git" : "walk";
  const candidates = git.ok ? git.paths : await listWithWalk(root, excluded, skips);
  let truncated = git.ok && git.truncated;

  candidates.sort();
  const files: ScannedFile[] = [];
  for (const rel of candidates) {
    if (rel.endsWith("/")) {
      skips.add("not_regular", rel); // repositorio anidado no versionado
      continue;
    }
    if (!validRelative(rel)) {
      skips.add("invalid_path", rel);
      continue;
    }
    const excludedBy = exclusionOf(rel);
    if (excludedBy) {
      skips.add(excludedBy, rel);
      continue;
    }
    const abs = join(root, rel);
    if (excluded.some((x) => isWithin(abs, x))) {
      skips.add("data_dir", rel);
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }

    let st;
    try {
      st = await lstat(abs);
    } catch {
      skips.add("missing", rel); // versionado pero borrado del disco
      continue;
    }
    if (st.isSymbolicLink()) {
      let inside = false;
      try {
        inside = isWithin(await realpath(abs), root);
      } catch {
        inside = false; // enlace roto
      }
      skips.add(inside ? "symlink" : "symlink_outside", rel);
      continue;
    }
    if (!st.isFile()) {
      skips.add("not_regular", rel); // submódulo, socket, fifo…
      continue;
    }

    const c = classifyPath(rel);
    let kind = c.kind;
    if (c.needsContentSniff) {
      try {
        if (await looksBinary(abs)) kind = "binary";
      } catch {
        skips.add("unreadable", rel);
        continue;
      }
    }
    files.push({ path: rel, kind, lang: kind === "binary" ? null : c.lang, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }

  // La identidad debe seguir siendo la misma al terminar: si el repositorio se
  // movió o se sustituyó durante el listado, el resultado no vale.
  const after = checkProjectHealth(root, options.fingerprint);
  if (after.health !== "ok") {
    return { ok: false, code: "project_identity_changed", message: `El proyecto cambió durante el escaneo: ${after.detail}` };
  }

  return {
    ok: true,
    listing: {
      rootPath: root,
      source,
      ...(git.ok ? {} : { gitError: git.error }),
      files,
      skipped: skips.summary(),
      truncated,
      startedAt,
      finishedAt: new Date().toISOString(),
    },
  };
}
