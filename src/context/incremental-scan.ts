import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectFingerprint } from "../core/core-store.js";
import type { ProcessRunner } from "../agents/process-runner.js";
import { scanProjectFiles, type ScannedFile } from "./project-scanner.js";
import { buildSummary } from "./project-summary.js";
import {
  MAX_CHANGES_PER_KIND,
  type ContextStore,
  type FileRecord,
  type ScanMode,
  type ScanRecord,
  type ScanStats,
  type ScanTrigger,
  type SnapshotRecord,
} from "./context-store.js";

/**
 * (Project Context, T3) Escaneo incremental.
 *
 * Lista con el Project Scanner (T1), compara con el índice del proyecto (que
 * por construcción es el del último snapshot completo, T2) y publica índice y
 * snapshot nuevos en UNA transacción al terminar bien.
 *
 * - Reutiliza el hash anterior solo si tamaño, mtime y tipo coinciden y el
 *   archivo no era "racy" (modificado poco antes de que el escaneo anterior lo
 *   leyera; el mismo problema que resuelve git con su índice). Si no, recalcula.
 * - `full` recalcula todos los hashes; también se fuerza si el índice no
 *   coincide con el hash del último snapshot (no se fía de él).
 * - Renombrado = baja + alta con el mismo hash (emparejado 1 a 1, en orden).
 * - Secretos: nunca se abren (hash null). Archivos > `maxHashBytes`: hash null.
 * - Un escaneo que falla, lanza o se interrumpe no toca el índice ni los
 *   snapshots: el último snapshot válido sigue siendo el vigente.
 * - Nunca guarda contenido: solo ruta, metadatos y hash.
 */

export interface ScanTarget {
  projectId: string;
  rootPath: string;
  fingerprint: ProjectFingerprint;
}

export interface RunScanOptions extends ScanTarget {
  mode: ScanMode;
  trigger: ScanTrigger;
  /** Directorio de datos de Saiki-IA y cualquier otra ruta que no se lista. */
  excludePaths?: string[];
  maxFiles?: number;
  /** Tamaño máximo para calcular el hash (D10: 20 MB). */
  maxHashBytes?: number;
  /**
   * Ids (pruebas); por defecto, aleatorios. (T5) Si `scanId` es un escaneo
   * `queued` de este proyecto (lo crea el scheduler al encolar), se usa ese.
   */
  scanId?: string;
  snapshotId?: string;
  runner?: ProcessRunner;
  gitCommand?: string;
  /** Hashes en paralelo. */
  hashConcurrency?: number;
  /** (T5) HEAD y firma de frescura al empezar; se guardan en el escaneo. */
  gitHead?: string | null;
  signature?: string | null;
  /** (T6) Progreso real: tras listar y a medida que se calculan hashes. No debe lanzar. */
  onProgress?: (p: ScanProgress) => void;
  /** Punto de prueba: se llama antes de calcular cada hash. */
  beforeHash?: (path: string) => void | Promise<void>;
}

export interface ScanProgress {
  phase: "hashing";
  /** Archivos listados. */
  listed: number;
  /** Archivos cuyo hash hay que calcular en este escaneo y cuántos van. */
  toHash: number;
  hashed: number;
}

export interface ScanChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export type RunScanResult =
  | {
      ok: true;
      scan: ScanRecord;
      snapshot: SnapshotRecord;
      changes: ScanChanges;
      /** true si se recalcularon todos los hashes sin pedirlo (índice no fiable). */
      forcedFull: boolean;
    }
  | { ok: false; code: "scan_in_progress"; message: string; activeScanId: string }
  | { ok: false; code: "scan_failed"; message: string; scan: ScanRecord };

export const DEFAULT_MAX_HASH_BYTES = 20 * 1024 * 1024;
/** Margen "racy": mtime a menos de esto del inicio del escaneo que lo leyó. */
const RACY_WINDOW_MS = 2000;

/** Hash del índice: (ruta, tipo, hash) ordenado por ruta. */
export function computeIndexHash(files: Iterable<Pick<FileRecord, "path" | "kind" | "hash">>): string {
  const rows = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash("sha256");
  for (const f of rows) h.update(`${f.path}\0${f.kind}\0${f.hash ?? ""}\n`);
  return h.digest("hex");
}

/** (T6) Cambios a guardar con el escaneo: como mucho `MAX_CHANGES_PER_KIND` por tipo. */
function capChanges(c: ScanChanges) {
  const cap = <T>(xs: T[]) => xs.slice(0, MAX_CHANGES_PER_KIND);
  return {
    added: cap(c.added),
    modified: cap(c.modified),
    deleted: cap(c.deleted),
    renamed: cap(c.renamed),
    truncated: [c.added, c.modified, c.deleted, c.renamed].some((xs) => xs.length > MAX_CHANGES_PER_KIND),
  };
}

/** Hasta este tamaño el archivo se lee de una vez (un stream por archivo pequeño es lento). */
const READ_WHOLE_BYTES = 1024 * 1024;

