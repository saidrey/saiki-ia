import { describe, it, expect } from "vitest";
import { validateHu } from "./hu-schema.js";

const valid = {
  summary: "Boton suma",
  need: "El usuario quiere sumar a+b",
  tasks: [{ order: 1, description: "crear boton" }],
  acceptanceCriteria: [{ id: "AC1", description: "al pulsar muestra a+b" }],
  assumptions: [],
  openQuestions: [],
  dependencies: [],
};

describe("Fase 9: validateHu", () => {
  it("acepta una HU completa y bien formada", () => {
    const r = validateHu(valid);
    expect(r.ok).toBe(true);
  });

  it("rechaza summary vacio", () => {
    const r = validateHu({ ...valid, summary: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("summary");
  });

  it("rechaza sin tareas", () => {
    const r = validateHu({ ...valid, tasks: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("tasks");
  });

  it("rechaza sin criterios de aceptacion", () => {
    const r = validateHu({ ...valid, acceptanceCriteria: [] });
    expect(r.ok).toBe(false);
  });

  it("rechaza null / no-objeto", () => {
    expect(validateHu(null).ok).toBe(false);
    expect(validateHu("texto").ok).toBe(false);
  });

  it("rechaza listas con tipo incorrecto", () => {
    const r = validateHu({ ...valid, assumptions: "no es lista" });
    expect(r.ok).toBe(false);
  });
});
