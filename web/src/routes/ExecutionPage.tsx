import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import type { ExecutionView, StageId } from "../api/types";
import { GateBanner } from "../components/GateBanner";
import { Pipeline } from "../components/Pipeline";
import { SessionRail } from "../components/SessionRail";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { EventLog } from "../components/EventLog";
import { ExecutionResult } from "../components/ExecutionResult";
import { StageInspector } from "../components/StageInspector";
import { useExecution } from "../hooks/useExecution";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { useDecisionRecords } from "../hooks/useDecisions";
import { usePendingMessages } from "../hooks/useSendMessage";
import { useStageObservations } from "../hooks/useStageObservations";
import { describeDecisionError, describeResolution } from "../model/decisions";
import { entriesForStage } from "../model/events";
import { clockTime } from "../model/format";
import { defaultSelectedStage, isExecutionActive } from "../model/stages";
import { executionProjectNotices } from "../model/projects";
import styles from "./Page.module.css";
import own from "./ExecutionPage.module.css";

const AVAILABILITY_WORDS = new Set(["available", "unavailable", "not_applicable"]);

function ExecutionHeader({ view }: { view: ExecutionView }) {
  const hasSession = !AVAILABILITY_WORDS.has(view.sessionId);
  const request = AVAILABILITY_WORDS.has(view.request) ? null : view.request;
  return (
    <header className={own.header}>
      <h1 id="exec-title" className={styles.title}>
        {request ?? "Solicitud no disponible"}
      </h1>
      <dl className={own.meta}>
        <div>
          <dt>Proyecto</dt>
          <dd>
            {view.project ? (
              <>
                <Link to="/projects">{view.project.name}</Link> <span className={styles.mono}>{view.project.rootPath}</span>
              </>
            ) : view.project === null ? (
              "Anterior al registro de proyectos"
            ) : (
              "No disponible"
            )}
          </dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{view.status}</dd>
        </div>
        <div>
          <dt>Fase</dt>
          <dd className={styles.mono}>{view.phase}</dd>
        </div>
        <div>
          <dt>Ciclos de corrección</dt>
          <dd>{view.retries}</dd>
        </div>
        <div>
          <dt>Ejecución</dt>
          <dd className={styles.mono}>{view.executionId}</dd>
        </div>
        <div>
          <dt>Sesión</dt>
          <dd>
            {hasSession ? (
              <Link className={styles.mono} to={`/sessions/${encodeURIComponent(view.sessionId)}`}>
                {view.sessionId}
              </Link>
            ) : (
              "No disponible"
            )}
          </dd>
        </div>
      </dl>
    </header>
  );
}

