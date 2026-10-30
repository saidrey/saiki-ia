import { describe, expect, it } from "vitest";
import type { ExecutionResponse, ExecutionView, StageId, StageStatus } from "../api/types";
import appliedFixture from "./fixtures/execution-applied.json";
import finalApprovalFixture from "./fixtures/execution-final-approval.json";
import { observe, observedTime, type ExecutionObservations } from "./observations";

/**
 * Base real (`GET /executions/:id` de la prueba con agentes); cada paso cambia
 * solo los estados para reproducir la secuencia que vio el sondeo real:
 * hu_analysis pending → running → done (2026-10-30, ejecución "slugify").
 */
const base = (appliedFixture as ExecutionResponse).execution;
const awaitingFinal = (finalApprovalFixture as ExecutionResponse).execution;

function withStatuses(statuses: Partial<Record<StageId, StageStatus>>): ExecutionView {
  return {
    ...base,
    pendingApproval: { required: false },
    finalResult: { available: "not_applicable" },
    stages: base.stages.map((s) => ({ ...s, status: statuses[s.id] ?? "pending" })),
  };
}

function run(seq: Array<[number, Partial<Record<StageId, StageStatus>>]>): ExecutionObservations {
  return seq.reduce<ExecutionObservations>((obs, [at, st]) => observe(obs, withStatuses(st), at), {});
}

describe("tiempo observado", () => {
  it("mide inicio y fin vistos, con su margen", () => {
    const obs = run([
      [0, {}],
      [2_500, { hu_analysis: "running" }],
      [20_000, { hu_analysis: "running" }],
      [22_500, { hu_analysis: "done" }],
    ]);
    // inicio ∈ (0, 2.5s] → 1.25s ± 1.25s; fin ∈ (20s, 22.5s] → 21.25s ± 1.25s
    expect(observedTime(obs.hu_analysis, 30_000)).toEqual({ kind: "measured", ms: 20_000, marginMs: 2_500 });
  });

  it("si la pestaña llegó con la etapa ya en curso, el inicio es desconocido: no disponible", () => {
    const obs = run([
      [0, { hu_analysis: "running" }],
      [2_500, { hu_analysis: "done" }],
    ]);
    expect(observedTime(obs.hu_analysis, 5_000).kind).toBe("unavailable");
  });

  it("una etapa ya terminada al abrir la página: no disponible", () => {
    const obs = run([[0, { hu_analysis: "done" }]]);
    expect(observedTime(obs.hu_analysis, 1_000).kind).toBe("unavailable");
  });

  it("una etapa pendiente que nunca se vio en curso: no disponible", () => {
    const obs = run([[0, {}], [2_500, {}]]);
    expect(observedTime(obs.technical_analysis, 3_000)).toEqual({
      kind: "unavailable",
      reason: "esta pestaña no ha visto la etapa en curso.",
    });
  });

  it("en curso con inicio observado: tiempo hasta ahora", () => {
    const obs = run([[0, {}], [2_000, { hu_analysis: "running" }]]);
    expect(observedTime(obs.hu_analysis, 11_000)).toEqual({ kind: "running", ms: 10_000, marginMs: 1_000 });
  });

  it("una nueva ejecución tras terminar (ciclo de corrección) reinicia la medición", () => {
    const obs = run([
      [0, {}],
      [2_000, { functional_review: "running" }],
      [4_000, { functional_review: "done" }],
      [6_000, { functional_review: "running" }],
      [10_000, { functional_review: "done" }],
    ]);
    // Segunda medición: inicio ∈ (4s, 6s], fin ∈ (6s, 10s]
    expect(observedTime(obs.functional_review, 20_000)).toEqual({ kind: "measured", ms: 3_000, marginMs: 3_000 });
  });

  it("la aprobación final esperando al humano no se cronometra como ejecución", () => {
    const obs = observe(observe({}, withStatuses({}), 0), awaitingFinal, 2_000);
    expect(observedTime(obs.final_approval, 5_000).kind).toBe("unavailable");
  });
});
