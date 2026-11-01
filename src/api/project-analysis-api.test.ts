import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "../projects/test-flow.js";
import { DATA_DIR_ENV, resolveDataPaths, type DataPaths } from "../persistence/data-dir.js";

/**
 * (T11) Project Analyst por la API: servidor, Core, KB y SQLite reales
 * (`SAIKI_DATA_DIR` externo); el agente es determinista.
 */

let repos: TempRepos;
let dataRoot: string;
let data: DataPaths;
let agent: FlowAgent;
let srv: TestServer;

async function start(opts: Partial<Parameters<typeof startTestServer>[0]> = {}) {
  srv = await startTestServer({ dir: repos.base, agent, data, ...opts });
}

beforeEach(async () => {
  repos = new TempRepos();
  dataRoot = mkdtempSync(join(tmpdir(), "saiki-data-"));
  const r = resolveDataPaths({ [DATA_DIR_ENV]: join(dataRoot, "data") }, repos.base);
  if (!r.ok) throw new Error(r.message);
  data = r.paths;
  agent = new FlowAgent();
});
afterEach(async () => {
  await srv?.stop().catch(() => undefined);
  repos.cleanup();
  rmSync(dataRoot, { recursive: true, force: true });
});

const api = (method: string, path: string, body?: unknown) => srv.api(method, path, body);
const FILES = { "README.md": "# shop\n", "src/api/server.ts": "export {};\n", "src/core/core.ts": "export {};\n", ".env": "API_TOKEN=abc\n" };

/** Contenido del repositorio (sin .git): demuestra que el análisis no escribe. */
function treeHash(dir: string): string {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !join(e.parentPath, e.name).includes(`${join(dir, ".git")}`))
    .map((e) => join(e.parentPath, e.name))
    .sort();
  return files.map((f) => `${f}\n${readFileSync(f, "utf8")}`).join("\n");
}

async function register(name: string) {
  const path = repos.repo(name, FILES);
  const r = await api("POST", "/projects", { name, path });
  expect(r.status).toBe(201);
  // El registro guarda la ruta real (en macOS, /private/var/...).
  return { id: r.json.project.id as string, path: realpathSync(path) };
}
const answer = (documents: unknown[]) => (agent.projectAnalysis = `Analizado.\n${JSON.stringify({ documents })}`);
const doc = (over: Record<string, unknown> = {}) => ({ category: "architecture", title: "Capas", content: "API → Core.", citedFiles: ["src/api/server.ts"], basedOn: null, ...over });
async function analyze(projectId: string) {
  const r = await api("POST", `/projects/${projectId}/analysis`);
  expect(r.status).toBe(202);
  await srv.core.analysisIdle();
  return (await api("GET", `/projects/${projectId}/analysis`)).json.analysis;
}
const projectDocs = async (projectId: string) => (await api("GET", `/knowledge?projectId=${projectId}`)).json.documents as any[];
const eventsOf = (projectId: string) => srv.core["eventStore"]!.getAll(`project:${projectId}`).map((e: any) => e.type);

