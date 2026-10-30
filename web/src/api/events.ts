import { EXECUTION_EVENT_TYPES, type ControlEventData, type SaikiEvent } from "./types";

/**
 * Conexión SSE a `GET /executions/:id/events` (a través del proxy `/api`).
 *
 * - Cortes de red con el servidor vivo: `EventSource` reconecta solo y reenvía
 *   `Last-Event-ID`; el servidor manda solo lo posterior.
 * - Respuesta no 200 (backend caído → 502 del proxy, 404, 501): `EventSource` se
 *   cierra para siempre sin exponer el código. Se consulta el estado con fetch:
 *   404/501 terminan; el resto se reintenta con espera creciente, retomando desde
 *   el último `seq` recibido (`?lastEventId=`).
 * - Los latidos (`: ping`) son comentarios SSE: el navegador no los expone, así
 *   que la conexión se juzga por el estado de `EventSource`.
 * - `control: end`: la ejecución es definitiva y el servidor cierra el stream. Se
 *   cierra el `EventSource` (si no, el navegador reconectaría en bucle).
 * - `control: shutdown`: el servidor se apaga; el corte se trata como cualquier
 *   otro (reintentos con espera creciente).
 */
export type EventsConnection = "connecting" | "open" | "reconnecting" | "ended" | "not_found" | "unavailable";

export interface EventsHandlers {
  onEvent: (ev: SaikiEvent) => void;
  onControl: (data: ControlEventData) => void;
  onConnection: (state: EventsConnection) => void;
}

const RETRY_MS = [1_000, 2_000, 5_000, 10_000];

export function connectExecutionEvents(executionId: string, h: EventsHandlers): () => void {
  const url = `/api/executions/${encodeURIComponent(executionId)}/events`;
  let source: EventSource | null = null;
  let lastSeq = 0;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  function open() {
    if (closed) return;
    h.onConnection(attempt === 0 ? "connecting" : "reconnecting");
    source = new EventSource(lastSeq > 0 ? `${url}?lastEventId=${lastSeq}` : url);
    source.onopen = () => {
      attempt = 0;
      h.onConnection("open");
    };
    for (const type of EXECUTION_EVENT_TYPES) {
      source.addEventListener(type, (e) => {
        const ev = parse((e as MessageEvent<string>).data) as SaikiEvent | undefined;
        if (ev === undefined) return;
        if (typeof ev.seq === "number" && ev.seq > lastSeq) lastSeq = ev.seq;
        h.onEvent(ev);
      });
    }
    source.addEventListener("control", (e) => {
      const data = parse((e as MessageEvent<string>).data) as ControlEventData | undefined;
      if (data === undefined) return;
      if (data.kind === "end") {
        closed = true;
        source?.close();
        source = null;
        h.onConnection("ended");
        return;
      }
      h.onControl(data);
    });
    source.onerror = () => {
      if (closed || source === null) return;
      if (source.readyState === EventSource.CONNECTING) {
        h.onConnection("reconnecting"); // el navegador reintenta solo
        return;
      }
      source.close();
      source = null;
      void classifyAndRetry();
    };
  }

  async function classifyAndRetry() {
    const ctrl = new AbortController();
    let status = 0;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      status = res.status;
    } catch {
      status = 0;
    } finally {
      ctrl.abort(); // no leer el stream: solo interesaba el código
    }
    if (closed) return;
    if (status === 404) return h.onConnection("not_found");
    if (status === 501) return h.onConnection("unavailable");
    h.onConnection("reconnecting");
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    timer = setTimeout(open, delay);
  }

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}
