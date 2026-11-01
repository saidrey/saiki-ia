import { useLayoutEffect, useRef } from "react";
import type { EventsConnection } from "../api/events";
import type { LogEntry } from "../model/events";
import styles from "./EventLog.module.css";

const CONNECTION_LABEL: Record<EventsConnection, string> = {
  connecting: "Conectando",
  open: "Conectado",
  reconnecting: "Reconectando",
  ended: "Finalizada, no habrá más eventos",
  not_found: "El servidor de eventos no conoce esta ejecución",
  unavailable: "El servidor no tiene eventos configurados",
};

const timeFormat = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** `subject`: de qué es el stream (por defecto, una ejecución). */
export function EventsStatus({ connection, subject = "ejecución" }: { connection: EventsConnection; subject?: "ejecución" | "proyecto" }) {
  const label = connection === "not_found" ? `El servidor de eventos no conoce ${subject === "proyecto" ? "este proyecto" : "esta ejecución"}` : CONNECTION_LABEL[connection];
  return (
    <span className={styles.status} data-state={connection}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {connection === "open" ? (
          <circle cx="5" cy="5" r="4" />
        ) : connection === "not_found" || connection === "unavailable" ? (
          <path d="M2 2l6 6M8 2l-6 6" />
        ) : (
          <circle cx="5" cy="5" r="3.5" />
        )}
      </svg>
      Eventos: {label}
    </span>
  );
}

/** Registro de eventos SSE de la ejecución, en orden de `seq`. */
export function EventLog({ entries, connection }: { entries: LogEntry[]; connection: EventsConnection }) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <section className={styles.panel} aria-labelledby="log-title">
      <header className={styles.head}>
        <h2 id="log-title" className={styles.title}>
          Registro de eventos
        </h2>
        <EventsStatus connection={connection} />
      </header>
      <p className={styles.note}>
        El backend emite los eventos en bloque al terminar cada tramo del flujo: la hora es la de emisión, no la del
        trabajo de cada etapa.
      </p>
      {entries.length === 0 ? (
        <p className={styles.empty}>
          {connection === "open" ? "Todavía no hay eventos para esta ejecución." : "Sin eventos recibidos."}
        </p>
      ) : (
        <div
          ref={listRef}
          className={styles.scroller}
          role="log"
          aria-live="off"
          aria-labelledby="log-title"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <ol className={styles.list}>
            {entries.map((e) => (
              <li key={e.key} className={styles.row} data-tone={e.tone}>
                <span className={styles.seq}>{e.seq !== undefined ? `#${e.seq}` : ""}</span>
                <time className={styles.time} dateTime={e.timestamp}>
                  {e.timestamp ? timeFormat.format(Date.parse(e.timestamp)) : ""}
                </time>
                <span className={styles.body}>
                  <span className={styles.type}>{e.type}</span>
                  <span className={styles.text}>{e.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