/** sha256 del archivo sin seguir un enlace simbólico en el último componente. */
async function hashFile(abs: string, size: number): Promise<string> {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const h = createHash("sha256");
    if (size <= READ_WHOLE_BYTES) {
      h.update(await fh.readFile());
    } else {
      for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    }
    return h.digest("hex");
  } finally {
    await fh.close();
  }
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(workers);
}

/** Ejecuta un escaneo completo o incremental del proyecto y publica su snapshot. */
export async function runScan(store: ContextStore, o: RunScanOptions): Promise<RunScanResult> {
  const queued = o.scanId ? store.getScan(o.scanId) : null;
  const own = queued !== null && queued.status === "queued" && queued.projectId === o.projectId;
  const active = store.activeScans(o.projectId).filter((s) => !own || s.id !== queued.id);
  if (active.length > 0) {
    return { ok: false, code: "scan_in_progress", message: "Ya hay un escaneo en curso para este proyecto.", activeScanId: active[0].id };
  }
  const scanId = own ? queued.id : (o.scanId ?? `scan-${randomUUID()}`);
  // Síncrono entre la comprobación y el alta: en este proceso no se intercala otro escaneo.
  if (!own) {
    store.createScan({ id: scanId, projectId: o.projectId, mode: o.mode, trigger: o.trigger, rootPath: o.rootPath, fingerprint: o.fingerprint });
  }
  store.startScan(scanId, undefined, { gitHead: o.gitHead, signature: o.signature });

  try {
    const listed = await scanProjectFiles({
      rootPath: o.rootPath,
      fingerprint: o.fingerprint,
      excludePaths: o.excludePaths,
      maxFiles: o.maxFiles,
      runner: o.runner,
      gitCommand: o.gitCommand,
    });
    if (!listed.ok) {
      return { ok: false, code: "scan_failed", message: listed.message, scan: store.failScan(scanId, `${listed.code}: ${listed.message}`) };
    }
    const listing = listed.listing;

    // Índice anterior = el del último snapshot. Si no cuadra, no se reutiliza nada.
    const prev = store.fileMap(o.projectId);
    const latest = store.latestSnapshot(o.projectId);
    const trusted = latest ? computeIndexHash(prev.values()) === latest.indexHash : prev.size === 0;
    const forcedFull = o.mode === "incremental" && !trusted;
    const reuseAllowed = o.mode === "incremental" && trusted;

    const scanStart = new Map<string, number>();
    const startedAtOf = (id: string): number | null => {
      if (!scanStart.has(id)) {
        const s = store.getScan(id)?.startedAt;
        scanStart.set(id, s ? Date.parse(s) : NaN);
      }
      const v = scanStart.get(id)!;
      return Number.isNaN(v) ? null : v;
    };
    const reusable = (f: ScannedFile, p: FileRecord | undefined): p is FileRecord => {
      if (!reuseAllowed || !p || p.hash === null) return false;
      if (p.size !== f.size || p.mtimeMs !== f.mtimeMs || p.kind !== f.kind) return false;
      const readAt = startedAtOf(p.lastScanId);
      return readAt !== null && f.mtimeMs < readAt - RACY_WINDOW_MS;
    };

    const maxHash = o.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
    const rows: FileRecord[] = [];
    const toHash: Array<{ file: ScannedFile; row: FileRecord }> = [];
    for (const f of listing.files) {
      const p = prev.get(f.path);
      const row: FileRecord = { ...f, hash: null, lastScanId: scanId };
      rows.push(row);
      if (f.kind === "secret" || f.size > maxHash) continue; // sin hash; un secreto no se abre
      if (reusable(f, p)) {
        row.hash = p.hash;
        row.lastScanId = p.lastScanId; // se conserva quién lo leyó (ventana racy)
      } else {
        toHash.push({ file: f, row });
      }
    }

    // Archivos que desaparecen o no se pueden leer entre el listado y el hash:
    // no entran en el índice (se tratan como no presentes).
    const vanished = new Set<string>();
    let hashed = 0;
    const progress = () => o.onProgress?.({ phase: "hashing", listed: listing.files.length, toHash: toHash.length, hashed });
    progress();
    await pool(toHash, o.hashConcurrency ?? 8, async ({ file, row }) => {
      await o.beforeHash?.(file.path);
      try {
        row.hash = await hashFile(join(o.rootPath, file.path), file.size);
      } catch {
        vanished.add(file.path);
      }
      hashed++;
      progress();
    });
    const next = vanished.size === 0 ? rows : rows.filter((r) => !vanished.has(r.path));

    // Diferencias con el índice anterior.
    const nextPaths = new Set(next.map((r) => r.path));
    const added: FileRecord[] = [];
    const modified: string[] = [];
    const upsert: FileRecord[] = [];
    for (const r of next) {
      const p = prev.get(r.path);
      if (!p) {
        added.push(r);
        upsert.push(r);
      } else if (p.hash !== r.hash || p.kind !== r.kind || (r.hash === null && (p.size !== r.size || p.mtimeMs !== r.mtimeMs))) {
        modified.push(r.path);
        upsert.push(r);
      } else if (p.size !== r.size || p.mtimeMs !== r.mtimeMs || p.lastScanId !== r.lastScanId || p.lang !== r.lang) {
        upsert.push(r); // mismo contenido; se actualizan metadatos
      }
    }
    const deletedRecords = [...prev.values()].filter((p) => !nextPaths.has(p.path)).sort((a, b) => (a.path < b.path ? -1 : 1));

    // Renombrados: baja + alta con el mismo hash, emparejados 1 a 1.
    const addedByHash = new Map<string, FileRecord[]>();
    for (const a of added) if (a.hash) addedByHash.set(a.hash, [...(addedByHash.get(a.hash) ?? []), a]);
    const renamed: Array<{ from: string; to: string }> = [];
    const renamedTo = new Set<string>();
    const deleted: string[] = [];
    for (const d of deletedRecords) {
      const candidates = d.hash ? addedByHash.get(d.hash) : undefined;
      const match = candidates?.shift();
      if (match) {
        renamed.push({ from: d.path, to: match.path });
        renamedTo.add(match.path);
      } else {
        deleted.push(d.path);
      }
    }
    const changes: ScanChanges = {
      added: added.filter((a) => !renamedTo.has(a.path)).map((a) => a.path),
      modified,
      deleted,
      renamed,
    };

    const skipped = listing.skipped.reduce((n, s) => n + s.count, 0) + vanished.size;
    const stats: ScanStats = {
      listed: listing.files.length,
      hashed: toHash.length - vanished.size,
      added: changes.added.length,
      modified: changes.modified.length,
      deleted: changes.deleted.length,
      renamed: changes.renamed.length,
      skipped,
      truncated: listing.truncated,
    };
    // (T4) Resumen técnico: extractores deterministas sobre el índice nuevo.
    const summary = await buildSummary({
      rootPath: o.rootPath,
      files: next,
      source: listing.source,
      truncated: listing.truncated,
      ...(listing.gitError ? { gitError: listing.gitError } : {}),
    });
    const done = store.completeScan(
      scanId,
      stats,
      { id: o.snapshotId ?? `snap-${randomUUID()}`, indexHash: computeIndexHash(next), summary: summary as unknown as Record<string, unknown> },
      new Date().toISOString(),
      { upsert, delete: deletedRecords.map((d) => d.path) },
      capChanges(changes),
    );
    return { ok: true, scan: done.scan, snapshot: done.snapshot, changes, forcedFull };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let scan: ScanRecord;
    try {
      scan = store.failScan(scanId, `error inesperado: ${message}`);
    } catch {
      // Ya terminado por otro camino (p. ej. marcado `interrupted` por una
      // recuperación): se deja como está; su índice y snapshot no se tocaron.
      scan = store.getScan(scanId)!;
    }
    return { ok: false, code: "scan_failed", message, scan };
  }
}

