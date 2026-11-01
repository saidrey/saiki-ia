import { describe, expect, it } from "vitest";
import { segmentPath, type NodeBox } from "./pipeline";

const box = (x: number, y: number, extra: Partial<NodeBox> = {}): NodeBox => ({ x, y, r: 44, cellTop: y - 70, cellBottom: y + 110, ...extra });

describe("segmentPath", () => {
  it("misma fila: recto de borde a borde, con la puerta en el centro", () => {
    expect(segmentPath(box(100, 200), box(400, 200))).toEqual({ d: "M144 200H356", mid: { x: 250, y: 200 } });
  });

  it("una sola columna (móvil): recto hacia abajo", () => {
    expect(segmentPath(box(60, 100), box(60, 260))).toEqual({ d: "M60 144V216", mid: { x: 60, y: 180 } });
  });

  it("cambio de fila: rodea las etiquetas por fuera y baja entre filas, sin cruzar el texto", () => {
    const a = box(900, 200); // última de la fila 1 (texto hasta y=310)
    const b = box(150, 520); // primera de la fila 2 (empieza en y=450)
    const s = segmentPath(a, b);
    // Sale por la derecha del nodo y entra por su izquierda.
    expect(s.d.startsWith("M944 200")).toBe(true);
    expect(s.d.endsWith("H106")).toBe(true);
    // El tramo horizontal va entre el texto de la fila 1 y el principio de la fila 2.
    expect(s.mid.y).toBe(380);
    expect(s.mid.y).toBeGreaterThan(a.cellBottom);
    expect(s.mid.y).toBeLessThan(b.cellTop);
    // Pasa por fuera de ambos nodos (a la derecha de a, a la izquierda de b).
    expect(s.d).toContain("V364");
    expect(s.d).toMatch(/Q980 380 964 380/);
    expect(s.d).toMatch(/Q70 380 70 396/);
  });
});

import { handoffsBetween } from "./pipeline";

describe("handoffsBetween", () => {
  const base = ["done", "done", "done", "running", "pending", "pending", "pending", "pending", "pending"] as const;

  it("sin observación previa no anima el historial", () => {
    expect(handoffsBetween(null, base)).toEqual([]);
  });

  it("la etapa siguiente se enciende tras completarse la anterior: relevo con el color de su nuevo estado", () => {
    const next = ["done", "done", "done", "done", "running", "pending", "pending", "pending", "pending"] as const;
    expect(handoffsBetween(base, next)).toEqual([{ to: 4, tone: "agent" }]);
  });

  it("varias etapas en un mismo sondeo: relevos en orden (cascada); la persona en violeta", () => {
    const prev = ["done", "running", "pending", "pending", "pending", "pending", "pending", "pending", "pending"] as const;
    const next = ["done", "done", "done", "done", "done", "done", "awaiting", "pending", "pending"] as const;
    expect(handoffsBetween(prev, next)).toEqual([
      { to: 2, tone: "trail" },
      { to: 3, tone: "trail" },
      { to: 4, tone: "trail" },
      { to: 5, tone: "trail" },
      { to: 6, tone: "human" },
    ]);
  });

  it("sin cambios, o si la anterior no terminó (error), no hay relevo", () => {
    expect(handoffsBetween(base, base)).toEqual([]);
    const failed = ["done", "done", "done", "failed", "pending", "pending", "pending", "pending", "pending"] as const;
    expect(handoffsBetween(base, failed)).toEqual([]);
  });
});
