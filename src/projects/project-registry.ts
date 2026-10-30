import { randomUUID } from "node:crypto";
import type {
  ApplyMode,
  CoreStore,
  ProjectHistoryAction,
  ProjectHistoryRecord,
  ProjectRecord,
  ProjectStatus,
} from "../core/core-store.js";
import { checkProjectHealth, isWithin, validateProjectPath, type PathErrorCode, type ProjectHealth } from "./project-fs.js";

/**
 * (Project Registry) Registro de proyectos locales.
 *
 * Reglas:
 *  - Solo el humano lo administra (a través de la API). Ningún agente, ni el
 *    moderador ni el grafo, tiene acceso a estas operaciones.
 *  - La ruta se guarda como `realpath` y es inmutable: mover un repositorio es
 *    registrar un proyecto nuevo (D2).
 *  - No hay borrado: desactivar conserva la trazabilidad.
 *  - Cada cambio deja una entrada inmutable en `project_history` con actor y fecha (D7).
 */

export type ProjectErrorCode =
  | PathErrorCode
  | "invalid_name"
  | "invalid_apply_mode"
  | "confirmation_required"
  | "already_registered"
  | "nested_project"
  | "name_taken"
  | "not_found"
  | "project_unhealthy"
  | "has_active_executions";

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  status: ProjectStatus;
  applyMode: ApplyMode;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  health: ProjectHealth;
  healthDetail?: string;
}

export type ProjectResult =
  | { ok: true; project: ProjectView }
  | { ok: false; code: ProjectErrorCode; message: string; projectId?: string };

export interface RegisterInput {
  name?: unknown;
  path?: unknown;
  applyMode?: unknown;
  confirmRealApply?: unknown;
}

export interface UpdateInput {
  name?: unknown;
  applyMode?: unknown;
  confirmRealApply?: unknown;
}

export interface ProjectRegistryOptions {
  /** Directorio de datos de Saiki-IA (no registrable). */
  dataDir: string;
  now?: () => string;
}

const MAX_NAME = 80;

function fail(code: ProjectErrorCode, message: string, projectId?: string): ProjectResult {
  return projectId ? { ok: false, code, message, projectId } : { ok: false, code, message };
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  return name.length === 0 || name.length > MAX_NAME || /[\u0000-\u001f]/.test(name) ? null : name;
}

/** `real` exige `confirmRealApply: true` explícito; cualquier otro valor que no sea `sandbox` es inválido. */
function parseApplyMode(raw: unknown, confirm: unknown): { ok: true; mode: ApplyMode } | { ok: false; result: ProjectResult } {
  if (raw === undefined || raw === "sandbox") return { ok: true, mode: "sandbox" };
  if (raw !== "real") return { ok: false, result: fail("invalid_apply_mode", 'El modo de aplicación debe ser "sandbox" o "real".') };
  if (confirm !== true) {
    return {
      ok: false,
      result: fail("confirmation_required", "Aplicar sobre el repositorio real exige confirmarlo explícitamente (confirmRealApply: true)."),
    };
  }
  return { ok: true, mode: "real" };
}

export class ProjectRegistry {
  private readonly now: () => string;

