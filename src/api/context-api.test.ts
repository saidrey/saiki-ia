import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "../projects/test-flow.js";
import { DATA_DIR_ENV, resolveDataPaths, type DataPaths } from "../persistence/data-dir.js";
import type { SaikiCoreOptions } from "../core/saiki-core.js";

/**
 * (Project Context, T6) API REST y SSE del contexto de proyectos: servidor HTTP
 * real sobre Core, scheduler y SQLite reales (`SAIKI_DATA_DIR` externo).
 */

class HashGate {
  private readonly holds = new Map<string, { started: () => void; release: Promise<void> }>();
  private readonly failures = new Set<string>();
  hold(path: string): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    this.holds.set(path, { started, release: new Promise<void>((r) => (release = r)) });
    return { started: startedP, release };
  }
  failOn(path: string): void {
    this.failures.add(path);
  }
  readonly beforeHash = async (path: string): Promise<void> => {
    if (this.failures.delete(path)) throw new Error(`fallo simulado al leer ${path}`);
    const h = this.holds.get(path);
    if (!h) return;
    this.holds.delete(path);
    h.started();
    await h.release;
  };
}

interface SseEvent {
  id: number | null;
  event: string;
  data: Record<string, any>;
}

/** Cliente SSE mínimo: acumula los eventos y permite esperar a uno concreto. */
class SseClient {
  readonly events: SseEvent[] = [];
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private waiters: Array<() => void> = [];
  private constructor(private readonly controller: AbortController) {}

