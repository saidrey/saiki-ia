import {
  type DevProposal,
  type DevFileChange,
  hashDevProposal,
} from "../dev/dev-schema.js";
import {
  type Proposal,
  type FileChange,
  type FileOperation,
  hashProposal as hashProposalInternal,
} from "./file-change.js";
import { applyProposalTransactional, type TxApplyResult, type TxApplyOptions } from "./transactional-applier.js";

/**
 * Puente DevProposal → aplicador seguro (Fase 13).
 *
 * PROBLEMA QUE RESUELVE: el flujo de HU produce una `DevProposal`
 * (src/dev/dev-schema.ts) cuyo hash aprobado por el humano es `hashDevProposal`.
 * El aplicador transaccional (Fase 7) opera sobre `Proposal`/`FileChange`
 * (src/apply/file-change.ts) con su propio `hashProposal`. Son formatos y hashes
 * DISTINTOS. Este puente los concilia SIN debilitar ningún control:
 *
 *  1. Verifica la INTEGRIDAD de la propuesta recalculando `hashDevProposal` y
 *     comparándolo con el hash que el humano aprobó. Si no coincide, NO aplica:
 *     la aprobación quedó obsoleta (la propuesta cambió).
 *  2. Convierte las operaciones del dominio HU ("create"/"modify"/"delete") a
 *     las del aplicador ("create"/"update"/"delete").
 *  3. Delega TODA la escritura al aplicador transaccional existente, que a su
 *     vez valida rutas, detecta conflictos concurrentes, hace snapshot y
 *     rollback best-effort. No se crea un segundo aplicador.
 *
 * El aplicador verifica su PROPIO hash interno (`hashProposal`) contra el hash
 * de la propuesta convertida, garantizando que lo que escribe === lo convertido.
 * La cadena de integridad es: hash DEV aprobado == hash DEV recalculado
 * (verificado aquí) y Proposal convertida == lo aplicado (verificado por el
 * aplicador). Así la aprobación nunca es reutilizable para otra versión.
 */

/** Mapea la operación del dominio HU a la del aplicador. */
function mapOperation(op: DevFileChange["operation"]): FileOperation {
  switch (op) {
    case "create":
      return "create";
    case "modify":
      return "update";
    case "delete":
      return "delete";
  }
}

/**
 * Convierte una `DevProposal` en la `Proposal` que entiende el aplicador.
 * El `id` es el hash DEV aprobado (trazabilidad: la propuesta aplicada lleva en
 * su identificador el hash exacto que se autorizó).
 */
export function devProposalToProposal(proposal: DevProposal, approvedDevHash: string): Proposal {
  const changes: FileChange[] = proposal.changes.map((ch) => ({
    path: ch.path,
    operation: mapOperation(ch.operation),
    content: ch.operation === "delete" ? "" : ch.content,
  }));
  return { id: approvedDevHash, changes };
}

/** Opciones de aplicación de una DevProposal (hereda las del aplicador salvo hash). */
export interface ApplyDevOptions {
  rootDir: string;
  /** Hash DEV que el humano aprobó (hashDevProposal). */
  approvedDevHash: string;
  /** Hash DEV de una aplicación previa exitosa (idempotencia). */
  alreadyAppliedDevHash?: string;
  /** Hashes base esperados por ruta (detección de cambios concurrentes). */
  expectedBaseHashes?: Record<string, string>;
  /** Hooks de inyección de fallo (tests deterministas). */
  failOnWrite?: TxApplyOptions["failOnWrite"];
  failOnRestore?: TxApplyOptions["failOnRestore"];
}

/**
 * Resultado de aplicar una DevProposal. Extiende el del aplicador con el hash
 * DEV (no el hash interno del aplicador) para registrar idempotencia en el
 * dominio HU.
 */
export interface ApplyDevResult extends TxApplyResult {
  /** Hash DEV efectivamente aplicado (para idempotencia del flujo de HU). */
  appliedDevHash?: string;
}

/**
 * Aplica una DevProposal de forma segura reutilizando el aplicador transaccional.
 *
 * Paso 0 (INTEGRIDAD): recalcula `hashDevProposal` y lo compara con el aprobado.
 * Si difiere, devuelve `rejected` SIN tocar disco: la aprobación no vale para
 * esta versión.
 *
 * Idempotencia: si `alreadyAppliedDevHash` === hash aprobado, el aplicador
 * devuelve `noop` y NO reescribe.
 */
export function applyDevProposal(
  proposal: DevProposal,
  options: ApplyDevOptions,
): ApplyDevResult {
  const { approvedDevHash, alreadyAppliedDevHash } = options;

  // 0. INTEGRIDAD en el dominio HU: la propuesta debe coincidir con la aprobada.
  const currentDevHash = hashDevProposal(proposal);
  if (currentDevHash !== approvedDevHash) {
    return {
      outcome: "rejected",
      applied: [],
      error:
        "La propuesta cambió respecto de la aprobada (hash DEV distinto). La aprobación no es válida para esta versión.",
    };
  }

  // 1. IDEMPOTENCIA (dominio HU): si ya se aplicó este hash DEV, no repetir.
  if (alreadyAppliedDevHash !== undefined && alreadyAppliedDevHash === currentDevHash) {
    return { outcome: "noop", applied: [], appliedDevHash: currentDevHash };
  }

  // 2. Convertir y delegar al aplicador transaccional existente. El aplicador
  //    verifica su propio hash interno contra la propuesta convertida.
  const converted = devProposalToProposal(proposal, approvedDevHash);
  const internalHash = hashProposalInternal(converted);

  const result = applyProposalTransactional(converted, {
    rootDir: options.rootDir,
    approvedHash: internalHash,
    expectedBaseHashes: options.expectedBaseHashes,
    failOnWrite: options.failOnWrite,
    failOnRestore: options.failOnRestore,
  });

  // Traducimos el resultado al dominio HU (hash DEV, no el interno).
  return {
    ...result,
    appliedDevHash: result.outcome === "applied" || result.outcome === "noop" ? currentDevHash : undefined,
  };
}
