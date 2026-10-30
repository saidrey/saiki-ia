import { Link } from "react-router";
import type { ExecutionView } from "../api/types";
import { relativeTime } from "../model/format";
import type { ActivityRow } from "../model/sessions";
import { approvalKindLabel, LIFECYCLE_LABEL } from "../model/stages";
import { MiniRail } from "./MiniRail";
import styles from "./SessionList.module.css";

export interface SessionRow {
  row: ActivityRow;
  /** Vista de su ejecución, si tiene y ya cargó. */
  execution?: ExecutionView;
  /** La carga de su ejecución falló (se dice, no se oculta). */
  executionError?: string;
  /** Hay un mensaje de esta pestaña en curso para la sesión (filas sin ejecución). */
  processing: boolean;
  /** Nombre del proyecto de la sesión, o "Sin proyecto". */
  project: string;
}

type Tone = "awaiting" | "failed" | "running" | "plain";
const LIFECYCLE_TONE: Record<ExecutionView["lifecycle"], Tone> = {
  running: "running",
  awaiting_decision: "awaiting",
  interrupted: "failed",
  completed: "plain",
  failed: "failed",
  stopped: "plain",
};

/** Estado de la fila según el ciclo de vida que da el backend. */
function describe(r: SessionRow): { text: string; tone: Tone } {
  const v = r.execution;
  if (r.executionError) return { text: `No se pudo cargar la ejecución: ${r.executionError}`, tone: "failed" };
  if (r.row.executionId === undefined) {
    if (r.processing) return { text: "Procesando tu mensaje", tone: "running" };
    return { text: r.row.hasAssistance ? "Sesión con asistencia" : "Conversación", tone: "plain" };
  }
  if (v === undefined) return { text: "Cargando ejecución…", tone: "plain" };
  const label = LIFECYCLE_LABEL[v.lifecycle];
  if (v.awaitingDecision) return { text: `${label}: ${approvalKindLabel(v.awaitingDecision.kind)}`, tone: "awaiting" };
  if (v.lifecycle === "running") {
    const stage = v.stages.find((s) => s.id === v.activeStage);
    return { text: stage ? `${label}: ${stage.label}` : label, tone: "running" };
  }
  if (v.finalResult.available === "available") return { text: `${label}: ${v.finalResult.outcome ?? v.phase}`, tone: LIFECYCLE_TONE[v.lifecycle] };
  return { text: label, tone: LIFECYCLE_TONE[v.lifecycle] };
}

function Row({ item }: { item: SessionRow }) {
  const { row, execution } = item;
  const to = row.executionId
    ? `/executions/${encodeURIComponent(row.executionId)}`
    : `/sessions/${encodeURIComponent(row.sessionId)}`;
  const state = describe(item);
  return (
    <li className={styles.item}>
      <Link to={to} className={styles.link}>
        <span className={styles.main}>
          <span className={styles.title}>{row.title}</span>
          <span className={styles.project}>{item.project}</span>
          <span className={styles.state} data-tone={state.tone}>
            {state.text}
          </span>
        </span>
        <span className={styles.rail}>
          {execution ? <MiniRail view={execution} /> : <span className={styles.kind}>{row.executionId ? "Desarrollo" : "Sin ejecución"}</span>}
        </span>
        <time className={styles.when} dateTime={row.updatedAt}>
          {relativeTime(row.updatedAt)}
        </time>
      </Link>
    </li>
  );
}

export function SessionList({ rows, labelledBy }: { rows: SessionRow[]; labelledBy: string }) {
  return (
    <ul className={styles.list} aria-labelledby={labelledBy}>
      {rows.map((row) => (
        <Row key={row.row.key} item={row} />
      ))}
    </ul>
  );
}
