import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { TempRepos } from "./test-repos.js";
import { FlowAgent, startTestServer, type FlowPlan, type TestServer } from "./test-flow.js";

/**
 * (Project Registry, tareas 6 y 7) Aislamiento entre proyectos: cada ejecución
 * lee, propone y aplica SOLO en su repositorio (o su sandbox), y la guardia
 * bloquea la aplicación si el repositorio cambió. Grafo, Core, API y SQLite
 * reales; agentes deterministas que anotan su `cwd`.
 */

const PLAN: FlowPlan = (m) =>
  m === "A"
    ? { affected: "src/a.ts", create: { path: "src/new-a.ts", content: "export const a = 1;\n" } }
    : m === "B"
      ? { affected: "lib/b.dart", create: { path: "lib/new_b.dart", content: "int b() => 2;\n" } }
      : m === "X"
        ? { affected: "src/a.ts", create: { path: ".saiki/core.sqlite", content: "corrupto" } }
        : { affected: "README.md", create: { path: "src/gen.ts", content: "x" } };

let repos: TempRepos;
let srv: TestServer;
let agent: FlowAgent;
let sandboxes: string;
let A: { id: string; rootPath: string };
let B: { id: string; rootPath: string };

/** Hash de cada archivo del árbol (incluye .git, node_modules y artefactos). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out[relative(dir, f)] = createHash("sha256").update(readFileSync(f)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function register(name: string, files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const r = await srv.api("POST", "/projects", { name, path: repos.repo(name, files), ...extra });
  expect(r.status).toBe(201);
  return r.json.project as { id: string; rootPath: string };
}

beforeEach(async () => {
  repos = new TempRepos();
  sandboxes = repos.dir("sandboxes");
  agent = new FlowAgent(PLAN);
  srv = await startTestServer({ dir: repos.base, agent, persist: true, sandboxDir: sandboxes });
  A = await register("app-node", {
    "package.json": '{"name":"a"}',
    "src/a.ts": "export {};\n",
    "README.md": "# A\n",
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "dist/out.js": "built\n",
  });
  B = await register("app-flutter", { "pubspec.yaml": "name: b\n", "lib/b.dart": "void main() {}\n", "README.md": "# B\n" });
});
afterEach(async () => {
  await srv.stop().catch(() => undefined);
  repos.cleanup();
});

const view = async (t: string) => (await srv.api("GET", `/executions/${t}`)).json.execution;

async function startDev(sessionId: string, projectId: string, marker: string): Promise<string> {
  await srv.api("POST", "/sessions", { sessionId, projectId });
  const r = await srv.api("POST", `/sessions/${sessionId}/messages`, { message: `implementa un util [P:${marker}]` });
  expect(r.json.result.category).toBe("development");
  return r.json.result.developmentThreadId;
}
async function approveHu(t: string) {
  const hash = (await view(t)).pendingApproval.decisionHash;
  return srv.api("POST", `/executions/${t}/approval/hu_review`, { decision: "approve", decisionHash: hash });
}
async function approveFinal(t: string) {
  const hash = (await view(t)).pendingApproval.proposalHash;
  return srv.api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: hash });
}
/** Lleva una ejecución hasta la aprobación final. */
async function toFinal(sessionId: string, projectId: string, marker: string): Promise<string> {
  const t = await startDev(sessionId, projectId, marker);
  expect((await approveHu(t)).status).toBe(200);
  expect((await view(t)).awaitingDecision?.kind).toBe("final_approval");
  return t;
}
const sandboxList = () => readdirSync(sandboxes);

