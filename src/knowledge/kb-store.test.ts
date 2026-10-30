import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./kb-store.js";

let dir: string;
let dbPath: string;
let kb: KnowledgeStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saiki-kb-"));
  dbPath = join(dir, "knowledge.sqlite");
  kb = new KnowledgeStore(dbPath);
});
afterEach(() => {
  kb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Fase 14: Knowledge Base compartida", () => {
  it("8. persiste y permite consultar documentos (texto y metadatos)", () => {
    kb.create({ id: "d1", title: "Router de agentes", category: "architecture", content: "El router resuelve rol->adaptador.", origin: "human" });
    kb.create({ id: "d2", title: "Elección de SQLite", category: "decisions", content: "Usamos SQLite por simplicidad.", origin: "human" });

    expect(kb.get("d1")?.title).toBe("Router de agentes");
    expect(kb.search({ text: "router" }).map((d) => d.id)).toContain("d1");
    expect(kb.search({ category: "decisions" }).map((d) => d.id)).toEqual(["d2"]);
  });

  it("9. los estados del conocimiento se respetan (nace proposed)", () => {
    const doc = kb.create({ id: "d1", title: "t", category: "lessons", content: "c", origin: "human" });
    expect(doc.status).toBe("proposed");
    // Solo las búsquedas por estado devuelven lo correcto.
    expect(kb.search({ status: "proposed" }).map((d) => d.id)).toContain("d1");
    expect(kb.search({ status: "approved" })).toHaveLength(0);
  });

  it("10. un AGENTE no puede aprobar conocimiento oficial por sí mismo", () => {
    kb.create({ id: "d1", title: "t", category: "conventions", content: "c", origin: "assistant" });
    // Actores de agente: rechazados.
    for (const agent of ["assistant", "moderator", "kiro", "claude", "opencode"]) {
      expect(() => kb.approve("d1", agent)).toThrow();
    }
    // Sigue proposed.
    expect(kb.get("d1")?.status).toBe("proposed");
    // Un humano SÍ puede aprobar.
    const approved = kb.approve("d1", "said");
    expect(approved.status).toBe("approved");
  });

  it("11. una decisión reemplazada conserva su historial (superseded)", () => {
    kb.create({ id: "old", title: "Decisión v1", category: "decisions", content: "usar A", origin: "human" });
    kb.approve("old", "said");
    kb.create({ id: "new", title: "Decisión v2", category: "decisions", content: "usar B", origin: "human" });
    kb.approve("new", "said");

    kb.supersede("old", "new", "said");

    const oldDoc = kb.get("old");
    expect(oldDoc?.status).toBe("superseded");
    expect(oldDoc?.supersededBy).toBe("new");
    // El historial del documento viejo SE CONSERVA (created, approve, superseded).
    const hist = kb.history("old");
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist.some((h) => h.action.includes("approved"))).toBe(true);
    expect(hist.some((h) => h.action.includes("superseded"))).toBe(true);
    // La relación supersedes queda registrada.
    const rels = kb.relationsOf("new");
    expect(rels.some((r) => r.type === "supersedes" && r.toId === "old")).toBe(true);
  });

  it("14. el estado sobrevive a reinicios (reabrir la misma base)", () => {
    kb.create({ id: "d1", title: "persistente", category: "projects", content: "c", origin: "human" });
    kb.approve("d1", "said");
    kb.close();

    // "Reinicio": nueva instancia sobre el MISMO archivo.
    const kb2 = new KnowledgeStore(dbPath);
    const recovered = kb2.get("d1");
    expect(recovered?.status).toBe("approved");
    expect(recovered?.title).toBe("persistente");
    expect(kb2.history("d1").length).toBeGreaterThanOrEqual(2);
    kb2.close();
    // Reasignamos para que afterEach no cierre una base ya cerrada.
    kb = new KnowledgeStore(dbPath);
  });

  it("evita duplicar relaciones (INSERT OR IGNORE)", () => {
    kb.create({ id: "a", title: "A", category: "research", content: "c", origin: "human" });
    kb.create({ id: "b", title: "B", category: "research", content: "c", origin: "human" });
    kb.relate("a", "b", "relates_to");
    kb.relate("a", "b", "relates_to"); // duplicada: ignorada
    expect(kb.relationsOf("a").filter((r) => r.type === "relates_to")).toHaveLength(1);
  });
});
