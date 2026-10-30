import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { type Proposal, hashProposal } from "./file-change.js";
import { resolveSafePath, PathValidationError } from "./path-validation.js";

/**
 * Aplicador transaccional BEST-EFFORT (Fase 7).
 *
 * LIMITACION HONESTA: el sistema de archivos NO es transaccional. No se puede
 * garantizar atomicidad real a nivel de FS. Lo que ofrece este modulo es:
 *  1. Snapshot del estado PREVIO de cada archivo (contenido o "no existia").
 *  2. Aplicacion de los cambios.
 *  3. Si algo falla a mitad, rollback best-effort restaurando desde el snapshot.
 *  4. Si el rollback TAMBIEN falla, NO se finge exito: se devuelve un informe
 *     explicito con los archivos afectados y lo que quedo pendiente.
 *
 * NO se le llama "transaccional" a secas porque no lo es; es "best-effort con
 * restauracion y reporte explicito".
 *
 * Idempotencia: el llamador pasa `alreadyAppliedHash`. Si coincide con el hash
 * de la propuesta, se considera YA APLICADA y no se vuelve a escribir.
 *
 * Operaciones soportadas (Fase 13): "create", "update" y "delete". El snapshot
 * previo de cada archivo (contenido o "no existía") permite restaurar cualquiera
 * de las tres en el rollback best-effort: un "delete" revertido re-escribe el
 * contenido previo; un "create" revertido elimina el archivo creado.
 */

/** Estado previo de un archivo para poder restaurarlo. */
interface FileSnapshot {
  abs: string;
  rel: string;
  existedBefore: boolean;
  previousContent: string | null;
}

/** Resultado de la aplicacion transaccional. */
export interface TxApplyResult {
  /** "applied" | "noop" (ya aplicada) | "rolled_back" | "unrecoverable" | "rejected" */
  outcome: "applied" | "noop" | "rolled_back" | "unrecoverable" | "rejected";
  applied: string[];
  error?: string;
  /** Informe detallado cuando outcome="unrecoverable". */
  report?: string[];
  /** Hash de la propuesta aplicada (para registrar idempotencia). */
  appliedHash?: string;
}

