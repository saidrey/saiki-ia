import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { KnowledgeDoc, ProjectKnowledgeCategory } from "../api/types";
import { useAnalyzeProject, useProjectAnalysis, useProjectKnowledge } from "../hooks/useProjectContext";
import { absoluteTime } from "../model/format";
import {
  analysisSummary,
  CATEGORY_LABEL,
  groupDocuments,
  knowledgeErrorHint,
  labelOf,
  originLabel,
  PROJECT_CATEGORIES,
  STATUS_LABEL,
  type KnowledgeDocument,
} from "../model/knowledge";
import { useProjectOutlet } from "./ProjectPage";
import own from "./ProjectPage.module.css";

/** Error de la API con la pista de qué hacer, si la hay. */
function ErrorText({ error, prefix }: { error: unknown; prefix: string }) {
  const hint = error instanceof ApiError ? knowledgeErrorHint(error.code) : null;
  return (
    <p className={own.error} role="alert">
      {prefix}: {error instanceof Error ? error.message : String(error)}
      {hint ? ` ${hint}` : ""}
    </p>
  );
}

function ProposeForm({ projectId }: { projectId: string }) {
  const id = useId();
  const [category, setCategory] = useState<ProjectKnowledgeCategory>("conventions");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const propose = useMutation({ mutationFn: () => api.proposeProjectKnowledge(projectId, { category, title: title.trim(), content }) });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    propose.mutate(undefined, {
      onSuccess: () => {
        setTitle("");
        setContent("");
      },
    });
  }

  return (
    <details className={own.disclosure}>
      <summary>Proponer un documento</summary>
      <form className={own.knowledgeForm} onSubmit={onSubmit} aria-busy={propose.isPending}>
        <p className={own.hint}>Nace como propuesta: no llega a los agentes hasta que lo apruebes.</p>
        <div className={own.field}>
          <label htmlFor={`${id}-cat`}>Categoría</label>
          <select id={`${id}-cat`} className={own.select} value={category} onChange={(e) => setCategory(e.target.value as ProjectKnowledgeCategory)}>
            {PROJECT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className={own.field}>
          <label htmlFor={`${id}-title`}>Título</label>
          <input id={`${id}-title`} className={own.textInput} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </div>
        <div className={own.field}>
          <label htmlFor={`${id}-content`}>Contenido (Markdown)</label>
          <textarea id={`${id}-content`} className={own.textarea} value={content} onChange={(e) => setContent(e.target.value)} rows={8} />
        </div>
        {propose.error ? <ErrorText error={propose.error} prefix="No se pudo proponer" /> : null}
        <div className={own.actions}>
          <button type="submit" className={own.primary} disabled={propose.isPending || title.trim() === "" || content.trim() === ""}>
            {propose.isPending ? "Proponiendo…" : "Proponer"}
          </button>
        </div>
        {propose.isSuccess ? (
          <p className={own.hint} role="status">
            Propuesta creada. Revísala y apruébala en la lista.
          </p>
        ) : null}
      </form>
    </details>
  );
}

/** Versión propuesta pendiente: aprobar o rechazar exactamente lo que se ve. */
function PendingVersion({ doc, hasOfficial }: { doc: KnowledgeDoc; hasOfficial: boolean }) {
  const decide = useMutation({ mutationFn: (decision: "approve" | "reject") => api.decideKnowledge(doc.id, decision, doc.versionHash ?? "") });
  return (
    <section className={own.version} data-pending="" aria-label={`Versión ${doc.version ?? 1} propuesta de ${doc.title}`}>
      <h3 className={own.subTitle}>
        Versión {doc.version ?? 1} propuesta{hasOfficial ? " (sustituirá a la oficial al aprobarla)" : ""}
      </h3>
      <p className={own.hint}>
        Propuesta por {originLabel(doc.origin)} el {absoluteTime(doc.createdAt)}.
      </p>
      {doc.title ? <p className={own.strong}>{doc.title}</p> : null}
      <div className={own.docContent}>{doc.content}</div>
      {decide.error ? <ErrorText error={decide.error} prefix="No se pudo decidir" /> : null}
      <div className={own.actions}>
        <button type="button" className={own.primary} disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
          {decide.isPending && decide.variables === "approve" ? "Aprobando…" : "Aprobar esta versión"}
        </button>
        <button type="button" className={own.secondary} disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
          {decide.isPending && decide.variables === "reject" ? "Rechazando…" : "Rechazar"}
        </button>
      </div>
    </section>
  );
}

