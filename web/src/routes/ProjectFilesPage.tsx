import { useId, useState } from "react";
import type { FileKind } from "../api/types";
import { useContextFiles } from "../hooks/useProjectContext";
import { FILE_KIND_LABEL, FILE_KINDS, formatBytes } from "../model/context";
import { absoluteTime } from "../model/format";
import { useProjectOutlet } from "./ProjectPage";
import own from "./ProjectPage.module.css";

/**
 * Pestaña "Archivos indexados": metadatos del índice (ruta, tipo, lenguaje,
 * tamaño, fecha). Sin contenido ni hashes; los secretos solo por nombre.
 */
export function ProjectFilesPage() {
  const { project, context } = useProjectOutlet();
  const id = useId();
  const [prefix, setPrefix] = useState("");
  // El prefijo se aplica al buscar (una consulta por búsqueda, no por tecla).
  const [applied, setApplied] = useState("");
  const [kind, setKind] = useState<FileKind | "">("");
  const q = useContextFiles(project.id, { prefix: applied, kind });
  const files = q.data?.pages.flatMap((p) => p.files) ?? [];

  if (!context.snapshot && context.status !== "scanning") {
    return <p className={own.hint}>Todavía no hay índice. Solicita un escaneo para generarlo.</p>;
  }

  return (
    <div className={own.panel}>
      <form className={own.filters} role="search" aria-label="Filtrar archivos indexados" onSubmit={(e) => {
          e.preventDefault();
          setApplied(prefix.trim());
        }}>
        <div className={own.field}>
          <label htmlFor={`${id}-prefix`}>Ruta empieza por</label>
          <input
            id={`${id}-prefix`}
            className={own.input}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="src/components/"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className={own.field}>
          <label htmlFor={`${id}-kind`}>Tipo</label>
          <select id={`${id}-kind`} className={own.select} value={kind} onChange={(e) => setKind(e.target.value as FileKind | "")}>
            <option value="">Todos</option>
            {FILE_KINDS.map((k) => (
              <option key={k} value={k}>
                {FILE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={own.secondary}>
          Buscar
        </button>
      </form>
      <p className={own.hint}>
        Índice del último snapshot{context.snapshot ? ` (${context.snapshot.summary.files} archivos)` : ""}. No se muestra el
        contenido de ningún archivo.
      </p>

      {q.isPending ? (
        <p className={own.hint}>Cargando archivos…</p>
      ) : q.isError ? (
        <p className={own.error} role="alert">
          No se pudo cargar el índice: {q.error.message}
        </p>
      ) : files.length === 0 ? (
        <p className={own.hint}>Ningún archivo coincide con el filtro.</p>
      ) : (
        <>
          <p className={own.hint} role="status">
            {files.length} {files.length === 1 ? "archivo" : "archivos"} mostrados{q.hasNextPage ? "; hay más" : ""}.
          </p>
          <div className={own.tableWrap} role="region" aria-label="Tabla de archivos indexados" tabIndex={0}>
            <table className={own.table}>
              <caption className="visually-hidden">Archivos indexados</caption>
              <thead>
                <tr>
                  <th scope="col">Ruta</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Lenguaje</th>
                  <th scope="col" className={own.num}>
                    Tamaño
                  </th>
                  <th scope="col">Modificado</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.path}>
                    <th scope="row" className={own.mono}>
                      {f.path}
                    </th>
                    <td>{FILE_KIND_LABEL[f.kind]}</td>
                    <td>{f.lang ?? "—"}</td>
                    <td className={own.num}>{formatBytes(f.size)}</td>
                    <td>{absoluteTime(new Date(f.mtimeMs).toISOString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage ? (
            <div>
              <button type="button" className={own.secondary} onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? "Cargando…" : "Cargar más archivos"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
