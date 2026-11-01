import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "../projects/test-flow.js";
import { DATA_DIR_ENV, resolveDataPaths, type DataPaths } from "../persistence/data-dir.js";
import type { SaikiCoreOptions } from "../core/saiki-core.js";
import type { ContextStore } from "./context-store.js";
import type { ContextScanView } from "../core/jev-contracts.js";

/**
 * (Project Context, T5) ScanScheduler integrado en SaikiCore: Core, registro,
 * grafo, API y SQLite reales; `context.sqlite` en `SAIKI_DATA_DIR`.
 */

/** Retiene el hash de un archivo (por ruta relativa) hasta `release()`, o lo hace fallar. */
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

/** Contenido de cada archivo del repositorio (sin `.git`), para comprobar que nada cambió. */
function tree(root: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (p === ".git") continue;
    if (e.isDirectory()) Object.assign(out, tree(root, p));
    else out[p] = createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
  }
  return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let repos: TempRepos;
let dataRoot: string;
let data: DataPaths;
let gate: HashGate;
let agent: FlowAgent;
let srv: TestServer;

async function start(contextScan: SaikiCoreOptions["contextScan"] = {}): Promise<TestServer> {
  srv = await startTestServer({
    dir: repos.base,
    agent,
    data,
    sandboxDir: repos.dir("sandboxes"),
    contextScan: { ...contextScan, scan: { beforeHash: gate.beforeHash, ...contextScan.scan } },
  });
  return srv;
}
async function restart(contextScan: SaikiCoreOptions["contextScan"] = {}): Promise<TestServer> {
  await srv.stop();
  return start(contextScan);
}

const core = () => srv.core;
const ctxStore = () => (srv.core as unknown as { contextStore: ContextStore }).contextStore;

async function register(name: string, files: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const r = await core().registerProject({ name, path: repos.repo(name, { "README.md": `# ${name}\n`, ...files }), ...extra }, "said");
  if (!r.ok) throw new Error(r.message);
  return r.project;
}
const scans = async (projectId: string) => (await core().listContextScans(projectId))!;
const lastScan = async (projectId: string): Promise<ContextScanView> => (await scans(projectId))[0];
const waitLast = async (projectId: string) => core().waitForScan((await lastScan(projectId)).id);

