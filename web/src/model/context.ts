import type {
  ContextScan,
  ContextStatus,
  ExecutionContextSummary,
  ExecutionView,
  FileKind,
  ScanMode,
  ScanProgressData,
  ScanStats,
  ScanStatus,
  ScanTrigger,
} from "../api/types";
import { duration } from "./format";

/**
 * Presentación del contexto de proyectos. Todo lo decide el backend (estado,
 * frescura, escaneos, bundles congelados); aquí solo se traduce a texto. Nada se
 * calcula a partir del repositorio ni se reconstruye.
 */

export const CONTEXT_STATUS_LABEL: Record<ContextStatus, string> = {
  none: "Sin escanear",
  scanning: "Escaneando",
  ready: "Al día",
  stale: "Desactualizado",
  failed: "Último escaneo fallido",
};

export const CONTEXT_STATUS_HINT: Record<ContextStatus, string> = {
  none: "Todavía no hay un índice del repositorio. Los agentes trabajarán sin contexto de proyecto hasta el primer escaneo.",
  scanning: "Hay un escaneo en cola o en curso. El último snapshot sigue vigente mientras tanto.",
  ready: "El índice coincide con el estado actual del repositorio.",
  stale: "El repositorio cambió después del último snapshot. Antes del análisis técnico se intentará un refresco incremental.",
  failed: "El último escaneo no terminó y no hay ningún snapshot.",
};

export const SCAN_STATUS_LABEL: Record<ScanStatus, string> = {
  queued: "En cola",
  running: "En curso",
  completed: "Completado",
  failed: "Fallido",
  interrupted: "Interrumpido",
};

export const SCAN_MODE_LABEL: Record<ScanMode, string> = {
  full: "Completo",
  incremental: "Incremental",
};

export const SCAN_TRIGGER_LABEL: Record<ScanTrigger, string> = {
  registered: "Registro del proyecto",
  manual: "Solicitud manual",
  stale_check: "Antes de un análisis técnico",
  post_apply: "Tras aplicar cambios",
  restart: "Reanudado tras reinicio",
};

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  source: "Código",
  test: "Prueba",
  config: "Configuración",
  manifest: "Manifiesto",
  doc: "Documentación",
  binary: "Binario",
  secret: "Secreto (solo el nombre)",
  other: "Otro",
};

export const FILE_KINDS = Object.keys(FILE_KIND_LABEL) as FileKind[];

/** Motivos de desactualización: del estado del proyecto (T6) y del fallback de una ejecución (T8). */
const STALE_REASON_TEXT: Record<string, string> = {
  changes_detected: "el repositorio tiene cambios posteriores al snapshot",
  project_unavailable: "el proyecto no estaba disponible para refrescarlo",
  refresh_timeout: "el refresco incremental no terminó a tiempo; se usó el snapshot anterior",
  refresh_failed: "el refresco incremental falló; se usó el snapshot anterior",
  no_snapshot: "el proyecto no tenía ningún snapshot; se trabajó sin índice",
};

export function staleReasonText(reason: string | null): string {
  if (reason === null) return "motivo no indicado";
  return STALE_REASON_TEXT[reason] ?? reason;
}

export function isScanActive(scan: Pick<ContextScan, "status">): boolean {
  return scan.status === "queued" || scan.status === "running";
}

/** Duración solo con inicio y fin reales; null si falta alguno. */
export function scanDuration(scan: Pick<ContextScan, "startedAt" | "finishedAt">): string | null {
  if (!scan.startedAt || !scan.finishedAt) return null;
  const ms = Date.parse(scan.finishedAt) - Date.parse(scan.startedAt);
  if (Number.isNaN(ms)) return null;
  return ms < 1000 ? "menos de 1 s" : duration(ms);
}

/** "12 altas, 3 cambios, 1 baja, 0 renombrados" (solo lo que el escáner contó). */
export function statsLine(stats: ScanStats): string {
  const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
  return [
    n(stats.added, "alta", "altas"),
    n(stats.modified, "modificado", "modificados"),
    n(stats.deleted, "baja", "bajas"),
    n(stats.renamed, "renombrado", "renombrados"),
  ].join(", ");
}

