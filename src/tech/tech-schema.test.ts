import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTechnicalAnalysis } from "./tech-schema.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-tech-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "existe.ts"), "export const x = 1;");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function baseAnalysis(path: string) {
  return {
    summary: "Analisis",
    currentFlow: "flujo actual",
    affectedFiles: [{ path, responsibility: "hace algo" }],
    proposedChanges: [{ path, change: "cambiar algo" }],
    traceability: [{ ref: "AC1", note: "cubre" }],
    dependencies: [],
    risks: [],
    openQuestions: [],
  };
}

describe("Fase 10: validateTechnicalAnalysis", () => {
  it("3. valida y confirma que una ruta EXISTENTE existe", () => {
    const r = validateTechnicalAnalysis(baseAnalysis("src/existe.ts"), root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unresolvedPaths).toEqual([]);
      expect(r.analysis.affectedFiles[0].exists).toBe(true);
    }
  });

  it("4. reporta una ruta INEXISTENTE en unresolvedPaths (no la inventa)", () => {
    const r = validateTechnicalAnalysis(baseAnalysis("src/no-existe.ts"), root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unresolvedPaths).toContain("src/no-existe.ts");
      expect(r.analysis.affectedFiles[0].exists).toBe(false);
    }
  });

  it("4b. rechaza ruta absoluta / traversal como no verificable", () => {
    const abs = validateTechnicalAnalysis(baseAnalysis("/etc/passwd"), root);
    expect(abs.ok).toBe(true);
    if (abs.ok) expect(abs.unresolvedPaths.some((p) => p.includes("no verificable"))).toBe(true);

    const trav = validateTechnicalAnalysis(baseAnalysis("../fuera.ts"), root);
    expect(trav.ok).toBe(true);
    if (trav.ok) expect(trav.unresolvedPaths.some((p) => p.includes("no verificable"))).toBe(true);
  });

  it("rechaza analisis sin summary o sin currentFlow", () => {
    expect(validateTechnicalAnalysis({ ...baseAnalysis("src/existe.ts"), summary: "" }, root).ok).toBe(false);
    expect(validateTechnicalAnalysis({ ...baseAnalysis("src/existe.ts"), currentFlow: "" }, root).ok).toBe(false);
  });

  it("acepta affectedFiles/proposedChanges VACIOS (HU no mapea a archivos) si hay summary", () => {
    const r = validateTechnicalAnalysis(
      { ...baseAnalysis("src/existe.ts"), affectedFiles: [], proposedChanges: [] },
      root,
    );
    expect(r.ok).toBe(true);
  });

  it("rechaza affectedFiles que NO es lista", () => {
    const r = validateTechnicalAnalysis(
      { ...baseAnalysis("src/existe.ts"), affectedFiles: "no-lista" },
      root,
    );
    expect(r.ok).toBe(false);
  });

  it("rechaza no-objeto", () => {
    expect(validateTechnicalAnalysis(null, root).ok).toBe(false);
    expect(validateTechnicalAnalysis("texto", root).ok).toBe(false);
  });
});
