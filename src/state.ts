import { Annotation } from "@langchain/langgraph";
import type { Proposal } from "./apply/file-change.js";
import type { Finding } from "./review/review-types.js";

/**
 * Estado tipado y compartido del grafo.
 *
 * En LangGraph el estado es el "contrato" que viaja entre todos los nodos.
 * Cada nodo lee este objeto y devuelve SOLO las claves que quiere actualizar;
 * LangGraph mezcla esas actualizaciones en el estado global.
 *
 * `Annotation.Root` define el esquema. Cada campo es un "canal" (channel):
 * por defecto cada canal guarda el ultimo valor que devuelve un nodo
 * (estrategia "last write wins"). Un canal puede llevar un "reducer" para
 * combinar el valor anterior con el nuevo en vez de reemplazarlo (ver
 * `attempts` mas abajo).
 */
export const WorkflowState = Annotation.Root({
  /** La tarea de entrada que el usuario quiere desarrollar. */
  task: Annotation<string>,

  /** Plan generado por el nodo `analyze`. Vacio hasta que `analyze` corre. */
  plan: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /** Resultado de la implementacion generado por el nodo `develop`. */
  implementation: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /** Veredicto textual de la revision generado por el nodo `review`. */
  review: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * Bandera booleana del resultado de la revision. La escribe `review` y la
   * lee la arista condicional para decidir el siguiente paso. Separar el
   * booleano del texto (`review`) hace el enrutamiento trivial y robusto.
   */
  approved: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),

  /**
   * Contador de intentos de desarrollo.
   *
   * Lleva un REDUCER: en vez de reemplazar el valor, suma el delta que
   * devuelve el nodo. Asi `develop` puede devolver `{ attempts: 1 }` en cada
   * pasada y el total se va acumulando (1, 2, 3...). Sin reducer, el valor se
   * sobrescribiria y nunca podriamos contar los reintentos.
   *
   * `default` da el valor inicial (0) si nadie lo ha escrito todavia.
   */
  attempts: Annotation<number>({
    reducer: (current, delta) => current + delta,
    default: () => 0,
  }),

  /**
   * Resultado final explicito del grafo: "approved" o "failed".
   * Lo fija el nodo terminal correspondiente. Vacio hasta terminar.
   */
  status: Annotation<"approved" | "failed" | "">({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * CONTROL DE SIMULACION (no es logica de negocio real).
   *
   * Indica cuantos intentos deben "fallar" antes de que `review` apruebe.
   * - 0  -> aprueba en el primer intento.
   * - >=3 -> nunca aprueba dentro del limite -> fuerza el escenario de fallo.
   *
   * Existe solo porque develop/review siguen simulados: necesitamos una forma
   * determinista de provocar rechazos para probar el bucle de correccion.
   */
  failUntil: Annotation<number>({
    reducer: (_current, next) => next,
    default: () => 0,
  }),

  /**
   * (Fase 4) true si el agente REAL de `analyze` (Kiro CLI) fallo. La arista
   * condicional que sale de `analyzeTask` lo lee para enrutar a la ruta de
   * fallo explicita SIN ejecutar `develop`.
   */
  analyzeFailed: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),

  /** (Fase 4) Detalle del error de `analyze`, para visibilidad en el resultado. */
  analyzeError: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 5) Marca que `implementation` es una PROPUESTA de codigo generada por
   * develop, NO un cambio aplicado al repositorio. Siempre false en esta fase:
   * la escritura real y las aprobaciones son fases posteriores. Existe para que
   * el estado distinga explicitamente "propuesto" de "aplicado" y ninguna parte
   * del flujo trate una propuesta como si fuera un cambio real.
   */
  developApplied: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),

  /**
   * (Fase 5) true si el agente real de `develop` (Claude Code) fallo. La arista
   * condicional tras `developTask` lo lee para enrutar a la ruta de fallo
   * explicita sin pasar por review. Sin fallback al mock.
   */
  developFailed: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),

  /** (Fase 5) Detalle del error de `develop`, para visibilidad en el resultado. */
  developError: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 6) Propuesta ESTRUCTURADA de cambios derivada de la salida de develop.
   * Es el artefacto que se aprueba y se aplica (no el texto libre de Claude).
   * null hasta que se genera.
   */
  proposal: Annotation<Proposal | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),

  /** (Fase 6) Hash SHA-256 de la propuesta generada. Lo que el humano aprueba. */
  proposalHash: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 6) Fase del ciclo de aprobacion humana:
   * - "none": aun no hay propuesta.
   * - "pending": propuesta generada, esperando decision humana.
   * - "approved": el humano aprobo.
   * - "rejected": el humano rechazo.
   * - "applied": los cambios aprobados se aplicaron con exito.
   * - "apply_failed": validacion o aplicacion fallo.
   */
  approvalPhase: Annotation<
    "none" | "pending" | "approved" | "rejected" | "applied" | "apply_failed"
  >({
    reducer: (_current, next) => next,
    default: () => "none",
  }),

  /** (Fase 6) Rutas efectivamente aplicadas por el aplicador. */
  appliedFiles: Annotation<string[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  /** (Fase 6) Detalle del error de validacion/aplicacion, visible en el resultado. */
  applyError: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 7) Hash de la propuesta que YA se aplico con exito. Es el registro de
   * idempotencia: si el nodo applyChanges se re-ejecuta (reintento, reanudacion
   * tras reinicio) y este hash coincide con el de la propuesta aprobada, NO se
   * vuelve a escribir. Vacio hasta que una aplicacion tiene exito.
   */
  appliedHash: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 7) Informe explicito cuando una recuperacion/rollback no se pudo
   * completar (outcome "unrecoverable"). Lista archivos afectados / acciones
   * pendientes. Vacio si no aplica.
   */
  recoveryReport: Annotation<string[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  /**
   * (Fase 8) Decision de la revision estructurada: "approved" | "rejected" | "".
   * "" = aun no revisado. La escribe `review` y la leen las aristas.
   */
  reviewDecision: Annotation<"approved" | "rejected" | "">({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 8) Hallazgos de la ultima revision. Si rechazo, estos hallazgos se
   * devuelven a `develop` para generar una nueva propuesta (con hash nuevo).
   */
  reviewFindings: Annotation<Finding[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),

  /** (Fase 8) Resumen textual de la decision de revision. */
  reviewSummary: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),

  /**
   * (Fase 8) true si la REVISION fallo en su ejecucion (distinto de un rechazo
   * legitimo). Enruta a fallo explicito, sin fallback.
   */
  reviewFailed: Annotation<boolean>({
    reducer: (_current, next) => next,
    default: () => false,
  }),

  /** (Fase 8) Detalle del error de ejecucion de la revision. */
  reviewError: Annotation<string>({
    reducer: (_current, next) => next,
    default: () => "",
  }),
});

/**
 * Tipo del estado completo, inferido del esquema.
 * Util para tipar funciones auxiliares o las aserciones de los tests.
 */
export type WorkflowStateType = typeof WorkflowState.State;

/**
 * Tipo de una actualizacion parcial del estado.
 * Es lo que cada nodo devuelve: un subconjunto del estado.
 */
export type WorkflowUpdate = Partial<WorkflowStateType>;

/** Numero maximo de correcciones permitidas tras el primer desarrollo. */
export const MAX_CORRECTIONS = 2;
