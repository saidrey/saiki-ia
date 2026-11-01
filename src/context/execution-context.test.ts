import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { FlowAgent, startTestServer, type FlowPlan, type TestServer } from "../projects/test-flow.js";
import { DATA_DIR_ENV, resolveDataPaths, type DataPaths } from "../persistence/data-dir.js";
import { CoreStore, type ExecutionContextRecord } from "../core/core-store.js";
import { CONTEXT_SECTIONS } from "./context-builder.js";
import { developerContext, prepareExecutionContext } from "./execution-context.js";
import type { ContextStore } from "./context-store.js";
import type { ProjectBinding } from "../projects/project-binding.js";
import { CLAUDE_READ_TOOLS } from "../agents/claude-cli-agent.js";
import { buildDevPrompt } from "../dev/dev-instructions.js";

/**
 * (Project Context, T8) ContextBuilder integrado en el flujo real y contexto
 * congelado por ejecución: grafo, Core, API, scheduler y SQLite reales
 * (`SAIKI_DATA_DIR` externo); agentes deterministas que anotan su prompt.
 */

const OPEN = "<<<CONTEXTO DEL PROYECTO";

const PLAN: FlowPlan = (m) =>
  m === "R"
    ? { hu: "Reembolso de pagos", affected: "src/payments/refund.ts", create: { path: "src/payments/partial.ts", content: "export const p = 1;\n" } }
    : m === "Z"
      ? { hu: "Zafiro cuarzo obsidiana", affected: "README.md", create: { path: "src/z.ts", content: "export const z = 1;\n" } }
      : { hu: "Pantalla de perfil", affected: "README.md", create: { path: "src/gen.ts", content: "export const v = 1;\n" } };

const FILES = {
  "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest run", build: "tsc" }, devDependencies: { vitest: "1.0.0", typescript: "5.0.0" } }),
  "README.md": "# Shop\n",
  "src/payments/refund.ts": "export const refund = 1;\n",
  "src/payments/refund.test.ts": "test\n",
  "src/users/profile.ts": "export const profile = 1;\n",
};

let repos: TempRepos;
let dataRoot: string;
let data: DataPaths;
let agent: FlowAgent;
let srv: TestServer;
let holds: Map<string, { wait: Promise<void>; release: () => void }>;
let failures: Set<string>;

const beforeHash = async (path: string): Promise<void> => {
  if (failures.delete(path)) throw new Error(`fallo simulado al leer ${path}`);
  await holds.get(path)?.wait;
};
/** Retiene el hash de `path` (y con él el escaneo) hasta `release()`. */
function hold(path: string): () => void {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  holds.set(path, { wait, release });
  return () => {
    holds.delete(path);
    release();
  };
}

