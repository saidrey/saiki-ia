import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { ContextStore, FileRecord, SnapshotRecord } from "./context-store.js";
import { computeIndexHash } from "./incremental-scan.js";
import { normalizeSummary } from "./project-summary.js";
import { redactSecrets } from "./redact.js";
import type { EcosystemSummary, ProjectSummaryV2 } from "./summary-shared.js";

/**
 * (Project Context, T7) Context Builder.
 *
 * Decide QUÉ debería saber un agente antes de empezar una HU: un texto acotado
 * con el stack, el conocimiento aprobado, las rutas relevantes y la
 * documentación del repositorio, más la traza de las fuentes usadas. No es un
 * agente: la selección es determinista (términos de la HU contra rutas del
 * índice), sin IA, embeddings ni contenido de archivos de código. Los agentes
 * leen el código con sus herramientas.
 *
 * Misma entrada (proyecto, snapshot e índice, HU, conocimiento, historial,
 * frescura) → mismo texto y mismo hash. La fecha de construcción va en la
 * traza, no en el texto.
 *
 * Cómo se congela por ejecución (execution_contexts) es T8.
 */

// ── Contrato ────────────────────────────────────────────────────────────────

/** Niveles de confianza (§12.1): el código los asigna según el origen, nunca según el contenido. */
export type ContextSourceKind = "index" | "knowledge" | "repo-doc" | "execution-history";

/** Conocimiento del proyecto aprobado por una persona (T10 lo proveerá desde la KB). */
export interface ApprovedKnowledge {
  docId: string;
  version: number;
  title: string;
  category: string;
  content: string;
  /** Si se indica, solo `approved` entra; lo propuesto nunca llega a los agentes. */
  status?: string;
}

/**
 * (§9.4, reservado) Resumen de una ejecución anterior de la misma sesión. Nadie
 * lo provee todavía; el builder ya sabe acotarlo y marcarlo.
 */
export interface ExecutionHistoryEntry {
  executionId: string;
  /** appliedHash o hash de la propuesta aprobada. */
  version: string;
  summary: string;
  files: string[];
}

export interface ContextLimits {
  maxChars: number;
  maxFiles: number;
  maxFullKnowledgeDocs: number;
  /** Fragmentos de documentación del repositorio. */
  maxRepoDocExcerpts: number;
  maxHistoryEntries: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxChars: 12_000,
  maxFiles: 25,
  maxFullKnowledgeDocs: 2,
  maxRepoDocExcerpts: 2,
  maxHistoryEntries: 3,
};

export interface BuildContextInput {
  project: { id: string; name: string; rootPath: string };
  /** null si el proyecto aún no tiene snapshot: solo entra el conocimiento aprobado. */
  snapshot: SnapshotRecord | null;
  /** Índice del snapshot (debe corresponder a su `indexHash`). */
  files: FileRecord[];
  hu: AnalyzedHu;
  knowledge?: ApprovedKnowledge[];
  history?: ExecutionHistoryEntry[];
  /** Frescura observada al construir (T5): null = al día. */
  stale: { reason: string; changedPaths: number | null } | null;
  limits?: Partial<ContextLimits>;
  /** Lectura de un documento del repositorio (pruebas); por defecto, del disco con verificación de hash. */
  readRepoDoc?: (path: string, expectedHash: string) => Promise<string | null>;
  /** Fecha de construcción (traza). */
  builtAt?: string;
}

export interface SelectedFile {
  path: string;
  kind: string;
  score: number;
  /** Términos de la HU que coinciden, o "prueba de <ruta>". */
  reasons: string[];
}

export type ContextSourceRef =
  | { kind: "index"; ref: string; version: string }
  | { kind: "knowledge"; ref: string; version: number; title: string; category: string; included: "full" | "title" }
  | { kind: "repo-doc"; ref: string; version: string; included: "excerpt" | "reference" }
  | { kind: "execution-history"; ref: string; version: string };

/** Todo lo que T8 necesita congelar por ejecución. */
export interface ContextTrace {
  projectId: string;
  snapshotId: string | null;
  indexHash: string | null;
  builtAt: string;
  stale: boolean;
  staleReason: string | null;
  sources: ContextSourceRef[];
  files: SelectedFile[];
  /** Términos de la HU usados para la selección. */
  terms: string[];
  /** Qué se recortó por los límites. */
  truncated: { files: boolean; knowledge: boolean; repoDocs: boolean; chars: boolean };
  limits: ContextLimits;
}

