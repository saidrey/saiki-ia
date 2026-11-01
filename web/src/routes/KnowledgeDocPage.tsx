import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useKnowledgeDoc } from "../hooks/useKnowledge";
import { absoluteTime } from "../model/format";
import { CATEGORY_LABEL, labelOf, STATUS_LABEL } from "../model/knowledge";
import styles from "./Page.module.css";
import own from "./KnowledgeDocPage.module.css";

export function KnowledgeDocPage() {
  const { docId = "" } = useParams();
  const q = useKnowledgeDoc(docId);

  if (q.isPending) return <p className={styles.text}>Cargando documento…</p>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <section className={`${styles.page} ${styles.narrow}`} aria-labelledby="doc-err">
        <h1 id="doc-err" className={styles.title}>
          {notFound ? "Este documento no existe" : "No se pudo cargar el documento"}
        </h1>
        <p className={styles.text}>
          {notFound ? "Puede que la dirección sea incorrecta." : q.error.message} <Link to="/knowledge">Volver a Conocimiento</Link>.
        </p>
      </section>
    );
  }

  const d = q.data;
  return (
    <article className={styles.page} aria-labelledby="doc-title">
      <p>
        <Link to="/knowledge">Conocimiento</Link>
      </p>
      <h1 id="doc-title" className={styles.title}>
        {d.title}
      </h1>
      <dl className={own.meta}>
        <div>
          <dt>Categoría</dt>
          <dd>{labelOf(CATEGORY_LABEL, d.category)}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>
            <span className={own.status} data-status={d.status}>
              {labelOf(STATUS_LABEL, d.status)}
            </span>
          </dd>
        </div>
        {d.version !== undefined ? (
          <div>
            <dt>Versión</dt>
            <dd>{d.version}</dd>
          </div>
        ) : null}
        {d.projectId ? (
          <div>
            <dt>Proyecto</dt>
            <dd>
              <Link to={`/projects/${encodeURIComponent(d.projectId)}/knowledge`}>Conocimiento del proyecto</Link>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Origen</dt>
          <dd>{d.origin}</dd>
        </div>
        <div>
          <dt>Creado</dt>
          <dd>{absoluteTime(d.createdAt)}</dd>
        </div>
        <div>
          <dt>Actualizado</dt>
          <dd>{absoluteTime(d.updatedAt)}</dd>
        </div>
        <div>
          <dt>Identificador</dt>
          <dd className={styles.mono}>{d.id}</dd>
        </div>
        {d.supersededBy ? (
          <div>
            <dt>Reemplazado por</dt>
            <dd>
              <Link className={styles.mono} to={`/knowledge/${encodeURIComponent(d.supersededBy)}`}>
                {d.supersededBy}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className={own.content}>{d.content}</div>
    </article>
  );
}