async function start(opts: { refreshMs?: number; withoutContext?: boolean } = {}): Promise<void> {
  srv = await startTestServer({
    dir: repos.base,
    agent,
    data,
    withoutContext: opts.withoutContext,
    contextRefreshMs: opts.refreshMs,
    contextScan: { progressIntervalMs: 0, scan: { beforeHash, hashConcurrency: 1 } },
  });
}
async function restart(opts: { refreshMs?: number; withoutContext?: boolean } = {}): Promise<void> {
  await srv.stop();
  await start(opts);
}
async function register(name: string, files: Record<string, string> = FILES) {
  const r = await srv.api("POST", "/projects", { name, path: repos.repo(name, files) });
  expect(r.status).toBe(201);
  return r.json.project as { id: string; rootPath: string };
}
const view = async (t: string) => (await srv.api("GET", `/executions/${t}`)).json.execution;
const snapshotOf = async (projectId: string) => (await srv.api("GET", `/projects/${projectId}/context`)).json.context.snapshot?.id ?? null;
async function startDev(sessionId: string, projectId: string, marker: string): Promise<string> {
  await srv.api("POST", "/sessions", { sessionId, projectId });
  const r = await srv.api("POST", `/sessions/${sessionId}/messages`, { message: `implementa esto [P:${marker}]` });
  expect(r.json.result.category).toBe("development");
  return r.json.result.developmentThreadId;
}
/** Aprueba la HU: corre análisis técnico, desarrollo y revisiones hasta la aprobación final. */
async function toFinal(sessionId: string, projectId: string, marker: string): Promise<string> {
  const t = await startDev(sessionId, projectId, marker);
  const hash = (await view(t)).pendingApproval.decisionHash;
  expect((await srv.api("POST", `/executions/${t}/approval/hu_review`, { decision: "approve", decisionHash: hash })).status).toBe(200);
  expect((await view(t)).awaitingDecision?.kind).toBe("final_approval");
  return t;
}
const prompts = (role: string, marker: string) => agent.calls.filter((c) => c.role === role && c.marker === marker).map((c) => c.input);
function frozen(t: string): ExecutionContextRecord {
  const r = srv.core.getExecutionContext(t);
  if (!r.ok) throw new Error(r.message);
  return r.context;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  repos = new TempRepos();
  dataRoot = mkdtempSync(join(tmpdir(), "saiki-data-"));
  const r = resolveDataPaths({ [DATA_DIR_ENV]: join(dataRoot, "data") }, repos.base);
  if (!r.ok) throw new Error(r.message);
  data = r.paths;
  agent = new FlowAgent(PLAN);
  holds = new Map();
  failures = new Set();
});
afterEach(async () => {
  for (const h of holds.values()) h.release();
  await srv?.stop().catch(() => undefined);
  repos.cleanup();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("flujo real con ContextBuilder", () => {
  it("HU con módulo concreto: Kiro recibe el bundle completo, Claude solo su parte; queda congelado y trazado", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const snapshotId = await snapshotOf(p.id);
    const t = await toFinal("s1", p.id, "R");

    const c = frozen(t);
    expect(c).toMatchObject({ executionId: t, huVersion: 1, sessionId: "s1", projectId: p.id, snapshotId, stale: false, staleReason: null });
    expect(c.hu.summary).toBe("Reembolso de pagos [P:R]");
    expect(c.indexHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.bundleHash).toBe(sha(c.bundle));
    expect(c.files.map((f) => f.path).slice(0, 2)).toEqual(["src/payments/refund.ts", "src/payments/refund.test.ts"]);
    expect(c.files[0].reasons).toEqual(["payment", "refund"]);
    expect(c.sources[0]).toEqual({ kind: "index", ref: snapshotId, version: c.indexHash });

    // Analista técnico (Kiro): el texto exacto congelado, delimitado; sin hashes internos.
    const [tech] = prompts("technicalAnalyst", "R");
    expect(tech).toContain(`${OPEN} (orientativo; verifica en el codigo antes de afirmar)\n${c.bundle.trimEnd()}\n>>>FIN DEL CONTEXTO DEL PROYECTO`);
    expect(tech).toContain(CONTEXT_SECTIONS.files);
    expect(tech).not.toContain(c.indexHash!);

    // Desarrollador (Claude): stack y conocimiento, no la lista de archivos ni la documentación.
    const [dev] = prompts("develop", "R");
    expect(dev).toContain(c.devBundle.trimEnd());
    expect(c.devBundleHash).toBe(sha(c.devBundle));
    expect(c.devBundle).toContain(CONTEXT_SECTIONS.stack);
    expect(c.devBundle).toContain("test → vitest run");
    expect(dev).not.toContain(CONTEXT_SECTIONS.files);
    expect(dev).not.toContain("src/payments/refund.test.ts");
    // El JSON del DevContext no duplica el contexto.
    expect(dev.split(OPEN)).toHaveLength(2);

    // HU y revisores: sin contexto (sus responsabilidades no cambian).
    for (const role of ["huAnalyst", "functionalReviewer", "qualityReviewer"]) {
      expect(prompts(role, "R").length).toBeGreaterThan(0);
      for (const input of prompts(role, "R")) expect(input).not.toContain(OPEN);
    }

    // Vista pública: qué contexto usó, sin el texto ni hashes internos.
    const v = (await view(t)).context;
    expect(v).toMatchObject({ huVersion: 1, snapshotId, stale: false, staleReason: null, intact: true });
    expect(v.files[0]).toEqual({ path: "src/payments/refund.ts", score: c.files[0].score, reasons: ["payment", "refund"] });
    expect(JSON.stringify(v)).not.toContain(c.indexHash!);
    expect(JSON.stringify(v)).not.toContain(c.bundleHash);
  });

  it("HU sin coincidencias claras: puntos de partida en lugar de archivos", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const t = await toFinal("s1", p.id, "Z");
    const c = frozen(t);
    expect(c.files).toEqual([]);
    expect(c.bundle).toContain("No hay archivos con coincidencias claras con la HU. Puntos de partida:");
    expect(prompts("technicalAnalyst", "Z")[0]).toContain("Puntos de partida");
  });
});

