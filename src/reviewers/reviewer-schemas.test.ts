import { describe, it, expect } from "vitest";
import { validateFunctionalReview, validateQualityReview } from "./reviewer-schemas.js";

const func = {
  decision: "approved", evaluatedCriteria: ["AC1"], metCriteria: ["AC1"],
  unmetCriteria: [], findings: [], requiredChanges: [], openQuestions: [], summary: "ok",
};
const qual = {
  decision: "approved", categories: [{ category: "clean-code", assessment: "ok" }],
  findings: [], requiredChanges: [], acceptedRisks: [], summary: "ok",
};

describe("Fase 12: validateFunctionalReview", () => {
  it("acepta una revisión bien formada", () => {
    expect(validateFunctionalReview(func).ok).toBe(true);
  });
  it("rechaza decision inválida (inválido != aprobación)", () => {
    expect(validateFunctionalReview({ ...func, decision: "maybe" }).ok).toBe(false);
  });
  it("rechaza null / no-objeto", () => {
    expect(validateFunctionalReview(null).ok).toBe(false);
  });
  it("rechaza listas con tipo incorrecto", () => {
    expect(validateFunctionalReview({ ...func, metCriteria: "no" }).ok).toBe(false);
  });
});

describe("Fase 12: validateQualityReview", () => {
  it("acepta una revisión bien formada", () => {
    expect(validateQualityReview(qual).ok).toBe(true);
  });
  it("rechaza decision inválida", () => {
    expect(validateQualityReview({ ...qual, decision: "x" }).ok).toBe(false);
  });
  it("rechaza sin summary", () => {
    expect(validateQualityReview({ ...qual, summary: "" }).ok).toBe(false);
  });
});
