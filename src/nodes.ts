import { interrupt } from "@langchain/langgraph";
import type { WorkflowStateType, WorkflowUpdate } from "./state.js";
import type { AgentRouter } from "./agents/router.js";
import { buildProposalFromText } from "./apply/proposal-parser.js";
import { hashProposal, summarizeProposal } from "./apply/file-change.js";
import { applyProposalTransactional } from "./apply/transactional-applier.js";
import { coerceReviewResult, type Reviewer } from "./review/review-types.js";

/**
 * Nodos del grafo.
 *
 * Los nodos DELEGAN en un `AgentRouter`, que resuelve que adaptador usar para
 * cada rol (Fase 4: analyze=real, develop/review=simulado). El nodo pide el
 * adaptador de su rol y lo usa; no sabe si es real o simulado.
 *
 * Los nodos siguen las mismas reglas de siempre:
 * - Reciben el estado (lectura) y devuelven SOLO el delta.
 * - Imprimen cuando empiezan y terminan.
 * - No conocen a Kiro/Claude/Codex; solo conocen el contrato via el router.
 *
 * Patron usado: cada "nodo" es una FABRICA que recibe el router y devuelve la
 * funcion-nodo que LangGraph ejecutara. Inyeccion de dependencias sin globales.
 */

function logStart(node: string): void {
  console.log(`[inicio] nodo "${node}"`);
}

function logEnd(node: string): void {
  console.log(`[fin]    nodo "${node}"`);
}

/**
 * Nodo 1: analyze
 * Pide al agente (rol "analyze") un plan a partir de la tarea.
 * Lee: task. Escribe: plan.
 */
export function makeAnalyze(router: AgentRouter) {
  return async function analyze(state: WorkflowStateType): Promise<WorkflowUpdate> {
    logStart("analyze");

    const agent = router.forRole("analyze");
    const result = await agent.run({ role: "analyze", input: state.task });

    logEnd("analyze");

    // Si el agente real (Kiro CLI) falla, NO seguimos a develop como si el
    // analisis fuera valido. Marcamos analyzeFailed para que la arista
    // condicional enrute a la ruta de fallo explicita.
    if (result.status === "failure") {
      return {
        plan: "",
        analyzeFailed: true,
        analyzeError: result.error ?? "error desconocido en analyze",
      };
    }

    return { plan: result.output, analyzeFailed: false };
  };
}

/**
 * Nodo 2: develop
 * Pide al agente (rol "develop") una PROPUESTA de codigo a partir del plan.
 * En Fase 5 este agente es Claude Code real en modo propuesta (sin escritura).
 *
 * Importante (seguridad): la salida es una PROPUESTA, no un cambio aplicado.
 * `developApplied` se fija SIEMPRE en false: ninguna parte del flujo debe
 * tratar esto como un cambio real al repositorio.
 *
 * Fallo explicito: si el agente falla, se marca `developFailed` para que la
 * arista condicional enrute al fallo; no se finge una implementacion valida.
 *
 * Lee: plan, attempts. Escribe: implementation, attempts (+1), developApplied,
 * developFailed.
 */
export function makeDevelop(router: AgentRouter) {
  return async function develop(state: WorkflowStateType): Promise<WorkflowUpdate> {
    logStart("develop");

    const agent = router.forRole("develop");
    const attemptNumber = state.attempts + 1;

    // (Fase 8) Si venimos de un rechazo de revision, pasamos los hallazgos a
    // develop. Esto ademas hace que la propuesta corregida sea DISTINTA ->
    // hash nuevo -> exige nueva aprobacion humana.
    const findingsText =
      state.reviewFindings.length > 0
        ? " Corrige estos hallazgos: " +
          state.reviewFindings.map((f) => `[${f.severity}] ${f.id}: ${f.description}`).join("; ")
        : "";

    const result = await agent.run({
      role: "develop",
      input: state.plan + findingsText,
      context: { attempt: attemptNumber, findings: state.reviewFindings },
    });

    logEnd("develop");

    if (result.status === "failure") {
      // Propagacion explicita del error de Claude. Sin fallback.
      return {
        implementation: "",
        attempts: 1,
        developApplied: false,
        developFailed: true,
        developError: result.error ?? "error desconocido en develop",
      };
    }

    // Exito: la salida es una PROPUESTA (no aplicada). El sufijo de intento +
    // los hallazgos incorporados garantizan un contenido distinto por intento.
    const correctionNote = findingsText
      ? ` [corrige ${state.reviewFindings.length} hallazgo(s)]`
      : "";
    return {
      implementation: `(intento ${attemptNumber})${correctionNote} [PROPUESTA] ${result.output}`,
      attempts: 1,
      developApplied: false,
      developFailed: false,
      // Reset del ciclo de revision/aprobacion para la nueva propuesta.
      reviewDecision: "",
      reviewFindings: [],
      approvalPhase: "none",
      appliedHash: "",
    };
  };
}

