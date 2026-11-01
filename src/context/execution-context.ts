import { createHash } from "node:crypto";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { CoreStore, ExecutionContextRecord } from "../core/core-store.js";
import type { ProjectBinding } from "../projects/project-binding.js";
import { buildContext, CONTEXT_SECTIONS, loadSnapshotIndex, type ApprovedKnowledge, type BuildContextInput } from "./context-builder.js";
import type { ContextStore, ScanRecord, SnapshotRecord } from "./context-store.js";
import type { Freshness } from "./freshness.js";
import type { ScanScheduler } from "./scan-scheduler.js";

/**
 * (Project Context, T8) Contexto congelado por ejecución.
 *
 * Decide con qué snapshot trabaja una ejecución (política D3: refresco
 * incremental con tiempo límite; si no termina, el último snapshot marcado como
 * desactualizado), construye el bundle con el ContextBuilder (determinista, sin
 * IA) y lo congela en `execution_contexts`. Una vez congelado, se reutiliza tal
 * cual: nunca se reconstruye con el índice actual.
 */

/** Tiempo máximo que una ejecución espera a un escaneo antes de seguir (D3, D10). */
export const DEFAULT_CONTEXT_REFRESH_MS = 30_000;

/** Por qué el contexto entregado puede no reflejar el repositorio actual. */
export type ContextStaleReason =
  | "changes_detected" // hay cambios posteriores al snapshot usado
  | "refresh_timeout" // el refresco no terminó dentro del límite
  | "refresh_failed" // el refresco falló o se interrumpió
  | "project_unavailable" // no se pudo refrescar (proyecto inactivo o no sano)
  | "no_snapshot"; // el proyecto no tiene ningún snapshot

export interface ExecutionContextDeps {
  coreStore: CoreStore;
  contextStore: ContextStore;
  scans: Pick<ScanScheduler, "request" | "wait">;
  freshness: (rootPath: string) => Promise<Freshness>;
  refreshMs?: number;
  /** (T10) Conocimiento aprobado vigente del proyecto (versiones exactas). Sin él, ninguno. */
  knowledge?: (projectId: string) => ApprovedKnowledge[];
  /** Lectura de documentos del repositorio (pruebas); por defecto, la del ContextBuilder. */
  readRepoDoc?: BuildContextInput["readRepoDoc"];
  now?: () => string;
}

export interface PrepareExecutionContextInput {
  executionId: string;
  huVersion: number;
  sessionId: string | null;
  project: ProjectBinding;
  hu: AnalyzedHu;
  /** Snapshot ya fijado en la ejecución (`contextSnapshotId`), si lo hay. */
  pinnedSnapshotId: string | null;
}

export type PrepareExecutionContextResult =
  | { ok: true; record: ExecutionContextRecord; reused: boolean }
  | { ok: false; error: string };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** ¿El bundle congelado sigue siendo exactamente el que se entregó? */
export function verifyFrozenContext(r: ExecutionContextRecord): boolean {
  return sha256(r.bundle) === r.bundleHash && sha256(r.devBundle) === r.devBundleHash;
}

/**
 * Subconjunto del bundle para el desarrollador: cabecera (con el aviso de
 * desactualización), stack y conocimiento aprobado. Los archivos relevantes y la
 * documentación ya los procesó el analista técnico.
 */
