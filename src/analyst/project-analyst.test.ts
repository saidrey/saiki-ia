import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRecord } from "../context/context-store.js";
import { createDefaultRouter, MapAgentRouter } from "../agents/router.js";
import { KiroCliAdapter } from "../agents/kiro-cli-agent.js";
import type { AgentAdapter, AgentRequest } from "../agents/types.js";
import {
  buildProjectAnalystPrompt,
  checkReference,
  runProjectAnalyst,
  validateProjectAnalysis,
  type AnalystApprovedDoc,
} from "./project-analyst.js";

/** (T11) Validación de las propuestas del Project Analyst: referencias verificables y todo o nada. */

let root: string;
let outside: string;
let index: Map<string, FileRecord>;

const rec = (path: string, kind: FileRecord["kind"] = "source"): FileRecord => ({ path, kind, lang: null, size: 1, mtimeMs: 0, hash: kind === "secret" ? null : "h", lastScanId: "s" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-analyst-"));
  outside = mkdtempSync(join(tmpdir(), "saiki-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/app.ts"), "export {};\n");
  writeFileSync(join(root, "README.md"), "# r\n");
  writeFileSync(join(root, ".env"), "TOKEN=x\n");
  writeFileSync(join(outside, "secret.ts"), "x\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src/link.ts"));
  // El índice puede contener lo que el disco ya no tiene (archivo borrado tras el escaneo).
  index = new Map([rec("src/app.ts"), rec("README.md", "doc"), rec(".env", "secret"), rec("src/link.ts"), rec("src/gone.ts")].map((f) => [f.path, f]));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const doc = (over: Record<string, unknown> = {}) => ({ category: "architecture", title: "Capas", content: "API → Core.", citedFiles: ["src/app.ts"], basedOn: null, ...over });
const validate = (documents: unknown[], approved: AnalystApprovedDoc[] = []) => validateProjectAnalysis({ documents }, { rootDir: root, index, approved });

describe("checkReference", () => {
  it("acepta un archivo indexado, regular y dentro de la raíz", () => {
    expect(checkReference("src/app.ts", root, index)).toBeNull();
    expect(checkReference("README.md", root, index)).toBeNull();
  });

  it("rechaza absolutas, traversal, no indexadas, secretos, symlinks y lo que no existe en disco", () => {
    expect(checkReference(join(root, "src/app.ts"), root, index)).toMatch(/traversal/);
    expect(checkReference("../x.ts", root, index)).toMatch(/traversal/);
    expect(checkReference("src/../src/app.ts", root, index)).toMatch(/traversal/);
    expect(checkReference("./src/app.ts", root, index)).toMatch(/traversal/);
    expect(checkReference("src\\app.ts", root, index)).toMatch(/traversal/);
    expect(checkReference("src/other.ts", root, index)).toMatch(/índice/);
    expect(checkReference(".env", root, index)).toMatch(/secreto/);
    expect(checkReference("src/link.ts", root, index)).toMatch(/simbólico/);
    expect(checkReference("src/gone.ts", root, index)).toMatch(/no existe/);
    expect(checkReference("src", root, new Map([["src", rec("src")]]))).toMatch(/no es un archivo/);
  });
});

describe("validateProjectAnalysis", () => {
  it("referencias válidas: añade «Referencias» al contenido y quita duplicados", () => {
    const r = validate([doc({ citedFiles: ["src/app.ts", "README.md", "src/app.ts"] })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documents[0].citedFiles).toEqual(["src/app.ts", "README.md"]);
    expect(r.documents[0].content).toBe("API → Core.\n\nReferencias:\n- `src/app.ts`\n- `README.md`\n");
  });

  it("una referencia inválida entre varias: se rechaza todo, con el motivo", () => {
    const r = validate([doc(), doc({ title: "Otro", citedFiles: ["README.md", "src/link.ts"] })]);
    expect(r).toEqual({ ok: false, errors: ['documento 2: referencia "src/link.ts" rechazada (es un enlace simbólico).'] });
  });

  it("como mucho seis documentos", () => {
    expect(validate(Array.from({ length: 6 }, (_, i) => doc({ title: `D${i}` }))).ok).toBe(true);
    expect(validate(Array.from({ length: 7 }, (_, i) => doc({ title: `D${i}` })))).toEqual({ ok: false, errors: ["Como mucho 6 documentos (llegaron 7)."] });
  });

  it("forma: categoría, título, contenido y citas obligatorias", () => {
    for (const bad of [doc({ category: "research" }), doc({ title: " " }), doc({ content: "" }), doc({ citedFiles: [] }), doc({ citedFiles: "src/app.ts" }), doc({ title: "x".repeat(121) })]) {
      expect(validate([bad]).ok).toBe(false);
    }
    expect(validateProjectAnalysis({}, { rootDir: root, index, approved: [] }).ok).toBe(false);
  });

  it("redacta secretos del título y del contenido", () => {
    const r = validate([doc({ title: "Token ghp_abcdefghijklmnopqrstuvwxyz0123", content: "Usa API_KEY=sk-ant-abcdefghijklmnopqrstuvwx en local." })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.documents[0].title).toBe("Token ***");
    expect(r.documents[0].content).toContain("API_KEY=***");
    expect(r.documents[0].content).not.toContain("sk-ant-");
  });

  it("basedOn: solo una versión aprobada vigente del proyecto, de la misma categoría y que no sea una decisión", () => {
    const approved: AnalystApprovedDoc[] = [
      { id: "conv-v2", category: "conventions", title: "Rutas", version: 2 },
      { id: "dec", category: "decisions", title: "SQLite", version: 1 },
    ];
    expect(validate([doc({ category: "conventions", basedOn: "conv-v2" })], approved).ok).toBe(true);
    expect(validate([doc({ category: "conventions", basedOn: "conv" })], approved)).toMatchObject({ ok: false, errors: [expect.stringMatching(/aprobado vigente/)] });
    expect(validate([doc({ category: "architecture", basedOn: "conv-v2" })], approved)).toMatchObject({ ok: false, errors: [expect.stringMatching(/otra categoría/)] });
    expect(validate([doc({ category: "decisions", basedOn: "dec" })], approved)).toMatchObject({ ok: false, errors: [expect.stringMatching(/decisión aprobada/)] });
  });
});

describe("ejecución: un rol de solo lectura y una sola llamada", () => {
  it("el rol por defecto es Kiro con fs_read (sin escritura ni ejecución)", () => {
    const adapter = createDefaultRouter().forRole("projectAnalyst");
    expect(adapter).toBeInstanceOf(KiroCliAdapter);
    expect((adapter as unknown as { trustTools: string }).trustTools).toBe("fs_read");
  });

  it("una llamada con cwd = raíz; error y timeout del agente se devuelven tal cual, sin reintentos", async () => {
    const calls: AgentRequest[] = [];
    const agent = (result: { status: "success" | "failure"; output: string; error?: string }): AgentAdapter => ({
      name: "fake",
      run: async (r) => {
        calls.push(r);
        return { ...result, role: r.role };
      },
    });
    const input = { projectName: "p", rootDir: root, bundle: "## Contexto", modules: [], approved: [], index };
    const route = (a: AgentAdapter) => new MapAgentRouter({ analyze: a, develop: a, review: a, projectAnalyst: a });

    const ok = await runProjectAnalyst(route(agent({ status: "success", output: `Hecho.\n${JSON.stringify({ documents: [doc()] })}` })), input);
    expect(ok.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ role: "projectAnalyst", context: { workingDirectory: root } });
    expect(calls[0].input).toContain("SOLO LECTURA");
    expect(calls[0].input).toContain("## Contexto");

    calls.length = 0;
    const timeout = await runProjectAnalyst(route(agent({ status: "failure", output: "", error: "Kiro CLI excedio el timeout de 1000 ms." })), input);
    expect(timeout).toEqual({ ok: false, error: "El analista de proyecto falló: Kiro CLI excedio el timeout de 1000 ms." });
    expect(calls).toHaveLength(1);

    const truncated = await runProjectAnalyst(route(agent({ status: "success", output: '{"documents":[{"category":"architecture"' })), input);
    expect(truncated).toEqual({ ok: false, error: "Análisis de proyecto no parseable: la respuesta no contiene un objeto JSON completo" });
  });

  it("el prompt lista el conocimiento aprobado (con su id) y los módulos", () => {
    const p = buildProjectAnalystPrompt({
      projectName: "p", rootDir: root, bundle: "B",
      modules: [{ path: "src", files: 3, tests: 1 }],
      approved: [{ id: "conv-v2", category: "conventions", title: "Rutas", version: 2 }],
    });
    expect(p).toContain("- conv-v2 · conventions · Rutas · v2");
    expect(p).toContain("- src · 3 · 1");
  });
});
