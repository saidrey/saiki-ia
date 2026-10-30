import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyProposal } from "./applier.js";
import { hashProposal, type Proposal } from "./file-change.js";
import { resolveSafePath, PathValidationError } from "./path-validation.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saiki-apply-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const proposal: Proposal = {
  id: "p1",
  changes: [{ path: "out/a.txt", operation: "create", content: "hola" }],
};

describe("Fase 6: applyProposal", () => {
  it("4. aplica solo lo autorizado cuando el hash coincide", () => {
    const r = applyProposal(proposal, { rootDir: root, approvedHash: hashProposal(proposal) });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["out/a.txt"]);
    expect(readFileSync(join(root, "out/a.txt"), "utf8")).toBe("hola");
  });

  it("7. una propuesta modificada tras aprobar se RECHAZA (hash distinto)", () => {
    const approvedHash = hashProposal(proposal);
    // La propuesta cambia despues de aprobarse.
    const tampered: Proposal = {
      id: "p1",
      changes: [{ path: "out/a.txt", operation: "create", content: "CONTENIDO MALICIOSO" }],
    };
    const r = applyProposal(tampered, { rootDir: root, approvedHash });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("hash distinto");
    expect(existsSync(join(root, "out/a.txt"))).toBe(false); // nada aplicado
  });

  it("9. detecta cambios concurrentes del usuario antes de sobrescribir", () => {
    // Archivo ya existe con contenido del usuario.
    writeFileSync(join(root, "a.txt"), "trabajo del usuario");
    const upd: Proposal = {
      id: "p2",
      changes: [{ path: "a.txt", operation: "update", content: "nuevo" }],
    };
    const r = applyProposal(upd, {
      rootDir: root,
      approvedHash: hashProposal(upd),
      // La propuesta asumio una base vacia, pero en disco hay otra cosa.
      expectedBaseHashes: { "a.txt": sha("base original distinta") },
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("Conflicto");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("trabajo del usuario"); // intacto
  });

  it("10. un fallo del aplicador queda visible y no declara exito", () => {
    // Forzamos fallo: 'create' sobre un archivo que ya existe.
    writeFileSync(join(root, "existe.txt"), "ya estaba");
    const p: Proposal = {
      id: "p3",
      changes: [{ path: "existe.txt", operation: "create", content: "x" }],
    };
    const r = applyProposal(p, { rootDir: root, approvedHash: hashProposal(p) });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("create");
    expect(readFileSync(join(root, "existe.txt"), "utf8")).toBe("ya estaba");
  });
});

describe("Fase 6: resolveSafePath (8. rutas peligrosas)", () => {
  it("rechaza rutas absolutas", () => {
    expect(() => resolveSafePath(root, "/etc/passwd")).toThrow(PathValidationError);
  });

  it("rechaza traversal con ..", () => {
    expect(() => resolveSafePath(root, "../fuera.txt")).toThrow(PathValidationError);
    expect(() => resolveSafePath(root, "sub/../../fuera.txt")).toThrow(PathValidationError);
  });

  it("acepta rutas relativas validas dentro del root", () => {
    const p = resolveSafePath(root, "sub/dir/archivo.txt");
    expect(p.startsWith(root)).toBe(true);
  });

  it("rechaza symlink que apunta fuera del root (symlink escape)", () => {
    // Creamos un symlink 'escape' -> /tmp (fuera del root autorizado).
    const link = join(root, "escape");
    symlinkSync(tmpdir(), link);
    // Intentar escribir a traves del symlink debe rechazarse.
    expect(() => resolveSafePath(root, "escape/objetivo.txt")).toThrow(PathValidationError);
  });

  it("8b. applyProposal rechaza una ruta con traversal sin escribir nada", () => {
    const p: Proposal = {
      id: "evil",
      changes: [{ path: "../escape.txt", operation: "create", content: "x" }],
    };
    const r = applyProposal(p, { rootDir: root, approvedHash: hashProposal(p) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Ruta invalida");
    mkdirSync(join(root, "probe"), { recursive: true }); // sanity: root usable
  });
});