export function developerContext(bundle: string): string {
  const sections: string[] = Object.values(CONTEXT_SECTIONS);
  const keep = new Set<string>([CONTEXT_SECTIONS.stack, CONTEXT_SECTIONS.knowledge]);
  let current = "";
  const out: string[] = [];
  for (const line of bundle.split("\n")) {
    if (sections.includes(line)) current = line;
    if (current === "" || keep.has(current)) out.push(line);
  }
  // Debe describir solo lo que el adaptador de Claude permite de verdad (solo lectura).
  out.push(
    "Los archivos a cambiar están en el análisis técnico. Puedes leer los archivos del repositorio con herramientas de solo lectura (Read, Glob, Grep); no puedes escribir ni ejecutar comandos. Si no puedes leer un archivo, dilo en openQuestions y no inventes su contenido.",
  );
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Devuelve el contexto congelado de la ejecución para esta versión de la HU; si
 * aún no existe, lo construye y lo congela. Nunca espera más de `refreshMs` a un
 * escaneo.
 */
export async function prepareExecutionContext(
  deps: ExecutionContextDeps,
  input: PrepareExecutionContextInput,
): Promise<PrepareExecutionContextResult> {
  const { coreStore } = deps;
  const projectId = input.project.projectId;

  const frozen = coreStore.getExecutionContext(input.executionId, input.huVersion);
  if (frozen) return checkFrozen(frozen, projectId);

  let chosen: { snapshot: SnapshotRecord | null; stale: { reason: ContextStaleReason; changedPaths: number | null } | null };
  if (input.pinnedSnapshotId !== null) {
    // keep-first: la ejecución ya trabaja con este snapshot; no se cambia.
    const snapshot = deps.contextStore.getSnapshot(projectId, input.pinnedSnapshotId);
    if (!snapshot) return { ok: false, error: "El snapshot fijado para esta ejecución no pertenece a su proyecto." };
    chosen = { snapshot, stale: await staleness(deps, snapshot, input.project.rootPath) };
  } else {
    chosen = await chooseSnapshot(deps, input.project);
  }

  const index = loadSnapshotIndex(deps.contextStore, projectId, chosen.snapshot?.id);
  if (!index.ok) {
    // Solo pasa con un snapshot fijado anterior al índice actual: no se sustituye por el contexto actual.
    return { ok: false, error: `El índice del snapshot de esta ejecución ya no está disponible (${index.code}); no se sustituye por el contexto actual.` };
  }

  const built = await buildContext({
    project: { id: projectId, name: input.project.projectName, rootPath: input.project.rootPath },
    snapshot: index.snapshot,
    files: index.files,
    hu: input.hu,
    // (T10) Solo lo aprobado del proyecto; el historial (§9.4) aún no tiene proveedor.
    knowledge: deps.knowledge?.(projectId) ?? [],
    history: [],
    stale: chosen.stale,
    readRepoDoc: deps.readRepoDoc,
    builtAt: (deps.now ?? (() => new Date().toISOString()))(),
  });
  if (!built.ok) return { ok: false, error: `No se pudo construir el contexto: ${built.message}` };

  const { bundle } = built;
  const devBundle = developerContext(bundle.text);
  const record: ExecutionContextRecord = {
    executionId: input.executionId,
    huVersion: input.huVersion,
    sessionId: input.sessionId,
    projectId,
    snapshotId: bundle.trace.snapshotId,
    indexHash: bundle.trace.indexHash,
    hu: input.hu,
    builtAt: bundle.trace.builtAt,
    stale: bundle.trace.stale,
    staleReason: bundle.trace.staleReason,
    sources: bundle.trace.sources,
    files: bundle.trace.files,
    trace: bundle.trace,
    bundleHash: bundle.hash,
    bundle: bundle.text,
    devBundleHash: sha256(devBundle),
    devBundle,
  };
  try {
    coreStore.insertExecutionContext(record);
  } catch (e) {
    // Otro intento ya lo congeló: manda el primero.
    const first = coreStore.getExecutionContext(input.executionId, input.huVersion);
    if (first) return checkFrozen(first, projectId);
    throw e;
  }
  return { ok: true, record, reused: false };
}

function checkFrozen(r: ExecutionContextRecord, projectId: string): PrepareExecutionContextResult {
  if (r.projectId !== projectId) return { ok: false, error: "El contexto congelado de esta ejecución pertenece a otro proyecto." };
  if (!verifyFrozenContext(r)) return { ok: false, error: "El contexto congelado de esta ejecución no supera la verificación de integridad." };
  return { ok: true, record: r, reused: true };
}

/** Política D3: snapshot al día si se consigue a tiempo; si no, el último disponible marcado como desactualizado. */
async function chooseSnapshot(
  deps: ExecutionContextDeps,
  project: ProjectBinding,
): Promise<{ snapshot: SnapshotRecord | null; stale: { reason: ContextStaleReason; changedPaths: number | null } | null }> {
  const store = deps.contextStore;
  const before = store.latestSnapshot(project.projectId);
  const initial = before ? await staleness(deps, before, project.rootPath) : null;
  if (before && !initial) return { snapshot: before, stale: null };

  // Sin snapshot: el escaneo inicial de T5; desactualizado: uno incremental. Si ya hay uno en curso, se espera ese.
  const active = store.activeScans(project.projectId)[0];
  const req = active
    ? { ok: true as const, scan: active }
    : deps.scans.request(project.projectId, before ? { mode: "incremental", trigger: "stale_check" } : { mode: "full", trigger: "registered" });
  if (!req.ok) return fallback(store, project, "project_unavailable", initial?.changedPaths ?? null);

  const outcome = await waitAtMost(deps.scans.wait(req.scan.id), deps.refreshMs ?? DEFAULT_CONTEXT_REFRESH_MS);
  if (outcome === "timeout") return fallback(store, project, "refresh_timeout", initial?.changedPaths ?? null);
  if (outcome === null || outcome.status !== "completed") return fallback(store, project, "refresh_failed", initial?.changedPaths ?? null);

  const after = store.latestSnapshot(project.projectId);
  if (!after) return { snapshot: null, stale: { reason: "no_snapshot", changedPaths: null } };
  return { snapshot: after, stale: await staleness(deps, after, project.rootPath) };
}

function fallback(
  store: ContextStore,
  project: ProjectBinding,
  reason: ContextStaleReason,
  changedPaths: number | null,
): { snapshot: SnapshotRecord | null; stale: { reason: ContextStaleReason; changedPaths: number | null } } {
  const snapshot = store.latestSnapshot(project.projectId);
  return { snapshot, stale: snapshot ? { reason, changedPaths } : { reason: "no_snapshot", changedPaths: null } };
}

/** null si el repositorio coincide con la firma del escaneo que generó el snapshot. */
async function staleness(
  deps: ExecutionContextDeps,
  snapshot: SnapshotRecord,
  rootPath: string,
): Promise<{ reason: ContextStaleReason; changedPaths: number | null } | null> {
  const base = deps.contextStore.getScan(snapshot.scanId)?.signature ?? null;
  const fresh = await deps.freshness(rootPath).catch(() => null);
  if (fresh && base !== null && fresh.signature === base) return null;
  return { reason: "changes_detected", changedPaths: fresh?.changedPaths ?? null };
}

/** El escaneo terminado, "timeout" si no terminó a tiempo, o null si no se pudo esperar. */
async function waitAtMost(p: Promise<ScanRecord>, ms: number): Promise<ScanRecord | "timeout" | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
