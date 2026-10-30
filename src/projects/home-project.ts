import { basename } from "node:path";
import type { JevProjectPort } from "../core/jev-contracts.js";

/** Actor de los cambios del registro que hace el propio backend al arrancar (D9). */
export const BOOTSTRAP_ACTOR = "saiki-bootstrap";

/**
 * (Project Registry, D9) Registra el repositorio desde el que se arranca el
 * backend como primer proyecto, en modo sandbox, para mantener el uso actual
 * sin pasos manuales. Solo si no está registrado ya, activo o no: un proyecto
 * desactivado por el usuario no se reactiva. Respeta D1: si no es un
 * repositorio git, no se registra y se explica cómo hacerlo.
 * Devuelve una frase completa para el log de arranque.
 */
export async function registerHomeProject(core: JevProjectPort, path: string): Promise<string> {
  const r = await core.registerProject({ name: basename(path), path, applyMode: "sandbox" }, BOOTSTRAP_ACTOR);
  if (r.ok) return `registrado "${r.project.name}" (${r.project.rootPath}) como proyecto, en modo sandbox.`;
  if (r.code === "already_registered") return "el repositorio del backend ya está en el registro.";
  return `el repositorio del backend NO se registró como proyecto: ${r.message}${
    r.code === "not_a_repository" ? ' Ejecuta "git init" en él y reinicia, o registra otro proyecto desde Jev.' : ""
  }`;
}
