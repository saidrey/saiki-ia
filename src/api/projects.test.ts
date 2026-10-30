import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServerHandle } from "./http-server.js";
import { SaikiCore } from "../core/saiki-core.js";
import { CoreStore } from "../core/core-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createMemoryCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { MockAgentAdapter } from "../agents/mock-agent.js";
import { BasicModerator } from "../moderator/basic-moderator.js";
import { TempRepos } from "../projects/test-repos.js";

/** (Project Registry) Endpoints de proyectos sobre el Core y SQLite reales. */

let repos: TempRepos;
let handle: ApiServerHandle;
let core: SaikiCore;

beforeEach(async () => {
  repos = new TempRepos();
  const mock = new MockAgentAdapter();
  core = new SaikiCore({
    router: new MapAgentRouter({ analyze: mock, develop: mock, review: mock }),
    graphOptions: { checkpointer: createMemoryCheckpointer() },
    coreStore: new CoreStore(":memory:"),
    knowledge: new KnowledgeStore(":memory:"),
    moderator: new BasicModerator(),
    dataDir: join(repos.base, ".saiki"),
  });
  handle = createApiServer({ core, humanActor: "said", port: 0 });
  await handle.ready;
});
afterEach(async () => {
  await handle.close();
  core.close();
  repos.cleanup();
});

