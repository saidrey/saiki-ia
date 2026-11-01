import { SANDBOX_EXCLUDED } from "../projects/apply-guard.js";

/**
 * (Project Context, T1) Clasificación de archivos por su ruta.
 *
 * Pura y determinista: decide solo con el nombre y los directorios, nunca con
 * el contenido. Así un secreto se reconoce SIN abrirlo. La única lectura de
 * contenido del escáner (detectar binarios de extensión desconocida) ocurre
 * después y nunca sobre archivos clasificados como secreto.
 *
 * No acoplado a un stack: Node/Angular/Ionic y Flutter tienen reglas explícitas,
 * y el resto de ecosistemas caen en las reglas genéricas por extensión.
 */

export type FileKind = "source" | "test" | "config" | "manifest" | "doc" | "binary" | "secret" | "other";

export interface Classification {
  kind: FileKind;
  /** Lenguaje o formato (para el recuento de lenguajes); null si no aplica. */
  lang: string | null;
  /**
   * true si la extensión no permite decidir si es texto o binario: el escáner
   * mira los primeros bytes. Nunca es true para un secreto.
   */
  needsContentSniff: boolean;
}

/**
 * Directorios que no se recorren en ningún nivel: los del sandbox (dependencias,
 * builds, `.git`, `.saiki`) más cachés y herramientas locales.
 */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ...SANDBOX_EXCLUDED,
  ".saiki-context",
  "out",
  ".idea",
  ".vscode",
  ".cache",
  ".parcel-cache",
  ".svelte-kit",
  "www", // salida de build de Ionic
  "tmp",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  "target", // Rust/Maven
  ".expo",
  ".pub-cache",
  "DerivedData",
  ".build", // SwiftPM
]);

/** Archivos que no se indexan (ruido sin valor para el contexto). */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDED_FILE_EXT: ReadonlySet<string> = new Set([".log"]);

// ── Secretos: solo por nombre ────────────────────────────────────────────────
const SECRET_NAMES: ReadonlySet<string> = new Set([
  ".npmrc", // puede llevar _authToken; no se abre para comprobarlo
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  "google-services.json",
  "googleservice-info.plist",
  "terraform.tfstate",
]);
const SECRET_EXT: ReadonlySet<string> = new Set([
  ".pem", ".key", ".p12", ".pfx", ".p8", ".ppk", ".keystore", ".jks", ".mobileprovision", ".tfvars", ".tfstate",
]);
const SECRET_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

// ── Binarios por extensión ───────────────────────────────────────────────────
const BINARY_EXT: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp", ".tif", ".tiff", ".psd", ".heic", ".avif",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".jar", ".war", ".aar", ".apk", ".aab", ".ipa", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".class",
  ".wasm", ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".flac", ".m4a", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".sqlite", ".sqlite3", ".db", ".pyc", ".dex", ".keychain",
]);

// ── Lenguajes de código fuente ───────────────────────────────────────────────
const SOURCE_LANG: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".dart": "dart",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".sass": "scss", ".less": "less",
  ".vue": "vue", ".svelte": "svelte",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".swift": "swift", ".m": "objective-c", ".mm": "objective-c",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".rb": "ruby", ".php": "php", ".sql": "sql",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
};

/** Formatos de texto que no son código (lang para el recuento; kind por nombre). */
const DATA_LANG: Readonly<Record<string, string>> = {
  ".json": "json", ".jsonc": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".xml": "xml", ".plist": "xml", ".ini": "ini", ".properties": "properties", ".gradle": "gradle",
  ".svg": "svg", ".csv": "csv", ".arb": "json",
};

const DOC_EXT: Readonly<Record<string, string>> = {
  ".md": "markdown", ".mdx": "markdown", ".rst": "rst", ".adoc": "asciidoc", ".txt": "text",
};
const DOC_PREFIXES = ["readme", "changelog", "license", "licence", "contributing", "authors", "notice"];

// ── Manifiestos (gestores de paquetes) ───────────────────────────────────────
const MANIFESTS: ReadonlySet<string> = new Set([
  // Node / Angular / Ionic
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "bun.lockb",
  // Flutter / Dart
  "pubspec.yaml", "pubspec.lock",
  // Genéricos
  "requirements.txt", "pyproject.toml", "pipfile", "pipfile.lock", "poetry.lock", "go.mod", "go.sum",
  "cargo.toml", "cargo.lock", "pom.xml", "gemfile", "gemfile.lock", "composer.json", "composer.lock",
  "podfile.lock", "package.resolved",
]);

