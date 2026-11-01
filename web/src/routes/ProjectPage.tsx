import { Link, NavLink, Outlet, useOutletContext, useParams } from "react-router";
import { ApiError } from "../api/client";
import type { ContextScan, Project, ProjectContext, ScanProgressData } from "../api/types";
import { EventsStatus } from "../components/EventLog";
import { useProjects } from "../hooks/useProjects";
import { useProjectContext, useProjectContextEvents, useRequestScan } from "../hooks/useProjectContext";
import { useNow } from "../hooks/useNow";
import { absoluteTime, elapsed, relativeTime } from "../model/format";
import { HEALTH_LABEL } from "../model/projects";
import {
  CONTEXT_STATUS_HINT,
  CONTEXT_STATUS_LABEL,
  progressText,
  SCAN_MODE_LABEL,
  SCAN_STATUS_LABEL,
  SCAN_TRIGGER_LABEL,
  staleReasonText,
} from "../model/context";
import styles from "./Page.module.css";
import own from "./ProjectPage.module.css";

/** Lo que el detalle comparte con sus pestañas. */
export interface ProjectOutletContext {
  project: Project;
  context: ProjectContext;
}

export function useProjectOutlet(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}

const tabClass = own.tab;

function ActiveScan({ scan, progress }: { scan: ContextScan; progress: ScanProgressData | undefined }) {
  const now = useNow(scan.startedAt !== null);
  return (
    <section className={own.activeScan} aria-labelledby="active-scan-title">
      <div className={own.activeHead}>
        <h2 id="active-scan-title" className={own.status} data-status={scan.status}>
          Escaneo {SCAN_MODE_LABEL[scan.mode].toLowerCase()} {SCAN_STATUS_LABEL[scan.status].toLowerCase()}
        </h2>
        <span className={own.hint}>{SCAN_TRIGGER_LABEL[scan.trigger]}</span>
        {scan.startedAt ? (
          <span className={own.hint}>
            Iniciado hace <time dateTime={scan.startedAt}>{elapsed(now - Date.parse(scan.startedAt))}</time>
          </span>
        ) : (
          <span className={own.hint}>Esperando turno (como mucho 2 escaneos a la vez)</span>
        )}
        <Link to={`scans/${encodeURIComponent(scan.id)}`}>Ver escaneo</Link>
      </div>
      {progress && progress.scanId === scan.id ? (
        <>
          <p>{progressText(progress)}</p>
          {progress.toHash > 0 ? (
            <progress className={own.meter} max={progress.toHash} value={progress.hashed} aria-label="Archivos procesados" />
          ) : null}
        </>
      ) : scan.status === "running" ? (
        <p className={own.hint}>Listando archivos. El backend publica cifras al empezar a calcular hashes.</p>
      ) : null}
    </section>
  );
}

