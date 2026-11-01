import { describe, expect, it } from "vitest";
import type {
  ContextFilesResponse,
  ContextScanResponse,
  ContextScansResponse,
  ExecutionContextResponse,
  ExecutionResponse,
  ProjectContextResponse,
} from "../api/types";
import {
  compareBundles,
  CONTEXT_STATUS_LABEL,
  executionContextState,
  FILE_KIND_LABEL,
  formatBytes,
  groupSources,
  isScanActive,
  progressText,
  scanDuration,
  splitBundle,
  staleReasonText,
  statsLine,
} from "./context";
import ready from "./fixtures/context-ready.json";
import failed from "./fixtures/context-failed.json";
import scans from "./fixtures/context-scans.json";
import scanDetail from "./fixtures/context-scan-detail.json";
import files from "./fixtures/context-files.json";
import withContext from "./fixtures/execution-with-context.json";
import bundles from "./fixtures/execution-context-bundles.json";
import legacy from "./fixtures/execution-legacy.json";
import legacyContext from "./fixtures/execution-legacy-context.json";

/**
 * Respuestas REALES del backend (Core, escáner y SQLite reales, agentes
 * deterministas), capturadas con el script de validación de T9. Rutas
 * temporales normalizadas a /repos.
 */
const readyCtx = (ready as unknown as ProjectContextResponse).context;
const failedCtx = (failed as unknown as ProjectContextResponse).context;
const scanList = (scans as unknown as ContextScansResponse).scans;
const detail = (scanDetail as unknown as ContextScanResponse).scan;
const filePage = files as unknown as ContextFilesResponse;
const execView = (withContext as unknown as ExecutionResponse).execution;
const frozen = (bundles as unknown as ExecutionContextResponse).context;
const legacyView = (legacy as unknown as ExecutionResponse).execution;

describe("estado del proyecto", () => {
  it("snapshot con cambios posteriores: desactualizado, con motivo legible", () => {
    expect(readyCtx.status).toBe("stale");
    expect(CONTEXT_STATUS_LABEL[readyCtx.status]).toBe("Desactualizado");
    expect(staleReasonText(readyCtx.stale!.reason)).toBe("el repositorio tiene cambios posteriores al snapshot");
    expect(readyCtx.snapshot!.summary.ecosystems[0].scripts.map((s) => s.name)).toEqual(["build", "dev", "test"]);
  });

  it("sin snapshot y escaneo fallido: error saneado, sin rutas del equipo", () => {
    expect(failedCtx.status).toBe("failed");
    expect(failedCtx.snapshot).toBeNull();
    expect(failedCtx.lastScan!.error).toContain("<proyecto>/src/broken.ts");
    expect(JSON.stringify(failedCtx)).not.toMatch(/\/(var|Users|private)\//);
  });
});

describe("escaneos", () => {
  it("historial: estados, duración solo con inicio y fin reales, cifras del escáner", () => {
    expect(scanList.map((s) => s.status).every((s) => s === "completed")).toBe(true);
    const last = scanList[0];
    expect(scanDuration(last)).toBe("menos de 1 s");
    expect(scanDuration({ startedAt: "2026-10-30T10:00:00.000Z", finishedAt: "2026-10-30T10:01:05.000Z" })).toBe("1 min 05 s");
    expect(scanDuration({ startedAt: last.startedAt, finishedAt: null })).toBeNull();
    expect(scanDuration({ startedAt: null, finishedAt: null })).toBeNull();
    expect(statsLine(last.stats!)).toBe("1 alta, 1 modificado, 0 bajas, 0 renombrados");
    expect(isScanActive({ status: "queued" })).toBe(true);
    expect(isScanActive({ status: "interrupted" })).toBe(false);
  });

  it("detalle: cambios por tipo y snapshot generado", () => {
    expect(detail.changes).toEqual({ added: ["src/orders/order.ts"], modified: ["src/payments/refund.ts"], deleted: [], renamed: [], truncated: false });
    expect(detail.snapshotId).toMatch(/^snap-/);
  });

  it("progreso: solo las cifras del evento", () => {
    expect(progressText({ scanId: "s", mode: "full", trigger: "manual", phase: "hashing", listed: 300, toHash: 120, hashed: 40 })).toBe(
      "Calculando hashes: 40 de 120 archivos por procesar (300 listados).",
    );
  });
});

describe("explorador", () => {
  it("metadatos sin contenido ni hashes; secretos por nombre; cursor del backend", () => {
    expect(filePage.files).toHaveLength(5);
    expect(filePage.nextCursor).not.toBeNull();
    for (const f of filePage.files) expect(Object.keys(f).sort()).toEqual(["kind", "lang", "mtimeMs", "path", "size"]);
    expect(filePage.files.find((f) => f.path === ".env")?.kind).toBe("secret");
    expect(FILE_KIND_LABEL.secret).toBe("Secreto (solo el nombre)");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("contexto de una ejecución", () => {
  it("recibió contexto congelado: snapshot, archivos y fuentes sin hashes", () => {
    const s = executionContextState(execView);
    expect(s.kind).toBe("received");
    if (s.kind !== "received") return;
    expect(s.context.files.map((f) => f.path)).toEqual(["src/payments/refund.ts", "src/payments/refund.test.ts"]);
    const g = groupSources(s.context.sources);
    expect(g.index).toHaveLength(1);
    expect(g.repoDocs.map((d) => d.ref)).toEqual(["README.md", "docs/payments.md"]);
    expect(JSON.stringify(s.context)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("ejecución anterior a T8: sin contexto, y la API lo dice sin reconstruir", () => {
    expect(executionContextState(legacyView)).toEqual({ kind: "none" });
    expect(legacyContext).toMatchObject({ error: "not_frozen" });
    const waiting = { context: null, stages: [{ id: "technical_analysis", status: "pending" }] } as never;
    expect(executionContextState(waiting)).toEqual({ kind: "not_yet" });
  });

  it("bundles congelados: el de Claude es un subconjunto; la comparación lo muestra por sección", () => {
    expect(frozen.snapshotId).toBe(execView.context!.snapshotId);
    expect(JSON.stringify(frozen)).not.toMatch(/[0-9a-f]{64}/);
    // El texto de cada sección se conserva exacto al partirlo.
    expect(splitBundle(frozen.technicalBundle).map((s) => s.text).join("\n")).toBe(frozen.technicalBundle);
    expect(compareBundles(frozen.technicalBundle, frozen.developerBundle).map((s) => [s.title, s.inDeveloper])).toEqual([
      ["Cabecera", true],
      ["Stack", true],
      ["Archivos relevantes", false],
      ["Documentación del repositorio", false],
    ]);
  });
});
