import { describe, it, expect, afterEach } from "vitest";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempRepos } from "../projects/test-repos.js";
import { readFingerprint } from "../projects/project-fs.js";
import type { AnalyzedHu } from "../hu/hu-schema.js";
import { ContextStore, type FileRecord, type SnapshotRecord } from "./context-store.js";
import { computeIndexHash, runScan } from "./incremental-scan.js";
import { buildContext, loadSnapshotIndex, termsOf, type ApprovedKnowledge, type BuildContextInput, type ContextBundle } from "./context-builder.js";

/** (Project Context, T7) Context Builder: selección determinista, límites, confianza y trazabilidad. */

let repos: TempRepos | undefined;
let store: ContextStore | undefined;
afterEach(() => {
  store?.close();
  repos?.cleanup();
  store = undefined;
  repos = undefined;
});

function hu(summary: string, need = "", tasks: string[] = [], criteria: string[] = []): AnalyzedHu {
  return {
    summary,
    need,
    tasks: tasks.map((description, i) => ({ order: i + 1, description })),
    acceptanceCriteria: criteria.map((description, i) => ({ id: `AC${i + 1}`, description })),
    assumptions: [],
    openQuestions: [],
    dependencies: [],
  };
}

/** Repositorio real escaneado: proyecto, snapshot e índice listos para el builder. */
async function scanned(name: string, files: Record<string, string>, projectId = `prj-${name}`) {
  repos ??= new TempRepos();
  store ??= new ContextStore(":memory:");
  const root = realpathSync(repos.repo(name, files));
  const r = await runScan(store!, { projectId, rootPath: root, fingerprint: readFingerprint(root)!, mode: "full", trigger: "manual" });
  if (!r.ok) throw new Error(r.message);
  const idx = loadSnapshotIndex(store!, projectId);
  if (!idx.ok) throw new Error(idx.message);
  return { project: { id: projectId, name, rootPath: root }, snapshot: idx.snapshot!, files: idx.files };
}

async function build(input: Omit<BuildContextInput, "stale"> & { stale?: BuildContextInput["stale"] }): Promise<ContextBundle> {
  const r = await buildContext({ stale: null, ...input });
  if (!r.ok) throw new Error(r.message);
  return r.bundle;
}

const APP = {
  "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest run", build: "tsc && firebase deploy --token 1//abcSECRET" }, devDependencies: { vitest: "^1.0.0" } }),
  "src/main.ts": "export {};\n",
  "src/payments/payment.service.ts": "export {};\n",
  "src/payments/payment.service.spec.ts": "test\n",
  "src/payments/refund.ts": "export {};\n",
  "src/users/user.repository.ts": "export {};\n",
  "src/orders/order.controller.ts": "export {};\n",
  "src/orders/order.controller.spec.ts": "test\n",
  ".env": "STRIPE_KEY=sk_live_x\n",
  "credentials-payment.json": "{}",
  "README.md": "# Shop\n\nIntro general.\n\n## Pagos y reembolsos\n\nLos reembolsos pasan por `payment.service`.\n\n## Usuarios\n\nAlta de usuarios.\n",
};