describe("snapshot al día, desactualizado o inexistente (D3)", () => {
  it("cambios fuera de Saiki: refresco incremental a tiempo → snapshot nuevo, al día", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const before = await snapshotOf(p.id);
    writeFileSync(join(p.rootPath, "src/payments/refund-policy.ts"), "export const x = 1;\n");

    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);
    expect(c.snapshotId).not.toBe(before);
    expect(c.snapshotId).toBe(await snapshotOf(p.id));
    expect(c.stale).toBe(false);
    expect(c.files.map((f) => f.path)).toContain("src/payments/refund-policy.ts");
  });

  it("refresco que no termina a tiempo: snapshot anterior marcado como desactualizado, sin bloquear", async () => {
    await start({ refreshMs: 150 });
    const p = await register("shop");
    await srv.core.contextIdle();
    const before = await snapshotOf(p.id);
    writeFileSync(join(p.rootPath, "src/payments/slow.ts"), "export const s = 1;\n");
    const release = hold("src/payments/slow.ts");

    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);
    expect(c).toMatchObject({ snapshotId: before, stale: true, staleReason: "refresh_timeout" });
    expect(c.bundle).toContain("ATENCIÓN: el contexto puede estar desactualizado (refresh_timeout");
    expect(c.devBundle).toContain("ATENCIÓN");
    expect((await view(t)).context).toMatchObject({ stale: true, staleReason: "refresh_timeout" });
    release();
    await srv.core.contextIdle();
    // Congelado: el escaneo posterior no cambia lo que recibió la ejecución.
    expect(await snapshotOf(p.id)).not.toBe(before);
    expect(frozen(t)).toEqual(c);
  });

  it("refresco que falla: snapshot anterior marcado como desactualizado", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const before = await snapshotOf(p.id);
    writeFileSync(join(p.rootPath, "src/payments/broken.ts"), "export const b = 1;\n");
    failures.add("src/payments/broken.ts");

    const t = await toFinal("s1", p.id, "R");
    expect(frozen(t)).toMatchObject({ snapshotId: before, stale: true, staleReason: "refresh_failed" });
  });

  it("sin snapshot: se espera el escaneo inicial; si termina, se usa", async () => {
    await start();
    const p = await register("shop");
    // Sin esperar al escaneo inicial: lo espera el análisis técnico.
    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);
    expect(c.snapshotId).not.toBeNull();
    expect(c.snapshotId).toBe(await snapshotOf(p.id));
    expect(c.stale).toBe(false);
  });

  it("sin snapshot y el escaneo inicial no termina: sin índice, explícito, sin bloquear", async () => {
    await start({ refreshMs: 150 });
    const release = hold("README.md");
    const p = await register("shop");
    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);
    expect(c).toMatchObject({ snapshotId: null, indexHash: null, stale: true, staleReason: "no_snapshot", files: [] });
    expect(c.bundle).toContain("El proyecto todavía no tiene snapshot: no hay índice técnico.");
    release();
  });

  it("sin snapshot y el escaneo inicial falla: sin índice, explícito", async () => {
    await start();
    failures.add("README.md");
    const p = await register("shop");
    const t = await toFinal("s1", p.id, "R");
    expect(frozen(t)).toMatchObject({ snapshotId: null, stale: true, staleReason: "no_snapshot" });
  });
});

