import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type FlowPlan, type TestServer } from "../projects/test-flow.js";
import { DATA_DIR_ENV, resolveDataPaths, type DataPaths } from "../persistence/data-dir.js";
import { CONTEXT_SECTIONS } from "../context/context-builder.js";

/**
 * (T10) Conocimiento por proyecto por la API, y su llegada al contexto
 * congelado de las ejecuciones. Servidor, Core, grafo y SQLite reales
 * (`SAIKI_DATA_DIR` externo); agentes deterministas.
 */

const PLAN: FlowPlan = () => ({ hu: "Reembolso de pagos", affected: "README.md", create: { path: "src/gen.ts", content: "export const v = 1;\n" } });

let repos: TempRepos;
let dataRoot: string;
let data: DataPaths;
let agent: FlowAgent;
let srv: TestServer;

beforeEach(async () => {
  repos = new TempRepos();
  dataRoot = mkdtempSync(join(tmpdir(), "saiki-data-"));
  const r = resolveDataPaths({ [DATA_DIR_ENV]: join(dataRoot, "data") }, repos.base);
  if (!r.ok) throw new Error(r.message);
  data = r.paths;
  agent = new FlowAgent(PLAN);
  srv = await startTestServer({ dir: repos.base, agent, data });
});
afterEach(async () => {
  await srv.stop().catch(() => undefined);
  repos.cleanup();
  rmSync(dataRoot, { recursive: true, force: true });
});

const api = (method: string, path: string, body?: unknown) => srv.api(method, path, body);
async function register(name: string) {
  const r = await api("POST", "/projects", { name, path: repos.repo(name, { "README.md": `# ${name}\n`, "src/payments/refund.ts": "x\n" }) });
  expect(r.status).toBe(201);
  return r.json.project as { id: string };
}
async function propose(projectId: string, category: string, title: string, content: string) {
  const r = await api("POST", `/projects/${projectId}/knowledge`, { category, title, content });
  expect(r.status).toBe(201);
  return r.json.document as { id: string; versionHash: string; version: number; documentId: string };
}
async function approve(doc: { id: string; versionHash: string }) {
  const r = await api("POST", `/knowledge/${doc.id}/approve`, { versionHash: doc.versionHash });
  expect(r.status).toBe(200);
  return r.json.document as { id: string; status: string; version: number };
}
async function runToFinal(sessionId: string, projectId: string): Promise<string> {
  await api("POST", "/sessions", { sessionId, projectId });
  const t = (await api("POST", `/sessions/${sessionId}/messages`, { message: "implementa esto [P:R]" })).json.result.developmentThreadId as string;
  const hash = (await api("GET", `/executions/${t}`)).json.execution.pendingApproval.decisionHash;
  expect((await api("POST", `/executions/${t}/approval/hu_review`, { decision: "approve", decisionHash: hash })).status).toBe(200);
  return t;
}
const bundles = async (t: string) => (await api("GET", `/executions/${t}/context`)).json.context as { technicalBundle: string; developerBundle: string };

describe("API de conocimiento por proyecto", () => {
  it("proponer, consultar sin mezclar, aprobar con el hash exacto, nueva versión, rechazo y exportación", async () => {
    const a = await register("shop");
    const b = await register("blog");
    srv.core.proposeKnowledge({ id: "g1", title: "Global", category: "research", content: "c", origin: "human" });

    const v1 = await propose(a.id, "conventions", "Convención de rutas", "Rutas relativas.");
    expect(v1).toMatchObject({ status: "proposed", projectId: a.id, version: 1, basedOn: null, origin: "said" });
    expect(v1.versionHash).toMatch(/^[0-9a-f]{64}$/);

    // Sin projectId: solo lo global (como antes). Con él: solo ese proyecto.
    expect((await api("GET", "/knowledge")).json.documents.map((d: any) => d.id)).toEqual(["g1"]);
    expect((await api("GET", `/knowledge?projectId=${a.id}`)).json.documents.map((d: any) => d.id)).toEqual([v1.id]);
    expect((await api("GET", `/knowledge?projectId=${b.id}`)).json.documents).toEqual([]);
    expect((await api("GET", "/knowledge?projectId=nope")).status).toBe(404);

    // Validación y decisiones atadas a la versión revisada.
    expect((await api("POST", `/projects/${a.id}/knowledge`, { category: "research", title: "t", content: "c" })).status).toBe(400);
    expect((await api("POST", "/projects/nope/knowledge", { category: "conventions", title: "t", content: "c" })).status).toBe(404);
    expect((await api("POST", `/knowledge/${v1.id}/approve`, {})).status).toBe(400);
    expect(await api("POST", `/knowledge/${v1.id}/approve`, { versionHash: "0".repeat(64) })).toMatchObject({ status: 409, json: { error: "hash_mismatch" } });
    expect((await approve(v1)).status).toBe("approved");
    expect(await api("POST", `/knowledge/${v1.id}/approve`, { versionHash: v1.versionHash })).toMatchObject({ status: 409, json: { error: "not_proposed" } });

    // Nueva versión (no toca la aprobada); una pendiente por documento.
    const v2r = await api("POST", `/knowledge/${v1.id}/versions`, { content: "Rutas relativas a la raíz." });
    expect(v2r.status).toBe(201);
    const v2 = v2r.json.document;
    expect(v2).toMatchObject({ documentId: v1.id, version: 2, basedOn: v1.id, status: "proposed" });
    expect(await api("POST", `/knowledge/${v1.id}/versions`, { content: "otra" })).toMatchObject({ status: 409, json: { error: "pending_exists" } });
    expect((await api("GET", `/knowledge/${v1.id}`)).json.document).toMatchObject({ status: "approved", content: "Rutas relativas." });

    // Rechazo → archivada; después, versión 3 aprobada → la 1 queda reemplazada.
    expect((await api("POST", `/knowledge/${v2.id}/reject`, { versionHash: v2.versionHash })).json.document.status).toBe("archived");
    const v3 = (await api("POST", `/knowledge/${v1.id}/versions`, { content: "Rutas relativas a src/." })).json.document;
    await approve(v3);
    const versions = (await api("GET", `/knowledge/${v1.id}/versions`)).json.versions.map((d: any) => [d.version, d.status]);
    expect(versions).toEqual([[1, "superseded"], [2, "archived"], [3, "approved"]]);

    // Exportación: solo lo aprobado vigente, con versión y aprobador.
    const md = (await api("GET", `/projects/${a.id}/knowledge/export`)).json.markdown as string;
    expect(md).toContain("# Conocimiento aprobado de «shop»");
    expect(md).toContain("## Convención de rutas");
    expect(md).toContain("Versión 3, aprobada por said");
    expect(md).toContain("Rutas relativas a src/.");
    expect(md).not.toContain("Rutas relativas a la raíz.");
    expect((await api("GET", "/projects/nope/knowledge/export")).status).toBe(404);

    // Archivar la oficial: deja de estar vigente.
    expect((await api("POST", `/knowledge/${v3.id}/archive`)).json.document.status).toBe("archived");
    expect((await api("GET", `/projects/${a.id}/knowledge/export`)).json.markdown).toContain("Todavía no hay conocimiento aprobado.");
  });
});

