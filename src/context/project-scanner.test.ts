import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { TempRepos } from "../projects/test-repos.js";
import { readFingerprint } from "../projects/project-fs.js";
import { spawnProcessRunner, type ProcessRunner } from "../agents/process-runner.js";
import { gitEnv, scanProjectFiles, type FileListing, type ScanOptions } from "./project-scanner.js";

/** (Project Context, T1) Escáner sobre repositorios git REALES temporales. */

let repos: TempRepos;
beforeEach(() => {
  repos = new TempRepos();
});
afterEach(() => {
  repos.cleanup();
});

function repo(name: string, files: Record<string, string>): string {
  return realpathSync(repos.repo(name, files));
}

async function scan(root: string, extra: Partial<ScanOptions> = {}): Promise<FileListing> {
  const r = await scanProjectFiles({ rootPath: root, fingerprint: readFingerprint(root), ...extra });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.listing;
}

const paths = (l: FileListing) => l.files.map((f) => f.path);
const skipped = (l: FileListing, reason: string) => l.skipped.find((s) => s.reason === reason);

/** Hash de TODO el árbol, incluido .git, con contenido y mtime de cada archivo. */
function treeState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out[relative(dir, f)] = `${createHash("sha256").update(readFileSync(f)).digest("hex")}@${statSync(f).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

function commitAll(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, env: gitEnv() });
  git("add", "-A");
  git("commit", "-qm", "init");
}

describe("listado con git", () => {
  it("respeta .gitignore, aplica las exclusiones fijas, clasifica y ordena", async () => {
    const root = repo("app", {
      ".gitignore": "ignored.txt\ngenerated/\n",
      "package.json": "{}",
      "src/main.ts": "export {}",
      "src/main.spec.ts": "test",
      "README.md": "# app",
      "ignored.txt": "x",
      "generated/out.js": "x",
      "dist/bundle.js": "no ignorado en .gitignore, pero excluido",
      "node_modules/lib/index.js": "x",
      "npm-debug.log": "x",
    });
    const l = await scan(root);
    expect(l.source).toBe("git");
    expect(paths(l)).toEqual([".gitignore", "README.md", "package.json", "src/main.spec.ts", "src/main.ts"]);
    expect(l.files.map((f) => f.kind)).toEqual(["config", "doc", "manifest", "test", "source"]);
    expect(skipped(l, "excluded_dir")?.examples).toEqual(["dist/bundle.js", "node_modules/lib/index.js"]);
    expect(skipped(l, "excluded_file")?.examples).toEqual(["npm-debug.log"]);
    expect(l.truncated).toBe(false);
    const main = l.files.find((f) => f.path === "src/main.ts")!;
    expect(main).toMatchObject({ lang: "typescript", size: 9 });
    expect(main.mtimeMs).toBeGreaterThan(0);
  });

  it("incluye archivos versionados y no versionados; informa versionados borrados y repos anidados", async () => {
    const root = repo("app", { "a.ts": "1", "b.ts": "2" });
    commitAll(root);
    rmSync(join(root, "b.ts"));
    writeFileSync(join(root, "c.ts"), "3");
    mkdirSync(join(root, "vendor/other"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: join(root, "vendor/other") });
    writeFileSync(join(root, "vendor/other/x.ts"), "x");
    const l = await scan(root);
    expect(paths(l)).toEqual(["a.ts", "c.ts"]);
    expect(skipped(l, "missing")?.examples).toEqual(["b.ts"]);
    expect(skipped(l, "not_regular")?.examples).toEqual(["vendor/other/"]);
  });

  it("es determinista: dos escaneos dan la misma lista", async () => {
    const root = repo("app", { "z.ts": "", "a/b.ts": "", "m.md": "" });
    const a = await scan(root);
    const b = await scan(root);
    expect(a.files).toEqual(b.files);
    expect(a.skipped).toEqual(b.skipped);
  });
});

describe("secretos", () => {
  it("se listan como secreto sin abrirlos: ni siquiera hace falta permiso de lectura", async () => {
    const root = repo("app", { ".env": "TOKEN=abc", "android/app/google-services.json": "{}", "src/a.ts": "" });
    chmodSync(join(root, ".env"), 0o000);
    chmodSync(join(root, "android/app/google-services.json"), 0o000);
    try {
      const l = await scan(root);
      expect(l.files.filter((f) => f.kind === "secret").map((f) => f.path)).toEqual([".env", "android/app/google-services.json"]);
      expect(l.files.find((f) => f.path === ".env")).toMatchObject({ size: 9, lang: null });
      expect(skipped(l, "unreadable")).toBeUndefined();
    } finally {
      chmodSync(join(root, ".env"), 0o600);
      chmodSync(join(root, "android/app/google-services.json"), 0o600);
    }
  });
});

describe("binarios", () => {
  it("extensión desconocida: binario si hay un byte NUL al principio; si no, texto", async () => {
    const root = repo("app", { "tools/run": "#!/bin/sh\necho hola\n" });
    writeFileSync(join(root, "data.blob"), Buffer.from([0x50, 0x00, 0x01]));
    const l = await scan(root);
    expect(l.files.find((f) => f.path === "data.blob")).toMatchObject({ kind: "binary", lang: null });
    expect(l.files.find((f) => f.path === "tools/run")).toMatchObject({ kind: "other" });
  });
});

describe("enlaces simbólicos", () => {
  it("no se siguen; los que salen de la raíz se marcan aparte", async () => {
    const outside = repos.dir("fuera");
    writeFileSync(join(outside, "secreto.ts"), "fuera del proyecto");
    const root = repo("app", { "src/a.ts": "" });
    symlinkSync(join(root, "src/a.ts"), join(root, "alias.ts"));
    symlinkSync(outside, join(root, "externo"));
    symlinkSync(join(outside, "secreto.ts"), join(root, "src/b.ts"));
    for (const mode of ["git", "walk"] as const) {
      const l = await scan(root, mode === "walk" ? { gitCommand: "git-que-no-existe" } : {});
      expect(paths(l), mode).toEqual(["src/a.ts"]);
      expect(skipped(l, "symlink")?.examples, mode).toEqual(["alias.ts"]);
      expect(skipped(l, "symlink_outside")?.examples, mode).toEqual(["externo", "src/b.ts"]);
    }
  });
});

describe("directorio de datos de Saiki-IA", () => {
  it("nunca se lista, aunque esté dentro del proyecto y no esté en .gitignore", async () => {
    const root = repo("app", { "src/a.ts": "", ".saiki/core.sqlite": "db", "datos-saiki/context.sqlite": "db", "datos-saiki/sub/x.json": "{}" });
    for (const mode of ["git", "walk"] as const) {
      const l = await scan(root, { excludePaths: [join(root, "datos-saiki")], ...(mode === "walk" ? { gitCommand: "git-que-no-existe" } : {}) });
      expect(paths(l), mode).toEqual(["src/a.ts"]);
      expect(skipped(l, "excluded_dir")?.examples.some((p) => p.startsWith(".saiki")), mode).toBe(true);
      expect(skipped(l, "data_dir"), mode).toBeDefined();
    }
  });
});

describe("seguridad de git", () => {
  it("ignora un GIT_DIR hostil del entorno: lista su propio repositorio", async () => {
    const other = repo("otro", { "otro.ts": "" });
    commitAll(other);
    const root = repo("app", { "mio.ts": "" });
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      expect(paths(await scan(root))).toEqual(["mio.ts"]);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("lanza git sin variables GIT_*, con core.fsmonitor desactivado y en la raíz del proyecto", async () => {
    const root = repo("app", { "a.ts": "" });
    const seen: Parameters<ProcessRunner>[0][] = [];
    const runner: ProcessRunner = (req) => {
      seen.push(req);
      return spawnProcessRunner(req);
    };
    process.env.GIT_WORK_TREE = "/tmp";
    try {
      await scan(root, { runner });
    } finally {
      delete process.env.GIT_WORK_TREE;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(root);
    expect(Object.keys(seen[0].env ?? {}).filter((k) => k.startsWith("GIT_"))).toEqual([]);
    expect(seen[0].args).toContain("core.fsmonitor=false");
  });

  it("sin git (o si falla), recurre al recorrido propio con las mismas exclusiones", async () => {
    const root = repo("app", { "src/a.ts": "", "node_modules/x.js": "", ".gitignore": "src/\n" });
    const l = await scan(root, { gitCommand: "git-que-no-existe" });
    expect(l.source).toBe("walk");
    expect(l.gitError).toMatch(/git no disponible/);
    // El recorrido propio no interpreta .gitignore (limitación documentada).
    expect(paths(l)).toEqual([".gitignore", "src/a.ts"]);
    expect(skipped(l, "excluded_dir")?.examples).toEqual(["node_modules/"]);
  });
});

describe("identidad del proyecto", () => {
  it("no escanea un proyecto movido o sustituido", async () => {
    const root = repo("app", { "a.ts": "" });
    const fingerprint = readFingerprint(root);
    renameSync(root, `${root}-movido`);
    const r = await scanProjectFiles({ rootPath: root, fingerprint });
    expect(r).toMatchObject({ ok: false, code: "project_unhealthy" });

    const nuevo = repo("app", { "a.ts": "" }); // misma ruta, otro repositorio
    const r2 = await scanProjectFiles({ rootPath: nuevo, fingerprint });
    expect(r2).toMatchObject({ ok: false, code: "project_unhealthy" });
  });

  it("descarta el resultado si el repositorio cambia durante el escaneo", async () => {
    const root = repo("app", { "a.ts": "" });
    const fingerprint = readFingerprint(root);
    const runner: ProcessRunner = async (req) => {
      const r = await spawnProcessRunner(req);
      renameSync(root, `${root}-movido`);
      return r;
    };
    const r = await scanProjectFiles({ rootPath: root, fingerprint, runner });
    expect(r).toMatchObject({ ok: false, code: "project_identity_changed" });
  });
});

describe("solo lectura", () => {
  it("el repositorio, incluido .git (índice), queda idéntico en contenido y fechas", async () => {
    const root = repo("app", { "src/a.ts": "a", "src/b.spec.ts": "b", "README.md": "r", "data.blob": "\0" });
    commitAll(root);
    writeFileSync(join(root, "untracked.ts"), "u");
    const before = treeState(root);
    await scan(root);
    await scan(root, { gitCommand: "git-que-no-existe" });
    expect(treeState(root)).toEqual(before);
  });
});

describe("límite de archivos", () => {
  it("indexa los primeros por orden de ruta y marca truncated", async () => {
    const root = repo("app", { "c.ts": "", "a.ts": "", "b.ts": "", "d.ts": "" });
    const l = await scan(root, { maxFiles: 2 });
    expect(paths(l)).toEqual(["a.ts", "b.ts"]);
    expect(l.truncated).toBe(true);
  });
});
