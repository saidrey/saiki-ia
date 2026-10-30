import { useMutation, useMutationState, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { DecisionGateKind, GateResolution, HumanDecision, ProposalResolution } from "../api/types";

const DECIDE_KEY = ["decide"] as const;

export interface DecideInput {
  executionId: string;
  /** Tipo de aprobación que se decide (de la vista mostrada). */
  kind: string;
  decision: HumanDecision;
  /** Hash de la versión MOSTRADA, reenviado tal cual. */
  hash: string;
  feedback?: string;
}

export type DecideResult = ProposalResolution | GateResolution;

/** `GET /executions/:id/approval`, solo cuando hay algo que decidir. */
export function useApproval(executionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["approval", executionId],
    queryFn: () => api.getApproval(executionId),
    enabled,
  });
}

/** Historial inmutable de versiones de propuesta (backend). */
export function useProposalHistory(executionId: string, enabled = true) {
  return useQuery({
    queryKey: ["proposals", executionId],
    queryFn: () => api.getProposals(executionId),
    select: (r) => r.proposals,
    enabled,
  });
}

/** Decisiones humanas de la ejecución, con observaciones (backend). */
export function useDecisionHistory(executionId: string, enabled = true) {
  return useQuery({
    queryKey: ["decisions", executionId],
    queryFn: () => api.getDecisions(executionId),
    select: (r) => r.decisions,
    enabled,
  });
}

/**
 * Envía una decisión. Bloquea hasta que el grafo vuelve a pausarse o termina
 * (minutos con agentes reales). No se envía actorId: lo fija el servidor.
 */
export function useDecide() {
  return useMutation<DecideResult, ApiError, DecideInput>({
    mutationKey: DECIDE_KEY,
    mutationFn: async ({ executionId, kind, decision, hash, feedback }) => {
      const body = feedback ? { feedback } : {};
      if (kind === "final_approval") {
        return (await api.resolveProposal(executionId, { decision, proposalHash: hash, ...body })).resolution;
      }
      if (kind === "hu_review" || kind === "feasibility_partial") {
        return (await api.resolveGate(executionId, kind as DecisionGateKind, { decision, decisionHash: hash, ...body })).resolution;
      }
      throw new ApiError(400, "unsupported_kind", `La interfaz no sabe resolver la aprobación "${kind}".`);
    },
  });
}

export interface DecisionRecord {
  input: DecideInput;
  status: "pending" | "success" | "error" | "idle";
  result?: DecideResult;
  error?: ApiError;
  submittedAt: number;
}

/** Decisiones de esta pestaña para una ejecución (la última al final). */
export function useDecisionRecords(executionId: string): DecisionRecord[] {
  return useMutationState({
    filters: { mutationKey: DECIDE_KEY, predicate: (m) => (m.state.variables as DecideInput | undefined)?.executionId === executionId },
    select: (m) => ({
      input: m.state.variables as DecideInput,
      status: m.state.status,
      result: m.state.data as DecideResult | undefined,
      error: (m.state.error as ApiError | null) ?? undefined,
      submittedAt: m.state.submittedAt,
    }),
  });
}

/** Ejecuciones con una decisión de esta pestaña aún en curso. */
export function usePendingDecisionIds(): string[] {
  return useMutationState({
    filters: { mutationKey: DECIDE_KEY, status: "pending" },
    select: (m) => (m.state.variables as DecideInput).executionId,
  });
}
