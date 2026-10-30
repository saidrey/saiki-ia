import type { AgentAdapter, AgentRole } from "./types.js";
import type { RuntimeId } from "./runtime.js";
import { MockAgentAdapter } from "./mock-agent.js";
import { KiroCliAdapter } from "./kiro-cli-agent.js";
import { ClaudeCliAdapter } from "./claude-cli-agent.js";

/**
 * Router de agentes por rol.
 *
 * La idea de esta fase: solo UN agente real (analyze -> Kiro CLI); el resto
 * sigue simulado. El router resuelve, para cada rol, que adaptador usar.
 *
 * Como el grafo (los nodos) solo conoce el contrato `AgentAdapter`, el router
 * es el unico lugar que sabe "quien ejecuta que". Cambiar el reparto de roles
 * no toca ni nodos ni grafo.
 */
export interface AgentRouter {
  /** Devuelve el adaptador encargado de un rol. */
  forRole(role: AgentRole): AgentAdapter;
}

/**
 * Mapa explicito rol -> adaptador. `huAnalyst` (Fase 9) es opcional para no
 * romper los mapas existentes del pipeline develop/review, que no lo usan.
 */
export interface RoleAdapterMap {
  analyze: AgentAdapter;
  develop: AgentAdapter;
  review: AgentAdapter;
  huAnalyst?: AgentAdapter;
  technicalAnalyst?: AgentAdapter;
  functionalReviewer?: AgentAdapter;
  qualityReviewer?: AgentAdapter;
  /** (Fase 14) Rol auxiliar genérico. Opcional: solo si se usa delegación. */
  assistant?: AgentAdapter;
}

/**
 * (Fase 14) Router que ADEMÁS puede resolver un adaptador por RUNTIME, de forma
 * independiente del rol. Es opcional: quien no lo necesite usa solo `forRole`.
 * Permite que un mismo rol se ejecute con runtimes distintos cuando corresponda.
 */
export interface RuntimeAwareRouter extends AgentRouter {
  /** ¿Hay un adaptador para este runtime? */
  hasRuntime(id: RuntimeId): boolean;
  /** Adaptador asociado a un runtime (lanza si no está registrado). */
  forRuntime(id: RuntimeId): AgentAdapter;
}

/** Implementacion simple del router a partir de un mapa de adaptadores. */
export class MapAgentRouter implements RuntimeAwareRouter {
  /**
   * @param adapters mapa rol -> adaptador.
   * @param runtimes (opcional, Fase 14) mapa runtimeId -> adaptador, para
   *        seleccionar el mecanismo de ejecución independientemente del rol.
   */
  constructor(
    private readonly adapters: RoleAdapterMap,
    private readonly runtimes: Partial<Record<RuntimeId, AgentAdapter>> = {},
  ) {}

  forRole(role: AgentRole): AgentAdapter {
    const adapter = this.adapters[role];
    if (adapter === undefined) {
      throw new Error(`No hay adaptador configurado para el rol "${role}".`);
    }
    return adapter;
  }

  hasRuntime(id: RuntimeId): boolean {
    return this.runtimes[id] !== undefined;
  }

  forRuntime(id: RuntimeId): AgentAdapter {
    const adapter = this.runtimes[id];
    if (adapter === undefined) {
      throw new Error(`No hay adaptador configurado para el runtime "${id}".`);
    }
    return adapter;
  }
}

/**
 * Router por defecto (Fase 5):
 * - analyze -> KiroCliAdapter (REAL, sesion SSO del entorno).
 * - develop -> ClaudeCliAdapter (REAL, modo propuesta sin escritura).
 * - review  -> MockAgentAdapter (simulado).
 *
 * Se permite inyectar adaptadores para los tests (deterministas), de modo que
 * no se llame a ninguna CLI real durante `npm test`.
 */
export function createDefaultRouter(overrides?: Partial<RoleAdapterMap>): AgentRouter {
  const mock = new MockAgentAdapter();
  return new MapAgentRouter({
    analyze: overrides?.analyze ?? new KiroCliAdapter(),
    develop: overrides?.develop ?? new ClaudeCliAdapter(),
    review: overrides?.review ?? mock,
    // (Fase 9) huAnalyst reutiliza Kiro CLI como implementacion inicial.
    huAnalyst: overrides?.huAnalyst ?? new KiroCliAdapter(),
    // (Fase 10) technicalAnalyst: Kiro CLI con SOLO LECTURA (fs_read), verificado
    // contra `kiro-cli chat --help`. Nunca escritura ni ejecucion arbitraria.
    technicalAnalyst: overrides?.technicalAnalyst ?? new KiroCliAdapter({ trustTools: "fs_read" }),
    // (Fase 12) revisores: Kiro CLI con SOLO LECTURA. Independientes entre si.
    functionalReviewer: overrides?.functionalReviewer ?? new KiroCliAdapter({ trustTools: "fs_read" }),
    qualityReviewer: overrides?.qualityReviewer ?? new KiroCliAdapter({ trustTools: "fs_read" }),
  });
}
