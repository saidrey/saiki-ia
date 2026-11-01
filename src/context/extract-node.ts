import { redactSecrets } from "./redact.js";
import {
  baseOf,
  byString,
  dirOf,
  emptyEcosystem,
  isPlainObject,
  joinRel,
  parseJsonObject,
  uniqueEntryPoints,
  MAX_DEPENDENCIES,
  MAX_LOCKFILE_BYTES,
  MAX_SCRIPTS,
  MAX_SCRIPT_CHARS,
  type DependencyInfo,
  type EcosystemSummary,
  type EntryPoint,
  type ExtractContext,
  type FrameworkInfo,
} from "./summary-shared.js";

/**
 * (Project Context, T4) Extractores del ecosistema JavaScript: Node
 * (npm/pnpm/yarn/bun), Angular, Ionic y Capacitor.
 *
 * Solo leen JSON y texto; nunca ejecutan scripts ni configuraciones `.ts/.js`.
 * Versiones resueltas: del `package-lock.json` (npm). pnpm y yarn guardan el
 * lockfile en YAML/propio: se detecta el gestor, pero la versión queda como la
 * especificación declarada (limitación documentada).
 */

const LOCKFILES: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
};

/** Paquete → framework (nombre normalizado). */
const FRAMEWORKS: Readonly<Record<string, string>> = {
  "@angular/core": "angular",
  "@ionic/angular": "ionic",
  "@ionic/react": "ionic",
  "@ionic/vue": "ionic",
  "@ionic/core": "ionic",
  "@capacitor/core": "capacitor",
  react: "react",
  "react-native": "react-native",
  expo: "expo",
  next: "next",
  vue: "vue",
  nuxt: "nuxt",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  express: "express",
  fastify: "fastify",
  koa: "koa",
  "@nestjs/core": "nestjs",
  electron: "electron",
  firebase: "firebase",
  "firebase-functions": "firebase-functions",
  "firebase-admin": "firebase-admin",
  "@langchain/langgraph": "langgraph",
};

const TEST_FRAMEWORKS: Readonly<Record<string, string>> = {
  vitest: "vitest",
  jest: "jest",
  karma: "karma",
  "jasmine-core": "jasmine",
  mocha: "mocha",
  cypress: "cypress",
  "@playwright/test": "playwright",
  protractor: "protractor",
  "@testing-library/react": "testing-library",
  "@testing-library/angular": "testing-library",
};

const TOOLS: Readonly<Record<string, string>> = {
  typescript: "typescript",
  vite: "vite",
  webpack: "webpack",
  esbuild: "esbuild",
  rollup: "rollup",
  parcel: "parcel",
  tsx: "tsx",
  "ts-node": "ts-node",
  "@angular/cli": "angular-cli",
  "@ionic/cli": "ionic-cli",
  "@capacitor/cli": "capacitor-cli",
  eslint: "eslint",
  tslint: "tslint",
  prettier: "prettier",
  "@biomejs/biome": "biome",
  nx: "nx",
  turbo: "turbo",
  lerna: "lerna",
  "@babel/core": "babel",
  sass: "sass",
  "firebase-tools": "firebase-tools",
};

