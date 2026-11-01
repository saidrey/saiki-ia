import { randomUUID } from "node:crypto";
import type { ContextStore, ScanMode, ScanRecord, ScanTrigger, SnapshotRecord } from "./context-store.js";
import { computeFreshness, type Freshness } from "./freshness.js";
import { runScan, type RunScanOptions, type ScanProgress, type ScanTarget } from "./incremental-scan.js";

/**
 * (Project Context, T5) Scheduler de escaneos en segundo plano.
 *
 * - Un escaneo activo por proyecto: pedir otro mientras hay uno `queued` o
 *   `running` devuelve ese (lo garantiza también un índice único en
 *   `context_scans`). Máximo `maxConcurrent` (2) en total; el resto espera en
 *   cola, persistido como `queued`.
 * - El proyecto se vuelve a comprobar al salir de la cola: si se desactivó o su
 *   repositorio ya no está disponible, el escaneo termina `failed` sin listar.
 * - El snapshot solo lo publica `runScan` al terminar bien, en una transacción.
 *   Un fallo, un tiempo agotado o un cierre del proceso no tocan el último
 *   snapshot válido.
 * - Reinicio: los escaneos que quedaron `queued`/`running` pasan a
 *   `interrupted` y se reencolan una vez como incrementales (reglas de T3).
 * - Nunca bloquea al llamador: `request` es síncrono y el trabajo corre en
 *   segundo plano con E/S asíncrona.
 */

export type ScanTargetErrorCode = "project_not_found" | "project_inactive" | "project_unhealthy";

export type ScanTargetResolution = { ok: true; target: ScanTarget } | { ok: false; code: ScanTargetErrorCode; message: string };

export type ScanRequestResult =
  | { ok: true; scan: ScanRecord; /** true si se devolvió un escaneo ya activo. */ deduplicated: boolean }
  | { ok: false; code: ScanTargetErrorCode | "scheduler_closed"; message: string };

export interface ScanRequest {
  mode: ScanMode;
  trigger: ScanTrigger;
}

export interface SchedulerRecoveryEntry {
  projectId: string;
  interruptedScanIds: string[];
  outcome: "requeued" | "skipped_repeat" | "skipped_unavailable";
  scanId?: string;
  detail?: string;
}

export interface SchedulerStartReport {
  recovered: SchedulerRecoveryEntry[];
  /** Proyectos activos sin snapshot a los que se encoló el escaneo inicial. */
  initial: string[];
}

/**
 * (T6) Hechos del ciclo de vida de un escaneo, en el orden en que ocurren. El
 * Core los publica como eventos; el scheduler no conoce el bus.
 */
export type ScanLifecycleEvent =
  | { kind: "queued"; scan: ScanRecord }
  | { kind: "started"; scan: ScanRecord }
  | { kind: "progress"; scan: ScanRecord; progress: ScanProgress }
  | { kind: "completed"; scan: ScanRecord; snapshot: SnapshotRecord }
  | { kind: "failed"; scan: ScanRecord }
  | { kind: "interrupted"; scan: ScanRecord };

/** Intervalo mínimo entre dos eventos de progreso del mismo escaneo (§10). */
export const PROGRESS_INTERVAL_MS = 2000;

export interface ScanSchedulerOptions {
  store: ContextStore;
  /** Proyecto escaneable (activo y disponible) o motivo por el que no lo es. */
  resolveTarget: (projectId: string) => ScanTargetResolution;
  /** Ids de los proyectos activos (escaneo inicial al arrancar). */
  listActiveProjects: () => string[];
  /** Rutas absolutas que nunca se listan (directorio de datos). */
  excludePaths?: string[];
  /** Escaneos simultáneos en total (D: 2). */
  maxConcurrent?: number;
  /** Tiempo máximo de un escaneo (D: 10 min). */
  timeoutMs?: number;
  /** Opciones del motor incremental (límites; puntos de prueba). */
  scan?: Pick<RunScanOptions, "maxFiles" | "maxHashBytes" | "runner" | "gitCommand" | "hashConcurrency" | "beforeHash">;
  /** Firma de frescura (inyectable en pruebas). */
  freshness?: (rootPath: string) => Promise<Freshness>;
  /** (T6) Observador del ciclo de vida (eventos). Sus errores no afectan al escaneo. */
  onEvent?: (e: ScanLifecycleEvent) => void;
  /** (T6) Intervalo mínimo entre eventos de progreso (pruebas). */
  progressIntervalMs?: number;
}

export const DEFAULT_MAX_CONCURRENT_SCANS = 2;
export const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

const TERMINAL = new Set(["completed", "failed", "interrupted"]);

