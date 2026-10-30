import type { FileChange, Proposal } from "./file-change.js";

/**
 * Parser de propuestas (Fase 6).
 *
 * LIMITACION DOCUMENTADA: Claude en modo propuesta devuelve TEXTO LIBRE con
 * bloques de codigo, no un formato estructurado garantizado. No existe (ni se
 * inventa) una opcion de la CLI que devuelva JSON de cambios de archivo.
 *
 * SOLUCION SEGURA: este parser, codigo deterministo NUESTRO (no Claude),
 * extrae cambios estructurados a partir de una convencion explicita que
 * pedimos en el prompt: cada archivo se marca con una cabecera
 *     FILE: <ruta relativa>
 * seguida de un bloque de codigo cercado con ```.
 *
 * Si el texto no sigue la convencion, el parser devuelve 0 cambios y el flujo
 * lo trata como "nada que aplicar" (no se inventa contenido). La validacion de
 * rutas y el hash se aplican despues, en el aplicador.
 *
 * Nota: el parser NO decide operacion create/update de forma magica; marca
 * "create" por defecto y el aplicador rechaza "create" sobre archivos que ya
 * existen, forzando que el humano/pipeline reconsidere.
 */

/** Extrae FileChange[] de un texto con la convencion FILE: + bloque ```. */
export function parseChangesFromText(text: string): FileChange[] {
  const changes: FileChange[] = [];

  // Busca: FILE: ruta  \n  ```lang\n ...contenido... \n```
  const re = /FILE:\s*(.+?)\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    if (path.length > 0) {
      changes.push({ path, operation: "create", content });
    }
  }

  return changes;
}

/** Construye una Proposal con un id dado a partir de texto libre. */
export function buildProposalFromText(id: string, text: string): Proposal {
  return { id, changes: parseChangesFromText(text) };
}
