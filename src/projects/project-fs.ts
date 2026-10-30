import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { ProjectFingerprint } from "../core/core-store.js";

/**
 * (Project Registry) Comprobaciones de un proyecto en el sistema de archivos:
 * validación de la ruta al registrar, huella del repositorio y estado de salud.
 *
 * Solo lectura: nunca crea, mueve ni repara nada. El backend es la única pieza
 * que toca el disco; el frontend solo envía la ruta como texto.
 */

export type PathErrorCode = "invalid_path" | "not_accessible" | "not_a_repository" | "sensitive_path";

export type PathValidation =
  | { ok: true; rootPath: string; fingerprint: ProjectFingerprint; resolvedFromSymlink: boolean }
  | { ok: false; code: PathErrorCode; message: string };

/** Salud calculada al leer (no se persiste). */
export type ProjectHealth = "ok" | "missing" | "moved" | "not_a_repository" | "not_accessible";

export interface HealthCheck {
  health: ProjectHealth;
  /** Motivo legible cuando la salud no es `ok`. */
  detail?: string;
}

export interface ValidateOptions {
  /** Directorio de datos de Saiki-IA (`.saiki/`): no se puede registrar ni nada dentro. */
  dataDir: string;
  /** Exigir escritura (modo de aplicación `real`). */
  requireWritable: boolean;
}

/** ¿`child` es `parent` o está dentro de él? (rutas absolutas normalizadas) */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/** realpath tolerante: si el directorio aún no existe, resuelve su padre existente. */
function realpathLoose(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(realpathLoose(parent), basename(p));
  }
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Directorio git del repositorio con raíz en `root`, o null si no es un repo
 * válido. Acepta `.git` como directorio (con `HEAD`) o como archivo `gitdir:`
 * (worktrees y submódulos).
 */
export function resolveGitDir(root: string): string | null {
  const dotGit = resolve(root, ".git");
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return null;
  }
  let gitDir: string;
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    gitDir = resolve(root, m[1].trim());
  } else {
    return null; // un symlink `.git` no se acepta
  }
  try {
    const real = realpathSync(gitDir);
    return statSync(resolve(real, "HEAD")).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Huella actual. Lanza si la raíz o su directorio git no existen. */
export function readFingerprint(root: string): ProjectFingerprint {
  const st = statSync(root);
  const gitDir = resolveGitDir(root);
  if (gitDir === null) throw new Error(`"${root}" no es un repositorio git`);
  return { dev: st.dev, ino: st.ino, gitDir, gitIno: statSync(gitDir).ino };
}

export function sameFingerprint(a: ProjectFingerprint, b: ProjectFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.gitDir === b.gitDir && a.gitIno === b.gitIno;
}

/** Valida una ruta propuesta por el usuario para registrarla como proyecto (§5). */
export function validateProjectPath(input: unknown, options: ValidateOptions): PathValidation {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    return { ok: false, code: "invalid_path", message: "Indica la ruta del proyecto." };
  }
  if (!isAbsolute(input)) {
    return { ok: false, code: "invalid_path", message: "La ruta debe ser absoluta (empieza por /)." };
  }
  const given = resolve(input);

  let real: string;
  try {
    if (!statSync(given).isDirectory()) {
      return { ok: false, code: "invalid_path", message: "La ruta no es un directorio." };
    }
    real = realpathSync(given);
  } catch (e) {
    return errnoCode(e) === "EACCES"
      ? { ok: false, code: "not_accessible", message: "El backend no tiene permiso para leer esa ruta." }
      : { ok: false, code: "invalid_path", message: "La ruta no existe." };
  }

  try {
    accessSync(real, constants.R_OK | constants.X_OK);
    if (options.requireWritable) accessSync(real, constants.W_OK);
  } catch {
    return {
      ok: false,
      code: "not_accessible",
      message: options.requireWritable
        ? "El backend no puede leer y escribir en esa ruta."
        : "El backend no puede leer esa ruta.",
    };
  }

  const home = realpathLoose(homedir());
  if (real === sep || isWithin(home, real)) {
    return { ok: false, code: "sensitive_path", message: "No se puede registrar la raíz del sistema ni tu carpeta personal completa." };
  }
  if (isWithin(real, realpathLoose(resolve(options.dataDir)))) {
    return { ok: false, code: "sensitive_path", message: "No se puede registrar el directorio de datos de Saiki-IA." };
  }

  if (resolveGitDir(real) === null) {
    return { ok: false, code: "not_a_repository", message: "La ruta no es la raíz de un repositorio git (falta .git)." };
  }

  return { ok: true, rootPath: real, fingerprint: readFingerprint(real), resolvedFromSymlink: real !== given };
}

/** Salud de un proyecto registrado: compara el disco actual con lo registrado. */
export function checkProjectHealth(rootPath: string, fingerprint: ProjectFingerprint): HealthCheck {
  let real: string;
  try {
    real = realpathSync(rootPath);
  } catch (e) {
    return errnoCode(e) === "EACCES"
      ? { health: "not_accessible", detail: "El backend no tiene permiso para leer la ruta." }
      : { health: "missing", detail: "La ruta registrada ya no existe." };
  }
  if (real !== rootPath) {
    return { health: "moved", detail: `La ruta registrada ahora apunta a otro sitio (${real}).` };
  }
  try {
    accessSync(real, constants.R_OK | constants.X_OK);
  } catch {
    return { health: "not_accessible", detail: "El backend no puede leer la ruta." };
  }
  if (resolveGitDir(real) === null) {
    return { health: "not_a_repository", detail: "La ruta ya no contiene un repositorio git." };
  }
  if (!sameFingerprint(readFingerprint(real), fingerprint)) {
    return { health: "moved", detail: "El repositorio de la ruta no es el registrado (se movió, se sustituyó o se volvió a crear)." };
  }
  return { health: "ok" };
}