export class ScanScheduler {
  private readonly queue: string[] = [];
  /** scanId → proyecto, mientras `runScan` no ha terminado (aunque el escaneo ya conste como fallido). */
  private readonly running = new Map<string, string>();
  private readonly waiters = new Map<string, Array<{ resolve: (s: ScanRecord) => void; reject: (e: Error) => void }>>();
  /** Proyectos con un cambio aplicado durante su escaneo en curso: se reescanean al terminar. */
  private readonly followUp = new Set<string>();
  private readonly settled: Array<() => void> = [];
  private pumpScheduled = false;
  private closed = false;

  constructor(private readonly o: ScanSchedulerOptions) {}

  /**
   * Arranque: recupera los escaneos interrumpidos por un reinicio y encola el
   * escaneo inicial de los proyectos activos sin snapshot. Síncrono; el trabajo
   * corre después en segundo plano.
   */
  start(): SchedulerStartReport {
    const { store } = this.o;
    const interrupted = store.interruptActiveScans("el backend se reinició durante el escaneo");
    for (const scan of interrupted) this.emit({ kind: "interrupted", scan });
    const byProject = new Map<string, ScanRecord[]>();
    for (const s of interrupted) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);

    const recovered: SchedulerRecoveryEntry[] = [];
    const repeat = new Set<string>();
    for (const [projectId, scans] of [...byProject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ids = scans.map((s) => s.id);
      // Una recuperación que también se interrumpió no se repite (evita un bucle
      // con un repositorio que tumba el proceso).
      if (scans.some((s) => s.trigger === "restart")) {
        repeat.add(projectId);
        recovered.push({ projectId, interruptedScanIds: ids, outcome: "skipped_repeat", detail: "la recuperación anterior también se interrumpió" });
        continue;
      }
      const r = this.request(projectId, { mode: "incremental", trigger: "restart" });
      recovered.push(
        r.ok
          ? { projectId, interruptedScanIds: ids, outcome: "requeued", scanId: r.scan.id }
          : { projectId, interruptedScanIds: ids, outcome: "skipped_unavailable", detail: r.message },
      );
    }

    const initial: string[] = [];
    for (const projectId of this.o.listActiveProjects()) {
      if (repeat.has(projectId) || byProject.has(projectId)) continue;
      const r = this.ensureInitialScan(projectId);
      if (r?.ok && !r.deduplicated) initial.push(projectId);
    }
    return { recovered, initial };
  }

  /** Encola un escaneo, o devuelve el activo del proyecto si ya hay uno. */
  request(projectId: string, req: ScanRequest): ScanRequestResult {
    if (this.closed) return { ok: false, code: "scheduler_closed", message: "El scheduler de escaneos está cerrado." };
    const active = this.o.store.activeScans(projectId)[0];
    if (active) {
      // Un cambio aplicado mientras el escaneo ya lista o calcula hashes puede
      // quedar fuera de él: se repite al terminar (uno, aunque lleguen varios).
      if (req.trigger === "post_apply" && active.status === "running") this.followUp.add(projectId);
      return { ok: true, scan: active, deduplicated: true };
    }
    const target = this.o.resolveTarget(projectId);
    if (!target.ok) return target;
    const scan = this.o.store.createScan({
      id: `scan-${randomUUID()}`,
      projectId,
      mode: req.mode,
      trigger: req.trigger,
      rootPath: target.target.rootPath,
      fingerprint: target.target.fingerprint,
    });
    this.queue.push(scan.id);
    this.emit({ kind: "queued", scan });
    this.schedulePump();
    return { ok: true, scan, deduplicated: false };
  }

  /** Escaneo inicial (`full`, `registered`) si el proyecto no tiene snapshot ni escaneo activo. */
  ensureInitialScan(projectId: string): ScanRequestResult | null {
    if (this.o.store.latestSnapshot(projectId) || this.o.store.activeScans(projectId).length > 0) return null;
    return this.request(projectId, { mode: "full", trigger: "registered" });
  }