export interface ContextBundle {
  /** Texto exacto que recibirá el agente. */
  text: string;
  /** sha256 del texto. */
  hash: string;
  trace: ContextTrace;
}

export type BuildContextResult =
  | { ok: true; bundle: ContextBundle }
  | { ok: false; code: "project_mismatch" | "index_mismatch"; message: string };

// ── Términos ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "que para con los las del una uno unos unas por como cuando donde este esta estos estas ese esa eso " +
    "sus sin sobre entre desde hasta hacia tras pero mas muy todo toda todos todas cada otro otra otros otras " +
    "debe deben deberia puede pueden poder hay hace hacer sea ser estar esta tiene tener tambien solo ademas " +
    "nuevo nueva nuevos nuevas mismo misma cual cuales quien segun asi algo alguna alguno ningun ninguna " +
    "usuario usuaria usuarios quiero quieres necesito permitir permite mostrar muestra crear crea agregar " +
    "the and for with from into that this these those are was were will would should could can must not " +
    "all any each new add use using when then than have has had its our your their them they user users"
  ).split(" "),
);

/**
 * Equivalencias fijas español → inglés de vocabulario frecuente en código (las
 * HU suelen estar en español y las rutas en inglés). Lista cerrada: no infiere.
 */
const GLOSSARY_RAW: Record<string, string[]> = {
  filtro: ["filter"], filtrar: ["filter"], proyecto: ["project"], estado: ["status", "state"], historial: ["history"],
  escaneo: ["scan"], prueba: ["test", "spec"], servicio: ["service"], pago: ["payment"], cuenta: ["account"],
  pedido: ["order"], producto: ["product"], carrito: ["cart"], factura: ["invoice"], cliente: ["client", "customer"],
  archivo: ["file"], configuracion: ["config", "settings"], autenticacion: ["auth"], sesion: ["session"],
  mensaje: ["message"], notificacion: ["notification"], busqueda: ["search"], buscar: ["search"], reporte: ["report"],
  informe: ["report"], panel: ["dashboard"], tabla: ["table"], formulario: ["form"], boton: ["button"], pagina: ["page"],
  ruta: ["route"], apuesta: ["bet"], cuota: ["odd"], registro: ["register", "log"], aprobacion: ["approval"],
  ejecucion: ["execution"], conocimiento: ["knowledge"], evento: ["event"], agente: ["agent"], tarea: ["task"],
  propuesta: ["proposal"], revision: ["review"], idioma: ["language", "i18n"], fecha: ["date"], precio: ["price"],
  imagen: ["image"], correo: ["email", "mail"], contrasena: ["password"], perfil: ["profile"], grafico: ["chart"],
  lista: ["list"], detalle: ["detail"], usuario: ["user"], inicio: ["home"], menu: ["menu"], tema: ["theme"],
  reembolso: ["refund"], tarjeta: ["card"], descuento: ["discount"], envio: ["shipping"], carga: ["upload"],
  descarga: ["download"], permiso: ["permission"], rol: ["role"], plantilla: ["template"], traduccion: ["translation", "i18n"],
};

function stem(w: string): string {
  return w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

/** Palabras normalizadas: sin acentos, camelCase/kebab/snake separados, sin vacías. */
export function termsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
    .map(stem);
}

/** Peso de cada término: en cuántos campos de la HU aparece (1–3). */
function huTerms(hu: AnalyzedHu): Map<string, number> {
  const fields = [
    hu.summary,
    hu.need,
    hu.tasks.map((t) => t.description).join(" "),
    hu.acceptanceCriteria.map((c) => c.description).join(" "),
    hu.dependencies.join(" "),
  ];
  const weight = new Map<string, number>();
  for (const f of fields) for (const t of new Set(termsOf(f))) weight.set(t, Math.min(3, (weight.get(t) ?? 0) + 1));
  return new Map([...weight.entries()].sort(([a], [b]) => byString(a, b)));
}

