import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CoreStore } from "../core/core-store.js";
import { ProjectRegistry } from "./project-registry.js";
import { validateProjectPath } from "./project-fs.js";
import { TempRepos } from "./test-repos.js";

let repos: TempRepos;
let store: CoreStore;
let registry: ProjectRegistry;
const ACTOR = "tester";

beforeEach(() => {
  repos = new TempRepos();
  store = new CoreStore(":memory:");
  registry = new ProjectRegistry(store, { dataDir: join(repos.base, "data", ".saiki") });
});
afterEach(() => {
  store.close();
  repos.cleanup();
});

function ok(r: ReturnType<ProjectRegistry["register"]>) {
  if (!r.ok) throw new Error(`esperaba ok: ${r.code} ${r.message}`);
  return r.project;
}

describe("validación de la ruta al registrar", () => {
  it("registra un repo git: ruta real, activo, sandbox por defecto, salud ok e historial", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    expect(p.rootPath).toBe(realpathSync(dir));
    expect(p).toMatchObject({ status: "active", applyMode: "sandbox", health: "ok" });
    expect(p.id).toMatch(/^prj-/);
    expect("fingerprint" in p).toBe(false);
    expect(registry.history(p.id)).toMatchObject([{ action: "registered", actor: ACTOR, details: { name: "app" } }]);
  });

  it("rechaza rutas relativas, inexistentes, archivos y vacías", () => {
    const file = join(repos.dir("x"), "f.txt");
    writeFileSync(file, "x");
    for (const path of ["relativa/app", join(repos.base, "no-existe"), file, "", undefined, 42]) {
      const r = registry.register({ name: "x", path }, ACTOR);
      expect(r).toMatchObject({ ok: false, code: "invalid_path" });
    }
    expect(store.listProjects()).toHaveLength(0);
  });

  it("D1: exige git (sin .git, o .git sin HEAD, no es un repositorio)", () => {
    expect(registry.register({ name: "a", path: repos.dir("plain") }, ACTOR)).toMatchObject({ code: "not_a_repository" });
    const fake = repos.dir("fake");
    mkdirSync(join(fake, ".git"));
    expect(registry.register({ name: "b", path: fake }, ACTOR)).toMatchObject({ code: "not_a_repository" });
  });

  it("acepta .git como archivo gitdir: (worktree / separate-git-dir)", () => {
    const dir = repos.dir("wt");
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(repos.base, "wt.gitdir")], { cwd: dir });
    const p = ok(registry.register({ name: "wt", path: dir }, ACTOR));
    expect(store.getProject(p.id)?.fingerprint.gitDir).toBe(realpathSync(join(repos.base, "wt.gitdir")));
  });

  it("D3: una raíz symlink se registra con su destino real y se anota la ruta pedida", () => {
    const dir = repos.repo("real-app");
    const link = join(repos.base, "link-app");
    symlinkSync(dir, link);
    const p = ok(registry.register({ name: "app", path: link }, ACTOR));
    expect(p.rootPath).toBe(realpathSync(dir));
    expect(registry.history(p.id)[0].details).toMatchObject({ requestedPath: link });
  });

  it("rutas sensibles: raíz del sistema, carpeta personal y directorio de datos", () => {
    expect(registry.register({ name: "r", path: "/" }, ACTOR)).toMatchObject({ code: "sensitive_path" });
    expect(registry.register({ name: "h", path: homedir() }, ACTOR)).toMatchObject({ code: "sensitive_path" });
    const data = repos.repo("data/.saiki");
    expect(registry.register({ name: "d", path: data }, ACTOR)).toMatchObject({ code: "sensitive_path" });
    const inside = repos.repo("data/.saiki/sub");
    expect(registry.register({ name: "s", path: inside }, ACTOR)).toMatchObject({ code: "sensitive_path" });
  });

  it("duplicados: misma ruta, o la misma vía symlink → already_registered con el id", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    expect(registry.register({ name: "otro", path: dir }, ACTOR)).toMatchObject({ code: "already_registered", projectId: p.id });
    const link = join(repos.base, "alias");
    symlinkSync(dir, link);
    expect(registry.register({ name: "otro", path: link }, ACTOR)).toMatchObject({ code: "already_registered", projectId: p.id });
    // Inactivo: sigue registrado; se reactiva, no se duplica.
    registry.deactivate(p.id, ACTOR);
    const again = registry.register({ name: "otro", path: dir }, ACTOR);
    expect(again).toMatchObject({ code: "already_registered", projectId: p.id });
    expect(!again.ok && again.message).toMatch(/inactivo/);
  });

  it("anidamiento en ambos sentidos → nested_project", () => {
    const outer = repos.repo("outer");
    ok(registry.register({ name: "outer", path: outer }, ACTOR));
    const inner = repos.repo("outer/packages/inner");
    expect(registry.register({ name: "inner", path: inner }, ACTOR)).toMatchObject({ code: "nested_project" });

    const r2 = new ProjectRegistry(new CoreStore(":memory:"), { dataDir: join(repos.base, "data", ".saiki") });
    ok(r2.register({ name: "inner", path: inner }, ACTOR));
    expect(r2.register({ name: "outer", path: outer }, ACTOR)).toMatchObject({ code: "nested_project" });
  });

  it("nombre único entre activos (sin distinguir mayúsculas); un inactivo libera el nombre", () => {
    const a = ok(registry.register({ name: "App", path: repos.repo("a") }, ACTOR));
    expect(registry.register({ name: "app", path: repos.repo("b") }, ACTOR)).toMatchObject({ code: "name_taken" });
    registry.deactivate(a.id, ACTOR);
    ok(registry.register({ name: "app", path: repos.repo("b") }, ACTOR));
    // Reactivar el primero choca con el nombre en uso.
    expect(registry.activate(a.id, ACTOR)).toMatchObject({ code: "name_taken" });
  });

  it("nombre inválido", () => {
    for (const name of ["", "   ", "x".repeat(81), "a\nb", undefined]) {
      expect(registry.register({ name, path: repos.repo(`n${Math.random()}`) }, ACTOR)).toMatchObject({ code: "invalid_name" });
    }
  });

  it("D4: real exige confirmación explícita; cualquier otro modo es inválido", () => {
    const dir = repos.repo("app");
    expect(registry.register({ name: "a", path: dir, applyMode: "real" }, ACTOR)).toMatchObject({ code: "confirmation_required" });
    expect(registry.register({ name: "a", path: dir, applyMode: "real", confirmRealApply: "yes" }, ACTOR)).toMatchObject({
      code: "confirmation_required",
    });
    expect(registry.register({ name: "a", path: dir, applyMode: "prod" }, ACTOR)).toMatchObject({ code: "invalid_apply_mode" });
    expect(ok(registry.register({ name: "a", path: dir, applyMode: "real", confirmRealApply: true }, ACTOR)).applyMode).toBe("real");
  });
});

