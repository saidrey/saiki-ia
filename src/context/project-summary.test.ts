import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { readFingerprint } from "../projects/project-fs.js";
import { spawnProcessRunner, type ProcessRunner } from "../agents/process-runner.js";
import { ContextStore, type FileRecord } from "./context-store.js";
import { runScan } from "./incremental-scan.js";
import { buildSummary, normalizeSummary, type EcosystemSummary, type ProjectSummaryV2 } from "./project-summary.js";

/** (Project Context, T4) Extractores sobre repositorios git reales, de punta a punta (T1–T3). */

let repos: TempRepos;
let store: ContextStore;
beforeEach(() => {
  repos = new TempRepos();
  store = new ContextStore(":memory:");
});
afterEach(() => {
  store.close();
  repos.cleanup();
});

function age(root: string): void {
  const t = Date.now() / 1000 - 3600;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else utimesSync(f, t, t);
    }
  };
  walk(root);
}

let seq = 0;
async function summarize(files: Record<string, string>, extra: { runner?: ProcessRunner } = {}): Promise<{ summary: ProjectSummaryV2; root: string }> {
  const root = realpathSync(repos.repo(`p${++seq}`, files));
  age(root);
  const r = await runScan(store, { projectId: `prj-${seq}`, rootPath: root, fingerprint: readFingerprint(root), mode: "full", trigger: "manual", ...extra });
  if (!r.ok) throw new Error(r.message);
  return { summary: r.snapshot.summary as unknown as ProjectSummaryV2, root };
}

const eco = (s: ProjectSummaryV2, kind: EcosystemSummary["kind"], root = ".") => {
  const e = s.ecosystems.find((x) => x.kind === kind && x.root === root);
  if (!e) throw new Error(`sin ecosistema ${kind} en ${root}: ${JSON.stringify(s.ecosystems.map((x) => [x.kind, x.root]))}`);
  return e;
};

const json = (v: unknown) => JSON.stringify(v, null, 2);