/** Puntos de entrada por convención (si package.json no declara ninguno). */
const CONVENTIONAL_ENTRIES = ["src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "src/main.js", "src/index.js", "src/server.ts", "src/app.ts", "index.ts", "index.js", "server.js", "app.js"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Lockfile más cercano subiendo desde `dir` (workspaces comparten el de la raíz). */
function nearestLockfile(ctx: ExtractContext, dir: string): { path: string; manager: string } | null {
  let d = dir;
  for (;;) {
    for (const [name, manager] of Object.entries(LOCKFILES)) {
      const p = joinRel(d, name);
      if (ctx.byPath.has(p)) return { path: p, manager };
    }
    if (d === ".") return null;
    d = dirOf(d);
  }
}

type NpmLock = { path: string; data: Record<string, unknown> };

/** Versión resuelta de una dependencia directa en un package-lock (v1, v2 o v3). */
function resolvedVersion(lock: NpmLock | null, pkgDir: string, name: string): string | null {
  if (!lock) return null;
  const lockDir = dirOf(lock.path);
  const packages = lock.data.packages;
  if (pkgDir !== lockDir) {
    // Paquete en un subdirectorio: solo si el lockfile lo cubre como workspace
    // (npm lo lista como clave propia). Sus dependencias pueden estar en
    // `<subdir>/node_modules/x` o elevadas a `node_modules/x`.
    const sub = lockDir === "." ? pkgDir : pkgDir.slice(lockDir.length + 1);
    if (!isPlainObject(packages) || !isPlainObject(packages[sub])) return null;
    for (const key of [`${sub}/node_modules/${name}`, `node_modules/${name}`]) {
      const v = packages[key];
      if (isPlainObject(v) && typeof v.version === "string") return v.version;
    }
    return null;
  }
  if (isPlainObject(packages)) {
    const v = packages[`node_modules/${name}`];
    if (isPlainObject(v) && typeof v.version === "string") return v.version;
  }
  const deps = lock.data.dependencies;
  if (isPlainObject(deps) && isPlainObject(deps[name]) && typeof deps[name].version === "string") return deps[name].version as string;
  return null;
}

/** Rutas de código del índice citadas en los comandos de los scripts. */
function scriptEntries(ctx: ExtractContext, dir: string, scripts: Array<{ name: string; command: string }>): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const s of scripts) {
    for (const token of s.command.split(/[\s;&|()]+/)) {
      const t = token.replace(/^['"]|['"]$/g, "");
      if (!/\.[cm]?[jt]sx?$/.test(t) || t.startsWith("-") || t.includes("*") || t.startsWith("/")) continue;
      const p = joinRel(dir, t);
      const f = ctx.byPath.get(p);
      if (f && f.kind === "source") out.push({ path: p, source: `script:${s.name}` });
    }
  }
  return out;
}

export async function extractNode(ctx: ExtractContext): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  const locks = new Map<string, NpmLock | null>();
  const readLock = async (path: string): Promise<NpmLock | null> => {
    if (!locks.has(path)) {
      const text = await ctx.read(path, MAX_LOCKFILE_BYTES);
      const data = text === null ? null : parseJsonObject(ctx, path, text);
      locks.set(path, data ? { path, data } : null);
    }
    return locks.get(path)!;
  };

  for (const f of ctx.files) {
    if (baseOf(f.path) !== "package.json") continue;
    const text = await ctx.read(f.path);
    if (text === null) continue;
    const pkg = parseJsonObject(ctx, f.path, text);
    if (!pkg) continue;

    const dir = dirOf(f.path);
    const eco = emptyEcosystem("node", f.path, dir);
    eco.name = str(pkg.name);
    eco.version = str(pkg.version);

    const lockRef = nearestLockfile(ctx, dir);
    const declaredPm = str(pkg.packageManager)?.match(/^([a-z]+)@/)?.[1] ?? null;
    eco.packageManager = declaredPm ?? lockRef?.manager ?? null;
    const lock = lockRef && lockRef.manager === "npm" ? await readLock(lockRef.path) : null;

    // Dependencias directas.
    const deps: DependencyInfo[] = [];
    for (const [field, dev] of [["dependencies", false], ["optionalDependencies", false], ["devDependencies", true]] as const) {
      const block = pkg[field];
      if (block === undefined) continue;
      if (!isPlainObject(block)) {
        ctx.warn(f.path, `"${field}" no es un objeto`);
        continue;
      }
      for (const [name, spec] of Object.entries(block)) {
        if (typeof spec !== "string") {
          ctx.warn(f.path, `la versión de "${name}" no es texto`);
          continue;
        }
        if (deps.some((d) => d.name === name)) continue;
        deps.push({ name, spec: redactSecrets(spec), dev, resolved: resolvedVersion(lock, dir, name) });
      }
    }
    deps.sort((a, b) => byString(a.name, b.name));
    eco.dependencies = deps.slice(0, MAX_DEPENDENCIES);
    eco.dependenciesTruncated = deps.length > MAX_DEPENDENCIES;

    const frameworks: FrameworkInfo[] = [];
    for (const d of deps) {
      const fw = FRAMEWORKS[d.name];
      if (fw && !frameworks.some((x) => x.name === fw)) {
        frameworks.push({ name: fw, version: d.resolved ?? d.spec, source: d.resolved && lock ? lock.path : f.path });
      }
    }
    eco.frameworks = frameworks.sort((a, b) => byString(a.name, b.name));
    eco.testFrameworks = [...new Set(deps.map((d) => TEST_FRAMEWORKS[d.name]).filter(Boolean))].sort(byString);
    eco.tools = [...new Set(deps.map((d) => TOOLS[d.name]).filter(Boolean))].sort(byString);

    // Scripts (texto declarado, redactado; nunca se ejecutan).
    if (pkg.scripts !== undefined && !isPlainObject(pkg.scripts)) ctx.warn(f.path, `"scripts" no es un objeto`);
    const scripts = isPlainObject(pkg.scripts)
      ? Object.entries(pkg.scripts)
          .filter((e): e is [string, string] => typeof e[1] === "string")
          .map(([name, command]) => ({ name, command: redactSecrets(command).slice(0, MAX_SCRIPT_CHARS) }))
          .sort((a, b) => byString(a.name, b.name))
      : [];
    eco.scripts = scripts.slice(0, MAX_SCRIPTS);

    // Puntos de entrada declarados, citados por scripts o por convención.
    const entries: EntryPoint[] = [];
    const declared = (rel: unknown, source: string) => {
      const r = str(rel);
      if (r && !r.startsWith("/")) entries.push({ path: joinRel(dir, r), source });
    };
    declared(pkg.main, "main");
    declared(pkg.module, "module");
    if (typeof pkg.bin === "string") declared(pkg.bin, "bin");
    else if (isPlainObject(pkg.bin)) for (const [k, v] of Object.entries(pkg.bin)) declared(v, `bin:${k}`);
    if (typeof pkg.exports === "string") declared(pkg.exports, "exports");
    else if (isPlainObject(pkg.exports) && typeof pkg.exports["."] === "string") declared(pkg.exports["."], "exports");
    entries.push(...scriptEntries(ctx, dir, scripts));
    if (entries.length === 0) {
      for (const c of CONVENTIONAL_ENTRIES) {
        const p = joinRel(dir, c);
        if (ctx.byPath.has(p)) entries.push({ path: p, source: "convention" });
      }
    }
    eco.entryPoints = uniqueEntryPoints(entries);

    eco.sourceRoots = ctx.hasDir(joinRel(dir, "src")) ? [joinRel(dir, "src")] : [];
    eco.configFiles = ctx.files.filter((x) => x.kind === "config" && dirOf(x.path) === dir).map((x) => x.path);

    const details: Record<string, unknown> = {};
    if (isPlainObject(pkg.engines) && typeof pkg.engines.node === "string") details.engines = { node: pkg.engines.node };
    if (typeof pkg.type === "string") details.moduleType = pkg.type;
    if (pkg.private === true) details.private = true;
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : isPlainObject(pkg.workspaces) ? pkg.workspaces.packages : undefined;
    if (Array.isArray(ws)) details.workspaces = ws.filter((w): w is string => typeof w === "string").sort(byString);
    for (const name of [".nvmrc", ".node-version"]) {
      const p = joinRel(dir, name);
      if (!ctx.byPath.has(p)) continue;
      const v = (await ctx.read(p))?.split(/\r?\n/)[0]?.trim();
      if (v) details.nodeVersion = v.slice(0, 40);
    }
    if (lockRef) details.lockfile = lockRef.path;
    eco.details = details;
    out.push(eco);
  }
  return out;
}

