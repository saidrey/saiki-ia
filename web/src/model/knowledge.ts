import type { KnowledgeCategory, KnowledgeDoc, KnowledgeStatus, ProjectAnalysis, ProjectKnowledgeCategory } from "../api/types";

export const CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  architecture: "Arquitectura",
  projects: "Proyectos",
  research: "Investigación",
  decisions: "Decisiones",
  lessons: "Lecciones",
  conventions: "Convenciones",
};

export const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  proposed: "Propuesto",
  approved: "Aprobado",
  superseded: "Reemplazado",
  archived: "Archivado",
};

/** Etiqueta de un valor de la API; si es desconocido, se muestra tal cual. */
export function labelOf<K extends string>(map: Record<K, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value;
}

/** Valor válido de un filtro leído de la URL, o "" (sin filtro). */
export function validFilter<K extends string>(map: Record<K, string>, value: string | null): K | "" {
  return value !== null && value in map ? (value as K) : "";
}

// ── (T10) Conocimiento por proyecto ─────────────────────────────────────────

export const PROJECT_CATEGORIES: readonly ProjectKnowledgeCategory[] = ["conventions", "architecture", "decisions"];

/** Un documento lógico con sus versiones (las calcula el backend; aquí solo se agrupan). */
export interface KnowledgeDocument {
  documentId: string;
  /** Versión aprobada vigente, si la hay. */
  official: KnowledgeDoc | null;
  /** Versión propuesta pendiente de decisión, si la hay (como mucho una). */
  pending: KnowledgeDoc | null;
  /** Todas las versiones, de la 1 a la última. */
  versions: KnowledgeDoc[];
  /** Título más reciente (para listar). */
  title: string;
  category: KnowledgeCategory;
}

/**
 * Agrupa las versiones por documento. Orden: primero los que esperan decisión,
 * después convenciones, arquitectura y decisiones (como en el contexto), y por título.
 */
export function groupDocuments(docs: KnowledgeDoc[]): KnowledgeDocument[] {
  const byDoc = new Map<string, KnowledgeDoc[]>();
  for (const d of docs) {
    const key = d.documentId ?? d.id;
    byDoc.set(key, [...(byDoc.get(key) ?? []), d]);
  }
  const rank = (c: string) => {
    const i = (PROJECT_CATEGORIES as readonly string[]).indexOf(c);
    return i === -1 ? PROJECT_CATEGORIES.length : i;
  };
  return [...byDoc.entries()]
    .map(([documentId, list]) => {
      const versions = [...list].sort((a, b) => (a.version ?? 1) - (b.version ?? 1));
      const latest = versions[versions.length - 1];
      return {
        documentId,
        official: versions.find((v) => v.status === "approved") ?? null,
        pending: versions.find((v) => v.status === "proposed") ?? null,
        versions,
        title: latest.title,
        category: latest.category,
      };
    })
    .sort(
      (a, b) =>
        Number(b.pending !== null) - Number(a.pending !== null) ||
        rank(a.category) - rank(b.category) ||
        a.title.localeCompare(b.title, "es"),
    );
}

/** Texto para un error de la API de conocimiento (el `message` del backend ya es claro; se añade qué hacer). */
export function knowledgeErrorHint(code: string): string | null {
  switch (code) {
    case "hash_mismatch":
      return "La versión cambió desde que la abriste. Recarga y revísala de nuevo.";
    case "stale_base":
      return "La versión oficial cambió después de proponer esta. Propón una versión nueva a partir de la vigente.";
    case "pending_exists":
      return "Decide primero la propuesta pendiente de este documento.";
    case "no_snapshot":
      return "Escanea el proyecto en la pestaña Resumen y vuelve a intentarlo.";
    case "analysis_running":
      return "Espera a que termine el análisis en curso.";
    default:
      return null;
  }
}


/** (T11) Autor legible de una versión: el Project Analyst es un agente, no una persona. */
export function originLabel(origin: string): string {
  return origin === "projectAnalyst" ? "Project Analyst (agente)" : origin;
}

/** (T11) Resumen del último análisis, con las cifras del backend. */
export function analysisSummary(a: ProjectAnalysis): string {
  if (a.status === "running") return "Analizando el repositorio en solo lectura…";
  if (a.status === "failed") return "El análisis falló; no se guardó ninguna propuesta.";
  const n = a.proposed.length;
  const created = n === 0 ? "El análisis terminó sin propuestas." : `El análisis propuso ${n} documento${n === 1 ? "" : "s"}; revísalo${n === 1 ? "" : "s"} abajo.`;
  const s = a.skipped.length;
  return s ? `${created} ${s} omitido${s === 1 ? "" : "s"} porque ya tenía${s === 1 ? "" : "n"} una propuesta pendiente.` : created;
}