describe("Node (npm, pnpm, yarn)", () => {
  it("dependencias con versión resuelta, frameworks, herramientas, scripts redactados y puntos de entrada", async () => {
    const { summary } = await summarize({
      "package.json": json({
        name: "api",
        version: "1.0.0",
        type: "module",
        main: "dist/index.js",
        bin: { api: "bin/cli.js" },
        engines: { node: ">=20" },
        scripts: { start: "tsx src/server.ts", deploy: "firebase deploy --token 1//secreto", test: "vitest run" },
        dependencies: { express: "^4.18.0", "@langchain/langgraph": "^0.2.0" },
        devDependencies: { typescript: "~5.4.0", vitest: "^1.0.0", eslint: "^9.0.0" },
      }),
      "package-lock.json": json({
        lockfileVersion: 3,
        packages: {
          "": { name: "api" },
          "node_modules/express": { version: "4.19.2" },
          "node_modules/typescript": { version: "5.4.5" },
        },
      }),
      ".nvmrc": "20.11.1\n",
      "tsconfig.json": "{}",
      "src/server.ts": "export {}",
      "src/routes/users.ts": "export {}",
      "src/routes/users.test.ts": "test",
    });
    const n = eco(summary, "node");
    expect(n).toMatchObject({ manifest: "package.json", name: "api", version: "1.0.0", packageManager: "npm" });
    expect(n.dependencies).toEqual([
      { name: "@langchain/langgraph", spec: "^0.2.0", dev: false, resolved: null },
      { name: "eslint", spec: "^9.0.0", dev: true, resolved: null },
      { name: "express", spec: "^4.18.0", dev: false, resolved: "4.19.2" },
      { name: "typescript", spec: "~5.4.0", dev: true, resolved: "5.4.5" },
      { name: "vitest", spec: "^1.0.0", dev: true, resolved: null },
    ]);
    expect(n.frameworks).toEqual([
      { name: "express", version: "4.19.2", source: "package-lock.json" },
      { name: "langgraph", version: "^0.2.0", source: "package.json" },
    ]);
    expect(n.tools).toEqual(["eslint", "typescript"]);
    expect(n.testFrameworks).toEqual(["vitest"]);
    expect(n.scripts).toEqual([
      { name: "deploy", command: "firebase deploy --token ***" },
      { name: "start", command: "tsx src/server.ts" },
      { name: "test", command: "vitest run" },
    ]);
    expect(n.entryPoints).toEqual([
      { path: "bin/cli.js", source: "bin:api" },
      { path: "dist/index.js", source: "main" },
      { path: "src/server.ts", source: "script:start" },
    ]);
    expect(n.sourceRoots).toEqual(["src"]);
    expect(n.configFiles).toEqual([".nvmrc", "tsconfig.json"]);
    expect(n.details).toEqual({ engines: { node: ">=20" }, moduleType: "module", nodeVersion: "20.11.1", lockfile: "package-lock.json" });
    expect(summary.modules).toEqual([{ path: "src/routes", files: 2, tests: 1 }]);
    expect(summary.tests).toEqual({ files: 1, frameworks: ["vitest"], dirs: [] });
    expect(JSON.stringify(summary)).not.toContain("secreto");
  });

  it("gestor de paquetes: campo packageManager, pnpm y yarn por lockfile, sin lockfile", async () => {
    const pm = async (files: Record<string, string>) => eco((await summarize({ "package.json": json({ name: "x" }), ...files })).summary, "node").packageManager;
    expect(await pm({ "pnpm-lock.yaml": "lockfileVersion: '6.0'\n" })).toBe("pnpm");
    expect(await pm({ "yarn.lock": "# yarn\n" })).toBe("yarn");
    expect(await pm({})).toBeNull();
    const declared = await summarize({ "package.json": json({ name: "x", packageManager: "pnpm@9.1.0" }), "package-lock.json": "{}" });
    expect(eco(declared.summary, "node").packageManager).toBe("pnpm");
  });

  it("workspaces: el lockfile de la raíz resuelve las dependencias del workspace; un paquete anidado no cubierto queda sin resolver", async () => {
    const { summary } = await summarize({
      "package.json": json({ name: "mono", private: true, workspaces: ["packages/*"] }),
      "package-lock.json": json({
        lockfileVersion: 3,
        packages: { "": {}, "packages/a": { name: "a" }, "node_modules/react": { version: "18.3.1" } },
      }),
      "packages/a/package.json": json({ name: "a", dependencies: { react: "^18.0.0" } }),
      "tools/b/package.json": json({ name: "b", dependencies: { react: "^18.0.0" } }),
    });
    expect(eco(summary, "node").details).toMatchObject({ private: true, workspaces: ["packages/*"] });
    expect(eco(summary, "node", "packages/a").dependencies[0]).toMatchObject({ name: "react", resolved: "18.3.1" });
    expect(eco(summary, "node", "packages/a").frameworks).toEqual([{ name: "react", version: "18.3.1", source: "package-lock.json" }]);
    expect(eco(summary, "node", "tools/b").dependencies[0]).toMatchObject({ name: "react", resolved: null });
  });
});