describe("tarea 6: cada agente trabaja en el repositorio de su ejecución", () => {
  it("dos proyectos en paralelo: cwd correcto en todos los roles y análisis validado contra su repo", async () => {
    const [ta, tb] = await Promise.all([startDev("sa", A.id, "A"), startDev("sb", B.id, "B")]);
    await Promise.all([approveHu(ta), approveHu(tb)]);

    for (const [t, p, m, other] of [[ta, A, "A", B], [tb, B, "B", A]] as const) {
      const v = await view(t);
      // Si el análisis se hubiera validado contra el otro repo, su archivo no existiría → viabilidad parcial.
      expect(v.awaitingDecision?.kind).toBe("final_approval");
      for (const role of ["huAnalyst", "technicalAnalyst", "develop", "functionalReviewer", "qualityReviewer"]) {
        const cwds = agent.cwdsOf(role, m);
        expect(cwds.length, `${role} ${m}`).toBeGreaterThan(0);
        expect(new Set(cwds), `${role} ${m}`).toEqual(new Set([p.rootPath]));
      }
      const techPrompt = agent.calls.find((c) => c.role === "technicalAnalyst" && c.marker === m)!.input;
      expect(techPrompt).toContain(p.rootPath);
      expect(techPrompt).not.toContain(other.rootPath);
    }
    // Ninguna llamada del flujo heredó el directorio del backend.
    expect(agent.calls.every((c) => c.cwd !== undefined && c.cwd !== process.cwd())).toBe(true);
  });

  it("D8: la asistencia usa el repo del proyecto; en una conversación general, un directorio vacío propio", async () => {
    await srv.api("POST", "/sessions", { sessionId: "sa", projectId: A.id });
    await srv.api("POST", "/sessions/sa/messages", { message: "investiga opciones de colas" });
    await srv.api("POST", "/sessions/general/messages", { message: "investiga opciones de caché" });
    const [inProject, general] = agent.calls.filter((c) => c.role === "assistant").map((c) => c.cwd!);
    expect(inProject).toBe(A.rootPath);
    expect(general).not.toBe(process.cwd());
    expect([A.rootPath, B.rootPath].some((r) => general.startsWith(r))).toBe(false);
    expect(general).toMatch(/saiki-general-/);
    expect(existsSync(general)).toBe(false); // se borra al terminar
  });
});

describe("tarea 7: aplicación aislada (sandbox por ejecución o repo real)", () => {
  it("sandbox por defecto: cada ejecución aplica en SU copia; los repos reales quedan intactos", async () => {
    const before = { A: tree(A.rootPath), B: tree(B.rootPath) };
    const [ta, tb] = await Promise.all([toFinal("sa", A.id, "A"), toFinal("sb", B.id, "B")]);
    await Promise.all([approveFinal(ta), approveFinal(tb)]);
    const [va, vb] = [await view(ta), await view(tb)];
    expect(va).toMatchObject({ lifecycle: "completed", phase: "applied" });
    expect(vb).toMatchObject({ lifecycle: "completed", phase: "applied" });

    // Repos reales intactos, byte a byte (incluido .git).
    expect(tree(A.rootPath)).toEqual(before.A);
    expect(tree(B.rootPath)).toEqual(before.B);

    // Un sandbox distinto por ejecución, con su nombre, y el archivo solo en el suyo.
    expect(va.applyTarget).not.toBe(vb.applyTarget);
    expect(sandboxList()).toHaveLength(2);
    expect(va.applyTarget.startsWith(realpathSync(sandboxes))).toBe(true);
    expect(va.applyTarget).toContain(`saiki-sandbox-${ta}`);
    expect(readFileSync(join(va.applyTarget, "src/new-a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(va.applyTarget, "lib/new_b.dart"))).toBe(false);
    expect(readFileSync(join(vb.applyTarget, "lib/new_b.dart"), "utf8")).toBe("int b() => 2;\n");
    expect(existsSync(join(vb.applyTarget, "src/new-a.ts"))).toBe(false);

    // Copia completa sin .git, dependencias ni artefactos de build (un proyecto sin src/ también funciona).
    expect(existsSync(join(va.applyTarget, "package.json"))).toBe(true);
    expect(existsSync(join(va.applyTarget, "src/a.ts"))).toBe(true);
    for (const excluded of [".git", "node_modules", "dist"]) expect(existsSync(join(va.applyTarget, excluded))).toBe(false);
    expect(existsSync(join(vb.applyTarget, "pubspec.yaml"))).toBe(true);
  });

  it("modo real (confirmado): aplica en su repo; el otro proyecto no cambia", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const beforeB = tree(B.rootPath);
    const beforeA = tree(A.rootPath);
    const [ta, tb] = await Promise.all([toFinal("sa", A.id, "A"), toFinal("sb", B.id, "B")]);
    await Promise.all([approveFinal(ta), approveFinal(tb)]);
    expect((await view(ta)).applyTarget).toBe(A.rootPath);
    const afterA = tree(A.rootPath);
    expect(Object.keys(afterA).filter((k) => !(k in beforeA))).toEqual(["src/new-a.ts"]);
    for (const [k, h] of Object.entries(beforeA)) expect(afterA[k], k).toBe(h);
    expect(tree(B.rootPath)).toEqual(beforeB);
    expect(sandboxList()).toHaveLength(1); // solo el de B
  });

  it("el modo que gana es el más restrictivo: vinculada en real pero hoy sandbox → sandbox", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sa", A.id, "A");
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "sandbox" });
    const before = tree(A.rootPath);
    await approveFinal(t);
    expect((await view(t)).applyTarget).toContain("saiki-sandbox-");
    expect(tree(A.rootPath)).toEqual(before);
  });
});

