import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { type Proposal, hashProposal } from "./file-change.js";
import { resolveSafePath, PathValidationError } from "./path-validation.js";

/**
 * Aplicador controlado de cambios (Fase 6).
 *
 * Separado por completo del proceso de Claude: Claude NUNCA escribe. Este
 * modulo es codigo deterministo que aplica un conjunto ESTRUCTURADO y APROBADO
 * de cambios, con todas las salvaguardas que pidio el PO.
 */

/** Resultado de aplicar una propuesta. */
export interface ApplyResult {
  ok: boolean;
  /** Rutas efectivamente escritas (en orden). */
  applied: string[];
  /** Mensaje de error si ok=false. */
  error?: string;
  /**
   * true si la aplicacion fue PARCIAL (algunos archivos se escribieron y luego
   * fallo). Nunca se declara exito si quedo incompleto.
   */
  partial?: boolean;
}

/** Opciones para la aplicacion. */
export interface ApplyOptions {
  /** Directorio autorizado (absoluto). Todo cambio debe quedar dentro. */
  rootDir: string;
  /**
   * Hash aprobado por el humano. DEBE coincidir con el hash de `proposal`.
   * Si no coincide, no se aplica nada (la propuesta cambio tras aprobarse).
   */
  approvedHash: string;
  /**
   * Mapa opcional ruta -> hash del contenido BASE que la propuesta asumio.
   * Permite detectar cambios concurrentes del usuario: si el archivo en disco
   * ya no coincide con la base esperada, hay conflicto y se aborta.
   */
  expectedBaseHashes?: Record<string, string>;
}

/** Hash SHA-256 de un contenido (para comparar base esperada vs disco). */
function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Aplica una propuesta aprobada. Devuelve un ApplyResult; NO lanza (los fallos
 * se reportan). Secuencia de salvaguardas:
 *  1. El hash de la propuesta debe coincidir con el aprobado.
 *  2. Todas las rutas se validan ANTES de escribir nada (no traversal, etc.).
 *  3. Deteccion de conflictos: si un archivo existente difiere de la base que
 *     la propuesta asumio, se aborta (no se sobrescribe trabajo del usuario).
 *  4. Se escribe SOLO lo incluido en la propuesta aprobada.
 *  5. Si algo falla a mitad, se reporta `partial` con lo ya aplicado.
 */
export function applyProposal(proposal: Proposal, options: ApplyOptions): ApplyResult {
  const { rootDir, approvedHash, expectedBaseHashes } = options;

  // 1. Verificar que la propuesta es EXACTAMENTE la aprobada.
  const currentHash = hashProposal(proposal);
  if (currentHash !== approvedHash) {
    return {
      ok: false,
      applied: [],
      error:
        "La propuesta cambio tras la aprobacion (hash distinto). " +
        "Se requiere nueva aprobacion. No se aplico nada.",
    };
  }

  // 2. Validar TODAS las rutas antes de tocar el disco (fail-fast, atomico en
  //    validacion). Y 3. detectar conflictos sobre la base esperada.
  const resolved: { abs: string; content: string; rel: string }[] = [];
  for (const change of proposal.changes) {
    let abs: string;
    try {
      abs = resolveSafePath(rootDir, change.path);
    } catch (e) {
      if (e instanceof PathValidationError) {
        return { ok: false, applied: [], error: `Ruta invalida: ${e.message}` };
      }
      throw e;
    }

    // Deteccion de conflicto concurrente del usuario.
    if (expectedBaseHashes && Object.prototype.hasOwnProperty.call(expectedBaseHashes, change.path)) {
      const expected = expectedBaseHashes[change.path];
      const actual = existsSync(abs) ? hashContent(readFileSync(abs, "utf8")) : "";
      if (actual !== expected) {
        return {
          ok: false,
          applied: [],
          error:
            `Conflicto: "${change.path}" cambio en disco desde que se genero la ` +
            `propuesta. No se sobrescribe. Regenera la propuesta.`,
        };
      }
    }

    // `create` no debe pisar un archivo existente.
    if (change.operation === "create" && existsSync(abs)) {
      return {
        ok: false,
        applied: [],
        error: `La operacion "create" no puede sobrescribir un archivo existente: "${change.path}"`,
      };
    }

    resolved.push({ abs, content: change.content, rel: change.path });
  }

  // 4 y 5. Escribir. Si algo falla a mitad, reportar parcial.
  const applied: string[] = [];
  for (const item of resolved) {
    try {
      mkdirSync(dirname(item.abs), { recursive: true });
      writeFileSync(item.abs, item.content, "utf8");
      applied.push(item.rel);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        applied,
        partial: applied.length > 0,
        error: `Fallo al escribir "${item.rel}": ${msg}. Aplicados antes del fallo: ${applied.join(", ") || "ninguno"}.`,
      };
    }
  }

  return { ok: true, applied };
}
