import { StateGraph, START, END, type BaseCheckpointSaver } from "@langchain/langgraph";
import { createSqliteCheckpointer } from "./persistence/checkpointer.js";
import { WorkflowState, MAX_CORRECTIONS, type WorkflowStateType } from "./state.js";
import {
  makeAnalyze,
  makeDevelop,
  makeReview,
  proposeChanges,
  approvalGate,
  makeApplyChanges,
  finish,
  fail,
} from "./nodes.js";
import { createDefaultRouter, type AgentRouter } from "./agents/router.js";
import { MockReviewer } from "./review/mock-reviewer.js";
import type { Reviewer } from "./review/review-types.js";

/** Arista tras analyze (Fase 4): fallo -> failTask. */
function routeAfterAnalyze(state: WorkflowStateType): "developTask" | "failTask" {
  return state.analyzeFailed ? "failTask" : "developTask";
}

/** Arista tras develop (Fase 5): fallo de Claude -> failTask; ok -> proposeTask. */
function routeAfterDevelop(state: WorkflowStateType): "proposeTask" | "failTask" {
  return state.developFailed ? "failTask" : "proposeTask";
}

/** Arista tras propose (Fase 6): propuesta pendiente -> reviewTask; si no -> failTask. */
function routeAfterPropose(state: WorkflowStateType): "reviewTask" | "failTask" {
  return state.approvalPhase === "pending" ? "reviewTask" : "failTask";
}

/**
 * Arista tras review (Fase 8 — REORDENADO). La revision va ANTES de la
 * aprobacion humana:
 *  - error de revision -> failTask (sin fallback).
 *  - aprobado -> approvalTask (aprobacion humana).
 *  - rechazado + quedan intentos -> developTask (corrige con hallazgos).
 *  - rechazado + sin cupo -> failTask (rechazo definitivo).
 *
 * El contador `attempts` vs `MAX_CORRECTIONS` evita el bucle infinito.
 */
function routeAfterReview(
  state: WorkflowStateType,
): "approvalTask" | "developTask" | "failTask" {
  if (state.reviewFailed) {
    return "failTask";
  }
  if (state.reviewDecision === "approved") {
    return "approvalTask";
  }
  // rechazado:
  const correctionsDone = state.attempts - 1;
  if (correctionsDone < MAX_CORRECTIONS) {
    return "developTask";
  }
  return "failTask";
}

/** Arista tras la aprobacion humana (Fase 6): approved -> apply; si no -> fail. */
function routeAfterApproval(state: WorkflowStateType): "applyTask" | "failTask" {
  return state.approvalPhase === "approved" ? "applyTask" : "failTask";
}

/** Arista tras aplicar (Fase 6/8): applied -> finish; apply_failed -> fail. */
function routeAfterApply(state: WorkflowStateType): "finishTask" | "failTask" {
  return state.approvalPhase === "applied" ? "finishTask" : "failTask";
}

/** Opciones de construccion del grafo. */
export interface BuildGraphOptions {
  router?: AgentRouter;
  /**
   * Checkpointer persistente (Fase 7). Por defecto SQLite durable. Los tests
   * inyectan memoria o un SQLite en dir temporal.
   */
  checkpointer?: BaseCheckpointSaver;
  /** Directorio autorizado donde el aplicador puede escribir. Por defecto cwd. */
  rootDir?: string;
  /** (Solo tests) Fuerza fallo de escritura en una ruta, para probar rollback. */
  failOnWrite?: (rel: string) => boolean;
  /**
   * (Fase 8) Revisor simulado inyectable. Por defecto un MockReviewer que
   * aprueba en el primer intento. Los tests inyectan configuraciones concretas.
   */
  reviewer?: Reviewer;
}

/**
 * Construccion del grafo (Fase 8).
 *
 * Flujo (la REVISION va antes de la aprobacion humana):
 *   START -> analyzeTask -> (fallo? failTask)
 *     -> developTask -> (fallo? failTask)
 *       -> proposeTask (estructura la propuesta + hash)
 *         -> reviewTask (revision estructurada: approved/rejected/error)
 *            - error     -> failTask
 *            - rechazado + quedan intentos -> developTask (corrige con hallazgos)
 *            - rechazado + sin cupo        -> failTask (rechazo definitivo)
 *            - aprobado  -> approvalTask [interrupt(): aprobacion humana]
 *                 - approve -> applyTask -> (applied? finishTask : failTask)
 *                 - reject  -> failTask (repo intacto)
 *
 * Checkpointer persiste el estado; se reanuda con Command({ resume }) y el
 * mismo thread_id.
 */
export function buildGraph(options: BuildGraphOptions = {}) {
  const router = options.router ?? createDefaultRouter();
  const checkpointer = options.checkpointer ?? createSqliteCheckpointer();
  const rootDir = options.rootDir ?? process.cwd();
  const reviewer = options.reviewer ?? new MockReviewer();

  const workflow = new StateGraph(WorkflowState)
    .addNode("analyzeTask", makeAnalyze(router))
    .addNode("developTask", makeDevelop(router))
    .addNode("proposeTask", proposeChanges)
    .addNode("reviewTask", makeReview(reviewer))
    .addNode("approvalTask", approvalGate)
    .addNode("applyTask", makeApplyChanges(rootDir, options.failOnWrite))
    .addNode("finishTask", finish)
    .addNode("failTask", fail)
    .addEdge(START, "analyzeTask")
    .addConditionalEdges("analyzeTask", routeAfterAnalyze, {
      developTask: "developTask",
      failTask: "failTask",
    })
    .addConditionalEdges("developTask", routeAfterDevelop, {
      proposeTask: "proposeTask",
      failTask: "failTask",
    })
    .addConditionalEdges("proposeTask", routeAfterPropose, {
      reviewTask: "reviewTask",
      failTask: "failTask",
    })
    .addConditionalEdges("reviewTask", routeAfterReview, {
      approvalTask: "approvalTask",
      developTask: "developTask",
      failTask: "failTask",
    })
    .addConditionalEdges("approvalTask", routeAfterApproval, {
      applyTask: "applyTask",
      failTask: "failTask",
    })
    .addConditionalEdges("applyTask", routeAfterApply, {
      finishTask: "finishTask",
      failTask: "failTask",
    })
    .addEdge("finishTask", END)
    .addEdge("failTask", END);

  return workflow.compile({ checkpointer });
}
