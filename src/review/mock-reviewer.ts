import type { Reviewer, ReviewRequest, ReviewResult, Finding } from "./review-types.js";

/**
 * Revisor SIMULADO determinista (Fase 8).
 *
 * HONESTIDAD (requisito del PO): este revisor NO usa un modelo ni hace analisis
 * semantico real. Aplica reglas explicitas y configurables para poder PROBAR el
 * flujo de revision/correccion/aprobacion de forma determinista.
 *
 * Esta aislado del grafo: implementa el contrato `Reviewer`. Manana se puede
 * sustituir por un revisor real sin tocar nodos ni aristas.
 */

export interface MockReviewerConfig {
  /**
   * Numero de intentos que deben FALLAR antes de aprobar.
   * - 0  -> aprueba en el intento 1.
   * - 1  -> rechaza el intento 1, aprueba el 2 (corregido-y-aprobado).
   * - 99 -> nunca aprueba (rechazo persistente hasta el limite).
   */
  rejectUntilAttempt?: number;
  /** Si true, la revision FALLA (error de ejecucion), distinto de rechazo. */
  failExecution?: boolean;
  /** Hallazgos a reportar cuando rechaza (configurable para tests). */
  findingsOnReject?: Finding[];
}

const DEFAULT_FINDINGS: Finding[] = [
  { id: "F001", severity: "high", description: "Falta manejo de errores en la propuesta." },
  { id: "F002", severity: "medium", description: "No hay pruebas para el cambio propuesto." },
];

export class MockReviewer implements Reviewer {
  readonly name = "mock-reviewer";

  constructor(private readonly config: MockReviewerConfig = {}) {}

  review(request: ReviewRequest): ReviewResult {
    // Caso: error de EJECUCION de la revision (no es un rechazo legitimo).
    if (this.config.failExecution) {
      return {
        status: "failure",
        decision: "rejected", // por seguridad, nunca "approved" en fallo
        findings: [],
        summary: "La revision no pudo ejecutarse.",
        error: "fallo simulado del revisor",
      };
    }

    const rejectUntil = this.config.rejectUntilAttempt ?? 0;

    // Caso: rechazo con hallazgos (hasta superar el umbral configurado).
    if (request.attempt <= rejectUntil) {
      const findings = this.config.findingsOnReject ?? DEFAULT_FINDINGS;
      return {
        status: "success",
        decision: "rejected",
        findings,
        summary: `Rechazada en el intento ${request.attempt}: ${findings.length} hallazgo(s).`,
      };
    }

    // Caso: aprobada.
    return {
      status: "success",
      decision: "approved",
      findings: [],
      summary: `Aprobada en el intento ${request.attempt}: sin hallazgos bloqueantes.`,
    };
  }
}