describe("conocimiento aprobado en el contexto congelado", () => {
  it("entra solo lo aprobado del proyecto, con su versión exacta; una versión posterior no cambia el contexto histórico", async () => {
    const a = await register("shop");
    const b = await register("blog");
    await srv.core.contextIdle();
    const conv = await approve(await propose(a.id, "conventions", "Convención de pagos", "Los importes van en céntimos (enteros)."));
    await approve(await propose(a.id, "architecture", "Capas", "API → Core → stores."));
    await propose(a.id, "decisions", "Pendiente de aprobar", "TEXTO-PROPUESTO-NO-OFICIAL");
    await approve(await propose(b.id, "conventions", "Convención de otro proyecto", "TEXTO-DE-OTRO-PROYECTO"));

    const t1 = await runToFinal("s1", a.id);
    const c1 = srv.core.getExecutionContext(t1);
    if (!c1.ok) throw new Error(c1.message);
    const { technicalBundle, developerBundle } = await bundles(t1);

    expect(technicalBundle).toContain(CONTEXT_SECTIONS.knowledge);
    // Convenciones primero, con su versión.
    const iConv = technicalBundle.indexOf("#### Convención de pagos (convenciones, versión 1)");
    const iArch = technicalBundle.indexOf("#### Capas (arquitectura, versión 1)");
    expect(iConv).toBeGreaterThan(-1);
    expect(iArch).toBeGreaterThan(iConv);
    for (const text of ["TEXTO-PROPUESTO-NO-OFICIAL", "TEXTO-DE-OTRO-PROYECTO"]) {
      expect(technicalBundle).not.toContain(text);
    }
    // Claude también recibe el conocimiento aprobado (su subconjunto lo conserva).
    expect(developerBundle).toContain("Los importes van en céntimos (enteros).");
    // Trazabilidad: referencia a la versión exacta.
    expect(c1.context.sources.filter((s) => s.kind === "knowledge")).toEqual([
      { kind: "knowledge", ref: conv.id, version: 1, title: "Convención de pagos", category: "conventions", included: "full" },
      expect.objectContaining({ kind: "knowledge", version: 1, title: "Capas" }),
    ]);
    // La vista de la ejecución también lo cuenta.
    const view = (await api("GET", `/executions/${t1}`)).json.execution.context;
    expect(view.sources.find((s: any) => s.kind === "knowledge" && s.title === "Convención de pagos")).toMatchObject({ ref: conv.id, version: 1 });

    // Nueva versión aprobada después de congelar: el contexto de t1 no cambia; una ejecución nueva recibe la v2.
    const v2 = (await api("POST", `/knowledge/${conv.id}/versions`, { content: "Los importes van en céntimos; nunca decimales." })).json.document;
    await approve(v2);
    const again = srv.core.getExecutionContext(t1);
    expect(again).toEqual(c1);
    const t2 = await runToFinal("s2", a.id);
    const second = await bundles(t2);
    expect(second.technicalBundle).toContain("#### Convención de pagos (convenciones, versión 2)");
    expect(second.technicalBundle).toContain("nunca decimales");
    expect((await bundles(t1)).technicalBundle).toBe(technicalBundle);
  });

  it("sin conocimiento aprobado, el bundle no tiene esa sección (comportamiento anterior)", async () => {
    const a = await register("shop");
    await srv.core.contextIdle();
    await propose(a.id, "conventions", "Solo propuesta", "c");
    const t = await runToFinal("s1", a.id);
    expect((await bundles(t)).technicalBundle).not.toContain(CONTEXT_SECTIONS.knowledge);
  });
});
