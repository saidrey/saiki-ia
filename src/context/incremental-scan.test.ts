import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { readFingerprint } from "../projects/project-fs.js";
import { ContextStore } from "./context-store.js";
import { computeIndexHash, recoverInterruptedScans, runScan, type RunScanOptions, type RunScanResult } from "./incremental-scan.js";

/** (Project Context, T3) Escaneo incremental sobre repositorios git reales. */

let repos: TempRepos;
let dbPath: string;
let store: ContextStore;
beforeEach(() => {
  repos = new TempRepos();
  dbPath = join(repos.base, "data", "context.sqlite");
  store = new ContextStore(dbPath);
});
afterEach(() => {
  store.close();
  repos.cleanup();
});

/** Pone todos los archivos (menos .git) en el pasado: fuera de la ventana "racy". */
function age(root: string, secondsAgo = 3600): void {
  const t = Date.now() / 1000 - secondsAgo;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) utimesSync(f, t, t);
    }
  };
  walk(root);
}

function project(name: string, files: Record<string, string>, projectId = `prj-${name}`) {
  const root = realpathSync(repos.repo(name, files));
  age(root);
  return { projectId, rootPath: root, fingerprint: readFingerprint(root) };
}

type Target = ReturnType<typeof project>;

async function scan(t: Target, extra: Partial<RunScanOptions> = {}) {
  const r = await runScan(store, { ...t, mode: "incremental", trigger: "manual", ...extra });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

const hashes = (t: Target) => Object.fromEntries([...store.fileMap(t.projectId).values()].map((f) => [f.path, f.hash]));

describe("primer escaneo", () => {
  it("indexa todo como alta, calcula hashes y publica el snapshot con el hash del índice", async () => {
    const t = project("app", { "src/a.ts": "a", "src/b.ts": "b", "README.md": "r", ".env": "SECRET=1" });
    const r = await scan(t);
    expect(r.changes).toEqual({ added: [".env", "README.md", "src/a.ts", "src/b.ts"], modified: [], deleted: [], renamed: [] });
    expect(r.scan.stats).toMatchObject({ listed: 4, hashed: 3, added: 4, truncated: false });
    expect(r.forcedFull).toBe(false);
    expect(hashes(t)[".env"]).toBeNull(); // el secreto no se abre
    expect(hashes(t)["src/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.snapshot.indexHash).toBe(computeIndexHash(store.fileMap(t.projectId).values()));
    expect(r.snapshot.summary).toMatchObject({ schemaVersion: 2, files: 4, byKind: { doc: 1, secret: 1, source: 2 }, source: "git" });
    expect(store.latestSnapshot(t.projectId)?.id).toBe(r.snapshot.id);
  });
});

describe("cambios incrementales", () => {
  it("sin cambios: reutiliza todos los hashes y no detecta nada", async () => {
    const t = project("app", { "src/a.ts": "a", "src/b.ts": "b" });
    const first = await scan(t);
    const r = await scan(t);
    expect(r.scan.stats).toMatchObject({ hashed: 0, added: 0, modified: 0, deleted: 0, renamed: 0 });
    expect(r.snapshot.indexHash).toBe(first.snapshot.indexHash);
    expect(r.snapshot.id).not.toBe(first.snapshot.id);
  });

  it("detecta altas, modificaciones y bajas, y solo recalcula lo que cambió", async () => {
    const t = project("app", { "src/a.ts": "a", "src/b.ts": "b", "src/c.ts": "c" });
    await scan(t);
    const before = hashes(t);
    writeFileSync(join(t.rootPath, "src/a.ts"), "a modificado");
    rmSync(join(t.rootPath, "src/b.ts"));
    writeFileSync(join(t.rootPath, "src/d.ts"), "nuevo");
    const r = await scan(t);
    expect(r.changes).toEqual({ added: ["src/d.ts"], modified: ["src/a.ts"], deleted: ["src/b.ts"], renamed: [] });
    expect(r.scan.stats?.hashed).toBe(2); // a.ts y d.ts; c.ts se reutiliza
    const after = hashes(t);
    expect(after["src/c.ts"]).toBe(before["src/c.ts"]);
    expect(after["src/a.ts"]).not.toBe(before["src/a.ts"]);
    expect(Object.keys(after).sort()).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]);
  });

  it("solo cambia la fecha: recalcula, no lo cuenta como modificado y actualiza el mtime", async () => {
    const t = project("app", { "src/a.ts": "a" });
    await scan(t);
    const past = Date.now() / 1000 - 600;
    utimesSync(join(t.rootPath, "src/a.ts"), past, past);
    const r = await scan(t);
    expect(r.scan.stats).toMatchObject({ hashed: 1, modified: 0 });
    expect(store.fileMap(t.projectId).get("src/a.ts")?.mtimeMs).toBe(Math.trunc(statSync(join(t.rootPath, "src/a.ts")).mtimeMs));
  });

  it("renombrado y movimiento de módulo: baja + alta con el mismo hash", async () => {
    const t = project("app", { "src/auth/login.ts": "login", "src/auth/logout.ts": "logout", "src/x.ts": "x" });
    await scan(t);
    mkdirSync(join(t.rootPath, "src/session"));
    renameSync(join(t.rootPath, "src/auth/login.ts"), join(t.rootPath, "src/session/login.ts"));
    renameSync(join(t.rootPath, "src/auth/logout.ts"), join(t.rootPath, "src/session/logout.ts"));
    rmSync(join(t.rootPath, "src/auth"), { recursive: true });
    const r = await scan(t);
    expect(r.changes.renamed).toEqual([
      { from: "src/auth/login.ts", to: "src/session/login.ts" },
      { from: "src/auth/logout.ts", to: "src/session/logout.ts" },
    ]);
    expect(r.changes).toMatchObject({ added: [], deleted: [], modified: [] });
  });

  it("archivos idénticos: el renombrado se empareja 1 a 1 y el resto son altas", async () => {
    const t = project("app", { "a.ts": "igual" });
    await scan(t);
    renameSync(join(t.rootPath, "a.ts"), join(t.rootPath, "b.ts"));
    writeFileSync(join(t.rootPath, "c.ts"), "igual");
    const r = await scan(t);
    expect(r.changes).toEqual({ added: ["c.ts"], modified: [], deleted: [], renamed: [{ from: "a.ts", to: "b.ts" }] });
  });

  it("dependencia nueva: el manifiesto aparece como modificado", async () => {
    const t = project("app", { "package.json": '{"dependencies":{}}', "src/a.ts": "a" });
    await scan(t);
    writeFileSync(join(t.rootPath, "package.json"), '{"dependencies":{"rxjs":"^7.8.0"}}');
    const r = await scan(t);
    expect(r.changes.modified).toEqual(["package.json"]);
    expect(store.fileMap(t.projectId).get("package.json")?.kind).toBe("manifest");
  });

  it("un secreto que cambia se detecta por tamaño/fecha, sin abrirlo", async () => {
    const t = project("app", { ".env": "A=1" });
    await scan(t);
    writeFileSync(join(t.rootPath, ".env"), "A=1\nB=2");
    const r = await scan(t);
    expect(r.changes.modified).toEqual([".env"]);
    expect(store.fileMap(t.projectId).get(".env")?.hash).toBeNull();
  });

  it("archivo editado poco antes de leerlo (racy): no se reutiliza aunque coincidan tamaño y fecha", async () => {
    const t = project("app", { "src/a.ts": "aaaa" });
    writeFileSync(join(t.rootPath, "src/a.ts"), "aaaa"); // mtime = ahora, dentro de la ventana
    await scan(t);
    const r = await scan(t);
    expect(r.scan.stats?.hashed).toBe(1);
  });

  it("archivos grandes: sin hash por encima del tope", async () => {
    const t = project("app", { "big.bin.dat": "x".repeat(2048), "small.ts": "s" });
    await scan(t, { maxHashBytes: 1024 });
    expect(hashes(t)).toMatchObject({ "big.bin.dat": null });
    expect(hashes(t)["small.ts"]).not.toBeNull();
  });
});

describe("modo full e integridad", () => {
  it("full recalcula todos los hashes aunque nada haya cambiado", async () => {
    const t = project("app", { "a.ts": "a", "b.ts": "b" });
    await scan(t);
    const r = await scan(t, { mode: "full" });
    expect(r.scan.stats).toMatchObject({ hashed: 2, modified: 0 });
    expect(r.scan.mode).toBe("full");
  });

  it("si el índice no coincide con el último snapshot, no se fía de él y recalcula todo", async () => {
    const t = project("app", { "a.ts": "a", "b.ts": "b" });
    await scan(t);
    store.upsertFiles(t.projectId, [{ ...store.fileMap(t.projectId).get("a.ts")!, hash: "manipulado" }]);
    const r = await scan(t);
    expect(r.forcedFull).toBe(true);
    expect(r.scan.stats?.hashed).toBe(2);
    expect(r.changes.modified).toEqual(["a.ts"]);
    expect(r.snapshot.indexHash).toBe(computeIndexHash(store.fileMap(t.projectId).values()));
  });
});

describe("fallos: el último snapshot válido se conserva", () => {
  async function expectFailureKeepsLast(t: Target, run: () => Promise<RunScanResult>) {
    const last = store.latestSnapshot(t.projectId)!;
    const index = hashes(t);
    const r = await run();
    expect(r.ok).toBe(false);
    if (r.ok || r.code !== "scan_failed") throw new Error("se esperaba scan_failed");
    expect(r.scan.status).toBe("failed");
    expect(store.latestSnapshot(t.projectId)?.id).toBe(last.id);
    expect(hashes(t)).toEqual(index);
    return r;
  }

  it("proyecto movido: falla sin tocar índice ni snapshot", async () => {
    const t = project("app", { "a.ts": "a" });
    await scan(t);
    renameSync(t.rootPath, `${t.rootPath}-movido`);
    const r = await expectFailureKeepsLast(t, () => runScan(store, { ...t, mode: "incremental", trigger: "manual" }));
    expect(r.scan.error).toMatch(/project_unhealthy/);
  });

  it("error inesperado a mitad del cálculo de hashes: falla sin publicar nada", async () => {
    const t = project("app", { "a.ts": "a", "b.ts": "b" });
    await scan(t);
    writeFileSync(join(t.rootPath, "a.ts"), "cambio");
    writeFileSync(join(t.rootPath, "c.ts"), "nuevo");
    const r = await expectFailureKeepsLast(t, () =>
      runScan(store, {
        ...t,
        mode: "incremental",
        trigger: "manual",
        beforeHash: (p) => {
          if (p === "c.ts") throw new Error("disco desconectado");
        },
      }),
    );
    expect(r.scan.error).toMatch(/disco desconectado/);
  });

  it("un archivo que desaparece entre el listado y el hash no entra en el índice", async () => {
    const t = project("app", { "a.ts": "a", "b.ts": "b" });
    const r = await scan(t, {
      beforeHash: (p) => {
        if (p === "b.ts") rmSync(join(t.rootPath, "b.ts"));
      },
    });
    expect(Object.keys(hashes(t))).toEqual(["a.ts"]);
    expect(r.scan.stats).toMatchObject({ listed: 2, hashed: 1, skipped: 1 });
  });

  it("no admite dos escaneos a la vez del mismo proyecto", async () => {
    const t = project("app", { "a.ts": "a" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runScan(store, { ...t, mode: "full", trigger: "manual", beforeHash: () => gate });
    await new Promise((r) => setTimeout(r, 50));
    const second = await runScan(store, { ...t, mode: "full", trigger: "manual" });
    expect(second).toMatchObject({ ok: false, code: "scan_in_progress" });
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("interrupción y recuperación tras reinicio (D9)", () => {
  it("un escaneo cortado por un reinicio queda interrupted, se relanza una vez y el proceso viejo ya no puede publicar", async () => {
    const t = project("app", { "a.ts": "a", "b.ts": "b" });
    const first = await scan(t);
    writeFileSync(join(t.rootPath, "c.ts"), "nuevo");

    // Proceso "viejo": se queda colgado calculando hashes.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const old = runScan(store, { ...t, mode: "incremental", trigger: "manual", scanId: "scan-viejo", beforeHash: () => gate });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getScan("scan-viejo")?.status).toBe("running");
    expect(store.latestSnapshot(t.projectId)?.id).toBe(first.snapshot.id); // nada publicado a medias

    // Proceso "nuevo" sobre los mismos datos.
    const restarted = new ContextStore(dbPath);
    try {
      const report = await recoverInterruptedScans(restarted, (id) => (id === t.projectId ? t : null));
      expect(report).toEqual([{ projectId: t.projectId, interruptedScanIds: ["scan-viejo"], outcome: "rescanned", scanId: expect.any(String) }]);
      expect(restarted.getScan("scan-viejo")).toMatchObject({ status: "interrupted", error: expect.stringMatching(/reinició/) });
      const recovered = restarted.getScan(report[0].scanId!)!;
      expect(recovered).toMatchObject({ status: "completed", trigger: "restart", mode: "incremental" });
      expect(Object.keys(Object.fromEntries([...restarted.fileMap(t.projectId)]))).toEqual(["a.ts", "b.ts", "c.ts"]);
      const recoveredSnapshot = restarted.latestSnapshot(t.projectId)!;

      // El proceso viejo despierta: no puede completar ni sobrescribir nada.
      release();
      const late = await old;
      expect(late).toMatchObject({ ok: false, code: "scan_failed" });
      expect(restarted.getScan("scan-viejo")?.status).toBe("interrupted");
      expect(restarted.latestSnapshot(t.projectId)?.id).toBe(recoveredSnapshot.id);
    } finally {
      restarted.close();
    }
  });

  it("no relanza una recuperación que también se interrumpió, ni proyectos no disponibles", async () => {
    const a = project("a", { "a.ts": "a" });
    const b = project("b", { "b.ts": "b" });
    store.createScan({ id: "rec", projectId: a.projectId, mode: "incremental", trigger: "restart", rootPath: a.rootPath, fingerprint: a.fingerprint });
    store.startScan("rec");
    store.createScan({ id: "q", projectId: b.projectId, mode: "full", trigger: "registered", rootPath: b.rootPath, fingerprint: b.fingerprint });
    const report = await recoverInterruptedScans(store, () => null);
    expect(report.map((r) => [r.projectId, r.outcome])).toEqual([
      [a.projectId, "skipped_repeat"],
      [b.projectId, "skipped_unavailable"],
    ]);
    expect(store.activeScans()).toEqual([]);
    expect(store.latestSnapshot(a.projectId)).toBeNull();
  });

  it("sin escaneos pendientes no hace nada", async () => {
    const t = project("app", { "a.ts": "a" });
    await scan(t);
    expect(await recoverInterruptedScans(store, () => t)).toEqual([]);
  });
});

describe("aislamiento entre proyectos", () => {
  it("dos proyectos escaneados en paralelo: cada índice y snapshot solo contiene lo suyo", async () => {
    const a = project("a", { "comun.ts": "de a", "solo-a.ts": "a" });
    const b = project("b", { "comun.ts": "de b", "solo-b.ts": "b" });
    const [ra, rb] = await Promise.all([scan(a), scan(b)]);
    expect(Object.keys(hashes(a)).sort()).toEqual(["comun.ts", "solo-a.ts"]);
    expect(Object.keys(hashes(b)).sort()).toEqual(["comun.ts", "solo-b.ts"]);
    expect(hashes(a)["comun.ts"]).not.toBe(hashes(b)["comun.ts"]);
    expect(store.getSnapshot(a.projectId, rb.snapshot.id)).toBeNull();
    expect(store.getSnapshot(b.projectId, ra.snapshot.id)).toBeNull();

    // Un cambio en b no afecta al siguiente escaneo de a.
    writeFileSync(join(b.rootPath, "solo-b.ts"), "cambio");
    const ra2 = await scan(a);
    expect(ra2.scan.stats).toMatchObject({ hashed: 0, modified: 0 });
    expect((await scan(b)).changes.modified).toEqual(["solo-b.ts"]);
  });

  it("el escaneo de un proyecto no bloquea el de otro", async () => {
    const a = project("a", { "a.ts": "a" });
    const b = project("b", { "b.ts": "b" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = runScan(store, { ...a, mode: "full", trigger: "manual", beforeHash: () => gate });
    await new Promise((r) => setTimeout(r, 50));
    expect((await runScan(store, { ...b, mode: "full", trigger: "manual" })).ok).toBe(true);
    release();
    expect((await slow).ok).toBe(true);
  });
});