describe("salud (calculada al leer)", () => {
  it("missing al mover; moved si en la ruta aparece otro repositorio", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    renameSync(dir, join(repos.base, "app-moved"));
    expect(registry.get(p.id)).toMatchObject({ health: "missing" });
    repos.repo("app"); // otro repo distinto en la misma ruta
    expect(registry.get(p.id)).toMatchObject({ health: "moved" });
  });

  it("not_a_repository si desaparece .git; moved si .git se borra y se vuelve a crear", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    rmSync(join(dir, ".git"), { recursive: true });
    expect(registry.get(p.id)).toMatchObject({ health: "not_a_repository" });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(registry.get(p.id)).toMatchObject({ health: "moved" });
  });

  it("moved si la ruta registrada pasa a ser un symlink a otro sitio", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    renameSync(dir, join(repos.base, "elsewhere"));
    symlinkSync(join(repos.base, "elsewhere"), realpathSync(repos.base) + "/app");
    const v = registry.get(p.id)!;
    expect(v.health).toBe("moved");
    expect(v.healthDetail).toMatch(/otro sitio/);
  });

  it("no se puede reactivar un proyecto cuyo repositorio ya no está sano", () => {
    const dir = repos.repo("app");
    const p = ok(registry.register({ name: "app", path: dir }, ACTOR));
    registry.deactivate(p.id, ACTOR);
    renameSync(dir, join(repos.base, "gone"));
    expect(registry.activate(p.id, ACTOR)).toMatchObject({ ok: false, code: "project_unhealthy" });
  });
});