  /** Resuelve cuando el escaneo termina (completed, failed o interrupted). */
  wait(scanId: string): Promise<ScanRecord> {
    const now = this.o.store.getScan(scanId);
    if (!now) return Promise.reject(new Error(`Escaneo no encontrado: "${scanId}".`));
    if (TERMINAL.has(now.status) && !this.running.has(scanId)) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      this.waiters.set(scanId, [...(this.waiters.get(scanId) ?? []), { resolve, reject }]);
    });
  }

  /** Resuelve cuando no queda nada en cola ni en curso. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0 && !this.pumpScheduled) return Promise.resolve();
    return new Promise((r) => this.settled.push(r));
  }

  /** Escaneos en curso en este proceso (para pruebas y diagnóstico). */
  get runningCount(): number {
    return this.running.size;
  }

  /**
   * Deja de lanzar escaneos. Los que están en curso no publican nada si la base
   * de datos se cierra después; quedan `running`/`queued` y el siguiente
   * arranque los recupera.
   */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
    for (const [id, ws] of this.waiters) for (const w of ws) w.reject(new Error(`El scheduler se cerró antes de terminar el escaneo "${id}".`));
    this.waiters.clear();
    for (const r of this.settled.splice(0)) r();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    const max = this.o.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SCANS;
    while (!this.closed && this.running.size < max && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const scan = this.o.store.getScan(id);
      if (!scan || scan.status !== "queued") continue;
      const target = this.o.resolveTarget(scan.projectId);
      if (!target.ok) {
        this.emit({ kind: "failed", scan: this.o.store.failScan(id, `${target.code}: ${target.message}`) });
        this.notify(id);
        continue;
      }
      this.running.set(id, scan.projectId);
      void this.execute(scan).finally(() => this.finish(id, scan.projectId));
    }
    this.checkIdle();
  }

  private async execute(scan: ScanRecord): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOutFlag = { value: false };
    try {
      const fresh = await (this.o.freshness ?? computeFreshness)(scan.rootPath).catch(() => null);
      if (this.closed) return;
      const interval = this.o.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
      let lastProgress = 0;
      const run = runScan(this.o.store, {
        ...this.o.scan,
        projectId: scan.projectId,
        rootPath: scan.rootPath,
        fingerprint: scan.fingerprint,
        mode: scan.mode,
        trigger: scan.trigger,
        scanId: scan.id,
        excludePaths: this.o.excludePaths,
        gitHead: fresh?.gitHead ?? null,
        signature: fresh?.signature ?? null,
        // Primer aviso tras listar (ya se sabe cuántos hashes faltan); los
        // siguientes, como mucho uno cada `interval`. Sin hashes pendientes no hay progreso que contar.
        onProgress: (progress) => {
          const now = Date.now();
          if (progress.toHash === 0 || (progress.hashed > 0 && now - lastProgress < interval)) return;
          lastProgress = now;
          this.emitFresh("progress", scan.id, progress);
        },
      });
      // runScan pasa el escaneo a `running` antes de su primer await.
      this.emitFresh("started", scan.id);
      const timeoutMs = this.o.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          // El escaneo queda `failed`; si `runScan` termina después, ya no puede publicar.
          if (!this.closed) {
            try {
              const failed = this.o.store.failScan(scan.id, `superó el tiempo máximo de ${Math.round(timeoutMs / 1000)} s`);
              timedOutFlag.value = true;
              this.emit({ kind: "failed", scan: failed });
            } catch {
              // ya había terminado
            }
            this.notify(scan.id, true);
          }
          resolve();
        }, timeoutMs);
        timer.unref();
      });
      await Promise.race([run, timedOut]);
      const result = await run;
      if (this.closed) return;
      if (result.ok) this.emit({ kind: "completed", scan: result.scan, snapshot: result.snapshot });
      else if (result.code === "scan_failed" && result.scan.status === "failed" && !timedOutFlag.value) this.emit({ kind: "failed", scan: result.scan });
    } catch {
      // runScan no lanza salvo que la base de datos ya no esté disponible (cierre).
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(id: string, projectId: string): void {
    this.running.delete(id);
    if (this.closed) return;
    this.notify(id);
    if (this.followUp.delete(projectId)) this.request(projectId, { mode: "incremental", trigger: "post_apply" });
    this.schedulePump();
  }

  /** Avisa a quien espera el escaneo. `early`: ya es terminal aunque runScan siga. */
  private notify(id: string, early = false): void {
    if (!early && this.running.has(id)) return;
    const scan = this.o.store.getScan(id);
    if (!scan || !TERMINAL.has(scan.status)) return;
    const ws = this.waiters.get(id);
    this.waiters.delete(id);
    for (const w of ws ?? []) w.resolve(scan);
  }

  private emit(e: ScanLifecycleEvent): void {
    try {
      this.o.onEvent?.(e);
    } catch {
      // un observador defectuoso no afecta a los escaneos
    }
  }

  /** Emite con el escaneo tal como está ahora en el store (estado y fechas al día). */
  private emitFresh(kind: "started" | "progress", scanId: string, progress?: ScanProgress): void {
    const scan = this.o.store.getScan(scanId);
    if (!scan || scan.status !== "running") return;
    if (kind === "started") this.emit({ kind, scan });
    else this.emit({ kind, scan, progress: progress! });
  }

  private checkIdle(): void {
    if (this.queue.length === 0 && this.running.size === 0 && !this.pumpScheduled) {
      for (const r of this.settled.splice(0)) r();
    }
  }
}
