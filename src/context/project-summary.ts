import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { FileRecord } from "./context-store.js";
import {
  baseOf,
  byString,
  dirOf,
  isPlainObject,
  MAX_MANIFEST_BYTES,
  type EcosystemKind,
  type EcosystemSummary,
  type ExtractContext,
  type ExtractionWarning,
  type ModuleSummary,
  type ProjectSummaryV2,
} from "./summary-shared.js";
import { extractNode, extractAngular, extractIonic, extractCapacitor } from "./extract-node.js";
import { extractFlutter } from "./extract-flutter.js";
import { extractGeneric } from "./extract-generic.js";

/**
 * (Project Context, T4) Resumen técnico del snapshot.
 *
 * Determinista y sin IA: describe QUÉ hay (lenguajes, ecosistemas, frameworks
 * y versiones, dependencias, scripts, puntos de entrada, módulos, pruebas,
 * configuración, documentación), no interpreta la arquitectura.
 *
 * Seguridad:
 * - Solo se leen manifiestos y configuración que YA están en el índice, nunca
 *   un secreto, con tope de tamaño y abriendo sin seguir enlaces simbólicos.
 * - Si el contenido leído no coincide con el hash indexado (cambió durante el
 *   escaneo), no se usa.
 * - Nada se ejecuta: ni scripts ni archivos de configuración en JS/TS (se leen
 *   como texto).
 * - Scripts y especificaciones de dependencias pasan por `redactSecrets`.
 * - Un archivo inválido produce un aviso (`warnings`), nunca un fallo del escaneo.
 *
 * Compatibilidad: `schemaVersion: 2` conserva todos los campos de la versión 1
 * (T3). `normalizeSummary` lee ambas.
 */

export type * from "./summary-shared.js";

const MAX_MODULES = 300;
const MAX_CONFIG_FILES = 200;
const MAX_REPO_DOCS = 50;
const MAX_WARNINGS = 100;
const MAX_TEST_DIRS = 50;

const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs", "integration_test", "e2e", "cypress", "playwright"]);
const REPO_DOC_NAME = /^(?:readme|architecture|contributing|claude|agents|conventions)(?:\.[a-z]+)?$/i;

// ── Lector seguro ────────────────────────────────────────────────────────────

function makeContext(rootPath: string, files: FileRecord[], warnings: ExtractionWarning[], inputs: Record<string, string | null>): ExtractContext {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dirs = new Set<string>();
  for (const f of files) {
    let d = dirOf(f.path);
    while (d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = dirOf(d);
    }
  }
  const warn = (path: string, message: string) => warnings.push({ path, message });
  return {
    files,
    byPath,
    warn,
    hasDir: (dir) => dir === "." || dirs.has(dir),
    async read(path, maxBytes = MAX_MANIFEST_BYTES) {
      const f = byPath.get(path);
      if (!f) return null;
      if (f.kind === "secret") {
        warn(path, "es un secreto: no se lee");
        return null;
      }
      if (f.size > maxBytes || f.hash === null) {
        warn(path, `demasiado grande para leerlo (${f.size} bytes)`);
        return null;
      }
      try {
        const fh = await open(join(rootPath, path), constants.O_RDONLY | constants.O_NOFOLLOW);
        let buf: Buffer;
        try {
          buf = await fh.readFile();
        } finally {
          await fh.close();
        }
        if (createHash("sha256").update(buf).digest("hex") !== f.hash) {
          warn(path, "cambió durante el escaneo: no se usa");
          return null;
        }
        inputs[path] = f.hash;
        return buf.toString("utf8");
      } catch {
        warn(path, "no se pudo leer");
        return null;
      }
    },
  };
}

// ── Campos del repositorio (sin leer archivos) ───────────────────────────────

function count(files: FileRecord[], key: "kind" | "lang"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const v = f[key];
    if (v !== null) out[v] = (out[v] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => byString(a, b)));
}

function modulesOf(ctx: ExtractContext, ecosystems: EcosystemSummary[]): { modules: ModuleSummary[]; truncated: boolean } {
  const code = ctx.files.filter((f) => f.kind === "source" || f.kind === "test");
  let bases = [...new Set(ecosystems.flatMap((e) => e.sourceRoots))].filter((b) => ctx.hasDir(b));
  if (bases.length === 0) bases = ["src", "lib", "app"].filter((b) => ctx.hasDir(b));
  if (bases.length === 0) bases = ["."];
  // `src/app` (Angular, Ionic) agrupa las funcionalidades: se usa como base.
  bases = [...new Set(bases.map((b) => (b !== "." && code.some((f) => f.path.startsWith(`${b}/app/`)) ? `${b}/app` : b)))].sort(byString);

  const mods = new Map<string, ModuleSummary>();
  for (const f of code) {
    // La base más específica que contiene el archivo.
    const base = bases.filter((b) => b === "." || f.path.startsWith(`${b}/`)).sort((a, b) => b.length - a.length)[0];
    if (base === undefined) continue;
    const rest = base === "." ? f.path : f.path.slice(base.length + 1);
    if (!rest.includes("/")) continue; // archivo suelto en la base
    const path = base === "." ? rest.slice(0, rest.indexOf("/")) : `${base}/${rest.slice(0, rest.indexOf("/"))}`;
    const m = mods.get(path) ?? { path, files: 0, tests: 0 };
    m.files++;
    if (f.kind === "test") m.tests++;
    mods.set(path, m);
  }
  const all = [...mods.values()].sort((a, b) => byString(a.path, b.path));
  return { modules: all.slice(0, MAX_MODULES), truncated: all.length > MAX_MODULES };
}

