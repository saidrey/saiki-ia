import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR_ENV, legacyDataNotice, resolveDataPaths, type DataPaths } from "./data-dir.js";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type TestServer } from "../projects/test-flow.js";

/** (Project Context, T4b) `SAIKI_DATA_DIR`: resolución, aviso de migración y uso real. */

const paths = (env: NodeJS.ProcessEnv, cwd: string): DataPaths => {
  const r = resolveDataPaths(env, cwd);
  if (!r.ok) throw new Error(r.message);
  return r.paths;
};

/** Árbol de archivos relativo (sin `.git`), para comprobar que nada cambió. */
function tree(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (p === ".git") return [];
    return e.isDirectory() ? [`${p}/`, ...tree(root, p)] : [p];
  });
}

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveDataPaths", () => {
  it("sin variable (o vacía): `.saiki` del directorio de arranque, con las mismas rutas que antes", () => {
    const cwd = "/srv/saiki";
    for (const env of [{}, { [DATA_DIR_ENV]: "" }]) {
      const p = paths(env, cwd);
      expect(p).toEqual({
        dir: "/srv/saiki/.saiki",
        source: "default",
        files: {
          core: resolve(cwd, ".saiki/core.sqlite"),
          checkpoints: resolve(cwd, ".saiki/checkpoints.sqlite"),
          events: resolve(cwd, ".saiki/events.sqlite"),
          knowledge: resolve(cwd, ".saiki/knowledge.sqlite"),
          context: resolve(cwd, ".saiki/context.sqlite"),
        },
      });
    }
  });

  it("con SAIKI_DATA_DIR absoluta: todas las bases de datos se derivan de ella (normalizada)", () => {
    const p = paths({ [DATA_DIR_ENV]: "/data/saiki/../saiki-data/" }, "/srv/saiki");
    expect(p.dir).toBe("/data/saiki-data");
    expect(p.source).toBe("env");
    expect(Object.values(p.files).every((f) => f.startsWith("/data/saiki-data/") && f.endsWith(".sqlite"))).toBe(true);
  });

  it("una ruta relativa es un error, no se interpreta respecto al directorio de arranque", () => {
    for (const raw of ["datos", "./.saiki", "~/saiki"]) {
      const r = resolveDataPaths({ [DATA_DIR_ENV]: raw }, "/srv/saiki");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain(DATA_DIR_ENV);
    }
  });
});

describe("legacyDataNotice (sin migración automática)", () => {
  it("avisa con los pasos si la ubicación nueva está vacía y la anterior tiene datos; no mueve ni crea nada", () => {
    const cwd = temp("saiki-cwd-");
    mkdirSync(join(cwd, ".saiki"));
    writeFileSync(join(cwd, ".saiki", "core.sqlite"), "x");
    const target = join(temp("saiki-ext-"), "data");
    const notice = legacyDataNotice(paths({ [DATA_DIR_ENV]: target }, cwd), cwd);
    expect(notice).toContain(target);
    expect(notice).toContain(join(cwd, ".saiki"));
    expect(notice).toMatch(/Detén el backend/);
    expect(readdirSync(join(cwd, ".saiki"))).toEqual(["core.sqlite"]);
    expect(existsSync(target)).toBe(false);
  });

  it("no avisa sin variable, si la nueva ya tiene datos, si la anterior no tiene o si son la misma", () => {
    const cwd = temp("saiki-cwd-");
    mkdirSync(join(cwd, ".saiki"));
    writeFileSync(join(cwd, ".saiki", "core.sqlite"), "x");
    const target = temp("saiki-ext-");
    expect(legacyDataNotice(paths({}, cwd), cwd)).toBeNull();
    expect(legacyDataNotice(paths({ [DATA_DIR_ENV]: join(cwd, ".saiki") }, cwd), cwd)).toBeNull();
    writeFileSync(join(target, "events.sqlite"), "x");
    expect(legacyDataNotice(paths({ [DATA_DIR_ENV]: target }, cwd), cwd)).toBeNull();
    const empty = temp("saiki-cwd-");
    expect(legacyDataNotice(paths({ [DATA_DIR_ENV]: join(target, "otro") }, empty), empty)).toBeNull();
  });
});

describe("backend real con SAIKI_DATA_DIR externo", () => {
  let repos: TempRepos;
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.stop().catch(() => undefined);
    srv = undefined;
    repos.cleanup();
  });

  it("sesiones, ejecuciones, eventos y conocimiento en el directorio externo; sobreviven al reinicio; el repositorio queda intacto", async () => {
    repos = new TempRepos();
    const root = repos.repo("app", { "README.md": "# app\n", "src/index.ts": "export {};\n" });
    const before = tree(root);
    const data = paths({ [DATA_DIR_ENV]: join(temp("saiki-ext-"), "data") }, root);
    const agent = new FlowAgent();
    srv = await startTestServer({ dir: repos.base, agent, data });

    const project = (await srv.api("POST", "/projects", { name: "app", path: root })).json.project;
    expect((await srv.api("POST", "/sessions", { sessionId: "s1", projectId: project.id })).status).toBeLessThan(300);
    const thread = (await srv.api("POST", "/sessions/s1/messages", { message: "implementa un util de suma" })).json.result.developmentThreadId;
    expect(thread).toBeTruthy();
    const kb = (srv.core as unknown as { kb: { create: (i: object) => unknown } }).kb;
    kb.create({ id: "kb-t4b", title: "t", category: "projects", content: "c", origin: "test" });
    const events = (srv.core as unknown as { eventStore: { getAll: (t: string) => unknown[] } }).eventStore.getAll(thread).length;
    expect(events).toBeGreaterThan(0);

    await srv.core.contextIdle();
    await srv.stop();
    expect(readdirSync(data.dir).filter((f) => f.endsWith(".sqlite")).sort()).toEqual(
      ["checkpoints.sqlite", "context.sqlite", "core.sqlite", "events.sqlite", "knowledge.sqlite"],
    );

    srv = await startTestServer({ dir: repos.base, agent, data });
    const view = (await srv.api("GET", `/executions/${thread}`)).json.execution;
    expect(view.project).toMatchObject({ id: project.id, rootPath: project.rootPath });
    expect(view.pendingApproval?.decisionHash).toBeTruthy();
    expect((await srv.api("GET", "/projects")).json.projects.map((p: { id: string }) => p.id)).toContain(project.id);
    expect((await srv.api("GET", `/sessions?projectId=${project.id}`)).json.sessions).toMatchObject([{ projectId: project.id }]);
    const reopened = srv.core as unknown as { kb: { get: (id: string) => unknown }; eventStore: { getAll: (t: string) => unknown[] } };
    expect(reopened.kb.get("kb-t4b")).toMatchObject({ id: "kb-t4b" });
    expect(reopened.eventStore.getAll(thread).length).toBe(events);

    // Ni el repositorio registrado ni el directorio de arranque de las pruebas reciben datos.
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(repos.base, ".saiki"))).toBe(false);
    expect(readdirSync(repos.base).some((f) => f.endsWith(".sqlite"))).toBe(false);
  });
});