/** Versión de un paquete según el ecosistema Node del mismo directorio. */
function nodeFramework(node: EcosystemSummary[], dir: string, fw: string): FrameworkInfo | null {
  const eco = node.find((e) => e.root === dir) ?? node.find((e) => e.root === ".");
  return eco?.frameworks.find((x) => x.name === fw) ?? null;
}

export async function extractAngular(ctx: ExtractContext, node: EcosystemSummary[]): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  for (const f of ctx.files) {
    if (baseOf(f.path) !== "angular.json") continue;
    const text = await ctx.read(f.path);
    if (text === null) continue;
    const ws = parseJsonObject(ctx, f.path, text);
    if (!ws) continue;
    const dir = dirOf(f.path);
    const eco = emptyEcosystem("angular", f.path, dir);
    const fw = nodeFramework(node, dir, "angular");
    if (fw) eco.frameworks = [fw];
    eco.version = fw?.version ?? null;

    if (!isPlainObject(ws.projects)) {
      ctx.warn(f.path, `sin "projects"`);
      eco.configFiles = [f.path];
      out.push(eco);
      continue;
    }
    const projects: Array<Record<string, unknown>> = [];
    const entries: EntryPoint[] = [];
    const roots = new Set<string>();
    const tests = new Set<string>();
    const configs = new Set<string>([f.path]);
    for (const name of Object.keys(ws.projects).sort(byString)) {
      const p = ws.projects[name];
      if (!isPlainObject(p)) continue;
      const targets = isPlainObject(p.architect) ? p.architect : isPlainObject(p.targets) ? p.targets : {};
      const build = isPlainObject(targets.build) ? targets.build : {};
      const options = isPlainObject(build.options) ? build.options : {};
      const test = isPlainObject(targets.test) ? targets.test : {};
      const main = str(options.browser) ?? str(options.main);
      const tsConfig = str(options.tsConfig);
      const sourceRoot = str(p.sourceRoot);
      if (main) entries.push({ path: joinRel(dir, main), source: `angular:${name}` });
      if (sourceRoot) roots.add(joinRel(dir, sourceRoot));
      if (tsConfig && ctx.byPath.has(joinRel(dir, tsConfig))) configs.add(joinRel(dir, tsConfig));
      const testBuilder = str(test.builder);
      if (testBuilder) {
        for (const [needle, label] of [["karma", "karma"], ["jest", "jest"], ["web-test-runner", "web-test-runner"], ["vitest", "vitest"]] as const) {
          if (testBuilder.includes(needle)) tests.add(label);
        }
      }
      projects.push({
        name,
        type: str(p.projectType),
        root: str(p.root) ?? "",
        sourceRoot,
        main,
        builder: str(build.builder),
        testBuilder,
        tsConfig,
      });
    }
    eco.entryPoints = uniqueEntryPoints(entries);
    eco.sourceRoots = [...roots].sort(byString);
    eco.testFrameworks = [...tests].sort(byString);
    eco.configFiles = [...configs].sort(byString);
    eco.details = { projects };
    out.push(eco);
  }
  return out;
}