describe("tarea 7: la guardia bloquea sin escribir nada", () => {
  async function expectBlocked(t: string, reason: RegExp, repoBefore: Record<string, string> | null, repoPath = A.rootPath) {
    const r = await approveFinal(t);
    expect(r.status).toBe(200);
    const v = await view(t);
    expect(v).toMatchObject({ lifecycle: "failed", phase: "apply_blocked" });
    expect(v.errors.join(" ")).toMatch(reason);
    expect(v.applyTarget).toBeNull();
    expect(sandboxList()).toEqual([]);
    if (repoBefore) expect(tree(repoPath)).toEqual(repoBefore);
  }

  it("D5: proyecto desactivado con la ejecución esperando la aprobación final", async () => {
    const t = await toFinal("sa", A.id, "A");
    await srv.api("POST", `/projects/${A.id}/deactivate`);
    await expectBlocked(t, /desactivado/, tree(A.rootPath));
  });

  it("repositorio movido: bloquea y no busca el repo en la nueva ruta", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sa", A.id, "A");
    const moved = join(repos.base, "app-node-movido");
    renameSync(A.rootPath, moved);
    const before = tree(moved);
    await expectBlocked(t, /ya no existe/, null);
    expect(tree(moved)).toEqual(before);
    expect(existsSync(A.rootPath)).toBe(false);
  });

  it("repositorio borrado y recreado en la misma ruta (otra identidad)", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sa", A.id, "A");
    rmSync(A.rootPath, { recursive: true });
    mkdirSync(join(A.rootPath, "src"), { recursive: true });
    writeFileSync(join(A.rootPath, "src/a.ts"), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: A.rootPath });
    await expectBlocked(t, /no es el registrado/, tree(A.rootPath));
  });

  it(".git sustituido (borrado y vuelto a crear) en el mismo directorio", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sa", A.id, "A");
    rmSync(join(A.rootPath, ".git"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: A.rootPath });
    await expectBlocked(t, /no es el registrado/, tree(A.rootPath));
  });

  it("la ruta registrada pasa a ser un symlink a otro repositorio", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sa", A.id, "A");
    renameSync(A.rootPath, join(repos.base, "original"));
    symlinkSync(B.rootPath, A.rootPath);
    const beforeB = tree(B.rootPath);
    await expectBlocked(t, /otro sitio/, null);
    expect(tree(B.rootPath)).toEqual(beforeB);
  });

  it("una propuesta que toca .saiki/ (datos de Saiki-IA) no se aplica", async () => {
    await srv.api("PATCH", `/projects/${A.id}`, { applyMode: "real", confirmRealApply: true });
    const t = await toFinal("sx", A.id, "X");
    await expectBlocked(t, /directorio protegido/, tree(A.rootPath));
  });

  it("tras reiniciar el backend, la vinculación y la guardia siguen vigentes", async () => {
    const tOk = await toFinal("sa", A.id, "A");
    const tBlocked = await toFinal("sb", B.id, "B");
    await srv.stop();
    srv = await startTestServer({ dir: repos.base, agent, persist: true, sandboxDir: sandboxes });
    renameSync(B.rootPath, join(repos.base, "b-movido"));
    expect((await view(tOk)).project.id).toBe(A.id);
    await approveFinal(tOk);
    expect(await view(tOk)).toMatchObject({ phase: "applied" });
    await approveFinal(tBlocked);
    const vb = await view(tBlocked);
    expect(vb).toMatchObject({ phase: "apply_blocked" });
    expect(vb.errors.join(" ")).toMatch(/ya no existe/);
    expect(sandboxList()).toHaveLength(1);
    expect(statSync(join(sandboxes, sandboxList()[0])).isDirectory()).toBe(true);
  });
});
