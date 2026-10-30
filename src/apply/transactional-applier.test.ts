import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyProposalTransactional } from "./transactional-applier.js";
import { hashProposal, type Proposal } from "./file-change.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-tx-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function sha(c: string): string {
  return createHash("sha256").update(c, "utf8").digest("hex");
}

const twoFiles: Proposal = {
  id: "p",
  changes: [
    { path: "a.txt", operation: "create", content: "AAA" },
    { path: "b.txt", operation: "create", content: "BBB" },
  ],
};

describe("Fase 7: applyProposalTransactional", () => {
  it("4. aplica exactamente una vez y registra appliedHash", () => {
    const h = hashProposal(twoFiles);
    const r = applyProposalTransactional(twoFiles, { rootDir: root, approvedHash: h });
    expect(r.outcome).toBe("applied");
    expect(r.appliedHash).toBe(h);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("AAA");
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("BBB");
  });

  it("5. idempotencia: si el hash ya se aplico, NO reescribe (noop)", () => {
    const h = hashProposal(twoFiles);
    // Primera aplicacion.
    applyProposalTransactional(twoFiles, { rootDir: root, approvedHash: h });
    // Un usuario edita el archivo despues.
    writeFileSync(join(root, "a.txt"), "EDITADO POR EL USUARIO");
    // Segunda "aplicacion" con el hash ya aplicado: debe ser noop (no pisa).
    const r = applyProposalTransactional(twoFiles, {
      rootDir: root,
      approvedHash: h,
      alreadyAppliedHash: h,
    });
    expect(r.outcome).toBe("noop");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("EDITADO POR EL USUARIO");
  });

  it("6+9. fallo al escribir el 2do archivo -> rollback restaura el estado previo", () => {
    // a.txt ya existia con contenido; lo actualizamos. b.txt es nuevo y fallara.
    writeFileSync(join(root, "a.txt"), "ORIGINAL-A");
    const prop: Proposal = {
      id: "p2",
      changes: [
        { path: "a.txt", operation: "update", content: "NUEVO-A" },
        { path: "b.txt", operation: "create", content: "NUEVO-B" },
      ],
    };
    const r = applyProposalTransactional(prop, {
      rootDir: root,
      approvedHash: hashProposal(prop),
      failOnWrite: (rel) => rel === "b.txt", // falla al escribir b.txt
    });

    expect(r.outcome).toBe("rolled_back");
    // a.txt restaurado a su contenido original.
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("ORIGINAL-A");
    // b.txt no existe (se elimino en el rollback porque no existia antes).
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(r.report).toBeDefined();
  });

  it("8. conflicto concurrente: no sobrescribe trabajo del usuario", () => {
    writeFileSync(join(root, "a.txt"), "trabajo del usuario");
    const prop: Proposal = {
      id: "p3",
      changes: [{ path: "a.txt", operation: "update", content: "x" }],
    };
    const r = applyProposalTransactional(prop, {
      rootDir: root,
      approvedHash: hashProposal(prop),
      expectedBaseHashes: { "a.txt": sha("base distinta") },
    });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("Conflicto");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("trabajo del usuario");
  });

  it("11. integridad de la propuesta: hash distinto -> rejected, nada escrito", () => {
    const r = applyProposalTransactional(twoFiles, {
      rootDir: root,
      approvedHash: "hash-que-no-coincide",
    });
    expect(r.outcome).toBe("rejected");
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  it("7+10. si el rollback tambien falla -> 'unrecoverable' con informe explicito (no exito)", () => {
    writeFileSync(join(root, "a.txt"), "ORIGINAL-A");
    const prop: Proposal = {
      id: "p4",
      changes: [
        { path: "a.txt", operation: "update", content: "NUEVO-A" },
        { path: "b.txt", operation: "create", content: "NUEVO-B" },
      ],
    };
    const r = applyProposalTransactional(prop, {
      rootDir: root,
      approvedHash: hashProposal(prop),
      failOnWrite: (rel) => rel === "b.txt", // falla la aplicacion en b.txt
      failOnRestore: (rel) => rel === "a.txt", // y la restauracion de a.txt falla
    });

    // NO se declara exito; se informa explicitamente lo afectado.
    expect(r.outcome).toBe("unrecoverable");
    expect(r.error).toContain("Revision manual requerida");
    expect(r.report).toBeDefined();
    expect(r.report?.some((l) => l.includes("NO SE PUDO RESTAURAR"))).toBe(true);
    expect(r.applied).toContain("a.txt"); // informa que a.txt quedo afectado
  });

  it("11b. control de rutas: traversal rechazado sin escribir", () => {
    const prop: Proposal = {
      id: "evil",
      changes: [{ path: "../escape.txt", operation: "create", content: "x" }],
    };
    const r = applyProposalTransactional(prop, { rootDir: root, approvedHash: hashProposal(prop) });
    expect(r.outcome).toBe("rejected");
    expect(r.error).toContain("Ruta invalida");
  });
});