describe("congelado y reproducibilidad", () => {
  it("sobrevive al reinicio; cambios y escaneos posteriores no alteran el bundle; Claude corrige con el mismo contexto", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);

    // El repositorio cambia y un escaneo posterior reemplaza el índice: el snapshot histórico ya no se puede reconstruir.
    writeFileSync(join(p.rootPath, "src/payments/refund.ts"), "export const refund = 2;\n");
    writeFileSync(join(p.rootPath, "src/payments/new.ts"), "export const n = 1;\n");
    expect((await srv.api("POST", `/projects/${p.id}/context/scan`, {})).status).toBe(202);
    await srv.core.contextIdle();
    expect(await snapshotOf(p.id)).not.toBe(c.snapshotId);

    await restart();
    expect(frozen(t)).toEqual(c);
    expect((await view(t)).context).toMatchObject({ snapshotId: c.snapshotId, intact: true });

    // Pedir cambios vuelve a desarrollar: Claude recibe el mismo subconjunto congelado (caso 9).
    const proposalHash = (await view(t)).pendingApproval.proposalHash;
    const r = await srv.api("POST", `/executions/${t}/approval`, { decision: "request_changes", proposalHash, feedback: "ajusta" });
    expect(r.status).toBe(200);
    const devs = prompts("develop", "R");
    expect(devs).toHaveLength(2);
    expect(devs[1]).toContain(c.devBundle.trimEnd());
    expect(devs[1]).not.toContain("src/payments/new.ts");
    expect(prompts("technicalAnalyst", "R")).toHaveLength(1);
    expect(srv.core.getExecutionContext(t)).toEqual({ ok: true, context: c });
  });

  it("solo inserción: no se sustituye, actualiza ni borra", () => {
    const store = new CoreStore(":memory:");
    const r = record({ executionId: "e1" });
    store.insertExecutionContext(r);
    expect(() => store.insertExecutionContext({ ...r, bundle: "otro" })).toThrow();
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db;
    expect(() => db.exec(`UPDATE execution_contexts SET bundle='x'`)).toThrow(/inmutable/);
    expect(() => db.exec(`DELETE FROM execution_contexts`)).toThrow(/inmutable/);
    expect(store.getExecutionContext("e1", 1)).toEqual(r);
    store.close();
  });

  it("si el bundle congelado no está, se informa: no se reconstruye con el índice actual", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const t = await startDev("s1", p.id, "R"); // en revisión de la HU: aún sin análisis técnico
    expect(srv.core.getExecutionContext(t)).toMatchObject({ ok: false, code: "not_frozen" });
    expect((await view(t)).context).toBeNull();
  });
});

