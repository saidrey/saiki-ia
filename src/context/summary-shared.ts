import { posix } from "node:path";
import type { FileRecord } from "./context-store.js";

/**
 * (Project Context, T4) Tipos, límites y utilidades compartidas por el
 * resumen técnico y sus extractores (archivo aparte para evitar ciclos).
 */

export interface DependencyInfo {
  name: string;
  /** Especificación declarada (rango, sdk:, path, git), ya redactada. */
  spec: string;
  dev: boolean;
  /** Versión resuelta en el lockfile, si existe. */
  resolved: string | null;
}

export interface FrameworkInfo {
  name: string;
  /** Resuelta si hay lockfile; si no, la especificación declarada. */
  version: string | null;
  /** Archivo del que sale la versión. */
  source: string;
}

export interface EntryPoint {
  path: string;
  /** main, module, bin, exports, script:<nombre>, angular:<proyecto>, convention… */
  source: string;
}

export type EcosystemKind = "node" | "angular" | "ionic" | "capacitor" | "flutter" | "generic";

export interface EcosystemSummary {
  kind: EcosystemKind;
  /** Archivo principal (relativo a la raíz); null en el genérico sin manifiesto. */
  manifest: string | null;
  /** Directorio del manifiesto ("." es la raíz del repositorio). */
  root: string;
  name: string | null;
  version: string | null;
  packageManager: string | null;
  frameworks: FrameworkInfo[];
  dependencies: DependencyInfo[];
  dependenciesTruncated: boolean;
  scripts: Array<{ name: string; command: string }>;
  entryPoints: EntryPoint[];
  sourceRoots: string[];
  testFrameworks: string[];
  tools: string[];
  configFiles: string[];
  details: Record<string, unknown>;
}

export interface ExtractionWarning {
  path: string;
  message: string;
}

export interface ModuleSummary {
  path: string;
  files: number;
  tests: number;
}

export interface ProjectSummaryV2 {
  schemaVersion: 2;
  // ── Campos de la versión 1 (T3) ──
  files: number;
  byKind: Record<string, number>;
  byLang: Record<string, number>;
  source: string;
  truncated: boolean;
  gitError?: string;
  // ── Versión 2 (T4) ──
  languages: Array<{ lang: string; files: number }>;
  ecosystems: EcosystemSummary[];
  modules: ModuleSummary[];
  modulesTruncated: boolean;
  configFiles: string[];
  tests: { files: number; frameworks: string[]; dirs: string[] };
  repoDocs: Array<{ path: string; hash: string | null }>;
  warnings: ExtractionWarning[];
  /** Archivos que alimentaron los extractores, con su hash (trazabilidad). */
  inputs: Record<string, string | null>;
}

/** Contexto que reciben los extractores. */
export interface ExtractContext {
  files: FileRecord[];
  byPath: ReadonlyMap<string, FileRecord>;
  /** Lee un archivo del índice como texto; null (y aviso) si no se puede o no se debe. */
  read(path: string, maxBytes?: number): Promise<string | null>;
  warn(path: string, message: string): void;
  /** ¿Hay algún archivo indexado bajo `dir/`? */
  hasDir(dir: string): boolean;
}

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;
export const MAX_DEPENDENCIES = 1000;
export const MAX_SCRIPTS = 100;
export const MAX_SCRIPT_CHARS = 300;

// ── Utilidades compartidas por los extractores ───────────────────────────────

export const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Une un directorio del repositorio ("." = raíz) con una ruta relativa, en POSIX normalizado. */
export function joinRel(dir: string, rel: string): string {
  const j = posix.normalize(dir === "." ? rel : `${dir}/${rel}`).replace(/^\.\//, "");
  return j.replace(/\/$/, "");
}
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Parsea JSON; null con aviso si no es un objeto válido. */
export function parseJsonObject(ctx: ExtractContext, path: string, text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    if (isPlainObject(v)) return v;
    ctx.warn(path, "no es un objeto JSON");
  } catch (e) {
    ctx.warn(path, `JSON inválido: ${e instanceof Error ? e.message.slice(0, 120) : "error de lectura"}`);
  }
  return null;
}
export function emptyEcosystem(kind: EcosystemKind, manifest: string | null, root: string): EcosystemSummary {
  return {
    kind,
    manifest,
    root,
    name: null,
    version: null,
    packageManager: null,
    frameworks: [],
    dependencies: [],
    dependenciesTruncated: false,
    scripts: [],
    entryPoints: [],
    sourceRoots: [],
    testFrameworks: [],
    tools: [],
    configFiles: [],
    details: {},
  };
}
export function uniqueEntryPoints(list: EntryPoint[]): EntryPoint[] {
  const seen = new Map<string, EntryPoint>();
  for (const e of list) if (!seen.has(e.path)) seen.set(e.path, e);
  return [...seen.values()].sort((a, b) => byString(a.path, b.path));
}
