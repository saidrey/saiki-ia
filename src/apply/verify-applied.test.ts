import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAppliedProposal } from "./verify-applied.js";
import type { DevProposal } from "../dev/dev-schema.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-verify-"));
  mkdirSync(join(root, "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function proposal(): DevProposal {
  return {
    summary: "s", technicalDecisions: [],
    changes: [
      { path: "src/a.ts", operation: "create", content: "A" },
      { path: "src/b.ts", operation: "modify", content: "B" },
      { path: "src/c.ts", operation: "delete", content: "" },
    ],
    traceability: [], risks: [], dependencies: [], openQuestions: [],
    coveredCriteria: [], uncoveredCriteria: [],
  };
}

describe("Fase 13: verificación posterior a aplicar", () => {
  it("17. contenido coincide con la propuesta -> filesMatch true", () => {
    writeFileSync(join(root, "src", "a.ts"), "A");
    writeFileSync(join(root, "src", "b.ts"), "B");
    // c.ts no existe (fue eliminado).
    const v = verifyAppliedProposal(proposal(), root);
    expect(v.filesMatch).toBe(true);
    expect(v.createdOk).toContain("src/a.ts");
    expect(v.modifiedOk).toContain("src/b.ts");
    expect(v.deletedOk).toContain("src/c.ts");
    expect(v.mismatches).toHaveLength(0);
  });

  it("detecta contenido distinto como discrepancia (no finge éxito)", () => {
    writeFileSync(join(root, "src", "a.ts"), "CONTENIDO DISTINTO");
    writeFileSync(join(root, "src", "b.ts"), "B");
    const v = verifyAppliedProposal(proposal(), root);
    expect(v.filesMatch).toBe(false);
    expect(v.mismatches.some((m) => m.includes("src/a.ts"))).toBe(true);
  });

  it("detecta archivo que debía eliminarse pero sigue existiendo", () => {
    writeFileSync(join(root, "src", "a.ts"), "A");
    writeFileSync(join(root, "src", "b.ts"), "B");
    writeFileSync(join(root, "src", "c.ts"), "sigo aqui"); // no se eliminó
    const v = verifyAppliedProposal(proposal(), root);
    expect(v.filesMatch).toBe(false);
    expect(v.mismatches.some((m) => m.includes("src/c.ts"))).toBe(true);
  });

  it("propaga el resultado de los checks del proyecto (opt-in)", () => {
    writeFileSync(join(root, "src", "a.ts"), "A");
    writeFileSync(join(root, "src", "b.ts"), "B");
    const v = verifyAppliedProposal(proposal(), root, () => ({ ran: true, passed: false, detail: "fallo" }));
    expect(v.filesMatch).toBe(true);
    expect(v.projectChecks?.ran).toBe(true);
    expect(v.projectChecks?.passed).toBe(false);
  });
});