describe("aislamiento y compatibilidad", () => {
  it("dos proyectos a la vez: cada ejecución con el contexto de su proyecto", async () => {
    await start();
    const a = await register("shop");
    const b = await register("blog", { "README.md": "# Blog\n", "src/posts/post.ts": "export {};\n", "src/payments/fake.ts": "x\n" });
    await srv.core.contextIdle();
    const [ta, tb] = await Promise.all([toFinal("sa", a.id, "R"), toFinal("sb", b.id, "Z")]);
    const [ca, cb] = [frozen(ta), frozen(tb)];
    expect(ca.projectId).toBe(a.id);
    expect(cb.projectId).toBe(b.id);
    expect(ca.snapshotId).toBe(await snapshotOf(a.id));
    expect(cb.snapshotId).toBe(await snapshotOf(b.id));
    expect(ca.bundle).toContain("«shop»");
    expect(ca.bundle).not.toContain("src/payments/fake.ts");
    expect(cb.bundle).toContain("«blog»");
    expect(cb.bundle).not.toContain("refund");
  });

  it("un contexto congelado de otro proyecto no se entrega", async () => {
    const coreStore = new CoreStore(":memory:");
    coreStore.insertExecutionContext(record({ executionId: "e1", projectId: "A" }));
    const binding: ProjectBinding = {
      projectId: "B", projectName: "b", rootPath: "/x", applyMode: "sandbox",
      fingerprint: { dev: 1, ino: 1, gitDir: null, gitIno: null }, boundAt: "t",
    } as unknown as ProjectBinding;
    const r = await prepareExecutionContext(
      { coreStore, contextStore: {} as ContextStore, scans: {} as never, freshness: async () => ({ signature: "", gitHead: null, changedPaths: null }) },
      { executionId: "e1", huVersion: 1, sessionId: null, project: binding, hu: record({}).hu, pinnedSnapshotId: null },
    );
    expect(r).toEqual({ ok: false, error: "El contexto congelado de esta ejecución pertenece a otro proyecto." });
    coreStore.close();
  });

  it("ejecuciones anteriores a T8 (sin execution_contexts) siguen funcionando sin contexto", async () => {
    // Ejecución creada por un Core sin contexto, pausada en la aprobación final.
    await start({ withoutContext: true });
    const p = await register("shop");
    const t = await toFinal("s1", p.id, "R");
    expect(prompts("technicalAnalyst", "R")[0]).not.toContain(OPEN);

    await restart();
    expect((await view(t)).context).toBeNull();
    expect(srv.core.getExecutionContext(t)).toMatchObject({ ok: false, code: "not_frozen" });
    const proposalHash = (await view(t)).pendingApproval.proposalHash;
    expect((await srv.api("POST", `/executions/${t}/approval`, { decision: "request_changes", proposalHash, feedback: "ajusta" })).status).toBe(200);
    const devs = prompts("develop", "R");
    expect(devs).toHaveLength(2);
    expect(devs[1]).not.toContain(OPEN);
    const hash2 = (await view(t)).pendingApproval.proposalHash;
    expect((await srv.api("POST", `/executions/${t}/approval`, { decision: "approve", proposalHash: hash2 })).status).toBe(200);
    expect(await view(t)).toMatchObject({ lifecycle: "completed", phase: "applied" });
  });
});

describe("API: GET /executions/:id/context (T9)", () => {
  it("devuelve el texto congelado de Kiro y Claude sin hashes; 404 explícitos; 400 por versión inválida", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const t = await toFinal("s1", p.id, "R");
    const c = frozen(t);

    const r = await srv.api("GET", `/executions/${t}/context`);
    expect(r.status).toBe(200);
    expect(r.json.context).toEqual({
      executionId: t, projectId: p.id, huVersion: 1, snapshotId: c.snapshotId, builtAt: c.builtAt,
      stale: false, staleReason: null, technicalBundle: c.bundle, developerBundle: c.devBundle,
    });
    const raw = JSON.stringify(r.json);
    for (const secret of [c.bundleHash, c.devBundleHash, c.indexHash!, p.rootPath]) expect(raw).not.toContain(secret);
    expect((await srv.api("GET", `/executions/${t}/context?huVersion=1`)).json.context.huVersion).toBe(1);

    expect(await srv.api("GET", `/executions/${t}/context?huVersion=2`)).toMatchObject({ status: 404, json: { error: "not_frozen" } });
    expect((await srv.api("GET", `/executions/${t}/context?huVersion=0`)).status).toBe(400);
    expect(await srv.api("GET", `/executions/nope/context`)).toMatchObject({ status: 404, json: { error: "not_found" } });
    const paused = await startDev("s2", p.id, "R"); // revisión de la HU: sin análisis técnico todavía
    expect(await srv.api("GET", `/executions/${paused}/context`)).toMatchObject({ status: 404, json: { error: "not_frozen" } });
  });

  it("integridad rota: 409, sin reconstruir", async () => {
    await start();
    const p = await register("shop");
    await srv.core.contextIdle();
    const t = await toFinal("s1", p.id, "R");
    const db = new Database(data.files.core);
    db.exec(`DROP TRIGGER execution_contexts_immutable_update`);
    db.prepare(`UPDATE execution_contexts SET bundle = bundle || 'x' WHERE executionId = ?`).run(t);
    db.close();
    expect(await srv.api("GET", `/executions/${t}/context`)).toMatchObject({ status: 409, json: { error: "integrity_failed" } });
    expect((await view(t)).context.intact).toBe(false);
  });
});

