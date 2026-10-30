import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { ACTIVE_POLL_MS } from "../app/queryClient";
import { usePendingMessages } from "./useSendMessage";

/** `GET /sessions`. Se refresca mientras haya mensajes en curso (aparecen sesiones nuevas). */
export function useSessionsList() {
  const pending = usePendingMessages();
  return useQuery({
    queryKey: ["sessions"],
    queryFn: api.listSessions,
    select: (r) => r.sessions,
    refetchInterval: pending.length > 0 ? ACTIVE_POLL_MS : false,
    refetchIntervalInBackground: true,
  });
}

/**
 * `GET /sessions/:id`. Con `poll`, se consulta periódicamente: la sesión puede no
 * existir aún (404) mientras el moderador clasifica el primer mensaje.
 */
export function useSession(sessionId: string | undefined, poll = false) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId as string),
    enabled: sessionId !== undefined,
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
    refetchInterval: poll ? ACTIVE_POLL_MS : false,
    refetchIntervalInBackground: true,
  });
}