describe("Angular", () => {
  it("proyectos de angular.json, versión del lockfile, main, sourceRoot, builder de pruebas y módulos de src/app", async () => {
    const { summary } = await summarize({
      "package.json": json({ name: "web", dependencies: { "@angular/core": "^16.2.0", rxjs: "~7.8.0" }, devDependencies: { "@angular/cli": "^16.2.0", karma: "~6.4.0", "jasmine-core": "~4.6.0" } }),
      "package-lock.json": json({ lockfileVersion: 2, packages: { "node_modules/@angular/core": { version: "16.2.8" } } }),
      "angular.json": json({
        version: 1,
        projects: {
          web: {
            projectType: "application",
            root: "",
            sourceRoot: "src",
            architect: {
              build: { builder: "@angular-devkit/build-angular:browser", options: { main: "src/main.ts", tsConfig: "tsconfig.app.json" } },
              test: { builder: "@angular-devkit/build-angular:karma" },
            },
          },
        },
      }),
      "tsconfig.app.json": "{}",
      "src/main.ts": "bootstrap",
      "src/app/auth/login.component.ts": "x",
      "src/app/auth/login.component.spec.ts": "x",
      "src/app/bets/list.component.ts": "x",
      "src/app/app.module.ts": "x",
    });
    const a = eco(summary, "angular");
    expect(a).toMatchObject({ manifest: "angular.json", version: "16.2.8", sourceRoots: ["src"], testFrameworks: ["karma"] });
    expect(a.frameworks).toEqual([{ name: "angular", version: "16.2.8", source: "package-lock.json" }]);
    expect(a.entryPoints).toEqual([{ path: "src/main.ts", source: "angular:web" }]);
    expect(a.configFiles).toEqual(["angular.json", "tsconfig.app.json"]);
    expect(a.details.projects).toEqual([
      {
        name: "web",
        type: "application",
        root: "",
        sourceRoot: "src",
        main: "src/main.ts",
        builder: "@angular-devkit/build-angular:browser",
        testBuilder: "@angular-devkit/build-angular:karma",
        tsConfig: "tsconfig.app.json",
      },
    ]);
    expect(eco(summary, "node").tools).toEqual(["angular-cli"]);
    expect(summary.modules).toEqual([
      { path: "src/app/auth", files: 2, tests: 1 },
      { path: "src/app/bets", files: 1, tests: 0 },
    ]);
    expect(summary.tests.frameworks).toEqual(["jasmine", "karma"]);
  });

  it("builder application (Angular 17+): usa options.browser como entrada", async () => {
    const { summary } = await summarize({
      "angular.json": json({ projects: { app: { sourceRoot: "src", architect: { build: { builder: "@angular-devkit/build-angular:application", options: { browser: "src/main.ts" } } } } } }),
      "src/main.ts": "x",
    });
    expect(eco(summary, "angular").entryPoints).toEqual([{ path: "src/main.ts", source: "angular:app" }]);
  });
});

describe("Ionic / Capacitor", () => {
  it("ionic.config.json y capacitor.config.ts leído como texto, con plataformas", async () => {
    const { summary } = await summarize({
      "package.json": json({ name: "mobile", dependencies: { "@ionic/angular": "^7.5.0", "@capacitor/core": "^5.5.0", "@angular/core": "^16.0.0" } }),
      "ionic.config.json": json({ name: "mobile", integrations: { capacitor: {} }, type: "angular" }),
      "capacitor.config.ts": "import type { CapacitorConfig } from '@capacitor/cli';\nconst config: CapacitorConfig = {\n  appId: 'com.example.mobile',\n  appName: \"Mobile\",\n  webDir: 'www',\n};\nexport default config;\n",
      "android/app/src/main/AndroidManifest.xml": "<manifest/>",
      "src/app/home/home.page.ts": "x",
    });
    expect(eco(summary, "ionic")).toMatchObject({ name: "mobile", version: "^7.5.0", details: { type: "angular", integrations: ["capacitor"] } });
    expect(eco(summary, "capacitor")).toMatchObject({
      name: "Mobile",
      version: "^5.5.0",
      configFiles: ["capacitor.config.ts"],
      details: { appId: "com.example.mobile", webDir: "www", platforms: ["android"] },
    });
    expect(summary.modules).toEqual([{ path: "src/app/home", files: 1, tests: 0 }]);
  });

  it("capacitor.config.json", async () => {
    const { summary } = await summarize({ "capacitor.config.json": json({ appId: "com.x", appName: "X", webDir: "dist" }), "ios/App/App/AppDelegate.swift": "x" });
    expect(eco(summary, "capacitor").details).toEqual({ appId: "com.x", webDir: "dist", platforms: ["ios"] });
  });
});

