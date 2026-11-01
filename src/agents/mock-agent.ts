import type {
  AgentAdapter,
  AgentRequest,
  AgentResult,
  AgentRole,
} from "./types.js";

/**
 * Opciones de simulacion del MockAgentAdapter.
 *
 * `failRoles` lista los roles que deben devolver un fallo. Es la forma
 * DETERMINISTA de probar el camino de error sin aleatoriedad ni procesos
 * externos. Mismo criterio que usamos con `failUntil` en el grafo.
 */
export interface MockAgentOptions {
  failRoles?: AgentRole[];
}

/**
 * Implementacion SIMULADA del contrato `AgentAdapter`.
 *
 * - No ejecuta procesos externos (no lanza CLIs).
 * - No llama a modelos ni usa API keys.
 * - Es determinista: el mismo input produce el mismo output.
 *
 * Sirve como implementacion por defecto mientras no haya agentes reales, y
 * ademas como "doble de prueba" para los tests.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly name = "mock";

  private readonly failRoles: Set<AgentRole>;

  constructor(options: MockAgentOptions = {}) {
    this.failRoles = new Set(options.failRoles ?? []);
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const { role, input } = request;

    // Camino de fallo simulado: devolvemos un AgentResult con status
    // "failure" y un error. NO lanzamos excepcion, segun el contrato.
    if (this.failRoles.has(role)) {
      return {
        status: "failure",
        output: "",
        error: `El agente simulado fallo intencionalmente en el rol "${role}".`,
        role,
      };
    }

    // Camino de exito: cada rol produce un entregable textual simulado.
    return {
      status: "success",
      output: this.simulateOutput(role, input),
      role,
    };
  }

  /** Genera el texto simulado segun el rol. Pura y determinista. */
  private simulateOutput(role: AgentRole, input: string): string {
    switch (role) {
      case "analyze":
        return `Plan simulado para: "${input}".`;
      case "develop":
        return `Implementacion simulada basada en: "${input}".`;
      case "review":
        return `Revision simulada de: "${input}".`;
      case "huAnalyst":
        return `Analisis simulado de HU para: "${input}".`;
      case "technicalAnalyst":
        return `Analisis tecnico simulado para: "${input}".`;
      case "functionalReviewer":
        return `Revision funcional simulada de: "${input}".`;
      case "qualityReviewer":
        return `Revision de calidad simulada de: "${input}".`;
      case "assistant":
        return `Asistencia simulada para: "${input}".`;
      case "projectAnalyst":
        return `Analisis de proyecto simulado para: "${input}".`;
      default: {
        // Exhaustividad: si se agrega un rol nuevo y se olvida aqui,
        // TypeScript marcara error en compilacion.
        const exhaustive: never = role;
        return exhaustive;
      }
    }
  }
}