describe("selección por la HU", () => {
  it("HU de un módulo concreto: sus archivos primero, con la prueba emparejada y el motivo", async () => {
    const c = await scanned("shop", APP);
    const b = await build({ ...c, hu: hu("Permitir reembolsos parciales de pagos", "El servicio de pagos debe aceptar un reembolso parcial") });
    const paths = b.trace.files.map((f) => f.path);
    expect(paths.slice(0, 3)).toEqual(["src/payments/refund.ts", "src/payments/payment.service.ts", "src/payments/payment.service.spec.ts"]);
    expect(b.trace.files[0].reasons).toEqual(["payment", "refund"]); // pagos ↔ payment, reembolso ↔ refund (glosario)
    expect(b.trace.files[2].reasons).toEqual(["prueba de src/payments/payment.service.ts"]);
    expect(paths).not.toContain("src/users/user.repository.ts");
    expect(b.text).toContain("- src/payments/payment.service.ts (código; coincide: payment");
    expect(b.text).toContain("Módulos relacionados: src/payments/");
    // Ningún secreto aparece aunque su nombre coincida con la HU.
    expect(b.text).not.toMatch(/\.env|credentials-payment/);
  });

  it("HU sin coincidencias claras: ningún archivo elegido; se dan puntos de partida", async () => {
    const c = await scanned("shop", APP);
    const b = await build({ ...c, hu: hu("Mejorar la accesibilidad del contraste de colores") });
    expect(b.trace.files).toEqual([]);
    expect(b.text).toContain("No hay archivos con coincidencias claras con la HU. Puntos de partida:");
    expect(b.text).toContain("- src/main.ts (entrada de node)");
  });

  it("términos: sin acentos, camelCase/kebab/snake separados, plurales y palabras vacías fuera", () => {
    expect(termsOf("Añadir validación al PaymentService y a user-profile_settings de los usuarios")).toEqual([
      "anadir", "validacion", "payment", "service", "profile", "setting",
    ]);
  });

  it("proyecto grande (30 000 archivos): respeta 25 archivos y 12 000 caracteres, y es rápido", async () => {
    const files: FileRecord[] = [];
    for (let i = 0; i < 30_000; i++) {
      const mod = `mod${i % 300}`;
      files.push({ path: `src/${mod}/${i % 100 === 0 ? "payment" : "item"}-${i}.ts`, kind: "source", lang: "typescript", size: 10, mtimeMs: 1, hash: `h${i}`, lastScanId: "s" });
    }
    const snapshot: SnapshotRecord = {
      id: "snap-big", projectId: "prj-big", scanId: "s", createdAt: "2026-10-30T00:00:00.000Z",
      indexHash: computeIndexHash(files), summary: { schemaVersion: 1, files: 30_000, byKind: {}, byLang: {}, source: "git", truncated: false },
    };
    const t0 = performance.now();
    const b = await build({ project: { id: "prj-big", name: "big", rootPath: "/nonexistent" }, snapshot, files, hu: hu("Validar el pago con tarjeta", "payment") });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(b.trace.files).toHaveLength(25);
    expect(b.trace.truncated.files).toBe(true);
    expect(b.text.length).toBeLessThanOrEqual(12_000);
  });
});

describe("fuentes y niveles de confianza", () => {
  const knowledge: ApprovedKnowledge[] = [
    { docId: "k-arch", version: 2, title: "Arquitectura por capas", category: "architecture", content: "Controladores → servicios → repositorios." },
    { docId: "k-dec", version: 1, title: "Decisión: pagos con Stripe", category: "decisions", content: "Usamos Stripe para pagos." },
    { docId: "k-conv", version: 3, title: "Convenciones de código", category: "conventions", content: "Servicios en *.service.ts con prueba *.spec.ts." },
    { docId: "k-prop", version: 1, title: "Propuesta sin aprobar", category: "conventions", content: "NO DEBE APARECER", status: "proposed" },
  ];

  it("conocimiento aprobado (convenciones primero, 2 completos, resto por título) separado de la documentación del repositorio", async () => {
    const c = await scanned("shop", APP);
    const b = await build({ ...c, hu: hu("Reembolsos de pagos"), knowledge });
    const kSection = b.text.slice(b.text.indexOf("### Conocimiento aprobado"), b.text.indexOf("### Archivos relevantes"));
    expect(kSection).toContain("[aprobado en Saiki por una persona]");
    expect(kSection.indexOf("Convenciones de código (convenciones, versión 3)")).toBeLessThan(kSection.indexOf("Arquitectura por capas"));
    expect(kSection).toContain("Usamos Stripe"); // decisión relevante para "pagos": completa, antes que arquitectura
    expect(kSection).toContain("- Arquitectura por capas (arquitectura, versión 2; solo el título)");
    expect(b.text).not.toContain("NO DEBE APARECER");
    expect(kSection).not.toContain("README");

    const docSection = b.text.slice(b.text.indexOf("### Documentación del repositorio"));
    expect(docSection).toContain("[del repositorio, no aprobada en Saiki]");
    expect(docSection).toContain("#### README.md — Pagos y reembolsos\nLos reembolsos pasan por `payment.service`.");
    expect(docSection).not.toContain("Alta de usuarios");

    expect(b.trace.sources).toEqual([
      { kind: "index", ref: c.snapshot.id, version: c.snapshot.indexHash },
      { kind: "knowledge", ref: "k-conv", version: 3, title: "Convenciones de código", category: "conventions", included: "full" },
      { kind: "knowledge", ref: "k-dec", version: 1, title: "Decisión: pagos con Stripe", category: "decisions", included: "full" },
      { kind: "knowledge", ref: "k-arch", version: 2, title: "Arquitectura por capas", category: "architecture", included: "title" },
      { kind: "repo-doc", ref: "README.md", version: c.files.find((f) => f.path === "README.md")!.hash!, included: "excerpt" },
    ]);
    expect(b.trace.truncated.knowledge).toBe(true);
  });

  it("un documento del repositorio que cambió tras el escaneo no se cita, solo se referencia", async () => {
    const c = await scanned("shop", APP);
    writeFileSync(join(c.project.rootPath, "README.md"), "# Shop\n\n## Pagos y reembolsos\n\nTEXTO NUEVO NO ESCANEADO\n");
    const b = await build({ ...c, hu: hu("Reembolsos de pagos") });
    expect(b.text).not.toContain("TEXTO NUEVO");
    expect(b.text).toContain("Otros documentos: README.md");
    expect(b.trace.sources.find((s) => s.kind === "repo-doc")).toMatchObject({ ref: "README.md", included: "reference" });
  });

  it("historial de ejecuciones (reservado): acotado y marcado como historial", async () => {
    const c = await scanned("shop", APP);
    const history = [1, 2, 3, 4].map((i) => ({ executionId: `dev-${i}`, version: `h${i}`, summary: `Cambio ${i}`, files: [`src/f${i}.ts`] }));
    const b = await build({ ...c, hu: hu("Reembolsos"), history });
    expect(b.text).toContain("### Ejecuciones anteriores de esta sesión [historial]");
    expect(b.text).toContain("- Historial de la ejecución dev-1: Cambio 1 (archivos: src/f1.ts)");
    expect(b.text).not.toContain("dev-4");
    expect(b.trace.sources.filter((s) => s.kind === "execution-history").map((s) => s.ref)).toEqual(["dev-1", "dev-2", "dev-3"]);
  });
});

