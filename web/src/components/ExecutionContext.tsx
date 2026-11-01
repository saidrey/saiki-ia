import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import type { ExecutionContextBundles, ExecutionContextSummary, ExecutionView } from "../api/types";
import { useExecutionContextBundles } from "../hooks/useProjectContext";
import { compareBundles, executionContextState, groupSources, staleReasonText } from "../model/context";
import { absoluteTime } from "../model/format";
import styles from "./ExecutionContext.module.css";

const AGENTS = [
  { id: "technical", label: "Kiro (análisis técnico)", note: "Bundle completo." },
  { id: "developer", label: "Claude (desarrollo)", note: "Subconjunto: cabecera, stack y conocimiento aprobado." },
] as const;
type AgentId = (typeof AGENTS)[number]["id"];

/** Texto congelado de cada agente en pestañas, más qué secciones recibió cada uno. */
function Bundles({ bundles }: { bundles: ExecutionContextBundles }) {
  const id = useId();
  const [agent, setAgent] = useState<AgentId>("technical");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const comparison = compareBundles(bundles.technicalBundle, bundles.developerBundle);
  const text = agent === "technical" ? bundles.technicalBundle : bundles.developerBundle;

  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + AGENTS.length) % AGENTS.length;
    setAgent(AGENTS[next].id);
    tabs.current[next]?.focus();
  }

  return (
    <div className={styles.bundles}>
      <div className={styles.tableWrap} role="region" aria-label="Tabla de secciones recibidas por cada agente" tabIndex={0}>
        <table className={styles.table}>
          <caption className={styles.caption}>Qué secciones recibió cada agente</caption>
          <thead>
            <tr>
              <th scope="col">Sección</th>
              <th scope="col">Origen</th>
              <th scope="col">Kiro</th>
              <th scope="col">Claude</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((s) => (
              <tr key={s.title}>
                <th scope="row">{s.title}</th>
                <td>{s.origin ?? "Saiki"}</td>
                <td>{s.inTechnical ? "Sí" : "No"}</td>
                <td data-missing={s.inDeveloper ? undefined : ""}>{s.inDeveloper ? "Sí" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div role="tablist" aria-label="Texto recibido por agente" className={styles.tabs}>
        {AGENTS.map((a, i) => (
          <button
            key={a.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${a.id}`}
            aria-selected={agent === a.id}
            aria-controls={`${id}-panel`}
            tabIndex={agent === a.id ? 0 : -1}
            className={styles.tab}
            onClick={() => setAgent(a.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${agent}`} className={styles.panel}>
        <p className={styles.hint}>
          {AGENTS.find((a) => a.id === agent)!.note} Texto exacto congelado el {absoluteTime(bundles.builtAt)}; {text.length} caracteres.
        </p>
        <pre className={styles.pre} tabIndex={0} aria-label={`Texto recibido por ${AGENTS.find((a) => a.id === agent)!.label}`}>
          {text}
        </pre>
      </div>
    </div>
  );
}

function Inspection({ executionId }: { executionId: string }) {
  const [open, setOpen] = useState(false);
  const q = useExecutionContextBundles(executionId, open);
  return (
    <details className={styles.disclosure} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Ver el texto que recibieron Kiro y Claude</summary>
      {!open ? null : q.isPending ? (
        <p className={styles.hint}>Cargando el contexto congelado…</p>
      ) : q.isError ? (
        <p className={styles.error} role="alert">
          {q.error instanceof ApiError && q.error.code === "integrity_failed"
            ? "El texto congelado no supera la verificación de integridad. No se reconstruye a partir del estado actual del proyecto."
            : q.error instanceof ApiError && q.error.code === "not_frozen"
              ? "Esta ejecución no tiene contexto congelado. No se reconstruye a partir del estado actual del proyecto."
              : `No se pudo cargar el contexto congelado: ${q.error.message}`}
        </p>
      ) : (
        <Bundles bundles={q.data} />
      )}
    </details>
  );
}

function Received({ view, context }: { view: ExecutionView; context: ExecutionContextSummary }) {
  const src = groupSources(context.sources);
  const excerpts = src.repoDocs.filter((d) => d.included === "excerpt").length;
  return (
    <>
      {!context.intact ? (
        <p className={styles.notice} data-tone="failed" role="status">
          El texto congelado de esta ejecución no supera la verificación de integridad.
        </p>
      ) : null}
      {context.stale ? (
        <p className={styles.notice} role="status">
          Contexto desactualizado: {staleReasonText(context.staleReason)}. Los agentes recibieron el aviso.
        </p>
      ) : null}
      <dl className={styles.facts}>
        <dt>Proyecto</dt>
        <dd>
          {view.project ? <Link to={`/projects/${encodeURIComponent(view.project.id)}`}>{view.project.name}</Link> : "No disponible"}
        </dd>
        <dt>Snapshot</dt>
        <dd>{context.snapshotId ? <span className={styles.mono}>{context.snapshotId}</span> : "Ninguno (se trabajó sin índice)"}</dd>
        <dt>Estado al congelarlo</dt>
        <dd>{context.stale ? "Desactualizado" : "Al día"}</dd>
        <dt>Congelado</dt>
        <dd>
          <time dateTime={context.builtAt}>{absoluteTime(context.builtAt)}</time>, versión {context.huVersion} de la HU
        </dd>
        <dt>Archivos seleccionados</dt>
        <dd>{context.files.length}</dd>
        <dt>Conocimiento aprobado</dt>
        <dd>
          {src.knowledge.length === 0
            ? "Ninguno"
            : src.knowledge.map((k) => `${k.title ?? k.ref} (versión ${k.version}${k.included === "title" ? ", solo título" : ""})`).join("; ")}
        </dd>
        <dt>Documentación del repositorio</dt>
        <dd>
          {src.repoDocs.length === 0 ? "Ninguna" : `${excerpts} extractos y ${src.repoDocs.length - excerpts} referencias (no aprobada en Saiki)`}
        </dd>
        {src.history.length > 0 ? (
          <>
            <dt>Ejecuciones anteriores</dt>
            <dd>{src.history.length}</dd>
          </>
        ) : null}
      </dl>
      {context.files.length > 0 ? (
        <details className={styles.disclosure}>
          <summary>Archivos seleccionados ({context.files.length})</summary>
          <div className={styles.tableWrap} role="region" aria-label="Tabla de archivos seleccionados" tabIndex={0}>
            <table className={styles.table}>
              <caption className={styles.caption}>Archivos seleccionados por coincidencia con la HU</caption>
              <thead>
                <tr>
                  <th scope="col">Ruta</th>
                  <th scope="col" className={styles.num}>
                    Puntuación
                  </th>
                  <th scope="col">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {context.files.map((f) => (
                  <tr key={f.path}>
                    <th scope="row" className={styles.mono}>
                      {f.path}
                    </th>
                    <td className={styles.num}>{f.score}</td>
                    <td>{f.reasons.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
      <Inspection executionId={view.executionId} />
    </>
  );
}

/** Sección "Contexto del proyecto" del detalle de una ejecución. Solo datos congelados. */
export function ExecutionContext({ view }: { view: ExecutionView }) {
  const state = executionContextState(view);
  return (
    <section className={styles.section} aria-labelledby="ctx-title">
      <h2 id="ctx-title" className={styles.title}>
        Contexto del proyecto
      </h2>
      {state.kind === "received" ? (
        <Received view={view} context={state.context} />
      ) : state.kind === "not_yet" ? (
        <p className={styles.hint}>Se construye y congela justo antes del análisis técnico.</p>
      ) : (
        <p className={styles.hint}>
          Esta ejecución no recibió contexto de proyecto: es anterior a Project Context o el backend no tenía índice
          configurado. Sus agentes trabajaron solo con la HU y el repositorio.
        </p>
      )}
    </section>
  );
}
