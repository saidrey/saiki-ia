import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyDevProposal, devProposalToProposal } from "./dev-proposal-bridge.js";
import { hashDevProposal, type DevProposal } from "../dev/dev-schema.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-bridge-"));
  mkdirSync(join(root, "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sha(c: string): string {
  return createHash("sha256").update(c, "utf8").digest("hex");
}

/** Propuesta base con create/modify/delete. */
function proposal(): DevProposal {
  return {
    summary: "cambios mixtos",
    technicalDecisions: ["d1"],
    changes: [
      { path: "src/nuevo.ts", operation: "create", content: "export const x = 1;" },
      { path: "src/existente.ts", operation: "modify", content: "export const y = 2;" },
      { path: "src/viejo.ts", operation: "delete", content: "" },
    ],
    traceability: [{ ref: "AC1", note: "n" }],
    risks: [],
    dependencies: [],
    openQuestions: [],
    coveredCriteria: ["AC1"],
    uncoveredCriteria: [],
  };
}

describe("Fase 13: puente DevProposal -> aplicador seguro", () => {
  it("3+11. aplica nuevos, modificados y eliminados correctamente", () => {
    writeFileSync(join(root, "src", "existente.ts"), "export const y = 1;");
    writeFileSync(join(root, "src", "viejo.ts"), "borrame");
    const p = proposal();
    const h = hashDevProposal(p);

    const r = applyDevProposal(p, { rootDir: root, approvedDevHash: h });

    expect(r.outcome).toBe("applied");
    expect(r.appliedDevHash).toBe(h);
    expect(readFileSync(join(root, "src", "nuevo.ts"), "utf8")).toBe("export const x = 1;");
    expect(readFileSync(join(root, "src", "existente.ts"), "utf8")).toBe("export const y = 2;");
    expect(existsSync(join(root, "src", "viejo.ts"))).toBe(false);
  });

  it("3+4. una modificación de la propuesta invalida la aprobación (hash distinto)", () => {
    const p = proposal();
    const approved = hashDevProposal(p);
    // El humano aprobó `approved`, pero ahora la propuesta cambió.
    const changed: DevProposal = { ...p, summary: "OTRA COSA" };

    const r = applyDevProposal(changed, { rootDir: root, approvedDevHash: approved });

    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("hash DEV distinto");
    expect(existsSync(join(root, "src", "nuevo.ts"))).toBe(false);
  });

  it("9. ruta con traversal -> rechazada sin escribir", () => {
    const p: DevProposal = {
      ...proposal(),
      changes: [{ path: "../escape.ts", operation: "create", content: "x" }],
    };
    const r = applyDevProposal(p, { rootDir: root, approvedDevHash: hashDevProposal(p) });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("Ruta invalida");
  });

  it("9b. symlink que escapa del root -> rechazado", () => {
    // Creamos un symlink dentro del root que apunta fuera.
    const outside = mkdtempSync(join(tmpdir(), "saiki-outside-"));
    try {
      const linkPath = join(root, "src", "link.ts");
      symlinkSync(join(outside, "target.ts"), linkPath);
      const p: DevProposal = {
        ...proposal(),
        changes: [{ path: "src/link.ts", operation: "modify", content: "hack" }],
      };
      const r = applyDevProposal(p, { rootDir: root, approvedDevHash: hashDevProposal(p) });
      expect(r.outcome).toBe("rejected");
      expect(existsSync(join(outside, "target.ts"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("10. cambio concurrente en disco -> rechazado (no sobrescribe)", () => {
    writeFileSync(join(root, "src", "existente.ts"), "contenido actual");
    writeFileSync(join(root, "src", "viejo.ts"), "v");
    const p = proposal();
    const h = hashDevProposal(p);
    const r = applyDevProposal(p, {
      rootDir: root,
      approvedDevHash: h,
      // La propuesta asumió una base distinta de la que hay en disco ahora.
      expectedBaseHashes: { "src/existente.ts": sha("base vieja distinta") },
    });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("Conflicto");
    expect(readFileSync(join(root, "src", "existente.ts"), "utf8")).toBe("contenido actual");
  });

  it("12+13. fallo al escribir -> rollback deja el repo en el estado anterior", () => {
    writeFileSync(join(root, "src", "existente.ts"), "ORIGINAL");
    writeFileSync(join(root, "src", "viejo.ts"), "VIEJO");
    const p = proposal();
    const r = applyDevProposal(p, {
      rootDir: root,
      approvedDevHash: hashDevProposal(p),
      failOnWrite: (rel) => rel === "src/viejo.ts", // falla en el delete
    });
    expect(r.outcome).toBe("rolled_back");
    // Todo volvió a su estado previo.
    expect(existsSync(join(root, "src", "nuevo.ts"))).toBe(false);
    expect(readFileSync(join(root, "src", "existente.ts"), "utf8")).toBe("ORIGINAL");
    expect(readFileSync(join(root, "src", "viejo.ts"), "utf8")).toBe("VIEJO");
  });

  it("14. rollback fallido -> unrecoverable (no finge éxito)", () => {
    writeFileSync(join(root, "src", "existente.ts"), "ORIGINAL");
    writeFileSync(join(root, "src", "viejo.ts"), "VIEJO");
    const p = proposal();
    const r = applyDevProposal(p, {
      rootDir: root,
      approvedDevHash: hashDevProposal(p),
      failOnWrite: (rel) => rel === "src/viejo.ts",
      failOnRestore: (rel) => rel === "src/existente.ts",
    });
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error).toContain("Revision manual requerida");
    expect(r.report?.some((l) => l.includes("NO SE PUDO RESTAURAR"))).toBe(true);
  });

  it("15. idempotencia: el mismo hash aplicado -> noop (no reescribe)", () => {
    writeFileSync(join(root, "src", "existente.ts"), "export const y = 1;");
    writeFileSync(join(root, "src", "viejo.ts"), "borrame");
    const p = proposal();
    const h = hashDevProposal(p);
    applyDevProposal(p, { rootDir: root, approvedDevHash: h });
    // Edición posterior del usuario que un segundo apply NO debe pisar.
    writeFileSync(join(root, "src", "nuevo.ts"), "EDITADO");
    const r = applyDevProposal(p, { rootDir: root, approvedDevHash: h, alreadyAppliedDevHash: h });
    expect(r.outcome).toBe("noop");
    expect(readFileSync(join(root, "src", "nuevo.ts"), "utf8")).toBe("EDITADO");
  });

  it("2. aprobación atada a un hash NO vale para otra versión (reuso bloqueado)", () => {
    const v1 = proposal();
    const hashV1 = hashDevProposal(v1);
    // Una versión distinta (otro contenido) con el hash aprobado de v1.
    const v2: DevProposal = {
      ...v1,
      changes: [{ path: "src/nuevo.ts", operation: "create", content: "export const x = 999;" }],
    };
    const r = applyDevProposal(v2, { rootDir: root, approvedDevHash: hashV1 });
    expect(r.outcome).toBe("rejected");
    expect(existsSync(join(root, "src", "nuevo.ts"))).toBe(false);
  });

  it("8. propuesta inconsistente (create sobre archivo existente) -> rechazada", () => {
    writeFileSync(join(root, "src", "ya-existe.ts"), "contenido previo");
    const p: DevProposal = {
      ...proposal(),
      changes: [{ path: "src/ya-existe.ts", operation: "create", content: "nuevo" }],
    };
    const r = applyDevProposal(p, { rootDir: root, approvedDevHash: hashDevProposal(p) });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("no puede sobrescribir");
    // El archivo conserva su contenido previo.
    expect(readFileSync(join(root, "src", "ya-existe.ts"), "utf8")).toBe("contenido previo");
  });

  it("conversión: modify->update, delete->'', id = hash aprobado", () => {
    const p = proposal();
    const h = hashDevProposal(p);
    const converted = devProposalToProposal(p, h);
    expect(converted.id).toBe(h);
    expect(converted.changes.find((c) => c.path === "src/existente.ts")?.operation).toBe("update");
    const del = converted.changes.find((c) => c.path === "src/viejo.ts");
    expect(del?.operation).toBe("delete");
    expect(del?.content).toBe("");
  });
});
