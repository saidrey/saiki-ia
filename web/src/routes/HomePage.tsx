import { Composer } from "../components/Composer";
import { ConnectionProblem } from "../components/ConnectionProblem";
import { SessionList, type SessionRow } from "../components/SessionList";
import { useExecutions } from "../hooks/useExecution";
import { useHealth } from "../hooks/useHealth";
import { usePendingMessages } from "../hooks/useSendMessage";
import { useSessionsList } from "../hooks/useSessions";
import { activityRows, executionsOf } from "../model/sessions";
import { useProjectsById } from "../hooks/useProjects";
import { sessionProjectLabel } from "../model/projects";
import styles from "./HomePage.module.css";

export function HomePage() {
  const { connection } = useHealth();
  const sessions = useSessionsList();
  const pending = usePendingMessages();
  const projects = useProjectsById();

  // Todas las ejecuciones de todas las sesiones: cada solicitud es una ejecución
  // propia y todas deben verse (también las pausadas anteriores de una sesión).
  const executionIds = (sessions.data ?? []).flatMap(executionsOf);
  const executions = useExecutions(executionIds);
  const byExecution = new Map(executionIds.map((id, i) => [id, executions[i]]));
  const processing = new Set(pending.map((p) => p.sessionId));
  const views = new Map(executionIds.map((id) => [id, byExecution.get(id)?.data?.execution]));

  const rows: SessionRow[] = activityRows(sessions.data ?? [], views).map((row) => {
    const q = row.executionId ? byExecution.get(row.executionId) : undefined;
    return {
      row,
      execution: q?.data?.execution,
      executionError: q?.error ? q.error.message : undefined,
      processing: processing.has(row.sessionId),
      project: sessionProjectLabel(row, projects),
    };
  });
  const attention = rows.filter((r) => r.execution?.awaitingDecision != null);
  const recent = rows.filter((r) => r.execution?.awaitingDecision == null);

  return (
    <div className={styles.page}>
      <section aria-labelledby="new-title" className={styles.section}>
        <h1 id="new-title" className="visually-hidden">
          Inicio
        </h1>
        <Composer
          label="¿Qué necesitas de Saiki-IA?"
          hint="Escribe una pregunta o pide un desarrollo. El moderador decide cómo atenderlo."
          chooseProject
        />
      </section>

      {connection === "unreachable" ? <ConnectionProblem /> : null}

      {sessions.isPending ? (
        <p className={styles.text}>Cargando sesiones…</p>
      ) : sessions.isError ? (
        connection === "unreachable" ? null : (
          <p className={styles.error} role="alert">
            No se pudieron cargar las sesiones: {sessions.error.message}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className={styles.text}>Todavía no hay sesiones. Escribe tu primera solicitud arriba.</p>
      ) : (
        <>
          <section aria-labelledby="att-title" className={styles.section}>
            <h2 id="att-title" className={styles.heading}>
              Necesitan tu intervención ({attention.length})
            </h2>
            {attention.length > 0 ? (
              <SessionList rows={attention} labelledBy="att-title" />
            ) : (
              <p className={styles.text}>Ninguna ejecución espera tu decisión.</p>
            )}
          </section>
          <section aria-labelledby="rec-title" className={styles.section}>
            <h2 id="rec-title" className={styles.heading}>
              Recientes
            </h2>
            {recent.length > 0 ? (
              <SessionList rows={recent} labelledBy="rec-title" />
            ) : (
              <p className={styles.text}>No hay más sesiones.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
