import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import type { ScanChanges } from "../api/types";
import { useContextScan } from "../hooks/useProjectContext";
import { isScanActive, SCAN_MODE_LABEL, SCAN_STATUS_LABEL, SCAN_TRIGGER_LABEL, scanDuration } from "../model/context";
import { absoluteTime } from "../model/format";
import { useProjectOutlet } from "./ProjectPage";
import own from "./ProjectPage.module.css";

function ChangeGroup({ id, title, total, paths }: { id: string; title: string; total: number; paths: string[] }) {
  return (
    <section className={own.section} aria-labelledby={id}>
      <h3 id={id} className={own.subTitle}>
        {title} ({total})
      </h3>
      {paths.length === 0 ? (
        <p className={own.hint}>Ninguno.</p>
      ) : (
        <div className={own.changeList} role="region" aria-label={`Lista: ${title}`} tabIndex={0}>
          <ul className={own.inlineColumn}>
            {paths.map((p) => (
              <li key={p} className={own.mono}>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Changes({ changes, totals }: { changes: ScanChanges; totals: { added: number; modified: number; deleted: number; renamed: number } }) {
  return (
    <section className={own.section} aria-labelledby="changes-title">
      <h2 id="changes-title" className={own.sectionTitle}>
        Cambios respecto al snapshot anterior
      </h2>
      {changes.truncated ? (
        <p className={own.hint}>Se muestran como mucho 200 rutas por tipo; los totales son los del escáner.</p>
      ) : null}
      <div className={own.changes}>
        <ChangeGroup id="ch-added" title="Altas" total={totals.added} paths={changes.added} />
        <ChangeGroup id="ch-modified" title="Modificados" total={totals.modified} paths={changes.modified} />
        <ChangeGroup id="ch-deleted" title="Bajas" total={totals.deleted} paths={changes.deleted} />
        <ChangeGroup id="ch-renamed" title="Renombrados" total={totals.renamed} paths={changes.renamed.map((r) => `${r.from} → ${r.to}`)} />
      </div>
    </section>
  );
}

/** Detalle de un escaneo: metadatos, cifras y cambios (solo si terminó bien). */
export function ProjectScanPage() {
  const { project } = useProjectOutlet();
  const { scanId = "" } = useParams();
  const q = useContextScan(project.id, scanId);

  if (q.isPending) return <p className={own.hint}>Cargando escaneo…</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <p className={own.error} role="alert">
        {notFound ? "Este escaneo no existe en este proyecto." : `No se pudo cargar el escaneo: ${q.error.message}`}{" "}
        <Link to=".." relative="path">
          Volver a escaneos
        </Link>
      </p>
    );
  }
  const s = q.data;
  const time = (iso: string | null) => (iso ? <time dateTime={iso}>{absoluteTime(iso)}</time> : "—");

  return (
    <div className={own.panel}>
      <Link to=".." relative="path" className={own.back}>
        Todos los escaneos
      </Link>
      <section className={own.section} aria-labelledby="scan-title">
        <h2 id="scan-title" className={own.sectionTitle}>
          Escaneo {SCAN_MODE_LABEL[s.mode].toLowerCase()}{" "}
          <span className={own.status} data-status={s.status}>
            {SCAN_STATUS_LABEL[s.status]}
          </span>
        </h2>
        <dl className={own.facts}>
          <dt>Origen</dt>
          <dd>{SCAN_TRIGGER_LABEL[s.trigger]}</dd>
          <dt>Solicitado</dt>
          <dd>{time(s.createdAt)}</dd>
          <dt>Inicio</dt>
          <dd>{time(s.startedAt)}</dd>
          <dt>Fin</dt>
          <dd>{time(s.finishedAt)}</dd>
          <dt>Duración</dt>
          <dd>{scanDuration(s) ?? "—"}</dd>
          <dt>Commit</dt>
          <dd className={own.mono}>{s.gitHead ? s.gitHead.slice(0, 12) : "—"}</dd>
          {s.stats ? (
            <>
              <dt>Archivos listados</dt>
              <dd>{s.stats.listed}</dd>
              <dt>Hashes calculados</dt>
              <dd>{s.stats.hashed}</dd>
              <dt>Omitidos</dt>
              <dd>{s.stats.skipped}</dd>
            </>
          ) : null}
          <dt>Snapshot</dt>
          <dd>{s.snapshotId ? <span className={own.mono}>{s.snapshotId}</span> : "No generó snapshot"}</dd>
        </dl>
        {s.stats?.truncated ? <p className={own.notice}>El índice de este escaneo quedó recortado por tamaño.</p> : null}
        {s.error ? (
          <p className={own.notice} data-tone="failed" role="status">
            {s.status === "interrupted" ? "Interrumpido" : "Error"}: {s.error}
          </p>
        ) : null}
        {isScanActive(s) ? <p className={own.hint}>El escaneo sigue en curso; esta vista se actualiza con los eventos del proyecto.</p> : null}
      </section>
      {s.changes && s.stats ? <Changes changes={s.changes} totals={s.stats} /> : null}
    </div>
  );
}
