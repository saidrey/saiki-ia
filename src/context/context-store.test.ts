import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore, type FileRecord, type NewScan, type ScanStats } from "./context-store.js";

/** (Project Context, T2) Almacén de contexto: aislamiento, inmutabilidad y atomicidad. */

const FP = { dev: 1, ino: 2, gitDir: "/repo/.git", gitIno: 3 };
const STATS: ScanStats = { listed: 2, hashed: 2, added: 2, modified: 0, deleted: 0, renamed: 0, skipped: 0, truncated: false };

let dir: string;
let dbPath: string;
let store: ContextStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-context-store-"));
  dbPath = join(dir, "context.sqlite");
  store = new ContextStore(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newScan = (id: string, projectId = "prj-a", extra: Partial<NewScan> = {}): NewScan => ({
  id,
  projectId,
  mode: "full",
  trigger: "registered",
  rootPath: `/repos/${projectId}`,
  fingerprint: FP,
  ...extra,
});

const file = (path: string, scanId: string, extra: Partial<FileRecord> = {}): FileRecord => ({
  path,
  kind: "source",
  lang: "typescript",
  size: 10,
  mtimeMs: 1000,
  hash: `h-${path}`,
  lastScanId: scanId,
  ...extra,
});

/** Escaneo completo con su snapshot. */
function completed(id: string, projectId = "prj-a", snapshotId = `snap-${id}`) {
  store.createScan(newScan(id, projectId));
  store.startScan(id);
  return store.completeScan(id, STATS, { id: snapshotId, indexHash: `ih-${id}`, summary: { schemaVersion: 1, project: projectId } });
}

describe("escaneos", () => {
  it("ciclo queued → running → completed publica el snapshot", () => {
    const s = store.createScan(newScan("scan-1", "prj-a", { createdAt: "2026-10-30T10:00:00.000Z" }));
    expect(s).toMatchObject({ status: "queued", startedAt: null, fingerprint: FP, stats: null });
    expect(store.startScan("scan-1", "2026-10-30T10:00:01.000Z", { gitHead: "abc", signature: "sig" })).toMatchObject({
      status: "running",
      gitHead: "abc",
      signature: "sig",
    });
    const { scan, snapshot } = store.completeScan("scan-1", STATS, { id: "snap-1", indexHash: "ih", summary: { a: 1 } });
    expect(scan).toMatchObject({ status: "completed", stats: STATS });
    expect(scan.finishedAt).not.toBeNull();
    expect(snapshot).toMatchObject({ id: "snap-1", projectId: "prj-a", scanId: "scan-1", indexHash: "ih", summary: { a: 1 } });
    expect(store.latestSnapshot("prj-a")?.id).toBe("snap-1");
  });

  it("rechaza transiciones no permitidas", () => {
    store.createScan(newScan("scan-1"));
    expect(() => store.completeScan("scan-1", STATS, { id: "s", indexHash: "i", summary: {} })).toThrow(/queued → completed/);
    store.startScan("scan-1");
    expect(() => store.startScan("scan-1")).toThrow(/running → running/);
    store.failScan("scan-1", "boom");
    expect(store.getScan("scan-1")).toMatchObject({ status: "failed", error: "boom" });
    expect(() => store.startScan("scan-1")).toThrow(/failed → running/);
    expect(() => store.startScan("no-existe")).toThrow(/no encontrado/);
  });

  it("un escaneo terminado no cambia y su identidad es inmutable, también por SQL directo", () => {
    completed("scan-1");
    store.createScan(newScan("scan-2"));
    store.close();
    const raw = new Database(dbPath);
    try {
      expect(() => raw.prepare(`UPDATE context_scans SET error = 'x' WHERE id = 'scan-1'`).run()).toThrow(/terminado/);
      expect(() => raw.prepare(`UPDATE context_scans SET rootPath = '/otro' WHERE id = 'scan-2'`).run()).toThrow(/identidad/);
      expect(() => raw.prepare(`UPDATE context_scans SET projectId = 'prj-b' WHERE id = 'scan-2'`).run()).toThrow(/identidad/);
      expect(() => raw.prepare(`DELETE FROM context_scans WHERE id = 'scan-2'`).run()).toThrow(/no se borran/);
    } finally {
      raw.close();
      store = new ContextStore(dbPath);
    }
  });

  it("(reinicio) interrumpe los escaneos queued y running de un proceso anterior; los terminados no", () => {
    completed("scan-done");
    store.createScan(newScan("scan-q"));
    store.createScan(newScan("scan-r", "prj-b"));
    store.startScan("scan-r");
    store.close();
    store = new ContextStore(dbPath); // "reinicio"
    expect(store.activeScans().map((s) => s.id)).toEqual(["scan-q", "scan-r"]);
    const hit = store.interruptActiveScans("el backend se reinició");
    expect(hit.map((s) => [s.id, s.status, s.error])).toEqual([
      ["scan-q", "interrupted", "el backend se reinició"],
      ["scan-r", "interrupted", "el backend se reinició"],
    ]);
    expect(store.getScan("scan-done")?.status).toBe("completed");
    expect(store.activeScans()).toEqual([]);
  });

  it("lista los escaneos de cada proyecto por separado, del más reciente al más antiguo", () => {
    store.createScan(newScan("a1", "prj-a", { createdAt: "2026-10-30T10:00:00.000Z" }));
    store.createScan(newScan("b1", "prj-b", { createdAt: "2026-10-30T10:00:01.000Z" }));
    // (T5) Un solo escaneo activo por proyecto: a2 solo cabe cuando a1 termina.
    expect(() => store.createScan(newScan("a2", "prj-a", { createdAt: "2026-10-30T10:00:02.000Z" }))).toThrow(/UNIQUE/);
    store.failScan("a1", "x");
    store.createScan(newScan("a2", "prj-a", { createdAt: "2026-10-30T10:00:02.000Z" }));
    expect(store.listScans("prj-a").map((s) => s.id)).toEqual(["a2", "a1"]);
    expect(store.activeScans("prj-b").map((s) => s.id)).toEqual(["b1"]);
  });
});

describe("snapshots", () => {
  it("son inmutables: ni UPDATE ni DELETE, también por SQL directo", () => {
    completed("scan-1");
    store.close();
    const raw = new Database(dbPath);
    try {
      expect(() => raw.prepare(`UPDATE context_snapshots SET indexHash = 'x'`).run()).toThrow(/inmutable/);
      expect(() => raw.prepare(`DELETE FROM context_snapshots`).run()).toThrow(/inmutable/);
    } finally {
      raw.close();
      store = new ContextStore(dbPath);
    }
    expect(store.getSnapshot("prj-a", "snap-scan-1")?.indexHash).toBe("ih-scan-1");
  });

  it("atomicidad: si el snapshot no se puede guardar, el escaneo no queda completado", () => {
    completed("scan-1", "prj-a", "snap-dup");
    store.createScan(newScan("scan-2"));
    store.startScan("scan-2");
    expect(() => store.completeScan("scan-2", STATS, { id: "snap-dup", indexHash: "x", summary: {} })).toThrow();
    expect(store.getScan("scan-2")).toMatchObject({ status: "running", stats: null, finishedAt: null });
    expect(store.listSnapshots("prj-a").map((s) => s.id)).toEqual(["snap-dup"]);
  });

  it("(T3) los cambios del índice se publican con el snapshot, o no se publican", () => {
    store.upsertFiles("prj-a", [file("old.ts", "s0")]);
    completed("scan-1", "prj-a", "snap-dup");
    store.createScan(newScan("scan-2"));
    store.startScan("scan-2");
    const changes = { upsert: [file("new.ts", "scan-2")], delete: ["old.ts"] };
    expect(() => store.completeScan("scan-2", STATS, { id: "snap-dup", indexHash: "x", summary: {} }, undefined, changes)).toThrow();
    expect([...store.fileMap("prj-a").keys()]).toEqual(["old.ts"]); // revertido junto con el snapshot
    store.completeScan("scan-2", STATS, { id: "snap-2", indexHash: "y", summary: {} }, undefined, changes);
    expect([...store.fileMap("prj-a").keys()]).toEqual(["new.ts"]);
  });

  it("aislamiento: el snapshot de otro proyecto no se devuelve aunque se conozca su id", () => {
    completed("scan-a", "prj-a");
    completed("scan-b", "prj-b");
    expect(store.getSnapshot("prj-a", "snap-scan-b")).toBeNull();
    expect(store.getSnapshot("prj-b", "snap-scan-b")?.summary).toEqual({ schemaVersion: 1, project: "prj-b" });
    expect(store.latestSnapshot("prj-a")?.id).toBe("snap-scan-a");
    expect(store.latestSnapshot("prj-c")).toBeNull();
  });

  it("latestSnapshot es el más reciente; los anteriores se conservan", () => {
    completed("scan-1");
    completed("scan-2");
    expect(store.latestSnapshot("prj-a")?.id).toBe("snap-scan-2");
    expect(store.listSnapshots("prj-a").map((s) => s.id)).toEqual(["snap-scan-2", "snap-scan-1"]);
  });
});

describe("índice de archivos", () => {
  it("upsert, borrado y mapa por proyecto, aislados entre proyectos", () => {
    store.upsertFiles("prj-a", [file("src/a.ts", "s1"), file("src/b.ts", "s1")]);
    store.upsertFiles("prj-b", [file("src/a.ts", "s9", { hash: "otro" })]);
    store.upsertFiles("prj-a", [file("src/a.ts", "s2", { size: 20, hash: "nuevo" })]);
    store.deleteFiles("prj-a", ["src/b.ts"]);

    const a = store.fileMap("prj-a");
    expect([...a.keys()]).toEqual(["src/a.ts"]);
    expect(a.get("src/a.ts")).toMatchObject({ size: 20, hash: "nuevo", lastScanId: "s2" });
    expect(store.fileMap("prj-b").get("src/a.ts")?.hash).toBe("otro");
    expect(store.countFiles("prj-a")).toBe(1);
    expect(store.countFiles("prj-b")).toBe(1);
  });

  it("secretos y binarios grandes sin hash; no hay columna de contenido", () => {
    store.upsertFiles("prj-a", [file(".env", "s1", { kind: "secret", lang: null, hash: null })]);
    expect(store.fileMap("prj-a").get(".env")).toMatchObject({ kind: "secret", hash: null });
    store.close();
    const raw = new Database(dbPath);
    try {
      const cols = (raw.prepare(`PRAGMA table_info(context_files)`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(["projectId", "path", "kind", "lang", "size", "mtimeMs", "hash", "lastScanId"]);
    } finally {
      raw.close();
      store = new ContextStore(dbPath);
    }
  });

  it("paginación por ruta con prefijo y tipo (sin comodines de LIKE)", () => {
    store.upsertFiles("prj-a", [
      file("src/a_b.ts", "s"),
      file("src/axb.ts", "s"),
      file("src/sub/c.ts", "s"),
      file("src/sub/c.spec.ts", "s", { kind: "test" }),
      file("srcx/d.ts", "s"),
      file("README.md", "s", { kind: "doc" }),
    ]);
    expect(store.listFiles("prj-a", { prefix: "src/" }).map((f) => f.path)).toEqual([
      "src/a_b.ts",
      "src/axb.ts",
      "src/sub/c.spec.ts",
      "src/sub/c.ts",
    ]);
    expect(store.listFiles("prj-a", { prefix: "src/a_" }).map((f) => f.path)).toEqual(["src/a_b.ts"]);
    expect(store.listFiles("prj-a", { kind: "test" }).map((f) => f.path)).toEqual(["src/sub/c.spec.ts"]);
    const p1 = store.listFiles("prj-a", { limit: 2 });
    const p2 = store.listFiles("prj-a", { limit: 2, after: p1[1].path });
    expect([...p1, ...p2].map((f) => f.path)).toEqual(["README.md", "src/a_b.ts", "src/axb.ts", "src/sub/c.spec.ts"]);
    expect(store.listFiles("prj-b")).toEqual([]);
  });

  it("persiste tras reabrir la base (reinicio)", () => {
    store.upsertFiles("prj-a", [file("src/a.ts", "s1")]);
    completed("scan-1");
    store.close();
    store = new ContextStore(dbPath);
    expect(store.fileMap("prj-a").get("src/a.ts")?.hash).toBe("h-src/a.ts");
    expect(store.latestSnapshot("prj-a")?.id).toBe("snap-scan-1");
  });
});
