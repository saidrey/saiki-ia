import { createHash } from "node:crypto";

/**
 * Formato ESTRUCTURADO de cambios de archivos (Fase 6).
 *
 * Este es el artefacto que se APRUEBA y se APLICA. No es texto libre: tiene
 * ruta relativa, contenido propuesto y una operacion explicita. La aplicacion
 * de cambios (ver applier.ts) opera SOLO sobre este formato, nunca sobre
 * instrucciones de shell ni scripts generados por el modelo.
 */

/**
 * Operaciones permitidas sobre un archivo.
 *  - "create": crear un archivo que NO existe.
 *  - "update": reemplazar el contenido de un archivo que SÍ existe.
 *  - "delete": eliminar un archivo existente (Fase 13). `content` se ignora.
 */
export type FileOperation = "create" | "update" | "delete";

/** Un cambio propuesto para un unico archivo. */
export interface FileChange {
  /** Ruta RELATIVA al directorio autorizado (p. ej. "src/sum.ts"). */
  path: string;
  /** Operacion permitida. */
  operation: FileOperation;
  /** Contenido completo propuesto para el archivo (vacío para "delete"). */
  content: string;
}

/** Una propuesta: un identificador y el conjunto de cambios. */
export interface Proposal {
  /** Identificador legible de la propuesta (para que el humano la reconozca). */
  id: string;
  /** Lista de cambios de archivos. */
  changes: FileChange[];
}

/**
 * Calcula un hash SHA-256 ESTABLE de una propuesta.
 *
 * Es la pieza clave del criterio del PO ("lo aprobado == lo aplicado"): se
 * aprueba un hash y el aplicador solo escribe si el hash de la propuesta actual
 * coincide con el aprobado. Si la propuesta cambia tras aprobarse, el hash
 * difiere y se exige nueva aprobacion.
 *
 * El hash es determinista: se serializan los cambios ordenados por ruta, con
 * sus campos en orden fijo. Asi el mismo contenido produce siempre el mismo
 * hash, independientemente del orden de entrada.
 */
export function hashProposal(proposal: Proposal): string {
  const ordered = [...proposal.changes].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = JSON.stringify({
    id: proposal.id,
    changes: ordered.map((c) => ({
      path: c.path,
      operation: c.operation,
      content: c.content,
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Resumen legible de una propuesta para mostrar al humano en la interrupcion.
 * Incluye que archivos se tocan y con que operacion (sin volcar todo el
 * contenido, que puede ser largo; el contenido va aparte y el hash lo fija).
 */
export function summarizeProposal(proposal: Proposal): string {
  const lines = proposal.changes.map((c) =>
    c.operation === "delete"
      ? `  - [delete] ${c.path}`
      : `  - [${c.operation}] ${c.path} (${c.content.length} bytes)`,
  );
  return `Propuesta "${proposal.id}" con ${proposal.changes.length} archivo(s):\n${lines.join("\n")}`;
}
