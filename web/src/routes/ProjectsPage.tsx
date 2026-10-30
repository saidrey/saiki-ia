import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import type { ApplyMode, Project } from "../api/types";
import { useProjectHistory, useProjects, useRegisterProject, useSetProjectActive, useUpdateProject } from "../hooks/useProjects";
import { absoluteTime, relativeTime } from "../model/format";
import { APPLY_MODE_HINT, APPLY_MODE_LABEL, fieldOfError, HEALTH_LABEL, historyText, type ProjectField } from "../model/projects";
import styles from "./Page.module.css";
import own from "./ProjectsPage.module.css";

/** Error de la API agrupado por campo del formulario (o general). */
function errorByField(err: unknown): Partial<Record<ProjectField | "form", string>> {
  if (!err) return {};
  if (err instanceof ApiError) return { [fieldOfError(err.code) ?? "form"]: err.message };
  return { form: err instanceof Error ? err.message : String(err) };
}

/** Modo de aplicación: sandbox por defecto; real exige marcar la confirmación. */
function ApplyModeChoice({
  mode,
  onMode,
  confirmed,
  onConfirmed,
  error,
  idPrefix,
}: {
  mode: ApplyMode;
  onMode: (m: ApplyMode) => void;
  confirmed: boolean;
  onConfirmed: (v: boolean) => void;
  error?: string;
  idPrefix: string;
}) {
  return (
    <fieldset className={own.fieldset} aria-describedby={error ? `${idPrefix}-mode-err` : undefined}>
      <legend className={own.label}>Modo de aplicación</legend>
      {(["sandbox", "real"] as const).map((m) => (
        <label key={m} className={own.radio}>
          <input type="radio" name={`${idPrefix}-mode`} value={m} checked={mode === m} onChange={() => onMode(m)} />
          <span>
            <span className={own.radioTitle}>{APPLY_MODE_LABEL[m]}</span>
            <span className={own.hint}>{APPLY_MODE_HINT[m]}</span>
          </span>
        </label>
      ))}
      {mode === "real" ? (
        <label className={own.confirm}>
          <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} />
          <span>Confirmo que las propuestas que apruebe se escribirán directamente en este repositorio.</span>
        </label>
      ) : null}
      {error ? (
        <p id={`${idPrefix}-mode-err`} className={own.fieldError}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function RegisterForm() {
  const id = useId();
  const register = useRegisterProject();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<ApplyMode>("sandbox");
  const [confirmed, setConfirmed] = useState(false);
  const errors = errorByField(register.error);
  // Un error se refiere a lo enviado: al editar, deja de valer.
  const edited = <T,>(set: (v: T) => void) => (v: T) => {
    if (register.error || register.isSuccess) register.reset();
    set(v);
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    register.mutate(
      { name: name.trim(), path: path.trim(), applyMode: mode, ...(mode === "real" ? { confirmRealApply: confirmed } : {}) },
      {
        onSuccess: () => {
          setName("");
          setPath("");
          setMode("sandbox");
          setConfirmed(false);
        },
      },
    );
  }

  return (
    <form className={own.panel} onSubmit={onSubmit} aria-labelledby={`${id}-title`} aria-busy={register.isPending}>
      <h2 id={`${id}-title`} className={styles.heading}>
        Registrar un proyecto
      </h2>
      <div className={own.field}>
        <label htmlFor={`${id}-name`} className={own.label}>
          Nombre
        </label>
        <input
          id={`${id}-name`}
          className={own.input}
          value={name}
          onChange={(e) => edited(setName)(e.target.value)}
          maxLength={80}
          autoComplete="off"
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${id}-name-err` : undefined}
        />
        {errors.name ? (
          <p id={`${id}-name-err`} className={own.fieldError}>
            {errors.name}
          </p>
        ) : null}
      </div>
      <div className={own.field}>
        <label htmlFor={`${id}-path`} className={own.label}>
          Ruta del repositorio
        </label>
        <p id={`${id}-path-hint`} className={own.hint}>
          Ruta absoluta a la raíz de un repositorio git en este equipo. La comprueba el backend; no se podrá cambiar después.
        </p>
        <input
          id={`${id}-path`}
          className={`${own.input} ${own.mono}`}
          value={path}
          onChange={(e) => edited(setPath)(e.target.value)}
          placeholder="/Users/tu-usuario/proyectos/mi-app"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={errors.path ? true : undefined}
          aria-describedby={`${id}-path-hint${errors.path ? ` ${id}-path-err` : ""}`}
        />
        {errors.path ? (
          <p id={`${id}-path-err`} className={own.fieldError}>
            {errors.path}
          </p>
        ) : null}
      </div>
      <ApplyModeChoice
        mode={mode}
        onMode={edited(setMode)}
        confirmed={confirmed}
        onConfirmed={edited(setConfirmed)}
        error={errors.applyMode}
        idPrefix={id}
      />
      {errors.form ? (
        <p className={own.fieldError} role="alert">
          No se pudo registrar: {errors.form}
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className={own.primary}
          disabled={register.isPending || name.trim() === "" || path.trim() === "" || (mode === "real" && !confirmed)}
        >
          {register.isPending ? "Registrando…" : "Registrar proyecto"}
        </button>
      </div>
      {register.isSuccess ? (
        <p className={own.success} role="status">
          Proyecto "{register.data.project.name}" registrado.
        </p>
      ) : null}
    </form>
  );
}

function History({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const q = useProjectHistory(project.id, open);
  return (
    <details className={own.history} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Historial de cambios</summary>
      {q.isPending ? (
        <p className={own.hint}>Cargando…</p>
      ) : q.isError ? (
        <p className={own.fieldError}>No se pudo cargar el historial: {q.error.message}</p>
      ) : (
        <ol className={own.historyList}>
          {q.data.map((e) => (
            <li key={e.id}>
              <span>{historyText(e)}</span>
              <span className={own.hint}>
                {e.actor},{" "}
                <time dateTime={e.at} title={absoluteTime(e.at)}>
                  {relativeTime(e.at)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function ProjectItem({ project }: { project: Project }) {
  const id = useId();
  const update = useUpdateProject(project.id);
  const setActive = useSetProjectActive(project.id);
  const [editing, setEditing] = useState<"name" | "mode" | null>(null);
  const [name, setName] = useState(project.name);
  const [mode, setMode] = useState<ApplyMode>(project.applyMode);
  const [confirmed, setConfirmed] = useState(false);
  const errors = errorByField(update.error);
  const active = project.status === "active";
  const healthy = project.health === "ok";

  function close() {
    setEditing(null);
    update.reset();
  }
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body =
      editing === "name"
        ? { name: name.trim() }
        : { applyMode: mode, ...(mode === "real" ? { confirmRealApply: confirmed } : {}) };
    update.mutate(body, { onSuccess: () => setEditing(null) });
  }

  return (
    <li className={own.item} aria-labelledby={`${id}-name`}>
      <div className={own.itemHead}>
        <h3 id={`${id}-name`} className={own.itemName}>
          {project.name}
        </h3>
        <span className={own.health} data-ok={healthy ? "" : undefined}>
          {HEALTH_LABEL[project.health]}
        </span>
        {active ? null : <span className={own.inactive}>Desactivado</span>}
      </div>
      <p className={own.mono}>{project.rootPath}</p>
      {project.healthDetail ? <p className={own.fieldError}>{project.healthDetail}</p> : null}
      <p className={own.hint}>
        Modo de aplicación: <span className={own.strong}>{APPLY_MODE_LABEL[project.applyMode]}</span>. Registrado{" "}
        <time dateTime={project.createdAt} title={absoluteTime(project.createdAt)}>
          {relativeTime(project.createdAt)}
        </time>
        .
      </p>

      {editing ? (
        <form className={own.inlineForm} onSubmit={save} aria-busy={update.isPending}>
          {editing === "name" ? (
            <div className={own.field}>
              <label htmlFor={`${id}-rename`} className={own.label}>
                Nuevo nombre
              </label>
              <input
                id={`${id}-rename`}
                className={own.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${id}-rename-err` : undefined}
              />
              {errors.name ? (
                <p id={`${id}-rename-err`} className={own.fieldError}>
                  {errors.name}
                </p>
              ) : null}
            </div>
          ) : (
            <ApplyModeChoice
              mode={mode}
              onMode={setMode}
              confirmed={confirmed}
              onConfirmed={setConfirmed}
              error={errors.applyMode}
              idPrefix={id}
            />
          )}
          {errors.form ? <p className={own.fieldError}>{errors.form}</p> : null}
          <p className={own.hint}>Las ejecuciones ya iniciadas conservan el nombre y el modo con los que empezaron.</p>
          <div className={own.actions}>
            <button
              type="submit"
              className={own.primary}
              disabled={update.isPending || (editing === "name" ? name.trim() === "" : mode === "real" && !confirmed)}
            >
              {update.isPending ? "Guardando…" : "Guardar"}
            </button>
            <button type="button" className={own.secondary} onClick={close}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className={own.actions}>
          <button
            type="button"
            className={own.secondary}
            onClick={() => {
              setName(project.name);
              setEditing("name");
            }}
          >
            Renombrar
          </button>
          <button
            type="button"
            className={own.secondary}
            onClick={() => {
              setMode(project.applyMode);
              setConfirmed(false);
              setEditing("mode");
            }}
          >
            Cambiar modo de aplicación
          </button>
          <button type="button" className={own.secondary} onClick={() => setActive.mutate(!active)} disabled={setActive.isPending}>
            {active ? "Desactivar" : "Activar"}
          </button>
        </div>
      )}
      {setActive.error ? (
        <p className={own.fieldError} role="alert">
          {setActive.error.message}
        </p>
      ) : null}
      <History project={project} />
    </li>
  );
}

