import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CoreStore } from "../core/core-store.js";
import type { HuStateType } from "../hu/hu-state.js";
import { createApplyGuard } from "./apply-guard.js";
import type { ProjectBinding } from "./project-binding.js";
import { ProjectRegistry } from "./project-registry.js";
import { TempRepos } from "./test-repos.js";

/** (Project Registry, tarea 7) Ramas de la guardia que la API no permite provocar. */

let repos: TempRepos;
let store: CoreStore;
let registry: ProjectRegistry;
let sandboxes: string;
let binding: ProjectBinding;
const EXEC = "dev-1";

beforeEach(() => {
  repos = new TempRepos();
  sandboxes = repos.dir("sandboxes");
  store = new CoreStore(":memory:");
  registry = new ProjectRegistry(store, { dataDir: "/nope" });
  const r = registry.register({ name: "a", path: repos.repo("a", { "src/a.ts": "x" }) }, "t");
  if (!r.ok) throw new Error(r.message);
  const p = store.getProject(r.project.id)!;
  binding = { projectId: p.id, projectName: p.name, rootPath: p.rootPath, applyMode: p.applyMode, fingerprint: p.fingerprint, boundAt: "2026-10-30T00:00:00.000Z" };
});
afterEach(() => {
  store.close();
  repos.cleanup();
});

const state = (s: Partial<HuStateType>) => ({ project: null, applyTarget: "", ...s }) as HuStateType;
const guard = () => createApplyGuard({ store, sandboxDir: sandboxes });

describe("createApplyGuard", () => {
  it("sin proyecto vinculado (ejecución anterior al registro) bloquea y pide intervención", () => {
    expect(guard()({ executionId: EXEC, state: state({}) })).toMatchObject({ ok: false, reason: /intervención humana/ });
  });

  it("sin fila en execution_projects, o si no coincide con el estado, bloquea", () => {
    expect(guard()({ executionId: EXEC, state: state({ project: binding }) })).toMatchObject({ ok: false, reason: /no consta/ });
    store.insertExecutionProject(EXEC, binding);
    for (const forged of [
      { ...binding, rootPath: "/otro" },
      { ...binding, projectId: "prj-otro" },
      { ...binding, applyMode: "real" as const },
      { ...binding, fingerprint: { ...binding.fingerprint, ino: binding.fingerprint.ino + 1 } },
    ]) {
      expect(guard()({ executionId: EXEC, state: state({ project: forged }) })).toMatchObject({ ok: false, reason: /no coincide/ });
    }
  });

  it("válida: crea el sandbox propio de la ejecución y lo reutiliza solo si es suyo y existe", () => {
    store.insertExecutionProject(EXEC, binding);
    const first = guard()({ executionId: EXEC, state: state({ project: binding }) });
    if (!first.ok) throw new Error(first.reason);
    expect(first.applyDir.startsWith(realpathSync(sandboxes))).toBe(true);
    expect(existsSync(join(first.applyDir, "src/a.ts"))).toBe(true);

    // Reintento tras un corte: el mismo sandbox, sin crear otro.
    expect(guard()({ executionId: EXEC, state: state({ project: binding, applyTarget: first.applyDir }) })).toEqual(first);

    // Un destino que no es el sandbox de esta ejecución no se acepta.
    const foreign = join(realpathSync(sandboxes), "saiki-sandbox-dev-2-xyz");
    mkdirSync(foreign);
    expect(guard()({ executionId: EXEC, state: state({ project: binding, applyTarget: foreign }) })).toMatchObject({
      ok: false,
      reason: /otro destino/,
    });
    expect(guard()({ executionId: EXEC, state: state({ project: binding, applyTarget: binding.rootPath }) })).toMatchObject({ ok: false });

    // Si su sandbox desapareció, no se crea otro en silencio.
    rmSync(first.applyDir, { recursive: true });
    expect(guard()({ executionId: EXEC, state: state({ project: binding, applyTarget: first.applyDir }) })).toMatchObject({
      ok: false,
      reason: /ya no existe/,
    });
  });

  it("modo real solo si lo era al vincular Y lo es ahora", () => {
    const real = { ...binding, applyMode: "real" as const };
    store.insertExecutionProject(EXEC, real);
    // Vinculada en real, pero el proyecto hoy está en sandbox → sandbox.
    const g1 = guard()({ executionId: EXEC, state: state({ project: real }) });
    expect(g1.ok && g1.applyDir !== binding.rootPath).toBe(true);
    registry.update(binding.projectId, { applyMode: "real", confirmRealApply: true }, "t");
    expect(guard()({ executionId: EXEC, state: state({ project: real }) })).toEqual({ ok: true, applyDir: binding.rootPath });
  });
});
