import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModeratorSession } from "../moderator/moderator-types.js";
import type { DelegatedTask } from "../moderator/delegation.js";
import type { ProjectBinding } from "../projects/project-binding.js";

/**
 * Store persistente del Core (Fase 15): sesiones del moderador y tareas
 * delegadas. Reutiliza `better-sqlite3` (ya presente; sin deps nuevas).
 *
 * PRINCIPIO: NO duplica el estado de LangGraph. Los flujos de desarrollo viven
 * en el checkpointer de LangGraph; aquí solo se guarda la sesión conversacional
 * (que REFERENCIA el flujo por `developmentThreadId`) y las tareas auxiliares.
 *
 * Serialización simple: cada registro se guarda como JSON en una fila. Es un
 * MVP KISS: no se normaliza en columnas porque no hay consultas complejas que lo
 * justifiquen todavía.
 */

export const DEFAULT_CORE_PATH = ".saiki/core.sqlite";

/** (Estabilización) Versión de una propuesta de desarrollo, tal como existió. Inmutable. */
export interface ProposalVersionRecord {
  executionId: string;
  proposalHash: string;
  /** 1, 2, 3… en orden de aparición dentro de la ejecución. */
  version: number;
  summary: string;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  risks: string[];
  /** Momento del checkpoint en que apareció esta versión. */
  createdAt: string;
}

/** (Estabilización) Decisión humana registrada. Inmutable. */
export interface HumanDecisionRecord {
  /** eventId del `approval.resolved` correspondiente (o uuid si no hay eventos). */
  id: string;
  executionId: string;
  /** "hu_review" | "feasibility_partial" | "final_approval". */
  kind: string;
  /** Hash de la versión decidida (propuesta, HU o decisión de viabilidad). */
  subjectHash: string;
  decision: "approve" | "reject" | "request_changes";
  actor: string;
  feedback: string | null;
  resolvedAt: string;
  phaseAfter: string;
  /** "recorded": registrada al decidir; "events": reconstruida de `approval.resolved` (sin observaciones). */
  source: "recorded" | "events";
}

/** (Project Registry) Huella del repositorio: detecta movido, borrado y recreado o sustituido. */
export interface ProjectFingerprint {
  /** `dev`/`ino` del directorio raíz. */
  dev: number;
  ino: number;
  /** Ruta real del directorio git (`.git` o el `gitdir:` de un worktree). */
  gitDir: string;
  /** `ino` del directorio git: cambia si se borra y se vuelve a crear. */
  gitIno: number;
}

export type ProjectStatus = "active" | "inactive";
export type ApplyMode = "sandbox" | "real";

/** (Project Registry) Proyecto registrado. `id`, `rootPath`, `fingerprint` y `createdAt` son inmutables. */
export interface ProjectRecord {
  id: string;
  name: string;
  /** Ruta real (`realpath`), absoluta. */
  rootPath: string;
  status: ProjectStatus;
  applyMode: ApplyMode;
  fingerprint: ProjectFingerprint;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
}

export type ProjectHistoryAction = "registered" | "renamed" | "apply_mode_changed" | "deactivated" | "reactivated";

/** (Project Registry) Cambio del registro. Inmutable. */
export interface ProjectHistoryRecord {
  id: string;
  projectId: string;
  action: ProjectHistoryAction;
  actor: string;
  at: string;
  /** Valores antes y después, si aplica. */
  details: Record<string, unknown>;
}

export class CoreStore {
  private readonly db: Database.Database;

