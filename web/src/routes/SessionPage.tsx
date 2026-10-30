import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import type { DelegatedTask } from "../api/types";
import { Composer } from "../components/Composer";
import { useExecutions } from "../hooks/useExecution";
import { executionsOf } from "../model/sessions";
import { LIFECYCLE_LABEL } from "../model/stages";
import { usePendingMessages } from "../hooks/useSendMessage";
import { useSession } from "../hooks/useSessions";
import { absoluteTime, relativeTime } from "../model/format";
import { useProjectsById } from "../hooks/useProjects";
import { HEALTH_LABEL } from "../model/projects";
import styles from "./Page.module.css";
import own from "./SessionPage.module.css";

const TASK_STATUS: Record<DelegatedTask["status"], string> = {
  pending: "Pendiente",
  blocked: "Bloqueada",
  running: "En curso",
  succeeded: "Completada",
  failed: "Fallida",
};

/** Ejecuciones de desarrollo de la sesión (una por solicitud), la más reciente primero. */
function SessionExecutions({ ids }: { ids: string[] }) {
  const ordered = [...ids].reverse();
  const qs = useExecutions(ordered);
  if (ordered.length === 0) return null;
  return (
    <section aria-labelledby="execs-title" className={own.section}>
      <h2 id="execs-title" className={styles.heading}>
        Ejecuciones de desarrollo ({ordered.length})
      </h2>
      <ul className={own.execList}>
        {ordered.map((id, i) => {
          const v = qs[i]?.data?.execution;
          return (
            <li key={id}>
              <Link to={`/executions/${encodeURIComponent(id)}`} className={own.execItem}>
                <span>{v && v.request !== "unavailable" ? v.request : id}</span>
                <span className={styles.text}>{v ? LIFECYCLE_LABEL[v.lifecycle] : "Cargando…"}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskItem({ task }: { task: DelegatedTask }) {
  const answer = task.synthesis ?? task.result;
  return (
    <li className={own.task}>
      <div className={own.taskHead}>
        <span className={own.taskStatus} data-status={task.status}>
          {TASK_STATUS[task.status]}
        </span>
        <span className={styles.text}>
          Rol <span className={styles.mono}>{task.agentRole}</span>
        </span>
        <span className={styles.text}>
          Runtime <span className={styles.mono}>{task.runtime}</span>
        </span>
      </div>
      {answer ? <p className={own.answer}>{answer}</p> : <p className={styles.text}>Sin resultado registrado.</p>}
      {task.evidence.length > 0 ? (
        <ul className={own.evidence}>
          {task.evidence.map((e, i) => (
            <li key={i}>
              {e.description}
              {e.source ? <span className={styles.text}> ({e.source})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {task.errors.length > 0 ? (
        <ul className={own.errors}>
          {task.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SessionPage() {
  const { sessionId = "" } = useParams();
  const processing = usePendingMessages().some((p) => p.sessionId === sessionId);
  const q = useSession(sessionId, processing);
  const projects = useProjectsById();

  if (q.isPending) return <p className={styles.text}>Cargando sesión…</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <section className={`${styles.page} ${styles.narrow}`} aria-labelledby="s-err">
        <h1 id="s-err" className={styles.title}>
          {notFound ? (processing ? "Registrando tu sesión…" : "Esta sesión no existe") : "No se pudo cargar la sesión"}
        </h1>
        <p className={styles.text}>
          {notFound
            ? processing
              ? "El moderador todavía está clasificando el primer mensaje."
              : "Puede que la dirección sea incorrecta."
            : q.error.message}{" "}
          <Link to="/">Volver al inicio</Link>.
        </p>
      </section>
    );
  }

  const { session, tasks } = q.data;
  const title = session.turns.find((t) => t.role === "user")?.text ?? "Sesión sin mensajes";
  const project = session.projectId ? projects?.get(session.projectId) : undefined;
  const projectProblem = !project
    ? null
    : project.status !== "active"
      ? `El proyecto "${project.name}" está desactivado: esta sesión no puede iniciar desarrollos.`
      : project.health !== "ok"
        ? `El repositorio de "${project.name}" no está disponible (${HEALTH_LABEL[project.health].toLowerCase()}): esta sesión no puede iniciar desarrollos.`
        : null;

  return (
    <article className={styles.page} aria-labelledby="s-title">
      <header className={own.header}>
        <h1 id="s-title" className={styles.title}>
          {title}
        </h1>
        <p className={styles.meta}>
          <span>
            {session.projectId ? (
              <>
                Proyecto <Link to="/projects">{project?.name ?? session.projectId}</Link>
                {project ? <span className={styles.mono}> {project.rootPath}</span> : null}
              </>
            ) : (
              "Sin proyecto: solo conversación"
            )}
          </span>
          <span>
            Sesión <span className={styles.mono}>{session.sessionId}</span>
          </span>
          <span>
            Última actividad <time dateTime={session.updatedAt} title={absoluteTime(session.updatedAt)}>{relativeTime(session.updatedAt)}</time>
          </span>
        </p>
      </header>

      {projectProblem ? (
        <p className={styles.notice} role="status">
          {projectProblem}
        </p>
      ) : null}

      <SessionExecutions ids={executionsOf(session)} />

      <section aria-labelledby="conv-title" className={own.section}>
        <h2 id="conv-title" className={styles.heading}>
          Conversación
        </h2>
        <ol className={own.turns}>
          {session.turns.map((t, i) => (
            <li key={i} className={own.turn} data-role={t.role}>
              <span className={own.who}>
                {t.role === "user" ? "Tú" : "Saiki-IA"}{" "}
                <time dateTime={t.at} title={absoluteTime(t.at)}>
                  {relativeTime(t.at)}
                </time>
              </span>
              <p className={own.turnText}>{t.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {tasks.length > 0 ? (
        <section aria-labelledby="tasks-title" className={own.section}>
          <h2 id="tasks-title" className={styles.heading}>
            Tareas de asistencia ({tasks.length})
          </h2>
          <ul className={own.tasks}>
            {tasks.map((t) => (
              <TaskItem key={t.id} task={t} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className={own.section}>
        <Composer
          sessionId={session.sessionId}
          label="Responder"
          hint={
            session.projectId
              ? "Continúa la conversación o pide otro desarrollo. Cada desarrollo es una ejecución nueva: las anteriores no cambian."
              : "Esta sesión no tiene proyecto: Saiki-IA conversa sin acceso a ningún repositorio y no puede desarrollar. Para pedir un desarrollo, empieza una solicitud nueva desde el inicio eligiendo un proyecto."
          }
        />
      </section>
    </article>
  );
}