export function ProjectsPage() {
  const q = useProjects();
  const active = (q.data ?? []).filter((p) => p.status === "active");
  const inactive = (q.data ?? []).filter((p) => p.status === "inactive");

  return (
    <div className={`${styles.page} ${own.page}`}>
      <header className={own.header}>
        <h1 className={styles.title}>Proyectos</h1>
        <p className={styles.text}>
          Repositorios de este equipo sobre los que Saiki-IA puede trabajar. Cada sesión de desarrollo pertenece a un proyecto y
          cada ejecución queda ligada al repositorio con el que empezó.
        </p>
      </header>

      <RegisterForm />

      {q.isPending ? (
        <p className={styles.text}>Cargando proyectos…</p>
      ) : q.isError ? (
        <p className={styles.error} role="alert">
          No se pudieron cargar los proyectos: {q.error.message}
        </p>
      ) : (
        <>
          <section aria-labelledby="active-title" className={own.section}>
            <h2 id="active-title" className={styles.heading}>
              Activos ({active.length})
            </h2>
            {active.length > 0 ? (
              <ul className={own.list}>
                {active.map((p) => (
                  <ProjectItem key={p.id} project={p} />
                ))}
              </ul>
            ) : (
              <p className={styles.text}>Todavía no hay proyectos activos. Registra el primero arriba.</p>
            )}
          </section>
          {inactive.length > 0 ? (
            <section aria-labelledby="inactive-title" className={own.section}>
              <h2 id="inactive-title" className={styles.heading}>
                Desactivados ({inactive.length})
              </h2>
              <p className={styles.text}>No admiten sesiones nuevas ni aplicar cambios. Se conservan por trazabilidad.</p>
              <ul className={own.list}>
                {inactive.map((p) => (
                  <ProjectItem key={p.id} project={p} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