async function api(method: string, path: string, body?: unknown) {
  const { port } = handle.server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("POST /projects", () => {
  it("registra y devuelve el proyecto con su salud; el actor lo fija el servidor", async () => {
    const dir = repos.repo("app-ionic");
    const r = await api("POST", "/projects", { name: "app-ionic", path: dir, actor: "otro" });
    expect(r.status).toBe(201);
    expect(r.json.project).toMatchObject({ name: "app-ionic", rootPath: realpathSync(dir), status: "active", applyMode: "sandbox", health: "ok" });
    const h = await api("GET", `/projects/${r.json.project.id}/history`);
    expect(h.json.history).toMatchObject([{ action: "registered", actor: "said" }]);
  });

  it("errores con su código y estado HTTP", async () => {
    const dir = repos.repo("app");
    expect((await api("POST", "/projects", { name: "x", path: "relativa" })).json).toMatchObject({ error: "invalid_path" });
    expect((await api("POST", "/projects", { name: "x", path: repos.dir("plain") })).status).toBe(400);
    expect((await api("POST", "/projects", { name: "x", path: repos.dir("plain2") })).json.error).toBe("not_a_repository");
    expect((await api("POST", "/projects", { name: "x", path: "/" })).json.error).toBe("sensitive_path");
    expect((await api("POST", "/projects", { name: "x", path: dir, applyMode: "real" })).json.error).toBe("confirmation_required");
    expect((await api("POST", "/projects")).json.error).toBe("invalid_name");

    const first = await api("POST", "/projects", { name: "app", path: dir });
    const dup = await api("POST", "/projects", { name: "otro", path: dir });
    expect(dup).toMatchObject({ status: 409, json: { error: "already_registered", projectId: first.json.project.id } });
    const nested = await api("POST", "/projects", { name: "inner", path: repos.repo("app/inner") });
    expect(nested).toMatchObject({ status: 409, json: { error: "nested_project" } });
    const taken = await api("POST", "/projects", { name: "APP", path: repos.repo("b") });
    expect(taken).toMatchObject({ status: 409, json: { error: "name_taken" } });
  });
});

describe("GET, PATCH, activar y desactivar", () => {
  it("lista con filtro de estado, lee uno y 404", async () => {
    const a = (await api("POST", "/projects", { name: "a", path: repos.repo("a") })).json.project;
    await api("POST", "/projects", { name: "b", path: repos.repo("b") });
    await api("POST", `/projects/${a.id}/deactivate`);
    expect((await api("GET", "/projects")).json.projects).toHaveLength(2);
    expect((await api("GET", "/projects?status=active")).json.projects.map((p: any) => p.name)).toEqual(["b"]);
    expect((await api("GET", "/projects?status=inactive")).json.projects.map((p: any) => p.name)).toEqual(["a"]);
    expect((await api("GET", "/projects?status=x")).status).toBe(400);
    expect((await api("GET", `/projects/${a.id}`)).json.project).toMatchObject({ status: "inactive" });
    expect((await api("GET", "/projects/prj-nope")).status).toBe(404);
    expect((await api("GET", "/projects/prj-nope/history")).status).toBe(404);
  });

  it("PATCH renombra y cambia el modo (real con confirmación); la ruta no se edita", async () => {
    const p = (await api("POST", "/projects", { name: "a", path: repos.repo("a") })).json.project;
    expect((await api("PATCH", `/projects/${p.id}`, { name: "renombrado" })).json.project.name).toBe("renombrado");
    expect((await api("PATCH", `/projects/${p.id}`, { applyMode: "real" })).json.error).toBe("confirmation_required");
    expect((await api("PATCH", `/projects/${p.id}`, { applyMode: "real", confirmRealApply: true })).json.project.applyMode).toBe("real");
    const path = await api("PATCH", `/projects/${p.id}`, { path: repos.repo("otro") });
    expect(path).toMatchObject({ status: 400, json: { error: "path_immutable" } });
    expect((await api("GET", `/projects/${p.id}`)).json.project.rootPath).toBe(p.rootPath);
    expect((await api("PATCH", "/projects/prj-nope", { name: "x" })).status).toBe(404);
    const hist = (await api("GET", `/projects/${p.id}/history`)).json.history.map((h: any) => h.action);
    expect(hist).toEqual(["registered", "renamed", "apply_mode_changed"]);
  });

  it("la salud refleja el repositorio movido y no se puede reactivar", async () => {
    const dir = repos.repo("a");
    const p = (await api("POST", "/projects", { name: "a", path: dir })).json.project;
    await api("POST", `/projects/${p.id}/deactivate`);
    renameSync(dir, join(repos.base, "a-movido"));
    expect((await api("GET", `/projects/${p.id}`)).json.project.health).toBe("missing");
    const r = await api("POST", `/projects/${p.id}/activate`);
    expect(r).toMatchObject({ status: 409, json: { error: "project_unhealthy" } });
  });
});

describe("POST /sessions con proyecto (tarea 3)", () => {
  const register = async (name: string) => (await api("POST", "/projects", { name, path: repos.repo(name) })).json.project;

  it("persiste la sesión ligada al proyecto y lo devuelve; repetir es idempotente", async () => {
    const p = await register("a");
    const r = await api("POST", "/sessions", { sessionId: "s1", projectId: p.id });
    expect(r).toMatchObject({ status: 201, json: { sessionId: "s1", existed: false, projectId: p.id } });
    expect((await api("GET", "/sessions/s1")).json.session).toMatchObject({ sessionId: "s1", projectId: p.id, turns: [] });
    expect((await api("POST", "/sessions", { sessionId: "s1", projectId: p.id })).json).toMatchObject({ existed: true, projectId: p.id });
    // Sin projectId, consultar la sesión existente devuelve su proyecto.
    expect((await api("POST", "/sessions", { sessionId: "s1" })).json).toMatchObject({ existed: true, projectId: p.id });
  });

  it("nunca reasigna: otro proyecto, o una sesión general que pide proyecto → 409", async () => {
    const a = await register("a");
    const b = await register("b");
    await api("POST", "/sessions", { sessionId: "s1", projectId: a.id });
    expect(await api("POST", "/sessions", { sessionId: "s1", projectId: b.id })).toMatchObject({
      status: 409,
      json: { error: "session_project_mismatch" },
    });
    await api("POST", "/sessions/general/messages", { message: "hola" });
    expect((await api("POST", "/sessions", { sessionId: "general", projectId: a.id })).json.error).toBe("session_project_mismatch");
    expect((await api("GET", "/sessions/s1")).json.session.projectId).toBe(a.id);
  });

  it("proyecto inexistente, inactivo o con el repositorio movido → sin sesión", async () => {
    expect(await api("POST", "/sessions", { sessionId: "x", projectId: "prj-nope" })).toMatchObject({ status: 404, json: { error: "project_not_found" } });
    const a = await register("a");
    await api("POST", `/projects/${a.id}/deactivate`);
    expect(await api("POST", "/sessions", { sessionId: "x", projectId: a.id })).toMatchObject({ status: 400, json: { error: "project_inactive" } });
    const b = await register("b");
    renameSync(b.rootPath, join(repos.base, "b-movido"));
    expect(await api("POST", "/sessions", { sessionId: "x", projectId: b.id })).toMatchObject({ status: 409, json: { error: "project_unhealthy" } });
    expect((await api("GET", "/sessions/x")).status).toBe(404);
    expect((await api("POST", "/sessions", { projectId: 42 })).status).toBe(400);
  });

  it("sin proyecto se comporta como antes (no persiste) y GET /sessions filtra por proyecto", async () => {
    const r = await api("POST", "/sessions", {});
    expect(r).toMatchObject({ status: 201, json: { existed: false } });
    expect(r.json.projectId).toBeUndefined();
    expect((await api("GET", `/sessions/${r.json.sessionId}`)).status).toBe(404);

    const a = await register("a");
    await api("POST", "/sessions", { sessionId: "s1", projectId: a.id });
    await api("POST", "/sessions/general/messages", { message: "hola" });
    expect((await api("GET", "/sessions")).json.sessions).toHaveLength(2);
    expect((await api("GET", `/sessions?projectId=${a.id}`)).json.sessions.map((s: any) => s.sessionId)).toEqual(["s1"]);
  });

  it("el proyecto de una sesión es inmutable también en SQLite", async () => {
    const a = await register("a");
    await api("POST", "/sessions", { sessionId: "s1", projectId: a.id });
    const store = (core as unknown as { store: CoreStore }).store;
    const s = store.getSession("s1")!;
    expect(() => store.saveSession({ ...s, projectId: "prj-otro" })).toThrow(/inmutable/);
    expect(() => store.saveSession({ ...s, projectId: undefined })).toThrow(/inmutable/);
    // El resto de la sesión sí se actualiza.
    store.saveSession({ ...s, updatedAt: new Date().toISOString() });
  });
});

describe("un desarrollo exige proyecto (tarea 4)", () => {
  const DEV = "implementa un util de suma";

  it("D6: en una sesión general responde con una aclaración (200) y no crea ninguna ejecución", async () => {
    const r = await api("POST", "/sessions/general/messages", { message: DEV });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ category: "clarification", blockedReason: "project_required" });
    expect(r.json.result.clarifyingQuestion).toMatch(/necesito un proyecto/);
    expect(r.json.result.developmentThreadId).toBeUndefined();
    const s = (await api("GET", "/sessions/general")).json.session;
    expect(s.developmentThreadIds ?? []).toEqual([]);
    expect(s.turns.map((t: any) => t.role)).toEqual(["user", "moderator"]);
  });

  it("la sesión general sigue conversando", async () => {
    const r = await api("POST", "/sessions/general/messages", { message: "¿cómo estás?" });
    expect(r.json.result).toMatchObject({ category: "conversation" });
    expect(r.json.result.blockedReason).toBeUndefined();
  });

  it("revalida al iniciar: proyecto desactivado o repositorio movido → sin ejecución y con el motivo", async () => {
    const dir = repos.repo("a");
    const p = (await api("POST", "/projects", { name: "a", path: dir })).json.project;
    await api("POST", "/sessions", { sessionId: "s1", projectId: p.id });
    await api("POST", "/sessions", { sessionId: "s2", projectId: p.id });

    await api("POST", `/projects/${p.id}/deactivate`);
    const off = (await api("POST", "/sessions/s1/messages", { message: DEV })).json.result;
    expect(off).toMatchObject({ category: "clarification", blockedReason: "project_unavailable" });
    expect(off.clarifyingQuestion).toMatch(/desactivado/);

    await api("POST", `/projects/${p.id}/activate`);
    renameSync(dir, join(repos.base, "a-movido"));
    const moved = (await api("POST", "/sessions/s2/messages", { message: DEV })).json.result;
    expect(moved).toMatchObject({ category: "clarification", blockedReason: "project_unavailable" });
    expect(moved.clarifyingQuestion).toMatch(/no está disponible/);
    for (const id of ["s1", "s2"]) expect((await api("GET", `/sessions/${id}`)).json.session.developmentThreadIds ?? []).toEqual([]);
  });
});
