/**
 * Knowledge Base — memoria compartida del equipo (Fase 14).
 *
 * Es INDEPENDIENTE de cualquier runtime o proveedor: Kiro, Claude y OpenCode la
 * CONSULTAN, pero ninguno es su dueño. La KB persiste entre reinicios (SQLite).
 *
 * MVP deliberadamente simple (KISS): SQLite + texto. NO se introduce base
 * vectorial, RAG ni servicios externos. La estructura queda preparada para
 * recuperación semántica futura (campo de búsqueda por texto y metadatos), sin
 * implementarla todavía.
 */

/** Categorías iniciales del conocimiento. */
export type KnowledgeCategory =
  | "architecture" // decisiones arquitectónicas, estructura
  | "projects" // contexto y documentación de proyectos
  | "research" // investigaciones y comparativas
  | "decisions" // decisiones aprobadas y sus justificaciones
  | "lessons" // errores, soluciones y aprendizajes
  | "conventions"; // convenciones y reglas aprobadas

/**
 * Estados del conocimiento (ciclo de vida):
 *  - proposed:   provisional, pendiente de validación humana.
 *  - approved:   validado y oficial (requiere aprobación HUMANA).
 *  - superseded: reemplazado por una decisión posterior.
 *  - archived:   histórico, ya no activo.
 */
export type KnowledgeStatus = "proposed" | "approved" | "superseded" | "archived";

/** Tipo de relación entre documentos. */
export type RelationType =
  | "relates_to" // relación genérica
  | "supersedes" // este documento reemplaza a otro
  | "derived_from"; // este documento deriva de otro

/** Un documento de la Knowledge Base. */
export interface KnowledgeDoc {
  id: string;
  title: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  content: string;
  /** Origen del conocimiento (p. ej. "moderator", "assistant", "human"). */
  origin: string;
  createdAt: string;
  updatedAt: string;
  /** Id del documento que reemplazó a este (cuando status=superseded). */
  supersededBy?: string;
}

/** Relación entre dos documentos. */
export interface KnowledgeRelation {
  fromId: string;
  toId: string;
  type: RelationType;
}

/** Entrada del historial de cambios de un documento (auditable). */
export interface KnowledgeHistoryEntry {
  docId: string;
  at: string;
  action: string; // p. ej. "created", "updated", "status:proposed->approved"
  actor: string; // quién hizo el cambio
  detail?: string;
}

/** Parámetros para crear un documento (siempre nace como `proposed`). */
export interface CreateDocInput {
  id: string;
  title: string;
  category: KnowledgeCategory;
  content: string;
  origin: string;
}

/** Filtro de búsqueda por texto y/o metadatos. */
export interface KnowledgeQuery {
  /** Texto a buscar en título + contenido (LIKE, no semántico todavía). */
  text?: string;
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  limit?: number;
}