// ── Configuración (compilación, herramientas, plataforma) ────────────────────
const CONFIG_NAMES: ReadonlySet<string> = new Set([
  "angular.json", "ionic.config.json", "nx.json", "project.json", "workspace.json", ".browserslistrc", "browserslist",
  "karma.conf.js", ".babelrc", ".editorconfig", ".gitignore", ".gitattributes", ".nvmrc", ".node-version",
  ".prettierrc", ".prettierignore", ".eslintignore", ".npmignore", "makefile", "dockerfile", ".dockerignore",
  "analysis_options.yaml", "l10n.yaml", "build.yaml", ".metadata", "podfile", "androidmanifest.xml", "info.plist",
  "gradle.properties", "settings.gradle", "build.gradle", "settings.gradle.kts", "build.gradle.kts", "procfile",
]);
const CONFIG_PREFIXES = ["tsconfig", "jsconfig", ".eslintrc", ".prettierrc", ".stylelintrc", "docker-compose", "capacitor.config"];
/** `*.config.{js,ts,mjs,cjs,json}` (vite, vitest, jest, webpack, tailwind…). */
const CONFIG_SUFFIX = /\.config\.(?:[cm]?[jt]s|json)$/;

// ── Pruebas ──────────────────────────────────────────────────────────────────
const TEST_DIRS: ReadonlySet<string> = new Set(["test", "tests", "__tests__", "spec", "specs", "integration_test", "e2e", "cypress", "playwright"]);
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:_test\.(?:dart|go|py)$)|(?:^test_.*\.py$)|(?:Tests?\.(?:java|kt|swift|cs)$)/;

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}

/** ¿Debe saltarse la ruta por un directorio excluido o por ser ruido? */
export function exclusionOf(relPath: string): "excluded_dir" | "excluded_file" | null {
  const segments = relPath.split("/");
  const name = segments[segments.length - 1];
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i])) return "excluded_dir";
  }
  if (EXCLUDED_FILES.has(name) || EXCLUDED_FILE_EXT.has(extOf(name))) return "excluded_file";
  return null;
}

/** ¿Es un secreto? Solo por nombre: nunca se abre el archivo para decidirlo. */
export function isSecretPath(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (SECRET_NAMES.has(lower) || SECRET_EXT.has(extOf(lower))) return true;
  if (SECRET_PREFIXES.some((p) => lower.startsWith(p))) return true;
  // `credentials.json`, `secrets.yaml`… (no `secretsManager.ts`: exige el punto).
  return /^(?:credentials|secrets?)(?:\.|$)/.test(lower);
}

/** Clasifica una ruta relativa POSIX (ya filtrada por `exclusionOf`). */
export function classifyPath(relPath: string): Classification {
  if (isSecretPath(relPath)) return { kind: "secret", lang: null, needsContentSniff: false };

  const segments = relPath.split("/");
  const name = segments[segments.length - 1];
  const lower = name.toLowerCase();
  const ext = extOf(lower);

  if (BINARY_EXT.has(ext)) return { kind: "binary", lang: null, needsContentSniff: false };
  if (MANIFESTS.has(lower)) return { kind: "manifest", lang: DATA_LANG[ext] ?? null, needsContentSniff: false };

  const isConfig =
    CONFIG_NAMES.has(lower) || CONFIG_PREFIXES.some((p) => lower.startsWith(p)) || CONFIG_SUFFIX.test(lower);
  if (isConfig) return { kind: "config", lang: SOURCE_LANG[ext] ?? DATA_LANG[ext] ?? null, needsContentSniff: false };

  if (DOC_EXT[ext] || (ext === "" && DOC_PREFIXES.some((p) => lower.startsWith(p)))) {
    return { kind: "doc", lang: DOC_EXT[ext] ?? "text", needsContentSniff: false };
  }

  const lang = SOURCE_LANG[ext];
  if (lang) {
    const inTestDir = segments.slice(0, -1).some((s) => TEST_DIRS.has(s));
    return { kind: inTestDir || TEST_FILE.test(name) ? "test" : "source", lang, needsContentSniff: false };
  }

  if (DATA_LANG[ext]) return { kind: "other", lang: DATA_LANG[ext], needsContentSniff: false };
  return { kind: "other", lang: null, needsContentSniff: true };
}
