import { describe, expect, it } from "vitest";
import type { ExecutionResponse, ExecutionView, ModeratorSession, SessionsResponse } from "../api/types";
import appliedFixture from "./fixtures/execution-applied.json";
import sessionsFixture from "./fixtures/sessions.json";
import { activityRows, byRecentActivity, executionsOf, summarizeSession } from "./sessions";
import { elapsed, relativeTime } from "./format";

/** Fixture = respuesta REAL de `GET /sessions` (sesión "real-1", 2026-10-30). */
const real = (sessionsFixture as SessionsResponse).sessions[0];

describe("summarizeSession", () => {
  it("usa el primer mensaje del usuario como solicitud y enlaza la ejecución", () => {
    const s = summarizeSession(real);
    expect(s.title).toMatch(/^Implementa en src\/utils\/clamp\.ts/);
    expect(s.executionId).toBe("dev-5ff3401b-2627-4ed2-83ad-74db959a4193");
    expect(s.hasAssistance).toBe(false);
  });

  it("una sesión sin turnos de usuario lo dice, no inventa un título", () => {
    const empty: ModeratorSession = { ...real, turns: [], developmentThreadId: undefined };
    expect(summarizeSession(empty).title).toBe("Sesión sin mensajes");
    expect(summarizeSession(empty).executionId).toBeUndefined();
  });

  it("ordena por actividad más reciente", () => {
    const a = { updatedAt: "2026-10-30T04:00:00.000Z" };
    const b = { updatedAt: "2026-10-30T05:00:00.000Z" };
    expect([a, b].sort(byRecentActivity)).toEqual([b, a]);
  });
});

describe("format", () => {
  const now = Date.parse("2026-10-30T05:00:00.000Z");
  it("tiempo relativo en español", () => {
    expect(relativeTime("2026-10-30T04:59:50.000Z", now)).toBe("hace un momento");
    expect(relativeTime("2026-10-30T04:55:00.000Z", now)).toBe("hace 5 minutos");
    expect(relativeTime("2026-10-30T02:00:00.000Z", now)).toBe("hace 3 horas");
    expect(relativeTime("2026-10-29T05:00:00.000Z", now)).toBe("ayer");
  });
  it("tiempo transcurrido", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(65_000)).toBe("1:05");
    expect(elapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("activityRows (una fila por ejecución)", () => {
  const applied = (appliedFixture as ExecutionResponse).execution;
  const multi: ModeratorSession = { ...real, developmentThreadId: "dev-b", developmentThreadIds: ["dev-a", "dev-b"] };

  it("una sesión con varias ejecuciones muestra todas, la más reciente primero, con su propia solicitud", () => {
    const views = new Map<string, ExecutionView | undefined>([
      ["dev-a", { ...applied, executionId: "dev-a", request: "solicitud A" }],
      ["dev-b", { ...applied, executionId: "dev-b", request: "solicitud B" }],
    ]);
    const rows = activityRows([multi], views);
    expect(rows.map((r) => [r.executionId, r.title])).toEqual([
      ["dev-b", "solicitud B"],
      ["dev-a", "solicitud A"],
    ]);
  });

  it("sin la vista aún cargada no inventa el título de una ejecución que no es la única", () => {
    const rows = activityRows([multi], new Map());
    expect(rows.map((r) => r.title)).toEqual(["Cargando solicitud…", "Cargando solicitud…"]);
    expect(rows.every((r) => r.titlePending)).toBe(true);
  });

  it("sesión antigua (solo developmentThreadId) y sesión sin ejecuciones", () => {
    expect(executionsOf(real)).toEqual(["dev-5ff3401b-2627-4ed2-83ad-74db959a4193"]);
    const chat: ModeratorSession = { ...real, sessionId: "chat", developmentThreadId: undefined, developmentThreadIds: undefined };
    const rows = activityRows([chat], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "chat", titlePending: false });
    expect(rows[0].executionId).toBeUndefined();
  });
});
