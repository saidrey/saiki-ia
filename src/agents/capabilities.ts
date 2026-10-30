/**
 * Capacidades y permisos (Fase 14).
 *
 * PRINCIPIO: separar explícitamente DOS conceptos que hasta ahora vivían
 * implícitos dentro de cada adaptador:
 *
 *  1. CAPACIDADES DECLARADAS por un runtime/agente: lo que TÉCNICAMENTE puede
 *     hacer (p. ej. Claude Code puede escribir archivos si se le permite).
 *  2. PERMISOS CONCEDIDOS a una tarea concreta: lo que SE AUTORIZA para ESA
 *     ejecución (p. ej. a una investigación solo se le concede lectura).
 *
 * Los permisos se conceden según la TAREA, no por el nombre del runtime. Un
 * runtime capaz de escribir NO escribe si la tarea no lo concede.
 *
 * Esto NO reemplaza los controles de fases anteriores: el Safe Applier
 * (src/apply/) sigue siendo el ÚNICO componente que modifica el repositorio
 * durante el flujo de desarrollo. `apply_changes` como capacidad/permiso aquí
 * modela la intención; la escritura real sigue pasando por el aplicador
 * controlado, nunca por un agente.
 */

/**
 * Capacidades atómicas del sistema. Deliberadamente pocas y de negocio (no
 * reflejan 1:1 las herramientas de cada CLI). Se mapean a permisos de runtime
 * en cada adaptador.
 */
export type Capability =
  | "read_repo" // leer archivos del repositorio
  | "read_kb" // leer la Knowledge Base
  | "write_kb_proposed" // crear conocimiento PROVISIONAL (proposed), nunca approved
  | "external_docs" // consultar documentación externa / web
  | "propose_changes" // proponer cambios de código (texto), sin aplicarlos
  | "apply_changes"; // aplicar cambios al repo (SOLO vía Safe Applier)

/** Todas las capacidades conocidas (para validación). */
export const ALL_CAPABILITIES: readonly Capability[] = [
  "read_repo",
  "read_kb",
  "write_kb_proposed",
  "external_docs",
  "propose_changes",
  "apply_changes",
] as const;

/**
 * Conjunto de permisos CONCEDIDOS a una tarea. Es un subconjunto de las
 * capacidades. Lo omitido queda DENEGADO (lista de permitidos explícita).
 */
export class PermissionGrant {
  private readonly granted: ReadonlySet<Capability>;

  constructor(capabilities: Capability[] = []) {
    this.granted = new Set(capabilities);
  }

  /** ¿Se concedió esta capacidad? */
  allows(cap: Capability): boolean {
    return this.granted.has(cap);
  }

  /** Lista de permisos concedidos (orden estable para auditoría). */
  list(): Capability[] {
    return ALL_CAPABILITIES.filter((c) => this.granted.has(c));
  }

  /** Grant de SOLO LECTURA: repo + KB + docs externas. Sin escritura alguna. */
  static readOnly(): PermissionGrant {
    return new PermissionGrant(["read_repo", "read_kb", "external_docs"]);
  }

  /** Grant vacío: nada permitido. */
  static none(): PermissionGrant {
    return new PermissionGrant([]);
  }
}

/**
 * Resultado de validar los permisos requeridos contra lo concedido.
 * `missing` enumera lo que falta (vacío = autorizado).
 */
export interface PermissionCheck {
  ok: boolean;
  missing: Capability[];
}

/**
 * Valida que un grant CUBRA todas las capacidades requeridas por una tarea.
 * Se debe llamar ANTES de ejecutar. Si falta algo, NO se ejecuta.
 */
export function checkPermissions(
  required: Capability[],
  grant: PermissionGrant,
): PermissionCheck {
  const missing = required.filter((c) => !grant.allows(c));
  return { ok: missing.length === 0, missing };
}