function ScanButtons({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const request = useRequestScan(projectId);
  return (
    <div className={own.field}>
      <div className={own.actions}>
        <button type="button" className={own.primary} disabled={disabled || request.isPending} onClick={() => request.mutate("incremental")}>
          {request.isPending && request.variables === "incremental" ? "Solicitando…" : "Escanear cambios"}
        </button>
        <button type="button" className={own.secondary} disabled={disabled || request.isPending} onClick={() => request.mutate("full")}>
          {request.isPending && request.variables === "full" ? "Solicitando…" : "Escaneo completo"}
        </button>
      </div>
      {request.error ? (
        <p className={own.error} role="alert">
          No se pudo solicitar el escaneo: {request.error.message}
        </p>
      ) : request.data?.deduplicated ? (
        <p className={own.hint} role="status">
          Ya había un escaneo en cola o en curso; se sigue ese.
        </p>
      ) : null}
    </div>
  );
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const projects = useProjects();
  const ctx = useProjectContext(projectId);
  const events = useProjectContextEvents(projectId);
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.isPending || ctx.isPending) return <p className={styles.text}>Cargando proyecto…</p>;
  if (ctx.isError || projects.isError || !project) {
    const err = ctx.error ?? projects.error;
    const notFound = !project || (err instanceof ApiError && err.status === 404);
    return (
      <section className={`${styles.page} ${styles.narrow}`} aria-labelledby="p-err">
        <h1 id="p-err" className={styles.title}>
          {notFound ? "Este proyecto no existe" : "No se pudo cargar el proyecto"}
        </h1>
        <p className={styles.text}>
          {notFound ? "Puede que la dirección sea incorrecta." : err?.message} <Link to="/projects">Volver a Proyectos</Link>.
        </p>
      </section>
    );
  }

  const context = ctx.data;
  const scan = context.currentScan;
  const canScan = project.status === "active" && project.health === "ok";
  const outlet: ProjectOutletContext = { project, context };

  return (
    <article className={`${styles.page} ${own.page}`} aria-labelledby="project-title">
      <Link to="/projects" className={own.back}>
        Proyectos
      </Link>
      <header className={own.header}>
        <div className={own.titleRow}>
          <div className={own.titleGroup}>
            <h1 id="project-title" className={styles.title}>
              {project.name}
            </h1>
            <span className={own.status} data-status={context.status}>
              Contexto: {CONTEXT_STATUS_LABEL[context.status]}
            </span>
          </div>
          <ScanButtons projectId={project.id} disabled={!canScan} />
        </div>
        <dl className={own.meta}>
          <div>
            <dt>Repositorio</dt>
            <dd className={own.mono}>{project.rootPath}</dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>
              {project.status === "active" ? "Activo" : "Desactivado"}, {HEALTH_LABEL[project.health].toLowerCase()}
            </dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>
              {context.snapshot ? (
                <>
                  <time dateTime={context.snapshot.createdAt} title={absoluteTime(context.snapshot.createdAt)}>
                    {relativeTime(context.snapshot.createdAt)}
                  </time>
                  , {context.snapshot.summary.files} archivos indexados
                </>
              ) : (
                "Ninguno todavía"
              )}
            </dd>
          </div>
        </dl>
        <p className={own.hint}>
          {CONTEXT_STATUS_HINT[context.status]} <EventsStatus connection={events.connection} subject="proyecto" />
        </p>
      </header>

      {!canScan ? (
        <p className={own.notice} role="status">
          {project.status !== "active"
            ? "El proyecto está desactivado: no se puede escanear. Su último snapshot se conserva."
            : `El repositorio no está disponible (${HEALTH_LABEL[project.health].toLowerCase()}): no se puede escanear.`}
        </p>
      ) : null}
      {context.stale ? (
        <p className={own.notice} role="status">
          El snapshot puede no reflejar el repositorio: {staleReasonText(context.stale.reason)}
          {context.stale.changedPaths !== null ? ` (unas ${context.stale.changedPaths} rutas con cambios según git)` : ""}.
        </p>
      ) : null}
      {context.lastScan && (context.lastScan.status === "failed" || context.lastScan.status === "interrupted") && !scan ? (
        <p className={own.notice} data-tone="failed" role="status">
          El último escaneo {context.lastScan.status === "failed" ? "falló" : "se interrumpió"}
          {context.lastScan.error ? `: ${context.lastScan.error}` : "."}{" "}
          {context.snapshot ? "Se sigue usando el snapshot anterior." : "No hay ningún snapshot."}{" "}
          <Link to={`scans/${encodeURIComponent(context.lastScan.id)}`}>Ver detalle</Link>
        </p>
      ) : null}
      {scan ? <ActiveScan scan={scan} progress={events.progress[scan.id]} /> : null}

      <nav aria-label="Contexto del proyecto" className={own.tabs}>
        <NavLink end to="." className={tabClass}>
          Resumen técnico
        </NavLink>
        <NavLink to="files" className={tabClass}>
          Archivos indexados
        </NavLink>
        <NavLink to="scans" className={tabClass}>
          Escaneos
        </NavLink>
        <NavLink to="knowledge" className={tabClass}>
          Conocimiento
        </NavLink>
      </nav>

      <Outlet context={outlet} />
      <p className="visually-hidden" role="status" aria-live="polite">
        {events.announcement}
      </p>
    </article>
  );
}