  constructor(
    private readonly store: CoreStore,
    private readonly options: ProjectRegistryOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Registro crudo (con huella), para la vinculación y la guardia de aplicación. */
  record(id: string): ProjectRecord | null {
    return this.store.getProject(id);
  }

  view(p: ProjectRecord): ProjectView {
    const { health, detail } = checkProjectHealth(p.rootPath, p.fingerprint);
    const { fingerprint: _fp, ...rest } = p;
    return detail ? { ...rest, health, healthDetail: detail } : { ...rest, health };
  }

  list(status?: ProjectStatus): ProjectView[] {
    return this.store
      .listProjects()
      .filter((p) => status === undefined || p.status === status)
      .map((p) => this.view(p));
  }

  get(id: string): ProjectView | null {
    const p = this.store.getProject(id);
    return p ? this.view(p) : null;
  }

  history(id: string): ProjectHistoryRecord[] {
    return this.store.listProjectHistory(id);
  }

  register(input: RegisterInput, actor: string): ProjectResult {
    const name = normalizeName(input.name);
    if (name === null) return fail("invalid_name", `El nombre es obligatorio (máximo ${MAX_NAME} caracteres).`);
    const mode = parseApplyMode(input.applyMode, input.confirmRealApply);
    if (!mode.ok) return mode.result;

    const v = validateProjectPath(input.path, { dataDir: this.options.dataDir, requireWritable: mode.mode === "real" });
    if (!v.ok) return fail(v.code, v.message);

    const all = this.store.listProjects();
    const dup = all.find((p) => p.rootPath === v.rootPath || p.fingerprint.gitDir === v.fingerprint.gitDir);
    if (dup) {
      return fail(
        "already_registered",
        dup.status === "active"
          ? `Ese repositorio ya está registrado como "${dup.name}".`
          : `Ese repositorio ya está registrado como "${dup.name}" (inactivo): actívalo en lugar de registrarlo otra vez.`,
        dup.id,
      );
    }
    const conflict = this.nestingConflict(v.rootPath, all);
    if (conflict) return conflict;
    if (this.nameTaken(name, all)) return fail("name_taken", `Ya hay un proyecto activo llamado "${name}".`);

    const at = this.now();
    const project: ProjectRecord = {
      id: `prj-${randomUUID()}`,
      name,
      rootPath: v.rootPath,
      status: "active",
      applyMode: mode.mode,
      fingerprint: v.fingerprint,
      createdAt: at,
      updatedAt: at,
      deactivatedAt: null,
    };
    this.store.insertProject(
      project,
      this.entry(project.id, "registered", actor, at, {
        name,
        rootPath: v.rootPath,
        applyMode: mode.mode,
        ...(v.resolvedFromSymlink ? { requestedPath: input.path } : {}),
      }),
    );
    return { ok: true, project: this.view(project) };
  }

  /** Renombrar y/o cambiar el modo de aplicación. La ruta no se edita (D2). */
  update(id: string, input: UpdateInput, actor: string): ProjectResult {
    const current = this.store.getProject(id);
    if (!current) return fail("not_found", "El proyecto no existe.");
    let next = { ...current };
    const changes: Array<[ProjectHistoryAction, Record<string, unknown>]> = [];

    if (input.name !== undefined) {
      const name = normalizeName(input.name);
      if (name === null) return fail("invalid_name", `El nombre es obligatorio (máximo ${MAX_NAME} caracteres).`);
      if (name !== current.name) {
        if (current.status === "active" && this.nameTaken(name, this.store.listProjects(), id)) {
          return fail("name_taken", `Ya hay un proyecto activo llamado "${name}".`);
        }
        next = { ...next, name };
        changes.push(["renamed", { from: current.name, to: name }]);
      }
    }
    if (input.applyMode !== undefined && input.applyMode !== current.applyMode) {
      const mode = parseApplyMode(input.applyMode, input.confirmRealApply);
      if (!mode.ok) return mode.result;
      if (mode.mode !== current.applyMode) {
        next = { ...next, applyMode: mode.mode };
        changes.push(["apply_mode_changed", { from: current.applyMode, to: mode.mode }]);
      }
    }
    return this.commit(next, changes, actor);
  }

  /** D5: se permite aunque haya ejecuciones pausadas; la guardia bloqueará sus aplicaciones. */
  deactivate(id: string, actor: string): ProjectResult {
    const current = this.store.getProject(id);
    if (!current) return fail("not_found", "El proyecto no existe.");
    if (current.status === "inactive") return { ok: true, project: this.view(current) };
    const at = this.now();
    return this.commit({ ...current, status: "inactive", deactivatedAt: at }, [["deactivated", {}]], actor, at);
  }

  /** Reactivar exige que el repositorio siga sano y que no choque con otro proyecto activo. */
  activate(id: string, actor: string): ProjectResult {
    const current = this.store.getProject(id);
    if (!current) return fail("not_found", "El proyecto no existe.");
    if (current.status === "active") return { ok: true, project: this.view(current) };
    const { health, detail } = checkProjectHealth(current.rootPath, current.fingerprint);
    if (health !== "ok") {
      return fail("project_unhealthy", `No se puede activar: ${detail ?? health}. Registra la ruta actual como proyecto nuevo.`);
    }
    const all = this.store.listProjects();
    const conflict = this.nestingConflict(current.rootPath, all, id);
    if (conflict) return conflict;
    if (this.nameTaken(current.name, all, id)) {
      return fail("name_taken", `Ya hay un proyecto activo llamado "${current.name}": renombra uno de los dos.`);
    }
    return this.commit({ ...current, status: "active", deactivatedAt: null }, [["reactivated", {}]], actor);
  }

  private commit(
    next: ProjectRecord,
    changes: Array<[ProjectHistoryAction, Record<string, unknown>]>,
    actor: string,
    at: string = this.now(),
  ): ProjectResult {
    if (changes.length === 0) return { ok: true, project: this.view(next) };
    const updated = { ...next, updatedAt: at };
    // Una entrada de historial por cambio, en la misma transacción que la actualización.
    this.store.updateProject(
      updated,
      changes.map(([action, details]) => this.entry(updated.id, action, actor, at, details)),
    );
    return { ok: true, project: this.view(updated) };
  }

  /** Un proyecto activo no puede contener a otro ni estar dentro de otro. */
  private nestingConflict(rootPath: string, all: ProjectRecord[], exceptId?: string): ProjectResult | null {
    const other = all.find(
      (p) => p.id !== exceptId && p.status === "active" && (isWithin(rootPath, p.rootPath) || isWithin(p.rootPath, rootPath)),
    );
    return other
      ? fail("nested_project", `La ruta está dentro de "${other.name}" o lo contiene; los proyectos no pueden anidarse.`, other.id)
      : null;
  }

  private nameTaken(name: string, all: ProjectRecord[], exceptId?: string): boolean {
    return all.some((p) => p.id !== exceptId && p.status === "active" && p.name.toLowerCase() === name.toLowerCase());
  }

  private entry(
    projectId: string,
    action: ProjectHistoryAction,
    actor: string,
    at: string,
    details: Record<string, unknown>,
  ): ProjectHistoryRecord {
    return { id: randomUUID(), projectId, action, actor, at, details };
  }
}