/**
 * Nodo 3: review
 * Pide al agente (rol "review") una revision de la implementacion y decide
 * si aprueba.
 *
 * La DECISION de aprobar sigue siendo del grafo (determinista via `failUntil`),
 * no del agente: en esta fase el agente solo produce texto. Asi conservamos
 * intacto el flujo condicional de la Fase 2.
 *
 * Lee: implementation, attempts, failUntil. Escribe: review, approved.
 */
export function makeReview(reviewer: Reviewer) {
  return function review(state: WorkflowStateType): WorkflowUpdate {
    logStart("review");

    const result = coerceReviewResult(
      reviewer.review({ proposalContent: state.implementation, attempt: state.attempts }),
    );

    logEnd("review");

    // Fallo de EJECUCION de la revision: distinto de un rechazo legitimo.
    if (result.status === "failure") {
      return {
        reviewFailed: true,
        reviewError: result.error ?? "error desconocido en la revision",
        reviewDecision: "",
        approved: false,
        review: `FALLO DE REVISION: ${result.summary}`,
      };
    }

    const approved = result.decision === "approved";
    return {
      reviewFailed: false,
      reviewDecision: result.decision,
      reviewFindings: result.findings,
      reviewSummary: result.summary,
      approved,
      review: approved
        ? `APROBADO (revision): ${result.summary}`
        : `RECHAZADO (revision): ${result.summary}`,
    };
  };
}

/**
 * Nodo (Fase 6): proposeChanges
 * Convierte la salida textual de develop (Claude) en una PROPUESTA estructurada
 * y calcula su hash. No escribe nada. Marca la fase como "pending" (espera
 * aprobacion). Si no hay cambios parseables, no abre aprobacion ficticia.
 * Lee: implementation. Escribe: proposal, proposalHash, approvalPhase.
 */
export function proposeChanges(state: WorkflowStateType): WorkflowUpdate {
  logStart("propose");

  // Id derivado del numero de intento (estable y determinista, no usa reloj).
  const proposalId = `prop-intento-${state.attempts}`;
  const proposal = buildProposalFromText(proposalId, state.implementation);

  logEnd("propose");

  if (proposal.changes.length === 0) {
    // No hay cambios estructurados que aplicar: no se abre una aprobacion vacia.
    return {
      proposal: null,
      proposalHash: "",
      approvalPhase: "none",
      review: "SIN CAMBIOS APLICABLES: la propuesta no contiene archivos estructurados.",
    };
  }

  return {
    proposal,
    proposalHash: hashProposal(proposal),
    approvalPhase: "pending",
  };
}

/**
 * Nodo (Fase 6): approvalGate — PAUSA para decision humana.
 * Usa interrupt() de LangGraph para detener el grafo ANTES de aplicar nada.
 * Expone al humano: id, archivos, resumen y hash de la propuesta.
 *
 * Interpreta SOLO dos decisiones explicitas:
 *  - "approve": pasa a fase "approved".
 *  - cualquier otra cosa / "reject": pasa a "rejected".
 * Ausencia de respuesta = sigue pausado (no se reanuda, no se aprueba).
 */
export function approvalGate(state: WorkflowStateType): WorkflowUpdate {
  logStart("approvalGate");

  if (state.proposal === null) {
    // Defensa: no deberia llegar aqui sin propuesta.
    return { approvalPhase: "rejected" };
  }

  // interrupt() detiene el grafo y entrega este payload al humano. Al reanudar
  // con Command({ resume }), ese valor se devuelve aqui.
  const decision = interrupt({
    kind: "approval_request",
    proposalId: state.proposal.id,
    proposalHash: state.proposalHash,
    files: state.proposal.changes.map((c) => ({ path: c.path, operation: c.operation })),
    summary: summarizeProposal(state.proposal),
  }) as { action?: string; approvedHash?: string } | string;

  logEnd("approvalGate");

  // Normalizamos la decision. Aceptamos string "approve"/"reject" u objeto.
  const action = typeof decision === "string" ? decision : decision?.action;

  if (action === "approve") {
    return { approvalPhase: "approved" };
  }

  // Todo lo que no sea un "approve" explicito es rechazo. NUNCA se interpreta
  // ausencia/timeout/error como aprobacion.
  return {
    approvalPhase: "rejected",
    review: "RECHAZADO POR EL HUMANO: no se aplican cambios.",
  };
}

