import { resolve, isAbsolute, relative, dirname } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

/**
 * Validacion de rutas para la aplicacion controlada de cambios (Fase 6).
 *
 * Objetivo de seguridad: impedir que una propuesta escriba FUERA del directorio
 * autorizado. Bloquea:
 *  - rutas absolutas,
 *  - traversal con "../",
 *  - enlaces simbolicos que apunten fuera del directorio (symlink escape),
 *  - cualquier destino que, resuelto, caiga fuera del directorio raiz.
 */

/** Error de validacion de ruta (se reporta, no se aplica nada). */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

/**
 * Valida que `relativePath` sea seguro dentro de `rootDir` y devuelve la ruta
 * absoluta ya resuelta y verificada. Lanza `PathValidationError` si no es segura.
 *
 * `rootDir` debe ser una ruta absoluta al directorio autorizado.
 */
export function resolveSafePath(rootDir: string, relativePath: string): string {
  // 1. Rechazar rutas absolutas de entrada.
  if (isAbsolute(relativePath)) {
    throw new PathValidationError(`Ruta absoluta no permitida: "${relativePath}"`);
  }

  // 2. Rechazar explicitamente segmentos de traversal.
  //    (resolve ya normaliza, pero lo rechazamos ANTES para ser claros.)
  const segments = relativePath.split(/[/\\]/);
  if (segments.includes("..")) {
    throw new PathValidationError(`Traversal "../" no permitido: "${relativePath}"`);
  }

  const root = resolve(rootDir);
  const target = resolve(root, relativePath);

  // 3. El destino resuelto debe quedar DENTRO del root.
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathValidationError(
      `La ruta escapa del directorio autorizado: "${relativePath}"`,
    );
  }

  // 4. Proteccion contra symlink escape: si el archivo (o alguno de sus
  //    directorios padre existentes) es un symlink, su destino real debe seguir
  //    dentro del root. Evita que un symlink preexistente redirija la escritura
  //    fuera del directorio autorizado.
  assertNoSymlinkEscape(root, target);

  return target;
}

/** Devuelve el realpath del ancestro existente mas cercano de `p`. */
function realpathOfNearestExisting(p: string): string {
  let current = p;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current; // raiz del FS
    current = parent;
  }
  return realpathSync(current);
}

/**
 * Verifica que `target` no escape del root via symlinks. Compara el realpath
 * del ancestro existente del TARGET contra el realpath del ancestro existente
 * del ROOT. Resolver ambos lados igual evita falsos positivos por symlinks del
 * sistema (p. ej. /var -> /private/var en macOS).
 */
function assertNoSymlinkEscape(root: string, target: string): void {
  const realRoot = realpathOfNearestExisting(root);
  const realTargetAncestor = realpathOfNearestExisting(target);

  const rel = relative(realRoot, realTargetAncestor);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathValidationError(
      `La ruta resuelve (via symlink) fuera del directorio autorizado: "${target}"`,
    );
  }

  // Si el propio target existe y es un symlink, lo rechazamos: no escribimos a
  // traves de symlinks.
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new PathValidationError(`El destino es un enlace simbolico: "${target}"`);
  }
}