export async function extractIonic(ctx: ExtractContext, node: EcosystemSummary[]): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  for (const f of ctx.files) {
    if (baseOf(f.path) !== "ionic.config.json") continue;
    const text = await ctx.read(f.path);
    if (text === null) continue;
    const cfg = parseJsonObject(ctx, f.path, text);
    if (!cfg) continue;
    const dir = dirOf(f.path);
    const eco = emptyEcosystem("ionic", f.path, dir);
    eco.name = str(cfg.name);
    const fw = nodeFramework(node, dir, "ionic");
    if (fw) eco.frameworks = [fw];
    eco.version = fw?.version ?? null;
    eco.configFiles = [f.path];
    eco.details = {
      type: str(cfg.type),
      integrations: isPlainObject(cfg.integrations) ? Object.keys(cfg.integrations).sort(byString) : [],
    };
    out.push(eco);
  }
  return out;
}

/** Valor de una propiedad de texto en un config TS/JS, leído como TEXTO (sin ejecutarlo). */
function literalProperty(source: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`\\n]{1,200})\\1`).exec(source);
  return m ? m[2] : null;
}

export async function extractCapacitor(ctx: ExtractContext, node: EcosystemSummary[]): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  for (const f of ctx.files) {
    const base = baseOf(f.path);
    if (!/^capacitor\.config\.(?:json|ts|js|mjs|cjs)$/.test(base)) continue;
    const text = await ctx.read(f.path);
    if (text === null) continue;
    const dir = dirOf(f.path);
    const eco = emptyEcosystem("capacitor", f.path, dir);
    let appId: string | null = null;
    let appName: string | null = null;
    let webDir: string | null = null;
    if (base.endsWith(".json")) {
      const cfg = parseJsonObject(ctx, f.path, text);
      if (!cfg) continue;
      appId = str(cfg.appId);
      appName = str(cfg.appName);
      webDir = str(cfg.webDir);
    } else {
      appId = literalProperty(text, "appId");
      appName = literalProperty(text, "appName");
      webDir = literalProperty(text, "webDir");
      if (!appId && !appName) ctx.warn(f.path, "no se encontraron appId/appName como texto literal (no se ejecuta el archivo)");
    }
    eco.name = appName;
    const fw = nodeFramework(node, dir, "capacitor");
    if (fw) eco.frameworks = [fw];
    eco.version = fw?.version ?? null;
    eco.configFiles = [f.path];
    eco.details = {
      appId,
      webDir,
      platforms: ["android", "ios"].filter((pl) => ctx.hasDir(joinRel(dir, pl))),
    };
    out.push(eco);
  }
  return out;
}