function NewVersionForm({ official, onDone }: { official: KnowledgeDoc; onDone: () => void }) {
  const id = useId();
  const [title, setTitle] = useState(official.title);
  const [content, setContent] = useState(official.content);
  const propose = useMutation({ mutationFn: () => api.proposeKnowledgeVersion(official.id, { title: title.trim(), content }) });
  const unchanged = title.trim() === official.title && content === official.content;
  return (
    <form
      className={own.knowledgeForm}
      aria-busy={propose.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        propose.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <p className={own.hint}>La versión {official.version ?? 1} sigue siendo la oficial hasta que apruebes la nueva.</p>
      <div className={own.field}>
        <label htmlFor={`${id}-title`}>Título</label>
        <input id={`${id}-title`} className={own.textInput} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>
      <div className={own.field}>
        <label htmlFor={`${id}-content`}>Contenido (Markdown)</label>
        <textarea id={`${id}-content`} className={own.textarea} value={content} onChange={(e) => setContent(e.target.value)} rows={8} />
      </div>
      {propose.error ? <ErrorText error={propose.error} prefix="No se pudo proponer la versión" /> : null}
      <div className={own.actions}>
        <button type="submit" className={own.primary} disabled={propose.isPending || unchanged || title.trim() === "" || content.trim() === ""}>
          {propose.isPending ? "Proponiendo…" : `Proponer versión ${(official.version ?? 1) + 1}`}
        </button>
        <button type="button" className={own.secondary} onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function OfficialVersion({ doc, canPropose }: { doc: KnowledgeDoc; canPropose: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archive = useMutation({ mutationFn: () => api.archiveKnowledge(doc.id) });
  return (
    <section className={own.version} aria-label={`Versión ${doc.version ?? 1} oficial de ${doc.title}`}>
      <h3 className={own.subTitle}>Versión {doc.version ?? 1} oficial</h3>
      <p className={own.hint}>Es la que reciben los agentes. Aprobada; no se edita.</p>
      <div className={own.docContent}>{doc.content}</div>
      {editing ? (
        <NewVersionForm official={doc} onDone={() => setEditing(false)} />
      ) : (
        <div className={own.actions}>
          {canPropose ? (
            <button type="button" className={own.secondary} onClick={() => setEditing(true)}>
              Proponer una versión nueva
            </button>
          ) : null}
          {confirmArchive ? (
            <>
              <button type="button" className={own.secondary} disabled={archive.isPending} onClick={() => archive.mutate()}>
                {archive.isPending ? "Archivando…" : "Confirmar: archivar (dejará de llegar a los agentes)"}
              </button>
              <button type="button" className={own.secondary} onClick={() => setConfirmArchive(false)}>
                Cancelar
              </button>
            </>
          ) : (
            <button type="button" className={own.secondary} onClick={() => setConfirmArchive(true)}>
              Archivar
            </button>
          )}
        </div>
      )}
      {archive.error ? <ErrorText error={archive.error} prefix="No se pudo archivar" /> : null}
    </section>
  );
}

function DocumentItem({ d }: { d: KnowledgeDocument }) {
  const state = d.official
    ? `Oficial: versión ${d.official.version ?? 1}${d.pending ? `; versión ${d.pending.version ?? 1} pendiente de decisión` : ""}`
    : d.pending
      ? `Sin versión oficial; versión ${d.pending.version ?? 1} pendiente de decisión`
      : "Sin versión oficial (archivado)";
  return (
    <li className={own.knowledgeItem}>
      <details>
        <summary className={own.knowledgeSummary}>
          <span className={own.strong}>{d.title}</span>
          <span className={own.hint}>{labelOf(CATEGORY_LABEL, d.category)}</span>
          <span className={own.status} data-status={d.pending ? "awaiting" : d.official ? "completed" : "none"}>
            {state}
          </span>
        </summary>
        <div className={own.knowledgeBody}>
          {d.pending ? <PendingVersion doc={d.pending} hasOfficial={d.official !== null} /> : null}
          {d.official ? <OfficialVersion doc={d.official} canPropose={d.pending === null} /> : null}
          <div className={own.tableWrap} role="region" aria-label={`Tabla de versiones de ${d.title}`} tabIndex={0}>
            <table className={own.table}>
              <caption className="visually-hidden">Versiones de {d.title}</caption>
              <thead>
                <tr>
                  <th scope="col">Versión</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Origen</th>
                  <th scope="col">Último cambio</th>
                </tr>
              </thead>
              <tbody>
                {[...d.versions].reverse().map((v) => (
                  <tr key={v.id}>
                    <th scope="row">
                      <Link to={`/knowledge/${encodeURIComponent(v.id)}`}>Versión {v.version ?? 1}</Link>
                    </th>
                    <td>{labelOf(STATUS_LABEL, v.status)}</td>
                    <td>{originLabel(v.origin)}</td>
                    <td>{absoluteTime(v.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </li>
  );
}

/** (T11) Project Analyst: un agente de solo lectura propone documentos; decides tú. */
function AnalysisPanel({ projectId }: { projectId: string }) {
  const q = useProjectAnalysis(projectId);
  const start = useAnalyzeProject(projectId);
  const a = q.data ?? null;
  const running = start.isPending || a?.status === "running";
  return (
    <section className={own.section} aria-labelledby="kb-analysis-title">
      <h2 id="kb-analysis-title" className={own.sectionTitle}>
        Análisis del proyecto
      </h2>
      <p className={own.hint}>
        Un agente en solo lectura inspecciona el repositorio a partir del último snapshot y propone hasta 6 documentos que citan
        archivos del proyecto. Las propuestas no llegan a los agentes hasta que las apruebes.
      </p>
      <div className={own.actions}>
        <button type="button" className={own.secondary} disabled={running} onClick={() => start.mutate()}>
          {running ? "Analizando…" : "Analizar el proyecto"}
        </button>
      </div>
      {start.error ? <ErrorText error={start.error} prefix="No se pudo iniciar el análisis" /> : null}
      {a ? (
        <div role="status">
          <p className={own.hint}>
            {analysisSummary(a)}
            {a.finishedAt ? ` (${absoluteTime(a.finishedAt)})` : ""}
          </p>
          {a.error ? <p className={own.error}>{a.error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Descarga el conocimiento aprobado en Markdown (lo genera el backend). */
function ExportButton({ projectId, name }: { projectId: string; name: string }) {
  const exp = useMutation({ mutationFn: () => api.exportProjectKnowledge(projectId) });
  return (
    <div className={own.field}>
      <button
        type="button"
        className={own.secondary}
        disabled={exp.isPending}
        onClick={() =>
          exp.mutate(undefined, {
            onSuccess: (r) => {
              const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `conocimiento-${name.replace(/[^\w.-]+/g, "-")}.md`;
              a.click();
              URL.revokeObjectURL(url);
            },
          })
        }
      >
        {exp.isPending ? "Preparando…" : "Descargar lo aprobado (Markdown)"}
      </button>
      {exp.error ? <ErrorText error={exp.error} prefix="No se pudo exportar" /> : null}
    </div>
  );
}

/** Pestaña "Conocimiento": documentos del proyecto, sus versiones y las decisiones pendientes. */
export function ProjectKnowledgePage() {
  const { project } = useProjectOutlet();
  const q = useProjectKnowledge(project.id);
  const docs = q.data ? groupDocuments(q.data) : [];
  const pending = docs.filter((d) => d.pending).length;

  return (
    <div className={own.panel}>
      <div className={own.titleRow}>
        <p className={own.hint}>
          Arquitectura, convenciones y decisiones de este proyecto. Solo las versiones aprobadas llegan a los agentes, con su
          número de versión; las convenciones van primero.
        </p>
        <ExportButton projectId={project.id} name={project.name} />
      </div>
      <AnalysisPanel projectId={project.id} />
      <ProposeForm projectId={project.id} />
      {q.isPending ? (
        <p className={own.hint}>Cargando conocimiento…</p>
      ) : q.isError ? (
        <p className={own.error} role="alert">
          No se pudo cargar el conocimiento: {q.error.message}
        </p>
      ) : docs.length === 0 ? (
        <p className={own.hint}>Este proyecto todavía no tiene conocimiento. Propón el primer documento.</p>
      ) : (
        <section className={own.section} aria-labelledby="kb-list-title">
          <h2 id="kb-list-title" className={own.sectionTitle}>
            Documentos ({docs.length}){pending ? `, ${pending} pendiente${pending === 1 ? "" : "s"} de decisión` : ""}
          </h2>
          <ul className={own.knowledgeList}>
            {docs.map((d) => (
              <DocumentItem key={d.documentId} d={d} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
