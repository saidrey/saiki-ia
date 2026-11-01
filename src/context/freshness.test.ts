import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { computeFreshness } from "./freshness.js";

/** (Project Context, T5) Firma de frescura (§8.3). */

let repos: TempRepos;
afterEach(() => repos.cleanup());

const sig = async (root: string) => (await computeFreshness(root)).signature;

describe("computeFreshness", () => {
  it("estable sin cambios; cambia con cada edición, también la segunda de un archivo ya modificado", async () => {
    repos = new TempRepos();
    const root = repos.repo("r", { "a.ts": "1\n", "src/b.ts": "b\n", "package.json": "{}" });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    git("add", "-A");
    git("commit", "-qm", "init");
    const index = statSync(join(root, ".git/index")).mtimeMs;

    const f0 = await computeFreshness(root);
    expect(f0.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(f0.changedPaths).toBe(0);
    expect(await sig(root)).toBe(f0.signature);

    writeFileSync(join(root, "src/b.ts"), "b2\n");
    const s1 = await sig(root);
    expect(s1).not.toBe(f0.signature);
    writeFileSync(join(root, "src/b.ts"), "b3 más larga\n"); // sigue " M": solo lo detecta el stat
    const s2 = await sig(root);
    expect(s2).not.toBe(s1);
    mkdirSync(join(root, "src/nuevo"));
    writeFileSync(join(root, "src/nuevo/c.ts"), "c\n"); // no versionado dentro de un directorio nuevo
    expect((await computeFreshness(root)).changedPaths).toBe(2);

    // Solo lectura: `git status` no reescribe el índice del repositorio.
    expect(statSync(join(root, ".git/index")).mtimeMs).toBe(index);
  });

  it("sin git: avisa y la firma depende solo de los manifiestos de la raíz", async () => {
    repos = new TempRepos();
    const root = repos.repo("r", { "package.json": "{}", "a.ts": "1\n" });
    const opts = { gitCommand: "git-inexistente-saiki" };
    const f0 = await computeFreshness(root, opts);
    expect(f0).toMatchObject({ gitHead: null, changedPaths: null, gitError: expect.stringMatching(/git no disponible/) });
    writeFileSync(join(root, "a.ts"), "2\n");
    expect((await computeFreshness(root, opts)).signature).toBe(f0.signature);
    writeFileSync(join(root, "package.json"), '{"name":"x"}');
    expect((await computeFreshness(root, opts)).signature).not.toBe(f0.signature);
  });
});