describe("edición, estado e historial (D2, D5, D7)", () => {
  it("renombrar y cambiar el modo dejan historial con actor; la ruta no es editable", () => {
    const p = ok(registry.register({ name: "app", path: repos.repo("app") }, ACTOR));
    const r = registry.update(p.id, { name: "app-2", applyMode: "real", confirmRealApply: true }, "alguien");
    expect(r).toMatchObject({ ok: true, project: { name: "app-2", applyMode: "real", rootPath: p.rootPath } });
    expect(registry.history(p.id).map((h) => [h.action, h.actor, h.details])).toEqual([
      ["registered", ACTOR, expect.anything()],
      ["renamed", "alguien", { from: "app", to: "app-2" }],
      ["apply_mode_changed", "alguien", { from: "sandbox", to: "real" }],
    ]);
    expect(registry.update(p.id, { applyMode: "real" }, ACTOR)).toMatchObject({ ok: true }); // sin cambio, sin confirmar
    expect(registry.update(p.id, { applyMode: "sandbox" }, ACTOR)).toMatchObject({ ok: true, project: { applyMode: "sandbox" } });
    expect(registry.update(p.id, { applyMode: "real" }, ACTOR)).toMatchObject({ code: "confirmation_required" });
    expect(registry.update("prj-nope", { name: "x" }, ACTOR)).toMatchObject({ code: "not_found" });
  });

  it("desactivar y reactivar quedan registrados; repetir no duplica historial", () => {
    const p = ok(registry.register({ name: "app", path: repos.repo("app") }, ACTOR));
    expect(registry.deactivate(p.id, ACTOR)).toMatchObject({ ok: true, project: { status: "inactive" } });
    expect(registry.deactivate(p.id, ACTOR)).toMatchObject({ ok: true });
    expect(registry.get(p.id)?.deactivatedAt).not.toBeNull();
    expect(registry.list("inactive")).toHaveLength(1);
    expect(registry.list("active")).toHaveLength(0);
    expect(registry.activate(p.id, ACTOR)).toMatchObject({ ok: true, project: { status: "active", deactivatedAt: null } });
    expect(registry.history(p.id).map((h) => h.action)).toEqual(["registered", "deactivated", "reactivated"]);
  });
});

describe("inmutabilidad en SQLite", () => {
  const db = (s: CoreStore) => (s as unknown as { db: Database.Database }).db;

  it("la identidad del proyecto no se puede cambiar ni borrar; el historial es de solo inserción", () => {
    const p = ok(registry.register({ name: "app", path: repos.repo("app") }, ACTOR));
    expect(() => db(store).prepare(`UPDATE projects SET rootPath='/tmp/otro' WHERE id=?`).run(p.id)).toThrow(/inmutable/);
    expect(() => db(store).prepare(`UPDATE projects SET fingerprint='{}' WHERE id=?`).run(p.id)).toThrow(/inmutable/);
    expect(() => db(store).prepare(`DELETE FROM projects WHERE id=?`).run(p.id)).toThrow(/no se borran/);
    expect(() => db(store).prepare(`UPDATE project_history SET actor='x'`).run()).toThrow(/inmutable/);
    expect(() => db(store).prepare(`DELETE FROM project_history`).run()).toThrow(/inmutable/);
    // Los campos editables sí cambian.
    db(store).prepare(`UPDATE projects SET name='renombrado' WHERE id=?`).run(p.id);
    expect(store.getProject(p.id)?.name).toBe("renombrado");
  });

  it("el registro sobrevive a reabrir la base de datos", () => {
    const file = join(repos.base, "core.sqlite");
    const s1 = new CoreStore(file);
    const p = ok(new ProjectRegistry(s1, { dataDir: "/nope" }).register({ name: "app", path: repos.repo("app") }, ACTOR));
    s1.close();
    const s2 = new CoreStore(file);
    expect(new ProjectRegistry(s2, { dataDir: "/nope" }).get(p.id)).toMatchObject({ name: "app", health: "ok" });
    s2.close();
  });
});

describe("validateProjectPath", () => {
  it("modo real exige escritura", () => {
    const dir = repos.repo("ro");
    execFileSync("chmod", ["555", dir]);
    try {
      expect(validateProjectPath(dir, { dataDir: "/nope", requireWritable: false })).toMatchObject({ ok: true });
      expect(validateProjectPath(dir, { dataDir: "/nope", requireWritable: true })).toMatchObject({ ok: false, code: "not_accessible" });
    } finally {
      execFileSync("chmod", ["755", dir]);
    }
  });
});
