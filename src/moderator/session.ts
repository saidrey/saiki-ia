import type {
  ModeratorSession,
  ConversationTurn,
  IntentClassification,
} from "./moderator-types.js";

/**
 * Utilidades de sesión del moderador (Fase 14). Mantienen el estado
 * conversacional SIN duplicar el estado de LangGraph: los flujos de desarrollo
 * se referencian por `developmentThreadId` y las tareas por id.
 */

export function createModeratorSession(sessionId: string, projectId?: string): ModeratorSession {
  const now = new Date().toISOString();
  return {
    sessionId,
    createdAt: now,
    updatedAt: now,
    turns: [],
    delegatedTaskIds: [],
    ...(projectId ? { projectId } : {}),
  };
}

export function addUserTurn(
  session: ModeratorSession,
  text: string,
  classification?: IntentClassification,
): ModeratorSession {
  const turn: ConversationTurn = {
    role: "user",
    text,
    at: new Date().toISOString(),
    classification,
  };
  return { ...session, turns: [...session.turns, turn], updatedAt: turn.at };
}

export function addModeratorTurn(session: ModeratorSession, text: string): ModeratorSession {
  const turn: ConversationTurn = { role: "moderator", text, at: new Date().toISOString() };
  return { ...session, turns: [...session.turns, turn], updatedAt: turn.at };
}

export function linkDelegatedTask(session: ModeratorSession, taskId: string): ModeratorSession {
  if (session.delegatedTaskIds.includes(taskId)) return session;
  return {
    ...session,
    delegatedTaskIds: [...session.delegatedTaskIds, taskId],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Enlaza una ejecución de desarrollo NUEVA a la sesión. Cada solicitud tiene su
 * propia ejecución: las anteriores se conservan en `developmentThreadIds` y
 * `developmentThreadId` apunta a la más reciente.
 */
export function linkDevelopmentThread(
  session: ModeratorSession,
  threadId: string,
): ModeratorSession {
  const previous = developmentThreadsOf(session);
  const ids = previous.includes(threadId) ? previous : [...previous, threadId];
  return { ...session, developmentThreadId: threadId, developmentThreadIds: ids, updatedAt: new Date().toISOString() };
}

/** Ejecuciones de desarrollo de una sesión (compatible con sesiones antiguas). */
export function developmentThreadsOf(session: ModeratorSession): string[] {
  if (session.developmentThreadIds && session.developmentThreadIds.length > 0) return session.developmentThreadIds;
  return session.developmentThreadId ? [session.developmentThreadId] : [];
}
