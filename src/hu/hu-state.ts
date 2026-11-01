import { Annotation } from "@langchain/langgraph";
import type { AnalyzedHu } from "./hu-schema.js";
import type { TechnicalAnalysis } from "../tech/tech-schema.js";
import type { Feasibility } from "../dev/feasibility.js";
import type { DevProposal } from "../dev/dev-schema.js";
import type { FunctionalReview, QualityReview } from "../reviewers/reviewer-schemas.js";
import type { ProjectBinding } from "../projects/project-binding.js";

/**
 * (Fase 13) Resultado de la aplicación tal como lo devuelve el aplicador
 * transaccional, mapeado al dominio HU. "noop" = ya estaba aplicado (idempotencia).
 */
export type ApplyOutcome =
  | "applied"
  | "noop"
  | "rolled_back"
  | "unrecoverable"
  | "rejected";

/**
 * (Fase 13) Resultado de la verificación posterior a aplicar. Distingue éxito
 * total de éxito con pruebas fallidas y de verificación fallida del contenido.
 */
export interface PostApplyVerification {
  /** ¿Los archivos del repo coinciden con la propuesta aprobada? */
  filesMatch: boolean;
  /** Archivos que debían existir y existen. */
  createdOk: string[];
  /** Archivos modificados cuyo contenido coincide con lo propuesto. */
  modifiedOk: string[];
  /** Archivos que debían eliminarse y ya no existen. */
  deletedOk: string[];
  /** Discrepancias detectadas (archivo faltante, contenido distinto, etc.). */
  mismatches: string[];
  /** Resultado de tests/typecheck del proyecto, si se ejecutaron (opt-in). */
  projectChecks?: { ran: boolean; passed: boolean; detail: string };
}

/**
 * (Fase 13) Registro de auditoría de la aplicación. NO contiene secretos: solo
 * identificadores, hashes, decisiones y rutas afectadas.
 */
export interface ApplicationAudit {
  applicationId: string;
  approvedHash: string;
  functionalDecision: string;
  qualityDecision: string;
  humanDecision: string;
  approvedAt: string;
  affectedFiles: string[];
  backupRef: string;
  applyOutcome: ApplyOutcome | "";
  verificationSummary: string;
  rollbackSummary: string;
  notes: string[];
}

/**
 * Estado del flujo de HU (Fase 9). INDEPENDIENTE del estado del pipeline
 * develop/review: aqui no hay escritura de archivos ni hash de propuesta. Este
 * flujo solo produce una HU aprobada, lista para que un analista tecnico la
 * consuma en una fase futura.
 */

/** Numero maximo de revisiones de HU tras la version inicial. */
export const MAX_HU_REVISIONS = 2;

/** (Fase 12) Limite GLOBAL de ciclos de correccion de propuesta (func+calidad). */
export const MAX_REVIEW_CYCLES = 3;

/** Fase del ciclo de HU. */
export type HuPhase =
  | "none" // aun no generada
  | "pending_review" // generada, esperando decision humana
  | "approved" // HU aprobada (pasa al analisis tecnico)
  | "rejected" // rechazada por el humano
  | "failed" // error al generar/validar la HU
  | "revision_limit" // se agoto el limite de revisiones
  // (Fase 10) fases del analisis tecnico:
  | "tech_analyzed" // analisis tecnico completado y persistido
  | "tech_failed" // el analisis tecnico fallo o no valido
  // (Fase 11) fases del desarrollo:
  | "blocked" // viabilidad blocked: no se ejecuta Claude
  | "needs_decision" // viabilidad partially_ready: requiere decision humana
  | "dev_proposed" // Claude genero propuesta valida (pasa a revisiones)
  | "dev_approved" // el humano aprobo la propuesta (NO se aplica en esta fase)
  | "dev_rejected" // el humano rechazo la propuesta
  | "dev_failed" // Claude fallo o propuesta invalida
  // (Fase 12) fases de revisiones automaticas:
  | "reviews_passed" // funcional y calidad aprobaron EL MISMO hash -> aprobacion humana
  | "review_failed" // un revisor fallo o devolvio salida invalida (sin fallback)
  | "reviews_exhausted" // se alcanzo el limite global de ciclos de correccion
  // (Fase 13) aprobacion humana final + aplicacion segura:
  | "awaiting_final_approval" // ambas revisiones OK: se presenta al humano y se pausa
  | "final_approval_rejected" // el humano rechazo definitivamente la propuesta
  | "ready_to_apply" // aprobado por el humano; hashes verificados; listo para aplicar
  | "applying" // aplicacion en curso (estado transitorio, persistido antes de escribir)
  | "applied" // aplicado y verificado con exito
  | "applied_with_test_failures" // aplicado y verificado, pero tests/typecheck fallaron
  | "rolled_back" // fallo al aplicar; se revirtieron los cambios parciales (repo intacto)
  | "unrecoverable" // fallo al aplicar Y el rollback no se completo (revision manual)
  | "apply_blocked"; // bloqueado antes de escribir (hash no coincide / propuesta invalida)