describe("Flutter", () => {
  it("pubspec.yaml + pubspec.lock: frameworks, versiones, pruebas, herramientas, entradas y plataformas", async () => {
    const { summary } = await summarize({
      "pubspec.yaml": [
        "name: notes_app",
        "version: 1.2.0+3",
        "environment:",
        '  sdk: ">=3.2.0 <4.0.0"',
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "  provider: ^6.1.1",
        "  local_pkg:",
        "    path: ../local_pkg",
        "  private_pkg:",
        "    git:",
        "      url: https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/me/pkg.git",
        "dev_dependencies:",
        "  flutter_test:",
        "    sdk: flutter",
        "  flutter_lints: ^3.0.0",
        "flutter:",
        "  uses-material-design: true",
        "  assets:",
        "    - assets/",
      ].join("\n"),
      "pubspec.lock": [
        "packages:",
        "  provider:",
        '    dependency: "direct main"',
        "    description:",
        "      name: provider",
        '      url: "https://pub.dev"',
        "    source: hosted",
        '    version: "6.1.2"',
        "sdks:",
        '  dart: ">=3.2.0 <4.0.0"',
        '  flutter: ">=3.16.0"',
      ].join("\n"),
      "analysis_options.yaml": "include: package:flutter_lints/flutter.yaml",
      "lib/main.dart": "void main() {}",
      "lib/main_dev.dart": "void main() {}",
      "lib/notes/note_list.dart": "x",
      "lib/notes/note_repo.dart": "x",
      "test/notes/note_repo_test.dart": "x",
      "android/app/build.gradle": "x",
      "ios/Runner/Info.plist": "<plist/>",
    });
    const f = eco(summary, "flutter");
    expect(f).toMatchObject({ name: "notes_app", version: "1.2.0+3", packageManager: "pub", sourceRoots: ["lib"] });
    expect(f.dependencies).toEqual([
      { name: "flutter", spec: "sdk:flutter", dev: false, resolved: null },
      { name: "flutter_lints", spec: "^3.0.0", dev: true, resolved: null },
      { name: "flutter_test", spec: "sdk:flutter", dev: true, resolved: null },
      { name: "local_pkg", spec: "path", dev: false, resolved: null },
      { name: "private_pkg", spec: "git", dev: false, resolved: null },
      { name: "provider", spec: "^6.1.1", dev: false, resolved: "6.1.2" },
    ]);
    expect(f.frameworks).toEqual([
      { name: "flutter", version: ">=3.16.0", source: "pubspec.lock" },
      { name: "provider", version: "6.1.2", source: "pubspec.lock" },
    ]);
    expect(f.testFrameworks).toEqual(["flutter_test"]);
    expect(f.tools).toEqual(["flutter_lints"]);
    expect(f.entryPoints).toEqual([
      { path: "lib/main.dart", source: "convention" },
      { path: "lib/main_dev.dart", source: "convention" },
    ]);
    expect(f.configFiles).toEqual(["analysis_options.yaml"]);
    expect(f.details).toEqual({ sdk: ">=3.2.0 <4.0.0", platforms: ["android", "ios"], lockfile: "pubspec.lock" });
    expect(summary.modules).toEqual([{ path: "lib/notes", files: 2, tests: 0 }]);
    expect(summary.tests).toEqual({ files: 1, frameworks: ["flutter_test"], dirs: ["test"] });
    expect(summary.languages).toEqual([{ lang: "dart", files: 5 }]);
    expect(JSON.stringify(summary)).not.toContain("ghp_");
  });
});

