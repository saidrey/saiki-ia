import type { Capability } from "./capabilities.js";
import type { AgentAdapter } from "./types.js";
import { KiroCliAdapter } from "./kiro-cli-agent.js";
import { ClaudeCliAdapter } from "./claude-cli-agent.js";
import { OpenCodeCliAdapter } from "./opencode-cli-agent.js";

/**
 * Runtimes: mecanismos de EJECUCIÓN de agentes (Fase 14).
 *
 * Un runtime es la herramienta que corre un agente (Kiro CLI, Claude Code,
 * OpenCode). Un ROL (developer, technicalAnalyst, assistant) es una
 * RESPONSABILIDAD, no un runtime. Un mismo rol puede ejecutarse con distintos
 * runtimes compatibles.
 *
 * Esta capa es ADITIVA: no reemplaza `AgentAdapter` ni obliga a migrar los
 * adaptadores existentes. Describe METADATOS (qué runtime, qué puede declarar)
 * y provee un registro extensible para seleccionar runtime por tarea.
 */

/** Identificador de runtime. Extensible sin tocar el Core. */
export type RuntimeId = "kiro" | "claude" | "opencode";

/**
 * Descriptor de un runtime: su identidad y las capacidades que DECLARA poder
 * ofrecer. "Declarado" != "concedido": lo que realmente se autoriza a una
 * tarea lo decide el PermissionGrant de esa tarea.
 */
export interface RuntimeDescriptor {
  id: RuntimeId;
  /** Nombre legible (coincide con AgentAdapter.name cuando aplica). */
  displayName: string;
  /** Capacidades que el runtime PUEDE ofrecer (techo técnico). */
  declaredCapabilities: Capability[];
  /** ¿Es opcional (no dependencia obligatoria del Core)? */
  optional: boolean;
  /** Fábrica del adaptador para un rol dado (inyectable para tests). */
  createAdapter: () => AgentAdapter;
}

/**
 * Registro de runtimes disponibles. Permite incorporar OpenCode como opcional
 * sin acoplarlo al Core: si no se registra, nada depende de él.
 */
export class RuntimeRegistry {
  private readonly runtimes = new Map<RuntimeId, RuntimeDescriptor>();

  register(descriptor: RuntimeDescriptor): this {
    this.runtimes.set(descriptor.id, descriptor);
    return this;
  }

  has(id: RuntimeId): boolean {
    return this.runtimes.has(id);
  }

  get(id: RuntimeId): RuntimeDescriptor {
    const d = this.runtimes.get(id);
    if (d === undefined) {
      throw new Error(`Runtime "${id}" no está registrado.`);
    }
    return d;
  }

  list(): RuntimeDescriptor[] {
    return [...this.runtimes.values()];
  }

  /** ¿El runtime declara TODAS las capacidades requeridas? (compatibilidad) */
  supports(id: RuntimeId, required: Capability[]): boolean {
    if (!this.has(id)) return false;
    const declared = new Set(this.get(id).declaredCapabilities);
    return required.every((c) => declared.has(c));
  }
}

/**
 * Descriptores por defecto de los runtimes conocidos. Las capacidades
 * DECLARADAS son el techo técnico de cada herramienta (no lo que se concede a
 * una tarea). OpenCode se marca `optional`.
 *
 * NOTA: `apply_changes` NO lo declara ningún runtime de agente: aplicar cambios
 * es responsabilidad exclusiva del Safe Applier (src/apply/), no de un agente.
 */
export function defaultRuntimeDescriptors(): RuntimeDescriptor[] {
  return [
    {
      id: "kiro",
      displayName: "Kiro CLI",
      declaredCapabilities: ["read_repo", "read_kb", "propose_changes"],
      optional: false,
      createAdapter: () => new KiroCliAdapter({ trustTools: "fs_read" }),
    },
    {
      id: "claude",
      displayName: "Claude Code",
      declaredCapabilities: ["read_repo", "propose_changes"],
      optional: false,
      createAdapter: () => new ClaudeCliAdapter({ rawPrompt: true }),
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      // Asistente auxiliar de SOLO LECTURA + documentación externa + KB.
      declaredCapabilities: ["read_repo", "read_kb", "external_docs", "write_kb_proposed"],
      optional: true,
      createAdapter: () => new OpenCodeCliAdapter({ agent: "assistant" }),
    },
  ];
}

/**
 * Construye un registro con los runtimes por defecto. OpenCode se incluye como
 * OPCIONAL: registrarlo no lo vuelve obligatorio; si no se usa, nada depende
 * de él. Permite omitir runtimes (p. ej. no registrar OpenCode).
 */
export function createDefaultRuntimeRegistry(
  options: { includeOptional?: boolean } = {},
): RuntimeRegistry {
  const includeOptional = options.includeOptional ?? true;
  const registry = new RuntimeRegistry();
  for (const d of defaultRuntimeDescriptors()) {
    if (d.optional && !includeOptional) continue;
    registry.register(d);
  }
  return registry;
}