export const HuState = Annotation.Root({
  /** Solicitud original en texto libre. */
  request: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** Ultima HU generada y validada (null si aun no hay o fallo). */
  hu: Annotation<AnalyzedHu | null>({ reducer: (_c, n) => n, default: () => null }),

  /** Historial de versiones de la HU (se conservan). */
  versions: Annotation<AnalyzedHu[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),

  /** Numero de revisiones realizadas (0 = version inicial). */
  revisions: Annotation<number>({ reducer: (cur, delta) => cur + delta, default: () => 0 }),

  /** Fase actual del ciclo. */
  phase: Annotation<HuPhase>({ reducer: (_c, n) => n, default: () => "none" }),

  /** Historial de decisiones humanas (approve/revise/reject) con feedback. */
  decisions: Annotation<Array<{ action: string; feedback?: string }>>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),

  /** Detalle del error cuando phase="failed" o "tech_failed". */
  error: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 10) Análisis técnico producido tras aprobar la HU (null hasta entonces). */
  technicalAnalysis: Annotation<TechnicalAnalysis | null>({
    reducer: (_c, n) => n,
    default: () => null,
  }),

  /** (Fase 10) Rutas referenciadas por el análisis que NO se pudieron verificar. */
  unresolvedPaths: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),

  /** (Fase 11) Clasificación de viabilidad derivada del análisis técnico. */
  feasibility: Annotation<Feasibility | "">({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 11) Motivos que respaldan la clasificación de viabilidad. */
  feasibilityReasons: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),

  /** (Fase 11) Propuesta de implementación generada por Claude (null hasta entonces). */
  devProposal: Annotation<DevProposal | null>({ reducer: (_c, n) => n, default: () => null }),

  /** (Fase 11) Hash SHA-256 de la propuesta de desarrollo. Lo que se aprueba. */
  devProposalHash: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 11) Clasificación de rutas de la propuesta (nuevas/existentes/no verificables). */
  devNewFiles: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),
  devExistingFiles: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),
  devUnverifiablePaths: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),

  /** (Fase 12) Última revisión funcional (null hasta que se ejecuta). */
  functionalReview: Annotation<FunctionalReview | null>({ reducer: (_c, n) => n, default: () => null }),

  /** (Fase 12) Última revisión de calidad (null hasta que se ejecuta). */
  qualityReview: Annotation<QualityReview | null>({ reducer: (_c, n) => n, default: () => null }),

  /**
   * (Fase 12) Hash de la propuesta que la revisión FUNCIONAL aprobó. Para la
   * invariante: la aprobación humana solo procede si este hash === el de calidad
   * === el hash de la propuesta actual. Si Claude corrige (hash nuevo), queda
   * obsoleto. "" = no aprobado.
   */
  functionalApprovedHash: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 12) Hash de la propuesta que la revisión de CALIDAD aprobó. */
  qualityApprovedHash: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 12) Contador GLOBAL de ciclos de corrección (incrementa cada rechazo). */
  reviewCycles: Annotation<number>({ reducer: (cur, delta) => cur + delta, default: () => 0 }),

  /** (Fase 12) Historial de resultados de revisión (auditable). */
  reviewHistory: Annotation<
    Array<{ cycle: number; kind: "functional" | "quality"; decision: string; hash: string; findings: number }>
  >({ reducer: (cur, next) => cur.concat(next), default: () => [] }),

  // ── (Fase 13) Aprobación humana final + aplicación segura ──────────────────

  /**
   * (Fase 13) Hash que el humano aprobó explícitamente en la aprobación FINAL.
   * Debe coincidir con functionalApprovedHash === qualityApprovedHash ===
   * devProposalHash para poder aplicar. "" = no aprobado. Si la propuesta cambia
   * (hash nuevo), esta aprobación queda obsoleta.
   */
  finalApprovedHash: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /**
   * (Fase 13) Hash DEV efectivamente APLICADO en el repositorio. Pieza de la
   * IDEMPOTENCIA: si al reintentar coincide con el hash de la propuesta, el
   * aplicador devuelve "noop" y NO reescribe. "" = aún no aplicado.
   */
  appliedHash: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 13) Identificador único de la aplicación (idempotencia + auditoría). */
  applicationId: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 13) Resultado crudo de la aplicación (outcome del aplicador). */
  applyOutcome: Annotation<ApplyOutcome | "">({ reducer: (_c, n) => n, default: () => "" }),

  /** (Fase 13) Informe detallado del aplicador (rollback, archivos afectados). */
  applyReport: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),

  /** (Fase 13) Rutas efectivamente escritas/eliminadas por el aplicador. */
  appliedFiles: Annotation<string[]>({ reducer: (_c, n) => n, default: () => [] }),

  /** (Fase 13) Verificación posterior a la aplicación (contenido + checks). */
  verification: Annotation<PostApplyVerification | null>({ reducer: (_c, n) => n, default: () => null }),

  /** (Fase 13) Registro de auditoría consolidado (sin secretos). */
  auditRecord: Annotation<ApplicationAudit | null>({ reducer: (_c, n) => n, default: () => null }),

  // ── (Project Registry) Proyecto de la ejecución ────────────────────────────

  /**
   * Copia del proyecto con la que nació la ejecución. El reducer CONSERVA EL
   * PRIMER VALOR: una vez fijada, ningún nodo, reanudación ni `updateState` la
   * cambia. null = ejecución anterior al registro de proyectos.
   */
  project: Annotation<ProjectBinding | null>({ reducer: (cur, next) => cur ?? next ?? null, default: () => null }),

  /**
   * (Project Context, T8) Snapshot del índice con el que trabaja la ejecución.
   * Conserva el primer valor fijado (como `project`). El contexto completo no va
   * al checkpoint: está congelado en `execution_contexts`. null = sin snapshot o
   * ejecución anterior a T8.
   */
  contextSnapshotId: Annotation<string | null>({ reducer: (cur, next) => cur ?? next ?? null, default: () => null }),

  /** Directorio donde se aplicó (repo real o sandbox de esta ejecución). "" = aún no se aplicó. */
  applyTarget: Annotation<string>({ reducer: (_c, n) => n, default: () => "" }),
});

export type HuStateType = typeof HuState.State;
export type HuUpdate = Partial<HuStateType>;