export function ExecutionPage() {
  const { executionId = "" } = useParams();
  const q = useExecution(executionId);
  const pending = usePendingMessages();
  const observations = useStageObservations(executionId);
  const events = useExecutionEvents(executionId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const decisions = useDecisionRecords(executionId);
  const deciding = decisions.find((d) => d.status === "pending") ?? null;
  const lastDecision = decisions.at(-1);
  const [params, setParams] = useSearchParams();
  const selectStage = (id: StageId) => {
    setParams(
      (p) => {
        p.set("stage", id);
        return p;
      },
      { replace: true },
    );
    // En pantallas estrechas el detalle queda debajo de la vía: llevarlo a la vista
    // (no hace nada si ya está visible).
    requestAnimationFrame(() => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("stage-inspector")?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    });
  };

  let body;
  if (q.isPending) {
    body = <p className={styles.text}>Cargando ejecución…</p>;
  } else if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    body = (
      <section className={`${styles.page} ${styles.narrow}`} aria-labelledby="e-err">
        <h1 id="e-err" className={styles.title}>
          {notFound ? "Esta ejecución no existe" : "No se pudo cargar la ejecución"}
        </h1>
        <p className={styles.text}>
          {notFound ? "Puede que la dirección sea incorrecta." : q.error.message} <Link to="/">Volver al inicio</Link>.
        </p>
      </section>
    );
  } else {
    const view = q.data;
    const live = pending.some((p) => p.sessionId === view.sessionId) || isExecutionActive(view);
    const requested = params.get("stage");
    const selectedIndex = Math.max(
      0,
      view.stages.findIndex((s) => s.id === (view.stages.some((x) => x.id === requested) ? requested : defaultSelectedStage(view))),
    );
    const selected = view.stages[selectedIndex];
    body = (
      <article className={styles.page} aria-labelledby="exec-title">
        <ExecutionHeader view={view} />

        {executionProjectNotices(view).map((n) => (
          <p key={n.text} className={styles.notice} data-tone={n.tone} role="status">
            {n.text}
          </p>
        ))}

        {view.finalResult.available === "available" ? (
          <ExecutionResult view={view} />
        ) : null}

        {view.lifecycle === "interrupted" ? (
          <section className={own.interrupted} aria-labelledby="int-title">
            <h2 id="int-title" className={styles.heading}>
              Ejecución interrumpida
            </h2>
            <p className={styles.text}>
              El backend se detuvo con trabajo pendiente en esta ejecución y no la reanuda solo. Los datos mostrados son los
              del último estado guardado.
            </p>
          </section>
        ) : null}

        <section className={own.pipelineSection} aria-labelledby="pipe-title">
          <div className={own.sectionHead}>
            <h2 id="pipe-title" className={styles.heading}>
              Pipeline
            </h2>
            <div className={own.freshness}>
              <span role="status" data-live={live ? "" : undefined} className={own.liveText}>
                {live ? "Observando en vivo" : "Sin actividad en curso"}, actualizado {clockTime(q.dataUpdatedAt)}
              </span>
              <button type="button" className={own.refresh} onClick={() => q.refetch()} disabled={q.isFetching}>
                {q.isFetching ? "Actualizando…" : "Actualizar"}
              </button>
            </div>
          </div>
          <Pipeline view={view} live={live} selectedId={selected.id} onSelect={selectStage} />
        </section>

        {lastDecision && lastDecision.status === "success" && lastDecision.result ? (
          <p className={own.decided} role="status">
            Decisión registrada: {describeResolution(lastDecision.input.kind, lastDecision.result)}
          </p>
        ) : lastDecision && lastDecision.status === "error" && lastDecision.error && !dialogOpen ? (
          <div className={own.decisionError} role="alert">
            <p className={own.decisionErrorTitle}>{describeDecisionError(lastDecision.error).title}</p>
            <p>{describeDecisionError(lastDecision.error).text}</p>
          </div>
        ) : null}

        <GateBanner
          pending={view.pendingApproval}
          onReview={() => setDialogOpen(true)}
          decidingSince={deciding ? deciding.submittedAt : null}
        />
        <ApprovalDialog
          executionId={view.executionId}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          reviews={view.stages.filter((s) => s.id === "functional_review" || s.id === "quality_review")}
          project={view.project}
        />

        <div className={own.panels}>
          <StageInspector
            view={view}
            stage={selected}
            index={selectedIndex}
            observation={observations?.[selected.id]}
            events={entriesForStage(events.entries, selected.id)}
          />
          <EventLog entries={events.entries} connection={events.connection} />
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {events.announcement}
        </p>

        {/* En una ejecución terminada, los errores los presenta el resultado final (sin duplicar la región). */}
        {view.errors.length > 0 && view.finalResult.available !== "available" ? (
          <section className={own.errors} aria-labelledby="err-title">
            <h2 id="err-title" className={styles.heading}>
              Errores registrados
            </h2>
            <ul>
              {view.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </section>
        ) : null}

      </article>
    );
  }

  return (
    <div className={own.layout}>
      <aside className={own.rail}>
        <SessionRail />
      </aside>
      <div className={own.content}>{body}</div>
    </div>
  );
}