let glossary: Map<string, string[]> | null = null;
function glossaryOf(term: string): string[] {
  glossary ??= new Map(Object.entries(GLOSSARY_RAW).map(([k, v]) => [stem(k), v.map(stem)]));
  return glossary.get(term) ?? [];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Términos de la HU más sus equivalencias en el vocabulario del índice: el
 * glosario (mismo peso) y palabras con un prefijo común de 6 letras o más
 * (calculadora ↔ calculator, contexto ↔ context; medio peso).
 */
function expandTerms(terms: Map<string, number>, vocabulary: Set<string>): Map<string, number> {
  const out = new Map(terms);
  const vocab = [...vocabulary].sort(byString);
  for (const [t, w] of terms) {
    for (const g of glossaryOf(t)) if (!out.has(g)) out.set(g, w);
    if (t.length < 6) continue;
    for (const v of vocab) if (v !== t && !out.has(v) && commonPrefix(v, t) >= 6) out.set(v, w * 0.5);
  }
  return new Map([...out.entries()].sort(([a], [b]) => byString(a, b)));
}

// ── Selección de archivos ────────────────────────────────────────────────────

const RELEVANT_KINDS = new Set(["source", "test", "config", "manifest"]);
const TEST_STEM = /^(?:test_)?(.+?)(?:[._-](?:spec|test|tests|e2e))?$/;

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Nombre sin extensión(es): `a.component.spec.ts` → `a.component.spec`. */
function stemOf(base: string): string {
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function testStem(base: string): string {
  return TEST_STEM.exec(stemOf(base))![1];
}

interface Candidate {
  file: FileRecord;
  base: Set<string>;
  dir: Set<string>;
  ext: string;
}

/** Vocabulario de las rutas del índice (para ampliar los términos de la HU). */
function pathVocabulary(files: FileRecord[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) for (const t of termsOf(f.path.replace(/\.[^./]+$/, ""))) out.add(t);
  return out;
}

function rankFiles(files: FileRecord[], terms: Map<string, number>, maxFiles: number): { selected: SelectedFile[]; truncated: boolean } {
  const candidates: Candidate[] = files
    .filter((f) => RELEVANT_KINDS.has(f.kind))
    .map((f) => {
      const base = baseOf(f.path);
      const dot = base.lastIndexOf(".");
      return {
        file: f,
        base: new Set(termsOf(stemOf(base))),
        dir: new Set(termsOf(dirOf(f.path) === "." ? "" : dirOf(f.path))),
        ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : "",
      };
    });

  // IDF: un término presente en muchas rutas (src, app, service…) discrimina poco.
  const n = candidates.length;
  const df = new Map<string, number>();
  for (const c of candidates) for (const t of new Set([...c.base, ...c.dir])) if (terms.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => {
    const d = df.get(t) ?? 0;
    if (d === 0) return 0;
    if (n >= 20 && d / n > 0.25) return 0; // demasiado común para orientar
    return Math.log(1 + n / d);
  };

  const scored: SelectedFile[] = [];
  for (const c of candidates) {
    let score = 0;
    let baseHits = 0;
    let dirHits = 0;
    const reasons: string[] = [];
    for (const [t, w] of terms) {
      const k = idf(t);
      if (k === 0) {
        if (c.ext === t) score += 0.5 * w;
        continue;
      }
      if (c.base.has(t)) {
        score += 3 * w * k;
        baseHits++;
        reasons.push(t);
      } else if (c.dir.has(t)) {
        score += w * k;
        dirHits++;
        reasons.push(t);
      } else if (c.ext === t) {
        score += 0.5 * w;
      }
    }
    // Umbral: el nombre del archivo coincide, o al menos dos directorios de su ruta.
    if (baseHits >= 1 || dirHits >= 2) scored.push({ path: c.file.path, kind: c.file.kind, score: round(score), reasons });
  }
  // A igual puntuación, el código antes que las pruebas (que se añaden emparejadas).
  scored.sort((a, b) => b.score - a.score || Number(a.kind === "test") - Number(b.kind === "test") || byString(a.path, b.path));

  // Pruebas emparejadas (x.ts ↔ x.spec.ts / x_test.dart / test_x.py) tras su archivo.
  const testsByStem = new Map<string, FileRecord[]>();
  for (const f of files) {
    if (f.kind !== "test") continue;
    const s = testStem(baseOf(f.path));
    testsByStem.set(s, [...(testsByStem.get(s) ?? []), f]);
  }
  const out: SelectedFile[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const s of scored) {
    if (seen.has(s.path)) continue;
    if (out.length >= maxFiles) {
      truncated = true;
      break;
    }
    out.push(s);
    seen.add(s.path);
    if (s.kind === "test") continue;
    const pairs = (testsByStem.get(stemOf(baseOf(s.path))) ?? [])
      .filter((t) => !seen.has(t.path) && (dirOf(t.path) === dirOf(s.path) || /(^|\/)(tests?|__tests__|spec|integration_test)(\/|$)/.test(dirOf(t.path))))
      .sort((a, b) => byString(a.path, b.path));
    for (const t of pairs) {
      if (out.length >= maxFiles) {
        truncated = true;
        break;
      }
      out.push({ path: t.path, kind: t.kind, score: s.score, reasons: [`prueba de ${s.path}`] });
      seen.add(t.path);
    }
  }
  return { selected: out, truncated: truncated || scored.some((s) => !seen.has(s.path)) };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

// ── Documentación del repositorio ────────────────────────────────────────────

const MAX_REPO_DOC_BYTES = 256 * 1024;
const MAX_EXCERPT_CHARS = 1500;
const MAX_REPO_DOC_REFS = 10;

/** Lee un documento indexado sin seguir enlaces y solo si su contenido es el del snapshot. */
function diskReader(rootPath: string, byPath: Map<string, FileRecord>) {
  return async (path: string, expectedHash: string): Promise<string | null> => {
    const f = byPath.get(path);
    if (!f || f.kind === "secret" || f.size > MAX_REPO_DOC_BYTES) return null;
    try {
      const fh = await open(join(rootPath, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buf = await fh.readFile();
        return createHash("sha256").update(buf).digest("hex") === expectedHash ? buf.toString("utf8") : null;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  };
}

interface DocMatch {
  path: string;
  hash: string;
  score: number;
  excerpt: string | null;
  heading: string | null;
}

/** Sección bajo el encabezado que más términos comparte, hasta el siguiente del mismo nivel o superior. */
function bestSection(text: string, terms: Map<string, number>): { heading: string | null; body: string; score: number } {
  const lines = text.split(/\r?\n/);
  let best = { index: -1, level: 0, score: 0 };
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+(.+)$/.exec(line);
    if (!m) return;
    const score = [...new Set(termsOf(m[2]))].reduce((s, t) => s + (terms.get(t) ?? 0), 0);
    // A igual puntuación, el encabezado más específico (nivel más profundo).
    if (score > best.score || (score > 0 && score === best.score && m[1].length > best.level)) best = { index: i, level: m[1].length, score };
  });
  if (best.index < 0) return { heading: null, body: text, score: 0 };
  let end = lines.length;
  inFence = false;
  for (let i = best.index + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= best.level) {
      end = i;
      break;
    }
  }
  return { heading: lines[best.index].trim(), body: lines.slice(best.index + 1, end).join("\n"), score: best.score };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > max * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}\n[…recortado]`;
}

async function matchRepoDocs(
  docs: Array<{ path: string; hash: string | null }>,
  terms: Map<string, number>,
  read: (path: string, hash: string) => Promise<string | null>,
): Promise<DocMatch[]> {
  const out: DocMatch[] = [];
  for (const d of [...docs].sort((a, b) => byString(a.path, b.path))) {
    if (d.hash === null) continue;
    const pathScore = [...new Set(termsOf(d.path.replace(/\.[^.]+$/, "")))].reduce((s, t) => s + (terms.get(t) ?? 0), 0);
    const text = await read(d.path, d.hash);
    if (text === null) {
      out.push({ path: d.path, hash: d.hash, score: pathScore, excerpt: null, heading: null });
      continue;
    }
    const section = bestSection(text, terms);
    const score = pathScore + section.score;
    const excerpt = section.score > 0 || pathScore > 0 ? clip(redactSecrets(section.body), MAX_EXCERPT_CHARS) : null;
    out.push({ path: d.path, hash: d.hash, score, excerpt: excerpt || null, heading: section.heading });
  }
  return out.sort((a, b) => b.score - a.score || byString(a.path, b.path));
}

// ── Composición con presupuesto ──────────────────────────────────────────────

/** Acumula bloques por prioridad sin pasar del máximo de caracteres. */
class Budget {
  private readonly parts: string[] = [];
  private used = 0;
  truncated = false;
  constructor(private readonly max: number) {}

  get remaining(): number {
    return this.max - this.used;
  }

  /** Añade el bloque si cabe entero; si no, nada. */
  add(block: string): boolean {
    const text = `${block}\n`;
    if (text.length > this.remaining) {
      this.truncated = true;
      return false;
    }
    this.parts.push(text);
    this.used += text.length;
    return true;
  }

  text(): string {
    return this.parts.join("").trimEnd() + "\n";
  }
}

/** Encabezados de sección del bundle (su origen y nivel de confianza). T8 los usa para el subconjunto del desarrollador. */
export const CONTEXT_SECTIONS = {
  stack: "### Stack [índice: generado del repositorio]",
  knowledge: "### Conocimiento aprobado [aprobado en Saiki por una persona]",
  files: "### Archivos relevantes [índice: generado del repositorio]",
  repoDocs: "### Documentación del repositorio [del repositorio, no aprobada en Saiki]",
  history: "### Ejecuciones anteriores de esta sesión [historial]",
} as const;

const CATEGORY_ORDER = ["conventions", "architecture", "decisions"];
const CATEGORY_LABEL: Record<string, string> = {
  conventions: "convenciones",
  architecture: "arquitectura",
  decisions: "decisiones",
  lessons: "aprendizajes",
  projects: "proyecto",
  research: "investigación",
};
const MAX_FULL_DOC_CHARS = 2500;
const KEY_SCRIPTS = /^(?:test|tests|build|lint|start|dev|serve|typecheck|e2e|check|format|analyze)(?::.*)?$/;
const KIND_LABEL: Record<string, string> = { source: "código", test: "prueba", config: "configuración", manifest: "manifiesto" };

function ecosystemLines(e: EcosystemSummary): string[] {
  const head = [e.kind, e.name ? `«${e.name}»` : null, e.manifest ? `(${e.manifest}${e.packageManager ? `, ${e.packageManager}` : ""})` : null]
    .filter(Boolean)
    .join(" ");
  const lines = [`- ${head}`];
  if (e.frameworks.length) lines.push(`  Frameworks: ${e.frameworks.map((f) => (f.version ? `${f.name} ${f.version}` : f.name)).join(", ")}`);
  if (e.testFrameworks.length) lines.push(`  Pruebas: ${e.testFrameworks.join(", ")}`);
  const scripts = e.scripts.filter((s) => KEY_SCRIPTS.test(s.name)).slice(0, 8);
  if (scripts.length) lines.push(`  Scripts: ${scripts.map((s) => `${s.name} → ${s.command.length > 100 ? `${s.command.slice(0, 100)}…` : s.command}`).join("; ")}`);
  if (e.entryPoints.length) lines.push(`  Entradas: ${e.entryPoints.slice(0, 5).map((p) => p.path).join(", ")}`);
  if (e.sourceRoots.length) lines.push(`  Código en: ${e.sourceRoots.slice(0, 5).join(", ")}`);
  return lines;
}

function relevantModules(summary: ProjectSummaryV2, terms: Map<string, number>): Array<{ path: string; files: number; tests: number }> {
  return summary.modules
    .map((m) => ({ m, score: [...new Set(termsOf(m.path))].reduce((s, t) => s + (terms.get(t) ?? 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byString(a.m.path, b.m.path))
    .slice(0, 5)
    .map((x) => x.m);
}

// ── Construcción ─────────────────────────────────────────────────────────────

export async function buildContext(input: BuildContextInput): Promise<BuildContextResult> {
  const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...input.limits };
  const { project, snapshot, hu } = input;
  if (snapshot && snapshot.projectId !== project.id) {
    return { ok: false, code: "project_mismatch", message: "El snapshot no pertenece a este proyecto." };
  }
  // Sin secretos ni binarios, y el índice debe ser exactamente el del snapshot.
  if (snapshot && computeIndexHash(input.files) !== snapshot.indexHash) {
    return { ok: false, code: "index_mismatch", message: "El índice recibido no corresponde al snapshot (hay un escaneo posterior)." };
  }
  const files = [...input.files].sort((a, b) => byString(a.path, b.path));
  const terms = huTerms(hu);
  const summary = snapshot ? normalizeSummary(snapshot.summary) : null;
  const budget = new Budget(limits.maxChars);
  const sources: ContextSourceRef[] = [];
  const truncated = { files: false, knowledge: false, repoDocs: false, chars: false };

  // 1. Cabecera (siempre).
  budget.add(
    [
      `## Contexto del proyecto «${project.name}»`,
      "Orientativo: verifica en el código antes de afirmar algo. Cada sección indica su origen y nivel de confianza.",
      snapshot ? `Snapshot ${snapshot.id}, ${summary!.files} archivos indexados${summary!.truncated ? " (índice truncado por tamaño)" : ""}.` : "El proyecto todavía no tiene snapshot: no hay índice técnico.",
      input.stale
        ? `ATENCIÓN: el contexto puede estar desactualizado (${input.stale.reason}${input.stale.changedPaths !== null ? `, ~${input.stale.changedPaths} rutas cambiadas` : ""}). Confirma en el repositorio.`
        : null,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );

  // 2. Stack (índice, siempre que haya snapshot).
  if (snapshot && summary) {
    sources.push({ kind: "index", ref: snapshot.id, version: snapshot.indexHash });
    const lines: string[] = [CONTEXT_SECTIONS.stack];
    if (summary.languages.length) lines.push(`Lenguajes: ${summary.languages.slice(0, 6).map((l) => `${l.lang} (${l.files})`).join(", ")}`);
    for (const e of summary.ecosystems.slice(0, 6)) lines.push(...ecosystemLines(e));
    if (summary.tests.frameworks.length) lines.push(`Pruebas del repositorio: ${summary.tests.files} archivos (${summary.tests.frameworks.join(", ")})`);
    budget.add(clip(redactSecrets(lines.join("\n")), 2500));
  }

  // 3. Conocimiento aprobado (convenciones primero; como mucho N completos, el resto por título).
  const approved = (input.knowledge ?? [])
    .filter((k) => k.status === undefined || k.status === "approved")
    .map((k) => ({
      k,
      score: [...new Set(termsOf(`${k.title} ${k.content}`))].reduce((s, t) => s + (terms.get(t) ?? 0), 0),
      rank: CATEGORY_ORDER.includes(k.category) ? CATEGORY_ORDER.indexOf(k.category) : CATEGORY_ORDER.length,
    }))
    // Convenciones siempre primero; el resto, por relevancia para la HU y después por categoría.
    .sort(
      (a, b) =>
        Number(a.k.category !== "conventions") - Number(b.k.category !== "conventions") ||
        b.score - a.score ||
        a.rank - b.rank ||
        byString(a.k.docId, b.k.docId),
    );
  if (approved.length) {
    budget.add(CONTEXT_SECTIONS.knowledge);
    let full = 0;
    const titles: typeof approved = [];
    for (const a of approved) {
      const { k } = a;
      const block = `#### ${k.title} (${CATEGORY_LABEL[k.category] ?? k.category}, versión ${k.version})\n${clip(redactSecrets(k.content), MAX_FULL_DOC_CHARS)}`;
      if (full < limits.maxFullKnowledgeDocs && budget.add(block)) {
        full++;
        sources.push({ kind: "knowledge", ref: k.docId, version: k.version, title: k.title, category: k.category, included: "full" });
      } else {
        titles.push(a);
      }
    }
    if (titles.length) {
      truncated.knowledge = true;
      const listed = titles.filter((a) =>
        budget.add(`- ${redactSecrets(a.k.title)} (${CATEGORY_LABEL[a.k.category] ?? a.k.category}, versión ${a.k.version}; solo el título)`),
      );
      for (const { k } of listed) sources.push({ kind: "knowledge", ref: k.docId, version: k.version, title: k.title, category: k.category, included: "title" });
    }
  }

  // 4. Rutas relevantes (índice). Términos ampliados con el vocabulario del índice.
  const selected: SelectedFile[] = [];
  if (snapshot && summary) {
    const expanded = expandTerms(terms, pathVocabulary(files));
    const ranked = rankFiles(files, expanded, limits.maxFiles);
    const header = `${CONTEXT_SECTIONS.files}\nCoincidencias de la HU con rutas del índice. No se incluye su contenido: léelos con tus herramientas.`;
    if (ranked.selected.length === 0) {
      const lines = [header, "No hay archivos con coincidencias claras con la HU. Puntos de partida:"];
      for (const e of summary.ecosystems) for (const p of e.entryPoints.slice(0, 3)) lines.push(`- ${p.path} (entrada de ${e.kind})`);
      for (const m of [...summary.modules].sort((a, b) => b.files - a.files || byString(a.path, b.path)).slice(0, 5)) lines.push(`- ${m.path}/ (módulo, ${m.files} archivos)`);
      budget.add(lines.join("\n"));
    } else if (budget.add(header)) {
      const modules = relevantModules(summary, expanded);
      if (modules.length) budget.add(`Módulos relacionados: ${modules.map((m) => `${m.path}/ (${m.files} archivos, ${m.tests} pruebas)`).join(", ")}`);
      for (const f of ranked.selected) {
        const why = f.reasons[0]?.startsWith("prueba de ") ? f.reasons[0] : `coincide: ${f.reasons.join(", ")}`;
        if (!budget.add(`- ${f.path} (${KIND_LABEL[f.kind] ?? f.kind}; ${why})`)) break;
        selected.push(f);
      }
    }
    truncated.files = ranked.truncated || selected.length < ranked.selected.length;
  }

  // 5. Documentación del repositorio (no aprobada).
  if (snapshot && summary && summary.repoDocs.length) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const read = input.readRepoDoc ?? diskReader(project.rootPath, byPath);
    const docs = await matchRepoDocs(summary.repoDocs.filter((d) => byPath.has(d.path)), terms, read);
    const header = CONTEXT_SECTIONS.repoDocs;
    if (budget.add(header)) {
      let excerpts = 0;
      const refs: DocMatch[] = [];
      for (const d of docs) {
        if (d.excerpt && d.score > 0 && excerpts < limits.maxRepoDocExcerpts) {
          const title = d.heading ? `#### ${d.path} — ${d.heading.replace(/^#+\s*/, "")}` : `#### ${d.path}`;
          if (budget.add(`${title}\n${d.excerpt}`)) {
            excerpts++;
            sources.push({ kind: "repo-doc", ref: d.path, version: d.hash, included: "excerpt" });
            continue;
          }
        }
        refs.push(d);
      }
      const shown = refs.slice(0, MAX_REPO_DOC_REFS);
      truncated.repoDocs = refs.length > shown.length;
      if (shown.length && budget.add(`Otros documentos: ${shown.map((d) => d.path).join(", ")}`)) {
        for (const d of shown) sources.push({ kind: "repo-doc", ref: d.path, version: d.hash, included: "reference" });
      }
    }
  }

  // 6. Historial de ejecuciones anteriores (reservado, §9.4).
  const history = (input.history ?? []).slice(0, limits.maxHistoryEntries);
  if (history.length && budget.add(CONTEXT_SECTIONS.history)) {
    for (const h of history) {
      const files = h.files.slice(0, 10).join(", ");
      const block = `- Historial de la ejecución ${h.executionId}: ${clip(redactSecrets(h.summary), 300)}${files ? ` (archivos: ${files})` : ""}`;
      if (budget.add(block)) sources.push({ kind: "execution-history", ref: h.executionId, version: h.version });
    }
  }

  truncated.chars = budget.truncated;
  const text = redactSecrets(budget.text());
  return {
    ok: true,
    bundle: {
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      trace: {
        projectId: project.id,
        snapshotId: snapshot?.id ?? null,
        indexHash: snapshot?.indexHash ?? null,
        builtAt: input.builtAt ?? new Date().toISOString(),
        stale: input.stale !== null,
        staleReason: input.stale?.reason ?? null,
        sources,
        files: selected,
        terms: [...terms.keys()],
        truncated,
        limits,
      },
    },
  };
}

/**
 * Índice del snapshot desde el ContextStore. El índice guardado es el del
 * último snapshot; para uno anterior ya no existe (`index_mismatch`): T8 debe
 * construir con el último o reutilizar el bundle congelado.
 */
export function loadSnapshotIndex(
  store: ContextStore,
  projectId: string,
  snapshotId?: string,
): { ok: true; snapshot: SnapshotRecord | null; files: FileRecord[] } | { ok: false; code: "snapshot_not_found" | "index_mismatch"; message: string } {
  const snapshot = snapshotId ? store.getSnapshot(projectId, snapshotId) : store.latestSnapshot(projectId);
  if (!snapshot) {
    if (snapshotId) return { ok: false, code: "snapshot_not_found", message: `Snapshot "${snapshotId}" no encontrado en este proyecto.` };
    return { ok: true, snapshot: null, files: [] };
  }
  const files = [...store.fileMap(projectId).values()];
  if (computeIndexHash(files) !== snapshot.indexHash) {
    return { ok: false, code: "index_mismatch", message: "El índice actual ya no es el de ese snapshot." };
  }
  return { ok: true, snapshot, files };
}
