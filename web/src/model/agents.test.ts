import { describe, expect, it } from "vitest";
import type { StageId } from "../api/types";
import { showsAvatar, STAGE_RESPONSIBLE } from "./agents";

const STAGES: StageId[] = ["hu_analysis", "technical_analysis", "feasibility", "development", "functional_review", "quality_review", "final_approval", "apply", "verify"];

describe("responsables de etapa (configuración de roles de serve.ts)", () => {
  it("las 9 etapas tienen responsable; avatar solo para agentes y la persona", () => {
    expect(STAGES.filter(showsAvatar)).toEqual(["hu_analysis", "technical_analysis", "development", "functional_review", "quality_review", "final_approval"]);
    expect(STAGES.map((s) => STAGE_RESPONSIBLE[s].kind)).toEqual(["kiro", "kiro", "saiki", "claude", "kiro", "kiro", "human", "applier", "saiki"]);
  });

  it("herramientas = las que permite el adaptador (solo lectura); ninguna etapa declara escritura ni MCP", () => {
    expect(STAGE_RESPONSIBLE.development.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(STAGE_RESPONSIBLE.development.blocked).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(STAGE_RESPONSIBLE.hu_analysis.tools).toEqual([]);
    for (const s of STAGES) {
      expect(STAGE_RESPONSIBLE[s].tools.some((t) => /write|edit|bash/i.test(t))).toBe(false);
      expect(STAGE_RESPONSIBLE[s].mcp).toMatch(/^(Ninguno|No aplica)/);
    }
  });
});