describe("subconjunto del desarrollador", () => {
  it("conserva cabecera, stack y conocimiento; quita archivos, documentación e historial", () => {
    const bundle = [
      "## Contexto del proyecto «x»",
      "ATENCIÓN: el contexto puede estar desactualizado (refresh_timeout). Confirma en el repositorio.",
      CONTEXT_SECTIONS.stack,
      "Scripts: test: vitest run",
      CONTEXT_SECTIONS.knowledge,
      "#### Convenciones (convenciones, versión 2)",
      "### Un encabezado dentro del documento",
      "usar KISS",
      CONTEXT_SECTIONS.files,
      "- src/a.ts (código; coincide: a)",
      CONTEXT_SECTIONS.repoDocs,
      "#### README.md",
      CONTEXT_SECTIONS.history,
      "- Historial de la ejecución e0: x",
      "",
    ].join("\n");
    const dev = developerContext(bundle);
    expect(dev).toContain("ATENCIÓN");
    expect(dev).toContain("Scripts: test: vitest run");
    expect(dev).toContain("### Un encabezado dentro del documento\nusar KISS");
    for (const gone of [CONTEXT_SECTIONS.files, "src/a.ts", CONTEXT_SECTIONS.repoDocs, "README.md", CONTEXT_SECTIONS.history]) {
      expect(dev).not.toContain(gone);
    }
    expect(developerContext(bundle)).toBe(dev);
  });
});

describe("lo que se le dice a Claude coincide con lo que el adaptador le permite", () => {
  it("subconjunto congelado y prompt de desarrollo: solo lectura con las herramientas reales; sin inventar contenido", () => {
    const dev = developerContext("## Contexto\n");
    const prompt = buildDevPrompt({
      hu: { version: 1, summary: "s", need: "n", tasks: [], acceptanceCriteria: [], assumptions: [], openQuestions: [] },
      technical: { summary: "t", currentFlow: "f", affectedFiles: [], proposedChanges: [], dependencies: [], risks: [], openQuestions: [] },
      feasibility: "ready",
      feasibilityReasons: [],
      constraints: [],
      projectContext: dev,
    });
    for (const text of [dev, prompt]) {
      expect(text).toContain(`(${CLAUDE_READ_TOOLS.join(", ")})`);
      expect(text).toMatch(/no puedes escribir/i);
      expect(text).toMatch(/inventes/);
    }
    // Ya no promete herramientas genéricas sin decir cuáles.
    expect(dev).not.toContain("consulta los archivos reales con tus herramientas");
    // Compatible con el aplicador: 'modify' sustituye el archivo entero.
    expect(prompt).toContain("contenido COMPLETO del archivo resultante");
  });
});

function record(o: Partial<ExecutionContextRecord>): ExecutionContextRecord {
  const bundle = "## Contexto\n";
  const devBundle = developerContext(bundle);
  return {
    executionId: "e",
    huVersion: 1,
    sessionId: null,
    projectId: "A",
    snapshotId: null,
    indexHash: null,
    hu: { summary: "s", need: "n", tasks: [], acceptanceCriteria: [], assumptions: [], openQuestions: [], dependencies: [] } as unknown as ExecutionContextRecord["hu"],
    builtAt: "t",
    stale: false,
    staleReason: null,
    sources: [],
    files: [],
    trace: {} as ExecutionContextRecord["trace"],
    bundleHash: sha(bundle),
    bundle,
    devBundleHash: sha(devBundle),
    devBundle,
    ...o,
  };
}