export interface TxApplyOptions {
  rootDir: string;
  approvedHash: string;
  /** Hash de una aplicacion previa exitosa (idempotencia). */
  alreadyAppliedHash?: string;
  expectedBaseHashes?: Record<string, string>;
  /**
   * Hook de inyeccion de fallo para tests: si devuelve true para una ruta
   * relativa, la escritura de ESE archivo lanza. Permite probar rollback de
   * forma determinista sin depender de permisos del FS.
   */
  failOnWrite?: (rel: string) => boolean;
  /**
   * Hook de tests: si devuelve true para una ruta, la RESTAURACION de ese
   * archivo durante el rollback lanza. Permite probar el caso "unrecoverable"
   * (el rollback tambien falla) de forma determinista.
   */
  failOnRestore?: (rel: string) => boolean;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function applyProposalTransactional(
  proposal: Proposal,
  options: TxApplyOptions,
): TxApplyResult {
  const { rootDir, approvedHash, alreadyAppliedHash, expectedBaseHashes, failOnWrite, failOnRestore } = options;

  const currentHash = hashProposal(proposal);

  // 0. INTEGRIDAD: la propuesta debe coincidir con la aprobada (sin debilitar).
  if (currentHash !== approvedHash) {
    return {
      outcome: "rejected",
      applied: [],
      error: "La propuesta cambio tras la aprobacion (hash distinto). No se aplico nada.",
    };
  }

  // 1. IDEMPOTENCIA: si ya se aplico exactamente esta propuesta, no repetir.
  if (alreadyAppliedHash !== undefined && alreadyAppliedHash === currentHash) {
    return { outcome: "noop", applied: [], appliedHash: currentHash };
  }

  // 2. VALIDACION previa de todas las rutas y conflictos (antes de tocar disco).
  const snapshots: FileSnapshot[] = [];
  for (const change of proposal.changes) {
    let abs: string;
    try {
      abs = resolveSafePath(rootDir, change.path);
    } catch (e) {
      if (e instanceof PathValidationError) {
        return { outcome: "rejected", applied: [], error: `Ruta invalida: ${e.message}` };
      }
      throw e;
    }

    const existedBefore = existsSync(abs);
    const previousContent = existedBefore ? readFileSync(abs, "utf8") : null;

    // Conflicto concurrente: el disco difiere de la base que asumio la propuesta.
    if (expectedBaseHashes && Object.prototype.hasOwnProperty.call(expectedBaseHashes, change.path)) {
      const expected = expectedBaseHashes[change.path];
      const actual = existedBefore ? hashContent(previousContent as string) : "";
      if (actual !== expected) {
        return {
          outcome: "rejected",
          applied: [],
          error: `Conflicto: "${change.path}" cambio en disco. No se sobrescribe.`,
        };
      }
    }

    if (change.operation === "create" && existedBefore) {
      return {
        outcome: "rejected",
        applied: [],
        error: `"create" no puede sobrescribir un archivo existente: "${change.path}"`,
      };
    }

    if (change.operation === "update" && !existedBefore) {
      return {
        outcome: "rejected",
        applied: [],
        error: `"update" requiere un archivo existente: "${change.path}"`,
      };
    }

    if (change.operation === "delete" && !existedBefore) {
      return {
        outcome: "rejected",
        applied: [],
        error: `"delete" requiere un archivo existente: "${change.path}"`,
      };
    }

    snapshots.push({ abs, rel: change.path, existedBefore, previousContent });
  }

  // 3. APLICAR con snapshot para rollback.
  const applied: { snap: FileSnapshot }[] = [];
  try {
    for (let i = 0; i < proposal.changes.length; i++) {
      const change = proposal.changes[i];
      const snap = snapshots[i];

      if (failOnWrite && failOnWrite(snap.rel)) {
        throw new Error(`fallo inyectado al escribir "${snap.rel}"`);
      }

      if (change.operation === "delete") {
        // Elimina el archivo. El snapshot conserva su contenido previo, por lo
        // que el rollback (existedBefore=true) lo restaura re-escribiéndolo.
        rmSync(snap.abs, { force: true });
      } else {
        mkdirSync(dirname(snap.abs), { recursive: true });
        writeFileSync(snap.abs, change.content, "utf8");
      }
      applied.push({ snap });
    }
  } catch (writeErr) {
    // 4. ROLLBACK best-effort: restaurar lo ya escrito al estado previo.
    const report: string[] = [];
    let rollbackOk = true;
    for (const { snap } of applied) {
      try {
        if (failOnRestore && failOnRestore(snap.rel)) {
          throw new Error(`fallo inyectado al restaurar "${snap.rel}"`);
        }
        if (snap.existedBefore) {
          writeFileSync(snap.abs, snap.previousContent as string, "utf8");
          report.push(`restaurado: ${snap.rel}`);
        } else {
          rmSync(snap.abs, { force: true });
          report.push(`eliminado (no existia antes): ${snap.rel}`);
        }
      } catch (rbErr) {
        rollbackOk = false;
        const m = rbErr instanceof Error ? rbErr.message : String(rbErr);
        report.push(`NO SE PUDO RESTAURAR: ${snap.rel} (${m})`);
      }
    }

    const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);

    if (rollbackOk) {
      return {
        outcome: "rolled_back",
        applied: [],
        error: `Fallo al aplicar (${writeMsg}). Se revirtieron los cambios parciales.`,
        report,
      };
    }

    // El rollback fallo: NO fingir exito. Informe explicito.
    return {
      outcome: "unrecoverable",
      applied: applied.map((a) => a.snap.rel),
      error: `Fallo al aplicar (${writeMsg}) y la restauracion no se completo. Revision manual requerida.`,
      report,
    };
  }

  // 5. Exito total.
  return { outcome: "applied", applied: applied.map((a) => a.snap.rel), appliedHash: currentHash };
}