function testDirsOf(files: FileRecord[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (f.kind !== "test") continue;
    const segs = f.path.split("/").slice(0, -1);
    const i = segs.findIndex((s) => TEST_DIR_NAMES.has(s));
    if (i !== -1) dirs.add(segs.slice(0, i + 1).join("/"));
  }
  return [...dirs].sort(byString).slice(0, MAX_TEST_DIRS);
}

/**
 * Documentación del repositorio: README/ARCHITECTURE/CLAUDE/AGENTS… solo en la
 * raíz o en la raíz de un paquete detectado (no los de dependencias o skills
 * de terceros que vivan más abajo), más `docs/` y `.kiro/steering/`.
 */
function repoDocsOf(files: FileRecord[], ecosystemRoots: ReadonlySet<string>): Array<{ path: string; hash: string | null }> {
  return files
    .filter(
      (f) =>
        f.kind === "doc" &&
        ((REPO_DOC_NAME.test(baseOf(f.path)) && (dirOf(f.path) === "." || ecosystemRoots.has(dirOf(f.path)))) ||
          /^docs\/.+\.mdx?$/i.test(f.path) ||
          /^\.kiro\/steering\/.+\.md$/i.test(f.path) ||
          f.path === ".github/copilot-instructions.md"),
    )
    .map((f) => ({ path: f.path, hash: f.hash }))
    .sort((a, b) => byString(a.path, b.path))
    .slice(0, MAX_REPO_DOCS);
}

// ── Orquestación ─────────────────────────────────────────────────────────────

const KIND_ORDER: EcosystemKind[] = ["node", "angular", "ionic", "capacitor", "flutter", "generic"];

export interface BuildSummaryInput {
  rootPath: string;
  files: FileRecord[];
  source: string;
  truncated: boolean;
  gitError?: string;
}

/** Construye el resumen v2. Nunca lanza por un archivo del repositorio. */
export async function buildSummary(input: BuildSummaryInput): Promise<ProjectSummaryV2> {
  const files = [...input.files].sort((a, b) => byString(a.path, b.path));
  const warnings: ExtractionWarning[] = [];
  const inputs: Record<string, string | null> = {};
  const ctx = makeContext(input.rootPath, files, warnings, inputs);

  const ecosystems: EcosystemSummary[] = [];
  const run = async (name: string, fn: () => Promise<EcosystemSummary[]>) => {
    try {
      ecosystems.push(...(await fn()));
    } catch (e) {
      ctx.warn(".", `el extractor ${name} falló: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  };
  await run("node", () => extractNode(ctx));
  const node = ecosystems.filter((e) => e.kind === "node");
  await run("angular", () => extractAngular(ctx, node));
  await run("ionic", () => extractIonic(ctx, node));
  await run("capacitor", () => extractCapacitor(ctx, node));
  await run("flutter", () => extractFlutter(ctx));
  await run("generic", () => extractGeneric(ctx, ecosystems));
  ecosystems.sort((a, b) => byString(a.root, b.root) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byString(a.manifest ?? "", b.manifest ?? ""));

  const langs = count(files.filter((f) => f.kind === "source" || f.kind === "test"), "lang");
  const { modules, truncated: modulesTruncated } = modulesOf(ctx, ecosystems);
  return {
    schemaVersion: 2,
    files: files.length,
    byKind: count(files, "kind"),
    byLang: count(files, "lang"),
    source: input.source,
    truncated: input.truncated,
    ...(input.gitError ? { gitError: input.gitError } : {}),
    languages: Object.entries(langs)
      .map(([lang, n]) => ({ lang, files: n }))
      .sort((a, b) => b.files - a.files || byString(a.lang, b.lang)),
    ecosystems,
    modules,
    modulesTruncated,
    configFiles: files.filter((f) => f.kind === "config").map((f) => f.path).slice(0, MAX_CONFIG_FILES),
    tests: {
      files: files.filter((f) => f.kind === "test").length,
      frameworks: [...new Set(ecosystems.flatMap((e) => e.testFrameworks))].sort(byString),
      dirs: testDirsOf(files),
    },
    repoDocs: repoDocsOf(files, new Set(ecosystems.map((e) => e.root))),
    warnings: warnings.sort((a, b) => byString(a.path, b.path) || byString(a.message, b.message)).slice(0, MAX_WARNINGS),
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => byString(a, b))),
  };
}

/**
 * Lee un resumen de cualquier versión. Los snapshots v1 (T3) no se reescriben
 * (son inmutables): se completan aquí con valores vacíos.
 */
export function normalizeSummary(raw: Record<string, unknown>): ProjectSummaryV2 {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const rec = (v: unknown) => (isPlainObject(v) ? (v as Record<string, number>) : {});
  const base = {
    files: num(raw.files),
    byKind: rec(raw.byKind),
    byLang: rec(raw.byLang),
    source: typeof raw.source === "string" ? raw.source : "unknown",
    truncated: raw.truncated === true,
    ...(typeof raw.gitError === "string" ? { gitError: raw.gitError } : {}),
  };
  if (raw.schemaVersion === 2) return { ...(raw as unknown as ProjectSummaryV2), ...base, schemaVersion: 2 };
  return {
    schemaVersion: 2,
    ...base,
    languages: [],
    ecosystems: [],
    modules: [],
    modulesTruncated: false,
    configFiles: [],
    tests: { files: base.byKind.test ?? 0, frameworks: [], dirs: [] },
    repoDocs: [],
    warnings: [],
    inputs: {},
  };
}
