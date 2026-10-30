import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildHuGraph, Command } from "../hu/hu-graph.js";
import { createSqliteCheckpointer } from "../persistence/checkpointer.js";
import { MapAgentRouter } from "../agents/router.js";
import { TempRepos } from "./test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "./test-flow.js";
import { BOOTSTRAP_ACTOR, registerHomeProject } from "./home-project.js";

/**
 * (Project Registry, tarea 8) Compatibilidad con datos anteriores al registro:
 * base de datos con el esquema antiguo, sesiones sin proyecto y ejecuciones
 * cuyos checkpoints no tienen `project`.
 */

let repos: TempRepos;
let dataDir: string;
let legacyRoot: string;
let srv: TestServer;
let agent: FlowAgent;
let tFinal: string;
let tHu: string;

/** Esquema de core.sqlite ANTES del registro de proyectos (solo las tablas de entonces). */
function createLegacyCoreDb(path: string, session: Record<string, unknown>) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE core_sessions (sessionId TEXT PRIMARY KEY, updatedAt TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE core_tasks (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, updatedAt TEXT NOT NULL, data TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO core_sessions VALUES (?, ?, ?)`).run(session.sessionId, session.updatedAt, JSON.stringify(session));
  db.close();
}

beforeEach(async () => {
  repos = new TempRepos();
  dataDir = repos.dir("data");
  legacyRoot = repos.dir("legacy-root");
  mkdirSync(join(legacyRoot, "src"));
  writeFileSync(join(legacyRoot, "README.md"), "# legado\n");
  agent = new FlowAgent();

  // Ejecuciones creadas como antes: grafo sin proyecto, con la ruta fija del backend.
  const router = new MapAgentRouter({
    analyze: agent, develop: agent, review: agent, huAnalyst: agent,
    technicalAnalyst: agent, functionalReviewer: agent, qualityReviewer: agent,
  });
  const cp = createSqliteCheckpointer(join(dataDir, "checkpoints.sqlite"));
  const legacy = buildHuGraph({ router, checkpointer: cp, rootDir: legacyRoot, applyDir: legacyRoot });
  tFinal = "dev-legacy-final";
  tHu = "dev-legacy-hu";
  await legacy.invoke({ request: "implementa un util" }, { configurable: { thread_id: tFinal } });
  await legacy.invoke(new Command({ resume: { action: "approve" } }), { configurable: { thread_id: tFinal } });
  await legacy.invoke({ request: "implementa otro util" }, { configurable: { thread_id: tHu } });

  const now = new Date().toISOString();
  createLegacyCoreDb(join(dataDir, "core.sqlite"), {
    sessionId: "old", createdAt: now, updatedAt: now, turns: [], delegatedTaskIds: [],
    developmentThreadId: tHu, developmentThreadIds: [tFinal, tHu],
  });

  srv = await startTestServer({ dir: dataDir, agent, persist: true, sandboxDir: repos.dir("sandboxes") });
});
afterEach(async () => {
  await srv.stop().catch(() => undefined);
  repos.cleanup();
});

const view = async (t: string) => (await srv.api("GET", `/executions/${t}`)).json.execution;

describe("datos anteriores al registro de proyectos", () => {
  it("la base de datos antigua abre, conserva la sesión (ahora general) y sus ejecuciones", async () => {
    const s = (await srv.api("GET", "/sessions/old")).json.session;
    expect(s.projectId).toBeUndefined();
    expect(s.developmentThreadIds).toEqual([tFinal, tHu]);
    const v = await view(tFinal);
    expect(v).toMatchObject({ sessionId: "old", lifecycle: "awaiting_decision", project: null, applyTarget: null });
    expect(v.awaitingDecision?.kind).toBe("final_approval");
    expect((await srv.api("GET", `/executions/${tFinal}/proposals`)).json.proposals).toBeDefined();
    expect((await srv.api("GET", "/projects")).json.projects).toEqual([]);
  });

  it("precisión 6: aprobar la propuesta de una ejecución sin proyecto se bloquea y no escribe en ningún sitio", async () => {
    const before = readdirSync(legacyRoot, { recursive: true });
    const hash = (await view(tFinal)).pendingApproval.proposalHash;
    const r = await srv.api("POST", `/executions/${tFinal}/approval`, { decision: "approve", proposalHash: hash });
    expect(r).toMatchObject({ status: 409, json: { error: "project_unbound" } });
    expect(r.json.message).toMatch(/Solo puede rechazarse/);
    expect(readdirSync(legacyRoot, { recursive: true })).toEqual(before);
    expect(readFileSync(join(legacyRoot, "README.md"), "utf8")).toBe("# legado\n");
    expect(readdirSync(join(repos.base, "sandboxes"))).toEqual([]);
    expect(await view(tFinal)).toMatchObject({ lifecycle: "awaiting_decision" }); // intacta
    // Pedir cambios tampoco reanuda trabajo.
    const rc = await srv.api("POST", `/executions/${tFinal}/approval`, { decision: "request_changes", proposalHash: hash, feedback: "x" });
    expect(rc.json.error).toBe("project_unbound");
  });

  it("en la revisión de HU tampoco se reanuda; rechazar sí se permite y la detiene", async () => {
    const calls = agent.calls.length;
    const hash = (await view(tHu)).pendingApproval.decisionHash;
    for (const decision of ["approve", "request_changes"]) {
      const r = await srv.api("POST", `/executions/${tHu}/approval/hu_review`, { decision, decisionHash: hash, feedback: "x" });
      expect(r).toMatchObject({ status: 409, json: { error: "project_unbound" } });
    }
    expect(agent.calls.length).toBe(calls); // ningún agente trabajó
    const rej = await srv.api("POST", `/executions/${tHu}/approval/hu_review`, { decision: "reject", decisionHash: hash });
    expect(rej.status).toBe(200);
    expect(await view(tHu)).toMatchObject({ lifecycle: "stopped" });
    expect((await srv.api("GET", `/executions/${tHu}/decisions`)).json.decisions).toMatchObject([{ decision: "reject" }]);
  });

  it("un desarrollo nuevo en la sesión antigua pide una sesión con proyecto", async () => {
    const r = await srv.api("POST", "/sessions/old/messages", { message: "implementa un util de resta" });
    expect(r.json.result).toMatchObject({ category: "clarification", blockedReason: "project_required" });
    expect((await srv.api("GET", "/sessions/old")).json.session.developmentThreadIds).toEqual([tFinal, tHu]);
  });
});

describe("defensa del grafo", () => {
  it("si algo reanudara una ejecución sin proyecto saltándose el Core, el grafo no aplica", async () => {
    await srv.core.submitApproval(tFinal, "approve");
    const v = await view(tFinal);
    expect(v).toMatchObject({ phase: "apply_blocked", lifecycle: "failed", applyTarget: null });
    expect(v.errors.join(" ")).toMatch(/intervención humana/);
    expect(readFileSync(join(legacyRoot, "README.md"), "utf8")).toBe("# legado\n");
    expect(readdirSync(join(legacyRoot, "src"))).toEqual([]);
  });
});

describe("D9: registro automático del repositorio del backend", () => {
  it("lo registra una vez, en sandbox y con actor saiki-bootstrap; no reactiva uno desactivado", async () => {
    const home = repos.repo("saiki-home");
    expect(await registerHomeProject(srv.core, home)).toMatch(/registrado "saiki-home"/);
    const [p] = (await srv.api("GET", "/projects")).json.projects;
    expect(p).toMatchObject({ name: "saiki-home", applyMode: "sandbox", status: "active" });
    expect((await srv.api("GET", `/projects/${p.id}/history`)).json.history).toMatchObject([{ action: "registered", actor: BOOTSTRAP_ACTOR }]);

    expect(await registerHomeProject(srv.core, home)).toMatch(/ya está en el registro/);
    await srv.api("POST", `/projects/${p.id}/deactivate`);
    await registerHomeProject(srv.core, home);
    expect((await srv.api("GET", `/projects/${p.id}`)).json.project.status).toBe("inactive");
    expect((await srv.api("GET", "/projects")).json.projects).toHaveLength(1);
  });

  it("D1 se respeta: un directorio sin git no se registra y se explica cómo hacerlo", async () => {
    const msg = await registerHomeProject(srv.core, repos.dir("sin-git"));
    expect(msg).toMatch(/NO se registró/);
    expect(msg).toMatch(/git init/);
    expect((await srv.api("GET", "/projects")).json.projects).toEqual([]);
  });
});
