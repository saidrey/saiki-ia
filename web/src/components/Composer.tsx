import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../api/client";
import { elapsed } from "../model/format";
import { useNow } from "../hooks/useNow";
import { useSendMessage } from "../hooks/useSendMessage";
import { useSession } from "../hooks/useSessions";
import { useProjects } from "../hooks/useProjects";
import { APPLY_MODE_LABEL, isSelectable } from "../model/projects";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Sesión existente a la que se añade el mensaje; si falta, se reserva una nueva. */
  sessionId?: string;
  label: string;
  hint: string;
  /** Sesión nueva: elegir su proyecto (fijo para siempre) o "sin proyecto". */
  chooseProject?: boolean;
}

/** Valor del selector para una sesión general (solo conversación). */
const GENERAL = "general";
const LAST_CHOICE_KEY = "jev.lastProjectChoice";

/** Última elección de este navegador (comodidad; puede no estar disponible). */
function readLastChoice(): string {
  try {
    return localStorage.getItem(LAST_CHOICE_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveLastChoice(choice: string) {
  try {
    localStorage.setItem(LAST_CHOICE_KEY, choice);
  } catch {
    // Sin almacenamiento: se volverá a elegir la próxima vez.
  }
}

/**
 * Envía un mensaje al moderador. La respuesta puede tardar minutos: mientras
 * tanto se muestra el tiempo transcurrido y se consulta la sesión; si nace una
 * ejecución de desarrollo, se abre su pipeline sin esperar a la respuesta.
 */
export function Composer({ sessionId, label, hint, chooseProject = false }: ComposerProps) {
  const navigate = useNavigate();
  const id = useId();
  const [text, setText] = useState("");
  const projects = useProjects();
  const selectable = (projects.data ?? []).filter(isSelectable);
  const [choice, setChoice] = useState(() => (chooseProject ? readLastChoice() : ""));
  // Una elección guardada que ya no es elegible (desactivado, movido…) no vale.
  const projectChoice = choice === GENERAL || selectable.some((p) => p.id === choice) ? choice : "";
  const chosen = selectable.find((p) => p.id === projectChoice);
  const needsChoice = chooseProject && projectChoice === "";
  const [targetSession, setTargetSession] = useState<string | undefined>(sessionId);
  const [reserveError, setReserveError] = useState<string | null>(null);
  const send = useSendMessage();
  const busy = send.isPending;
  const now = useNow(busy);

  // Mientras la petición sigue abierta, la sesión puede aparecer ya enlazada a
  // su ejecución (el backend la guarda antes de arrancar el grafo).
  const watched = useSession(busy ? targetSession : undefined, busy);
  const discoveredExecution = watched.data?.session.developmentThreadId;
  useEffect(() => {
    if (busy && discoveredExecution !== undefined && sessionId === undefined) {
      navigate(`/executions/${encodeURIComponent(discoveredExecution)}`);
    }
  }, [busy, discoveredExecution, navigate, sessionId]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const message = text.trim();
    if (message.length === 0 || busy || needsChoice) return;
    setReserveError(null);
    let sid = sessionId;
    if (sid === undefined) {
      try {
        if (chooseProject) saveLastChoice(projectChoice);
        sid = (await api.createSession(chosen?.id)).sessionId;
      } catch (err) {
        setReserveError(err instanceof ApiError ? err.message : "No se pudo crear la sesión.");
        return;
      }
    }
    setTargetSession(sid);
    send.mutate(
      { sessionId: sid, message },
      {
        onSuccess: ({ result }) => {
          setText("");
          if (result.category === "development" && result.developmentThreadId !== undefined) {
            navigate(`/executions/${encodeURIComponent(result.developmentThreadId)}`);
          } else if (sessionId === undefined) {
            navigate(`/sessions/${encodeURIComponent(result.sessionId)}`);
          }
        },
      },
    );
  }

  const error = reserveError ?? (send.error ? send.error.message : null);

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-busy={busy}>
      <label htmlFor={`${id}-msg`} className={styles.label}>
        {label}
      </label>
      <p id={`${id}-hint`} className={styles.hint}>
        {hint}
      </p>
      {chooseProject ? (
        <div className={styles.project}>
          <label htmlFor={`${id}-project`} className={styles.projectLabel}>
            Proyecto
          </label>
          <select
            id={`${id}-project`}
            className={styles.select}
            value={projectChoice}
            onChange={(e) => setChoice(e.target.value)}
            aria-describedby={`${id}-phint`}
            disabled={busy}
          >
            <option value="" disabled>
              {projects.isPending ? "Cargando proyectos…" : "Elige un proyecto…"}
            </option>
            {selectable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={GENERAL}>Sin proyecto (solo conversación)</option>
          </select>
          <p id={`${id}-phint`} className={styles.hint}>
            {chosen ? (
              <>
                Trabajará sobre <span className={styles.path}>{chosen.rootPath}</span> ({APPLY_MODE_LABEL[chosen.applyMode].toLowerCase()}).
                La sesión queda ligada a este proyecto.{" "}
              </>
            ) : projectChoice === GENERAL ? (
              "Saiki-IA conversará sin acceso a ningún repositorio y no podrá desarrollar. "
            ) : projects.isError ? (
              `No se pudieron cargar los proyectos: ${projects.error.message}. `
            ) : !projects.isPending && selectable.length === 0 ? (
              "No hay proyectos disponibles: registra uno para pedir desarrollos. "
            ) : (
              "Para pedir un desarrollo, elige el proyecto sobre el que quieres trabajar. "
            )}
            <Link to="/projects">Gestionar proyectos</Link>
          </p>
        </div>
      ) : null}
      <div className={styles.row}>
        <textarea
          id={`${id}-msg`}
          className={styles.input}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
          aria-invalid={error ? true : undefined}
          readOnly={busy}
        />
        <button type="submit" className={styles.send} disabled={busy || needsChoice || text.trim().length === 0}>
          {busy ? "Enviando…" : "Enviar"}
        </button>
      </div>
      {busy ? (
        <p className={styles.progress} role="status">
          Saiki-IA está procesando tu mensaje ({elapsed(now - send.submittedAt)}). Con agentes reales puede tardar
          varios minutos; puedes seguir navegando.
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className={styles.error} role="alert">
          No se pudo enviar: {error}
        </p>
      ) : null}
    </form>
  );
}
