import { redactSecrets } from "./redact.js";
import {
  baseOf,
  byString,
  dirOf,
  emptyEcosystem,
  isPlainObject,
  parseJsonObject,
  uniqueEntryPoints,
  MAX_DEPENDENCIES,
  type DependencyInfo,
  type EcosystemSummary,
  type ExtractContext,
} from "./summary-shared.js";

/**
 * (Project Context, T4) Extractor genérico: manifiestos que no cubren los
 * extractores específicos (Python, Go, Rust, Java, Ruby, PHP…) y, si el
 * repositorio no tiene ningún ecosistema reconocido, un resumen por convención.
 *
 * Lee dependencias solo de formatos triviales (requirements.txt, go.mod,
 * composer.json); del resto registra el manifiesto y su ecosistema.
 */

const ECOSYSTEM_OF: Readonly<Record<string, string>> = {
  "requirements.txt": "python",
  "pyproject.toml": "python",
  pipfile: "python",
  "go.mod": "go",
  "cargo.toml": "rust",
  "pom.xml": "java-maven",
  gemfile: "ruby",
  "composer.json": "php",
};
/** Lockfiles y manifiestos que ya leen otros extractores o que no aportan aquí. */
const HANDLED = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lockb",
  "pubspec.yaml", "pubspec.lock", "pipfile.lock", "poetry.lock", "go.sum", "cargo.lock", "gemfile.lock", "composer.lock",
  "podfile.lock", "package.resolved",
]);
const CONVENTIONAL_ENTRY = /^(?:(?:src|app|cmd\/[^/]+)\/)?(?:main|index|app|server|manage)\.[a-z]+$/;

function requirements(text: string): DependencyInfo[] {
  const out: DependencyInfo[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (m) out.push({ name: m[1], spec: redactSecrets(m[3].trim() || "any"), dev: false, resolved: null });
  }
  return out;
}

function goMod(text: string): { module: string | null; go: string | null; deps: DependencyInfo[] } {
  let module: string | null = null;
  let go: string | null = null;
  const deps: DependencyInfo[] = [];
  let inRequire = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.startsWith("module ")) module = line.slice(7).trim();
    else if (line.startsWith("go ")) go = line.slice(3).trim();
    else if (line === "require (") inRequire = true;
    else if (inRequire && line === ")") inRequire = false;
    else {
      const m = /^(?:require\s+)?(\S+)\s+(v\S+)/.exec(inRequire || line.startsWith("require ") ? line : "");
      if (m) deps.push({ name: m[1], spec: m[2], dev: false, resolved: m[2] });
    }
  }
  return { module, go, deps };
}

export async function extractGeneric(ctx: ExtractContext, found: EcosystemSummary[]): Promise<EcosystemSummary[]> {
  const out: EcosystemSummary[] = [];
  for (const f of ctx.files) {
    const base = baseOf(f.path).toLowerCase();
    if (f.kind !== "manifest" || HANDLED.has(base)) continue;
    const eco = emptyEcosystem("generic", f.path, dirOf(f.path));
    const ecosystem = ECOSYSTEM_OF[base] ?? "unknown";
    let deps: DependencyInfo[] = [];
    const details: Record<string, unknown> = { ecosystem };

    if (base === "requirements.txt" || base === "go.mod" || base === "composer.json") {
      const text = await ctx.read(f.path);
      if (text !== null) {
        if (base === "requirements.txt") {
          deps = requirements(text);
        } else if (base === "go.mod") {
          const g = goMod(text);
          eco.name = g.module;
          details.goVersion = g.go;
          deps = g.deps;
        } else {
          const c = parseJsonObject(ctx, f.path, text);
          if (c) {
            eco.name = typeof c.name === "string" ? c.name : null;
            for (const [field, dev] of [["require", false], ["require-dev", true]] as const) {
              if (!isPlainObject(c[field])) continue;
              for (const [name, spec] of Object.entries(c[field] as Record<string, unknown>)) {
                if (typeof spec === "string") deps.push({ name, spec: redactSecrets(spec), dev, resolved: null });
              }
            }
          }
        }
      }
    } else {
      details.note = "manifiesto reconocido sin lector de dependencias";
    }
    deps.sort((a, b) => byString(a.name, b.name));
    eco.dependencies = deps.slice(0, MAX_DEPENDENCIES);
    eco.dependenciesTruncated = deps.length > MAX_DEPENDENCIES;
    eco.details = details;
    out.push(eco);
  }

  // Ningún ecosistema reconocido: resumen por convención (lenguaje y entradas típicas).
  if (found.length === 0 && out.length === 0) {
    const eco = emptyEcosystem("generic", null, ".");
    eco.entryPoints = uniqueEntryPoints(
      ctx.files.filter((f) => f.kind === "source" && CONVENTIONAL_ENTRY.test(f.path)).map((f) => ({ path: f.path, source: "convention" })),
    );
    eco.sourceRoots = ["src", "lib", "app"].filter((d) => ctx.hasDir(d));
    eco.details = { ecosystem: "unknown", note: "sin manifiesto reconocido" };
    if (ctx.files.some((f) => f.kind === "source")) out.push(eco);
  }
  return out;
}
