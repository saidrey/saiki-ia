import { describe, expect, it } from "vitest";
import { describeOutcome } from "./outcomes";

describe("describeOutcome", () => {
  it("applied: aplicado y verificado (docs/APPLY.md)", () => {
    expect(describeOutcome("applied")).toEqual({
      tone: "success",
      text: "Cambios aplicados y verificados: el contenido en disco coincide con lo aprobado.",
    });
  });
  it("las paradas sin desarrollo no se presentan como fallos", () => {
    expect(describeOutcome("rejected").tone).toBe("stopped");
    expect(describeOutcome("blocked").tone).toBe("stopped");
  });
  it("una reversión incompleta es un fallo que pide revisión manual", () => {
    expect(describeOutcome("unrecoverable")).toMatchObject({ tone: "failure" });
    expect(describeOutcome("unrecoverable").text).toMatch(/revisión manual/);
  });
  it("apply_blocked no presupone el motivo (hash, proyecto desactivado, repo movido…)", () => {
    const o = describeOutcome("apply_blocked");
    expect(o.tone).toBe("failure");
    expect(o.text).not.toMatch(/coincid/);
    expect(o.text).toMatch(/no se aplicó nada/);
  });
  it("una fase desconocida se muestra tal cual, sin interpretarla", () => {
    expect(describeOutcome("fase_nueva").text).toBe("Terminada con la fase «fase_nueva».");
  });
});
