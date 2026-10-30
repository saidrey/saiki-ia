import { NavLink } from "react-router";
import { useExecutions } from "../hooks/useExecution";
import { useSessionsList } from "../hooks/useSessions";
import { relativeTime } from "../model/format";
import { activityRows, executionsOf } from "../model/sessions";
import { useProjectsById } from "../hooks/useProjects";
import { sessionProjectLabel } from "../model/projects";
import styles from "./SessionRail.module.css";

/** Columna de actividad reciente junto a la ejecución (escritorio): una entrada por ejecución. */
export function SessionRail() {
  const q = useSessionsList();
  const executionIds = (q.data ?? []).flatMap(executionsOf);
  const executions = useExecutions(executionIds);
  const views = new Map(executionIds.map((id, i) => [id, executions[i]?.data?.execution]));
  const rows = activityRows(q.data ?? [], views).slice(0, 12);
  const projects = useProjectsById();
  return (
    <nav className={styles.rail} aria-label="Actividad reciente">
      <NavLink to="/" end className={styles.newLink}>
        Nueva solicitud
      </NavLink>
      {q.isError ? <p className={styles.note}>No se pudieron cargar las sesiones.</p> : null}
      <ul className={styles.list}>
        {rows.map((r) => (
          <li key={r.key}>
            <NavLink
              to={r.executionId ? `/executions/${encodeURIComponent(r.executionId)}` : `/sessions/${encodeURIComponent(r.sessionId)}`}
              className={({ isActive }) => (isActive ? `${styles.item} ${styles.active}` : styles.item)}
            >
              <span className={styles.title}>{r.title}</span>
              <span className={styles.when}>{sessionProjectLabel(r, projects)}</span>
              <time className={styles.when} dateTime={r.updatedAt}>
                {relativeTime(r.updatedAt)}
              </time>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
