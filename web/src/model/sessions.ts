import type { ExecutionView, ModeratorSession } from "../api/types";

export interface SessionSummary {
  sessionId: string;
  /** Primer mensaje del usuario. */
  title: string;
  updatedAt: string;
  /** Ejecución más reciente. */
  executionId?: string;
  /** Todas las ejecuciones de la sesión, la más reciente primero. */
  executionIds: string[];
  /** La sesión delegó al menos una tarea de asistencia (`delegatedTaskIds`). */
  hasAssistance: boolean;
  /** Proyecto de la sesión; ausente = sesión general. */
  projectId?: string;
}

/** Ejecuciones de una sesión; las sesiones antiguas solo tienen `developmentThreadId`. */
export function executionsOf(s: ModeratorSession): string[] {
  if (s.developmentThreadIds && s.developmentThreadIds.length > 0) return s.developmentThreadIds;
  return s.developmentThreadId ? [s.developmentThreadId] : [];
}

export function summarizeSession(s: ModeratorSession): SessionSummary {
  const firstUser = s.turns.find((t) => t.role === "user");
  return {
    sessionId: s.sessionId,
    title: firstUser?.text ?? "Sesión sin mensajes",
    updatedAt: s.updatedAt,
    executionId: s.developmentThreadId,
    executionIds: [...executionsOf(s)].reverse(),
    hasAssistance: s.delegatedTaskIds.length > 0,
    projectId: s.projectId,
  };
}

/** Más reciente primero, según `updatedAt` de la API. */
export function byRecentActivity(a: { updatedAt: string }, b: { updatedAt: string }): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Una fila del inicio: una ejecución, o una sesión sin ejecuciones (conversación/asistencia). */
export interface ActivityRow {
  key: string;
  sessionId: string;
  executionId?: string;
  /** Solicitud de la ejecución (de la API) o primer mensaje de la sesión. */
  title: string;
  updatedAt: string;
  hasAssistance: boolean;
  /** Si la ejecución se sigue cargando, el título aún no es el suyo. */
  titlePending: boolean;
  /** Proyecto de la sesión; ausente = sesión general. */
  projectId?: string;
}

/**
 * Filas del inicio: cada ejecución por separado (una sesión puede tener varias y
 * todas deben verse) y las sesiones sin ejecuciones. El título de una ejecución
 * es su propia solicitud según la API, no el primer mensaje de la sesión.
 */
export function activityRows(sessions: ModeratorSession[], views: Map<string, ExecutionView | undefined>): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const s of sessions.map(summarizeSession).sort(byRecentActivity)) {
    if (s.executionIds.length === 0) {
      rows.push({
        key: s.sessionId,
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
        hasAssistance: s.hasAssistance,
        titlePending: false,
        projectId: s.projectId,
      });
      continue;
    }
    for (const id of s.executionIds) {
      const v = views.get(id);
      const request = v && v.request !== "unavailable" ? v.request : undefined;
      rows.push({
        key: id,
        sessionId: s.sessionId,
        executionId: id,
        title: request ?? (s.executionIds.length === 1 ? s.title : "Cargando solicitud…"),
        updatedAt: s.updatedAt,
        hasAssistance: s.hasAssistance,
        titlePending: request === undefined,
        projectId: s.projectId,
      });
    }
  }
  return rows;
}