describe("límites, redacción y determinismo", () => {
  it("respeta el máximo de caracteres y lo indica; la traza solo lista lo incluido", async () => {
    const c = await scanned("shop", APP);
    const long: ApprovedKnowledge = { docId: "k1", version: 1, title: "Convenciones", category: "conventions", content: "x ".repeat(10_000) };
    const b = await build({ ...c, hu: hu("Reembolsos de pagos"), knowledge: [long], limits: { maxChars: 2000 } });
    expect(b.text.length).toBeLessThanOrEqual(2000);
    expect(b.trace.truncated.chars).toBe(true);
    const listed = [...b.text.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]).filter((p) => p.includes("/"));
    expect(b.trace.files.map((f) => f.path)).toEqual(listed);

    const full = await build({ ...c, hu: hu("Reembolsos de pagos"), knowledge: [long] });
    expect(full.text).toContain("[…recortado]"); // un documento completo no pasa de 2 500 caracteres
    expect(full.text.length).toBeLessThanOrEqual(12_000);
  });

  it("redacta credenciales del conocimiento, de la documentación y de los scripts; sin hashes en el texto", async () => {
    const c = await scanned("shop", { ...APP, "README.md": "# Shop\n\n## Pagos\n\nclave AKIAABCDEFGHIJKLMNOP y https://u:p4ss@api.pagos.dev\n" });
    const b = await build({
      ...c,
      hu: hu("Pagos"),
      knowledge: [{ docId: "k", version: 1, title: "Convenciones", category: "conventions", content: `token ghp_${"a".repeat(36)} para pagos` }],
    });
    expect(b.text).not.toMatch(/ghp_a|AKIA|p4ss|abcSECRET/);
    expect(b.text).toContain("build → tsc && firebase deploy --token ***");
    expect(b.text).not.toMatch(/[0-9a-f]{40,}/);
  });

  it("determinista: mismo resultado con el índice y el conocimiento en otro orden y otra fecha", async () => {
    const c = await scanned("shop", APP);
    const k: ApprovedKnowledge[] = [
      { docId: "a", version: 1, title: "A", category: "conventions", content: "pagos" },
      { docId: "b", version: 1, title: "B", category: "conventions", content: "pagos" },
      { docId: "c", version: 1, title: "C", category: "architecture", content: "x" },
    ];
    const one = await build({ ...c, hu: hu("Reembolsos de pagos"), knowledge: k, builtAt: "2026-01-01T00:00:00.000Z" });
    const two = await build({ ...c, files: [...c.files].reverse(), hu: hu("Reembolsos de pagos"), knowledge: [...k].reverse(), builtAt: "2027-01-01T00:00:00.000Z" });
    expect(two.text).toBe(one.text);
    expect(two.hash).toBe(one.hash);
    expect({ ...two.trace, builtAt: "" }).toEqual({ ...one.trace, builtAt: "" });
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("snapshot, frescura y aislamiento", () => {
  it("snapshot desactualizado: aviso en el texto y en la traza", async () => {
    const c = await scanned("shop", APP);
    const b = await build({ ...c, hu: hu("Pagos"), stale: { reason: "changes_detected", changedPaths: 4 } });
    expect(b.text).toContain("ATENCIÓN: el contexto puede estar desactualizado (changes_detected, ~4 rutas cambiadas)");
    expect(b.trace).toMatchObject({ stale: true, staleReason: "changes_detected" });
  });

  it("sin snapshot: solo el conocimiento aprobado y el aviso; nada del índice", async () => {
    const b = await build({
      project: { id: "prj-x", name: "x", rootPath: "/nonexistent" },
      snapshot: null,
      files: [],
      hu: hu("Pagos"),
      knowledge: [{ docId: "k", version: 1, title: "Convenciones", category: "conventions", content: "Usa servicios." }],
    });
    expect(b.text).toContain("El proyecto todavía no tiene snapshot: no hay índice técnico.");
    expect(b.text).toContain("Usa servicios.");
    expect(b.text).not.toMatch(/### Stack|### Archivos relevantes/);
    expect(b.trace).toMatchObject({ snapshotId: null, indexHash: null, files: [] });
  });

  it("aislamiento: snapshot de otro proyecto o índice ajeno → error; un snapshot anterior ya no tiene índice", async () => {
    const a = await scanned("a", { "src/pay.ts": "1\n" });
    const b = await scanned("b", { "src/pay.ts": "2\n", "src/other.ts": "3\n" });
    expect(await buildContext({ ...a, snapshot: b.snapshot, hu: hu("pay"), stale: null })).toMatchObject({ ok: false, code: "project_mismatch" });
    expect(await buildContext({ ...a, files: b.files, hu: hu("pay"), stale: null })).toMatchObject({ ok: false, code: "index_mismatch" });

    writeFileSync(join(a.project.rootPath, "src/new.ts"), "x\n");
    const r = await runScan(store!, { projectId: a.project.id, rootPath: a.project.rootPath, fingerprint: readFingerprint(a.project.rootPath)!, mode: "incremental", trigger: "manual" });
    expect(r.ok).toBe(true);
    expect(loadSnapshotIndex(store!, a.project.id, a.snapshot.id)).toMatchObject({ ok: false, code: "index_mismatch" });
    expect(loadSnapshotIndex(store!, a.project.id, b.snapshot.id)).toMatchObject({ ok: false, code: "snapshot_not_found" });
    const latest = loadSnapshotIndex(store!, a.project.id);
    expect(latest.ok && latest.files.map((f) => f.path)).toEqual(["src/new.ts", "src/pay.ts"]);
  });

  it("compatible con snapshots de esquema 1 (anteriores a T4)", async () => {
    const files: FileRecord[] = [{ path: "src/pay.ts", kind: "source", lang: "typescript", size: 1, mtimeMs: 1, hash: "h", lastScanId: "s" }];
    const snapshot: SnapshotRecord = {
      id: "snap-v1", projectId: "prj-v1", scanId: "s", createdAt: "2026-10-30T00:00:00.000Z", indexHash: computeIndexHash(files),
      summary: { schemaVersion: 1, files: 1, byKind: { source: 1 }, byLang: { typescript: 1 }, source: "git", truncated: false },
    };
    const b = await build({ project: { id: "prj-v1", name: "v1", rootPath: "/nonexistent" }, snapshot, files, hu: hu("Pagos con pay") });
    expect(b.text).toContain("Snapshot snap-v1, 1 archivos indexados.");
    expect(b.trace.files.map((f) => f.path)).toEqual(["src/pay.ts"]);
  });
});