export interface RecoveryEntry {
  projectId: string;
  interruptedScanIds: string[];
  outcome: "rescanned" | "failed" | "skipped_repeat" | "skipped_unavailable";
  detail?: string;
  scanId?: string;
}

/**
 * (D9) Recuperación al arrancar: marca como `interrupted` los escaneos que
 * quedaron `queued`/`running` en el proceso anterior y relanza UNA vez un
 * escaneo incremental por proyecto. No se relanza si el interrumpido ya era
 * una recuperación (evita un bucle con un repositorio que tumba el proceso) ni
 * si el proyecto ya no está disponible (`resolve` devuelve null).
 */
export async function recoverInterruptedScans(
  store: ContextStore,
  resolve: (projectId: string) => ScanTarget | null,
  options: Omit<RunScanOptions, keyof ScanTarget | "mode" | "trigger" | "scanId" | "snapshotId"> = {},
): Promise<RecoveryEntry[]> {
  const interrupted = store.interruptActiveScans("el backend se reinició durante el escaneo");
  const byProject = new Map<string, ScanRecord[]>();
  for (const s of interrupted) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);

  const report: RecoveryEntry[] = [];
  for (const [projectId, scans] of [...byProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ids = scans.map((s) => s.id);
    if (scans.some((s) => s.trigger === "restart")) {
      report.push({ projectId, interruptedScanIds: ids, outcome: "skipped_repeat", detail: "la recuperación anterior también se interrumpió" });
      continue;
    }
    const target = resolve(projectId);
    if (!target) {
      report.push({ projectId, interruptedScanIds: ids, outcome: "skipped_unavailable", detail: "el proyecto no está activo o no existe" });
      continue;
    }
    const r = await runScan(store, { ...options, ...target, mode: "incremental", trigger: "restart" });
    report.push(
      r.ok
        ? { projectId, interruptedScanIds: ids, outcome: "rescanned", scanId: r.scan.id }
        : { projectId, interruptedScanIds: ids, outcome: "failed", detail: r.message, ...(r.code === "scan_failed" ? { scanId: r.scan.id } : {}) },
    );
  }
  return report;
}
