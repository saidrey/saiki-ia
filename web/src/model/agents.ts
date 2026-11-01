import type { StageId } from "../api/types";

/**
 * Responsable de cada etapa según la configuración de roles del backend
 * (`buildRealRouter` en src/api/serve.ts y los adaptadores de src/agents/).
 * La API no expone esta asignación ni registra qué agente ejecutó una etapa:
 * es lo CONFIGURADO, no lo observado. Si se reasigna un rol, hay que
 * actualizarlo aquí.
 */
export type ResponsibleKind = "kiro" | "claude" | "human" | "applier" | "saiki";

export interface StageResponsible {
  kind: ResponsibleKind;
  name: string;
  /** Agente de IA (lleva avatar en el pipeline) o componente/persona. */
  isAgent: boolean;
  /** Qué hace en esta etapa. */
  role: string;
  /** Herramientas que el adaptador le permite usar (no las que usó). */
  tools: string[];
  /** Herramientas bloqueadas explícitamente, si las hay. */
  blocked: string[];
  /** Servidores MCP disponibles para la etapa. */
  mcp: string;
}

const KIRO_MCP = "Ninguno: Kiro corre sin interacción con --trust-tools, y los MCP configurados en Kiro quedan bloqueados.";

const kiro = (role: string, tools: string[]): StageResponsible => ({ kind: "kiro", name: "Kiro CLI", isAgent: true, role, tools, blocked: [], mcp: KIRO_MCP });

export const STAGE_RESPONSIBLE: Record<StageId, StageResponsible> = {
  hu_analysis: kiro("Convierte la solicitud en una historia de usuario.", []),
  technical_analysis: kiro("Lee el repositorio y decide qué cambiar y dónde.", ["fs_read (solo lectura)"]),
  feasibility: { kind: "saiki", name: "Saiki-IA", isAgent: false, role: "Clasifica la viabilidad a partir del análisis técnico. Sin agente.", tools: [], blocked: [], mcp: "No aplica." },
  development: {
    kind: "claude",
    name: "Claude CLI",
    isAgent: true,
    role: "Propone los cambios de código. No escribe en el repositorio.",
    tools: ["Read", "Glob", "Grep"],
    blocked: ["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"],
    mcp: "Ninguno: se ejecuta con --strict-mcp-config sin servidores.",
  },
  functional_review: kiro("Comprueba la propuesta contra los criterios de la HU.", ["fs_read (solo lectura)"]),
  quality_review: kiro("Revisa la calidad del código propuesto.", ["fs_read (solo lectura)"]),
  final_approval: { kind: "human", name: "Tú", isAgent: false, role: "Apruebas, pides cambios o rechazas la versión exacta revisada.", tools: [], blocked: [], mcp: "No aplica." },
  apply: { kind: "applier", name: "Safe Applier", isAgent: false, role: "Aplica exactamente la propuesta aprobada, en sandbox o en el repositorio según el proyecto.", tools: [], blocked: [], mcp: "No aplica." },
  verify: { kind: "saiki", name: "Saiki-IA", isAgent: false, role: "Comprueba que lo aplicado coincide con lo aprobado. Sin agente.", tools: [], blocked: [], mcp: "No aplica." },
};

/** Avatar en el pipeline: agentes de IA y la persona; no los componentes deterministas. */
export function showsAvatar(id: StageId): boolean {
  const r = STAGE_RESPONSIBLE[id];
  return r.isAgent || r.kind === "human";
}
