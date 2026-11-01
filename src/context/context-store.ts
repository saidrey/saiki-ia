import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectFingerprint } from "../core/core-store.js";
import type { FileKind } from "./file-classifier.js";

/**
 * (Project Context, T2) Almacén del contexto técnico: escaneos, índice de
 * archivos y snapshots, en `context.sqlite` (directorio de datos del backend,
 * D1). Sin dependencias nuevas: `better-sqlite3`, como el resto de almacenes.
 *
 * Reglas, impuestas también por triggers (no solo por el código):
 * - Aislamiento: todo lleva `projectId`; las lecturas de archivos y snapshots
 *   exigen el proyecto, así que un id de otro proyecto no devuelve nada.
 * - Un snapshot es INMUTABLE (solo inserción): es la "versión de referencia"
 *   que congelan las ejecuciones.
 * - Un snapshot solo nace al COMPLETAR un escaneo, en la misma transacción
 *   (`completeScan`): nunca hay un índice a medias publicado.
 * - Un escaneo terminado (completed, failed, interrupted) no cambia más, y su
 *   identidad (proyecto, raíz, huella, modo, origen, inicio) nunca cambia.
 * - No se guarda el contenido de ningún archivo: solo ruta, metadatos y hash.
 */

export const DEFAULT_CONTEXT_PATH = ".saiki/context.sqlite";

export type ScanMode = "full" | "incremental";
export type ScanStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type ScanTrigger = "registered" | "manual" | "stale_check" | "post_apply" | "restart";

export interface ScanStats {
  listed: number;
  hashed: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  skipped: number;
  truncated: boolean;
}

/**
 * (T6) Cambios detectados por un escaneo completado, acotados a
 * `MAX_CHANGES_PER_KIND` rutas por tipo (los totales están en `stats`).
 */
export interface ScanChangesRecord {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  /** true si alguna lista se recortó. */
  truncated: boolean;
}

export const MAX_CHANGES_PER_KIND = 200;

export interface ScanRecord {
  id: string;
  projectId: string;
  mode: ScanMode;
  status: ScanStatus;
  trigger: ScanTrigger;
  rootPath: string;
  fingerprint: ProjectFingerprint;
  /** HEAD de git al empezar, si lo hay. */
  gitHead: string | null;
  /** Firma de frescura al empezar (§8.3). */
  signature: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: ScanStats | null;
  /** (T6) Solo en escaneos completados (null en los anteriores a T6). */
  changes: ScanChangesRecord | null;
  error: string | null;
}

export interface FileRecord {
  path: string;
  kind: FileKind;
  lang: string | null;
  size: number;
  mtimeMs: number;
  /** sha256; null para secretos y binarios grandes. */
  hash: string | null;
  lastScanId: string;
}

/** Resumen del snapshot. Su forma la define T4 (extractores); aquí es JSON opaco. */
export type SnapshotSummary = Record<string, unknown>;

export interface SnapshotRecord {
  id: string;
  projectId: string;
  scanId: string;
  createdAt: string;
  /** Hash del conjunto (ruta, hash) indexado. */
  indexHash: string;
  summary: SnapshotSummary;
}

export interface FileQuery {
  prefix?: string;
  kind?: FileKind;
  /** Última ruta de la página anterior (paginación por ruta). */
  after?: string;
  limit?: number;
}

export type NewScan = Pick<ScanRecord, "id" | "projectId" | "mode" | "trigger" | "rootPath" | "fingerprint"> &
  Partial<Pick<ScanRecord, "gitHead" | "signature">> & { createdAt?: string };

type ScanRow = Omit<ScanRecord, "fingerprint" | "stats" | "changes"> & { fingerprint: string; stats: string | null; changes: string | null };
type SnapshotRow = Omit<SnapshotRecord, "summary"> & { summary: string };

const MAX_PAGE = 1000;

export class ContextStore {
  private readonly db: Database.Database;

