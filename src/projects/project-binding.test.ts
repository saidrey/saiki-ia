import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { CoreStore } from "../core/core-store.js";
import { TempRepos } from "./test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "./test-flow.js";

/**
 * (Project Registry, tarea 5) Vinculación inmutable ejecución → proyecto.
 * Grafo, Core, API y SQLite reales; agentes deterministas. Las pruebas no llegan
 * a aplicar: la escritura y su guardia se prueban en la tarea 7.
 */

const DEV = "implementa un util de suma";
let repos: TempRepos;
let srv: TestServer;
let agent: FlowAgent;

beforeEach(async () => {
  repos = new TempRepos();
  agent = new FlowAgent();
  srv = await startTestServer({ dir: repos.base, agent, persist: true });
});
afterEach(async () => {
  await srv.stop().catch(() => undefined);
  repos.cleanup();
});

const store = () => (srv.core as unknown as { store: CoreStore }).store;
const db = () => (store() as unknown as { db: Database.Database }).db;

async function project(name: string) {
  return (await srv.api("POST", "/projects", { name, path: repos.repo(name) })).json.project;
}
async function startDev(sessionId: string, projectId: string): Promise<string> {
  await srv.api("POST", "/sessions", { sessionId, projectId });
  const r = await srv.api("POST", `/sessions/${sessionId}/messages`, { message: DEV });
  return r.json.result.developmentThreadId;
}
const view = async (t: string) => (await srv.api("GET", `/executions/${t}`)).json.execution;

describe("vinculación al nacer", () => {
  it("la ejecución expone su proyecto, y el estado del grafo coincide con la tabla", async () => {
    const p = await project("a");
    const t = await startDev("s1", p.id);
    const v = await view(t);
    expect(v.project).toMatchObject({ id: p.id, name: "a", rootPath: p.rootPath, applyMode: "sandbox", current: { name: "a", status: "active", health: "ok" } });
    expect(v.applyTarget).toBeNull();
    const row = store().getExecutionProject(t)!;
    expect(row).toMatchObject({ projectId: p.id, rootPath: p.rootPath, applyMode: "sandbox", boundAt: v.project.boundAt });
    expect(row.fingerprint).toEqual(store().getProject(p.id)!.fingerprint);
  });

  it("cada ejecución hereda el proyecto de SU sesión, no de otra ni de la anterior", async () => {
    const a = await project("a");
    const b = await project("b");
    const ta1 = await startDev("sa", a.id);
    const tb = await startDev("sb", b.id);
    const ta2 = await startDev("sa", a.id);
    expect((await view(ta1)).project.id).toBe(a.id);
    expect((await view(tb)).project.id).toBe(b.id);
    expect((await view(ta2)).project.id).toBe(a.id);
    expect(new Set([ta1, tb, ta2]).size).toBe(3);
    expect([ta1, tb, ta2].map((t) => store().getExecutionProject(t)?.projectId)).toEqual([a.id, b.id, a.id]);
  });
});

describe("inmutabilidad", () => {
  it("se conserva al reanudar (nueva versión de la HU) y ante un intento de sobrescribir el estado", async () => {
    const p = await project("a");
    const other = await project("b");
    const t = await startDev("s1", p.id);
    const before = (await view(t)).project;

    const hash = (await view(t)).pendingApproval.decisionHash;
    const r = await srv.api("POST", `/executions/${t}/approval/hu_review`, { decision: "request_changes", decisionHash: hash, feedback: "más detalle" });
    expect(r.status).toBe(200);
    expect((await view(t)).project).toEqual(before);

    // Ni siquiera una escritura directa en el checkpoint cambia el proyecto (reducer keep-first).
    const graph = (srv.core as unknown as { graph: { updateState: (c: unknown, v: unknown) => Promise<unknown> } }).graph;
    const forged = { ...store().getExecutionProject(t)!, projectId: other.id, rootPath: other.rootPath };
    await graph.updateState({ configurable: { thread_id: t } }, { project: forged });
    expect((await view(t)).project).toEqual(before);
  });

  it("execution_projects es de solo inserción: no se revincula, no se edita, no se borra", async () => {
    const p = await project("a");
    const t = await startDev("s1", p.id);
    const row = store().getExecutionProject(t)!;
    expect(() => store().insertExecutionProject(t, { ...row, rootPath: "/otro" })).toThrow();
    expect(() => db().prepare(`UPDATE execution_projects SET rootPath='/otro' WHERE executionId=?`).run(t)).toThrow(/inmutable/);
    expect(() => db().prepare(`DELETE FROM execution_projects WHERE executionId=?`).run(t)).toThrow(/inmutable/);
    expect(store().getExecutionProject(t)).toEqual(row);
  });

  it("sobrevive al reinicio del backend", async () => {
    const p = await project("a");
    const t = await startDev("s1", p.id);
    const before = (await view(t)).project;
    await srv.stop();
    srv = await startTestServer({ dir: repos.base, agent, persist: true });
    expect((await view(t)).project).toEqual(before);
    expect(store().getExecutionProject(t)?.projectId).toBe(p.id);
  });

  it("renombrar o desactivar el proyecto no cambia la copia; la vista muestra el estado actual aparte", async () => {
    const p = await project("a");
    const t = await startDev("s1", p.id);
    await srv.api("PATCH", `/projects/${p.id}`, { name: "a-renombrado" });
    await srv.api("POST", `/projects/${p.id}/deactivate`);
    expect((await view(t)).project).toMatchObject({ name: "a", current: { name: "a-renombrado", status: "inactive" } });
  });
});

describe("D5: desactivar con ejecuciones", () => {
  it("con una ejecución trabajando → 409 has_active_executions; pausada → se permite", async () => {
    const p = await project("a");
    await srv.api("POST", "/sessions", { sessionId: "s1", projectId: p.id });
    const held = agent.hold("huAnalyst");
    const sending = srv.api("POST", "/sessions/s1/messages", { message: DEV });
    await held.started;
    const busy = await srv.api("POST", `/projects/${p.id}/deactivate`);
    expect(busy).toMatchObject({ status: 409, json: { error: "has_active_executions" } });
    held.release();
    const t = (await sending).json.result.developmentThreadId;
    expect((await view(t)).lifecycle).toBe("awaiting_decision");
    expect(await srv.api("POST", `/projects/${p.id}/deactivate`)).toMatchObject({ status: 200, json: { project: { status: "inactive" } } });
  });
});