describe("genérico", () => {
  it("Go, Python y manifiestos sin lector", async () => {
    const { summary } = await summarize({
      "go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\nrequire golang.org/x/text v0.14.0\n",
      "tools/requirements.txt": "requests==2.31.0\n# comentario\nflask[async]>=3.0\n-r base.txt\n",
      "Cargo.toml": "[package]\nname = \"x\"\n",
      "cmd/svc/main.go": "package main",
    });
    expect(summary.ecosystems.find((e) => e.manifest === "go.mod")).toMatchObject({
      kind: "generic",
      name: "example.com/svc",
      details: { ecosystem: "go", goVersion: "1.22" },
      dependencies: [
        { name: "github.com/gin-gonic/gin", spec: "v1.9.1", dev: false, resolved: "v1.9.1" },
        { name: "golang.org/x/text", spec: "v0.14.0", dev: false, resolved: "v0.14.0" },
      ],
    });
    expect(eco(summary, "generic", "tools").dependencies).toEqual([
      { name: "flask", spec: ">=3.0", dev: false, resolved: null },
      { name: "requests", spec: "==2.31.0", dev: false, resolved: null },
    ]);
    expect(summary.ecosystems.find((e) => e.manifest === "Cargo.toml")?.details).toEqual({ ecosystem: "rust", note: "manifiesto reconocido sin lector de dependencias" });
  });

  it("sin ningún manifiesto: resumen por convención", async () => {
    const { summary } = await summarize({ "app/main.py": "print()", "app/utils/text.py": "x", "README.md": "# x" });
    expect(summary.ecosystems).toEqual([
      expect.objectContaining({ kind: "generic", manifest: null, entryPoints: [{ path: "app/main.py", source: "convention" }], sourceRoots: ["app"] }),
    ]);
    expect(summary.modules).toEqual([{ path: "app/utils", files: 1, tests: 0 }]);
    expect(summary.repoDocs).toEqual([{ path: "README.md", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
});

describe("archivos inválidos o incompletos: avisos, nunca fallos", () => {
  it("JSON inválido, tipos inesperados, angular.json sin proyectos, lockfile roto y pubspec basura", async () => {
    const { summary } = await summarize({
      "package.json": json({ name: "x", dependencies: ["no", "es", "objeto"], scripts: "tampoco", devDependencies: { ok: "^1.0.0", raro: 5 } }),
      "package-lock.json": "{ roto",
      "angular.json": json({ version: 1 }),
      "sub/package.json": "{ esto no es json",
      "arr/package.json": "[1,2]",
      "pubspec.yaml": "\t\t:::\n{{{\n",
      "capacitor.config.ts": "export default makeConfig();",
      "src/a.ts": "x",
    });
    const n = eco(summary, "node");
    expect(n.dependencies).toEqual([{ name: "ok", spec: "^1.0.0", dev: true, resolved: null }]);
    expect(n.scripts).toEqual([]);
    expect(eco(summary, "angular").details).toEqual({});
    expect(eco(summary, "flutter").name).toBeNull();
    expect(summary.warnings.map((w) => `${w.path}: ${w.message.split(":")[0]}`)).toEqual([
      'angular.json: sin "projects"',
      "arr/package.json: no es un objeto JSON",
      "capacitor.config.ts: no se encontraron appId/appName como texto literal (no se ejecuta el archivo)",
      'package-lock.json: JSON inválido',
      'package.json: "dependencies" no es un objeto',
      'package.json: "scripts" no es un objeto',
      'package.json: la versión de "raro" no es texto',
      'pubspec.yaml: sin "name"',
      "sub/package.json: JSON inválido",
    ]);
  });

  it("manifiesto por encima del tope de tamaño: aviso y se omite", async () => {
    const { summary } = await summarize({ "package.json": json({ name: "big", description: "x".repeat(1024 * 1024) }) });
    expect(summary.ecosystems).toEqual([]);
    expect(summary.warnings).toEqual([{ path: "package.json", message: expect.stringMatching(/demasiado grande/) }]);
  });

  it("un archivo cuyo contenido ya no coincide con el hash indexado no se usa", async () => {
    const root = realpathSync(repos.repo("x", { "package.json": json({ name: "real" }) }));
    const files: FileRecord[] = [{ path: "package.json", kind: "manifest", lang: "json", size: 20, mtimeMs: 0, hash: "0".repeat(64), lastScanId: "s" }];
    const s = await buildSummary({ rootPath: root, files, source: "git", truncated: false });
    expect(s.ecosystems).toEqual([]);
    expect(s.warnings).toEqual([{ path: "package.json", message: "cambió durante el escaneo: no se usa" }]);
    expect(s.inputs).toEqual({});
  });
});

describe("seguridad", () => {
  it("no ejecuta nada del repositorio: scripts, configs JS/TS ni hooks; git es el único proceso", async () => {
    const marker = join(repos.base, "PWNED");
    const payload = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`;
    const calls: string[][] = [];
    const runner: ProcessRunner = (req) => {
      calls.push([req.command, ...req.args]);
      return spawnProcessRunner(req);
    };
    const { summary } = await summarize(
      {
        "package.json": json({ name: "evil", scripts: { preinstall: `node -e '${payload}'`, postinstall: `touch ${marker}` }, main: "index.js" }),
        "capacitor.config.ts": `${payload}\nexport default { appId: 'com.evil' };`,
        "vite.config.ts": payload,
        "karma.conf.js": payload,
        "angular.json": json({ projects: {} }),
        "index.js": payload,
      },
      { runner },
    );
    expect(existsSync(marker)).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(["git"]);
    expect(calls[0]).toContain("ls-files");
    expect(eco(summary, "capacitor").details.appId).toBe("com.evil");
  });

  it("los secretos nunca se leen ni aparecen en el resumen", async () => {
    const { summary } = await summarize({
      "package.json": json({ name: "x" }),
      ".npmrc": "//registry.npmjs.org/:_authToken=SECRETO_NPM",
      ".env": "API_KEY=SECRETO_ENV",
      "android/app/google-services.json": json({ api_key: "SECRETO_FIREBASE" }),
    });
    expect(Object.keys(summary.inputs)).toEqual(["package.json"]);
    expect(JSON.stringify(summary)).not.toMatch(/SECRETO/);
  });
});

describe("determinismo y compatibilidad", () => {
  it("los mismos archivos producen exactamente el mismo resumen", async () => {
    const files = {
      "package.json": json({ name: "x", dependencies: { b: "1", a: "2" }, scripts: { z: "z", a: "a" } }),
      "angular.json": json({ projects: { b: { sourceRoot: "src" }, a: { sourceRoot: "src" } } }),
      "src/app/x/a.ts": "x",
      "docs/b.md": "b",
      "docs/a.md": "a",
    };
    const a = (await summarize(files)).summary;
    const b = (await summarize(files)).summary;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("documentación del repositorio: README, docs/, CLAUDE.md, AGENTS.md y steering, con hash", async () => {
    const { summary } = await summarize({
      "README.md": "r",
      "CLAUDE.md": "c",
      "web/README.md": "w",
      "docs/API.md": "a",
      "docs/guides/setup.md": "s",
      ".kiro/steering/context.md": "k",
      "web/package.json": json({ name: "web" }),
      "vendor/skill/README.md": "no: no es la raíz de un paquete",
      "notes/random.md": "no",
      "CHANGELOG.md": "no",
    });
    expect(summary.repoDocs.map((d) => d.path)).toEqual([".kiro/steering/context.md", "CLAUDE.md", "README.md", "docs/API.md", "docs/guides/setup.md", "web/README.md"]);
  });

  it("un snapshot v1 (T3) se normaliza sin reescribirlo; el siguiente escaneo produce v2", async () => {
    const v1 = { schemaVersion: 1, files: 3, byKind: { source: 2, test: 1 }, byLang: { typescript: 3 }, source: "git", truncated: false };
    expect(normalizeSummary(v1)).toEqual({
      schemaVersion: 2,
      files: 3,
      byKind: { source: 2, test: 1 },
      byLang: { typescript: 3 },
      source: "git",
      truncated: false,
      languages: [],
      ecosystems: [],
      modules: [],
      modulesTruncated: false,
      configFiles: [],
      tests: { files: 1, frameworks: [], dirs: [] },
      repoDocs: [],
      warnings: [],
      inputs: {},
    });

    // Escaneo previo "de T3" guardado tal cual; el incremental siguiente publica v2.
    const root = realpathSync(repos.repo("v1", { "package.json": json({ name: "v1" }) }));
    age(root);
    const fp = readFingerprint(root);
    const first = await runScan(store, { projectId: "prj-v1", rootPath: root, fingerprint: fp, mode: "full", trigger: "manual" });
    if (!first.ok) throw new Error(first.message);
    writeFileSync(join(root, "a.ts"), "x");
    const next = await runScan(store, { projectId: "prj-v1", rootPath: root, fingerprint: fp, mode: "incremental", trigger: "manual" });
    if (!next.ok) throw new Error(next.message);
    expect(normalizeSummary(next.snapshot.summary)).toEqual(next.snapshot.summary);
    expect(store.getSnapshot("prj-v1", first.snapshot.id)?.summary).toEqual(first.snapshot.summary);
  });
});