  constructor(path: string = DEFAULT_CORE_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_sessions (
        sessionId TEXT PRIMARY KEY,
        updatedAt TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_tasks (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_core_tasks_session ON core_tasks(sessionId);
      -- (Project Registry) El proyecto de una sesión no se reasigna nunca.
      CREATE TRIGGER IF NOT EXISTS core_sessions_project_immutable BEFORE UPDATE ON core_sessions
        WHEN json_extract(OLD.data, '$.projectId') IS NOT json_extract(NEW.data, '$.projectId')
        BEGIN SELECT RAISE(ABORT, 'el proyecto de una sesión es inmutable'); END;

      -- (Estabilización) Historial INMUTABLE de propuestas y decisiones. Solo
      -- inserción: los triggers impiden modificar o borrar una versión registrada.
      CREATE TABLE IF NOT EXISTS proposal_versions (
        executionId TEXT NOT NULL,
        proposalHash TEXT NOT NULL,
        version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        filesToCreate TEXT NOT NULL,
        filesToModify TEXT NOT NULL,
        filesToDelete TEXT NOT NULL,
        risks TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (executionId, proposalHash),
        UNIQUE (executionId, version)
      );
      CREATE TRIGGER IF NOT EXISTS proposal_versions_immutable_update BEFORE UPDATE ON proposal_versions
        BEGIN SELECT RAISE(ABORT, 'proposal_versions es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS proposal_versions_immutable_delete BEFORE DELETE ON proposal_versions
        BEGIN SELECT RAISE(ABORT, 'proposal_versions es inmutable'); END;

      CREATE TABLE IF NOT EXISTS human_decisions (
        id TEXT PRIMARY KEY,
        executionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        subjectHash TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        feedback TEXT,
        resolvedAt TEXT NOT NULL,
        phaseAfter TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_human_decisions_execution ON human_decisions(executionId, resolvedAt);
      CREATE TRIGGER IF NOT EXISTS human_decisions_immutable_update BEFORE UPDATE ON human_decisions
        BEGIN SELECT RAISE(ABORT, 'human_decisions es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS human_decisions_immutable_delete BEFORE DELETE ON human_decisions
        BEGIN SELECT RAISE(ABORT, 'human_decisions es inmutable'); END;

      -- (Project Registry) Proyectos. Sin borrado físico; la identidad (id, ruta
      -- real, huella, alta) es inmutable: mover un repo = registrar otro proyecto.
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rootPath TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        applyMode TEXT NOT NULL CHECK (applyMode IN ('sandbox', 'real')),
        fingerprint TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        deactivatedAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active_name ON projects(lower(name)) WHERE status = 'active';
      CREATE TRIGGER IF NOT EXISTS projects_identity_immutable BEFORE UPDATE ON projects
        WHEN NEW.id IS NOT OLD.id OR NEW.rootPath IS NOT OLD.rootPath
          OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.createdAt IS NOT OLD.createdAt
        BEGIN SELECT RAISE(ABORT, 'la identidad de un proyecto es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS projects_no_delete BEFORE DELETE ON projects
        BEGIN SELECT RAISE(ABORT, 'los proyectos no se borran: se desactivan'); END;

      CREATE TABLE IF NOT EXISTS project_history (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL,
        details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_history_project ON project_history(projectId, at);
      CREATE TRIGGER IF NOT EXISTS project_history_immutable_update BEFORE UPDATE ON project_history
        BEGIN SELECT RAISE(ABORT, 'project_history es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS project_history_immutable_delete BEFORE DELETE ON project_history
        BEGIN SELECT RAISE(ABORT, 'project_history es inmutable'); END;

      -- (Project Registry) Proyecto con el que nació cada ejecución. Solo inserción:
      -- una ejecución no cambia nunca de repositorio.
      CREATE TABLE IF NOT EXISTS execution_projects (
        executionId TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        projectName TEXT NOT NULL,
        rootPath TEXT NOT NULL,
        applyMode TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        boundAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_projects_project ON execution_projects(projectId);
      CREATE TRIGGER IF NOT EXISTS execution_projects_immutable_update BEFORE UPDATE ON execution_projects
        BEGIN SELECT RAISE(ABORT, 'execution_projects es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS execution_projects_immutable_delete BEFORE DELETE ON execution_projects
        BEGIN SELECT RAISE(ABORT, 'execution_projects es inmutable'); END;
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── Sesiones ─────────────────────────────────────────────────────────────

  saveSession(session: ModeratorSession): void {
    this.db
      .prepare(
        `INSERT INTO core_sessions (sessionId, updatedAt, data)
         VALUES (@sessionId, @updatedAt, @data)
         ON CONFLICT(sessionId) DO UPDATE SET updatedAt=@updatedAt, data=@data`,
      )
      .run({ sessionId: session.sessionId, updatedAt: session.updatedAt, data: JSON.stringify(session) });
  }

  getSession(sessionId: string): ModeratorSession | null {
    const row = this.db
      .prepare(`SELECT data FROM core_sessions WHERE sessionId=?`)
      .get(sessionId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ModeratorSession) : null;
  }

  listSessions(): ModeratorSession[] {
    const rows = this.db
      .prepare(`SELECT data FROM core_sessions ORDER BY updatedAt DESC`)
      .all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ModeratorSession);
  }

  // ── Tareas delegadas ───────────────────────────────────────────────────────

  saveTask(sessionId: string, task: DelegatedTask): void {
    this.db
      .prepare(
        `INSERT INTO core_tasks (id, sessionId, updatedAt, data)
         VALUES (@id, @sessionId, @updatedAt, @data)
         ON CONFLICT(id) DO UPDATE SET updatedAt=@updatedAt, data=@data`,
      )
      .run({ id: task.id, sessionId, updatedAt: task.updatedAt, data: JSON.stringify(task) });
  }

  getTask(id: string): DelegatedTask | null {
    const row = this.db.prepare(`SELECT data FROM core_tasks WHERE id=?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as DelegatedTask) : null;
  }

  listTasks(sessionId: string): DelegatedTask[] {
    const rows = this.db
      .prepare(`SELECT data FROM core_tasks WHERE sessionId=? ORDER BY updatedAt ASC`)
      .all(sessionId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as DelegatedTask);
  }

  // ── (Estabilización) Historial de propuestas y decisiones (solo inserción) ──

  /**
   * Registra una versión de propuesta si es NUEVA para la ejecución (por hash).
   * Si ya existe, no hace nada: una versión registrada nunca se sobrescribe.
   * Devuelve true si la insertó.
   */
  recordProposalVersion(v: Omit<ProposalVersionRecord, "version">): boolean {
    const insert = this.db.transaction((rec: Omit<ProposalVersionRecord, "version">) => {
      const exists = this.db
        .prepare(`SELECT 1 FROM proposal_versions WHERE executionId=? AND proposalHash=?`)
        .get(rec.executionId, rec.proposalHash);
      if (exists) return false;
      const { next } = this.db
        .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM proposal_versions WHERE executionId=?`)
        .get(rec.executionId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO proposal_versions
             (executionId, proposalHash, version, summary, filesToCreate, filesToModify, filesToDelete, risks, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.executionId,
          rec.proposalHash,
          next,
          rec.summary,
          JSON.stringify(rec.filesToCreate),
          JSON.stringify(rec.filesToModify),
          JSON.stringify(rec.filesToDelete),
          JSON.stringify(rec.risks),
          rec.createdAt,
        );
      return true;
    });
    return insert(v);
  }

  listProposalVersions(executionId: string): ProposalVersionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM proposal_versions WHERE executionId=? ORDER BY version ASC`)
      .all(executionId) as Array<Record<string, string | number>>;
    return rows.map(toProposalVersion);
  }

  getProposalVersion(executionId: string, proposalHash: string): ProposalVersionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM proposal_versions WHERE executionId=? AND proposalHash=?`)
      .get(executionId, proposalHash) as Record<string, string | number> | undefined;
    return row ? toProposalVersion(row) : null;
  }

  /** Registra una decisión (idempotente por id). Devuelve true si la insertó. */
  recordDecision(d: HumanDecisionRecord): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO human_decisions
           (id, executionId, kind, subjectHash, decision, actor, feedback, resolvedAt, phaseAfter, source)
         VALUES (@id, @executionId, @kind, @subjectHash, @decision, @actor, @feedback, @resolvedAt, @phaseAfter, @source)`,
      )
      .run(d);
    return r.changes > 0;
  }

  listDecisions(executionId: string): HumanDecisionRecord[] {
    return this.db
      .prepare(`SELECT * FROM human_decisions WHERE executionId=? ORDER BY resolvedAt ASC, rowid ASC`)
      .all(executionId) as HumanDecisionRecord[];
  }

  // ── (Project Registry) Proyectos e historial del registro ──────────────────
  // Solo persistencia: las reglas (validación, unicidad, salud) viven en
  // `ProjectRegistry`. Cada cambio y su entrada de historial van en una transacción.

  insertProject(p: ProjectRecord, history: ProjectHistoryRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, rootPath, status, applyMode, fingerprint, createdAt, updatedAt, deactivatedAt)
           VALUES (@id, @name, @rootPath, @status, @applyMode, @fingerprint, @createdAt, @updatedAt, @deactivatedAt)`,
        )
        .run({ ...p, fingerprint: JSON.stringify(p.fingerprint) });
      this.insertProjectHistory(history);
    })();
  }

  /** Actualiza los campos editables (nombre, estado, modo). La identidad no se toca. */
  updateProject(p: ProjectRecord, history: ProjectHistoryRecord[]): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE projects SET name=@name, status=@status, applyMode=@applyMode, updatedAt=@updatedAt, deactivatedAt=@deactivatedAt
           WHERE id=@id`,
        )
        .run({ id: p.id, name: p.name, status: p.status, applyMode: p.applyMode, updatedAt: p.updatedAt, deactivatedAt: p.deactivatedAt });
      for (const h of history) this.insertProjectHistory(h);
    })();
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Record<string, string | null> | undefined;
    return row ? toProject(row) : null;
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY createdAt ASC, rowid ASC`).all() as Array<
      Record<string, string | null>
    >;
    return rows.map(toProject);
  }

  listProjectHistory(projectId: string): ProjectHistoryRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM project_history WHERE projectId=? ORDER BY at ASC, rowid ASC`)
      .all(projectId) as Array<Record<string, string>>;
    return rows.map((r) => ({ ...r, details: JSON.parse(r.details) }) as ProjectHistoryRecord);
  }

  /** Vincula una ejecución a su proyecto. Lanza si ya estaba vinculada: no se revincula nunca. */
  insertExecutionProject(executionId: string, b: ProjectBinding): void {
    this.db
      .prepare(
        `INSERT INTO execution_projects (executionId, projectId, projectName, rootPath, applyMode, fingerprint, boundAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(executionId, b.projectId, b.projectName, b.rootPath, b.applyMode, JSON.stringify(b.fingerprint), b.boundAt);
  }

  getExecutionProject(executionId: string): ProjectBinding | null {
    const row = this.db.prepare(`SELECT * FROM execution_projects WHERE executionId=?`).get(executionId) as
      | Record<string, string>
      | undefined;
    if (!row) return null;
    return {
      projectId: row.projectId,
      projectName: row.projectName,
      rootPath: row.rootPath,
      applyMode: row.applyMode as ApplyMode,
      fingerprint: JSON.parse(row.fingerprint) as ProjectFingerprint,
      boundAt: row.boundAt,
    };
  }

  private insertProjectHistory(h: ProjectHistoryRecord): void {
    this.db
      .prepare(`INSERT INTO project_history (id, projectId, action, actor, at, details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(h.id, h.projectId, h.action, h.actor, h.at, JSON.stringify(h.details));
  }
}

function toProject(row: Record<string, string | null>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.rootPath),
    status: row.status as ProjectStatus,
    applyMode: row.applyMode as ApplyMode,
    fingerprint: JSON.parse(String(row.fingerprint)) as ProjectFingerprint,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    deactivatedAt: row.deactivatedAt ?? null,
  };
}

function toProposalVersion(row: Record<string, string | number>): ProposalVersionRecord {
  return {
    executionId: String(row.executionId),
    proposalHash: String(row.proposalHash),
    version: Number(row.version),
    summary: String(row.summary),
    filesToCreate: JSON.parse(String(row.filesToCreate)) as string[],
    filesToModify: JSON.parse(String(row.filesToModify)) as string[],
    filesToDelete: JSON.parse(String(row.filesToDelete)) as string[],
    risks: JSON.parse(String(row.risks)) as string[],
    createdAt: String(row.createdAt),
  };
}
