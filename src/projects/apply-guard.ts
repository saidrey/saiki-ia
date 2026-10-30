import { cpSync, existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CoreStore } from "../core/core-store.js";
import type { ApplyGuard } from "../hu/hu-graph.js";
import { sameBinding } from "./project-binding.js";
import { checkProjectHealth, isWithin } from "./project-fs.js";

/**
 * (Project Registry) Guardia previa a la escritura del Safe Applier.
 *
 * Se evalúa dentro de `applyTask`, inmediatamente antes de escribir. Exige que:
 *  1. la ejecución tenga proyecto vinculado (sin él no se aplica: precisión 6);
 *  2. la copia del estado del grafo y la de `execution_projects` coincidan;
 *  3. el proyecto siga registrado, activo (D5) y con la misma ruta;
 *  4. el disco siga siendo el mismo repositorio: misma ruta real, `.git` y huella
 *     (detecta movido, borrado, sustituido o un symlink nuevo).
 * Si algo falla devuelve el motivo y el grafo termina en `apply_blocked` sin
 * escribir. Nunca busca el repositorio en otra ruta.
 *
 * Destino: el repo real solo si el proyecto está en modo `real` al vincularse Y
 * ahora (la opción más restrictiva gana); si no, un sandbox PROPIO de la
 * ejecución, copia completa del repo sin `.git`, dependencias ni artefactos de
 * build. Nunca se comparte entre ejecuciones.
 */

/** Nombres que no se copian al sandbox, en cualquier nivel. */
export const SANDBOX_EXCLUDED = new Set([
  ".git",
  "node_modules",
  ".saiki",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".angular",
  ".dart_tool",
  ".gradle",
  "coverage",
  "Pods",
]);

const SANDBOX_PREFIX = "saiki-sandbox-";

export interface ApplyGuardOptions {
  store: CoreStore;
  /** Dónde crear los sandboxes (default: temporal del sistema). */
  sandboxDir?: string;
}

/** Prefijo del sandbox de una ejecución (el id se sanea para usarlo como nombre). */
function sandboxPrefix(executionId: string): string {
  return `${SANDBOX_PREFIX}${executionId.replace(/[^A-Za-z0-9_-]/g, "_")}-`;
}

export function createApplyGuard(options: ApplyGuardOptions): ApplyGuard {
  const sandboxRoot = () => realpathSync(options.sandboxDir ?? tmpdir());

  return ({ executionId, state }) => {
    const block = (reason: string) => ({ ok: false as const, reason: `Aplicación bloqueada: ${reason}` });

    const b = state.project;
    if (!b) return block("la ejecución no tiene un proyecto vinculado. Requiere intervención humana.");

    const row = options.store.getExecutionProject(executionId);
    if (!row) return block("no consta la vinculación de esta ejecución con su proyecto.");
    if (!sameBinding(b, row)) return block("la vinculación del estado de la ejecución no coincide con la registrada.");

    const p = options.store.getProject(b.projectId);
    if (!p) return block(`el proyecto "${b.projectName}" ya no está en el registro.`);
    if (p.status !== "active") return block(`el proyecto "${p.name}" está desactivado.`);
    if (p.rootPath !== b.rootPath) return block("la ruta registrada del proyecto no coincide con la de la ejecución.");

    const { health, detail } = checkProjectHealth(b.rootPath, b.fingerprint);
    if (health !== "ok") return block(`${detail ?? health} No se busca el repositorio en otra ruta.`);

    const real = b.applyMode === "real" && p.applyMode === "real";
    const previous = state.applyTarget;

    if (real) {
      if (previous && previous !== b.rootPath) return block("esta ejecución ya se aplicó en otro destino.");
      return { ok: true, applyDir: b.rootPath };
    }

    // Sandbox de ESTA ejecución: se reutiliza solo el suyo (reintento tras un corte).
    const root = sandboxRoot();
    const prefix = sandboxPrefix(executionId);
    if (previous) {
      const ownSandbox = isWithin(previous, root) && basename(previous).startsWith(prefix);
      if (!ownSandbox) return block("esta ejecución ya se aplicó en otro destino.");
      if (!existsSync(previous) || !statSync(previous).isDirectory()) {
        return block("el sandbox de esta ejecución ya no existe. Requiere intervención humana.");
      }
      return { ok: true, applyDir: previous };
    }

    const dir = mkdtempSync(join(root, prefix));
    cpSync(b.rootPath, dir, {
      recursive: true,
      filter: (src) => src === b.rootPath || !SANDBOX_EXCLUDED.has(basename(src)),
    });
    return { ok: true, applyDir: dir };
  };
}
