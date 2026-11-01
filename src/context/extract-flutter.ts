import { parseYamlSubset, yamlMap, yamlString, type YamlMap } from "./minimal-yaml.js";
import { redactSecrets } from "./redact.js";
import {
  baseOf,
  byString,
  dirOf,
  emptyEcosystem,
  joinRel,
  uniqueEntryPoints,
  MAX_DEPENDENCIES,
  MAX_LOCKFILE_BYTES,
  type DependencyInfo,
  type EcosystemSummary,
  type ExtractContext,
  type FrameworkInfo,
} from "./summary-shared.js";

/**
 * (Project Context, T4) Extractor de Flutter/Dart: `pubspec.yaml` y, si existe,
 * `pubspec.lock` (versiones resueltas), con el lector YAML mínimo (D7).
 */

const PACKAGES: Readonly<Record<string, string>> = {
  provider: "provider",
  flutter_riverpod: "riverpod",
  riverpod: "riverpod",
  hooks_riverpod: "riverpod",
  flutter_bloc: "bloc",
  bloc: "bloc",
  get: "getx",
  go_router: "go_router",
  auto_route: "auto_route",
  firebase_core: "firebase",
  dio: "dio",
  http: "http",
  hive: "hive",
  sqflite: "sqflite",
  drift: "drift",
};
const TEST_PACKAGES: Readonly<Record<string, string>> = {
  flutter_test: "flutter_test",
  integration_test: "integration_test",
  test: "dart_test",
  mockito: "mockito",
  mocktail: "mocktail",
  bloc_test: "bloc_test",
};
const TOOL_PACKAGES: Readonly<Record<string, string>> = {
  flutter_lints: "flutter_lints",
  lints: "lints",
  very_good_analysis: "very_good_analysis",
  build_runner: "build_runner",
  json_serializable: "json_serializable",
  freezed: "freezed",
  flutter_launcher_icons: "flutter_launcher_icons",
  flutter_native_splash: "flutter_native_splash",
};
const PLATFORMS = ["android", "ios", "web", "macos", "windows", "linux"];

/** Especificación de una dependencia de pubspec, sin URLs ni rutas completas. */
function specOf(v: unknown): string {
  if (typeof v === "string") return redactSecrets(v === "" ? "any" : v);
  const m = v as YamlMap;
  const sdk = yamlString(m.sdk);
  if (sdk) return `sdk:${sdk}`;
  if (m.path !== undefined) return "path";
  if (m.git !== undefined) return "git";
  const version = yamlString(m.version);
  if (version) return redactSecrets(version);
  if (m.hosted !== undefined) return "hosted";
  return "any";
}

export async function extractFlutter(ctx: ExtractContext): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  for (const f of ctx.files) {
    if (baseOf(f.path) !== "pubspec.yaml") continue;
    const text = await ctx.read(f.path);
    if (text === null) continue;
    const { data } = parseYamlSubset(text);
    const dir = dirOf(f.path);
    const eco = emptyEcosystem("flutter", f.path, dir);
    eco.name = yamlString(data.name);
    eco.version = yamlString(data.version);
    eco.packageManager = "pub";
    if (!eco.name) ctx.warn(f.path, `sin "name": puede no ser un pubspec válido`);

    // Versiones resueltas del pubspec.lock del mismo directorio.
    const lockPath = joinRel(dir, "pubspec.lock");
    const resolved = new Map<string, string>();
    let lockSdks: YamlMap | null = null;
    if (ctx.byPath.has(lockPath)) {
      const lockText = await ctx.read(lockPath, MAX_LOCKFILE_BYTES);
      if (lockText !== null) {
        const lock = parseYamlSubset(lockText).data;
        const packages = yamlMap(lock.packages);
        if (!packages) ctx.warn(lockPath, `sin "packages"`);
        for (const [name, entry] of Object.entries(packages ?? {})) {
          const v = yamlString(yamlMap(entry)?.version);
          if (v) resolved.set(name, v);
        }
        lockSdks = yamlMap(lock.sdks);
      }
    }

    const deps: DependencyInfo[] = [];
    for (const [field, dev] of [["dependencies", false], ["dev_dependencies", true]] as const) {
      const block = data[field];
      if (block === undefined) continue;
      const map = yamlMap(block);
      if (!map) {
        if (block !== "") ctx.warn(f.path, `"${field}" no es un mapa`);
        continue;
      }
      for (const [name, v] of Object.entries(map)) {
        if (deps.some((d) => d.name === name)) continue;
        deps.push({ name, spec: specOf(v), dev, resolved: resolved.get(name) ?? null });
      }
    }
    deps.sort((a, b) => byString(a.name, b.name));
    eco.dependencies = deps.slice(0, MAX_DEPENDENCIES);
    eco.dependenciesTruncated = deps.length > MAX_DEPENDENCIES;

    const env = yamlMap(data.environment);
    const frameworks: FrameworkInfo[] = [];
    if (deps.some((d) => d.name === "flutter" && d.spec === "sdk:flutter")) {
      const lockFlutter = yamlString(lockSdks?.flutter);
      frameworks.push({
        name: "flutter",
        version: yamlString(env?.flutter) ?? lockFlutter ?? null,
        source: yamlString(env?.flutter) ? f.path : lockFlutter ? lockPath : f.path,
      });
    }
    for (const d of deps) {
      const fw = PACKAGES[d.name];
      if (fw && !frameworks.some((x) => x.name === fw)) {
        frameworks.push({ name: fw, version: d.resolved ?? d.spec, source: d.resolved ? lockPath : f.path });
      }
    }
    eco.frameworks = frameworks.sort((a, b) => byString(a.name, b.name));
    eco.testFrameworks = [...new Set(deps.map((d) => TEST_PACKAGES[d.name]).filter(Boolean))].sort(byString);
    eco.tools = [...new Set(deps.map((d) => TOOL_PACKAGES[d.name]).filter(Boolean))].sort(byString);

    const libMain = ctx.files.filter((x) => {
      const rel = dir === "." ? x.path : x.path.startsWith(`${dir}/`) ? x.path.slice(dir.length + 1) : null;
      return rel !== null && /^lib\/main(?:_[A-Za-z0-9_]+)?\.dart$/.test(rel);
    });
    eco.entryPoints = uniqueEntryPoints(libMain.map((x) => ({ path: x.path, source: "convention" })));
    eco.sourceRoots = ctx.hasDir(joinRel(dir, "lib")) ? [joinRel(dir, "lib")] : [];
    eco.configFiles = ctx.files.filter((x) => x.kind === "config" && dirOf(x.path) === dir).map((x) => x.path);
    eco.details = {
      sdk: yamlString(env?.sdk) ?? yamlString(lockSdks?.dart),
      platforms: PLATFORMS.filter((p) => ctx.hasDir(joinRel(dir, p))),
      ...(ctx.byPath.has(lockPath) ? { lockfile: lockPath } : {}),
    };
    out.push(eco);
  }
  return out;
}
