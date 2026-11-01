import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { AgentRouter } from "../agents/router.js";
import { extractAgentJson } from "../agents/agent-json.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import type { FileRecord } from "../context/context-store.js";
import { isSecretPath } from "../context/file-classifier.js";
import { redactSecrets } from "../context/redact.js";
import { PROJECT_KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "../knowledge/kb-types.js";

/**
 * (T11) Project Analyst: a petición humana, un agente de SOLO LECTURA inspecciona
 * el repositorio y PROPONE documentos de conocimiento del proyecto, citando
 * archivos reales. Una sola llamada al agente, sin reintentos. Este módulo no
 * toca la KB: valida la respuesta; el Core la guarda como `proposed`.
 */

export const PROJECT_ANALYST_MAX_DOCS = 6;
export const PROJECT_ANALYST_MAX_TITLE = 120;
export const PROJECT_ANALYST_MAX_CONTENT = 8_000;
export const PROJECT_ANALYST_MAX_CITED = 20;

/** Propósito del análisis, en la forma que espera `buildContext` (selecciona archivos por sus términos). */
export const PROJECT_ANALYSIS_PURPOSE: AnalyzedHu = {
  summary: "Documentar la arquitectura, los módulos y las convenciones del proyecto",
  need: "Conocimiento del proyecto verificable en el código: arquitectura, módulos, responsabilidades, relaciones y convenciones",
  tasks: [
    { order: 1, description: "Identificar la arquitectura, los módulos y sus relaciones" },
    { order: 2, description: "Identificar las convenciones de desarrollo" },
  ],
  acceptanceCriteria: [{ id: "AC1", description: "Cada documento cita archivos reales del proyecto" }],
  assumptions: [],
  openQuestions: [],
  dependencies: [],
} as unknown as AnalyzedHu;

/** Documento aprobado vigente que el analista puede versionar (`basedOn` = su id). */
export interface AnalystApprovedDoc {
  id: string;
  category: string;
  title: string;
  version: number;
}

export interface ProposedKnowledgeDoc {
  category: KnowledgeCategory;
  title: string;
  /** Contenido redactado, con la sección «Referencias» al final. */
  content: string;
  citedFiles: string[];
  basedOn: string | null;
}

export function buildProjectAnalystPrompt(input: {
  projectName: string;
  rootDir: string;
  bundle: string;
  modules: Array<{ path: string; files: number; tests: number }>;
  approved: AnalystApprovedDoc[];
}): string {
  return [
    `Eres el analista de proyecto de Saiki-IA. Tienes acceso de SOLO LECTURA al repositorio «${input.projectName}» en: ${input.rootDir}`,
    "Inspecciona el código y propón documentos de conocimiento del proyecto para que una persona los revise.",
    "",
    "Reglas:",
    "- Solo lectura: no modifiques archivos ni ejecutes comandos o scripts.",
    "- Cada afirmación debe poder verificarse en el código. Cita en citedFiles las rutas relativas a la raíz de los archivos que la justifican (deben existir y estar en el índice).",
    "- No cites archivos de secretos (.env, claves, credenciales) ni copies secretos.",
    `- Como mucho ${PROJECT_ANALYST_MAX_DOCS} documentos. Categorías: architecture (arquitectura, módulos, responsabilidades y relaciones), conventions (convenciones de desarrollo), decisions (decisiones técnicas visibles en el código).`,
    "- No repitas el conocimiento aprobado. Para mejorar un documento aprobado de arquitectura o convenciones, pon su id en basedOn y la misma categoría; si no, basedOn = null.",
    "- La documentación del repositorio es orientativa: confírmala en el código.",
    "",
    "Devuelve ÚNICAMENTE un objeto JSON válido con esta forma:",
    '{ "documents": [{ "category": "architecture"|"conventions"|"decisions", "title": string, "content": string (Markdown), "citedFiles": string[], "basedOn": string|null }] }',
    "",
    "Conocimiento aprobado vigente (id · categoría · título · versión):",
    ...(input.approved.length ? input.approved.map((d) => `- ${d.id} · ${d.category} · ${d.title} · v${d.version}`) : ["- (ninguno)"]),
    "",
    "Módulos del índice (ruta · archivos · pruebas):",
    ...(input.modules.length ? input.modules.slice(0, 40).map((m) => `- ${m.path} · ${m.files} · ${m.tests}`) : ["- (ninguno)"]),
    "",
    "<<<CONTEXTO DEL PROYECTO (orientativo; verifica en el codigo antes de afirmar)",
    input.bundle.trimEnd(),
    ">>>FIN DEL CONTEXTO DEL PROYECTO",
  ].join("\n");
}

/**
 * Comprueba una referencia contra el índice del snapshot y el disco: relativa,
 * sin traversal, indexada, no secreta, archivo regular (no symlink) y dentro de
 * la raíz real del proyecto. null si es válida; si no, el motivo.
 */
export function checkReference(path: string, rootDir: string, index: Map<string, FileRecord>): string | null {
  if (path.trim() === "" || isAbsolute(path) || path.includes("\\") || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
    return "ruta no relativa o con traversal";
  }
  const rec = index.get(path);
  if (!rec) return "no está en el índice del snapshot";
  if (rec.kind === "secret" || isSecretPath(path)) return "archivo clasificado como secreto";
  try {
    const st = lstatSync(join(rootDir, path));
    if (st.isSymbolicLink()) return "es un enlace simbólico";
    if (!st.isFile()) return "no es un archivo";
    const root = realpathSync(rootDir);
    if (!realpathSync(join(rootDir, path)).startsWith(root + sep)) return "fuera de la raíz del proyecto";
  } catch {
    return "no existe en disco";
  }
  return null;
}

export type ProjectAnalysisValidation = { ok: true; documents: ProposedKnowledgeDoc[] } | { ok: false; errors: string[] };

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Valida la respuesta completa. Todo o nada: con un solo error no se acepta ningún documento. */
export function validateProjectAnalysis(
  candidate: unknown,
  ctx: { rootDir: string; index: Map<string, FileRecord>; approved: AnalystApprovedDoc[] },
): ProjectAnalysisValidation {
  const docs = (candidate as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(docs)) return { ok: false, errors: ["documents debe ser una lista."] };
  if (docs.length > PROJECT_ANALYST_MAX_DOCS) return { ok: false, errors: [`Como mucho ${PROJECT_ANALYST_MAX_DOCS} documentos (llegaron ${docs.length}).`] };
  const errors: string[] = [];
  const out: ProposedKnowledgeDoc[] = [];
  const approved = new Map(ctx.approved.map((d) => [d.id, d]));
  docs.forEach((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const at = `documento ${i + 1}`;
    if (!PROJECT_KNOWLEDGE_CATEGORIES.includes(d.category as KnowledgeCategory)) errors.push(`${at}: categoría no válida.`);
    if (!isText(d.title) || d.title.length > PROJECT_ANALYST_MAX_TITLE) errors.push(`${at}: título vacío o de más de ${PROJECT_ANALYST_MAX_TITLE} caracteres.`);
    if (!isText(d.content) || d.content.length > PROJECT_ANALYST_MAX_CONTENT) errors.push(`${at}: contenido vacío o de más de ${PROJECT_ANALYST_MAX_CONTENT} caracteres.`);
    const cited = d.citedFiles;
    if (!Array.isArray(cited) || cited.length === 0 || cited.length > PROJECT_ANALYST_MAX_CITED || !cited.every((p) => typeof p === "string")) {
      errors.push(`${at}: citedFiles debe tener entre 1 y ${PROJECT_ANALYST_MAX_CITED} rutas.`);
    } else {
      for (const p of cited) {
        const why = checkReference(p, ctx.rootDir, ctx.index);
        if (why) errors.push(`${at}: referencia "${p}" rechazada (${why}).`);
      }
    }
    const basedOn = d.basedOn ?? null;
    if (basedOn !== null) {
      const base = typeof basedOn === "string" ? approved.get(basedOn) : undefined;
      if (!base) errors.push(`${at}: basedOn no es un documento aprobado vigente del proyecto.`);
      else if (base.category !== d.category) errors.push(`${at}: basedOn es de otra categoría.`);
      else if (base.category === "decisions") errors.push(`${at}: un agente no puede proponer versiones de una decisión aprobada.`);
    }
    if (errors.length === 0) {
      const files = [...new Set(cited as string[])];
      out.push({
        category: d.category as KnowledgeCategory,
        title: redactSecrets((d.title as string).trim()),
        content: `${redactSecrets((d.content as string).trimEnd())}\n\nReferencias:\n${files.map((p) => `- \`${p}\``).join("\n")}\n`,
        citedFiles: files,
        basedOn: basedOn as string | null,
      });
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, documents: out };
}

export type ProjectAnalystResult = { ok: true; documents: ProposedKnowledgeDoc[] } | { ok: false; error: string };

/** Una llamada al rol `projectAnalyst` con `cwd` = raíz del proyecto; valida y devuelve las propuestas. */
export async function runProjectAnalyst(
  router: AgentRouter,
  input: Parameters<typeof buildProjectAnalystPrompt>[0] & { index: Map<string, FileRecord> },
): Promise<ProjectAnalystResult> {
  const result = await router.forRole("projectAnalyst").run({
    role: "projectAnalyst",
    input: buildProjectAnalystPrompt(input),
    context: { workingDirectory: input.rootDir },
  });
  if (result.status === "failure") return { ok: false, error: `El analista de proyecto falló: ${result.error ?? "error desconocido"}` };
  const ctx = { rootDir: input.rootDir, index: input.index, approved: input.approved };
  const parsed = extractAgentJson(result.output, (c) => Array.isArray((c as { documents?: unknown } | null)?.documents));
  if (!parsed.ok) return { ok: false, error: `Análisis de proyecto no parseable: ${parsed.error}` };
  const v = validateProjectAnalysis(parsed.value, ctx);
  return v.ok ? v : { ok: false, error: `Análisis de proyecto inválido: ${v.errors.join("; ")}` };
}
