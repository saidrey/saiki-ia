import Database from "better-sqlite3";
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
const AGENT_ACTORS = new Set(["assistant", "moderator", "kiro", "claude", "opencode", "agent"]);

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
  }

  close(): void {
    this.db.close();
  }

  // ── Escritura de conocimiento PROVISIONAL ──────────────────────────────────

  /**
   * Crea un documento. SIEMPRE nace como `proposed`: ningún origen (ni humano)
   * crea algo ya aprobado; la promoción es un paso aparte y humano.
   */
  create(input: CreateDocInput): KnowledgeDoc {
    const now = new Date().toISOString();
    const doc: KnowledgeDoc = {
      id: input.id,
      title: input.title,
      category: input.category,
      status: "proposed",
      content: input.content,
      origin: input.origin,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO kb_docs (id, title, category, status, content, origin, createdAt, updatedAt, supersededBy)
         VALUES (@id, @title, @category, @status, @content, @origin, @createdAt, @updatedAt, NULL)`,
      )
      .run(doc);
    this.addHistory(doc.id, "created", input.origin, `category=${input.category}`);
    return doc;
  }

  /** Actualiza el contenido/título de un documento (mantiene estado e historial). */
  update(id: string, changes: { title?: string; content?: string }, actor: string): KnowledgeDoc {
    const doc = this.getOrThrow(id);
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
  approve(id: string, humanActor: string): KnowledgeDoc {
    if (AGENT_ACTORS.has(humanActor.toLowerCase())) {
      throw new Error(
        `El actor "${humanActor}" es un agente: no puede aprobar conocimiento oficial. Requiere aprobación humana.`,
      );
    }
    const doc = this.getOrThrow(id);
    if (doc.status === "approved") return doc;
    this.setStatus(id, "approved");
    this.addHistory(id, `status:${doc.status}->approved`, humanActor);
    return this.getOrThrow(id);
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

  /** Archiva un documento (histórico, ya no activo). */
  archive(id: string, actor: string): KnowledgeDoc {
    const doc = this.getOrThrow(id);
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
    if (doc === null) throw new Error(`Documento de KB no encontrado: "${id}".`);
    return doc;
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
