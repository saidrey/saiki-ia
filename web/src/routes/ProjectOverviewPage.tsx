import type { EcosystemSummary, ProjectSummary } from "../api/types";
import { useProjectOutlet } from "./ProjectPage";
import own from "./ProjectPage.module.css";

/** Lista en línea, o "—" si está vacía. */
function Inline({ items }: { items: string[] }) {
  if (items.length === 0) return <>—</>;
  return (
    <ul className={own.inlineList}>
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function Ecosystem({ e, index }: { e: EcosystemSummary; index: number }) {
  const direct = e.dependencies.filter((d) => !d.dev);
  const dev = e.dependencies.filter((d) => d.dev);
  const titleId = `eco-${index}`;
  return (
    <section className={own.ecosystem} aria-labelledby={titleId}>
      <h3 id={titleId} className={own.subTitle}>
        {e.name ?? e.kind} <span className={own.hint}>({e.kind}{e.manifest ? `, ${e.manifest}` : ""})</span>
      </h3>
      <dl className={own.facts}>
        {e.version ? (
          <>
            <dt>Versión</dt>
            <dd>{e.version}</dd>
          </>
        ) : null}
        <dt>Frameworks</dt>
        <dd>
          <Inline items={e.frameworks.map((f) => (f.version ? `${f.name} ${f.version}` : f.name))} />
        </dd>
        <dt>Gestor de paquetes</dt>
        <dd>{e.packageManager ?? "—"}</dd>
        <dt>Pruebas</dt>
        <dd>
          <Inline items={e.testFrameworks} />
        </dd>
        <dt>Herramientas</dt>
        <dd>
          <Inline items={e.tools} />
        </dd>
        <dt>Puntos de entrada</dt>
        <dd className={own.mono}>
          <Inline items={e.entryPoints.map((p) => p.path)} />
        </dd>
        <dt>Código en</dt>
        <dd className={own.mono}>
          <Inline items={e.sourceRoots} />
        </dd>
      </dl>

      {e.scripts.length > 0 ? (
        <div className={own.tableWrap} role="region" aria-label={`Tabla de scripts de ${e.name ?? e.kind}`} tabIndex={0}>
          <table className={own.table}>
            <caption className="visually-hidden">Scripts de {e.name ?? e.kind}</caption>
            <thead>
              <tr>
                <th scope="col">Script</th>
                <th scope="col">Comando</th>
              </tr>
            </thead>
            <tbody>
              {e.scripts.map((s) => (
                <tr key={s.name}>
                  <th scope="row" className={own.mono}>
                    {s.name}
                  </th>
                  <td className={own.mono}>{s.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {e.dependencies.length > 0 ? (
        <details className={own.disclosure}>
          <summary>
            Dependencias: {direct.length} de ejecución, {dev.length} de desarrollo
            {e.dependenciesTruncated ? " (lista recortada)" : ""}
          </summary>
          <div className={own.tableWrap} role="region" aria-label={`Tabla de dependencias de ${e.name ?? e.kind}`} tabIndex={0}>
            <table className={own.table}>
              <caption className="visually-hidden">Dependencias de {e.name ?? e.kind}</caption>
              <thead>
                <tr>
                  <th scope="col">Paquete</th>
                  <th scope="col">Versión declarada</th>
                  <th scope="col">Versión resuelta</th>
                  <th scope="col">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {e.dependencies.map((d) => (
                  <tr key={`${d.dev ? "d" : "r"}:${d.name}`}>
                    <th scope="row" className={own.mono}>
                      {d.name}
                    </th>
                    <td className={own.mono}>{d.spec}</td>
                    <td className={own.mono}>{d.resolved ?? "—"}</td>
                    <td>{d.dev ? "Desarrollo" : "Ejecución"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Summary({ summary }: { summary: ProjectSummary }) {
  const modules = [...summary.modules].sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
  return (
    <>
      <section className={own.section} aria-labelledby="langs-title">
        <h2 id="langs-title" className={own.sectionTitle}>
          Lenguajes y pruebas
        </h2>
        <dl className={own.facts}>
          <dt>Lenguajes</dt>
          <dd>
            <Inline items={summary.languages.map((l) => `${l.lang} (${l.files})`)} />
          </dd>
          <dt>Pruebas</dt>
          <dd>
            {summary.tests.files} {summary.tests.files === 1 ? "archivo" : "archivos"}{summary.tests.frameworks.length ? ` (${summary.tests.frameworks.join(", ")})` : ""}
          </dd>
          <dt>Configuración</dt>
          <dd className={own.mono}>
            <Inline items={summary.configFiles} />
          </dd>
        </dl>
        {summary.truncated ? (
          <p className={own.notice} role="status">
            El índice está recortado por tamaño: hay archivos del repositorio que no se indexaron.
          </p>
        ) : null}
      </section>

      <section className={own.section} aria-labelledby="eco-title">
        <h2 id="eco-title" className={own.sectionTitle}>
          Stack
        </h2>
        {summary.ecosystems.length === 0 ? (
          <p className={own.hint}>No se reconoció ningún ecosistema (no hay manifiestos conocidos).</p>
        ) : (
          summary.ecosystems.map((e, i) => <Ecosystem key={`${e.kind}:${e.root}`} e={e} index={i} />)
        )}
      </section>

      <section className={own.section} aria-labelledby="mod-title">
        <h2 id="mod-title" className={own.sectionTitle}>
          Módulos
        </h2>
        <p className={own.hint}>Directorios de primer nivel con código.{summary.modulesTruncated ? " Lista recortada." : ""}</p>
        {modules.length === 0 ? (
          <p className={own.hint}>Sin módulos detectados.</p>
        ) : (
          <div className={own.tableWrap} role="region" aria-label="Tabla de módulos" tabIndex={0}>
            <table className={own.table}>
              <caption className="visually-hidden">Módulos</caption>
              <thead>
                <tr>
                  <th scope="col">Ruta</th>
                  <th scope="col" className={own.num}>
                    Archivos
                  </th>
                  <th scope="col" className={own.num}>
                    Pruebas
                  </th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m.path}>
                    <th scope="row" className={own.mono}>
                      {m.path}/
                    </th>
                    <td className={own.num}>{m.files}</td>
                    <td className={own.num}>{m.tests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {summary.warnings.length > 0 ? (
        <section className={own.section} aria-labelledby="warn-title">
          <h2 id="warn-title" className={own.sectionTitle}>
            Avisos de extracción
          </h2>
          <ul className={own.inlineColumn}>
            {summary.warnings.map((w) => (
              <li key={`${w.path}:${w.message}`}>
                <span className={own.mono}>{w.path}</span>: {w.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** Pestaña "Resumen técnico": del último snapshot (inmutable). */
export function ProjectOverviewPage() {
  const { context } = useProjectOutlet();
  return (
    <div className={own.panel}>
      {context.snapshot ? (
        <Summary summary={context.snapshot.summary} />
      ) : (
        <p className={own.hint}>
          {context.status === "scanning"
            ? "El resumen técnico aparecerá al terminar el primer escaneo."
            : "Todavía no hay resumen técnico. Solicita un escaneo para generar el primer snapshot."}
        </p>
      )}
    </div>
  );
}