  constructor(path: string = DEFAULT_CONTEXT_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_scans (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('full','incremental')),
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','interrupted')),
        "trigger" TEXT NOT NULL,
        rootPath TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        gitHead TEXT,
        signature TEXT,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT,
        stats TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_context_scans_project ON context_scans(projectId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_context_scans_status ON context_scans(status);
      -- (T5) Como mucho un escaneo activo por proyecto, también entre procesos.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_context_scans_one_active ON context_scans(projectId)
        WHERE status IN ('queued','running');
      CREATE TRIGGER IF NOT EXISTS context_scans_identity_immutable BEFORE UPDATE ON context_scans
        WHEN OLD.projectId IS NOT NEW.projectId OR OLD.rootPath IS NOT NEW.rootPath
          OR OLD.fingerprint IS NOT NEW.fingerprint OR OLD.mode IS NOT NEW.mode
          OR OLD."trigger" IS NOT NEW."trigger" OR OLD.createdAt IS NOT NEW.createdAt
        BEGIN SELECT RAISE(ABORT, 'la identidad de un escaneo es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS context_scans_terminal_final BEFORE UPDATE ON context_scans
        WHEN OLD.status IN ('completed','failed','interrupted')
        BEGIN SELECT RAISE(ABORT, 'un escaneo terminado no cambia'); END;
      CREATE TRIGGER IF NOT EXISTS context_scans_no_delete BEFORE DELETE ON context_scans
        BEGIN SELECT RAISE(ABORT, 'los escaneos no se borran'); END;

      CREATE TABLE IF NOT EXISTS context_files (
        projectId TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        lang TEXT,
        size INTEGER NOT NULL,
        mtimeMs INTEGER NOT NULL,
        hash TEXT,
        lastScanId TEXT NOT NULL,
        PRIMARY KEY (projectId, path)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        scanId TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL,
        indexHash TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_project ON context_snapshots(projectId, createdAt);
      CREATE TRIGGER IF NOT EXISTS context_snapshots_no_update BEFORE UPDATE ON context_snapshots
        BEGIN SELECT RAISE(ABORT, 'un snapshot es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS context_snapshots_no_delete BEFORE DELETE ON context_snapshots
        BEGIN SELECT RAISE(ABORT, 'un snapshot es inmutable'); END;
    `);
    // (T6) Columna aditiva: bases de datos creadas antes no la tienen.
    const cols = this.db.prepare(`PRAGMA table_info(context_scans)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "changes")) this.db.exec(`ALTER TABLE context_scans ADD COLUMN changes TEXT`);
    this.db.pragma("user_version = 2");
  }

  close(): void {
    this.db.close();
  }

  // ── Escaneos ───────────────────────────────────────────────────────────────

  /** Registra un escaneo nuevo en estado `queued`. */
  createScan(input: NewScan): ScanRecord {
    this.db
      .prepare(
        `INSERT INTO context_scans (id, projectId, mode, status, "trigger", rootPath, fingerprint, gitHead, signature, createdAt)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.mode,
        input.trigger,
        input.rootPath,
        JSON.stringify(input.fingerprint),
        input.gitHead ?? null,
        input.signature ?? null,
        input.createdAt ?? new Date().toISOString(),
      );
    return this.getScan(input.id)!;
  }

  /** queued → running. */
  startScan(id: string, at: string = new Date().toISOString(), extra: { gitHead?: string | null; signature?: string | null } = {}): ScanRecord {
    const scan = this.getScan(id);
    this.transition(id, ["queued"], "running", {
      startedAt: at,
      gitHead: extra.gitHead ?? scan?.gitHead ?? null,
      signature: extra.signature ?? scan?.signature ?? null,
    });
    return this.getScan(id)!;
  }

  /**
   * running → completed, publicando su snapshot en la MISMA transacción. Si el
   * snapshot no se puede guardar, el escaneo no queda como completado.
   *
   * (T3) `files`: cambios del índice detectados por el escaneo. Se aplican en
   * esa misma transacción, así el índice solo avanza junto con un snapshot
   * válido: un escaneo fallido o interrumpido nunca lo deja a medias.
   */
  completeScan(
    id: string,
    stats: ScanStats,
    snapshot: { id: string; indexHash: string; summary: SnapshotSummary },
    at: string = new Date().toISOString(),
    files?: { upsert: FileRecord[]; delete: string[] },
    changes?: ScanChangesRecord,
  ): { scan: ScanRecord; snapshot: SnapshotRecord } {
    const tx = this.db.transaction(() => {
      const scan = this.transition(id, ["running"], "completed", {
        finishedAt: at,
        stats: JSON.stringify(stats),
        changes: changes ? JSON.stringify(changes) : null,
      });
      if (files) {
        this.deleteFiles(scan.projectId, files.delete);
        this.upsertFiles(scan.projectId, files.upsert);
      }
      this.db
        .prepare(`INSERT INTO context_snapshots (id, projectId, scanId, createdAt, indexHash, summary) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(snapshot.id, scan.projectId, id, at, snapshot.indexHash, JSON.stringify(snapshot.summary));
      return scan.projectId;
    });
    const projectId = tx();
    return { scan: this.getScan(id)!, snapshot: this.getSnapshot(projectId, snapshot.id)! };
  }

  /** queued|running → failed. */
  failScan(id: string, error: string, stats: ScanStats | null = null, at: string = new Date().toISOString()): ScanRecord {
    this.transition(id, ["queued", "running"], "failed", { finishedAt: at, error, stats: stats && JSON.stringify(stats) });
    return this.getScan(id)!;
  }

  /**
   * (Reinicio, D9) Marca como `interrupted` todo escaneo que quedó `queued` o
   * `running` en un proceso anterior. Devuelve los escaneos afectados.
   */
  interruptActiveScans(reason: string, at: string = new Date().toISOString()): ScanRecord[] {
    const active = this.activeScans();
    const stmt = this.db.prepare(`UPDATE context_scans SET status = 'interrupted', finishedAt = ?, error = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const s of active) stmt.run(at, reason, s.id);
    })();
    return active.map((s) => this.getScan(s.id)!);
  }

  /** (T6) Snapshot publicado por un escaneo, si lo hay. */
  snapshotOfScan(scanId: string): SnapshotRecord | null {
    const row = this.db.prepare(`SELECT * FROM context_snapshots WHERE scanId = ?`).get(scanId) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  getScan(id: string): ScanRecord | null {
    const row = this.db.prepare(`SELECT * FROM context_scans WHERE id = ?`).get(id) as ScanRow | undefined;
    return row ? toScan(row) : null;
  }

  /** Escaneos del proyecto, del más reciente al más antiguo. */
  listScans(projectId: string, limit = 20): ScanRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_scans WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
      .all(projectId, Math.min(Math.max(1, limit), MAX_PAGE)) as ScanRow[];
    return rows.map(toScan);
  }

  /** Escaneos `queued` o `running` (de todos los proyectos o de uno). */
  activeScans(projectId?: string): ScanRecord[] {
    const rows = (
      projectId === undefined
        ? this.db.prepare(`SELECT * FROM context_scans WHERE status IN ('queued','running') ORDER BY createdAt, rowid`).all()
        : this.db
            .prepare(`SELECT * FROM context_scans WHERE projectId = ? AND status IN ('queued','running') ORDER BY createdAt, rowid`)
            .all(projectId)
    ) as ScanRow[];
    return rows.map(toScan);
  }

  /**
   * Cambia el estado y sus campos en UN solo UPDATE: al pasar a un estado
   * terminal, el trigger ya no permitiría una segunda escritura.
   */
  private transition(
    id: string,
    from: ScanStatus[],
    to: ScanStatus,
    fields: Partial<Record<"startedAt" | "finishedAt" | "gitHead" | "signature" | "stats" | "changes" | "error", string | null>> = {},
  ): ScanRecord {
    const scan = this.getScan(id);
    if (!scan) throw new Error(`Escaneo no encontrado: "${id}".`);
    if (!from.includes(scan.status)) {
      throw new Error(`Transición no permitida del escaneo "${id}": ${scan.status} → ${to}.`);
    }
    const cols = Object.keys(fields);
    this.db
      .prepare(`UPDATE context_scans SET ${["status = ?", ...cols.map((c) => `${c} = ?`)].join(", ")} WHERE id = ?`)
      .run(to, ...cols.map((c) => fields[c as keyof typeof fields]), id);
    return { ...scan, status: to };
  }

  // ── Índice de archivos ─────────────────────────────────────────────────────

  /** Inserta o actualiza archivos del proyecto en una transacción (un lote). */
  upsertFiles(projectId: string, files: FileRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO context_files (projectId, path, kind, lang, size, mtimeMs, hash, lastScanId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (projectId, path) DO UPDATE SET
         kind = excluded.kind, lang = excluded.lang, size = excluded.size,
         mtimeMs = excluded.mtimeMs, hash = excluded.hash, lastScanId = excluded.lastScanId`,
    );
    this.db.transaction(() => {
      for (const f of files) stmt.run(projectId, f.path, f.kind, f.lang, f.size, f.mtimeMs, f.hash, f.lastScanId);
    })();
  }

  /** Borra rutas del índice del proyecto (bajas detectadas por el escaneo). */
  deleteFiles(projectId: string, paths: string[]): void {
    const stmt = this.db.prepare(`DELETE FROM context_files WHERE projectId = ? AND path = ?`);
    this.db.transaction(() => {
      for (const p of paths) stmt.run(projectId, p);
    })();
  }

  /** Índice completo del proyecto por ruta (para calcular diferencias en T3). */
  fileMap(projectId: string): Map<string, FileRecord> {
    const rows = this.db
      .prepare(`SELECT path, kind, lang, size, mtimeMs, hash, lastScanId FROM context_files WHERE projectId = ?`)
      .all(projectId) as FileRecord[];
    return new Map(rows.map((r) => [r.path, r]));
  }

  /** Página del índice ordenada por ruta. */
  listFiles(projectId: string, q: FileQuery = {}): FileRecord[] {
    const clauses = ["projectId = ?"];
    const args: unknown[] = [projectId];
    if (q.prefix) {
      // Rango por prefijo (sin LIKE: `_` y `%` son caracteres válidos en rutas).
      clauses.push("path >= ? AND path < ?");
      // Cota superior: el mayor punto de código (SQLite compara bytes UTF-8).
      args.push(q.prefix, q.prefix + "\u{10FFFF}");
    }
    if (q.kind) {
      clauses.push("kind = ?");
      args.push(q.kind);
    }
    if (q.after !== undefined) {
      clauses.push("path > ?");
      args.push(q.after);
    }
    args.push(Math.min(Math.max(1, q.limit ?? 200), MAX_PAGE));
    return this.db
      .prepare(
        `SELECT path, kind, lang, size, mtimeMs, hash, lastScanId FROM context_files WHERE ${clauses.join(" AND ")} ORDER BY path LIMIT ?`,
      )
      .all(...args) as FileRecord[];
  }

  countFiles(projectId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM context_files WHERE projectId = ?`).get(projectId) as { n: number }).n;
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  /** Snapshot del proyecto indicado; null si no existe o es de otro proyecto. */
  getSnapshot(projectId: string, id: string): SnapshotRecord | null {
    const row = this.db.prepare(`SELECT * FROM context_snapshots WHERE id = ? AND projectId = ?`).get(id, projectId) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  latestSnapshot(projectId: string): SnapshotRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM context_snapshots WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`)
      .get(projectId) as SnapshotRow | undefined;
    return row ? toSnapshot(row) : null;
  }

  listSnapshots(projectId: string, limit = 20): SnapshotRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_snapshots WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
      .all(projectId, Math.min(Math.max(1, limit), MAX_PAGE)) as SnapshotRow[];
    return rows.map(toSnapshot);
  }
}

function toScan(row: ScanRow): ScanRecord {
  return {
    ...row,
    fingerprint: JSON.parse(row.fingerprint),
    stats: row.stats === null ? null : JSON.parse(row.stats),
    changes: row.changes === null || row.changes === undefined ? null : JSON.parse(row.changes),
  };
}

function toSnapshot(row: SnapshotRow): SnapshotRecord {
  return { ...row, summary: JSON.parse(row.summary) };
}