/**
 * Nodo (Fase 6): applyChanges — aplicacion CONTROLADA.
 * Fabrica que recibe el directorio autorizado. Aplica SOLO la propuesta
 * aprobada (hash-verificada), con validacion de rutas y deteccion de conflicto.
 * Reporta exito/fallo de forma explicita. Nunca declara exito si quedo parcial.
 */
export function makeApplyChanges(rootDir: string, failOnWrite?: (rel: string) => boolean) {
  return function applyChanges(state: WorkflowStateType): WorkflowUpdate {
    logStart("apply");

    if (state.proposal === null || state.approvalPhase !== "approved") {
      logEnd("apply");
      return {
        approvalPhase: "apply_failed",
        applyError: "No hay propuesta aprobada para aplicar.",
      };
    }

    // Aplicador transaccional best-effort con IDEMPOTENCIA: si este hash ya se
    // aplico con exito antes (reintento/reanudacion/reinicio), devuelve "noop".
    const result = applyProposalTransactional(state.proposal, {
      rootDir,
      approvedHash: state.proposalHash,
      alreadyAppliedHash: state.appliedHash || undefined,
      failOnWrite,
    });

    logEnd("apply");

    switch (result.outcome) {
      case "noop":
        // Ya estaba aplicada: no se reescribe nada. Exito idempotente.
        return {
          approvalPhase: "applied",
          developApplied: true,
          appliedHash: result.appliedHash,
        };

      case "applied":
        return {
          approvalPhase: "applied",
          appliedFiles: result.applied,
          developApplied: true,
          appliedHash: result.appliedHash,
        };

      case "rolled_back":
        // Fallo pero se revirtieron los cambios parciales: repo consistente.
        return {
          approvalPhase: "apply_failed",
          developApplied: false,
          applyError: result.error ?? "fallo al aplicar; cambios revertidos",
          recoveryReport: result.report ?? [],
        };

      case "unrecoverable":
        // Fallo Y el rollback no se completo: NO se declara exito.
        return {
          approvalPhase: "apply_failed",
          developApplied: false,
          appliedFiles: result.applied,
          applyError: result.error ?? "fallo irrecuperable al aplicar",
          recoveryReport: result.report ?? [],
        };

      case "rejected":
      default:
        return {
          approvalPhase: "apply_failed",
          developApplied: false,
          applyError: result.error ?? "aplicacion rechazada",
        };
    }
  };
}

/**
 * Nodo terminal: finish (camino de exito). Fija status = "approved".
 * No usa agente: es un cierre determinista del grafo.
 */
export function finish(_state: WorkflowStateType): WorkflowUpdate {
  logStart("finish");
  logEnd("finish");
  return { status: "approved" };
}

/**
 * Nodo terminal: fail (camino de fallo). Fija status = "failed".
 * Si el fallo vino de `analyze` (Kiro CLI), deja el detalle del error visible
 * en el campo `review` para que el resultado final lo muestre.
 */
export function fail(state: WorkflowStateType): WorkflowUpdate {
  logStart("fail");
  logEnd("fail");

  if (state.analyzeFailed) {
    return {
      status: "failed",
      review: `FALLO EN ANALYZE (Kiro CLI): ${state.analyzeError}`,
    };
  }

  if (state.developFailed) {
    return {
      status: "failed",
      review: `FALLO EN DEVELOP (Claude Code): ${state.developError}`,
    };
  }

  // (Fase 8) Error de EJECUCION de la revision (distinto de un rechazo).
  if (state.reviewFailed) {
    return {
      status: "failed",
      review: `FALLO DE REVISION: ${state.reviewError}`,
    };
  }

  // (Fase 8) Rechazo definitivo de la revision tras agotar el limite.
  if (state.reviewDecision === "rejected") {
    const hallazgos = state.reviewFindings
      .map((f) => `[${f.severity}] ${f.id}: ${f.description}`)
      .join("; ");
    return {
      status: "failed",
      review: `RECHAZO DEFINITIVO (revision): limite de correcciones alcanzado. Hallazgos: ${hallazgos}`,
    };
  }

  if (state.approvalPhase === "apply_failed") {
    return {
      status: "failed",
      review: `FALLO AL APLICAR: ${state.applyError}`,
    };
  }

  if (state.approvalPhase === "rejected") {
    return {
      status: "failed",
      review: state.review || "RECHAZADO POR EL HUMANO: no se aplican cambios.",
    };
  }

  return { status: "failed" };
}
