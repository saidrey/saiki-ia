import type { ApplyMode, ProjectFingerprint } from "../core/core-store.js";

/**
 * (Project Registry) Copia del proyecto con la que nace una ejecución.
 *
 * Se fija UNA vez, al crear la ejecución, en dos sitios independientes: el
 * estado del grafo (campo `project`, reducer que conserva el primer valor) y la
 * tabla de solo inserción `execution_projects`. La ejecución usa solo esta copia,
 * aunque el registro cambie después; la guardia de aplicación compara ambas
 * fuentes con el disco antes de escribir.
 */
export interface ProjectBinding {
  projectId: string;
  /** Nombre del proyecto al empezar (si se renombra después, la copia no cambia). */
  projectName: string;
  /** Ruta real del repositorio al empezar. */
  rootPath: string;
  /** Modo de aplicación vigente al empezar. */
  applyMode: ApplyMode;
  fingerprint: ProjectFingerprint;
  boundAt: string;
}

/** ¿Las dos copias describen exactamente el mismo proyecto, ruta, modo y huella? */
export function sameBinding(a: ProjectBinding, b: ProjectBinding): boolean {
  return (
    a.projectId === b.projectId &&
    a.rootPath === b.rootPath &&
    a.applyMode === b.applyMode &&
    a.boundAt === b.boundAt &&
    a.fingerprint.dev === b.fingerprint.dev &&
    a.fingerprint.ino === b.fingerprint.ino &&
    a.fingerprint.gitDir === b.fingerprint.gitDir &&
    a.fingerprint.gitIno === b.fingerprint.gitIno
  );
}