describe("Project Analyst", () => {
  it("snapshot válido: una llamada de solo lectura en la raíz, propuestas `proposed` con referencias verificadas y aprobación humana", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    const before = treeHash(a.path);
    answer([doc(), doc({ category: "conventions", title: "Rutas", content: "Rutas relativas.", citedFiles: ["src/core/core.ts", "README.md"] })]);

    const analysis = await analyze(a.id);
    expect(analysis).toMatchObject({ status: "completed", actor: "said", error: null, skipped: [] });
    expect(analysis.proposed.map((p: any) => [p.title, p.version, p.basedOn, p.citedFiles])).toEqual([
      ["Capas", 1, null, ["src/api/server.ts"]],
      ["Rutas", 1, null, ["src/core/core.ts", "README.md"]],
    ]);

    // Una sola llamada, rol projectAnalyst, cwd = raíz; recibe el bundle de buildContext.
    const calls = agent.calls.filter((c) => c.role === "projectAnalyst");
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(a.path);
    expect(calls[0].input).toContain("## Contexto del proyecto «shop»");
    expect(calls[0].input).toContain("### Stack [índice: generado del repositorio]");

    // En la KB: proposed, del proyecto, autor de agente, con «Referencias» y traza del análisis.
    const docs = await projectDocs(a.id);
    expect(docs.map((d) => [d.title, d.status, d.origin, d.projectId])).toEqual(
      expect.arrayContaining([["Capas", "proposed", "projectAnalyst", a.id], ["Rutas", "proposed", "projectAnalyst", a.id]]),
    );
    const capas = docs.find((d) => d.title === "Capas");
    expect(capas.content).toBe("API → Core.\n\nReferencias:\n- `src/api/server.ts`\n");
    expect(srv.core["kb"].history(capas.id)[0].detail).toContain(`analysis=${analysis.id}; snapshot=${analysis.snapshotId}`);
    expect(eventsOf(a.id)).toEqual(expect.arrayContaining(["project.analysis.started", "knowledge.proposed", "project.analysis.completed"]));

    // El analista no aprueba: la KB se lo niega. La persona sí, con el hash exacto.
    expect(srv.core["kb"].approve.bind(srv.core["kb"], capas.id, "projectAnalyst", capas.versionHash)).toThrow(/agente/);
    expect((await api("POST", `/knowledge/${capas.id}/approve`, { versionHash: capas.versionHash })).json.document.status).toBe("approved");
    // Solo lectura: el repositorio no cambió.
    expect(treeHash(a.path)).toBe(before);
  });

  it("una referencia inválida entre varias: no se guarda ninguna propuesta", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    for (const bad of ["src/nope.ts", ".env", "../shop/README.md", "/etc/passwd"]) {
      answer([doc(), doc({ title: "Mala", citedFiles: ["README.md", bad] })]);
      const analysis = await analyze(a.id);
      expect(analysis.status).toBe("failed");
      expect(analysis.error).toContain(`referencia "${bad}" rechazada`);
      expect(analysis.error).not.toContain(a.path);
    }
    expect(await projectDocs(a.id)).toEqual([]);
    expect(eventsOf(a.id)).not.toContain("knowledge.proposed");
  });

  it("más de seis documentos: rechazo completo", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    answer(Array.from({ length: 7 }, (_, i) => doc({ title: `D${i}` })));
    expect((await analyze(a.id)).error).toContain("Como mucho 6 documentos");
    expect(await projectDocs(a.id)).toEqual([]);
  });

  it("secretos redactados en lo que se guarda", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    answer([doc({ content: "Despliegue con API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123." })]);
    await analyze(a.id);
    const [d] = await projectDocs(a.id);
    expect(d.content).toContain("API_TOKEN=***");
    expect(d.content).not.toContain("ghp_");
  });

  it("basedOn crea la versión siguiente sin tocar la aprobada; si ya hay una pendiente, se omite", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    const v1 = (await api("POST", `/projects/${a.id}/knowledge`, { category: "conventions", title: "Rutas", content: "Rutas relativas." })).json.document;
    await api("POST", `/knowledge/${v1.id}/approve`, { versionHash: v1.versionHash });

    answer([doc({ category: "conventions", title: "Rutas", content: "Rutas relativas a src/.", citedFiles: ["src/core/core.ts"], basedOn: v1.id })]);
    const first = await analyze(a.id);
    expect(first.proposed).toEqual([expect.objectContaining({ documentId: v1.id, version: 2, basedOn: v1.id })]);
    expect((await api("GET", `/knowledge/${v1.id}`)).json.document).toMatchObject({ status: "approved", content: "Rutas relativas." });
    // El prompt ofreció el id de la versión vigente.
    expect(agent.calls.at(-1)!.input).toContain(`- ${v1.id} · conventions · Rutas · v1`);

    // Segunda vez: la v2 sigue pendiente → se omite; el documento nuevo sí entra.
    answer([doc({ category: "conventions", title: "Rutas", content: "Otra redacción.", citedFiles: ["README.md"], basedOn: v1.id }), doc()]);
    const second = await analyze(a.id);
    expect(second.status).toBe("completed");
    expect(second.skipped).toEqual([expect.objectContaining({ basedOn: v1.id, reason: expect.stringMatching(/pendiente/) })]);
    expect(second.proposed.map((p: any) => p.title)).toEqual(["Capas"]);
    expect((await api("GET", `/knowledge/${v1.id}/versions`)).json.versions.map((d: any) => [d.version, d.status])).toEqual([[1, "approved"], [2, "proposed"]]);
  });

  it("aislamiento: referencias y basedOn de otro proyecto se rechazan; cada proyecto ve solo lo suyo", async () => {
    await start();
    const a = await register("shop");
    const b = await register("blog");
    await srv.core.contextIdle();
    const vb = (await api("POST", `/projects/${b.id}/knowledge`, { category: "conventions", title: "De blog", content: "c" })).json.document;
    await api("POST", `/knowledge/${vb.id}/approve`, { versionHash: vb.versionHash });

    answer([doc({ category: "conventions", basedOn: vb.id })]);
    expect((await analyze(a.id)).error).toMatch(/basedOn no es un documento aprobado vigente del proyecto/);
    answer([doc({ citedFiles: ["../blog/README.md"] })]);
    expect((await analyze(a.id)).status).toBe("failed");

    answer([doc()]);
    await analyze(a.id);
    expect((await projectDocs(a.id)).map((d) => d.title)).toEqual(["Capas"]);
    expect((await projectDocs(b.id)).map((d) => d.title)).toEqual(["De blog"]);
    // El prompt de A no contiene el conocimiento de B.
    expect(agent.calls.filter((c) => c.role === "projectAnalyst").every((c) => !c.input.includes(vb.id))).toBe(true);
  });

  it("error y timeout del agente: análisis fallido, sin reintentos y sin propuestas", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    agent.projectAnalysis = { status: "failure", role: "projectAnalyst", output: "", error: "Kiro CLI excedio el timeout de 180000 ms." };
    const analysis = await analyze(a.id);
    expect(analysis).toMatchObject({ status: "failed", error: "El analista de proyecto falló: Kiro CLI excedio el timeout de 180000 ms." });
    expect(agent.calls.filter((c) => c.role === "projectAnalyst")).toHaveLength(1);
    expect(eventsOf(a.id)).toContain("project.analysis.failed");
    expect(await projectDocs(a.id)).toEqual([]);
  });

  it("sin snapshot, proyecto inexistente o análisis en curso: rechazo", async () => {
    await start({ contextScan: { scan: { beforeHash: async () => { throw new Error("escaneo roto"); } } } });
    const a = await register("shop");
    await srv.core.contextIdle();
    expect(await api("POST", `/projects/${a.id}/analysis`)).toMatchObject({ status: 409, json: { error: "no_snapshot" } });
    expect((await api("POST", "/projects/nope/analysis")).status).toBe(404);
    expect((await api("GET", "/projects/nope/analysis")).status).toBe(404);
    expect((await api("GET", `/projects/${a.id}/analysis`)).json.analysis).toBeNull();
    expect(agent.calls.filter((c) => c.role === "projectAnalyst")).toHaveLength(0);
  });

  it("uno a la vez por proyecto", async () => {
    await start();
    const a = await register("shop");
    await srv.core.contextIdle();
    answer([doc()]);
    const hold = agent.hold("projectAnalyst");
    expect((await api("POST", `/projects/${a.id}/analysis`)).status).toBe(202);
    await hold.started;
    expect(await api("POST", `/projects/${a.id}/analysis`)).toMatchObject({ status: 409, json: { error: "analysis_running" } });
    expect((await api("GET", `/projects/${a.id}/analysis`)).json.analysis.status).toBe("running");
    hold.release();
    await srv.core.analysisIdle();
    expect((await api("GET", `/projects/${a.id}/analysis`)).json.analysis.status).toBe("completed");
  });
});
