/**
 * Contrato de revision estructurada (Fase 8).
 *
 * El rol `review` sigue SIMULADO. Este contrato define QUE devuelve una
 * revision, de forma que manana se pueda sustituir el mock por una
 * implementacion real (un agente) SIN tocar el grafo.
 *
 * Distincion clave (requisito del PO):
 *  - `status: "failure"` = la REVISION fallo (error de ejecucion). NO es un
 *    rechazo legitimo.
 *  - `status: "success"` + `decision: "rejected"` = revision OK que decide
 *    rechazar con hallazgos.
 * Un resultado invalido NUNCA se interpreta como aprobacion.
 */

/** Severidad de un hallazgo. */
export type Severity = "low" | "medium" | "high" | "critical";

/** Un hallazgo de la revision. */
export interface Finding {
  id: string;
  severity: Severity;
  description: string;
}

/** Decision de una revision que se ejecuto correctamente. */
export type ReviewDecision = "approved" | "rejected";

/**
 * Resultado estructurado de una revision.
 * - status: exito o fallo de EJECUCION de la revision.
 * - decision: approved | rejected (solo significativo si status="success").
 * - findings: hallazgos (vacio si aprobado; con items si rechazado).
 * - summary: explicacion breve de la decision.
 */
export interface ReviewResult {
  status: "success" | "failure";
  decision: ReviewDecision;
  findings: Finding[];
  summary: string;
  /** Detalle del error cuando status="failure". */
  error?: string;
}

/** Peticion de revision: la propuesta (como texto) y el numero de intento. */
export interface ReviewRequest {
  /** Contenido de la propuesta a revisar. */
  proposalContent: string;
  /** Numero de intento de desarrollo (1 = primero). */
  attempt: number;
}

/**
 * EL CONTRATO del revisor. Aislado del grafo: el nodo review lo invoca sin
 * saber si es el mock o una implementacion futura.
 */
export interface Reviewer {
  readonly name: string;
  review(request: ReviewRequest): ReviewResult;
}

/**
 * Normaliza/valida un ReviewResult que venga de una fuente no confiable.
 * Si el objeto es invalido, devuelve un fallo de revision (NUNCA aprobacion).
 * Esto implementa "un resultado invalido nunca se interpreta como aprobacion".
 */
export function coerceReviewResult(value: unknown): ReviewResult {
  const invalid = (reason: string): ReviewResult => ({
    status: "failure",
    decision: "rejected",
    findings: [],
    summary: `Resultado de revision invalido: ${reason}`,
    error: reason,
  });

  if (typeof value !== "object" || value === null) return invalid("no es un objeto");
  const v = value as Record<string, unknown>;

  if (v.status !== "success" && v.status !== "failure") return invalid("status invalido");
  if (v.decision !== "approved" && v.decision !== "rejected") return invalid("decision invalida");
  if (!Array.isArray(v.findings)) return invalid("findings no es lista");

  // Regla dura: solo status=success + decision=approved cuenta como aprobacion.
  return {
    status: v.status,
    decision: v.decision,
    findings: v.findings as Finding[],
    summary: typeof v.summary === "string" ? v.summary : "",
    error: typeof v.error === "string" ? v.error : undefined,
  };
}
