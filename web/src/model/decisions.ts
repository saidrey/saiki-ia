import type { ApiError } from "../api/client";
import type { ApprovalResponse, HumanDecision } from "../api/types";
import { approvalKindLabel } from "./stages";

export interface DecisionOption {
  decision: HumanDecision;
  label: string;
  tone: "primary" | "secondary" | "danger";
  /** Texto de confirmación para decisiones irreversibles (segundo paso). */
  confirm?: string;
  /** La decisión necesita observaciones (pedir cambios sin decir cuáles no sirve). */
  needsFeedback?: boolean;
}

/**
 * Opciones de decisión de la aprobación pendiente. En HU y viabilidad parcial se
 * respetan las `allowedDecisions` que da el servidor (la viabilidad parcial no
 * admite "pedir cambios").
 */
export function decisionOptions(approval: ApprovalResponse): DecisionOption[] {
  const kind = approval.pendingApproval.kind;
  const gate = approval.gate;
  if (kind === "hu_review" && gate?.kind === "hu_review") {
    const exhausted = gate.revisionsUsed >= gate.maxRevisions;
    const all: DecisionOption[] = [
      { decision: "approve", label: "Aprobar la HU", tone: "primary" },
      {
        decision: "request_changes",
        label: "Pedir cambios",
        tone: "secondary",
        needsFeedback: true,
        confirm: exhausted
          ? `Ya se usaron las ${gate.maxRevisions} revisiones permitidas: pedir cambios termina la ejecución sin desarrollar nada.`
          : undefined,
      },
      { decision: "reject", label: "Rechazar la HU", tone: "danger", confirm: "Rechazar termina la ejecución sin desarrollar nada." },
    ];
    return all.filter((o) => gate.allowedDecisions.includes(o.decision));
  }
  if (kind === "feasibility_partial" && gate?.kind === "feasibility_partial") {
    const all: DecisionOption[] = [
      { decision: "approve", label: "Proceder con lo implementable", tone: "primary" },
      { decision: "reject", label: "No desarrollar", tone: "danger", confirm: "La ejecución termina sin desarrollar nada." },
    ];
    return all.filter((o) => gate.allowedDecisions.includes(o.decision));
  }
  if (kind === "final_approval" && approval.proposal !== null) {
    return [
      {
        decision: "approve",
        label: "Aprobar y aplicar",
        tone: "primary",
        confirm: "Saiki-IA aplicará estos cambios con el Safe Applier y después los verificará.",
      },
      { decision: "request_changes", label: "Pedir cambios", tone: "secondary", needsFeedback: true },
      { decision: "reject", label: "Rechazar", tone: "danger", confirm: "Rechazar termina la ejecución: no se aplica nada." },
    ];
  }
  return [];
}

/** Hash de la versión que se está mostrando (lo que el humano decide). */
export function shownHash(approval: ApprovalResponse): string | undefined {
  if (approval.pendingApproval.kind === "final_approval") return approval.proposal?.proposalHash;
  return approval.gate?.decisionHash;
}

const VERB: Record<HumanDecision, string> = {
  approve: "aprobó",
  reject: "rechazó",
  request_changes: "pidió cambios en",
};

/** Frase de la resolución, con el actor que fijó el servidor. */
export function describeResolution(kind: string | undefined, r: { decision: HumanDecision; actor: string; phase: string }): string {
  return `${r.actor} ${VERB[r.decision]} la ${approvalKindLabel(kind)}. Fase actual: ${r.phase}.`;
}

export interface DecisionErrorView {
  title: string;
  text: string;
}

/** Errores de una decisión, traducidos a qué pasó y qué hacer. Nunca se reenvía solo. */
export function describeDecisionError(err: ApiError): DecisionErrorView {
  if (err.status === 409 && err.code === "hash_mismatch") {
    return {
      title: "La versión cambió mientras decidías",
      text: "Tu decisión no se aplicó. Revisa la versión vigente y decide de nuevo.",
    };
  }
  if (err.status === 409 && err.code === "not_awaiting") {
    const now = err.body?.pendingKind;
    return {
      title: "Esta ejecución ya no espera esa decisión",
      text: now ? `Ahora espera: ${approvalKindLabel(now)}.` : "No hay ninguna decisión pendiente.",
    };
  }
  if (err.status === 409 && err.code === "project_unbound") {
    return { title: "Esta ejecución no tiene un proyecto vinculado", text: err.message };
  }
  if (err.status === 404) return { title: "La ejecución ya no existe", text: err.message };
  if (err.status === 0) {
    return {
      title: "Se perdió la conexión mientras se enviaba tu decisión",
      text: "Puede que el backend la haya recibido. Comprueba el estado de la ejecución antes de volver a decidir.",
    };
  }
  return { title: "No se pudo registrar la decisión", text: err.message };
}
