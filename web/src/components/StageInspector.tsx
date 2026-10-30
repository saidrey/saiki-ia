import type { ExecutionStage, ExecutionView } from "../api/types";
import type { LogEntry } from "../model/events";
import { duration } from "../model/format";
import { observedTime, type StageObservation } from "../model/observations";
import { approvalKindLabel, gateAfterStage, stateLabel, stationState } from "../model/stages";
import { useNow } from "../hooks/useNow";
import { StageMark } from "./StageMark";
import styles from "./StageInspector.module.css";

interface Props {
  view: ExecutionView;
  stage: ExecutionStage;
  index: number;
  observation: StageObservation | undefined;
  /** Eventos SSE de esta etapa (registro de la pestaña). */
  events: LogEntry[];
}

const eventTime = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Un dato que el backend no da: se dice, con su motivo. */
function Unavailable({ reason }: { reason: string }) {
  return (
    <span className={styles.unavailable}>
      No disponible<span className={styles.reason}>: {reason}</span>
    </span>
  );
}

function ObservedTimeValue({ observation, stage }: { observation: StageObservation | undefined; stage: ExecutionStage }) {
  const ticking = observation?.startSeenAt !== undefined && observation.endSeenAt === undefined;
  const now = useNow(ticking);
  if (stage.status === "pending" && observation?.lastRunningAt === undefined) {
    return <Unavailable reason="la etapa no ha empezado." />;
  }
  const t = observedTime(observation, now);
  if (t.kind === "unavailable") return <Unavailable reason={t.reason} />;
  const margin = Math.max(1, Math.round(t.marginMs / 1000));
  return (
    <span>
      ≈ {duration(t.ms)}
      {t.kind === "running" ? " hasta ahora" : ""} <span className={styles.reason}>(margen ±{margin} s)</span>
      <span className={styles.note}>
        Tiempo que esta pestaña vio la etapa en curso al consultar la API. No es la duración oficial: el backend no guarda
        tiempos por etapa.
      </span>
    </span>
  );
}

/** Detalle de una etapa con lo que la API da y lo que no, sin deducir nada. */
export function StageInspector({ view, stage, index, observation, events }: Props) {
  const state = stationState(stage, view);
  const gateHere = gateAfterStage(view) === stage.id;
  const developerRuntime =
    stage.id === "development" && !["available", "unavailable", "not_applicable"].includes(view.runtime) ? view.runtime : null;

  return (
    <section id="stage-inspector" className={styles.panel} aria-labelledby="insp-title" tabIndex={-1}>
      <header className={styles.head}>
        <h2 id="insp-title" className={styles.title}>
          {index + 1}. {stage.label}
        </h2>
        <span className={styles.state} data-state={state}>
          <StageMark state={state} size={16} />
          {stateLabel(state, view)}
        </span>
      </header>

      {state === "awaiting" || gateHere ? (
        <p className={styles.decision}>
          <StageMark state="awaiting" size={16} />
          {state === "awaiting" ? "Esta etapa espera tu decisión" : "Tras esta etapa, la ejecución espera tu decisión"}:{" "}
          {approvalKindLabel(view.pendingApproval.kind)}.
        </p>
      ) : null}

      <dl className={styles.fields}>
        <dt>Detalle</dt>
        <dd className={styles.detail}>
          {stage.detail ? stage.detail : <Unavailable reason="el backend no registró un resumen para esta etapa." />}
        </dd>

        <dt>Agente y runtime</dt>
        <dd>
          {developerRuntime ? (
            <>Runtime del desarrollador: <code>{developerRuntime}</code></>
          ) : (
            <Unavailable reason="el backend no registra qué agente ni qué runtime ejecutó cada etapa." />
          )}
        </dd>

        <dt>Tiempo observado</dt>
        <dd>
          <ObservedTimeValue observation={observation} stage={stage} />
        </dd>

        <dt>Estado en la API</dt>
        <dd>
          <code>{stage.status}</code>
        </dd>

        <dt>Eventos</dt>
        <dd>
          {events.length === 0 ? (
            <span className={styles.reason}>Ninguno de esta etapa en el registro.</span>
          ) : (
            <ul className={styles.events}>
              {events.map((e) => (
                <li key={e.key}>
                  <code>
                    #{e.seq} {e.timestamp ? eventTime.format(Date.parse(e.timestamp)) : ""} {e.type}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </dd>

        {stage.status === "failed" && view.errors.length > 0 ? (
          <>
            <dt>Error registrado</dt>
            <dd className={styles.error}>
              <ul>
                {view.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              <span className={styles.note}>El backend registra los errores por ejecución, no por etapa.</span>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
