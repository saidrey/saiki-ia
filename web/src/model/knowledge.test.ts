import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, labelOf, STATUS_LABEL, validFilter } from "./knowledge";

describe("knowledge", () => {
  it("etiquetas en español; un valor desconocido se muestra tal cual", () => {
    expect(labelOf(CATEGORY_LABEL, "decisions")).toBe("Decisiones");
    expect(labelOf(STATUS_LABEL, "approved")).toBe("Aprobado");
    expect(labelOf(CATEGORY_LABEL, "otra")).toBe("otra");
  });
  it("un filtro de la URL inválido se ignora (no se envía a la API)", () => {
    expect(validFilter(STATUS_LABEL, "approved")).toBe("approved");
    expect(validFilter(STATUS_LABEL, "<script>")).toBe("");
    expect(validFilter(STATUS_LABEL, null)).toBe("");
  });
});
