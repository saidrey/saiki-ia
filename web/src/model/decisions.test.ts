import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { ApprovalResponse, HuReviewGateView } from "../api/types";
import huFixture from "./fixtures/approval-hu.json";
import feasibilityFixture from "./fixtures/approval-feasibility.json";
import finalFixture from "./fixtures/approval-final.json";
import { decisionOptions, describeDecisionError, describeResolution, shownHash } from "./decisions";

/** Fixtures = respuestas REALES de `GET /executions/:id/approval` (ejecución "clamp", 2026-10-30). */
const hu = huFixture as ApprovalResponse;
const feasibility = feasibilityFixture as ApprovalResponse;
const final = finalFixture as ApprovalResponse;

describe("decisionOptions", () => {
  it("HU: aprobar, pedir cambios (con observaciones) y rechazar (con confirmación)", () => {
    const opts = decisionOptions(hu);
    expect(opts.map((o) => o.decision)).toEqual(["approve", "request_changes", "reject"]);
    expect(opts[1]).toMatchObject({ needsFeedback: true, confirm: undefined });
    expect(opts[2].confirm).toMatch(/termina la ejecución/);
  });

  it("HU con el cupo de revisiones agotado: pedir cambios exige confirmación", () => {
    const gate = { ...(hu.gate as HuReviewGateView), revisionsUsed: 2, maxRevisions: 2 };
    expect(decisionOptions({ ...hu, gate })[1].confirm).toMatch(/Ya se usaron las 2 revisiones/);
  });

  it("viabilidad parcial: solo lo que el servidor permite (sin pedir cambios)", () => {
    expect(decisionOptions(feasibility).map((o) => o.decision)).toEqual(["approve", "reject"]);
  });

  it("propuesta final: aprobar y aplicar pide confirmación", () => {
    const opts = decisionOptions(final);
    expect(opts.map((o) => o.label)).toEqual(["Aprobar y aplicar", "Pedir cambios", "Rechazar"]);
    expect(opts[0].confirm).toMatch(/Safe Applier/);
  });
});

describe("shownHash", () => {
  it("usa el hash de lo que se muestra: propuesta en la final, decisionHash en las puertas", () => {
    expect(shownHash(final)).toBe(final.proposal?.proposalHash);
    expect(shownHash(hu)).toBe("10fde5044dcd447cd5767dabca477fb4df71e121cd5c737208fb62ddc637a69e");
    expect(shownHash(feasibility)).toBe(feasibility.gate?.decisionHash);
  });
});

describe("textos de resultado y error", () => {
  it("resolución con el actor del servidor", () => {
    expect(describeResolution("hu_review", { decision: "approve", actor: "local-human", phase: "tech_analyzed" })).toBe(
      "local-human aprobó la revisión de la HU. Fase actual: tech_analyzed.",
    );
  });

  it("409 hash_mismatch: no se aplicó y hay que decidir sobre la versión vigente", () => {
    const e = new ApiError(409, "hash_mismatch", "x", { error: "hash_mismatch", message: "x", expectedHash: "h2" });
    expect(describeDecisionError(e).title).toBe("La versión cambió mientras decidías");
  });

  it("409 not_awaiting dice qué espera ahora la ejecución", () => {
    const e = new ApiError(409, "not_awaiting", "x", { error: "not_awaiting", message: "x", pendingKind: "final_approval" });
    expect(describeDecisionError(e).text).toBe("Ahora espera: aprobación final de la propuesta.");
  });

  it("409 project_unbound: ejecución anterior al registro, con el motivo del backend", () => {
    const e = new ApiError(409, "project_unbound", "Solo puede rechazarse.", { error: "project_unbound", message: "Solo puede rechazarse." });
    expect(describeDecisionError(e)).toEqual({ title: "Esta ejecución no tiene un proyecto vinculado", text: "Solo puede rechazarse." });
  });

  it("sin respuesta: puede haber llegado, no se da por fallida ni se reintenta", () => {
    expect(describeDecisionError(new ApiError(0, "unreachable", "x")).text).toMatch(/Puede que el backend la haya recibido/);
  });
});