/** Texto del progreso con las cifras del último evento (sin estimaciones). */
export function progressText(p: ScanProgressData): string {
  return `Calculando hashes: ${p.hashed} de ${p.toHash} archivos por procesar (${p.listed} listados).`;
}

const sizeFormat = new Intl.NumberFormat("es", { maximumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

// ── Contexto de una ejecución ───────────────────────────────────────────────

export type ExecutionContextState =
  /** Recibió contexto congelado. */
  | { kind: "received"; context: ExecutionContextSummary }
  /** Aún no llegó al análisis técnico: el contexto se congela justo antes. */
  | { kind: "not_yet" }
  /** Pasó el análisis técnico sin contexto (ejecución anterior a T8 o backend sin índice). */
  | { kind: "none" };

export function executionContextState(view: Pick<ExecutionView, "context" | "stages">): ExecutionContextState {
  if (view.context) return { kind: "received", context: view.context };
  const tech = view.stages.find((s) => s.id === "technical_analysis");
  return tech && (tech.status === "pending" || tech.status === "running") ? { kind: "not_yet" } : { kind: "none" };
}

/** Fuentes agrupadas por nivel de confianza (sin hashes: la vista ya no los trae). */
export function groupSources(sources: ExecutionContextSummary["sources"]) {
  return {
    index: sources.filter((s) => s.kind === "index"),
    knowledge: sources.filter((s) => s.kind === "knowledge"),
    repoDocs: sources.filter((s) => s.kind === "repo-doc"),
    history: sources.filter((s) => s.kind === "execution-history"),
  };
}

// ── Bundles congelados ──────────────────────────────────────────────────────

/**
 * Encabezados de sección que escribe el ContextBuilder (copiados de
 * `CONTEXT_SECTIONS`; el frontend no importa del backend). Cada uno indica el
 * origen y el nivel de confianza.
 */
export const BUNDLE_SECTIONS = [
  { header: "### Stack [índice: generado del repositorio]", title: "Stack", origin: "Índice generado del repositorio" },
  { header: "### Conocimiento aprobado [aprobado en Saiki por una persona]", title: "Conocimiento aprobado", origin: "Aprobado en Saiki por una persona" },
  { header: "### Archivos relevantes [índice: generado del repositorio]", title: "Archivos relevantes", origin: "Índice generado del repositorio" },
  { header: "### Documentación del repositorio [del repositorio, no aprobada en Saiki]", title: "Documentación del repositorio", origin: "Del repositorio, no aprobada en Saiki" },
  { header: "### Ejecuciones anteriores de esta sesión [historial]", title: "Ejecuciones anteriores", origin: "Historial" },
] as const;

export interface BundleSection {
  title: string;
  origin: string | null;
  /** Texto exacto de la sección (encabezado incluido). */
  text: string;
}

/** Parte un bundle en cabecera + secciones conocidas, sin alterar el texto. */
export function splitBundle(bundle: string): BundleSection[] {
  const out: BundleSection[] = [{ title: "Cabecera", origin: null, text: "" }];
  const lines = bundle.split("\n");
  for (const line of lines) {
    const known = BUNDLE_SECTIONS.find((s) => s.header === line);
    if (known) out.push({ title: known.title, origin: known.origin, text: "" });
    const cur = out[out.length - 1];
    cur.text += cur.text === "" ? line : `\n${line}`;
  }
  return out.filter((s) => s.text.trim() !== "");
}

export interface SectionComparison {
  title: string;
  origin: string | null;
  inTechnical: boolean;
  inDeveloper: boolean;
}

/**
 * Qué secciones recibió cada agente. Una sección cuenta como recibida por Claude
 * si su texto está en su subconjunto (la cabecera, además, lleva una nota final).
 */
export function compareBundles(technical: string, developer: string): SectionComparison[] {
  const dev = splitBundle(developer);
  return splitBundle(technical).map((s) => ({
    title: s.title,
    origin: s.origin,
    inTechnical: true,
    inDeveloper: s.title === "Cabecera" ? dev.some((d) => d.title === "Cabecera") : developer.includes(s.text),
  }));
}
