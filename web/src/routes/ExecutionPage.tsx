import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import type { ExecutionView, StageId } from "../api/types";
import { GateBanner } from "../components/GateBanner";
import { Pipeline } from "../components/Pipeline";
import { WorkspaceDialog } from "../components/WorkspaceDialog";
import { ApprovalDialog } from "../components/ApprovalDialog";
import { EventLog } from "../components/EventLog";
import { ExecutionContext } from "../components/ExecutionContext";
import { ExecutionResult } from "../components/ExecutionResult";
import { StageInspector } from "../components/StageInspector";
import { useExecution } from "../hooks/useExecution";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { useDecisionRecords } from "../hooks/useDecisions";
import { usePendingMessages } from "../hooks/useSendMessage";
import { useStageObservations } from "../hooks/useStageObservations";
import { executionContextState } from "../model/context";
import { describeDecisionError, describeResolution } from "../model/decisions";
import { entriesForStage } from "../model/events";
import { clockTime } from "../model/format";
import { describeOutcome } from "../model/outcomes";
import { approvalKindLabel, isExecutionActive, progressSummary } from "../model/stages";
import { executionProjectNotices } from "../model/projects";
import styles from "./Page.module.css";
import own from "./ExecutionPage.module.css";

const AVAILABILITY_WORDS = new Set(["available", "unavailable", "not_applicable"]);

type Section = "result" | "activity" | "context" | "execution" | "errors";

