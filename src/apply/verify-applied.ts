import { existsSync, readFileSync } from "node:fs";
import { resolveSafePath, PathValidationError } from "./path-validation.js";
import type { DevProposal } from "../dev/dev-schema.js";
import type { PostApplyVerification } from "../hu/hu-state.js";

/**
 * Verificación POSTERIOR a la aplicación (Fase 13).
 *
 * Compara el estado REAL del repositorio contra la propuesta aprobada:
 *  - "create"/"modify": el archivo debe existir y su contenido debe ser
 *    EXACTAMENTE el propuesto.
 *  - "delete": el archivo ya NO debe existir.
 *
 * No infla el resultado: cualquier discrepancia se reporta en `mismatches` y
 * `filesMatch` queda en false. Una aplicación "exitosa" solo lo es si el
 * contenido real coincide con lo aprobado.
 */

/**
 * Hook opcional para ejecutar los comandos de validación del proyecto (tests,
 * typecheck) DESPUÉS de aplicar. Es opt-in: el grafo por defecto NO lo ejecuta
 * (sería no determinista y lento). Permite distinguir "applied" de
 * "applied_with_test_failures".
 */
export type RunProjectChecks = () => { ran: boolean; passed: boolean; detail: string };

export function verifyAppliedProposal(
  proposal: DevProposal,
  rootDir: string,
  runChecks?: RunProjectChecks,
): PostApplyVerification {
  const createdOk: string[] = [];
  const modifiedOk: string[] = [];
  const deletedOk: string[] = [];
  const mismatches: string[] = [];

  for (const ch of proposal.changes) {
    let abs: string;
    try {
      abs = resolveSafePath(rootDir, ch.path);
    } catch (e) {
      if (e instanceof PathValidationError) {
        mismatches.push(`${ch.path}: ruta inválida (${e.message})`);
        continue;
      }
      throw e;
    }

    if (ch.operation === "delete") {
      if (existsSync(abs)) mismatches.push(`${ch.path}: debía eliminarse pero sigue existiendo`);
      else deletedOk.push(ch.path);
      continue;
    }

    // create / modify
    if (!existsSync(abs)) {
      mismatches.push(`${ch.path}: debía existir tras aplicar pero no existe`);
      continue;
    }
    const actual = readFileSync(abs, "utf8");
    if (actual !== ch.content) {
      mismatches.push(`${ch.path}: el contenido en disco no coincide con el aprobado`);
      continue;
    }
    if (ch.operation === "create") createdOk.push(ch.path);
    else modifiedOk.push(ch.path);
  }

  const projectChecks = runChecks ? runChecks() : undefined;

  return {
    filesMatch: mismatches.length === 0,
    createdOk,
    modifiedOk,
    deletedOk,
    mismatches,
    projectChecks,
  };
}
