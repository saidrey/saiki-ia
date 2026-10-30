import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SaikiEvent, NewEvent } from "./event-types.js";

/**
 * Persistencia MÍNIMA de eventos para reconexión SSE (Fase 20).
 *
 * Reutiliza `better-sqlite3` (ya presente; sin deps nuevas). Cada evento recibe
 * un `seq` incremental POR ejecución, usado como `Last-Event-ID` para que un
 * cliente que reconecta reciba solo los eventos POSTERIORES al último que vio.
 *
 * Retención: se conservan como máximo `maxPerExecution` eventos por ejecución
 * (los más antiguos se descartan). No almacena secretos (el Core sanea `data`).
 *
 * NO duplica el estado completo del grafo: solo guarda los eventos emitidos.
 */

export const DEFAULT_EVENTS_PATH = ".saiki/events.sqlite";
const DEFAULT_MAX_PER_EXECUTION = 1000;

export class EventStore {
  private readonly db: Database.Database;
  private readonly maxPerExecution: number;

  constructor(path: string = DEFAULT_EVENTS_PATH, options: { maxPerExecution?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.maxPerExecution = options.maxPerExecution ?? DEFAULT_MAX_PER_EXECUTION;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        executionId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        eventId TEXT NOT NULL,
        type TEXT NOT NULL,
        sessionId TEXT,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (executionId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_exec_seq ON events(executionId, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Persiste un evento asignándole el siguiente `seq` de su ejecución. Devuelve
   * el evento ya con `seq`. Eventos sin `executionId` no se persisten (no son
   * reconectables por ejecución) y se devuelven tal cual con seq=0.
   */
  append(event: NewEvent): SaikiEvent {
    const executionId = event.executionId;
    if (executionId === undefined) {
      return { ...event, seq: 0 } as SaikiEvent;
    }

    const row = this.db
      .prepare(`SELECT MAX(seq) AS maxSeq FROM events WHERE executionId = ?`)
      .get(executionId) as { maxSeq: number | null };
    const seq = (row.maxSeq ?? 0) + 1;

    this.db
      .prepare(
        `INSERT INTO events (executionId, seq, eventId, type, sessionId, timestamp, data)
         VALUES (@executionId, @seq, @eventId, @type, @sessionId, @timestamp, @data)`,
      )
      .run({
        executionId,
        seq,
        eventId: event.eventId,
        type: event.type,
        sessionId: event.sessionId ?? null,
        timestamp: event.timestamp,
        data: JSON.stringify(event.data),
      });

    this.enforceRetention(executionId);
    return { ...event, seq } as SaikiEvent;
  }

  /** Eventos de una ejecución con `seq` > `afterSeq`, en orden. */
  getSince(executionId: string, afterSeq: number): SaikiEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE executionId = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(executionId, afterSeq) as EventRow[];
    return rows.map(toEvent);
  }

  /** Todos los eventos de una ejecución, en orden. */
  getAll(executionId: string): SaikiEvent[] {
    return this.getSince(executionId, 0);
  }

  /** `seq` mínimo disponible para una ejecución (para detectar brechas). */
  earliestSeq(executionId: string): number | null {
    const row = this.db
      .prepare(`SELECT MIN(seq) AS minSeq FROM events WHERE executionId = ?`)
      .get(executionId) as { minSeq: number | null };
    return row.minSeq ?? null;
  }

  private enforceRetention(executionId: string): void {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE executionId = ?`)
      .get(executionId) as { c: number };
    if (countRow.c <= this.maxPerExecution) return;
    const toDelete = countRow.c - this.maxPerExecution;
    this.db
      .prepare(
        `DELETE FROM events WHERE rowid IN (
           SELECT rowid FROM events WHERE executionId = ? ORDER BY seq ASC LIMIT ?
         )`,
      )
      .run(executionId, toDelete);
  }
}

interface EventRow {
  executionId: string;
  seq: number;
  eventId: string;
  type: string;
  sessionId: string | null;
  timestamp: string;
  data: string;
}

function toEvent(row: EventRow): SaikiEvent {
  return {
    eventId: row.eventId,
    type: row.type as SaikiEvent["type"],
    executionId: row.executionId,
    sessionId: row.sessionId ?? undefined,
    timestamp: row.timestamp,
    seq: row.seq,
    data: JSON.parse(row.data),
  };
}
