import { useQueries, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { ExecutionView } from "../api/types";
import { ACTIVE_POLL_MS } from "../app/queryClient";
import { isExecutionActive } from "../model/stages";
import { usePendingMessages, type PendingMessage } from "./useSendMessage";
import { recordExecutionSnapshot } from "./useStageObservations";
import { usePendingDecisionIds } from "./useDecisions";

const executionKey = (executionId: string) => ["execution", executionId] as const;

/**
 * Sondeo de `GET /executions/:id` SOLO mientras el backend trabaja: hay un
 * mensaje o una decisión de esta pestaña en curso para la ejecución, o la vista
 * muestra una etapa en ejecución. Pausado o terminado: sin sondeo (el SSE avisa).
 */
function pollInterval(view: ExecutionView | undefined, pending: PendingMessage[], deciding: string[]): number | false {
  if (view === undefined) return false;
  const inFlight = pending.some((p) => p.sessionId === view.sessionId) || deciding.includes(view.executionId);
  return inFlight || isExecutionActive(view) ? ACTIVE_POLL_MS : false;
}

/** Consulta la ejecución y registra la respuesta para el «Tiempo observado». */
async function fetchExecution(executionId: string) {
  const r = await api.getExecution(executionId);
  recordExecutionSnapshot(r.execution, Date.now());
  return r;
}

const noRetryOn404 = (count: number, err: Error) => !(err instanceof ApiError && err.status === 404) && count < 1;

export function useExecution(executionId: string) {
  const pending = usePendingMessages();
  const deciding = usePendingDecisionIds();
  return useQuery({
    queryKey: executionKey(executionId),
    queryFn: () => fetchExecution(executionId),
    select: (r) => r.execution,
    retry: noRetryOn404,
    refetchInterval: (q) => pollInterval(q.state.data?.execution, pending, deciding),
    // El sondeo solo existe con actividad; seguirlo aunque la pestaña esté oculta
    // (quien espera minutos cambia de pestaña). Sin esto, TanStack lo pausa.
    refetchIntervalInBackground: true,
  });
}

/** Varias ejecuciones (inicio). Comparte caché con `useExecution`. */
export function useExecutions(executionIds: string[]) {
  const pending = usePendingMessages();
  const deciding = usePendingDecisionIds();
  return useQueries({
    queries: executionIds.map((id) => ({
      queryKey: executionKey(id),
      queryFn: () => fetchExecution(id),
      retry: noRetryOn404,
      refetchInterval: (q: { state: { data?: { execution: ExecutionView } } }) =>
        pollInterval(q.state.data?.execution, pending, deciding),
      refetchIntervalInBackground: true,
    })),
  });
}
