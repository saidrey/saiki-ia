import { describe, it, expect } from "vitest";
import { MockReviewer } from "./mock-reviewer.js";
import { coerceReviewResult } from "./review-types.js";

describe("Fase 8: MockReviewer (reglas deterministas)", () => {
  it("aprueba en el intento 1 por defecto", () => {
    const r = new MockReviewer().review({ proposalContent: "x", attempt: 1 });
    expect(r.status).toBe("success");
    expect(r.decision).toBe("approved");
    expect(r.findings).toEqual([]);
  });

  it("rechaza con hallazgos cuando attempt <= rejectUntilAttempt", () => {
    const r = new MockReviewer({ rejectUntilAttempt: 1 }).review({ proposalContent: "x", attempt: 1 });
    expect(r.status).toBe("success");
    expect(r.decision).toBe("rejected");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0]).toHaveProperty("id");
    expect(r.findings[0]).toHaveProperty("severity");
  });

  it("aprueba en el intento siguiente (corregido)", () => {
    const rev = new MockReviewer({ rejectUntilAttempt: 1 });
    expect(rev.review({ proposalContent: "x", attempt: 1 }).decision).toBe("rejected");
    expect(rev.review({ proposalContent: "x", attempt: 2 }).decision).toBe("approved");
  });

  it("error de revision es distinto de rechazo (status failure)", () => {
    const r = new MockReviewer({ failExecution: true }).review({ proposalContent: "x", attempt: 1 });
    expect(r.status).toBe("failure");
    expect(r.error).toBeDefined();
    // Nunca approved en un fallo.
    expect(r.decision).not.toBe("approved");
  });
});

describe("Fase 8: coerceReviewResult (resultado invalido != aprobacion)", () => {
  it("un objeto invalido se convierte en fallo, nunca en aprobacion", () => {
    const r = coerceReviewResult({ status: "success", decision: "si-dale" });
    expect(r.status).toBe("failure");
    expect(r.decision).not.toBe("approved");
  });

  it("null/undefined -> fallo", () => {
    expect(coerceReviewResult(null).status).toBe("failure");
    expect(coerceReviewResult(undefined).status).toBe("failure");
  });
});
