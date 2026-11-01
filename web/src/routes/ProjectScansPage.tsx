import { Link } from "react-router";
import { useContextScans } from "../hooks/useProjectContext";
import { SCAN_MODE_LABEL, SCAN_STATUS_LABEL, SCAN_TRIGGER_LABEL, scanDuration, statsLine } from "../model/context";
import { absoluteTime, relativeTime } from "../model/format";
import { useProjectOutlet } from "./ProjectPage";
import own from "./ProjectPage.module.css";

/** Pestaña "Escaneos": historial del backend, del más reciente al más antiguo. */
export function ProjectScansPage() {
  const { project } = useProjectOutlet();
  const q = useContextScans(project.id);

  if (q.isPending) return <p className={own.hint}>Cargando escaneos…</p>;
  if (q.isError) {
    return (
      <p className={own.error} role="alert">
        No se pudo cargar el historial: {q.error.message}
      </p>
    );
  }
  if (q.data.length === 0) return <p className={own.hint}>Este proyecto todavía no tiene escaneos.</p>;

  return (
    <div className={own.panel}>
      <p className={own.hint}>Últimos {q.data.length} escaneos. La duración solo aparece si el escaneo empezó y terminó.</p>
      <div className={own.tableWrap} role="region" aria-label="Tabla del historial de escaneos" tabIndex={0}>
        <table className={own.table}>
          <caption className="visually-hidden">Historial de escaneos</caption>
          <thead>
            <tr>
              <th scope="col">Estado</th>
              <th scope="col">Solicitado</th>
              <th scope="col">Tipo</th>
              <th scope="col">Origen</th>
              <th scope="col">Duración</th>
              <th scope="col">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id}>
                <th scope="row">
                  <Link to={encodeURIComponent(s.id)} className={own.status} data-status={s.status}>
                    {SCAN_STATUS_LABEL[s.status]}
                  </Link>
                </th>
                <td>
                  <time dateTime={s.createdAt} title={absoluteTime(s.createdAt)}>
                    {relativeTime(s.createdAt)}
                  </time>
                </td>
                <td>{SCAN_MODE_LABEL[s.mode]}</td>
                <td>{SCAN_TRIGGER_LABEL[s.trigger]}</td>
                <td>{scanDuration(s) ?? "—"}</td>
                <td>
                  {s.error ? <span className={own.error}>{s.error}</span> : s.stats && s.status === "completed" ? statsLine(s.stats) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
