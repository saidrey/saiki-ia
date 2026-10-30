import type { ApplyMode, ExecutionView, ModeratorSession, Project, ProjectHealth, ProjectHistoryEntry } from "../api/types";

/**
 * Presentación del registro de proyectos. Todo lo calcula el backend (salud,
 * estado, copia de la ejecución); aquí solo se traduce a texto y se decide qué
 * avisar. El frontend nunca lee rutas ni el sistema de archivos.
 */

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  ok: "Disponible",
  missing: "No existe",
  moved: "Movido o sustituido",
  not_a_repository: "Sin repositorio git",
  not_accessible: "Sin acceso",
};

export const APPLY_MODE_LABEL: Record<ApplyMode, string> = {
  sandbox: "Sandbox",
  real: "Repositorio real",
};

export const APPLY_MODE_HINT: Record<ApplyMode, string> = {
  sandbox: "Cada ejecución aplica en una copia propia del repositorio; el repositorio no cambia.",
  real: "Las propuestas aprobadas se escriben directamente en el repositorio.",
};

/** Se puede iniciar una sesión de desarrollo con él. */
export function isSelectable(p: Project): boolean {
  return p.status === "active" && p.health === "ok";
}

/** Por qué un proyecto no se puede elegir, o null. */
export function unavailableReason(p: Project): string | null {
  if (p.status !== "active") return "desactivado";
  if (p.health !== "ok") return HEALTH_LABEL[p.health].toLowerCase();
  return null;
}

export type ProjectField = "name" | "path" | "applyMode";

/** Campo del formulario al que pertenece un error de la API (para mostrarlo junto a él). */
export function fieldOfError(code: string): ProjectField | null {
  switch (code) {
    case "invalid_name":
    case "name_taken":
      return "name";
    case "invalid_path":
    case "not_accessible":
    case "not_a_repository":
    case "sensitive_path":
    case "already_registered":
    case "nested_project":
    case "path_immutable":
      return "path";
    case "confirmation_required":
    case "invalid_apply_mode":
      return "applyMode";
    default:
      return null;
  }
}

/** Nombre del proyecto de una sesión para mostrarlo en listas y cabeceras. */
export function sessionProjectLabel(session: Pick<ModeratorSession, "projectId">, projects: Map<string, Project> | undefined): string {
  if (!session.projectId) return "Sin proyecto";
  return projects?.get(session.projectId)?.name ?? "Proyecto";
}

/** Dónde se aplicará una propuesta de esta ejecución (gana el modo más restrictivo). */
export function applyDestination(view: Pick<ExecutionView, "project">): { mode: ApplyMode; text: string } | null {
  const p = view.project;
  if (!p) return null;
  const real = p.applyMode === "real" && p.current?.applyMode === "real";
  return real
    ? { mode: "real", text: `Se aplicará directamente en el repositorio ${p.rootPath}.` }
    : { mode: "sandbox", text: `Se aplicará en un sandbox propio de esta ejecución (copia de ${p.rootPath}). El repositorio no cambia.` };
}

export interface ProjectNotice {
  /** `blocked`: aplicar se bloqueará. `info`: dato a tener en cuenta. */
  tone: "blocked" | "info";
  text: string;
}

/** Avisos sobre el proyecto de una ejecución: si aplicar se bloqueará y por qué. */
export function executionProjectNotices(view: Pick<ExecutionView, "project">): ProjectNotice[] {
  const p = view.project;
  if (p === undefined) return [];
  if (p === null) {
    return [
      {
        tone: "blocked",
        text: "Ejecución anterior al registro de proyectos: no consta en qué repositorio debe trabajar. Solo puede rechazarse; para continuar, repite la solicitud en una sesión con proyecto.",
      },
    ];
  }
  const out: ProjectNotice[] = [];
  const now = p.current;
  if (now === null) {
    out.push({ tone: "blocked", text: "El proyecto ya no está en el registro: aplicar se bloqueará." });
    return out;
  }
  if (now.status !== "active") out.push({ tone: "blocked", text: `El proyecto "${now.name}" está desactivado: aplicar se bloqueará.` });
  if (now.health !== "ok") {
    out.push({
      tone: "blocked",
      text: `Repositorio ${HEALTH_LABEL[now.health].toLowerCase()}${now.healthDetail ? ` (${now.healthDetail})` : ""}: aplicar se bloqueará.`,
    });
  }
  if (now.name !== p.name) out.push({ tone: "info", text: `El proyecto se llama ahora "${now.name}".` });
  return out;
}

/** Una línea del historial del registro. */
export function historyText(e: ProjectHistoryEntry): string {
  const d = e.details;
  switch (e.action) {
    case "registered":
      return "Registrado";
    case "renamed":
      return `Renombrado de "${String(d.from)}" a "${String(d.to)}"`;
    case "apply_mode_changed":
      return `Modo de aplicación: ${APPLY_MODE_LABEL[d.from as ApplyMode] ?? String(d.from)} → ${APPLY_MODE_LABEL[d.to as ApplyMode] ?? String(d.to)}`;
    case "deactivated":
      return "Desactivado";
    case "reactivated":
      return "Reactivado";
  }
}