  static async open(url: string, headers: Record<string, string> = {}): Promise<{ status: number; client: SseClient | null; body?: any }> {
    const controller = new AbortController();
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal });
    if (res.status !== 200) return { status: res.status, client: null, body: await res.json() };
    const client = new SseClient(controller);
    void client.pump(res.body!.getReader());
    return { status: 200, client };
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        let i: number;
        while ((i = this.buffer.indexOf("\n\n")) >= 0) {
          const block = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 2);
          const ev: SseEvent = { id: null, event: "message", data: {} };
          let has = false;
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) {
              ev.data = JSON.parse(line.slice(6));
              has = true;
            }
          }
          if (has) this.events.push(ev);
        }
        for (const w of this.waiters.splice(0)) w();
      }
    } catch {
      // abortado
    }
  }

  types(): string[] {
    return this.events.filter((e) => e.event !== "control").map((e) => e.event);
  }

  async until(pred: (evs: SseEvent[]) => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.events)) {
      if (Date.now() > deadline) throw new Error(`SSE: tiempo agotado; recibidos: ${this.types().join(", ")}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close(): void {
    this.controller.abort();
  }
}

let repos: TempRepos;
let dataRoot: string;
let data: DataPaths;
let gate: HashGate;
let srv: TestServer;
const clients: SseClient[] = [];

async function start(contextScan: SaikiCoreOptions["contextScan"] = {}, withContext = true): Promise<void> {
  srv = await startTestServer({
    dir: repos.base,
    agent: new FlowAgent(),
    ...(withContext ? { data } : { persist: true }),
    contextScan: { progressIntervalMs: 0, ...contextScan, scan: { beforeHash: gate.beforeHash, hashConcurrency: 1, ...contextScan.scan } },
  });
}
const base = () => `http://127.0.0.1:${(srv.handle.server.address() as AddressInfo).port}`;
const api = (method: string, path: string, body?: unknown) => srv.api(method, path, body);
async function sse(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const r = await SseClient.open(`${base()}${path}`, headers);
  if (!r.client) throw new Error(`SSE ${path}: ${r.status}`);
  clients.push(r.client);
  return r.client;
}
async function register(name: string, files: Record<string, string> = {}) {
  const r = await api("POST", "/projects", { name, path: repos.repo(name, { "README.md": `# ${name}\n`, ...files }) });
  expect(r.status).toBe(201);
  return r.json.project as { id: string; rootPath: string };
}
const context = async (id: string) => (await api("GET", `/projects/${id}/context`)).json.context;
const idle = () => srv.core.contextIdle();

beforeEach(() => {
  repos = new TempRepos();
  dataRoot = mkdtempSync(join(tmpdir(), "saiki-data-"));
  const r = resolveDataPaths({ [DATA_DIR_ENV]: join(dataRoot, "data") }, repos.base);
  if (!r.ok) throw new Error(r.message);
  data = r.paths;
  gate = new HashGate();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await srv?.stop().catch(() => undefined);
  repos.cleanup();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("REST: estado, snapshot, escaneos y archivos", () => {
  it("contexto sin snapshot (escaneando) y con snapshot; sin rutas absolutas, huellas, firmas ni hashes de archivos", async () => {
    await start();
    const held = gate.hold("src/index.ts");
    const p = await register("app", { "package.json": '{"name":"app"}', "src/index.ts": "export {};\n", ".env": "TOKEN=x\n" });
    await held.started;

    const during = await context(p.id);
    expect(during).toMatchObject({ projectId: p.id, status: "scanning", snapshot: null, lastScan: null, stale: null });
    expect(Object.keys(during.currentScan).sort()).toEqual(
      ["createdAt", "error", "finishedAt", "gitHead", "id", "mode", "projectId", "startedAt", "stats", "status", "trigger"].sort(),
    );

    held.release();
    await idle();
    const r = await api("GET", `/projects/${p.id}/context`);
    expect(r.status).toBe(200);
    const ctx = r.json.context;
    expect(ctx).toMatchObject({
      status: "ready",
      currentScan: null,
      lastScan: { status: "completed", trigger: "registered", mode: "full", stats: { listed: 4 } },
      snapshot: { scanId: ctx.lastScan.id, summary: { schemaVersion: 2, ecosystems: [{ kind: "node", name: "app" }] } },
    });
    expect(Object.keys(ctx.snapshot).sort()).toEqual(["createdAt", "id", "scanId", "summary"]);
    const raw = JSON.stringify(r.json);
    expect(raw).not.toContain(p.rootPath);
    expect(raw).not.toMatch(/fingerprint|"signature"|indexHash/);

    const files = (await api("GET", `/projects/${p.id}/context/files`)).json;
    expect(files.files).toEqual([
      { path: ".env", kind: "secret", lang: null, size: 8, mtimeMs: expect.any(Number) },
      { path: "README.md", kind: "doc", lang: "markdown", size: 6, mtimeMs: expect.any(Number) },
      { path: "package.json", kind: "manifest", lang: "json", size: 14, mtimeMs: expect.any(Number) },
      { path: "src/index.ts", kind: "source", lang: "typescript", size: 11, mtimeMs: expect.any(Number) },
    ]);
    expect(files.nextCursor).toBeNull();
  });

  it("solicitud manual (202), duplicada mientras corre, historial y detalle con cambios", async () => {
    await start();
    const p = await register("app", { "a.ts": "1\n", "b.ts": "1\n" });
    await idle();

    writeFileSync(join(p.rootPath, "a.ts"), "2\n");
    rmSync(join(p.rootPath, "b.ts"));
    writeFileSync(join(p.rootPath, "c.ts"), "nuevo\n");
    const held = gate.hold("a.ts");
    const first = await api("POST", `/projects/${p.id}/context/scan`, {});
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ deduplicated: false, scan: { status: "queued", mode: "incremental", trigger: "manual" } });
    await held.started;
    const dup = await api("POST", `/projects/${p.id}/context/scan`, { mode: "full" });
    expect(dup.status).toBe(202);
    expect(dup.json).toMatchObject({ deduplicated: true, scan: { id: first.json.scan.id, status: "running" } });
    expect((await api("POST", `/projects/${p.id}/context/scan`, { mode: "rapido" })).status).toBe(400);
    held.release();
    await idle();

    const history = (await api("GET", `/projects/${p.id}/context/scans`)).json;
    expect(history.scans.map((s: any) => [s.trigger, s.status])).toEqual([["manual", "completed"], ["registered", "completed"]]);
    expect((await api("GET", `/projects/${p.id}/context/scans?limit=1`)).json.scans).toHaveLength(1);
    expect((await api("GET", `/projects/${p.id}/context/scans?limit=0`)).status).toBe(400);

    const detail = (await api("GET", `/projects/${p.id}/context/scans/${first.json.scan.id}`)).json.scan;
    expect(detail).toMatchObject({
      status: "completed",
      stats: { added: 1, modified: 1, deleted: 1, renamed: 0 },
      changes: { added: ["c.ts"], modified: ["a.ts"], deleted: ["b.ts"], renamed: [], truncated: false },
    });
    const ctx = await context(p.id);
    expect(detail.snapshotId).toBe(ctx.snapshot.id);
    const snap = await api("GET", `/projects/${p.id}/context/snapshots/${detail.snapshotId}`);
    expect(snap.status).toBe(200);
    expect(snap.json.snapshot).toMatchObject({ id: detail.snapshotId, scanId: detail.id, summary: { files: 3 } });

    const initial = history.scans[1];
    const old = (await api("GET", `/projects/${p.id}/context/scans/${initial.id}`)).json.scan;
    expect(old.changes.added.sort()).toEqual(["README.md", "a.ts", "b.ts"]);
  });

  it("paginación y filtros de archivos", async () => {
    await start();
    const p = await register("app", { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n", "docs/x.md": "x\n" });
    await idle();
    const page1 = (await api("GET", `/projects/${p.id}/context/files?kind=source&limit=2`)).json;
    expect(page1.files.map((f: any) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(page1.nextCursor).toBe("src/b.ts");
    const page2 = (await api("GET", `/projects/${p.id}/context/files?kind=source&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`)).json;
    expect(page2).toMatchObject({ files: [{ path: "src/c.ts" }], nextCursor: null });
    expect((await api("GET", `/projects/${p.id}/context/files?prefix=docs/`)).json.files.map((f: any) => f.path)).toEqual(["docs/x.md"]);
    expect((await api("GET", `/projects/${p.id}/context/files?kind=bogus`)).status).toBe(400);
  });
});

describe("REST: aislamiento y errores", () => {
  it("un escaneo o snapshot de otro proyecto no se ve desde éste", async () => {
    await start();
    const a = await register("a", { "a.ts": "a\n" });
    const b = await register("b", { "b.ts": "b\n" });
    await idle();
    const ca = await context(a.id);
    const cb = await context(b.id);
    expect((await api("GET", `/projects/${b.id}/context/scans/${ca.lastScan.id}`)).status).toBe(404);
    expect((await api("GET", `/projects/${b.id}/context/snapshots/${ca.snapshot.id}`)).status).toBe(404);
    expect((await api("GET", `/projects/${a.id}/context/scans`)).json.scans.map((s: any) => s.id)).toEqual([ca.lastScan.id]);
    expect((await api("GET", `/projects/${b.id}/context/files`)).json.files.map((f: any) => f.path)).toEqual(["README.md", "b.ts"]);
    expect(cb.snapshot.id).not.toBe(ca.snapshot.id);
  });

  it("proyecto inexistente → 404; desactivado o movido → 409; el snapshot se conserva", async () => {
    await start();
    for (const path of ["/context", "/context/scans", "/context/scans/x", "/context/snapshots/x", "/context/files"]) {
      expect((await api("GET", `/projects/prj-nope${path}`)).status, path).toBe(404);
    }
    expect((await api("POST", "/projects/prj-nope/context/scan", {})).json).toMatchObject({ error: "project_not_found" });

    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    const snap = (await context(p.id)).snapshot.id;
    await api("POST", `/projects/${p.id}/deactivate`);
    const inactive = await api("POST", `/projects/${p.id}/context/scan`, {});
    expect([inactive.status, inactive.json.error]).toEqual([409, "project_inactive"]);
    await api("POST", `/projects/${p.id}/activate`);

    renameSync(p.rootPath, `${p.rootPath}-movido`);
    const moved = await api("POST", `/projects/${p.id}/context/scan`, {});
    expect([moved.status, moved.json.error]).toEqual([409, "project_unhealthy"]);
    expect(await context(p.id)).toMatchObject({ status: "stale", snapshot: { id: snap }, stale: { reason: "project_unavailable" } });
  });

  it("un escaneo fallido se ve con su error saneado (sin la ruta del repositorio)", async () => {
    await start();
    gate.failOn("a.ts");
    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    const ctx = await context(p.id);
    expect(ctx).toMatchObject({ status: "failed", snapshot: null, lastScan: { status: "failed", error: expect.stringMatching(/fallo simulado/) } });
    expect(JSON.stringify(ctx)).not.toContain(p.rootPath);
  });

  it("sin contexto configurado: estado none y solicitud 501", async () => {
    await start({}, false);
    const p = await register("app");
    expect(await context(p.id)).toMatchObject({ status: "none", snapshot: null });
    const r = await api("POST", `/projects/${p.id}/context/scan`, {});
    expect([r.status, r.json.error]).toEqual([501, "context_disabled"]);
  });
});

describe("SSE de contexto", () => {
  it("ciclo de vida de un escaneo con progreso real, en orden y con proyecto y escaneo", async () => {
    await start();
    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    const stream = await sse(`/projects/${p.id}/context/events`);
    await stream.until((evs) => evs.some((e) => e.event === "context.snapshot.published"));
    const replayed = stream.events.length;

    for (let i = 0; i < 4; i++) writeFileSync(join(p.rootPath, `f${i}.ts`), `${i}\n`);
    const r = await api("POST", `/projects/${p.id}/context/scan`, { mode: "full" });
    const scanId = r.json.scan.id;
    await stream.until((evs) => evs.some((e) => e.event === "context.snapshot.published" && e.data.data.scanId === scanId));

    const live = stream.events.slice(replayed).filter((e) => e.event !== "control");
    const types = live.map((e) => e.event).filter((t) => t !== "context.freshness.changed");
    expect(types[0]).toBe("context.scan.queued");
    expect(types[1]).toBe("context.scan.started");
    expect(types.slice(-2)).toEqual(["context.scan.completed", "context.snapshot.published"]);
    const progress = live.filter((e) => e.event === "context.scan.progress").map((e) => e.data.data);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((d) => d.listed === 6 && d.toHash === 6 && d.hashed <= d.toHash)).toBe(true);
    expect(progress.map((d) => d.hashed)).toEqual([...progress.map((d) => d.hashed)].sort((x, y) => x - y));

    for (const e of live) {
      expect(e.data.projectId).toBe(p.id);
      expect(e.data.executionId).toBeUndefined();
      expect(e.id).toBe(e.data.seq);
      if (e.event.startsWith("context.scan.") || e.event === "context.snapshot.published") expect(e.data.data.scanId).toBe(scanId);
    }
    const ids = live.map((e) => e.id!);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    const completed = live.find((e) => e.event === "context.scan.completed")!.data.data;
    expect(completed).toMatchObject({ scanId, mode: "full", trigger: "manual", stats: { listed: 6, added: 4 } });
    expect(completed.snapshotId).toBe((await context(p.id)).snapshot.id);
  });

  it("reconexión con Last-Event-ID o lastEventId: solo lo posterior; brecha cero sin duplicados", async () => {
    await start();
    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    const all = await sse(`/projects/${p.id}/context/events`);
    await all.until((evs) => evs.some((e) => e.event === "context.snapshot.published"));
    const startedId = all.events.find((e) => e.event === "context.scan.started")!.id!;
    const after = all.events.filter((e) => e.id !== null && e.id > startedId).map((e) => e.id);

    const viaHeader = await sse(`/projects/${p.id}/context/events`, { "last-event-id": String(startedId) });
    await viaHeader.until((evs) => evs.filter((e) => e.id !== null).length >= after.length);
    expect(viaHeader.events.filter((e) => e.id !== null).map((e) => e.id)).toEqual(after);

    const viaQuery = await sse(`/projects/${p.id}/context/events?lastEventId=${startedId}`);
    await viaQuery.until((evs) => evs.filter((e) => e.id !== null).length >= after.length);
    expect(viaQuery.events.filter((e) => e.id !== null).map((e) => e.id)).toEqual(after);

    // Tras ponerse al día, recibe lo nuevo en vivo sin repetir.
    await api("POST", `/projects/${p.id}/context/scan`, {});
    await viaHeader.until((evs) => evs.filter((e) => e.event === "context.snapshot.published").length >= 1);
    const ids = viaHeader.events.filter((e) => e.id !== null).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aislamiento: el stream de un proyecto no recibe eventos de otro; proyecto inexistente → 404", async () => {
    await start();
    const a = await register("a", { "a.ts": "1\n" });
    const b = await register("b", { "b.ts": "1\n" });
    await idle();
    const sb = await sse(`/projects/${b.id}/context/events`);
    await sb.until((evs) => evs.some((e) => e.event === "context.freshness.changed"));
    const before = sb.events.length;
    const r = await api("POST", `/projects/${a.id}/context/scan`, {});
    await srv.core.waitForScan(r.json.scan.id);
    await new Promise((res) => setTimeout(res, 100));
    expect(sb.events.slice(before)).toEqual([]);
    expect(sb.events.every((e) => e.event === "control" || e.data.projectId === b.id)).toBe(true);

    expect((await SseClient.open(`${base()}/projects/prj-nope/context/events`)).status).toBe(404);
  });

  it("frescura: un evento al cambiar (stale ↔ ready), ninguno si no cambia", async () => {
    await start();
    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    const stream = await sse(`/projects/${p.id}/context/events`);
    const freshness = () => stream.events.filter((e) => e.event === "context.freshness.changed").map((e) => e.data.data);
    await stream.until(() => freshness().length >= 1);
    expect(freshness()).toMatchObject([{ freshness: "ready", reason: null }]);

    writeFileSync(join(p.rootPath, "nuevo.ts"), "x\n");
    await context(p.id);
    await context(p.id);
    await stream.until(() => freshness().length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(freshness()).toMatchObject([{ freshness: "ready" }, { freshness: "stale", reason: "changes_detected", changedPaths: 3 }]);

    const r = await api("POST", `/projects/${p.id}/context/scan`, {});
    await srv.core.waitForScan(r.json.scan.id);
    await stream.until(() => freshness().length >= 3);
    expect(freshness()[2]).toMatchObject({ freshness: "ready", snapshotId: (await context(p.id)).snapshot.id });
  });

  it("reinicio: interrupción y reanudación quedan en el stream; el historial sobrevive", async () => {
    await start();
    const held = gate.hold("a.ts");
    const p = await register("app", { "a.ts": "1\n" });
    await held.started;
    await srv.stop();
    held.release();

    await start();
    await idle();
    const stream = await sse(`/projects/${p.id}/context/events`);
    await stream.until((evs) => evs.some((e) => e.event === "context.snapshot.published"));
    const types = stream.types().filter((t) => t !== "context.freshness.changed" && t !== "context.scan.progress");
    expect(types).toEqual([
      "context.scan.queued",
      "context.scan.started",
      "context.scan.interrupted",
      "context.scan.queued",
      "context.scan.started",
      "context.scan.completed",
      "context.snapshot.published",
    ]);
    const interrupted = stream.events.find((e) => e.event === "context.scan.interrupted")!.data.data;
    expect(interrupted).toMatchObject({ trigger: "registered", error: "el backend se reinició durante el escaneo" });
    expect(stream.events.filter((e) => e.event === "context.scan.queued")[1].data.data.trigger).toBe("restart");
  });
});

describe("compatibilidad con los eventos de ejecuciones", () => {
  it("las ejecuciones conservan su stream; los eventos de contexto no se mezclan", async () => {
    await start();
    const p = await register("app", { "a.ts": "1\n" });
    await idle();
    await api("POST", "/sessions", { sessionId: "s1", projectId: p.id });
    const t = (await api("POST", "/sessions/s1/messages", { message: "implementa un util de suma" })).json.result.developmentThreadId;

    const exec = await sse(`/executions/${t}/events`);
    await exec.until((evs) => evs.some((e) => e.event === "approval.required"));
    expect(exec.types().every((x) => !x.startsWith("context."))).toBe(true);
    expect(exec.events.filter((e) => e.event !== "control").every((e) => e.data.executionId === t && e.data.projectId === undefined)).toBe(true);
    expect(exec.events.filter((e) => e.id !== null).map((e) => e.id)[0]).toBe(1);

    const ctx = await sse(`/projects/${p.id}/context/events`);
    await ctx.until((evs) => evs.some((e) => e.event === "context.snapshot.published"));
    expect(ctx.types().every((x) => x.startsWith("context."))).toBe(true);
  });
});
