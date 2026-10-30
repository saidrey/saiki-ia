import { describe, expect, it } from "vitest";
import type { ExecutionResponse, ExecutionView, StageId } from "../api/types";
import finalApprovalFixture from "./fixtures/execution-final-approval.json";
import appliedFixture from "./fixtures/execution-applied.json";
import {
  approvalKindLabel,
  defaultSelectedStage,
  gateAfterStage,
  isExecutionActive,
  progressSummary,
  stateLabel,
  stationState,
  trackAfter,
} from "./stages";

/**
 * Fixtures = respuestas REALES de `GET /executions/:id` capturadas en la prueba
 * con agentes reales del 2026-10-30 (ejecución "clamp", dev-5ff3401b…).
 */
const awaitingFinal = (finalApprovalFixture as ExecutionResponse).execution;
const applied = (appliedFixture as ExecutionResponse).execution;

const states = (v: ExecutionView) => v.stages.map((s) => stationState(s, v));

describe("stationState", () => {
  it("la etapa de awaitingDecision (final_approval, que la API deja en running) = espera tu decisión", () => {
    expect(awaitingFinal.stages.find((s) => s.id === "final_approval")?.status).toBe("running");
    expect(states(awaitingFinal)).toEqual(["done", "done", "done", "done", "done", "done", "awaiting", "pending", "pending"]);
  });

  it("una ejecución aplicada muestra las 9 etapas completadas", () => {
    expect(states(applied)).toEqual(Array(9).fill("done"));
  });
});

describe("gateAfterStage", () => {
  const withGate = (kind: string, afterStageId: StageId): ExecutionView => ({ ...awaitingFinal, awaitingDecision: { kind, afterStageId } });
  it("la señal va donde dice el backend (awaitingDecision.afterStageId)", () => {
    expect(gateAfterStage(withGate("hu_review", "hu_analysis"))).toBe("hu_analysis");
    expect(gateAfterStage(withGate("feasibility_partial", "feasibility"))).toBe("feasibility");
  });
  it("final_approval es una etapa: no hay señal aparte", () => {
    expect(awaitingFinal.awaitingDecision).toEqual({ kind: "final_approval", stageId: "final_approval" });
    expect(gateAfterStage(awaitingFinal)).toBeNull();
    expect(gateAfterStage(applied)).toBeNull();
  });
});

describe("isExecutionActive", () => {
  it("pausada esperando una decisión: no hay actividad", () => {
    expect(isExecutionActive(awaitingFinal)).toBe(false);
  });
  it("terminada: no hay actividad", () => {
    expect(isExecutionActive(applied)).toBe(false);
  });
  it("la actividad la decide el ciclo de vida del backend, no las etapas", () => {
    expect(awaitingFinal.lifecycle).toBe("awaiting_decision");
    expect(applied.lifecycle).toBe("completed");
    expect(isExecutionActive({ ...applied, lifecycle: "running" })).toBe(true);
    expect(isExecutionActive({ ...applied, lifecycle: "interrupted" })).toBe(false);
  });
});

describe("trackAfter", () => {
  it("vía recorrida hasta la revisión de calidad y tramo ámbar hacia la decisión", () => {
    const s = states(awaitingFinal);
    const tracks = s.map((_, i) => trackAfter(s, i, -1));
    expect(tracks).toEqual(["done", "done", "done", "done", "done", "approach", "off", "off", "off"]);
  });
  it("una señal de HU vuelve ámbar el tramo que sale de la etapa 1", () => {
    const s = ["done", "pending", "pending"] as const;
    expect(trackAfter([...s], 0, 0)).toBe("approach");
    expect(trackAfter([...s], 1, 0)).toBe("off");
  });
});

describe("textos", () => {
  it("resumen accesible del progreso", () => {
    expect(progressSummary(awaitingFinal)).toBe(
      "6 de 9 etapas completadas; espera tu decisión: aprobación final de la propuesta",
    );
  });
  it("un tipo de aprobación desconocido se muestra tal cual", () => {
    expect(approvalKindLabel("otra_puerta")).toBe("otra_puerta");
  });
});

describe("defaultSelectedStage", () => {
  it("esperando la aprobación final: se muestra esa etapa", () => {
    expect(defaultSelectedStage(awaitingFinal)).toBe("final_approval");
  });
  it("terminada: la última etapa que dejó de estar pendiente", () => {
    expect(defaultSelectedStage(applied)).toBe("verify");
  });
  it("con señal de HU: la etapa anterior a la señal", () => {
    const huGate: ExecutionView = {
      ...applied,
      lifecycle: "awaiting_decision",
      activeStage: "none",
      awaitingDecision: { kind: "hu_review", afterStageId: "hu_analysis" },
      finalResult: { available: "not_applicable" },
      pendingApproval: { required: true, kind: "hu_review", decisionHash: "h" },
      stages: applied.stages.map((s) => ({ ...s, status: s.id === "hu_analysis" ? "done" : "pending" })),
    };
    expect(defaultSelectedStage(huGate)).toBe("hu_analysis");
  });
});

describe("stateLabel", () => {
  it("en una ejecución terminada, pendiente = no se ejecutó; en curso sigue siendo pendiente", () => {
    expect(stateLabel("pending", applied)).toBe("No se ejecutó");
    expect(stateLabel("pending", awaitingFinal)).toBe("Pendiente");
    expect(stateLabel("done", applied)).toBe("Completada");
  });
});
