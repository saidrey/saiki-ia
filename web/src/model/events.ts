import type {
  ApprovalRequiredData,
  ApprovalResolvedData,
  ControlEventData,
  ExecutionEventData,
  SaikiEvent,
  StageEventData,
  StageId,
} from "../api/types";
import { approvalKindLabel } from "./stages";

export type LogFamily = "execution" | "stage" | "approval" | "control";
export type LogTone = "done" | "running" | "awaiting" | "failed" | "plain";

export interface LogEntry {
  /** Identidad estable: eventId (o clave del evento de control). */
  key: string;
  seq?: number;
  timestamp?: string;
  /** Tipo tal cual lo envía la API (`stage.completed`, `control`…). */
  type: string;
  family: LogFamily;
  tone: LogTone;
  text: string;
  stageId?: StageId;
  /** Decisión humana estructurada (solo `approval.resolved`). */
  resolution?: { kind?: string; decision: ApprovalResolvedData["decision"]; actor: string; hash: string; phase: string };
}

const EXECUTION_LABEL: Record<string, string> = {
  "execution.started": "Ejecución iniciada",
  "execution.completed": "Ejecución terminada",
  "execution.failed": "Ejecución fallida",
  "execution.stopped": "Ejecución detenida",
};

const DECISION: Record<ApprovalResolvedData["decision"], string> = {
  approve: "aprobó",
  reject: "rechazó",
  request_changes: "pidió cambios en",
};

/** Una línea legible por evento, solo con lo que trae el evento. */
export function describeEvent(ev: SaikiEvent): LogEntry {
  const base = { key: ev.eventId, seq: ev.seq, timestamp: ev.timestamp, type: ev.type };
  switch (ev.type) {
    case "stage.started":
    case "stage.completed":
    case "stage.failed": {
      const d = ev.data as StageEventData;
      const verb = ev.type === "stage.started" ? "empezó" : ev.type === "stage.completed" ? "completada" : "falló";
      const tone: LogTone = ev.type === "stage.started" ? "running" : ev.type === "stage.completed" ? "done" : "failed";
      return { ...base, family: "stage", tone, text: `${d.label}: ${verb}`, stageId: d.stageId };
    }
    case "approval.required": {
      const d = ev.data as ApprovalRequiredData;
      return { ...base, family: "approval", tone: "awaiting", text: `Espera tu decisión: ${approvalKindLabel(d.kind)}` };
    }
    case "approval.resolved": {
      const d = ev.data as ApprovalResolvedData;
      const what = d.kind !== undefined ? approvalKindLabel(d.kind) : "la aprobación";
      return {
        ...base,
        family: "approval",
        tone: "plain",
        text: `${d.actor} ${DECISION[d.decision] ?? d.decision} ${what}`,
        resolution: { kind: d.kind, decision: d.decision, actor: d.actor, hash: d.proposalHash, phase: d.phase },
      };
    }
    case "execution.started":
    case "execution.completed":
    case "execution.failed":
    case "execution.stopped": {
      const d = ev.data as ExecutionEventData;
      const tone: LogTone = ev.type === "execution.failed" ? "failed" : ev.type === "execution.completed" ? "done" : "plain";
      const label = EXECUTION_LABEL[ev.type];
      return { ...base, family: "execution", tone, text: `${label}: ${d.status}` };
    }
    default:
      return { ...base, family: "execution", tone: "plain", text: ev.type };
  }
}

/** Evento de control: hoy solo `gap` (se pidieron eventos anteriores a los retenidos). */
export function describeControl(data: ControlEventData, receivedAt: number): LogEntry {
  const text =
    data.kind === "gap"
      ? `Faltan eventos anteriores al #${data.earliest ?? "?"}: el servidor ya no los conserva.`
      : `Aviso del servidor: ${data.kind}`;
  return { key: `control-${data.kind}-${data.earliest ?? ""}-${receivedAt}`, type: "control", family: "control", tone: "plain", text };
}

/** Añade una entrada sin duplicar (misma clave = mismo evento) y mantiene el orden por `seq`. */
export function appendEntry(log: LogEntry[], entry: LogEntry): LogEntry[] {
  if (log.some((e) => e.key === entry.key)) return log;
  const next = [...log, entry];
  if (entry.seq === undefined) return next;
  return next.toSorted((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

/** Eventos de una etapa (para el inspector). */
export function entriesForStage(log: LogEntry[], stageId: StageId): LogEntry[] {
  return log.filter((e) => e.stageId === stageId);
}