function ExecutionHeader({ view, live, updatedAt, fetching, onRefresh, onDecide }: { view: ExecutionView; live: boolean; updatedAt: number; fetching: boolean; onRefresh: () => void; onDecide: (() => void) | null }) {
  const request = AVAILABILITY_WORDS.has(view.request) ? null : view.request;
  return (
    <header className={own.header}>
      <div className={own.headText}>
        {view.project ? (
          <Link className={own.project} to={`/projects/${encodeURIComponent(view.project.id)}`}>
            {view.project.name}
          </Link>
        ) : null}
        <h1 id="exec-title" className={own.title}>
          {request ?? "Solicitud no disponible"}
        </h1>
      </div>
      <div className={own.freshness}>
        {onDecide ? (
          <button type="button" className={own.decide} onClick={onDecide} aria-haspopup="dialog">
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 1l6 6-6 6-6-6z" />
            </svg>
            Espera tu decisión: {approvalKindLabel(view.pendingApproval.kind)}
          </button>
        ) : null}
        <span role="status" data-live={live ? "" : undefined} className={own.liveChip}>
          <span className={own.liveDot} aria-hidden="true" />
          {live ? "Observando en vivo" : "Sin actividad en curso"}, actualizado {clockTime(updatedAt)}
        </span>
        <button type="button" className={own.refresh} onClick={onRefresh} disabled={fetching}>
          {fetching ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
    </header>
  );
}

/** Datos de la ejecución (antes en la cabecera): ahora bajo demanda. */
function ExecutionData({ view }: { view: ExecutionView }) {
  const hasSession = !AVAILABILITY_WORDS.has(view.sessionId);
  return (
    <section className={own.data} aria-labelledby="data-title">
      <h2 id="data-title" className={own.dialogTitle}>
        Datos de la ejecución
      </h2>
      <dl className={own.dataList}>
        <dt>Proyecto</dt>
        <dd>
          {view.project ? (
            <>
              <Link to={`/projects/${encodeURIComponent(view.project.id)}`}>{view.project.name}</Link>{" "}
              <span className={own.mono}>{view.project.rootPath}</span>
            </>
          ) : view.project === null ? (
            "Anterior al registro de proyectos"
          ) : (
            "No disponible"
          )}
        </dd>
        <dt>Estado</dt>
        <dd>{view.status}</dd>
        <dt>Fase</dt>
        <dd className={own.mono}>{view.phase}</dd>
        <dt>Ciclos de corrección</dt>
        <dd>{view.retries}</dd>
        <dt>Ejecución</dt>
        <dd className={own.mono}>{view.executionId}</dd>
        <dt>Sesión</dt>
        <dd>
          {hasSession ? (
            <Link className={own.mono} to={`/sessions/${encodeURIComponent(view.sessionId)}`}>
              {view.sessionId}
            </Link>
          ) : (
            "No disponible"
          )}
        </dd>
      </dl>
    </section>
  );
}

const TILE_ICON: Record<Section, string> = {
  result: "M5 12.5l4 4L19 7",
  activity: "M3 12h4l2.5-6 5 12 2.5-6H21",
  context: "M12 3l8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5L12 21l8-4.5",
  execution: "M4 6h16M4 12h16M4 18h10",
  errors: "M12 8v5M12 16.5v.5M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
};

/** Acceso a una sección: lo justo para saber qué hay dentro; el detalle se abre en un modal. */
function SectionTile({ id, title, summary, tone, onOpen }: { id: Section; title: string; summary: ReactNode; tone?: string; onOpen: (s: Section) => void }) {
  return (
    <li>
      <button type="button" className={own.tile} data-tone={tone} aria-haspopup="dialog" onClick={() => onOpen(id)}>
        <svg className={own.tileIcon} width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path d={TILE_ICON[id]} />
        </svg>
        <span className={own.tileTitle}>{title}</span>
        <span className={own.tileSummary}>{summary}</span>
      </button>
    </li>
  );
}

const CONNECTION_SHORT = { connecting: "conectando", open: "en directo", reconnecting: "reconectando", ended: "finalizado", not_found: "no disponible", unavailable: "no disponible" } as const;

export function ExecutionPage() {
  const { executionId = "" } = useParams();
  const q = useExecution(executionId);
  const pending = usePendingMessages();
  const observations = useStageObservations(executionId);
  const events = useExecutionEvents(executionId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  const decisions = useDecisionRecords(executionId);
  const deciding = decisions.find((d) => d.status === "pending") ?? null;
  const lastDecision = decisions.at(-1);
  const [params, setParams] = useSearchParams();
  // La etapa abierta vive en la URL (?stage=): se puede enlazar.
  const openStage = (id: StageId | null) =>
    setParams(
      (p) => {
        if (id) p.set("stage", id);
        else p.delete("stage");
        return p;
      },
      { replace: true },
    );

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
    const stageIndex = view.stages.findIndex((s) => s.id === params.get("stage"));
    const stage = stageIndex >= 0 ? view.stages[stageIndex] : null;
    const hasResult = view.finalResult.available === "available";
    const outcome = describeOutcome(view.finalResult.outcome);
    const ctx = executionContextState(view);
    const lastEntry = events.entries.at(-1);

    body = (
      <article className={own.workspace} aria-labelledby="exec-title">
        <ExecutionHeader
          view={view}
          live={live}
          updatedAt={q.dataUpdatedAt}
          fetching={q.isFetching}
          onRefresh={() => q.refetch()}
          onDecide={view.pendingApproval.required && !deciding ? () => setDialogOpen(true) : null}
        />

        {executionProjectNotices(view).map((n) => (
          <p key={n.text} className={styles.notice} data-tone={n.tone} role="status">
            {n.text}
          </p>
        ))}

        {view.lifecycle === "interrupted" ? (
          <section className={own.interrupted} aria-labelledby="int-title">
            <h2 id="int-title" className={styles.heading}>
              Ejecución interrumpida
            </h2>
            <p className={styles.text}>
              El backend se detuvo con trabajo pendiente en esta ejecución y no la reanuda solo. Los datos mostrados son los del
              último estado guardado.
            </p>
          </section>
        ) : null}

        <section className={own.band} aria-labelledby="pipe-title">
          <div className={own.bandHead}>
            <h2 id="pipe-title" className={own.bandTitle}>
              Pipeline
            </h2>
            <p className={own.bandSummary}>{progressSummary(view)}. Pulsa una etapa para ver su detalle.</p>
          </div>
          <Pipeline
            view={view}
            live={live}
            pulse={events.pulse}
            onOpen={openStage}
            decision={view.pendingApproval.required ? { onReview: () => setDialogOpen(true), busy: deciding !== null } : null}
          />
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

        <GateBanner pending={view.pendingApproval} onReview={() => setDialogOpen(true)} decidingSince={deciding ? deciding.submittedAt : null} />
        <ApprovalDialog
          executionId={view.executionId}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          reviews={view.stages.filter((s) => s.id === "functional_review" || s.id === "quality_review")}
          project={view.project}
        />

        <nav aria-label="Secciones de la ejecución">
          <ul className={own.tiles}>
            {hasResult ? <SectionTile id="result" title="Resultado final" summary={outcome.text} tone={outcome.tone} onOpen={setSection} /> : null}
            <SectionTile
              id="activity"
              title="Actividad"
              summary={`${events.entries.length} evento${events.entries.length === 1 ? "" : "s"}, ${CONNECTION_SHORT[events.connection]}${lastEntry ? `. Último: ${lastEntry.text}` : ""}`}
              tone={events.connection === "open" && live ? "live" : undefined}
              onOpen={setSection}
            />
            <SectionTile
              id="context"
              title="Contexto congelado"
              summary={
                ctx.kind === "received"
                  ? `${ctx.context.sources.length} fuente${ctx.context.sources.length === 1 ? "" : "s"}${ctx.context.stale ? ", puede estar desactualizado" : ""}`
                  : ctx.kind === "not_yet"
                    ? "Se congela antes del análisis técnico."
                    : "Sin contexto de proyecto."
              }
              tone={ctx.kind === "received" && ctx.context.stale ? "warning" : undefined}
              onOpen={setSection}
            />
            <SectionTile id="execution" title="Datos de la ejecución" summary={`${view.status}. Fase ${view.phase}.`} onOpen={setSection} />
            {view.errors.length > 0 && !hasResult ? (
              <SectionTile id="errors" title="Errores" summary={`${view.errors.length} registrado${view.errors.length === 1 ? "" : "s"}`} tone="failure" onOpen={setSection} />
            ) : null}
          </ul>
        </nav>
        <p className="visually-hidden" role="status" aria-live="polite">
          {events.announcement}
        </p>

        <WorkspaceDialog open={stage !== null} onClose={() => openStage(null)} labelledBy="insp-title">
          {stage ? (
            <StageInspector
              view={view}
              stage={stage}
              index={stageIndex}
              observation={observations?.[stage.id]}
              events={entriesForStage(events.entries, stage.id)}
            />
          ) : null}
        </WorkspaceDialog>
        <WorkspaceDialog open={section === "result"} onClose={() => setSection(null)} labelledBy="result-title">
          {hasResult ? <ExecutionResult view={view} /> : null}
        </WorkspaceDialog>
        <WorkspaceDialog open={section === "activity"} onClose={() => setSection(null)} labelledBy="log-title">
          <EventLog entries={events.entries} connection={events.connection} />
        </WorkspaceDialog>
        <WorkspaceDialog open={section === "context"} onClose={() => setSection(null)} labelledBy="ctx-title">
          <ExecutionContext view={view} />
        </WorkspaceDialog>
        <WorkspaceDialog open={section === "execution"} onClose={() => setSection(null)} labelledBy="data-title">
          <ExecutionData view={view} />
        </WorkspaceDialog>
        <WorkspaceDialog open={section === "errors"} onClose={() => setSection(null)} labelledBy="err-title">
          <section className={own.errors} aria-labelledby="err-title">
            <h2 id="err-title" className={own.dialogTitle}>
              Errores registrados
            </h2>
            <ul>
              {view.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </section>
        </WorkspaceDialog>
      </article>
    );
  }

  return body;
}
