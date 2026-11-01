import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  KnowledgeDoc,
  KnowledgeRelation,
  KnowledgeHistoryEntry,
  CreateDocInput,
  KnowledgeQuery,
  KnowledgeCategory,
  KnowledgeStatus,
  RelationType,
} from "./kb-types.js";
import { PROJECT_KNOWLEDGE_CATEGORIES } from "./kb-types.js";

/**
 * Almacén persistente de la Knowledge Base (Fase 14), sobre SQLite.
 *
 * Reutiliza `better-sqlite3` (ya presente como dependencia transitiva del
 * checkpointer); NO añade dependencias nuevas. Síncrono y simple (KISS).
 *
 * REGLA DURA: ningún AGENTE puede promover conocimiento a `approved`. El método
 * `approve()` exige un actor HUMANO explícito y rechaza actores de agente. Crear
 * un documento SIEMPRE nace como `proposed`.
 *
 * Ubicación por defecto: `.saiki/knowledge.sqlite` (gitignored). Los tests deben
 * usar una ruta temporal o `:memory:`.
 */

export const DEFAULT_KB_PATH = ".saiki/knowledge.sqlite";

/** Actores de AGENTE que NUNCA pueden aprobar conocimiento oficial. */
const AGENT_ACTORS = new Set(["assistant", "moderator", "kiro", "claude", "opencode", "agent", "projectanalyst"]);

/** (T10) Error de una operación de la KB con código estable (la API lo traduce). */
export type KnowledgeErrorCode =
  | "not_found"
  | "invalid"
  | "agent_forbidden"
  | "not_proposed"
  | "not_approved"
  | "hash_mismatch"
  | "stale_base"
  | "pending_exists";

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

/**
 * (T10) Hash de una versión: lo que la persona revisó y aprueba. Cambia con
 * cualquier dato que forme parte de la versión.
 */
export function versionHash(d: Pick<KnowledgeDoc, "documentId" | "version" | "projectId" | "category" | "title" | "content">): string {
  return createHash("sha256")
    .update(JSON.stringify([d.documentId, d.version, d.projectId, d.category, d.title, d.content]))
    .digest("hex");
}

export class KnowledgeStore {
  private readonly db: Database.Database;

