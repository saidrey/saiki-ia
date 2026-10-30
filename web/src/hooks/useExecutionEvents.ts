import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectExecutionEvents, type EventsConnection } from "../api/events";
import { appendEntry, describeControl, describeEvent, type LogEntry } from "../model/events";

/** Agrupa las invalidaciones de una ráfaga de eventos en una sola recarga. */
const INVALIDATE_DEBOUNCE_MS = 200;
/** Tipos que se anuncian a lectores de pantalla cuando llegan en vivo. */
const ANNOUNCED = new Set(["approval.required", "execution.completed", "execution.failed", "stage.failed"]);
/** Margen para distinguir un evento nuevo de uno del historial reenviado. */
const LIVE_SKEW_MS = 5_000;

interface EventsState {
  executionId: string;
  entries: LogEntry[];
  connection: EventsConnection;
  announcement: string;
}

/**
 * Registro de eventos SSE de una ejecución. Cada evento:
 *  - se añade al registro (sin duplicados),
 *  - invalida `GET /executions/:id` (la API sigue siendo la fuente de los estados;
 *    el registro NO calcula estados de etapa).
 */
export function useExecutionEvents(executionId: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<EventsState>(() => ({ executionId, entries: [], connection: "connecting", announcement: "" }));

  useEffect(() => {
    const openedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["execution", executionId] });
        // Un diálogo abierto debe enterarse si la versión pendiente cambió (otra pestaña o persona).
        void queryClient.invalidateQueries({ queryKey: ["approval", executionId] });
        void queryClient.invalidateQueries({ queryKey: ["proposals", executionId] });
        void queryClient.invalidateQueries({ queryKey: ["decisions", executionId] });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }, INVALIDATE_DEBOUNCE_MS);
    };
    setState({ executionId, entries: [], connection: "connecting", announcement: "" });

    const disconnect = connectExecutionEvents(executionId, {
      onEvent: (ev) => {
        const entry = describeEvent(ev);
        const isLive = Date.parse(ev.timestamp) >= openedAt - LIVE_SKEW_MS;
        setState((s) => ({
          ...s,
          entries: appendEntry(s.entries, entry),
          announcement: isLive && ANNOUNCED.has(ev.type) ? entry.text : s.announcement,
        }));
        invalidate();
      },
      onControl: (data) => setState((s) => ({ ...s, entries: appendEntry(s.entries, describeControl(data, Date.now())) })),
      onConnection: (connection) => setState((s) => ({ ...s, connection })),
    });
    return () => {
      clearTimeout(timer);
      disconnect();
    };
  }, [executionId, queryClient]);

  // Mientras el efecto no ha reiniciado el estado para otra ejecución, no mostrar el de la anterior.
  return state.executionId === executionId ? state : { executionId, entries: [], connection: "connecting" as const, announcement: "" };
}
