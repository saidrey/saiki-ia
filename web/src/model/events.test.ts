import { describe, expect, it } from "vitest";
import type { SaikiEvent } from "../api/types";
import clampEvents from "./fixtures/events-clamp.json";
import { appendEntry, describeControl, describeEvent, entriesForStage, type LogEntry } from "./events";

/** Fixture = los 18 eventos REALES del SSE de la ejecución "clamp" (2026-10-30). */
const events = clampEvents as SaikiEvent[];
const build = (evs: SaikiEvent[]) => evs.reduce<LogEntry[]>((log, ev) => appendEntry(log, describeEvent(ev)), []);

describe("describeEvent", () => {
  it("traduce cada tipo real a una línea legible", () => {
    const texts = events.map((e) => describeEvent(e).text);
    expect(texts[0]).toBe("Ejecución iniciada: en curso, esperando interacción (pending_review)");
    expect(texts[1]).toBe("Análisis de HU: completada");
    expect(texts[2]).toBe("Espera tu decisión: revisión de la HU");
    expect(texts[6]).toBe("local-human aprobó revisión de la HU");
    expect(texts[10]).toBe("Aprobación humana final: empezó");
    expect(texts[16]).toBe("Ejecución terminada: terminada (applied)");
    expect(texts[17]).toBe("local-human aprobó aprobación final de la propuesta");
  });

  it("los eventos de etapa llevan su stageId para el inspector", () => {
    expect(describeEvent(events[3])).toMatchObject({ family: "stage", tone: "done", stageId: "technical_analysis" });
  });
});

describe("appendEntry", () => {
  it("no duplica un evento ya recibido (reenvío del historial o reconexión)", () => {
    const log = build([...events, ...events.slice(10)]);
    expect(log).toHaveLength(18);
  });

  it("ordena por seq aunque lleguen desordenados", () => {
    const log = build([events[5], events[0], events[2]]);
    expect(log.map((e) => e.seq)).toEqual([1, 3, 6]);
  });

  it("filtra por etapa", () => {
    const log = build(events);
    expect(entriesForStage(log, "final_approval").map((e) => e.type)).toEqual(["stage.started", "stage.completed"]);
  });
});

describe("decisiones del registro", () => {
  it("approval.resolved lleva la decisión estructurada (tipo, actor, hash, fase)", () => {
    const decisions = build(events).flatMap((e) => (e.resolution ? [e.resolution] : []));
    expect(decisions.map((d) => [d.kind, d.decision, d.actor, d.phase])).toEqual([
      ["hu_review", "approve", "local-human", "tech_analyzed"],
      ["feasibility_partial", "approve", "local-human", "reviews_passed"],
      ["final_approval", "approve", "local-human", "applied"],
    ]);
    expect(decisions[0].hash).toBe("10fde5044dcd447cd5767dabca477fb4df71e121cd5c737208fb62ddc637a69e");
  });
});

describe("describeControl", () => {
  it("una brecha por retención se dice explícitamente", () => {
    expect(describeControl({ kind: "gap", from: 2, earliest: 40 }, 0).text).toBe(
      "Faltan eventos anteriores al #40: el servidor ya no los conserva.",
    );
  });
});