beforeEach(async () => {
  repos = new TempRepos();
  dataRoot = mkdtempSync(join(tmpdir(), "saiki-data-"));
  const r = resolveDataPaths({ [DATA_DIR_ENV]: join(dataRoot, "data") }, repos.base);
  if (!r.ok) throw new Error(r.message);
  data = r.paths;
  gate = new HashGate();
  agent = new FlowAgent();
});
afterEach(async () => {
  await srv?.stop().catch(() => undefined);
  repos.cleanup();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("escaneo al registrar y persistencia", () => {
  it("registrar devuelve sin esperar; el escaneo inicial corre en segundo plano y su snapshot sobrevive al reinicio", async () => {
    await start();
    const held = gate.hold("src/index.ts");
    const p = await register("app", { "package.json": '{"name":"app","dependencies":{"rxjs":"^7.8.0"}}', "src/index.ts": "export {};\n" });
    const before = tree(p.rootPath);

    await held.started;
    expect(await scans(p.id)).toMatchObject([{ status: "running", mode: "full", trigger: "registered" }]);
    const during = (await core().getProjectContext(p.id))!;
    expect(during).toMatchObject({ status: "scanning", snapshot: null, currentScan: { status: "running" } });

    held.release();
    const done = await waitLast(p.id);
    expect(done.status).toBe("completed");
    expect(done.signature).toMatch(/^[0-9a-f]{64}$/);
    const ctx = (await core().getProjectContext(p.id))!;
    expect(ctx.status).toBe("ready");
    expect(ctx.snapshot?.scanId).toBe(done.id);
    expect(ctx.snapshot?.summary.ecosystems).toMatchObject([{ kind: "node", name: "app" }]);
    expect((await core().listContextFiles(p.id))!.files.map((f) => f.path)).toEqual(["README.md", "package.json", "src/index.ts"]);

    // context.sqlite vive en SAIKI_DATA_DIR; ni el repositorio ni el directorio de arranque reciben datos.
    expect(existsSync(data.files.context)).toBe(true);
    expect(dirname(data.files.context)).toBe(join(dataRoot, "data"));
    expect(tree(p.rootPath)).toEqual(before);
    expect(existsSync(join(repos.base, ".saiki"))).toBe(false);

    await restart();
    expect(core().contextStartReport).toEqual({ recovered: [], initial: [] });
    const again = (await core().getProjectContext(p.id))!;
    expect(again.status).toBe("ready");
    expect(again.snapshot?.id).toBe(ctx.snapshot?.id);
    expect(await scans(p.id)).toHaveLength(1);
  });

  it("al arrancar, un proyecto activo sin snapshot (registrado antes de T5) recibe su escaneo inicial", async () => {
    // Registro sin contexto, como antes de esta fase.
    const plain = await startTestServer({ dir: repos.base, agent, persist: true });
    const r = await plain.core.registerProject({ name: "old", path: repos.repo("old", { "a.ts": "1\n" }) }, "said");
    await plain.stop();
    if (!r.ok) throw new Error(r.message);
    // Mismo core.sqlite, ahora con contexto: se copia a SAIKI_DATA_DIR como haría una migración manual.
    const { copyFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(data.dir, { recursive: true });
    for (const f of readdirSync(repos.base).filter((f) => f.startsWith("core.sqlite"))) copyFileSync(join(repos.base, f), join(data.dir, f));

    await start();
    expect(core().contextStartReport?.initial).toEqual([r.project.id]);
    expect((await waitLast(r.project.id)).status).toBe("completed");
  });
});

describe("concurrencia", () => {
  it("dos proyectos en paralelo; el tercero espera en cola (máximo 2 en total); cada índice es de su proyecto", async () => {
    await start();
    const [ha, hb, hc] = ["a.txt", "b.txt", "c.txt"].map((f) => gate.hold(f));
    const a = await register("a", { "a.txt": "a\n" });
    const b = await register("b", { "b.txt": "b\n" });
    const c = await register("c", { "c.txt": "c\n" });

    await Promise.all([ha.started, hb.started]);
    await tick();
    expect([(await lastScan(a.id)).status, (await lastScan(b.id)).status, (await lastScan(c.id)).status]).toEqual(["running", "running", "queued"]);

    ha.release();
    await hc.started; // al liberar un hueco entra el tercero
    expect((await lastScan(c.id)).status).toBe("running");
    hb.release();
    hc.release();
    await core().contextIdle();

    for (const [p, own] of [[a, "a.txt"], [b, "b.txt"], [c, "c.txt"]] as const) {
      expect((await lastScan(p.id)).status).toBe("completed");
      expect((await core().listContextFiles(p.id))!.files.map((f) => f.path)).toEqual(["README.md", own]);
    }
  });

  it("solicitudes duplicadas devuelven el escaneo activo; el Core sigue atendiendo mientras escanea", async () => {
    await start();
    const held = gate.hold("src/x.ts");
    const p = await register("app", { "src/x.ts": "x\n" });
    await held.started;
    const first = await lastScan(p.id);

    const dups = await Promise.all([1, 2, 3].map(() => core().requestContextScan(p.id, "full")));
    for (const d of dups) expect(d).toMatchObject({ ok: true, deduplicated: true, scan: { id: first.id } });
    expect(await scans(p.id)).toHaveLength(1);
    // Ni una segunda fila activa por SQL directo (índice único).
    expect(() =>
      ctxStore().createScan({ id: "dup", projectId: p.id, mode: "full", trigger: "manual", rootPath: p.rootPath, fingerprint: ctxStore().getScan(first.id)!.fingerprint }),
    ).toThrow(/UNIQUE/);

    // Conversación y registro no esperan al escaneo.
    expect((await srv.api("POST", "/sessions", { sessionId: "s1", projectId: p.id })).status).toBeLessThan(300);
    const msg = await srv.api("POST", "/sessions/s1/messages", { message: "implementa un util de suma" });
    expect(msg.json.result.category).toBe("development");
    expect((await lastScan(p.id)).status).toBe("running");

    held.release();
    await core().waitForScan(first.id);
    const manual = await core().requestContextScan(p.id);
    expect(manual).toMatchObject({ ok: true, deduplicated: false, scan: { mode: "incremental", trigger: "manual" } });
    expect((await core().waitForScan(manual.ok ? manual.scan.id : "")).status).toBe("completed");
    expect((await scans(p.id)).map((s) => s.status)).toEqual(["completed", "completed"]);
  });
});

describe("reinicio", () => {
  it("escaneos en curso y en cola se reanudan; el último snapshot válido se conserva mientras tanto", async () => {
    await start({ maxConcurrent: 1 });
    const a = await register("a", { "a.txt": "1\n" });
    const s1 = (await waitLast(a.id)).id;
    const snap1 = (await core().getProjectContext(a.id))!.snapshot!.id;

    writeFileSync(join(a.rootPath, "a.txt"), "2\n");
    const held = gate.hold("a.txt");
    const manual = await core().requestContextScan(a.id);
    await held.started;
    const b = await register("b", { "b.txt": "b\n" }); // en cola: el hueco está ocupado
    expect((await lastScan(b.id)).status).toBe("queued");

    await srv.stop(); // "caída" con un escaneo en curso y otro en cola
    held.release();
    await tick();

    await start();
    const report = core().contextStartReport!;
    expect(report.recovered).toEqual([
      { projectId: a.id, interruptedScanIds: [manual.ok ? manual.scan.id : ""], outcome: "requeued", scanId: expect.any(String) },
      { projectId: b.id, interruptedScanIds: [expect.any(String)], outcome: "requeued", scanId: expect.any(String) },
    ].sort((x, y) => (x.projectId < y.projectId ? -1 : 1)));
    const during = (await core().getProjectContext(a.id))!;
    expect(during.status).toBe("scanning");
    expect(during.snapshot?.id).toBe(snap1); // el escaneo interrumpido no publicó nada

    await core().contextIdle();
    const after = (await core().getProjectContext(a.id))!;
    expect(after.status).toBe("ready");
    expect(after.snapshot?.id).not.toBe(snap1);
    expect((await scans(a.id)).map((s) => [s.trigger, s.status])).toEqual([
      ["restart", "completed"],
      ["manual", "interrupted"],
      ["registered", "completed"],
    ]);
    expect((await scans(a.id)).at(-1)?.id).toBe(s1);
    expect((await core().getProjectContext(b.id))!.status).toBe("ready");
  });

  it("una recuperación que también se interrumpe no se repite (sin bucle) ni se sustituye por el escaneo inicial", async () => {
    await start();
    let held = gate.hold("a.txt");
    const a = await register("a", { "a.txt": "1\n" });
    await held.started;
    await srv.stop();
    held.release();

    held = gate.hold("a.txt");
    await start();
    expect(core().contextStartReport?.recovered[0]).toMatchObject({ outcome: "requeued" });
    await held.started;
    await srv.stop();
    held.release();

    await start();
    expect(core().contextStartReport).toMatchObject({ recovered: [{ projectId: a.id, outcome: "skipped_repeat" }], initial: [] });
    await core().contextIdle();
    expect((await scans(a.id)).map((s) => s.status)).toEqual(["interrupted", "interrupted"]);
    expect((await core().getProjectContext(a.id))!.status).toBe("none");
    // El humano puede pedirlo a mano.
    const r = await core().requestContextScan(a.id, "full");
    expect((await core().waitForScan(r.ok ? r.scan.id : "")).status).toBe("completed");
  });
});

describe("proyectos no disponibles", () => {
  it("inexistente, desactivado o movido → rechazado; el snapshot anterior se conserva", async () => {
    await start();
    expect(await core().requestContextScan("prj-nope")).toMatchObject({ ok: false, code: "project_not_found" });
    expect(await core().getProjectContext("prj-nope")).toBeNull();

    const a = await register("a", { "a.txt": "1\n" });
    await waitLast(a.id);
    const snap = (await core().getProjectContext(a.id))!.snapshot!.id;

    await core().deactivateProject(a.id, "said");
    expect(await core().requestContextScan(a.id)).toMatchObject({ ok: false, code: "project_inactive" });
    await core().activateProject(a.id, "said"); // ya tiene snapshot: no hay escaneo inicial nuevo
    await core().contextIdle();
    expect(await scans(a.id)).toHaveLength(1);

    renameSync(a.rootPath, `${a.rootPath}-movido`);
    expect(await core().requestContextScan(a.id)).toMatchObject({ ok: false, code: "project_unhealthy" });
    expect((await core().getProjectContext(a.id))!).toMatchObject({
      status: "stale",
      snapshot: { id: snap },
      stale: { reason: "project_unavailable" },
    });
  });

  it("un escaneo en cola cuyo proyecto se desactiva termina failed sin listar nada", async () => {
    await start({ maxConcurrent: 1 });
    const held = gate.hold("a.txt");
    await register("a", { "a.txt": "1\n" });
    await held.started;
    const b = await register("b", { "b.txt": "b\n" });
    expect((await lastScan(b.id)).status).toBe("queued");
    await core().deactivateProject(b.id, "said");
    held.release();

    const s = await waitLast(b.id);
    expect(s).toMatchObject({ status: "failed", startedAt: null });
    expect(s.error).toMatch(/^project_inactive/);
    expect((await core().listContextFiles(b.id))!.files).toEqual([]);
    expect((await core().getProjectContext(b.id))!.status).toBe("failed");
  });
});

describe("errores", () => {
  it("un error durante el escaneo deja failed y no toca índice ni snapshot", async () => {
    await start();
    const a = await register("a", { "src/a.ts": "1\n" });
    await waitLast(a.id);
    const before = (await core().getProjectContext(a.id))!;
    const files = (await core().listContextFiles(a.id))!.files;

    writeFileSync(join(a.rootPath, "src/a.ts"), "2\n");
    writeFileSync(join(a.rootPath, "src/b.ts"), "nuevo\n");
    gate.failOn("src/a.ts");
    const r = await core().requestContextScan(a.id, "full");
    const s = await core().waitForScan(r.ok ? r.scan.id : "");
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/fallo simulado/);

    const after = (await core().getProjectContext(a.id))!;
    expect(after.snapshot?.id).toBe(before.snapshot?.id);
    expect(after.lastScan?.id).toBe(s.id);
    expect(after.status).toBe("stale"); // el repositorio cambió y no hay snapshot nuevo
    expect((await core().listContextFiles(a.id))!.files).toEqual(files);
  });

  it("tiempo máximo superado → failed; si el escaneo termina después, no publica", async () => {
    await start({ timeoutMs: 100 });
    const a = await register("a", { "a.txt": "1\n" });
    await waitLast(a.id);
    const snap = (await core().getProjectContext(a.id))!.snapshot!.id;

    const held = gate.hold("a.txt");
    writeFileSync(join(a.rootPath, "a.txt"), "2\n");
    const r = await core().requestContextScan(a.id, "full");
    await held.started;
    const s = await core().waitForScan(r.ok ? r.scan.id : "");
    expect(s).toMatchObject({ status: "failed", error: expect.stringMatching(/tiempo máximo/) });
    held.release();
    await core().contextIdle();
    expect((await core().getProjectContext(a.id))!.snapshot?.id).toBe(snap);
    expect(ctxStore().listSnapshots(a.id)).toHaveLength(1);
  });
});

describe("frescura y aplicación", () => {
  it("un cambio fuera de Saiki marca el contexto stale; un escaneo lo pone al día", async () => {
    await start();
    const a = await register("a", { "a.txt": "1\n" });
    await waitLast(a.id);
    expect((await core().getProjectContext(a.id))!.status).toBe("ready");

    writeFileSync(join(a.rootPath, "nuevo.ts"), "export {};\n");
    const stale = (await core().getProjectContext(a.id))!;
    expect(stale.status).toBe("stale");
    expect(stale.stale).toMatchObject({ reason: "changes_detected", changedPaths: 3 });

    const r = await core().requestContextScan(a.id);
    await core().waitForScan(r.ok ? r.scan.id : "");
    expect((await core().getProjectContext(a.id))!.status).toBe("ready");
  });

  it("aplicar en modo real encola un escaneo incremental post_apply; en sandbox no", async () => {
    await start();
    const real = await register("real", {}, { applyMode: "real", confirmRealApply: true });
    const sandbox = await register("sb");
    await core().contextIdle();

    async function applyIn(sessionId: string, projectId: string) {
      await srv.api("POST", "/sessions", { sessionId, projectId });
      const t = (await srv.api("POST", `/sessions/${sessionId}/messages`, { message: "implementa un util de suma" })).json.result.developmentThreadId;
      const view = async () => (await srv.api("GET", `/executions/${t}`)).json.execution;
      await srv.api("POST", `/executions/${t}/approval/hu_review`, { decision: "approve", decisionHash: (await view()).pendingApproval.decisionHash });
      const r = await srv.api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: (await view()).pendingApproval.proposalHash });
      expect(r.status).toBe(200);
      return view();
    }

    expect((await applyIn("s-real", real.id)).applyTarget).toBe(real.rootPath);
    expect((await applyIn("s-sb", sandbox.id)).applyTarget).toContain("saiki-sandbox-");
    await core().contextIdle();

    expect((await scans(real.id)).map((s) => [s.trigger, s.mode, s.status])).toEqual([
      ["post_apply", "incremental", "completed"],
      ["registered", "full", "completed"],
    ]);
    expect((await core().listContextFiles(real.id))!.files.map((f) => f.path)).toContain("src/gen.ts");
    expect((await scans(sandbox.id)).map((s) => s.trigger)).toEqual(["registered"]);
  });
});
