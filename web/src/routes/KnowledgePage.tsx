import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useKnowledgeSearch } from "../hooks/useKnowledge";
import { absoluteTime, relativeTime } from "../model/format";
import { CATEGORY_LABEL, labelOf, STATUS_LABEL, validFilter } from "../model/knowledge";
import styles from "./Page.module.css";
import own from "./KnowledgePage.module.css";

/** Consulta de la Knowledge Base (solo lectura). Filtros en la URL para poder enlazarlos. */
export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const category = validFilter(CATEGORY_LABEL, params.get("category"));
  const status = validFilter(STATUS_LABEL, params.get("status"));
  const [text, setText] = useState(query);
  const q = useKnowledgeSearch({ query, category, status });
  const filtered = query !== "" || category !== "" || status !== "";

  const setFilter = (key: string, value: string) =>
    setParams((p) => {
      if (value) p.set(key, value);
      else p.delete(key);
      return p;
    });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFilter("q", text.trim());
  }

  return (
    <section className={styles.page} aria-labelledby="kb-title">
      <header className={own.header}>
        <h1 id="kb-title" className={styles.title}>
          Conocimiento
        </h1>
        <p className={styles.text}>
          Documentos de la Knowledge Base de Saiki-IA. Solo consulta: promover o editar conocimiento no está disponible en la API.
        </p>
      </header>

      <form className={own.filters} onSubmit={onSubmit} role="search" aria-label="Buscar en la Knowledge Base">
        <div className={own.field}>
          <label htmlFor="kb-q">Texto</label>
          <div className={own.searchRow}>
            <input id="kb-q" type="search" value={text} onChange={(e) => setText(e.target.value)} className={own.input} />
            <button type="submit" className={own.button}>
              Buscar
            </button>
          </div>
        </div>
        <div className={own.field}>
          <label htmlFor="kb-cat">Categoría</label>
          <select id="kb-cat" value={category} onChange={(e) => setFilter("category", e.target.value)} className={own.input}>
            <option value="">Todas</option>
            {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className={own.field}>
          <label htmlFor="kb-status">Estado</label>
          <select id="kb-status" value={status} onChange={(e) => setFilter("status", e.target.value)} className={own.input}>
            <option value="">Todos</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </form>
      <p className={styles.text}>Búsqueda por texto en título y contenido. Hasta 50 documentos, los más recientes primero.</p>

      <div aria-live="polite" aria-busy={q.isFetching}>
        {q.isPending ? (
          <p className={styles.text}>Cargando documentos…</p>
        ) : q.isError ? (
          <p className={styles.error} role="alert">
            No se pudo consultar la Knowledge Base: {q.error.message}
          </p>
        ) : q.data.length === 0 ? (
          <p className={styles.text}>
            {filtered ? "Ningún documento coincide con estos filtros." : "La Knowledge Base todavía no tiene documentos."}
          </p>
        ) : (
          <>
            <p className={styles.text}>
              {q.data.length} {q.data.length === 1 ? "documento" : "documentos"}
              {q.isPlaceholderData ? ". Actualizando…" : "."}
            </p>
            <ul className={own.list}>
              {q.data.map((d) => (
                <li key={d.id} className={own.item}>
                  <Link to={`/knowledge/${encodeURIComponent(d.id)}`} className={own.link}>
                    <span className={own.docTitle}>{d.title}</span>
                    <span className={own.meta}>
                      <span>{labelOf(CATEGORY_LABEL, d.category)}</span>
                      <span className={own.status} data-status={d.status}>
                        {labelOf(STATUS_LABEL, d.status)}
                      </span>
                      <span>Origen: {d.origin}</span>
                      <time dateTime={d.updatedAt} title={absoluteTime(d.updatedAt)}>
                        Actualizado {relativeTime(d.updatedAt)}
                      </time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