  constructor(path: string = DEFAULT_KB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        origin TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        supersededBy TEXT
      );
      CREATE TABLE IF NOT EXISTS kb_relations (
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (fromId, toId, type)
      );
      CREATE TABLE IF NOT EXISTS kb_history (
        docId TEXT NOT NULL,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kb_docs_cat ON kb_docs(category);
      CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_docs(status);
      CREATE INDEX IF NOT EXISTS idx_kb_history_doc ON kb_history(docId);
    `);
    this.migrateVersions();
  }

  /**
   * (T10) Proyecto y versiones (aditivo): los documentos existentes quedan como
   * globales, versión 1 de sí mismos. Nada se mueve ni se reescribe.
   */
  private migrateVersions(): void {
    const cols = new Set((this.db.prepare(`PRAGMA table_info(kb_docs)`).all() as Array<{ name: string }>).map((c) => c.name));
    const add = (name: string, ddl: string) => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE kb_docs ADD COLUMN ${ddl}`);
    };
    add("projectId", "projectId TEXT");
    add("documentId", "documentId TEXT");
    add("version", "version INTEGER NOT NULL DEFAULT 1");
    add("basedOn", "basedOn TEXT");
    this.db.exec(`
      UPDATE kb_docs SET documentId = id WHERE documentId IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_docs_version ON kb_docs(documentId, version);
      CREATE INDEX IF NOT EXISTS idx_kb_docs_project ON kb_docs(projectId);
      -- Solo una versión propuesta es editable; aprobada, reemplazada o archivada no cambia nunca.
      CREATE TRIGGER IF NOT EXISTS kb_docs_versions_immutable
        BEFORE UPDATE OF title, content, category, projectId, documentId, version, basedOn ON kb_docs
        WHEN OLD.status <> 'proposed'
        BEGIN SELECT RAISE(ABORT, 'kb_docs: una versión no propuesta es inmutable'); END;
      CREATE TRIGGER IF NOT EXISTS kb_docs_no_delete BEFORE DELETE ON kb_docs
        BEGIN SELECT RAISE(ABORT, 'kb_docs: los documentos no se borran'); END;
      PRAGMA user_version = 1;
    `);
  }

  close(): void {
    this.db.close();
  }

  /** (T11) Varias escrituras atómicas: si una lanza, no queda ninguna. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Escritura de conocimiento PROVISIONAL ──────────────────────────────────

  /**
   * Crea un documento. SIEMPRE nace como `proposed`: ningún origen (ni humano)
   * crea algo ya aprobado; la promoción es un paso aparte y humano.
   */
  create(input: CreateDocInput, note?: string): KnowledgeDoc {
    const projectId = input.projectId ?? null;
    if (projectId !== null && !PROJECT_KNOWLEDGE_CATEGORIES.includes(input.category)) {
      throw new KnowledgeError("invalid", `El conocimiento de un proyecto es de categoría ${PROJECT_KNOWLEDGE_CATEGORIES.join(", ")}.`);
    }
    if (input.title.trim() === "" || input.content.trim() === "") throw new KnowledgeError("invalid", "Título y contenido son obligatorios.");
    return this.insert({ id: input.id, title: input.title, category: input.category, content: input.content, origin: input.origin, projectId, documentId: input.id, version: 1, basedOn: null }, `category=${input.category}${note ? `; ${note}` : ""}`);
  }

  private insert(d: Omit<KnowledgeDoc, "status" | "createdAt" | "updatedAt">, detail: string): KnowledgeDoc {
    const now = new Date().toISOString();
    const doc: KnowledgeDoc = { ...d, status: "proposed", createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO kb_docs (id, title, category, status, content, origin, createdAt, updatedAt, supersededBy, projectId, documentId, version, basedOn)
         VALUES (@id, @title, @category, @status, @content, @origin, @createdAt, @updatedAt, NULL, @projectId, @documentId, @version, @basedOn)`,
      )
      .run(doc);
    this.addHistory(doc.id, "created", d.origin, detail);
    return this.getOrThrow(doc.id);
  }

  /**
   * (T10) Propone la versión siguiente de un documento APROBADO, sin tocarlo:
   * nace `proposed`, con `basedOn` = la versión aprobada. Una propuesta pendiente
   * por documento. Las decisiones son de solo adición para los agentes (§7.2).
   */
  proposeVersion(baseId: string, changes: { title?: string; content?: string }, actor: string, note?: string): KnowledgeDoc {
    const base = this.getOrThrow(baseId);
    if (base.status !== "approved") {
      throw new KnowledgeError("not_approved", "Solo se proponen versiones nuevas de la versión aprobada vigente.");
    }
    if (base.category === "decisions" && AGENT_ACTORS.has(actor.toLowerCase())) {
      throw new KnowledgeError("agent_forbidden", "Un agente no puede proponer versiones de una decisión aprobada; solo decisiones nuevas.");
    }
    const pending = this.db
      .prepare(`SELECT id FROM kb_docs WHERE documentId=? AND status='proposed'`)
      .get(base.documentId) as { id: string } | undefined;
    if (pending) throw new KnowledgeError("pending_exists", `El documento ya tiene una versión propuesta pendiente ("${pending.id}").`);
    const title = changes.title ?? base.title;
    const content = changes.content ?? base.content;
    if (title.trim() === "" || content.trim() === "") throw new KnowledgeError("invalid", "Título y contenido son obligatorios.");
    if (title === base.title && content === base.content) throw new KnowledgeError("invalid", "La versión propuesta no cambia nada.");
    const { max } = this.db.prepare(`SELECT MAX(version) AS max FROM kb_docs WHERE documentId=?`).get(base.documentId) as { max: number };
    const version = max + 1;
    return this.insert(
      { id: `${base.documentId}-v${version}`, title, category: base.category, content, origin: actor, projectId: base.projectId, documentId: base.documentId, version, basedOn: base.id },
      `version=${version}; basedOn=${base.id}${note ? `; ${note}` : ""}`,
    );
  }

  /** Actualiza el contenido/título de una versión PROPUESTA (lo aprobado no se edita). */
  update(id: string, changes: { title?: string; content?: string }, actor: string): KnowledgeDoc {
    const doc = this.getOrThrow(id);
    if (doc.status !== "proposed") {
      throw new KnowledgeError("not_proposed", "Un documento aprobado no se edita: propón una versión nueva.");
    }
    const now = new Date().toISOString();
    const title = changes.title ?? doc.title;
    const content = changes.content ?? doc.content;
    this.db
      .prepare(`UPDATE kb_docs SET title=?, content=?, updatedAt=? WHERE id=?`)
      .run(title, content, now, id);
    this.addHistory(id, "updated", actor);
    return this.getOrThrow(id);
  }

  // ── Promoción / transiciones de estado ─────────────────────────────────────

  /**
   * Promueve un documento a `approved`. REQUIERE actor HUMANO explícito: si el
   * actor parece un agente, lanza (ningún agente aprueba conocimiento oficial).
   */
  approve(id: string, humanActor: string, expectedHash?: string): KnowledgeDoc {
    this.requireHuman(humanActor, "aprobar");
    const doc = this.getOrThrow(id);
    if (doc.status === "approved" && expectedHash === undefined) return doc;
    this.requireProposed(doc, expectedHash);
    // La base debe seguir siendo la versión oficial: si no, la propuesta quedó obsoleta.
    const base = doc.basedOn ? this.getOrThrow(doc.basedOn) : null;
    if (base && base.status !== "approved") {
      throw new KnowledgeError("stale_base", "La versión de la que deriva esta propuesta ya no es la vigente.");
    }
    this.db.transaction(() => {
      this.setStatus(id, "approved");
      this.addHistory(id, "status:proposed->approved", humanActor, `version=${doc.version}; hash=${versionHash(doc)}`);
      if (base) this.supersede(base.id, id, humanActor);
    })();
    return this.getOrThrow(id);
  }

  /** (T10) Rechaza una versión propuesta: queda archivada y el historial dice "rejected". */
  reject(id: string, humanActor: string, expectedHash?: string): KnowledgeDoc {
    this.requireHuman(humanActor, "rechazar");
    const doc = this.getOrThrow(id);
    this.requireProposed(doc, expectedHash);
    this.setStatus(id, "archived");
    this.addHistory(id, "rejected", humanActor, `status:proposed->archived; version=${doc.version}`);
    return this.getOrThrow(id);
  }

  private requireHuman(actor: string, action: string): void {
    if (AGENT_ACTORS.has(actor.toLowerCase())) {
      throw new KnowledgeError(
        "agent_forbidden",
        `El actor "${actor}" es un agente: no puede ${action} conocimiento oficial. Requiere aprobación humana.`,
      );
    }
  }

  /** La decisión debe recaer en una versión propuesta y, si se indica, exactamente la revisada. */
  private requireProposed(doc: KnowledgeDoc, expectedHash?: string): void {
    if (doc.status !== "proposed") throw new KnowledgeError("not_proposed", `La versión está ${doc.status}: no hay nada que decidir.`);
    if (expectedHash !== undefined && expectedHash !== versionHash(doc)) {
      throw new KnowledgeError("hash_mismatch", "La versión cambió desde que se revisó: vuelve a revisarla.");
    }
  }

  /**
   * Marca `oldId` como `superseded` por `newId` y registra la relación. El
   * documento reemplazado CONSERVA su historial (no se borra).
   */
  supersede(oldId: string, newId: string, actor: string): void {
    const oldDoc = this.getOrThrow(oldId);
    this.getOrThrow(newId); // valida que exista
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE kb_docs SET status='superseded', supersededBy=?, updatedAt=? WHERE id=?`)
      .run(newId, now, oldId);
    this.relate(newId, oldId, "supersedes");
    this.addHistory(oldId, `status:${oldDoc.status}->superseded`, actor, `by ${newId}`);
  }

  /** Archiva un documento aprobado o propuesto (histórico, ya no activo). */
  archive(id: string, actor: string): KnowledgeDoc {
    this.requireHuman(actor, "archivar");
    const doc = this.getOrThrow(id);
    if (doc.status !== "approved" && doc.status !== "proposed") {
      throw new KnowledgeError("invalid", `Una versión ${doc.status} no se archiva: ya es histórica.`);
    }
    this.setStatus(id, "archived");
    this.addHistory(id, `status:${doc.status}->archived`, actor);
    return this.getOrThrow(id);
  }

  private setStatus(id: string, status: KnowledgeStatus): void {
    this.db
      .prepare(`UPDATE kb_docs SET status=?, updatedAt=? WHERE id=?`)
      .run(status, new Date().toISOString(), id);
  }

  // ── Relaciones ─────────────────────────────────────────────────────────────

  relate(fromId: string, toId: string, type: RelationType): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO kb_relations (fromId, toId, type) VALUES (?, ?, ?)`)
      .run(fromId, toId, type);
  }

  relationsOf(id: string): KnowledgeRelation[] {
    return this.db
      .prepare(`SELECT fromId, toId, type FROM kb_relations WHERE fromId=? OR toId=?`)
      .all(id, id) as KnowledgeRelation[];
  }

  // ── Lectura / búsqueda ─────────────────────────────────────────────────────

  get(id: string): KnowledgeDoc | null {
    const row = this.db.prepare(`SELECT * FROM kb_docs WHERE id=?`).get(id) as
      | KnowledgeDoc
      | undefined;
    return row ?? null;
  }

  private getOrThrow(id: string): KnowledgeDoc {
    const doc = this.get(id);
    if (doc === null) throw new KnowledgeError("not_found", `Documento de KB no encontrado: "${id}".`);
    return doc;
  }

  /** (T10) Todas las versiones de un documento lógico, de la 1 a la última. */
  versions(documentId: string): KnowledgeDoc[] {
    return this.db.prepare(`SELECT * FROM kb_docs WHERE documentId=? ORDER BY version ASC`).all(documentId) as KnowledgeDoc[];
  }

  /** (T10) Versiones aprobadas vigentes de un proyecto (las que entran en el contexto). */
  approvedForProject(projectId: string): KnowledgeDoc[] {
    return this.db
      .prepare(`SELECT * FROM kb_docs WHERE projectId=? AND status='approved' ORDER BY documentId ASC`)
      .all(projectId) as KnowledgeDoc[];
  }

  /** Búsqueda por texto (LIKE) y/o metadatos. No semántica (todavía). */
  search(query: KnowledgeQuery = {}): KnowledgeDoc[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.text) {
      clauses.push(`(title LIKE ? OR content LIKE ?)`);
      const like = `%${query.text}%`;
      params.push(like, like);
    }
    if (query.category) {
      clauses.push(`category = ?`);
      params.push(query.category);
    }
    if (query.status) {
      clauses.push(`status = ?`);
      params.push(query.status);
    }
    // (T10) Global y proyecto nunca se mezclan.
    if (query.projectId === undefined) clauses.push(`projectId IS NULL`);
    else {
      clauses.push(`projectId = ?`);
      params.push(query.projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = query.limit ?? 50;
    return this.db
      .prepare(`SELECT * FROM kb_docs ${where} ORDER BY updatedAt DESC LIMIT ?`)
      .all(...params, limit) as KnowledgeDoc[];
  }

  listByCategory(category: KnowledgeCategory): KnowledgeDoc[] {
    return this.search({ category });
  }

  // ── Historial ──────────────────────────────────────────────────────────────

  private addHistory(docId: string, action: string, actor: string, detail?: string): void {
    this.db
      .prepare(`INSERT INTO kb_history (docId, at, action, actor, detail) VALUES (?, ?, ?, ?, ?)`)
      .run(docId, new Date().toISOString(), action, actor, detail ?? null);
  }

  history(docId: string): KnowledgeHistoryEntry[] {
    return this.db
      .prepare(`SELECT docId, at, action, actor, detail FROM kb_history WHERE docId=? ORDER BY at ASC`)
      .all(docId) as KnowledgeHistoryEntry[];
  }
}
