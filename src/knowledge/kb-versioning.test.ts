import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeError, KnowledgeStore, versionHash } from "./kb-store.js";

/** (T10) Conocimiento por proyecto, versiones inmutables y migración aditiva. */

let dir: string;
let path: string;
let kb: KnowledgeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-kb-v-"));
  path = join(dir, "knowledge.sqlite");
  kb = new KnowledgeStore(path);
});
afterEach(() => {
  kb.close();
  rmSync(dir, { recursive: true, force: true });
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KnowledgeError) return e.code;
    throw e;
  }
  return "sin error";
};

function approvedConvention(id = "c1", projectId = "prj-a") {
  const d = kb.create({ id, title: "Convención de rutas", category: "conventions", content: "Rutas relativas.", origin: "said", projectId });
  return kb.approve(d.id, "said", versionHash(d));
}

describe("migración aditiva", () => {
  it("una base anterior a T10 conserva sus documentos como globales, versión 1", () => {
    kb.close();
    rmSync(path);
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE kb_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
      content TEXT NOT NULL, origin TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, supersededBy TEXT)`);
    legacy.prepare(`INSERT INTO kb_docs VALUES ('old','Antiguo','lessons','approved','c','human','t','t',NULL)`).run();
    legacy.close();

    kb = new KnowledgeStore(path);
    expect(kb.get("old")).toMatchObject({ id: "old", projectId: null, documentId: "old", version: 1, basedOn: null, status: "approved" });
    expect(kb.search().map((d) => d.id)).toEqual(["old"]);
    expect(code(() => kb.update("old", { content: "x" }, "said"))).toBe("not_proposed");
  });
});

describe("global y proyecto no se mezclan", () => {
  it("sin projectId: solo global; con projectId: solo ese proyecto", () => {
    kb.create({ id: "g", title: "Global", category: "research", content: "c", origin: "human" });
    kb.create({ id: "a", title: "De A", category: "architecture", content: "c", origin: "said", projectId: "prj-a" });
    kb.create({ id: "b", title: "De B", category: "architecture", content: "c", origin: "said", projectId: "prj-b" });
    expect(kb.search().map((d) => d.id)).toEqual(["g"]);
    expect(kb.search({ projectId: "prj-a" }).map((d) => d.id)).toEqual(["a"]);
    expect(kb.search({ projectId: "prj-b" }).map((d) => d.id)).toEqual(["b"]);
  });

  it("un proyecto solo tiene arquitectura, convenciones y decisiones; título y contenido obligatorios", () => {
    expect(code(() => kb.create({ id: "x", title: "t", category: "research", content: "c", origin: "said", projectId: "prj-a" }))).toBe("invalid");
    expect(code(() => kb.create({ id: "y", title: " ", category: "conventions", content: "c", origin: "said", projectId: "prj-a" }))).toBe("invalid");
  });

  it("solo lo aprobado del proyecto se entrega al contexto", () => {
    approvedConvention("c1", "prj-a");
    kb.create({ id: "p", title: "Pendiente", category: "decisions", content: "c", origin: "said", projectId: "prj-a" });
    approvedConvention("c-b", "prj-b");
    expect(kb.approvedForProject("prj-a").map((d) => d.id)).toEqual(["c1"]);
  });
});

describe("versiones", () => {
  it("propuesta → aprobación → nueva versión: la anterior queda reemplazada y se conserva", () => {
    const v1 = approvedConvention();
    const v2 = kb.proposeVersion(v1.id, { content: "Rutas relativas a la raíz del proyecto." }, "said");
    expect(v2).toMatchObject({ id: "c1-v2", documentId: "c1", version: 2, basedOn: "c1", status: "proposed", projectId: "prj-a", category: "conventions" });
    expect(kb.get("c1")?.status).toBe("approved"); // la propuesta no toca la versión oficial

    kb.approve(v2.id, "said", versionHash(v2));
    expect(kb.get("c1")).toMatchObject({ status: "superseded", supersededBy: "c1-v2", content: "Rutas relativas." });
    expect(kb.get("c1-v2")?.status).toBe("approved");
    expect(kb.versions("c1").map((d) => [d.version, d.status])).toEqual([[1, "superseded"], [2, "approved"]]);
    expect(kb.approvedForProject("prj-a").map((d) => d.id)).toEqual(["c1-v2"]);
    // Quién y cuándo, con el hash de lo aprobado.
    const approved = kb.history("c1-v2").find((h) => h.action === "status:proposed->approved");
    expect(approved).toMatchObject({ actor: "said" });
    expect(approved?.detail).toContain(versionHash(v2));
  });

  it("la aprobación va ligada a la versión exacta revisada", () => {
    const d = kb.create({ id: "c1", title: "t", category: "conventions", content: "a", origin: "said", projectId: "prj-a" });
    const reviewed = versionHash(d);
    kb.update(d.id, { content: "b" }, "said"); // cambió después de revisarla
    expect(code(() => kb.approve(d.id, "said", reviewed))).toBe("hash_mismatch");
    expect(kb.get("c1")?.status).toBe("proposed");
  });

  it("rechazo: la versión propuesta se archiva (historial 'rejected') y la oficial no cambia", () => {
    const v1 = approvedConvention();
    const v2 = kb.proposeVersion(v1.id, { title: "Otra" }, "said");
    kb.reject(v2.id, "said", versionHash(v2));
    expect(kb.get(v2.id)?.status).toBe("archived");
    expect(kb.history(v2.id).some((h) => h.action === "rejected" && h.actor === "said")).toBe(true);
    expect(kb.get("c1")?.status).toBe("approved");
    // Tras el rechazo se puede proponer otra versión (la 3).
    expect(kb.proposeVersion(v1.id, { title: "Tercera" }, "said").version).toBe(3);
  });

  it("transiciones explícitas: una propuesta pendiente por documento; base vigente; nada que decidir fuera de proposed", () => {
    const v1 = approvedConvention();
    const v2 = kb.proposeVersion(v1.id, { content: "v2" }, "said");
    expect(code(() => kb.proposeVersion(v1.id, { content: "otra" }, "said"))).toBe("pending_exists");
    expect(code(() => kb.proposeVersion(v2.id, { content: "otra" }, "said"))).toBe("not_approved");
    expect(code(() => kb.proposeVersion(v1.id, {}, "said"))).toBe("pending_exists");
    kb.reject(v2.id, "said", versionHash(v2));
    expect(code(() => kb.proposeVersion(v1.id, {}, "said"))).toBe("invalid"); // no cambia nada
    expect(code(() => kb.approve(v2.id, "said", versionHash(v2)))).toBe("not_proposed");
    expect(code(() => kb.reject(v1.id, "said", versionHash(v1)))).toBe("not_proposed");
    // Archivar retira la versión oficial; lo histórico no se vuelve a archivar.
    kb.archive(v1.id, "said");
    expect(kb.get(v1.id)?.status).toBe("archived");
    expect(code(() => kb.archive(v1.id, "said"))).toBe("invalid");
    expect(kb.approvedForProject("prj-a")).toEqual([]);
  });

  it("una propuesta basada en una versión que dejó de ser la vigente no se aprueba", () => {
    const v1 = approvedConvention();
    const v2 = kb.proposeVersion(v1.id, { content: "v2" }, "said");
    kb.archive(v1.id, "said");
    expect(code(() => kb.approve(v2.id, "said", versionHash(v2)))).toBe("stale_base");
  });
});

describe("inmutabilidad y agentes", () => {
  it("una versión aprobada no se edita (ni por la API del store ni por SQL directo) y no se borra", () => {
    const v1 = approvedConvention();
    expect(code(() => kb.update(v1.id, { content: "x" }, "said"))).toBe("not_proposed");
    kb.close();
    const raw = new Database(path);
    expect(() => raw.prepare(`UPDATE kb_docs SET content='x' WHERE id='c1'`).run()).toThrow(/inmutable/);
    expect(() => raw.prepare(`DELETE FROM kb_docs WHERE id='c1'`).run()).toThrow(/no se borran/);
    raw.close();
    kb = new KnowledgeStore(path);
    expect(kb.get("c1")?.content).toBe("Rutas relativas.");
  });

  it("los agentes proponen pero no aprueban, rechazan ni archivan; no versionan decisiones aprobadas", () => {
    const d = kb.create({ id: "dec", title: "Usar SQLite", category: "decisions", content: "c", origin: "kiro", projectId: "prj-a" });
    for (const agent of ["kiro", "claude", "assistant"]) {
      expect(code(() => kb.approve(d.id, agent, versionHash(d)))).toBe("agent_forbidden");
      expect(code(() => kb.reject(d.id, agent, versionHash(d)))).toBe("agent_forbidden");
      expect(code(() => kb.archive(d.id, agent))).toBe("agent_forbidden");
    }
    kb.approve(d.id, "said", versionHash(d));
    expect(code(() => kb.proposeVersion(d.id, { content: "usar Postgres" }, "kiro"))).toBe("agent_forbidden");
    // Una persona sí puede proponer la versión siguiente; un agente sí puede proponer una decisión nueva.
    expect(kb.proposeVersion(d.id, { content: "usar SQLite en WAL" }, "said").version).toBe(2);
    expect(kb.create({ id: "dec2", title: "Nueva", category: "decisions", content: "c", origin: "kiro", projectId: "prj-a" }).status).toBe("proposed");
  });
});
