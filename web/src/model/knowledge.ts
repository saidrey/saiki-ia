import type { KnowledgeCategory, KnowledgeStatus } from "../api/types";

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
