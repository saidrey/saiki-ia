import type { ExecutionStage, ExecutionView } from "../api/types";
import type { LogEntry } from "../model/events";
import { duration } from "../model/format";
import { observedTime, type StageObservation } from "../model/observations";
import { approvalKindLabel, gateAfterStage, stateLabel, stationState } from "../model/stages";
import { STAGE_RESPONSIBLE } from "../model/agents";
import { useNow } from "../hooks/useNow";
import { AgentAvatar } from "./AgentAvatar";
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

/** Detalle de la etapa seleccionada: responsable, actividad, herramientas y resultado, sin deducir nada. */
export function StageInspector({ view, stage, index, observation, events }: Props) {
  const state = stationState(stage, view);
  const gateHere = gateAfterStage(view) === stage.id;
  const responsible = STAGE_RESPONSIBLE[stage.id];
  const developerRuntime =
    stage.id === "development" && !["available", "unavailable", "not_applicable"].includes(view.runtime) ? view.runtime : null;

  return (
    <section id="stage-inspector" className={styles.panel} aria-labelledby="insp-title" tabIndex={-1}>
      <header className={styles.head}>
        <p className={styles.kicker}>
          Etapa {String(index + 1).padStart(2, "0")} de {String(view.stages.length).padStart(2, "0")}
        </p>
        <h2 id="insp-title" className={styles.title}>
          {stage.label}
        </h2>
        <span className={styles.state} data-state={state}>
          <StageMark state={state} size={14} />
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

      <section className={styles.section} aria-labelledby="insp-who">
        <h3 id="insp-who" className={styles.sectionTitle}>
          Responsable
        </h3>
        <div className={styles.who}>
          <AgentAvatar kind={responsible.kind} size={32} active={state === "running"} />
          <div className={styles.whoText}>
            <span className={styles.whoName}>
              {responsible.name}
              {responsible.isAgent ? <span className={styles.badge}>Agente</span> : null}
            </span>
            <span className={styles.reason}>{responsible.role}</span>
          </div>
        </div>
        {developerRuntime ? (
          <p className={styles.small}>
            Runtime que informa el backend: <code>{developerRuntime}</code>
          </p>
        ) : null}
        <p className={styles.note}>Asignado en la configuración de roles. El backend no registra qué agente ejecutó cada etapa.</p>
      </section>

      <section className={styles.section} aria-labelledby="insp-activity">
        <h3 id="insp-activity" className={styles.sectionTitle}>
          Actividad
        </h3>
        <dl className={styles.fields}>
          <dt>Tiempo observado</dt>
          <dd>
            <ObservedTimeValue observation={observation} stage={stage} />
          </dd>
          <dt>Eventos</dt>
          <dd>{events.length === 0 ? <span className={styles.reason}>Ninguno de esta etapa en el registro.</span> : `${events.length} en el registro`}</dd>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="insp-tools">
        <h3 id="insp-tools" className={styles.sectionTitle}>
          Herramientas
        </h3>
        {responsible.isAgent ? (
          <dl className={styles.fields}>
            <dt>Disponibles</dt>
            <dd>
              {responsible.tools.length === 0 ? (
                <span className={styles.reason}>Ninguna: solo genera texto.</span>
              ) : (
                <ul className={styles.chips}>
                  {responsible.tools.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
            </dd>
            {responsible.blocked.length > 0 ? (
              <>
                <dt>Bloqueadas</dt>
                <dd className={styles.reason}>{responsible.blocked.join(", ")}</dd>
              </>
            ) : null}
            <dt>MCP</dt>
            <dd className={styles.reason}>{responsible.mcp}</dd>
            <dt>Utilizadas</dt>
            <dd>
              <Unavailable reason="el backend no registra qué herramientas usó el agente." />
            </dd>
          </dl>
        ) : (
          <p className={styles.reason}>No aplica: esta etapa no la ejecuta un agente.</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="insp-result">
        <h3 id="insp-result" className={styles.sectionTitle}>
          Resultado y observaciones
        </h3>
        <p className={styles.detail}>
          {stage.detail ? stage.detail : <Unavailable reason="el backend no registró un resumen para esta etapa." />}
        </p>
        {stage.status === "failed" && view.errors.length > 0 ? (
          <div className={styles.error}>
            <ul>
              {view.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            <span className={styles.note}>El backend registra los errores por ejecución, no por etapa.</span>
          </div>
        ) : null}
      </section>

      <details className={styles.technical}>
        <summary>Detalles técnicos</summary>
        <dl className={styles.fields}>
          <dt>Etapa</dt>
          <dd>
            <code>{stage.id}</code>
          </dd>
          <dt>Estado en la API</dt>
          <dd>
            <code>{stage.status}</code>
          </dd>
          <dt>Eventos</dt>
          <dd>
            {events.length === 0 ? (
              <span className={styles.reason}>Ninguno.</span>
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
        </dl>
      </details>
    </section>
  );
}
